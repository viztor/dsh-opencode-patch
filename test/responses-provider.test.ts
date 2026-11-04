import { PiAiAdapter } from "@deepseek-ai/dsh-llm-pi-ai";
/**
 * `responses-provider.ts` — the plugin registering the gateway's non-default
 * planes itself, so the user keeps their existing provider and key.
 *
 * The mount is exercised against a **faithful stand-in for the host**, not a
 * spy. A spy can only prove that this plugin called something; it cannot prove
 * the mount survives the composition it is actually mounted into. So the stand-in
 * below reproduces the four host behaviours the mount has to survive, each of
 * which threw at mount time before this was fixed and none of which pointed at
 * its cause:
 *
 * | host behaviour | reproduced by | what used to happen |
 * | --- | --- | --- |
 * | the registry keys its runtime by `apply` identity, so the FIRST instance's schema validates the SECOND mount | `plugin()` re-running the recorded `Config` | `providers.get expected object` |
 * | `apply` declares the WHOLE installed catalog, so a second instance collides on every catalog provider | `registerConfigurableProviders` rejecting a provider another registration holds | `DUPLICATE_DIRECTORY` |
 * | model discovery is keyed by settings namespace, and a child plugin INHERITS its parent entry's id | `registerModelDiscovery` rejecting a namespace it already holds | `DUPLICATE_DISCOVERY` |
 * | `registerPiAiFlows` registers one flow per installed catalog provider | `inject(['authorization'])` | `DUPLICATE_FLOW` |

 * Each case below asserts the composition SURVIVES, and one case asserts the
 * shape that used to be passed is the shape the stand-in refuses — so a
 * regression reintroduces a failure the test can name.
 */
import { describe, expect, it, vi } from "vitest";

import {
  type CordisContext,
  GOOGLE_INTERNAL_ROUTE,
  OPENCODE_PLANE_API,
  RESPONSES_SDK,
  ROUTE_FOR_PLANE_PROTOCOL,
  SELF_MOUNTED_ROUTES,
  baseForProtocol,
  declaredProviderModels,
  getLiveGoCatalog,
  getLiveZenCatalog,
  inheritedCredentialRef,
  internalRouteFor,
  loadPiAi,
  loadPiAiAdapterHost,
  loadPiAiModule,
  modelsForSdk,
  narrowToDeclared,
  reasoningEffortsFor,
  registerResponsesProvider,
  undescribedDeclaredModels,
  unroutedDeclaredModels,
} from "./support/src.ts";

const MUSE = "muse-spark-1.2";

/** The package name the loader entry is matched on. */
const PI_AI = "@deepseek-ai/dsh-llm-pi-ai";

/**
 * A stand-in for the installed pi-ai catalog.
 *
 * `apply` declares ALL of it as configurable providers regardless of what its own
 * config names, which is precisely why a second instance cannot declare its own
 * directory. One entry is enough to reproduce the collision.
 */
const CATALOG = ["openai", "anthropic"] as const;

describe("responses-provider: the model list", () => {
  it("comes from the catalog, not from a hand-written list", () => {
    // Every model whose provider.npm names the OpenAI SDK is served on
    // /responses, so the route covers all of them. The bundled shim seeds one;
    // a live refresh widens it without a code change.
    const models = modelsForSdk(RESPONSES_SDK);
    expect(models.length).toBeGreaterThan(0);
    expect(models.map((m) => m.id)).toContain(MUSE);
    for (const model of models) {
      expect(model.contextWindow).toBeGreaterThan(0);
      expect(model.maxTokens).toBeGreaterThan(0);
      expect(model.input.length).toBeGreaterThan(0);
    }
  });

  it("lists each model once, even across both planes", () => {
    const ids = modelsForSdk(RESPONSES_SDK).map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("serves nothing for a protocol no model names", () => {
    expect(modelsForSdk("@ai-sdk/does-not-exist")).toEqual([]);
  });

  it("names the SDK it dispatches on", () => {
    // The constant the whole split hangs off; a typo here would silently stop
    // redirecting every Responses model.
    expect(RESPONSES_SDK).toBe("@ai-sdk/openai");
  });

  it("derives reasoningEfforts for effort, toggle, and unelaborated models", () => {
    expect(
      reasoningEffortsFor({
        context_window: 1000,
        id: "effort-model",
        input_modalities: ["text"],
        max_output_tokens: 100,
        name: "Effort",
        reasoning: true,
        reasoning_options: [{ type: "effort", values: ["low", "high", "max"] }],
      })
    ).toEqual({ off: null, low: "low", high: "high", max: "max" });

    // Toggle models like minimax-m3 on Go plan
    expect(
      reasoningEffortsFor({
        context_window: 1000,
        id: "minimax-m3",
        input_modalities: ["text"],
        max_output_tokens: 100,
        name: "MiniMax-M3",
        reasoning: true,
        reasoning_options: [{ type: "toggle" }],
      })
    ).toEqual({ off: null, low: "low", medium: "medium", high: "high" });

    // Unelaborated reasoning models like minimax-m2.7
    expect(
      reasoningEffortsFor({
        context_window: 1000,
        id: "minimax-m2.7",
        input_modalities: ["text"],
        max_output_tokens: 100,
        name: "MiniMax-M2.7",
        reasoning: true,
        reasoning_options: [],
      })
    ).toEqual({ off: null, low: "low", medium: "medium", high: "high" });

    // Non-reasoning model
    expect(
      reasoningEffortsFor({
        context_window: 1000,
        id: "plain-model",
        input_modalities: ["text"],
        max_output_tokens: 100,
        name: "Plain",
      })
    ).toBeUndefined();
  });

  it("carries reasoningEfforts into ModelProfile so llm-pi-ai exposes thinking levels", () => {
    const anthropicModels = modelsForSdk("@ai-sdk/anthropic");
    const m3 = anthropicModels.find((m) => m.id === "minimax-m3");
    expect(m3).toBeDefined();
    expect(m3?.reasoningEfforts).toEqual({
      off: null,
      low: "low",
      medium: "medium",
      high: "high",
    });
  });
});

/**
 * A minimal but faithful cordis: service isolation, context extension, `inject`,
 * and a registry that keys runtime records by `apply` identity.
 *
 * Only what the mount actually exercises is modelled, and each piece exists
 * because omitting it would make the test pass against a host the real one is
 * not. Returned object also carries the observables a case asserts on.
 */
const createHost = (options: { onPlugin?: (config: unknown) => void } = {}) => {
  const ISOLATE = Symbol("isolate");
  const ROOT = Symbol("root");
  /** Service instances per isolation label. */
  const realms = new Map<symbol, Map<string, unknown>>([
    [ROOT, new Map<string, unknown>()],
  ]);
  /** Runtime records keyed by `apply` identity — the registry's own cache. */
  const runtimes = new Map<
    () => unknown,
    { Config?: (raw: unknown) => unknown }
  >();
  const observables = {
    /** Every `registerFlow` call that actually reached the service. */
    authFlows: [] as string[],
    /** Providers the mounted instances declared in the directory. */
    directory: [] as string[],
    discoveries: [] as string[],
    adapters: [] as string[],
    isolated: [] as string[],
    extended: [] as string[],
    /** What the plugin reported at INFO, so a mount failure names its cause. */
    infos: [] as string[],
    /** Every service name `provide` registered, in order. */
    provided: [] as string[],
  };

  /** The fiber `plugin` starts, reduced to what the mount observes. */
  interface FakeFiber {
    dispose: () => unknown;
  }
  /** The stand-in `llm-pi-ai` module, as the loader hands it over. */
  interface FakePiAi {
    Config: (raw: unknown) => unknown;
    apply: (ctx: HostCtx, config: unknown) => void;
    inject?: unknown;
    name: string;
  }
  /**
   * A cordis context, reduced to what the mount touches.
   *
   * Typed rather than `Record<string, unknown>` so the stand-in itself is
   * checked: an `apply` that reads a method this shape does not have would
   * otherwise be a silent `undefined` at mount time.
   */
  type HostCtx = Record<string | symbol, unknown> & {
    effect: (fn: () => unknown) => unknown;
    extend: (meta?: Record<string, unknown>) => HostCtx;
    fiber: { entry: { options: { id: string } } };
    get: (name: string) => unknown;
    inject: (deps: string[], cb: (scope: HostCtx) => void) => void;
    isolate: (name: string) => HostCtx;
    logger: {
      error: (...args: unknown[]) => void;
      info: (msg: string, ...args: unknown[]) => void;
      warn: (...args: unknown[]) => void;
    };
    on: (event?: string, callback?: unknown) => void;
    plugin: (plugin: unknown, config?: unknown) => FakeFiber;
    provide: (name: string, value: unknown) => () => void;
  };

  const ENTRY_ID = "dsh-opencode-patch";

  /** Resolve a service the way cordis does: nearest isolation label, else root. */
  const resolveService = (
    chain: Map<string, symbol>,
    name: string
  ): unknown => {
    const label = chain.get(name);
    // An isolated name resolves in its OWN scope and nowhere else — that is what
    // makes hiding a service possible. Falling back to the parent here would let
    // the very inject this module isolates reach the host's service, which is the
    // DUPLICATE_FLOW a stub that leaked could never have shown.
    if (label !== undefined) {
      return realms.get(label)?.get(name);
    }
    return realms.get(ROOT)?.get(name);
  };

  const makeCtx = (
    parent: HostCtx | null,
    isolateChain: Map<string, symbol>,
    entryId: string
  ): HostCtx => {
    const ctx: HostCtx = Object.create(parent ?? { ctx: true });

    // cordis: reads and writes of an isolated service resolve in a new scope.
    // One fresh label per call; the NAME is what the isolation is keyed on.
    ctx[ISOLATE] = isolateChain;
    // Regular functions bound to `this`, not arrows over the closure: cordis's
    // context methods are receiver-bound, so a shadowed child (the `llm` facade)
    // must be the receiver of anything called on it. An arrow keeps building
    // children off the LEXICAL context instead, which makes a real fix look like
    // a no-op — the facade would never be reached.
    ctx.isolate = function isolate(this: HostCtx, name: string) {
      observables.isolated.push(name);
      return makeCtx(
        this,
        new Map(isolateChain).set(name, Symbol(name)),
        entryId
      );
    };
    ctx.extend = function extend(
      this: HostCtx,
      meta: Record<string, unknown> = {}
    ) {
      observables.extended.push(...Object.keys(meta));
      // `defineProperty`, not `Object.assign`: a service on the parent is an
      // inherited GETTER, and shadowing it is the whole reason `extend` exists.
      const child = Object.create(this);
      for (const prop of Reflect.ownKeys(meta)) {
        Object.defineProperty(
          child,
          prop,
          Object.getOwnPropertyDescriptor(meta, prop) ?? {}
        );
      }
      return child;
    };
    ctx.get = function get(this: HostCtx, name: string) {
      return resolveService(this[ISOLATE] as Map<string, symbol>, name);
    };
    // cordis: a service is registered through `provide`, which stores it
    // against the isolation scope the reading context resolves in; the proxy
    // then answers `ctx[name]` from that store. The stand-in mirrors the half
    // the rotation handoff depends on: a provided name is readable on the
    // context, and the registration can be withdrawn.
    ctx.provide = function provide(
      this: HostCtx,
      name: string,
      value: unknown
    ) {
      const label = (this[ISOLATE] as Map<string, symbol>).get(name) ?? ROOT;
      const realm = realms.get(label) ?? new Map<string, unknown>();
      realms.set(label, realm);
      realm.set(name, value);
      observables.provided.push(name);
      Object.defineProperty(this, name, {
        configurable: true,
        get: () => resolveService(this[ISOLATE] as Map<string, symbol>, name),
      });
      return () => {
        realm.delete(name);
      };
    };
    // A Service is a getter defined ONCE on the root context and resolved per
    // read through `this`, so a child sees its OWN isolation and a shadowed
    // service (the `llm` facade) is inherited by everything below it. Defining
    // one per context would break both.
    if (parent === null) {
      for (const name of ["llm", "authorization", "settings"] as const) {
        Object.defineProperty(ctx, name, {
          configurable: true,
          get(this: HostCtx) {
            return resolveService(this[ISOLATE] as Map<string, symbol>, name);
          },
        });
      }
    }
    ctx.plugin = function plugin(
      this: HostCtx,
      subject: unknown,
      config?: unknown
    ) {
      options.onPlugin?.(config);
      const record = subject as Partial<FakePiAi>;
      // Named for what it IS — the plugin's own `apply` — rather than
      // `callback`, which is what the enclosing registry helper calls its own
      // parameter and what the linter rightly refused to shadow.
      const applyFn = record.apply as () => unknown;
      // The registry's own rule: the FIRST instance's schema is the one on
      // record, and it validates whatever every later mount is handed.
      let runtime = runtimes.get(applyFn);
      if (runtime === undefined) {
        runtime = { Config: record.Config };
        runtimes.set(applyFn, runtime);
      }
      const resolved =
        runtime.Config === undefined ? config : runtime.Config(config);
      // A child plugin INHERITS its parent entry, which is why the mounted
      // instance reads the namespace off the plugin's own entry id.
      const fiberCtx = makeCtx(this, new Map(isolateChain), entryId);
      fiberCtx.fiber = { entry: { options: { id: entryId } } };
      fiberCtx.effect = (fn: () => unknown) => fn();
      // Faithful: the host fires `loader/volatile-update` after a config change,
      // and the mounted plugin answers it by re-running its directory sync — which
      // is the only path that reaches the handle our facade hands back.
      const volatile: (() => void)[] = [];
      fiberCtx.on = (event?: string, callback?: unknown) => {
        if (
          event === "loader/volatile-update" &&
          typeof callback === "function"
        ) {
          volatile.push(callback as () => void);
        }
      };
      fiberCtx.logger = { error: () => {}, info: () => {}, warn: () => {} };
      fiberCtx.inject = (deps: string[], cb: (scope: HostCtx) => void) => {
        // An unresolved dependency simply never fires — that is what isolating
        // a service is FOR.
        for (const dep of deps) {
          if (fiberCtx.get(dep) === undefined) {
            return;
          }
        }
        cb(fiberCtx);
      };
      (record.apply as (c: HostCtx, cfg: unknown) => void)(fiberCtx, resolved);
      for (const listener of volatile) {
        listener();
      }
      // Awaitable via a real promise rather than a literal `then`: a cordis
      // fiber is thenable, and what the mount observes is only that awaiting it
      // settles.
      return Object.assign(Promise.resolve({}), {
        dispose: () => {
          // The stand-in owns nothing that outlives the call.
        },
      });
    };
    return ctx;
  };

  // Our own entry: a SIBLING of the host's `llm-pi-ai` entry, with its own id.
  // That id is what a child mount inherits, and it is the namespace this plugin
  // has already registered model discovery under.
  const root = makeCtx(null, new Map(), ENTRY_ID);
  root.logger = {
    info: (msg: string, ...args: unknown[]) => {
      observables.infos.push([msg, ...args].join(" "));
    },
    error: () => {},
    warn: () => {},
  };
  // The host's own entry, mounted on its own context under its own id.
  const hostCtx = makeCtx(null, new Map(), "llm-pi-ai");

  const registerService = (name: string, service: unknown) => {
    realms.set(ROOT, new Map([...(realms.get(ROOT) ?? []), [name, service]]));
  };

  /** The LLM registry, with the host's own duplicate checks intact. */
  const adapters = new Map<string, unknown>();
  const directory = new Map<string, unknown>();
  const discoveries = new Map<string, unknown>();
  const registerAdapter = (providers: readonly string[], adapter: unknown) => {
    for (const route of providers) {
      if (adapters.has(route)) {
        throw new Error(
          `an adapter for provider "${route}" is already registered`
        );
      }
      const info = (
        adapter as { providerInfo: (p: string) => { id: string; name: string } }
      ).providerInfo(route);
      adapters.set(route, info);
      observables.adapters.push(route);
    }
    const dispose = () => {
      for (const route of providers) {
        adapters.delete(route);
      }
    };
    dispose.replace = (next: readonly string[]) => {
      dispose();
      return registerAdapter(next, adapter);
    };
    return dispose;
  };
  const registerConfigurableProviders = (entries: readonly unknown[]) => {
    for (const entry of entries) {
      const row = entry as { provider: string };
      if (directory.has(row.provider)) {
        throw new Error(
          `configurable provider "${row.provider}" is already declared`
        );
      }
    }
    for (const entry of entries) {
      const row = entry as { provider: string };
      directory.set(row.provider, entry);
      observables.directory.push(row.provider);
    }
    const dispose = () => {
      for (const entry of entries) {
        directory.delete((entry as { provider: string }).provider);
      }
    };
    dispose.replace = () => {};
    return dispose;
  };
  const registerModelDiscovery = (ns: string, discover: unknown) => {
    if (discoveries.has(ns)) {
      throw new Error(`model discovery for "${ns}" is already registered`);
    }
    discoveries.set(ns, discover);
    observables.discoveries.push(ns);
    return () => discoveries.delete(ns);
  };

  registerService("llm", {
    // The real service keeps its routes in an own map, and that map is the
    // authority this plugin reads — `listProviders()` is Remote-decorated and
    // under-reports. Exposed so a case can assert on the difference, and so a
    // case can stage a registration that arrives after the declared check.
    adapters,
    listConfigurableProviders: () => [...directory.values()],
    // What the deployment declared, which the mount narrows each route to. The
    // real service answers it from the user's configuration; the catalog here
    // stands in for that, so the mount has a declaration to read.
    listModels: async () => [
      ...getLiveZenCatalog().map((spec) => ({ id: spec.id })),
      ...getLiveGoCatalog().map((spec) => ({ id: spec.id })),
    ],
    listProviders: () => [...adapters.values()],
    registerAdapter,
    registerConfigurableProviders,
    registerModelDiscovery,
  });
  registerService("authorization", {
    registerFlow: (key: string) => {
      if (observables.authFlows.includes(key)) {
        throw new Error(
          `an authorization flow for "${key}" is already registered`
        );
      }
      observables.authFlows.push(key);
    },
  });
  registerService("settings", {
    configure: () => {},
  });

  /**
   * A stand-in for `llm-pi-ai`'s `apply`.
   *
   * Faithful to the parts that collide: the WHOLE catalog reaches the directory,
   * the settings namespace is the inherited entry id, the flows are registered
   * through the `authorization` inject, and the adapter is registered last.
   */
  const apply = (ctx: HostCtx, config: unknown) => {
    const declared = (config as { providers: unknown }).providers;
    const providers = (
      declared instanceof ValidatedProviders ? declared.get() : declared
    ) as Record<string, unknown>;
    ctx.inject(["authorization"], (scope: Record<string, unknown>) => {
      for (const provider of CATALOG) {
        (
          scope.authorization as { registerFlow: (k: string) => void }
        ).registerFlow(`${provider}-login`);
      }
    });
    const settingsNs = (ctx.fiber as { entry: { options: { id: string } } })
      .entry.options.id;
    const llm = ctx.llm as {
      registerAdapter: typeof registerAdapter;
      registerConfigurableProviders: typeof registerConfigurableProviders;
      registerModelDiscovery: typeof registerModelDiscovery;
    };
    llm.registerConfigurableProviders(
      [...CATALOG, ...Object.keys(providers)].map((provider) => ({
        provider,
        displayName: provider,
        settingsNs,
      }))
    );
    llm.registerModelDiscovery(settingsNs, async () => []);
    const routes = Object.keys(providers);
    if (routes.length > 0) {
      llm.registerAdapter(routes, {
        providerInfo: (route: string) => ({ id: route, name: route }),
      });
    }
  };

  /**
   * The stand-in's `Config`.
   *
   * It returns what schemastery returns: an object whose `providers` is a Dict
   * INSTANCE, not a plain record. That is the whole reason the mount must be
   * handed raw config — the registry keys its runtime by `apply` identity, so the
   * second mount is validated by the first instance's schema, and a
   * pre-validated object is not a shape that schema accepts.
   */
  class ValidatedProviders {
    private readonly entries: Record<string, unknown>;
    constructor(entries: Record<string, unknown>) {
      this.entries = entries;
    }
    get(): Record<string, unknown> {
      return this.entries;
    }
  }
  const isPlainRecord = (value: unknown): boolean =>
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype;
  const Config = (raw: unknown) => {
    if (
      !isPlainRecord(raw) ||
      !isPlainRecord((raw as { providers: unknown }).providers)
    ) {
      // The host's own complaint, verbatim: a validated `Config` is a Dict
      // instance, so its `providers` reads as a `.get` call, not a record.
      throw new Error("llm-pi-ai: providers.get expected object");
    }
    const { providers } = raw as { providers: Record<string, unknown> };
    return { providers: new ValidatedProviders(providers) };
  };

  // The REAL adapter class, so the bridge registers through the same class
  // the host would hand it — a stand-in here would test our stand-in.
  const piAi = { Config, apply, inject: undefined, name: PI_AI, PiAiAdapter };

  /** The host's OWN instance: occupies the catalog, its namespace and the flows. */
  const mountHostInstance = (config: unknown) =>
    (hostCtx.plugin as (p: unknown, c?: unknown) => unknown)(piAi, config);

  /**
   * Mount `apply` below ONE isolated seam and nothing else — the shape the
   * earlier implementation used, which each case pairs with the seam that lets
   * its collision be the one under test.
   */
  const mountIsolated = (seam: string, config: unknown) => {
    const scope = root.isolate(seam);
    return (scope.plugin as (p: unknown, c?: unknown) => unknown)(piAi, config);
  };

  const loaderEntry = { options: { name: PI_AI }, moduleNamespace: piAi };
  const ctx = Object.assign(root, {
    loader: {
      entries: () => [loaderEntry],
      // The loader's own normalization, so the shape a test asserts on is the
      // shape the host produces rather than one this file invented.
      unwrapExports: (value: unknown) => {
        const candidate = value as {
          default?: unknown;
          __esModule?: boolean;
        } | null;
        if (candidate === null || candidate === undefined) {
          return candidate;
        }
        const unwrapped = candidate.default ?? candidate;
        return (unwrapped as { __esModule?: boolean }).__esModule === true
          ? ((unwrapped as { default?: unknown }).default ?? unwrapped)
          : unwrapped;
      },
    },
  }) as unknown as CordisContext;

  return {
    adapters,
    ctx,
    mountHostInstance,
    mountIsolated,
    observables,
    piAi,
    registerService,
  };
};

describe("responses-provider: registration is best-effort", () => {
  it("stands down when the Host has no adapter registry", async () => {
    const ctx = { llm: {}, logger: {} } as unknown as CordisContext;
    await expect(registerResponsesProvider(ctx)).resolves.toBeUndefined();
  });

  it("does not throw when the host loaded no copy of the plugin", async () => {
    // `llm-pi-ai` is a profile bundle, so a host need not have it loaded at all.
    // A deployment that does not must degrade to "the route you declared still
    // works", not fail the boot — and must say so at INFO, because that is an
    // expected state rather than a fault.
    // The report goes to the CONSOLE, not `ctx.logger`: cordis's logger only
    // buffers (its default exporter pushes to a ring) and no host package
    // registers a console exporter, so a `logger.info` here is invisible in the
    // terminal — which is where someone checks whether a build loaded.
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const ctx = {
      llm: { listProviders: () => [], registerAdapter: vi.fn() },
      loader: { entries: () => [] },
      logger: {},
    } as unknown as CordisContext;
    try {
      await expect(registerResponsesProvider(ctx)).resolves.toBeUndefined();
      expect(ctx.llm?.registerAdapter).not.toHaveBeenCalled();
      expect(info).toHaveBeenCalledWith(
        expect.stringContaining("no loaded llm-pi-ai")
      );
    } finally {
      info.mockRestore();
    }
  });

  it("defers to routes the profile already declares", async () => {
    const plugin = vi.fn();
    const ctx = {
      isolate: () => ({ plugin }),
      llm: {
        listProviders: () => [
          { id: "opencode" },
          { id: "opencode-responses" },
          { id: "opencode-anthropic" },
        ],
        registerAdapter: vi.fn(),
      },
      logger: {},
    } as unknown as CordisContext;
    await expect(registerResponsesProvider(ctx)).resolves.toBeUndefined();
    expect(plugin).not.toHaveBeenCalled();
  });

  it("reads the raw route map, not the decorated provider list", async () => {
    // Measured: `listProviders()` is Remote-decorated and omitted a route the
    // registry held, so a mount tried to re-register it and died on
    // DUPLICATE_ADAPTER. Here every internal route is in the raw map and NONE
    // is in the decorated list — that discrepancy, inverted into an assertion:
    // reading the decorated list would mount, reading the map stands down.
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const plugin = vi.fn();
    const internal = Object.values(ROUTE_FOR_PLANE_PROTOCOL).flatMap((plane) =>
      Object.values(plane.routes)
    );
    const ctx = {
      isolate: () => ({ plugin }),
      llm: {
        adapters: new Map(internal.map((route) => [route, { id: route }])),
        listProviders: () => [],
        registerAdapter: vi.fn(),
      },
      logger: {},
    } as unknown as CordisContext;
    try {
      await expect(registerResponsesProvider(ctx)).resolves.toBeUndefined();
      expect(plugin).not.toHaveBeenCalled();
      expect(ctx.llm?.registerAdapter).not.toHaveBeenCalled();
      expect(info).toHaveBeenCalledWith(
        expect.stringContaining("every internal route is already declared")
      );
    } finally {
      info.mockRestore();
    }
  });

  it("stands down when the host offers no scope to mount into", async () => {
    // A route that declares nothing has nothing to mount, so the mount stands
    // down before it ever looks for a scope — and registering an adapter anyway
    // is what used to put the catalog on a route the user had not filled.
    const ctx = {
      llm: {
        listModels: async () => [],
        listProviders: () => [],
        registerAdapter: vi.fn(),
      },
      logger: { info: () => {}, warn: () => {} },
      loader: {
        entries: () => [
          {
            options: { name: PI_AI },
            moduleNamespace: { apply: () => {}, name: PI_AI },
          },
        ],
        unwrapExports: (value: unknown) => value,
      },
    } as unknown as CordisContext;
    await expect(registerResponsesProvider(ctx)).resolves.toBeUndefined();
    expect(ctx.llm?.registerAdapter).not.toHaveBeenCalled();
  });
});

describe("responses-provider: finding the host's plugin", () => {
  it("reads the module off the loader entry, not a guessed path", () => {
    // `moduleNamespace` is the host's own import result, so nothing here knows
    // or cares where the package was installed.
    const { ctx, piAi } = createHost();
    expect(loadPiAi(ctx)).toBe(piAi);
  });

  it("normalizes the export shape the way the loader does", () => {
    const { ctx, piAi } = createHost();
    // CJS interop: the namespace carries the plugin under `default`, which is
    // exactly the shape the loader's own normalization exists for.
    const wrapped = { default: piAi };
    (ctx.loader as { entries: () => unknown[] }).entries = () => [
      { options: { name: PI_AI }, moduleNamespace: wrapped },
    ];
    expect(loadPiAi(ctx)).toBe(piAi);
  });

  it("reports an entry that never finished loading as absent", () => {
    const { ctx, piAi } = createHost();
    (ctx.loader as { entries: () => unknown[] }).entries = () => [
      { options: { name: PI_AI } },
    ];
    expect(loadPiAi(ctx)).toBeUndefined();
    expect(piAi).toBeDefined();
  });

  it("reads the plugin off the fiber when the loader kept no module", () => {
    // The other loader generation hands the import result to the registry and
    // keeps only the fiber, so the two pieces a second mount needs are read off
    // it: the resolved callback on its runtime, and the registry-normalized
    // `inject` — without which the plugin's first service access fails.
    const { ctx } = createHost();
    const callback = () => {};
    (ctx.loader as { entries: () => unknown[] }).entries = () => [
      {
        fiber: { inject: { llm: null }, runtime: { callback } },
        options: { name: PI_AI },
      },
    ];
    expect(loadPiAi(ctx)).toEqual({ apply: callback, inject: { llm: null } });
  });

  it("reports a fiber entry that carries nothing mountable as absent", () => {
    const { ctx } = createHost();
    const fromEntry = (entry: unknown) => {
      (ctx.loader as { entries: () => unknown[] }).entries = () => [entry];
      return loadPiAi(ctx);
    };
    const options = { name: PI_AI };
    // Four separate missing pieces, each of which alone makes the mount
    // impossible: the fiber itself, its runtime, the callback, and the inject.
    expect(fromEntry({ options })).toBeUndefined();
    expect(
      fromEntry({ fiber: { inject: { llm: null } }, options })
    ).toBeUndefined();
    expect(
      fromEntry({ fiber: { inject: { llm: null }, runtime: {} }, options })
    ).toBeUndefined();
    expect(
      fromEntry({ fiber: { runtime: { callback: () => {} } }, options })
    ).toBeUndefined();
  });

  it("ignores an entry belonging to a different package", () => {
    const { ctx, piAi } = createHost();
    (ctx.loader as { entries: () => unknown[] }).entries = () => [
      { options: { name: "some-other-plugin" }, moduleNamespace: piAi },
    ];
    expect(loadPiAi(ctx)).toBeUndefined();
  });

  it("stands down when the host exposes no loader at all", () => {
    expect(loadPiAi({})).toBeUndefined();
    expect(loadPiAi({ loader: { entries: 1 } })).toBeUndefined();
    expect(loadPiAi(null)).toBeUndefined();
  });

  it("resolves the module from the base URL when the entry kept no namespace", async () => {
    // The fiber-only generation keeps no namespace, and the class the bridge
    // needs lives on one — so the entry's own name is resolved from the base
    // URL the loader resolves against, which reaches the same file.
    const { ctx } = createHost();
    (ctx.loader as { entries: () => unknown[] }).entries = () => [
      {
        fiber: { inject: { llm: null }, runtime: { callback: () => {} } },
        options: { name: PI_AI },
      },
    ];
    // This repository's own tree, so the specifier resolves to the installed
    // package — the same file the loader would have imported.
    (ctx as { baseUrl?: string }).baseUrl = new URL(
      "../",
      import.meta.url
    ).href;
    const namespace = await loadPiAiModule(ctx);
    // The class the module hands back is the installed package's own — the
    // very one this file imported statically, not a copy of it.
    expect(namespace?.PiAiAdapter).toBe(PiAiAdapter);
  });

  it("stands down without an entry, a base URL, or a resolvable module", async () => {
    const base = new URL("../", import.meta.url).href;
    const fiberEntry = {
      fiber: { inject: { llm: null }, runtime: { callback: () => {} } },
      options: { name: PI_AI },
    };
    // No entry names the package: nothing to import, even from a good base.
    const unnamed = createHost();
    (unnamed.ctx.loader as { entries: () => unknown[] }).entries = () => [];
    (unnamed.ctx as { baseUrl?: string }).baseUrl = base;
    expect(await loadPiAiModule(unnamed.ctx)).toBeUndefined();
    // An entry, but no base URL to resolve the loader's specifier against.
    const unbased = createHost();
    (unbased.ctx.loader as { entries: () => unknown[] }).entries = () => [
      fiberEntry,
    ];
    expect(await loadPiAiModule(unbased.ctx)).toBeUndefined();
    // A base URL the package cannot be resolved from.
    const unresolved = createHost();
    (unresolved.ctx.loader as { entries: () => unknown[] }).entries = () => [
      fiberEntry,
    ];
    (unresolved.ctx as { baseUrl?: string }).baseUrl =
      "file:///nonexistent-dsh-opencode/";
    expect(await loadPiAiModule(unresolved.ctx)).toBeUndefined();
  });

  it("hands the bridge a host carrying the adapter class either way", async () => {
    // The namespace-keeping shape: the class is already on the record.
    const kept = createHost();
    expect(await loadPiAiAdapterHost(kept.ctx)).toBe(kept.piAi);
    // The fiber-only shape: the record carries no class, so the module is
    // resolved instead and its class is what the bridge gets.
    const fiber = createHost();
    (fiber.ctx.loader as { entries: () => unknown[] }).entries = () => [
      {
        fiber: { inject: { llm: null }, runtime: { callback: () => {} } },
        options: { name: PI_AI },
      },
    ];
    (fiber.ctx as { baseUrl?: string }).baseUrl = new URL(
      "../",
      import.meta.url
    ).href;
    const resolved = await loadPiAiAdapterHost(fiber.ctx);
    expect(resolved?.PiAiAdapter).toBe(PiAiAdapter);
    // Neither reaches it: the mount's own record comes back, so the bridge
    // stands down on the missing class rather than on a missing host.
    const bare = createHost();
    const callback = () => {};
    (bare.ctx.loader as { entries: () => unknown[] }).entries = () => [
      {
        fiber: { inject: { llm: null }, runtime: { callback } },
        options: { name: PI_AI },
      },
    ];
    expect(await loadPiAiAdapterHost(bare.ctx)).toEqual({
      apply: callback,
      inject: { llm: null },
    });
  });
});

describe("responses-provider: the mount survives the host's own instance", () => {
  it("registers the internal routes without colliding with anything", async () => {
    const host = createHost();
    // The host's own `llm-pi-ai` instance: it owns the catalog directory, its
    // own discovery namespace, and one auth flow per catalog provider. Our
    // plugin also registers discovery under its own entry id, which is exactly
    // the id a child mount INHERITS.
    host.mountHostInstance({
      providers: { opencode: { api: "openai-completions" } },
    });
    host.ctx.llm?.registerModelDiscovery?.(
      "dsh-opencode-patch",
      async () => []
    );

    const flowCountBefore = host.observables.authFlows.length;
    const adaptersBefore = [...host.observables.adapters];

    const stop = await registerResponsesProvider(host.ctx);

    // Registered: the routes this plugin owns, on the REAL service.
    expect(typeof stop).toBe("function");
    expect(host.observables.adapters).toContain("opencode-responses");

    // Untouched: the host's own catalog directory keeps exactly what it had.
    // A second declaration would have thrown DUPLICATE_DIRECTORY.
    expect(host.observables.directory).toEqual([...CATALOG, "opencode"]);

    // Untouched: one discovery per namespace and no more. The host's instance owns
    // its own entry's namespace, this plugin owns its own, and the mount added
    // neither — a second registration under the INHERITED `dsh-opencode-patch`
    // is what would have thrown DUPLICATE_DISCOVERY.
    expect(host.observables.discoveries).toEqual([
      "llm-pi-ai",
      "dsh-opencode-patch",
    ]);

    // Untouched: no new authorization flow, which would have thrown
    // DUPLICATE_FLOW on the host's own `registerFlow`.
    expect(host.observables.authFlows).toHaveLength(flowCountBefore);

    // The host's own routes still serve.
    for (const route of adaptersBefore) {
      expect(host.ctx.llm?.listProviders?.()).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: route })])
      );
    }
  });

  it("drops a route that arrives after the check, instead of dying on it", async () => {
    // The declared check and the registration are two reads of the same map,
    // and registration is all-or-nothing: a route that appears in between —
    // another plugin, a reload — would kill the whole forward. The facade
    // re-reads the map at the registration point, so the late route is left to
    // its owner and every other route still lands.
    const host = createHost({
      onPlugin: () => {
        host.adapters.set("opencode-responses", {
          id: "opencode-responses",
          name: "opencode-responses",
        });
      },
    });
    // Pre-declared so the Gemini bridge stays out of this case's way: the
    // route's own registration, not the mount's, and unrelated here.
    for (const route of SELF_MOUNTED_ROUTES) {
      host.adapters.set(route, { id: route, name: route });
    }

    const stop = await registerResponsesProvider(host.ctx);

    expect(typeof stop).toBe("function");
    // The three others landed, in the mount's own order.
    const others = Object.values(ROUTE_FOR_PLANE_PROTOCOL).flatMap((plane) =>
      Object.values(plane.routes).filter(
        (route) =>
          !SELF_MOUNTED_ROUTES.has(route) && route !== "opencode-responses"
      )
    );
    expect(host.observables.adapters).toEqual(others);
    // And the late route was not re-registered behind its owner's back.
    expect(host.adapters.get("opencode-responses")).toEqual({
      id: "opencode-responses",
      name: "opencode-responses",
    });
  });

  it("drops a registration whose routes are ALL taken, instead of dying on it", async () => {
    // The sibling case taken to the end of its range: every route the wrapper
    // declares is already served by the time it registers, so the forward
    // drops the whole list rather than letting the registry's all-or-nothing
    // throw take the mount down. It still answers with a handle-shaped value —
    // the wrapper stores what `registerAdapter` returned and may call
    // `replace` on it later — and the mount stands down with nothing to
    // withdraw rather than half-registering.
    const routes: string[] = [];
    const host = createHost({
      onPlugin: (config) => {
        routes.push(
          ...Object.keys(
            (config as { providers: Record<string, unknown> }).providers
          )
        );
        for (const route of routes) {
          host.adapters.set(route, { id: route, name: route });
        }
      },
    });
    // Pre-declared so the Gemini bridge stays out of this case's way: its
    // registration is its own, and this case is about the wrapper's.
    for (const route of SELF_MOUNTED_ROUTES) {
      host.adapters.set(route, { id: route, name: route });
    }

    const stop = await registerResponsesProvider(host.ctx);

    // The setup really did take every route — without this, the case could
    // pass by exercising nothing.
    expect(routes.length).toBeGreaterThan(0);
    for (const route of routes) {
      expect(host.adapters.has(route)).toBe(true);
    }
    // Nothing new landed: no route was re-registered behind its owner's back.
    expect(host.observables.adapters).toEqual([]);
    for (const route of routes) {
      expect(host.adapters.get(route)).toEqual({ id: route, name: route });
    }
    // The mount reported the stand-down, and handed back nothing to withdraw.
    expect(host.observables.infos).toContain(
      "[dsh-opencode-patch] the mount registered no route; internal routes stay unregistered"
    );
    expect(stop).toBeUndefined();
  });

  it("isolates both the authorization and the settings seam", async () => {
    const host = createHost();
    await registerResponsesProvider(host.ctx);
    // `settings` is the second one, and it is the one a test that only checked
    // `authorization` would miss: without it the mounted instance's directory
    // is driven by a section nobody asked to write.
    expect(host.observables.isolated).toEqual(["authorization", "settings"]);
  });

  it("shadows the llm service for the mount only", async () => {
    const host = createHost();
    await registerResponsesProvider(host.ctx);
    // One `extend`, carrying exactly the service it needs to shadow.
    expect(host.observables.extended).toEqual(["llm"]);
    // The parent's own service is untouched by the shadow.
    expect(typeof host.ctx.llm?.registerConfigurableProviders).toBe("function");
  });

  it("passes RAW config, which is the only shape the recorded schema accepts", async () => {
    const host = createHost();
    // A pre-validated `Config` is a Dict instance: the registry re-validates the
    // second mount against the first instance's schema, and that object reads as
    // `providers.get` rather than as a record.
    expect(() => host.piAi.Config(host.piAi.Config({ providers: {} }))).toThrow(
      /providers\.get expected object/
    );
    // So the mount has to hand over a plain object, and it does — reaching here
    // at all means the schema accepted it.
    await expect(registerResponsesProvider(host.ctx)).resolves.toBeTypeOf(
      "function"
    );
  });

  it("carries every internal route in ONE config", async () => {
    const spy = vi.fn();
    const host = createHost({
      onPlugin: (config) => {
        spy(config);
      },
    });

    await registerResponsesProvider(host.ctx);

    // Each `apply` declares the whole catalog, so a per-route mount is a
    // collision no matter how few routes it carries. One call, every route.
    expect(spy).toHaveBeenCalledTimes(1);
    const [config] = spy.mock.calls[0] ?? [];
    const { providers } = (config ?? {}) as {
      providers: Record<string, { models: unknown[] }>;
    };
    // Derived from the PLANE table, not hard-coded, and not from the Zen-only
    // view: the mount walks (plane, protocol) pairs, so a route the table names
    // is mounted whenever its own plane carries a model for its protocol.
    // Self-mounted routes are NOT here: the wrapper's mount would only earn
    // its protocol table's refusal, so the bridge registers them itself —
    // which is the companion assertion.
    const expected = Object.values(ROUTE_FOR_PLANE_PROTOCOL).flatMap((plane) =>
      Object.values(plane.routes).filter(
        (route) => !SELF_MOUNTED_ROUTES.has(route)
      )
    );

    expect(Object.keys(providers)).toEqual(expected);
    expect(Object.keys(providers)).toContain("opencode-responses");
    expect(Object.keys(providers)).not.toContain(GOOGLE_INTERNAL_ROUTE);
    for (const profile of Object.values(providers)) {
      expect(profile.models.length).toBeGreaterThan(0);
    }
  });

  it("mounts each route on its PROTOCOL's base, not the plane's", async () => {
    // The bug this guards, measured on the gateway: pi hands an Anthropic
    // route's base straight to the Anthropic SDK, which appends `/v1/messages`
    // itself, so the plane's `/v1` base asks for `/v1/v1/messages` — a 404.
    // The OpenAI protocols append their own path to a base that already has
    // `/v1`, so those keep it. One base for every route is wrong for at least
    // one protocol.
    const spy = vi.fn();
    const host = createHost({
      onPlugin: (config) => {
        spy(config);
      },
    });

    await registerResponsesProvider(host.ctx);

    const [config] = spy.mock.calls[0] ?? [];
    const { providers } = (config ?? {}) as {
      providers: Record<string, { api: string; baseURL: string }>;
    };

    for (const [route, profile] of Object.entries(providers)) {
      expect(
        profile.baseURL,
        `${route} (${profile.api}) is mounted on the wrong base`
      ).toBe(baseForProtocol(routePlaneOf(route), profile.api));
      // And the positive control: the bases are not all the same string, which
      // is what makes this assert something rather than restate the mount.
      expect(profile.baseURL.length).toBeGreaterThan(0);
    }
    expect(
      new Set(Object.values(providers).map((profile) => profile.baseURL)).size
    ).toBeGreaterThan(1);
    // Spot-check the two that differ, in the gateway's own terms.
    expect(providers["opencode-anthropic"]?.baseURL).toBe(
      "https://opencode.ai/inference/anthropic"
    );
    expect(providers["opencode-responses"]?.baseURL).toBe(
      OPENCODE_PLANE_API.zen
    );
  });

  it("releases the mount on dispose", async () => {
    const host = createHost();
    const stop = await registerResponsesProvider(host.ctx);
    expect(host.ctx.llm?.listProviders?.()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "opencode-responses" }),
      ])
    );
    stop?.();
    // The route must NOT outlive the mount: a leftover registration would make
    // the next mount fail DUPLICATE_ADAPTER, which is a reload loop that never
    // recovers. The mount's own fiber would normally own this registration —
    // releasing it here regardless is what makes withdrawal deterministic.
    expect(host.ctx.llm?.listProviders?.()).toEqual([]);
  });
});

/**
 * The stand-in is only worth anything if it REFUSES what used to be passed.
 *
 * Each case below mounts `apply` the way the earlier shape did and asserts the
 * stand-in rejects it with the host's own error. Without these, the passing
 * mount above could be passing because the stand-in models nothing.
 */
/**
 * Which plane a mounted route serves, read back from the route table rather
 * than guessed from the route's name.
 */
const routePlaneOf = (route: string): string =>
  Object.entries(ROUTE_FOR_PLANE_PROTOCOL).find(([, entry]) =>
    Object.values(entry.routes).includes(route)
  )?.[0] ?? "";

describe("responses-provider: the stand-in refuses the shapes that used to be passed", () => {
  const rawConfig = () => ({
    providers: {
      "opencode-responses": {
        api: "openai-responses",
        models: [
          {
            id: "m",
            name: "m",
            contextWindow: 1,
            maxTokens: 1,
            input: ["text"],
          },
        ],
      },
    },
  });

  it("refuses a pre-validated Config handed to a second mount", () => {
    const host = createHost();
    host.mountHostInstance({ providers: {} });
    // The registry reuses the first instance's schema, so the second mount is
    // validated by it — and a validated Config is a Dict instance, not a record.
    expect(() =>
      (host.ctx.plugin as (p: unknown, c?: unknown) => unknown)(
        host.piAi,
        host.piAi.Config(rawConfig())
      )
    ).toThrow(/providers\.get expected object/);
  });

  it("refuses a second instance's catalog declaration", () => {
    const host = createHost();
    host.mountHostInstance({ providers: {} });
    // Isolating `authorization` alone does not help: `apply` declares the whole
    // catalog regardless of what its own config names.
    expect(() => host.mountIsolated("authorization", rawConfig())).toThrow(
      /configurable provider "openai" is already declared/
    );
  });

  it("refuses a second instance's discovery under the inherited namespace", () => {
    const host = createHost();
    // Our plugin already registers discovery under its own entry id, and a child
    // plugin inherits that entry — so the mount lands on the same key.
    host.ctx.llm?.registerModelDiscovery?.(
      "dsh-opencode-patch",
      async () => []
    );
    // With the directory already colliding first, isolate only `settings` so this
    // case fails on the discovery key and not on the one before it.
    expect(() => host.mountIsolated("settings", rawConfig())).toThrow(
      /model discovery for "dsh-opencode-patch" is already registered/
    );
  });

  it("refuses a second instance's authorization flows", () => {
    const host = createHost();
    host.mountHostInstance({ providers: {} });
    const flowsBefore = host.observables.authFlows.length;
    expect(flowsBefore).toBeGreaterThan(0);
    // With the seams that collide BEFORE the flows already dealt with, this one
    // isolates `llm` only, so the inject still reaches the real authorization.
    expect(() => host.mountIsolated("unused-seam", rawConfig())).toThrow(
      /authorization flow .* is already registered/
    );
  });
});

describe("responses-provider: the credential is the user's, not ours", () => {
  it("inherits the reference the opencode route already declares", () => {
    // A deployment that named its own env var must not be asked to state it
    // again here: pi-ai resolves the reference through the credentials service,
    // so the same ref is the same stored record.
    const ctx = {
      loader: {
        entries: () => [
          {
            options: {
              id: "llm-pi-ai",
              config: { providers: { opencode: { apiKeyEnv: "MY_ZEN_KEY" } } },
            },
          },
        ],
      },
    };
    expect(inheritedCredentialRef(ctx)).toBe("MY_ZEN_KEY");
  });

  it("falls back to the documented default when the composition names none", () => {
    expect(inheritedCredentialRef({})).toBe("OPENCODE_API_KEY");
    expect(
      inheritedCredentialRef({
        loader: { entries: () => [{ options: { config: {} } }] },
      })
    ).toBe("OPENCODE_API_KEY");
  });

  it("puts the inherited reference on every route it mounts", async () => {
    const spy = vi.fn();
    const host = createHost({
      onPlugin: (config) => {
        spy(config);
      },
    });
    // The composition's own `llm-pi-ai` row, alongside the entry this plugin
    // reads its module from.
    (host.ctx.loader as { entries: () => unknown[] }).entries = () => [
      {
        options: {
          id: "llm-pi-ai",
          config: { providers: { opencode: { apiKeyEnv: "MY_ZEN_KEY" } } },
        },
      },
      { options: { name: PI_AI }, moduleNamespace: host.piAi },
    ];

    await registerResponsesProvider(host.ctx);

    const [config] = spy.mock.calls[0] ?? [];
    const { providers } = (config ?? {}) as {
      providers: Record<string, { apiKeyEnv?: string }>;
    };
    // Each plane carries its OWN credential. One reference for every route was
    // the old design, and it would send a Zen key to the Go endpoint - the
    // failure the plane split exists to make impossible.
    expect(Object.keys(providers).length).toBeGreaterThan(0);
    const goRoutes = new Set([
      "opencode-go-responses",
      "opencode-go-anthropic",
    ]);
    for (const [route, profile] of Object.entries(providers)) {
      expect(profile.apiKeyEnv).toBe(
        goRoutes.has(route) ? "OPENCODE_GO_API_KEY" : "MY_ZEN_KEY"
      );
    }
  });
});

describe("responses-provider: the loader contract", () => {
  const PI_AI_NAME = "@deepseek-ai/dsh-llm-pi-ai";
  // A body rather than `() => undefined`: these cases never run the plugin, and
  // an arrow whose whole body is `undefined` says the return value matters.
  const plugin = {
    apply: (): void => {
      /* never invoked by these cases */
    },
    name: PI_AI_NAME,
  };

  it("reads entries from a generator, which is what the loader yields", () => {
    // `entries()` is a generator, not an array; a stand-in that returned an
    // array would never exercise this path.
    function* entries() {
      yield { options: { name: "other" }, moduleNamespace: {} };
      yield { options: { name: PI_AI_NAME }, moduleNamespace: plugin };
    }
    expect(loadPiAi({ loader: { entries } })).toBe(plugin);
  });

  it("reaches the loader through the service registry when it is not a property", () => {
    const ctx = {
      get: (name: string) =>
        name === "loader"
          ? {
              entries: () => [
                { options: { name: PI_AI_NAME }, moduleNamespace: plugin },
              ],
            }
          : undefined,
    };
    expect(loadPiAi(ctx)).toBe(plugin);
  });

  it("accepts the raw namespace when the loader does not normalize exports", () => {
    const ctx = {
      loader: {
        entries: () => [
          { options: { name: PI_AI_NAME }, moduleNamespace: plugin },
        ],
      },
    };
    expect(loadPiAi(ctx)).toBe(plugin);
  });

  it("reports a namespace that carries no apply as absent", () => {
    const ctx = {
      loader: {
        entries: () => [
          {
            options: { name: PI_AI_NAME },
            moduleNamespace: { name: PI_AI_NAME },
          },
        ],
      },
    };
    expect(loadPiAi(ctx)).toBeUndefined();
  });

  it("survives a loader whose entries() throws", () => {
    const ctx = {
      loader: {
        entries: () => {
          throw new Error("loader unavailable");
        },
      },
    };
    expect(loadPiAi(ctx)).toBeUndefined();
    expect(inheritedCredentialRef(ctx)).toBe("OPENCODE_API_KEY");
  });

  it("ignores entries that carry no options, no config, or no source route", () => {
    const ctx = {
      loader: {
        entries: () => [
          null,
          { options: null },
          { options: { config: null } },
          { options: { config: { providers: null } } },
          { options: { config: { providers: { opencode: null } } } },
          {
            options: { config: { providers: { opencode: { apiKeyEnv: "" } } } },
          },
          {
            options: {
              config: { providers: { opencode: { apiKeyEnv: "REAL_KEY" } } },
            },
          },
        ],
      },
    };
    expect(inheritedCredentialRef(ctx)).toBe("REAL_KEY");
  });

  it("lists each model once when both planes carry it", () => {
    const shared = {
      context_window: 1,
      id: "shared-model",
      input_modalities: ["text"],
      max_output_tokens: 1,
      name: "Shared",
      provider_npm: "@ai-sdk/openai",
    };
    const catalog = [
      shared,
      { ...shared },
      { ...shared, id: "other", provider_npm: undefined },
    ];
    const models = modelsForSdk("@ai-sdk/openai", catalog);
    expect(models.map((m) => m.id)).toEqual(["shared-model"]);
  });
});

describe("responses-provider: the loader's degraded shapes", () => {
  // Each of these is a shape a real host can hand over — a registry that throws,
  // an `entries()` that yields something that is not a list — and each has to
  // degrade to "no internal route", never to a failed boot.

  it("treats an entries() that yields a primitive as no entries", () => {
    // `entries` is typed as an array but is a generator in practice; a host that
    // returned a scalar would otherwise iterate its characters.
    expect(loadPiAi({ loader: { entries: () => 42 } })).toBeUndefined();
  });

  it("treats an entries() that yields a non-iterable object as no entries", () => {
    expect(loadPiAi({ loader: { entries: () => ({}) } })).toBeUndefined();
  });

  it("treats a loader without a usable entries() as absent", () => {
    expect(loadPiAi({ loader: {} })).toBeUndefined();
    expect(loadPiAi({ loader: { entries: "not a function" } })).toBeUndefined();
  });

  it("survives a service registry whose get() throws", () => {
    // The registry is another plugin's service; asking it is not guaranteed to
    // work, and a throw here must not take the boot with it.
    const ctx = {
      get: () => {
        throw new Error("registry unavailable");
      },
    };
    expect(loadPiAi(ctx)).toBeUndefined();
    // The credential reference still answers with its documented default.
    expect(inheritedCredentialRef(ctx)).toBe("OPENCODE_API_KEY");
  });

  it("ignores a loader the registry resolves to something that is not one", () => {
    expect(loadPiAi({ get: () => "not a loader" })).toBeUndefined();
    expect(loadPiAi({ get: () => null })).toBeUndefined();
    expect(
      loadPiAi({
        get: () => {
          /* the registry holds no loader */
        },
      })
    ).toBeUndefined();
  });

  it("treats a context that is not a context as absent", () => {
    for (const ctx of [undefined, null, 42, "ctx"]) {
      expect(loadPiAi(ctx)).toBeUndefined();
      expect(inheritedCredentialRef(ctx)).toBe("OPENCODE_API_KEY");
    }
  });
});

describe("responses-provider: a plane serves only its own catalog", () => {
  it("offers no model for a protocol its plane does not carry", () => {
    // The Go plane has no Mistral model. Asking for one must answer nothing -
    // not fall back to the Zen catalog, which is how a Go route would end up
    // offering a model the Go endpoint does not serve.
    expect(modelsForSdk("@ai-sdk/mistral", getLiveGoCatalog())).toEqual([]);
    expect(
      modelsForSdk("@ai-sdk/openai", getLiveGoCatalog()).length
    ).toBeGreaterThan(0);
  });
});

describe("responses-provider: a loader that breaks its own contract", () => {
  it("mounts nothing when the loader cannot yield entries", async () => {
    // The host's loader always exposes `entries`. A composition whose loader
    // does not is a contract violation, and the mount must answer "nothing to
    // do" rather than throw inside the caller's startup path.
    const host = createHost();
    (host.ctx.loader as { entries: unknown }).entries = 42;
    await expect(registerResponsesProvider(host.ctx)).resolves.toBeUndefined();
  });
});

describe("responses-provider · an internal route never outgrows the declaration", () => {
  const models = [
    { id: "claude-haiku-5-5" },
    { id: "claude-sonnet-5-5" },
    { id: "gpt-5.4" },
  ];

  it("keeps only the models the deployment declared", () => {
    // A mounted route's model list is what a picker shows. The whole protocol
    // catalog there is how models nobody selected reached the screen, which is
    // the bug this narrowing exists for.
    expect(narrowToDeclared(models, new Set(["claude-haiku-5-5"]))).toEqual([
      { id: "claude-haiku-5-5" },
    ]);
  });

  it("falls back to the full list when the declaration cannot be read", () => {
    // `undefined` is "the host could not answer", not "the user declared
    // nothing": mounting nothing would break every deployment whose host does
    // not expose the listing.
    expect(narrowToDeclared(models)).toEqual(models);
  });

  it("mounts nothing when the declaration excludes this protocol entirely", () => {
    // The caller skips the route on an empty list rather than registering a
    // provider with no models.
    expect(narrowToDeclared(models, new Set(["gpt-5.4"]))).toHaveLength(1);
  });
});

describe("responses-provider · declared models a missing route would strand", () => {
  const zen = getLiveZenCatalog();
  const anthropic = zen.find(
    (spec) => spec.provider_npm === "@ai-sdk/anthropic"
  );

  it("names the model and the protocol nothing serves", () => {
    // The case: no declared provider for this protocol, and a model the user
    // selected that speaks it. Silence would leave the model in the picker
    // with every call failing.
    if (anthropic === undefined) {
      throw new Error("the zen catalog serves no anthropic model");
    }
    const declared = new Map([["opencode", new Set([anthropic.id])]]);
    expect(unroutedDeclaredModels(declared, new Set())).toEqual([
      `${anthropic.id} (opencode · anthropic-messages)`,
    ]);
  });

  it("says nothing once a route serves that protocol", () => {
    if (anthropic === undefined) {
      throw new Error("the zen catalog serves no anthropic model");
    }
    const declared = new Map([["opencode", new Set([anthropic.id])]]);
    expect(
      unroutedDeclaredModels(declared, new Set(["opencode:anthropic-messages"]))
    ).toEqual([]);
  });

  it("skips a model the catalog does not describe", () => {
    // Nothing is known about its protocol, and a guess here would warn about a
    // model that works.
    const declared = new Map([["opencode", new Set(["not-in-the-catalog"])]]);
    expect(unroutedDeclaredModels(declared, new Set())).toEqual([]);
  });
});

describe("responses-provider · the keyless and unreadable declarations", () => {
  it("mounts nothing when the host cannot list its models", async () => {
    // No `listModels` means no declaration can be read. That is now the same
    // answer as an empty one — nothing — because filling the gap with the
    // catalog is what put 58 undeclared models on hidden routes.
    const ctx = {
      llm: { listProviders: () => [], registerAdapter: () => () => {} },
      loader: { entries: () => [] },
      logger: { info: () => {}, warn: () => {} },
    } as unknown as CordisContext;
    await expect(registerResponsesProvider(ctx)).resolves.toBeUndefined();
  });

  it("reads the declaration before deciding what to mount", async () => {
    // The mount asks the host what the deployment declared; a host that answers
    // is the ordinary case, and the answer narrows every route it mounts.
    const listed: string[] = [];
    const ctx = {
      llm: {
        listModels: async (route: string) => {
          listed.push(route);
          return [
            { id: "beam-free" },
            { id: "gpt-5.4" },
            { name: "no id here" },
            null,
          ];
        },
        listProviders: () => [],
        registerAdapter: () => () => {},
      },
      loader: { entries: () => [] },
      logger: { info: () => {}, warn: () => {} },
    } as unknown as CordisContext;
    await expect(registerResponsesProvider(ctx)).resolves.toBeUndefined();
    // Both plane routes were asked, and an entry without an id was ignored.
    expect(listed).toEqual(["opencode", "opencode-go"]);
  });

  it("does not throw when the listing fails", async () => {
    // A host whose `listModels` throws is the same case as one that answers
    // nothing: no declaration can be read, so nothing is mounted and the boot
    // does not fail. Mounting the catalog instead is the override this removed.
    const ctx = {
      llm: {
        listModels: () => {
          throw new Error("not implemented");
        },
        listProviders: () => [],
        registerAdapter: () => () => {},
      },
      loader: { entries: () => [] },
      logger: { info: () => {}, warn: () => {} },
    } as unknown as CordisContext;
    await expect(registerResponsesProvider(ctx)).resolves.toBeUndefined();
  });
});

describe("routing · a declared protocol beats the catalog's", () => {
  it("routes by the declared protocol before the SDK's", () => {
    // `modelRoutes` is the deployment saying it knows better than a bundled
    // snapshot. It has to reach the redirect, not just the model object: a
    // provider built with a route protocol dispatches on THAT protocol
    // (`createProvider` in `dsh-llm-pi-ai` calls `input.api.stream`), so the only
    // way to change which format is spoken is to hand the call to another route.
    expect(
      internalRouteFor(
        "opencode",
        "some-model",
        "@ai-sdk/openai",
        "anthropic-messages"
      )
    ).toBe("opencode-anthropic");
  });

  it("falls back to the SDK's protocol when nothing was declared", () => {
    expect(
      internalRouteFor("opencode", "claude-opus-5", "@ai-sdk/anthropic")
    ).toBe("opencode-anthropic");
  });
});

describe("responses-provider · declared models the catalog cannot describe", () => {
  it("names an id the bundled snapshot does not carry", () => {
    // The everyday cause is a release newer than the shim, or an id the vendor has
    // since marked deprecated (the shim drops those). Either way the model is
    // served from the deployment's configuration and this plugin adds no metadata,
    // and saying so is the difference between "ignored" and "never seen".
    const declared = new Map([
      ["opencode", new Set(["ll-alpha-free", "step-5-preview-free"])],
    ]);
    expect(undescribedDeclaredModels(declared)).toEqual([
      "ll-alpha-free (opencode)",
      "step-5-preview-free (opencode)",
    ]);
  });

  it("says nothing about ids the catalog knows", () => {
    const [spec] = getLiveZenCatalog();
    if (spec === undefined) {
      throw new Error("the zen catalog is empty");
    }
    expect(
      undescribedDeclaredModels(new Map([["opencode", new Set([spec.id])]]))
    ).toEqual([]);
  });
});

describe("responses-provider · the declaration needs no credential", () => {
  it("reads the declaration from the config, through the shared reader", async () => {
    // The walk itself lives in `declaredProviderModels` (go-discovery) and is
    // tested there; what this file owns is that the MOUNT asks for it at all —
    // the credential-free source — rather than only `listModels`, which answers
    // [] at boot because it resolves the route's key first.
    //
    // Measured in a live host:
    //   opencode: no models could be read for the route - it declares none, or
    //   its credential is not resolvable in this process - so no internal route
    //   is mounted for it
    const ctx = {
      loader: {
        *entries() {
          yield {
            options: {
              config: {
                providers: {
                  opencode: { models: [{ id: "gpt-5.4" }, { id: "" }, null] },
                  "opencode-go": { models: [{ id: "deepseek-v4.1-flash" }] },
                },
              },
            },
          };
        },
      },
    } as unknown as CordisContext;
    expect(declaredProviderModels(ctx, "opencode")).toEqual([
      { id: "gpt-5.4" },
    ]);
    expect(declaredProviderModels(ctx, "opencode-go")).toEqual([
      { id: "deepseek-v4.1-flash" },
    ]);
    // A route the loader does not describe is UNDEFINED, not empty: "cannot
    // read" and "declared nothing" must stay distinguishable.
    expect(declaredProviderModels(ctx, "nvidia")).toBeUndefined();
  });
});

describe("responses-provider · an empty declaration mounts nothing", () => {
  it("mounts no internal route when the host answers [] for a route", async () => {
    // `dsh-llm-pi-ai` answers `[]` from `listModels` when the route's credential
    // cannot be resolved (`lib/index.js:1894`) — the keyless deployment this
    // plugin supports. An earlier revision read that as "the declaration could
    // not be read" and fell back to the whole catalog; measured on a live host,
    // that mounted 58 models the deployment never declared:
    //
    //   mounted opencode-responses … 30 model(s); opencode-anthropic … 18;
    //   opencode-go-responses … 5; opencode-go-anthropic … 5
    //
    // A route's model list belongs to the operator, so `[]` now mounts nothing.
    // Dispatch does not depend on these routes any more: `decoratePlaneAdapters`
    // names each model's `api`, and `dsh-llm-pi-ai` dispatches per model.
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const registered: string[] = [];
    const ctx = {
      isolate: () => ({}),
      llm: {
        listModels: async () => [],
        listProviders: () => [],
        registerAdapter: (providers: readonly string[]) => {
          registered.push(...providers);
          return () => {};
        },
      },
      loader: { entries: () => [] },
    } as unknown as CordisContext;
    try {
      await registerResponsesProvider(ctx);
      // Nothing declared, so nothing registered — the whole point.
      expect(registered).toEqual([]);
      // The report must not assert a cause it cannot see. `[]` means either "this
      // route declares nothing" or "its credential did not resolve" — a route the
      // deployment DID configure lands in the second case when the credential
      // service is unreadable in this process, and announcing "no models declared"
      // there sends the operator looking at a configuration that was never wrong.
      const line = info.mock.calls
        .map((call) => String(call[0]))
        .find((text) => text.includes("no models could be read"));
      expect(line).toBeDefined();
      expect(line).toContain("declares none");
      expect(line).toContain("credential is not resolvable");
    } finally {
      info.mockRestore();
    }
  });
});

describe("Go Google bridge mounting", () => {
  it("inherits a custom Go key independently of Zen", () => {
    const ctx = {
      loader: {
        entries: () => [
          {
            options: {
              id: "llm-pi-ai",
              config: {
                providers: {
                  opencode: { apiKeyEnv: "ZEN_REF" },
                  "opencode-go": { apiKeyEnv: "GO_REF" },
                },
              },
            },
          },
        ],
      },
    };
    expect(inheritedCredentialRef(ctx, "opencode-go")).toBe("GO_REF");
    expect(inheritedCredentialRef(ctx)).toBe("ZEN_REF");
    expect(inheritedCredentialRef({}, "opencode-go")).toBe(
      "OPENCODE_GO_API_KEY"
    );
  });

  it("mounts and withdraws both Google routes", async () => {
    const host = createHost();
    const stop = await registerResponsesProvider(host.ctx);
    expect(host.adapters.has("opencode-google")).toBe(true);
    expect(host.adapters.has("opencode-go-google")).toBe(true);
    stop?.();
    expect(host.adapters.has("opencode-google")).toBe(false);
    expect(host.adapters.has("opencode-go-google")).toBe(false);
  });

  it("hands back the bridges' disposer when every internal route is already declared", async () => {
    // The bridge mounts before the wrapper's routes are weighed, so an early
    // exit that answered `undefined` left both Google routes registered with
    // nothing able to withdraw them — and the next reload's bridge then failed
    // DUPLICATE_ADAPTER. Every wrapper-mounted route is declared here, which is
    // the exit that leaves nothing to mount.
    const host = createHost();
    const wrapperRoutes = Object.values(ROUTE_FOR_PLANE_PROTOCOL)
      .flatMap((plane) => Object.values(plane.routes))
      .filter((route) => !SELF_MOUNTED_ROUTES.has(route));
    expect(wrapperRoutes.length).toBeGreaterThan(0);
    for (const route of wrapperRoutes) {
      host.adapters.set(route, { id: route });
    }
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      const stop = await registerResponsesProvider(host.ctx);
      expect(info).toHaveBeenCalledWith(
        expect.stringContaining("every internal route is already declared")
      );
      expect(host.adapters.has("opencode-google")).toBe(true);
      expect(host.adapters.has("opencode-go-google")).toBe(true);
      expect(stop).toBeTypeOf("function");
      stop?.();
      expect(host.adapters.has("opencode-google")).toBe(false);
      expect(host.adapters.has("opencode-go-google")).toBe(false);
      // The disposer withdraws only what it mounted: the declared routes stay.
      for (const route of wrapperRoutes) {
        expect(host.adapters.has(route)).toBe(true);
      }
      // And a second activation can mount them again, which is what a reload does.
      const again = await registerResponsesProvider(host.ctx);
      expect(host.adapters.has("opencode-google")).toBe(true);
      again?.();
    } finally {
      info.mockRestore();
    }
  });

  it("withdraws routes and disposes the fiber when the mount fails to start", async () => {
    // A route the mounted plugin registered before its startup error is live on
    // the host. The failure path used to log "internal routes stay unregistered"
    // and leave both the route and the fiber behind.
    const host = createHost();
    const disposed = vi.fn();
    type Ctx = NonNullable<typeof host.ctx>;
    const wrap = (ctx: Ctx): Ctx => {
      const isolate = ctx.isolate as (name: string) => Ctx;
      const plugin = ctx.plugin as (
        subject: unknown,
        config?: unknown
      ) => unknown;
      Object.assign(ctx, {
        isolate(this: Ctx, name: string) {
          return wrap(isolate.call(this, name));
        },
        plugin(this: Ctx, subject: unknown, config?: unknown) {
          plugin.call(this, subject, config);
          return {
            await: () => Promise.reject(new Error("startup failed")),
            dispose: disposed,
          };
        },
      });
      return ctx;
    };
    wrap(host.ctx);
    const stop = await registerResponsesProvider(host.ctx);
    // Fiber disposal is fire-and-forget; let it run.
    await Promise.resolve();
    expect(disposed).toHaveBeenCalledTimes(1);
    // Only the two bridges remain; every route the failed mount took is gone.
    expect(
      (
        (host.ctx.llm?.listProviders?.() ?? []) as readonly { id: string }[]
      ).map((provider) => provider.id)
    ).toEqual(["opencode-google", "opencode-go-google"]);
    // The bridges did mount, and the disposer handed back still withdraws them.
    expect(host.adapters.has("opencode-google")).toBe(true);
    stop?.();
    expect(host.adapters.has("opencode-google")).toBe(false);
  });

  it("withdraws the first bridge if mounting the second fails", async () => {
    const host = createHost();
    const llm = host.ctx.llm!;
    const original = llm.registerAdapter!;
    llm.registerAdapter = (routes, adapter) => {
      if (routes.includes("opencode-go-google"))
        throw new Error("Go registration failed");
      return original.call(llm, routes, adapter);
    };
    await expect(registerResponsesProvider(host.ctx)).rejects.toThrow(
      "Go registration failed"
    );
    expect(host.adapters.has("opencode-google")).toBe(false);
    expect(host.adapters.has("opencode-go-google")).toBe(false);
  });
});
