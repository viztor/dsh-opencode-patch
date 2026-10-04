/**
 * The `llm/stream` hook: turn capture for configured providers.
 *
 * Extracted from `apply()` so the lifecycle wiring stays readable; the hook
 * itself validates the stream options, derives the session value, optionally
 * records the debug entry, and carries the turn state through the downstream
 * async iterable.
 *
 * @module dsh-opencode-patch/stream-hook
 */

import type { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";

import type { ResolvedPluginConfig } from "./config.ts";
import { readSessionMetaResolver } from "./cordis-context.ts";
import type { DebugContext } from "./debug.ts";
import { recordDebug } from "./debug.ts";
import { isAsyncIterableLike, isRecord } from "./guards.ts";
import { findModelSpec } from "./models-catalog.ts";
import { isRouteRegistered } from "./models-discovery.ts";
import { internalRouteFor } from "./responses-routes.ts";
import { recordTurnUsage } from "./session-cost.ts";
import {
  fallbackSessionId,
  headerValueFor,
  SESSION_HEADER,
} from "./session.ts";
import type { ActiveTurnState } from "./turn-store.ts";
import { withStore } from "./turn-store.ts";

interface StreamOptions {
  model?: unknown;
  parentId?: unknown;
  parentSession?: unknown;
  parentSessionId?: unknown;
  provider?: unknown;
  sessionId?: unknown;
}

const isStreamOptions = (value: unknown): value is StreamOptions =>
  typeof value === "object" && value !== null;

type StreamHandler = (options: unknown, next: () => unknown) => unknown;

/**
 * Build the `llm/stream` listener.
 *
 * @param ctx - plugin context (logging + debug file writes).
 * @param config - resolved plugin configuration.
 * @param als - turn store shared with the fetch patch.
 */
export const createStreamHook = (
  ctx: DebugContext & {
    llm?: {
      stream?: (options: unknown) => unknown;
    };
    logger?: {
      info?: (msg: string, ...args: unknown[]) => void;
    };
  },
  config: ResolvedPluginConfig,
  als: AsyncLocalStorage<ActiveTurnState>
): StreamHandler => {
  const { debug, debugFile, providers } = config;

  return (options: unknown, next: () => unknown): unknown => {
    if (!isStreamOptions(options)) {
      return next();
    }
    const providerProp: unknown = options.provider;
    if (typeof providerProp !== "string" && typeof providerProp !== "number") {
      return next();
    }
    const providerKey = String(providerProp);
    if (!providers.has(providerKey)) {
      return next();
    }

    // A model the gateway serves on /responses cannot be dispatched through a
    // chat-completions route. Rather than translating the protocol at the
    // transport, hand the call to the route whose `api` already says
    // `openai-responses`: the adapter then speaks the format natively and
    // nothing about the response has to be rewritten. Returning here rather than
    // continuing means the redirected call does the session/debug/turn-state
    // work exactly once — its own pass through this hook.
    //
    // `prepared` is deliberately dropped. It is bound to the SOURCE route's
    // adapter and already-resolved model, so re-resolving on the target route is
    // not a loss — it is the only correct thing to do.
    const redirect = internalRouteFor(
      providerKey,
      options.model,
      // The vendor's own statement of the split: a model naming a different SDK
      // than the route's is served on a different API. Read from the catalog
      // rather than from a list we would have to notice changing.
      typeof options.model === "string"
        ? findModelSpec(options.model)?.provider_npm
        : undefined
    );
    // Take the call over only when the target route is really registered.
    // Without this, a layer that failed to load would replace the gateway's own
    // error with a "no adapter for provider" one, which is harder to act on and
    // points at the wrong thing. Asked of the UNFILTERED registry — the route is
    // deliberately absent from every listing a user sees.
    if (
      redirect !== undefined &&
      typeof ctx.llm?.stream === "function" &&
      isRouteRegistered(redirect)
    ) {
      return ctx.llm.stream({ ...options, provider: redirect });
    }
    const sessionProp: unknown = options.sessionId;
    let rawSession: string;
    let value: string;
    if (typeof sessionProp === "string" && sessionProp.length > 0) {
      rawSession = sessionProp;
      value =
        headerValueFor(rawSession) ?? fallbackSessionId(config.sessionIdEnv);
    } else if (typeof sessionProp === "number") {
      rawSession = String(sessionProp);
      value =
        headerValueFor(rawSession) ?? fallbackSessionId(config.sessionIdEnv);
    } else {
      rawSession = fallbackSessionId(config.sessionIdEnv);
      value = rawSession;
    }

    const sessionMetaResolver = readSessionMetaResolver(ctx);
    const sessionMeta =
      typeof options.sessionId === "string" && sessionMetaResolver !== undefined
        ? sessionMetaResolver(options.sessionId)
        : undefined;

    const parentProp =
      options.parentSessionId ?? options.parentSession ?? options.parentId;
    let rawParent: string | undefined;
    if (typeof parentProp === "string" && parentProp.length > 0) {
      rawParent = parentProp;
    } else if (typeof parentProp === "number") {
      rawParent = String(parentProp);
    } else if (sessionMeta?.parentSession !== undefined) {
      rawParent = sessionMeta.parentSession;
    }
    const parentValue =
      rawParent === undefined ? undefined : headerValueFor(rawParent);

    let project: string | undefined;
    if (sessionMeta?.cwd !== undefined) {
      const folder = path.basename(sessionMeta.cwd);
      if (folder.length > 0 && folder !== "/" && folder !== ".") {
        project = folder;
      }
    }

    const downstream: unknown = next();
    if (!isAsyncIterableLike(downstream)) {
      return downstream;
    }

    if (debug || debugFile !== undefined) {
      const entry = {
        header: SESSION_HEADER,
        model: options.model,
        ...(parentValue === undefined ? {} : { parentSession: parentValue }),
        ...(project === undefined ? {} : { project }),
        provider: providerKey,
        session: rawSession,
        ts: new Date().toISOString(),
        value,
      };
      if (debugFile !== undefined) {
        void recordDebug(ctx, debugFile, entry);
      }
      if (debug) {
        ctx.logger?.info?.(
          '[dsh-opencode-patch] streaming provider "%s" with %s=%s',
          providerKey,
          SESSION_HEADER,
          value
        );
      }
    }
    const modelProp: unknown = options.model;
    const modelName = typeof modelProp === "string" ? modelProp : "unknown";
    const spec = findModelSpec(modelName);

    const wrappedStream = async function* wrappedStream() {
      for await (const chunk of downstream) {
        if (
          isRecord(chunk) &&
          chunk.type === "usage" &&
          isRecord(chunk.usage)
        ) {
          const u = chunk.usage;
          const inputTokens =
            typeof u.inputTokens === "number" ? u.inputTokens : undefined;
          const outputTokens =
            typeof u.outputTokens === "number" ? u.outputTokens : undefined;
          const totalTokens =
            typeof u.totalTokens === "number" ? u.totalTokens : undefined;
          const cacheReadTokens =
            typeof u.cacheReadTokens === "number"
              ? u.cacheReadTokens
              : undefined;
          recordTurnUsage(
            rawSession,
            { cacheReadTokens, inputTokens, outputTokens, totalTokens },
            spec?.cost,
            modelName,
            spec?.is_free
          );
        }
        yield chunk;
      }
    };

    return withStore(
      wrappedStream(),
      {
        model: typeof modelProp === "string" ? modelProp : undefined,
        ...(parentValue === undefined ? {} : { parentValue }),
        ...(project === undefined ? {} : { project }),
        provider: providerKey,
        value,
      },
      als
    );
  };
};
