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
import { defaultHostModuleSource } from "./host/host-modules.ts";
import { isFunctionLike, isRecord } from "./utils/guards.ts";
import type { PlanePiModel } from "./utils/plane-model.ts";
import type { PlaneRoute, Protocol } from "./utils/protocols.ts";

/**
 * The disposer `llm.registerAdapter` returns.
 *
 * It is a **callable**, not an object with a `dispose` method, and it carries an
 * atomic route swap: `replace(providers)` re-points the same adapter at a new
 * route set. A stand-in handed to a plugin that expects the real contract has to
 * answer both, or the plugin's own re-registration path throws on a missing
 * method rather than on the conflict it should be reporting.
 */
export type AdapterRegistrationLike = (() => void) & {
  replace?: (providers: readonly string[]) => void;
};

/**
 * The directory counterpart of {@link AdapterRegistrationLike}: withdraws every
 * configurable provider a registration holds, and swaps them atomically.
 */
export type DirectoryRegistrationLike = (() => void) & {
  replace?: (entries: readonly unknown[]) => void;
};

/** Logging + lifecycle capabilities `apply()` uses. */
export interface CordisContext {
  effect?: (fn: () => unknown, name?: string) => void;
  /**
   * A child context with extra metadata on top of this scope, prototypally
   * inheriting every property. Own properties of the metadata shadow the
   * inherited ones, which is how a service can be shadowed for one subtree
   * without the parent being mutated.
   */
  extend?: (meta?: Record<string, unknown>) => CordisContext;
  get?: (name: string) => unknown;
  inject?: (deps: string[], cb: (scope: unknown) => void) => void;
  /**
   * The ROOT context of this composition.
   *
   * Cordis exposes it on every context (`typert-protocol` reads `ctx.root` to
   * install its invocation accessor), and it is the only scope whose lifetime is
   * the process rather than one activation — which is what a service the
   * Gateway scans has to have. Optional because a stand-in host may not carry it;
   * the callers fall back to the context they were given.
   */
  root?: CordisContext;
  /**
   * The loader's entry list. Every configured entry the host loaded keeps its
   * raw import result there, which is how the plugin reaches a package it is
   * deliberately not a dependency of.
   */
  loader?: LoaderService;
  llm?: {
    /**
     * Offer to interrogate provider endpoints on behalf of one settings
     * namespace. Uniqueness is by namespace, so a second registration under the
     * same one is a conflict rather than a replacement.
     */
    registerModelDiscovery?: (
      ns: string,
      discover: (request?: unknown, signal?: AbortSignal) => Promise<unknown>
    ) => (() => void) | undefined;
    /** Declare routes a plugin can activate through configuration. */
    registerConfigurableProviders?: (
      entries: readonly unknown[]
    ) => DirectoryRegistrationLike | undefined;
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
    ) => AdapterRegistrationLike | undefined;
    /**
     * The models one route advertises. The browser catalog turns each route into
     * a group and DROPS groups with no models, which is why the plane adapter
     * lists a plane's declared ids even when no key resolves (F18).
     */
    listModels?: (provider: string) => Promise<unknown>;
    /**
     * One exact model's capabilities. What the model picker's Effort row reads:
     * a route that reports no `reasoning` here shows no thinking-level control,
     * which is why the plane adapter builds every model's reasoning from the
     * catalog (D1, D17).
     */
    resolveModelInfo?: (
      provider: string,
      model: string,
      signal?: AbortSignal
    ) => Promise<unknown>;
  };
  /**
   * A child context whose reads and writes of `name` resolve in a new scope.
   * Used to hide the authorization seam from a mounted `llm-pi-ai` instance, so
   * it registers no auth flows and cannot collide with the host's own.
   */
  isolate?: (name: string) => CordisContext;
  /**
   * Register a service on the current fiber. The only write a live context
   * proxy accepts from a running fiber: an ad-hoc property set for a name that
   * was never provided is rejected, which is a load failure rather than a
   * degraded feature.
   */
  provide?: (name: string, value: unknown) => unknown;
  logger?: {
    info?: (msg: string, ...args: unknown[]) => void;
    warn?: (msg: string, ...args: unknown[]) => void;
  };
  /**
   * Listen for a host event. Cordis answers the listener's disposer
   * (`() => boolean`), which `rewrapOnAdaptersUpdated` calls to stop listening;
   * a stand-in may answer nothing, so the answer is `unknown` until checked.
   */
  on?: (
    event: string,
    callback: (
      options: unknown,
      next: () => unknown,
      ...rest: unknown[]
    ) => unknown,
    options?: { global?: boolean; prepend?: boolean }
  ) => unknown;
  /**
   * Start a plugin in this context and return its fiber. A plugin is a function
   * or an object with an `apply` method — which is exactly what `llm-pi-ai`
   * exports, so this is how the plugin mounts it.
   */
  plugin?: (plugin: unknown, config?: unknown) => PluginFiber | undefined;
}

/**
 * The fiber `ctx.plugin` starts a plugin in.
 *
 * **Not thenable.** Cordis's `Fiber` has no `then`, so `await fiber` resolves
 * immediately with the fiber itself and swallows nothing: `await()` is the
 * method that waits for the lifecycle work and rethrows a startup or
 * config-validation error. Without calling it, a mount that failed validation
 * looks exactly like one that succeeded.
 */
export interface PluginFiber {
  /** Wait for current lifecycle work, rethrowing a startup error if any. */
  await?: () => Promise<unknown>;
  /** Dispose and unload; resolves once the unwind is complete. */
  dispose?: () => Promise<unknown>;
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

/**
 * Structural claim satisfied by any context exposing the loader's entry list.
 *
 * `unwrapExports` is what turns an entry's RAW import result into the plugin
 * object the registry would have applied — the same normalization the loader
 * itself performs, so a default-export or CJS-interop shape needs no second
 * guess here.
 */
export interface LoaderHost {
  loader: {
    entries: () => Iterable<unknown>;
    unwrapExports?: (exports: unknown) => unknown;
  };
}

/** The loader surface, as the plugin reads it off its own context. */
export type LoaderService = LoaderHost["loader"];

/**
 * The loader's entry surface, or `undefined` when the context serves none.
 *
 * **Returns what it found rather than asserting a property exists.** The
 * previous version was a type PREDICATE (`ctx is LoaderHost`) whose body read
 * `ctx.loader` — so the guard threw `cannot get property "loader" without
 * inject` on exactly the contexts it existed to describe, and the narrowed type
 * pointed at a property that could throw on read. A guard has to hand back the
 * value it verified.
 *
 * `ctx.get` first: it reads the store WITHOUT consulting `inject`, which is what
 * an optional dependency needs, and this plugin declares only `llm`. The
 * property is a guarded fallback for a context that serves only that.
 *
 * @param ctx - the plugin context, mock or real.
 * @returns the loader service, or `undefined`.
 */
export const loaderOfContext = (ctx: unknown): LoaderService | undefined => {
  if (!isRecord(ctx)) {
    return undefined;
  }
  let loader: unknown;
  const { get } = ctx as { get?: unknown };
  if (typeof get === "function") {
    try {
      loader = Reflect.apply(get, ctx, ["loader"]);
    } catch {
      loader = undefined;
    }
  }
  if (loader === undefined) {
    try {
      const { loader: viaProperty } = ctx as { loader?: unknown };
      loader = viaProperty;
    } catch {
      return undefined;
    }
  }
  if (!isRecord(loader) || typeof loader.entries !== "function") {
    return undefined;
  }
  return loader as LoaderService;
};

/** Session metadata resolved from the host SessionRegistry. */
export interface SessionMeta {
  cwd?: string;
  parentSession?: string;
  /**
   * The session's creation time in milliseconds.
   *
   * It sits on the RECORD, not in its `header` (the Host validates
   * `record.createdAt`), and it is what lets a derived OpenCode session id
   * carry a REAL creation time rather than hash bits — the vendor parses that
   * field back out of the id.
   */
  createdAt?: number;
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
      // A creation time is a non-negative safe integer or it is absent; a
      // malformed one must not become a timestamp in the id.
      const createdAt: number | undefined =
        typeof session.createdAt === "number" &&
        Number.isSafeInteger(session.createdAt) &&
        session.createdAt >= 0
          ? session.createdAt
          : undefined;
      return { createdAt, cwd, parentSession };
    } catch {
      return undefined;
    }
  };
};

// ---------------------------------------------------------------------------
// The host's own modules
// ---------------------------------------------------------------------------

/** pi-ai's three public exports the plane adapter is built from (F19). */
export interface PiAiModule {
  readonly PiAiAdapter: new (options: Record<string, unknown>) => object;
  readonly Config: (raw: unknown) => unknown;
  readonly recordKeyFor: (providerId: string) => string;
}

/**
 * The libraries pi-ai runs on, as the plane provider uses them: pi's provider
 * pieces, dsh-llm's helpers and the loader's `interpolate`. Typed locally,
 * because the copies at runtime are the host's, not this package's.
 */
export interface HostLibraries {
  /** pi's `createProvider` (`dist/models.js`). */
  readonly createProvider: (input: Record<string, unknown>) => unknown;
  /** pi's `withOpenCodeSessionHeader` (`providers/opencode-headers.js`). */
  readonly withOpenCodeSessionHeader: (api: unknown) => unknown;
  /** pi's four protocol factories (`api/*.lazy.js`). */
  readonly apis: Readonly<Record<Protocol, () => unknown>>;
  /** `opencodeProvider().auth`: pi's ambient OpenCode key discovery. */
  readonly opencodeAuth: unknown;
  /** `opencodeGoProvider().auth`. */
  readonly opencodeGoAuth: unknown;
  /** pi's installed models for a route (`getBuiltinModels`). */
  readonly builtinModels: (route: PlaneRoute) => readonly PlanePiModel[];
  /** The pi version that was loaded, for diagnostics. */
  readonly version: string;
  /** The package root pi was loaded from, for diagnostics. */
  readonly root?: string;
  /** dsh-llm's `resolveRetryPolicy`. */
  readonly resolveRetryPolicy: (policy: unknown, label: string) => unknown;
  /** dsh-llm's `LlmError`, so a refusal carries the host's own class. */
  readonly LlmError?: new (message: string, code: string) => Error;
  /** dsh-llm's `assertUsableApiKey`. */
  readonly assertUsableApiKey?: (
    raw: string,
    pkg: string,
    ref: string
  ) => string;
  /** The loader's `interpolate`, absent when no loader is installed. */
  readonly interpolate?: (ctx: unknown, value: unknown) => unknown;
}

/** Both halves, once both resolved. */
export interface HostModules {
  readonly piAi: PiAiModule;
  readonly libraries: HostLibraries;
}

/** Where the host modules come from; the harness replaces it. */
export interface HostModuleSource {
  readonly piAi: (
    ctx: unknown,
    fiber?: unknown
  ) => Promise<PiAiModule | undefined>;
  /** The libraries pi-ai runs on, found from the context's base URL. */
  readonly libraries: (ctx?: unknown) => Promise<HostLibraries | undefined>;
}

let replacementSource: HostModuleSource | undefined;

/**
 * Replace where the host modules come from, until the returned restore runs.
 * A bare cordis context has no loader to find pi-ai's module through, so the
 * real-host harness hands the statically imported packages in here.
 *
 * @param source - the replacement, or `undefined` for the default.
 * @returns the restore.
 */
export const replaceHostModuleSource = (
  source: HostModuleSource | undefined
): (() => void) => {
  const previous = replacementSource;
  replacementSource = source;
  return () => {
    replacementSource = previous;
  };
};

/**
 * The host's pi-ai module and libraries, or `undefined` while either cannot be
 * read.
 *
 * @param ctx - the plugin context.
 * @param piFiber - pi-ai's fiber, whose loader entry holds its module.
 */
export const loadHostModules = async (
  ctx: unknown,
  piFiber?: unknown
): Promise<HostModules | undefined> => {
  const source = replacementSource ?? defaultHostModuleSource;
  try {
    const [piAi, libraries] = await Promise.all([
      source.piAi(ctx, piFiber),
      source.libraries(ctx),
    ]);
    return piAi === undefined || libraries === undefined
      ? undefined
      : { libraries, piAi };
  } catch {
    return undefined;
  }
};

/** One value of a launch-environment snapshot. */
export interface LaunchEnvironmentLike {
  readonly get: (name: string) => { readonly value?: string } | undefined;
}

/**
 * The launch environment, as pi-ai reads it (`launchEnvironmentOf`,
 * `launch-environment/src/index.ts:114-117`): the composition's snapshot when
 * one is provided, the process environment otherwise.
 *
 * @param ctx - the plugin context.
 */
export const readLaunchEnvironment = (ctx: unknown): LaunchEnvironmentLike => {
  let provided: unknown;
  if (isRecord(ctx) && isFunctionLike(ctx.get)) {
    try {
      provided = Reflect.apply(ctx.get, ctx, ["launchEnvironment"]);
    } catch {
      provided = undefined;
    }
  }
  if (isRecord(provided) && isFunctionLike(provided.get)) {
    const { get } = provided;
    return {
      get: (name) => {
        const hit: unknown = Reflect.apply(get, provided, [name]);
        return isRecord(hit) && typeof hit.value === "string"
          ? { value: hit.value }
          : undefined;
      },
    };
  }
  return {
    get: (name) => {
      const value = process.env[name];
      return value === undefined ? undefined : { value };
    },
  };
};

/** A cordis fiber, as far as the route claim reads one. */
export interface HostFiber {
  readonly uid: number | null;
  readonly state: number;
  readonly runtime?: { readonly name?: string } | null;
  readonly _config?: unknown;
  readonly config?: unknown;
  readonly entry?: { readonly options?: { readonly id?: string } } | undefined;
  readonly parent?: { readonly fiber?: { readonly state?: number } };
  readonly ctx?: unknown;
  readonly await?: () => Promise<unknown>;
  readonly restart?: () => Promise<unknown>;
}

/** The name pi-ai's runtime is registered under. */
export const PI_AI_RUNTIME = "llm-pi-ai";

/**
 * Every live fiber of pi-ai, in registry order, read through `ctx.registry`'s
 * runtimes. Never by `fiber.name`, which pi-ai's inject children inherit.
 *
 * @param ctx - the plugin context.
 */
export const piAiFibers = (ctx: unknown): HostFiber[] => {
  try {
    const registry: unknown = isRecord(ctx) ? ctx.registry : undefined;
    if (!isRecord(registry) || !isFunctionLike(registry.values)) {
      return [];
    }
    const runtimes: unknown = Reflect.apply(registry.values, registry, []);
    const out: HostFiber[] = [];
    // cordis's registry yields runtimes and each runtime's `fibers` is a
    // DisposableList; both are iterated, and a non-iterable throws into the
    // catch below. A fiber is read only through optional fields.
    /* oxlint-disable typescript/no-unsafe-type-assertion */
    for (const runtime of runtimes as Iterable<unknown>) {
      if (!isRecord(runtime) || runtime.name !== PI_AI_RUNTIME) {
        continue;
      }
      for (const fiber of (runtime.fibers ?? []) as Iterable<unknown>) {
        if (isRecord(fiber)) {
          out.push(fiber as unknown as HostFiber);
        }
      }
    }
    /* oxlint-enable typescript/no-unsafe-type-assertion */
    return out;
  } catch {
    return [];
  }
};
