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

import { readString } from "./config-values.ts";
import { isFunctionLike, isRecord } from "./guards.ts";

/** Logging + lifecycle capabilities `apply()` uses. */
export interface CordisContext {
  effect?: (fn: () => unknown, name?: string) => void;
  get?: (name: string) => unknown;
  inject?: (deps: string[], cb: (scope: unknown) => void) => void;
  llm?: {
    registerModelDiscovery?: (
      ns: string,
      discover: () => Promise<unknown>
    ) => void;
    discoverModels?: (
      settingsNs: string,
      request?: unknown,
      signal?: AbortSignal
    ) => Promise<unknown>;
    /**
     * Re-dispatch a generation. Used to hand a call to the route whose `api`
     * already names the format it needs, instead of translating the protocol.
     */
    stream?: (options: unknown) => unknown;
    /** Registered provider routes, for checking a target exists before using it. */
    listProviders?: () => unknown;
    /** Routes offered in Settings → Models. */
    listConfigurableProviders?: () => unknown;
    /**
     * Register an adapter for routes the plugin owns. Used to serve the
     * gateway's Responses plane without the user declaring anything.
     */
    registerAdapter?: (
      providers: readonly string[],
      adapter: unknown
    ) => { dispose?: () => void } | undefined;
    /**
     * The models one route advertises. The browser catalog turns each route into
     * a group and DROPS groups with no models, so this is how an internal route
     * stays out of the picker.
     */
    listModels?: (provider: string) => Promise<unknown>;
  };
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
  if (isFunctionLike(ctx.get)) {
    try {
      sessions = Reflect.apply(ctx.get, ctx, ["sessions"]);
    } catch {
      return undefined;
    }
  } else {
    try {
      sessions = Reflect.get(ctx, "sessions");
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
      // Blank fields are absent, not values: a whitespace-only cwd would
      // otherwise become the `x-opencode-project` header. `readString` is the
      // same rule the config readers use, so "absent or blank means default"
      // holds in one place.
      const parentSession = readString(header.parentSession);
      const cwd = readString(header.cwd);
      return { cwd, parentSession };
    } catch {
      return undefined;
    }
  };
};
