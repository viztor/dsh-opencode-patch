/**
 * Structural view of the Cordis host context.
 *
 * The host plugin cannot import `@deepseek-ai/cordis` types: that package
 * ships with the Harness installation, not as a dependency of this package.
 * So the context surface the plugin actually touches is declared here as
 * minimal interfaces, and every narrow step is a runtime-checked predicate
 * (never an `as` cast) — mock contexts in tests and future Cordis versions
 * both fail loudly instead of silently mis-shaping.
 *
 * @module dsh-opencode-patch/cordis-context
 */

import { isFunctionLike, isRecord } from "./guards.ts";

/** Logging + lifecycle capabilities `apply()` uses. */
export interface CordisContext {
  effect?: (fn: () => unknown, name?: string) => void;
  get?: (name: string) => unknown;
  inject?: (deps: string[], cb: (scope: unknown) => void) => void;
  logger?: {
    info?: (msg: string, ...args: unknown[]) => void;
    warn?: (msg: string, ...args: unknown[]) => void;
  };
  on?: (
    event: string,
    callback: (
      options: unknown,
      next: () => unknown,
      ...rest: unknown[]
    ) => unknown,
    options?: { prepend?: boolean }
  ) => void;
  plugin?: (plugin: unknown, options?: unknown) => void;
}

/** One loaded cordis entry's identifying options. */
export interface EntryOptions {
  id?: string;
  name?: string;
}

/** Credentials-service lookup, as the plugin consumes it. */
export type CredentialsResolver = (
  ref: string
) => Promise<{ value?: string } | undefined>;

/**
 * The plugin's own cordis entry options (`fiber.entry.options`), when the
 * context carries them. Used only to detect a legacy row id/name and log the
 * rename notice.
 *
 * @param ctx - the plugin context, mock or real.
 */
export const readEntryOptions = (ctx: unknown): EntryOptions | undefined => {
  if (!isRecord(ctx)) {
    return undefined;
  }
  const fiber: unknown = ctx.fiber;
  if (!isRecord(fiber)) {
    return undefined;
  }
  const entry: unknown = fiber.entry;
  if (!isRecord(entry)) {
    return undefined;
  }
  const options: unknown = entry.options;
  if (!isRecord(options)) {
    return undefined;
  }
  const id = typeof options.id === "string" ? options.id : undefined;
  const name = typeof options.name === "string" ? options.name : undefined;
  if (id === undefined && name === undefined) {
    return undefined;
  }
  return { id, name };
};

/**
 * Resolve a credential reference through `ctx.get("credentials")`, or
 * `undefined` when the Host serves no credentials service.
 *
 * Errors thrown by the service degrade to `undefined`: a broken credentials
 * service must not fail a plugin whose env fallback still works.
 *
 * @param ctx - the plugin context, mock or real.
 */
export const readCredentialsResolver = (
  ctx: unknown
): CredentialsResolver | undefined => {
  if (!isRecord(ctx) || !isFunctionLike(ctx.get)) {
    return undefined;
  }
  const { get } = ctx;
  let host: unknown;
  try {
    host = Reflect.apply(get, ctx, ["credentials"]);
  } catch {
    return undefined;
  }
  if (!isRecord(host) || !isFunctionLike(host.resolve)) {
    return undefined;
  }
  const { resolve } = host;
  return async (ref: string): Promise<{ value?: string } | undefined> => {
    let hit: unknown;
    try {
      hit = await Reflect.apply(resolve, host, [ref]);
    } catch {
      return undefined;
    }
    if (!isRecord(hit)) {
      return undefined;
    }
    const value: unknown = hit.value;
    return typeof value === "string" ? { value } : {};
  };
};

/** Structural claim satisfied by any context exposing `loader.entries()`. */
export interface LoaderHost {
  loader: { entries: () => Iterable<unknown> };
}

/**
 * True when `ctx` exposes the loader's entry list. Iteration itself is the
 * caller's trust boundary, exactly as it was before this predicate existed.
 *
 * @param ctx - the plugin context, mock or real.
 */
export const isLoaderHost = (ctx: unknown): ctx is LoaderHost => {
  if (!isRecord(ctx)) {
    return false;
  }
  const loader: unknown = ctx.loader;
  if (!isRecord(loader)) {
    return false;
  }
  const entries: unknown = loader.entries;
  return typeof entries === "function";
};

/** Session metadata resolved from the host SessionRegistry. */
export interface SessionMeta {
  cwd?: string;
  parentSession?: string;
}

export type SessionMetaResolver = (
  sessionId: string
) => SessionMeta | undefined;

/** Parent session lookup function. */
export type ParentSessionResolver = (sessionId: string) => string | undefined;

/**
 * Read the session metadata lookup function from `ctx.get("sessions")` or `ctx.sessions`,
 * returning `undefined` when the Host serves no session service.
 */
export const readSessionMetaResolver = (
  ctx: unknown
): SessionMetaResolver | undefined => {
  if (!isRecord(ctx)) {
    return undefined;
  }
  let sessions: unknown;
  if ("sessions" in ctx) {
    const { sessions: candidate } = ctx;
    if (isRecord(candidate)) {
      sessions = candidate;
    }
  } else if (isFunctionLike(ctx.get)) {
    try {
      sessions = Reflect.apply(ctx.get, ctx, ["sessions"]);
    } catch {
      return undefined;
    }
  }
  if (!isRecord(sessions) || !isFunctionLike(sessions.get)) {
    return undefined;
  }
  const { get } = sessions;
  return (sessionId: string): SessionMeta | undefined => {
    try {
      const session: unknown = Reflect.apply(get, sessions, [sessionId]);
      if (!isRecord(session)) {
        return undefined;
      }
      const header: unknown = session.header;
      if (!isRecord(header)) {
        return undefined;
      }
      const parentSession =
        typeof header.parentSession === "string" &&
        header.parentSession.length > 0
          ? header.parentSession
          : undefined;
      const cwd =
        typeof header.cwd === "string" && header.cwd.length > 0
          ? header.cwd
          : undefined;
      return { cwd, parentSession };
    } catch {
      return undefined;
    }
  };
};

/**
 * Read the parent session lookup function from `ctx.get("sessions")` or `ctx.sessions`,
 * returning `undefined` when the Host serves no session service.
 */
export const readParentSessionResolver = (
  ctx: unknown
): ParentSessionResolver | undefined => {
  const metaResolver = readSessionMetaResolver(ctx);
  if (metaResolver === undefined) {
    return undefined;
  }
  return (sessionId: string): string | undefined =>
    metaResolver(sessionId)?.parentSession;
};
