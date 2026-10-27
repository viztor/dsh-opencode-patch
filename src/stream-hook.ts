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
import { recordTurnUsage } from "./session-cost.ts";
import {
  fallbackSessionId,
  headerValueFor,
  newOpenCodeMessageId,
  SESSION_HEADER,
} from "./session.ts";
import type { ActiveTurnState } from "./turn-store.ts";
import { withStore } from "./turn-store.ts";
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
    // The ROUTE's plane first: the two planes
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
