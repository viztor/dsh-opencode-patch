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

import type { ResolvedPluginConfig } from "./config.ts";
import { readParentSessionResolver } from "./cordis-context.ts";
import type { DebugContext } from "./debug.ts";
import { recordDebug } from "./debug.ts";
import { isAsyncIterableLike } from "./guards.ts";
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

    const parentResolver = readParentSessionResolver(ctx);
    const parentProp =
      options.parentSessionId ?? options.parentSession ?? options.parentId;
    let rawParent: string | undefined;
    if (typeof parentProp === "string" && parentProp.length > 0) {
      rawParent = parentProp;
    } else if (typeof parentProp === "number") {
      rawParent = String(parentProp);
    } else if (
      typeof options.sessionId === "string" &&
      parentResolver !== undefined
    ) {
      rawParent = parentResolver(options.sessionId);
    }
    const parentValue =
      rawParent === undefined ? undefined : headerValueFor(rawParent);

    const downstream: unknown = next();
    if (!isAsyncIterableLike(downstream)) {
      return downstream;
    }

    if (debug || debugFile !== undefined) {
      const entry = {
        header: SESSION_HEADER,
        model: options.model,
        ...(parentValue === undefined ? {} : { parentSession: parentValue }),
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
    return withStore(
      downstream,
      {
        model: typeof modelProp === "string" ? modelProp : undefined,
        ...(parentValue === undefined ? {} : { parentValue }),
        provider: providerKey,
        value,
      },
      als
    );
  };
};
