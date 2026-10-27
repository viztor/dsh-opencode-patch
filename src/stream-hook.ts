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
import { existsSync } from "node:fs";

import type { ResolvedPluginConfig } from "./config.ts";
import { readSessionMetaResolver } from "./cordis-context.ts";
import type { DebugContext } from "./debug.ts";
import { recordDebug } from "./debug.ts";
import {
  catalogPlaneForRoute,
  findModelSpec,
  findModelSpecOn,
} from "./models-catalog.ts";
import { isRouteRegistered, isServableModel } from "./models-discovery.ts";
import {
  internalRouteFor,
  UNSERVED_PLANE_SDKS,
  GO_GOOGLE_INTERNAL_ROUTE,
} from "./responses-routes.ts";
import { recordTurnUsage } from "./session-cost.ts";
import {
  fallbackSessionId,
  headerValueFor,
  newOpenCodeMessageId,
  SESSION_HEADER,
} from "./session.ts";
import type { ActiveTurnState } from "./turn-store.ts";
import { withStore } from "./turn-store.ts";
import { googleHistoryFor, googleReplayStream } from "./utils/google-replay.ts";
import { isAsyncIterableLike, isRecord } from "./utils/guards.ts";

interface StreamOptions {
  messages?: unknown;
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
/**
 * The workspace folder name for `x-opencode-project`, or `undefined` when the
 * path names no folder.
 *
 * Splits on BOTH separators instead of calling `path.basename`, which is
 * platform-specific (Node documents `/` and `\` on Windows, `/` alone on
 * POSIX). A Windows-shaped `cwd` arriving on a POSIX host is therefore NOT
 * split by it at all — `path.basename("C:\\Users\\you\\proj")` returns the whole
 * string — so the full path, username included, would be sent as the project
 * name. This header is for attribution, not for a filesystem layout.
 */
/**
 * Models already reported as unservable, so the report happens once rather than on
 * every request that names one.
 */
const warnedUnservable = new Set<string>();

/** Markers whose presence makes a directory a repository root, either kind. */
const VCS_MARKERS = [".git", ".hg"] as const;

export const projectNameFrom = (cwd: string): string | undefined => {
  const trimmed = cwd.replace(/[\\/]+$/, "");
  // A folder name is trimmed for the same reason the resolver trims `cwd`:
  // blanks are absent, not values.
  const folder = trimmed.split(/[\\/]/).pop()?.trim();
  if (
    folder === undefined ||
    folder.length === 0 ||
    folder === "." ||
    folder === ".."
  ) {
    return undefined;
  }
  // The REPOSITORY's name, not this folder's. OpenCode's project id resolves up
  // to the version-control root and strips the marker - `.git` or `.hg`, both
  // markers, because a repository is not necessarily git - and a worktree or a
  // subdirectory therefore reports its main repository (`packages/core/src/
  // project.ts:52,307-315,356-376`). Taking the `cwd`'s own last segment made a
  // session in `/repo/packages/foo` report `foo` while a session in `/repo`
  // reported `repo`: two names for one workspace, which is the attribution the
  // header is for.
  //
  // The basename is sent rather than the root's path, which is OpenCode's actual
  // value, because this repository's hard rule forbids a local path from leaving
  // the machine - and the path carries the username.
  const segments = trimmed.split(/[\\/]/);
  for (let index = segments.length; index > 0; index -= 1) {
    const candidate = segments.slice(0, index).join("/");
    if (VCS_MARKERS.some((marker) => existsSync(`${candidate}/${marker}`))) {
      const root = segments[index - 1]?.trim();
      if (root !== undefined && root.length > 0) {
        return root;
      }
      break;
    }
  }
  return folder;
};

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

    // A model this plugin cannot serve, named by hand - once per pair, because
    // this hook runs on every request.
    //
    // The message states the reason it COMPUTED and nothing it did not. An
    // earlier version blamed the Zen free tier for every unservable id, which was
    // wrong twice over: for an `opencode-go` request that plane has no free tier
    // at all, and the filter's reasons here are about SHAPE - an SDK this plane
    // has no route for. The filter did spend a round excluding free-tier ids, and
    // this message computed that half too; the exclusion was withdrawn again when
    // the decision was made to offer them (a refused free id answers with the
    // gateway's own words, which is more use than an empty picker), so the shape
    // reasons below are what remains. A diagnostic that asserts a cause it never
    // checked is worse than none - it sends the reader to the wrong subsystem,
    // which is exactly what it did.
    if (
      typeof options.model === "string" &&
      options.model.length > 0 &&
      !isServableModel(options.model, providerKey) &&
      !warnedUnservable.has(`${providerKey}/${options.model}`)
    ) {
      warnedUnservable.add(`${providerKey}/${options.model}`);
      const plane = catalogPlaneForRoute(providerKey);
      const spec = findModelSpecOn(plane, options.model);
      const sdk = spec?.provider_npm;
      // Checked in the order the filter itself applies them, so the reason named
      // is the one that actually decided it. Naming the shape for a model that
      // was filtered on its tier sends the reader to the routing table for an
      // entitlement problem.
      let why: string;
      if (sdk === undefined) {
        why = "it names no SDK this plane has a route for";
      } else if (UNSERVED_PLANE_SDKS.has(`${providerKey} + ${sdk}`)) {
        why = `its catalog SDK \`${sdk}\` is not served on this plane`;
      } else {
        why = `its catalog SDK \`${sdk}\` names a protocol this plane has no route for`;
      }
      console.warn(
        `[dsh-opencode-patch] ${providerKey}/${options.model} cannot be served: ${why}`,
        "the picker does not offer it for the same reason"
      );
    }

    // A model the gateway serves on /responses cannot be dispatched through a
    // chat-completions route. Rather than translating the protocol at the
    // transport, hand the call to the route whose `api` already says
    // `openai-responses`: the adapter then speaks the format natively and
    // nothing about the response has to be rewritten. Returning here rather than
    // continuing means the redirected call does the session/debug/turn-state
    // work exactly once — its own pass through this hook.
    const redirect = internalRouteFor(
      providerKey,
      options.model,
      // The vendor's own statement of the split: a model naming a different SDK
      // than the route's is served on a different API. Read from the catalog
      // rather than from a list we would have to notice changing.
      //
      // Read from the plane the REQUEST is on, not from a Go-first lookup. The
      // two planes declare different SDKs for the same id — models.dev's
      // `opencode-go` names `@ai-sdk/anthropic` for `qwen3.8-max`,
      // `minimax-m2.7` and `minimax-m3` while its `opencode` names the default —
      // so a single lookup answered a Zen question with Go data and sent those
      // three to `/messages`. Measured: the Zen gateway serves `qwen3.8-max` and
      // `minimax-m3` on `/chat/completions` and answers
      // `400 ModelProtocolUnsupported` on `/messages`. The route decides the
      // plane, because the route is what the user configured.
      typeof options.model === "string"
        ? (
            findModelSpecOn(catalogPlaneForRoute(providerKey), options.model) ??
            findModelSpec(options.model)
          )?.provider_npm
        : undefined,
      // A route the deployment declared beats the catalog's own answer. The
      // catalog is a snapshot; the deployment is the one place that can say it is
      // wrong about a model.
      typeof options.model === "string"
        ? config.modelRoutes[options.model]?.api
        : undefined
    );
    // Take the call over only when the target route is really registered.
    // Without this, a layer that failed to load would replace the gateway's own
    // error with a "no adapter for provider" one, which is harder to act on and
    // points at the wrong thing. Asked of the UNFILTERED registry — the route is
    // deliberately absent from every listing a user sees.
    const isAvailable = (routeId: string): boolean => {
      const llm: unknown = ctx.llm;
      if (
        isRecord(llm) &&
        "adapters" in llm &&
        llm.adapters instanceof Map &&
        llm.adapters.has(routeId)
      ) {
        return true;
      }
      return isRouteRegistered(routeId);
    };
    if (
      redirect !== undefined &&
      typeof ctx.llm?.stream === "function" &&
      isAvailable(redirect)
    ) {
      if (redirect === GO_GOOGLE_INTERNAL_ROUTE) {
        const stream = ctx.llm.stream({
          ...options,
          provider: redirect,
          messages: googleHistoryFor(options.messages, providerKey, redirect),
        });
        return isAsyncIterableLike(stream)
          ? googleReplayStream(stream, redirect, providerKey)
          : stream;
      }
      return ctx.llm.stream({ ...options, provider: redirect });
    }
    const sessionProp: unknown = options.sessionId;
    // The session is looked up FIRST: its `createdAt` is what lets the derived
    // id carry the conversation's real creation time instead of hash bits, and
    // the derivation below is where that value goes.
    const sessionMetaResolver = readSessionMetaResolver(ctx);
    const sessionMeta =
      typeof sessionProp === "string" && sessionMetaResolver !== undefined
        ? sessionMetaResolver(sessionProp)
        : undefined;

    let rawSession: string;
    let value: string;
    if (typeof sessionProp === "string" && sessionProp.length > 0) {
      rawSession = sessionProp;
      value =
        headerValueFor(rawSession, sessionMeta?.createdAt) ??
        fallbackSessionId(config.sessionIdEnv);
    } else if (typeof sessionProp === "number") {
      rawSession = String(sessionProp);
      value =
        headerValueFor(rawSession, sessionMeta?.createdAt) ??
        fallbackSessionId(config.sessionIdEnv);
    } else {
      rawSession = fallbackSessionId(config.sessionIdEnv);
      value = rawSession;
    }

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
    // The parent's own creation time, when the Host has that session too.
    const parentValue =
      rawParent === undefined
        ? undefined
        : headerValueFor(
            rawParent,
            sessionMetaResolver?.(rawParent)?.createdAt
          );

    let project: string | undefined;
    if (sessionMeta?.cwd !== undefined) {
      const folder = projectNameFrom(sessionMeta.cwd);
      if (folder !== undefined && folder.length > 0) {
        project = folder;
      }
    }

    const downstream: unknown = next();
    if (!isAsyncIterableLike(downstream)) {
      return downstream;
    }

    // `debug` is the switch and `debugFile` is only where the switch writes —
    // the fetch patch is gated the same way (lifecycle.ts), and the manifest
    // documents `debugFile` as the append target for stream debug, not a
    // switch of its own.
    if (debug) {
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
      ctx.logger?.info?.(
        '[dsh-opencode-patch] streaming provider "%s" with %s=%s',
        providerKey,
        SESSION_HEADER,
        value
      );
    }
    const modelProp: unknown = options.model;
    const modelName = typeof modelProp === "string" ? modelProp : "unknown";
    // The ROUTE's plane first, as the dispatch lookup above does: the two planes
    // price some shared ids differently (deepseek-v4-pro is 0.66/1.98 on Go and
    // 1.74/3.48 on Zen), and a Go-first lookup recorded every Zen turn on those
    // at the Go rate. The Go-first lookup is the fallback for a model neither
    // route's plane carries.
    const spec =
      findModelSpecOn(catalogPlaneForRoute(providerKey), modelName) ??
      findModelSpec(modelName);

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
            spec?.is_free,
            catalogPlaneForRoute(providerKey)
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
        requestValue: newOpenCodeMessageId(),
        value,
      },
      als
    );
  };
};
