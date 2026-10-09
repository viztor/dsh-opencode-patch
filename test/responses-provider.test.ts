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
  RESPONSES_SDK,
  ROUTE_FOR_PLANE_PROTOCOL,
  inheritedCredentialRef,
  loadPiAi,
  modelsForSdk,
  registerResponsesProvider,
} from "../src/index.ts";
import type { CordisContext } from "../src/index.ts";

const MUSE = "muse-spark-1.3-contributor-free";

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
    listConfigurableProviders: () => [...directory.values()],
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

  const piAi = { Config, apply, inject: undefined, name: PI_AI };

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

  return { ctx, mountHostInstance, mountIsolated, observables, piAi };
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
    const info = vi.fn();
    const ctx = {
      llm: { listProviders: () => [], registerAdapter: vi.fn() },
      loader: { entries: () => [] },
      logger: { info },
    } as unknown as CordisContext;
    await expect(registerResponsesProvider(ctx)).resolves.toBeUndefined();
    expect(ctx.llm?.registerAdapter).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledWith(
      expect.stringContaining("no loaded llm-pi-ai")
    );
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
          { id: "opencode-mistral" },
        ],
        registerAdapter: vi.fn(),
      },
      logger: {},
    } as unknown as CordisContext;
    await expect(registerResponsesProvider(ctx)).resolves.toBeUndefined();
    expect(plugin).not.toHaveBeenCalled();
  });

  it("stands down when the host offers no scope to mount into", async () => {
    const info = vi.fn();
    const ctx = {
      llm: { listProviders: () => [], registerAdapter: vi.fn() },
      logger: { info },
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
    expect(info).toHaveBeenCalledWith(
      expect.stringContaining("no isolate/plugin scope")
    );
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
    const expected = Object.entries(ROUTE_FOR_PLANE_PROTOCOL).flatMap(
      ([, rows]) => Object.values(rows)
    );

    expect(Object.keys(providers)).toEqual(expected);
    expect(Object.keys(providers)).toContain("opencode-responses");
    for (const profile of Object.values(providers)) {
      expect(profile.models.length).toBeGreaterThan(0);
    }
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
