/**
 * A reload, at every site where the plugin wraps a method on a host object.
 *
 * The host runs `apply` once per activation. cordis disposes an activation
 * before it re-applies one (a config update is `Fiber.update` → `restart` →
 * `_unload`, which awaits every disposer, → `_reload`), so a reload alone never
 * overlaps two activations. Two are live at once when two rows load the plugin,
 * or when a dispose restores nothing, which is how the base stacked: its
 * disposers silently failed the identity check below, and the next activation
 * wrapped the leftover wrapper. So the sequence a patch has to survive is:
 * apply A → apply B → dispose A → B intact → dispose B → the originals restored
 * EXACTLY, and the same with the disposals reversed.
 * Two harder shapes follow: a reload whose config (for the Settings graft, its
 * committed entries) CHANGED, where the live answer must be B's alone, which a
 * site that stacked B on A would get wrong; and a foreign wrapper set on top
 * while the newest install is disposed first.
 *
 * Two sites are left after P-R1: model discovery, and the `settings.describe`
 * graft. The listing, model-info and plane-adapter wrappers went with the
 * hidden routes — the planes are the plugin's own registration, not a patch.
 * "Exactly" is two facts: an own method comes back as the same function with
 * the same attributes, and an inherited one leaves no own property behind, so
 * the prototype answers again.
 *
 * Identity is read from OWN DESCRIPTORS, never by comparing a property read with
 * `===`. On the real host `ctx.llm` is cordis's traceable proxy, which answers a
 * fresh proxy for every read of a method, so a read is never the function that
 * was installed; `Reflect.getOwnPropertyDescriptor` is not trapped and sees the
 * instance itself. The tier-A block is that host.
 *
 * @module test/reload.test
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  adaptersOf,
  mountTierA,
  PLANES,
  piAiRestarts,
  s0Providers,
  type TierA,
  waitForPlaneOwner,
} from "./support/host.ts";
import {
  apply,
  complementDiscoveredModels,
  Config,
  type CordisContext,
  decorateModelDiscovery,
  inject,
  inspectPatch,
  installDescribeGraft,
  name,
  type ResolvedPluginConfig,
  resolveConfig,
} from "./support/src.ts";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** Where a fixture's methods live: on the object, or on its prototype. */
type Shape = "inherited" | "own";

type Method = (...args: never[]) => unknown;

/**
 * The methods as own data properties of an object literal, or as methods on the
 * prototype of a fresh object, which is where a class keeps them.
 */
const shaped = (
  shape: Shape,
  methods: Record<string, Method>
): Record<string, unknown> =>
  shape === "own" ? { ...methods } : Object.create({ ...methods });

/** Call a method by name, with its host as the receiver. */
const call = async (
  target: object,
  key: string,
  ...args: unknown[]
): Promise<unknown> => {
  const method: unknown = Reflect.get(target, key);
  if (typeof method !== "function") {
    throw new TypeError(`no ${key} on the fixture`);
  }
  return await Reflect.apply(method, target, args);
};

/** The own descriptor of each key, which is what identity is read from. */
const ownDescriptors = (
  target: object,
  keys: readonly string[]
): Map<string, PropertyDescriptor | undefined> =>
  new Map(
    keys.map((key) => [key, Reflect.getOwnPropertyDescriptor(target, key)])
  );

/** The own value of each key, or `undefined` where there is no own property. */
const ownValues = (
  target: object,
  keys: readonly string[]
): Map<string, unknown> =>
  new Map(
    keys.map((key) => [
      key,
      Reflect.getOwnPropertyDescriptor(target, key)?.value,
    ])
  );

const asContext = (llm: object): CordisContext =>
  ({ llm }) as unknown as CordisContext;

/** One patch site, as the reload sequence drives it. */
interface Site {
  readonly name: string;
  /** The keys the site wraps on its target. */
  readonly keys: readonly string[];
  /** A fresh host `llm` service of the given shape. */
  readonly host: (shape: Shape) => Record<string, unknown>;
  /** The object whose methods the site wraps. */
  readonly targetOf: (llm: Record<string, unknown>) => object;
  readonly install: (
    llm: object,
    config?: ResolvedPluginConfig
  ) => (() => void) | undefined;
  /** A call whose decorated and raw answers differ. */
  readonly probe: (llm: Record<string, unknown>) => Promise<unknown>;
  readonly raw: unknown;
  readonly decorated: unknown;
  /**
   * An activation A whose decoration differs from the default's, and a call
   * that tells them apart: a stacked install would leak the first activation's
   * answer through the second's wherever the decoration reads per-activation
   * state, which every site does. Most sites read it from config; the listing's
   * `listModels` reads its `hasCredential` option (the keyless filter), so its
   * A is an install with that option rather than a config. The listing's
   * `listProviders` capture is pinned separately, by the `isRouteRegistered`
   * reinstall case in `models-discovery.test.ts` (a stacked listing would
   * capture the previous install's filtered `listProviders`). The main
   * sequence also checks, for every key of every site, that the second
   * install REPLACED the first (two live entries of one site id).
   */
  readonly reconfigured?: {
    /** A's config, installed through the site's own `install`. */
    readonly config?: ResolvedPluginConfig;
    /** A's install, where what differs is not config. */
    readonly installA?: (llm: object) => (() => void) | undefined;
    readonly probe: (llm: Record<string, unknown>) => Promise<unknown>;
  };
}

/** A provider listing, for the `apply()` case's stand-in host. */
const LISTED = [{ id: "opencode", name: "opencode" }];

/** Poll until `predicate` holds, or fail by name. */
const until = async (
  predicate: () => boolean,
  what: string,
  deadlineMs = 10_000
): Promise<void> => {
  const end = Date.now() + deadlineMs;
  while (!predicate()) {
    if (Date.now() > end) {
      throw new Error(`never happened: ${what}`);
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
  }
};

/** pi-ai's descriptor as `settings.describe()` builds it without the planes. */
const describeMethods = (): Record<string, Method> => ({
  describe: () => [
    { ns: "llm-pi-ai", revision: 3, value: { providers: { deepseek: {} } } },
    { ns: "other", value: {} },
  ],
});

/** The committed plane entries the default activation grafts, and A's. */
const ENTRIES_B = { opencode: { apiKeyEnv: "OPENCODE_API_KEY" } };
const ENTRIES_A = { opencode: { apiKeyEnv: "ACTIVATION_A_KEY" } };

/**
 * The graft installed the way `apply` installs it: through a `settings`
 * scope whose effects are collected and disposed together.
 */
const installGraft =
  (entries: Record<string, unknown>) =>
  (settings: object): (() => void) => {
    const cleanups: (() => void)[] = [];
    installDescribeGraft(
      {
        inject: (_deps: string[], callback: (scope: unknown) => void) => {
          callback({
            effect: (factory: () => () => void) => {
              cleanups.push(factory());
            },
            settings,
          });
        },
      } as unknown as CordisContext,
      {
        committedEntries: () => entries,
        piAiNamespace: () => "llm-pi-ai",
      }
    );
    return () => {
      for (const cleanup of cleanups.splice(0).toReversed()) {
        cleanup();
      }
    };
  };

/** A live claim on pi-ai's default row, as the discovery wrapper reads it. */
const SERVED = {
  claiming: () => true,
  piAiNamespace: () => "llm-pi-ai",
};

const SITES: readonly Site[] = [
  {
    decorated: complementDiscoveredModels([{ id: "minimax-m3" }], "go"),
    host: (shape) =>
      shaped(shape, { discoverModels: async () => [{ id: "minimax-m3" }] }),
    install: (llm, config = resolveConfig()) =>
      decorateModelDiscovery(asContext(llm), config, SERVED),
    keys: ["discoverModels"],
    name: "discovery",
    probe: (llm) =>
      call(llm, "discoverModels", "llm-pi-ai", {
        provider: "opencode-go",
      }),
    raw: [{ id: "minimax-m3" }],
    // Which requests are merged is read from `gatewayUrls`: under A a
    // relay.example base is the Zen gateway and is merged, under the default it
    // is nobody's and passes through, so a stacked default install would keep
    // A's merge.
    reconfigured: {
      config: resolveConfig({ gatewayUrls: ["relay.example"] }),
      probe: (llm) =>
        call(llm, "discoverModels", "llm-pi-ai", {
          baseURL: "https://relay.example/v1",
        }),
    },
    targetOf: (llm) => llm,
  },
  {
    decorated: [
      {
        ns: "llm-pi-ai",
        revision: 3,
        value: { providers: { deepseek: {}, ...ENTRIES_B } },
      },
      { ns: "other", value: {} },
    ],
    host: (shape) => shaped(shape, describeMethods()),
    install: installGraft(ENTRIES_B),
    keys: ["describe"],
    name: "settings-describe",
    probe: (settings) => call(settings, "describe"),
    raw: describeMethods().describe?.(),
    // The entries are per activation: A grafts its own, so a stacked default
    // install would keep showing A's.
    reconfigured: {
      installA: installGraft(ENTRIES_A),
      probe: (settings) => call(settings, "describe"),
    },
    targetOf: (settings) => settings,
  },
];

const CASES = SITES.flatMap((site) =>
  (["own", "inherited"] as const).map((shape) => ({
    shape,
    site,
    title: `${site.name} · original is ${shape}`,
  }))
);

describe("reload · every patch site", () => {
  it.each(CASES.map((entry) => [entry.title, entry] as const))(
    "%s · apply A → apply B → dispose A → B intact → dispose B → originals restored exactly",
    async (_title, { shape, site }) => {
      // The sequence reads "decorated" and "raw" off one call, so the two must
      // differ, or a patch that never ran would pass it.
      expect(site.decorated).toBeDefined();
      expect(site.decorated).not.toEqual(site.raw);
      const llm = site.host(shape);
      const target = site.targetOf(llm);
      const before = ownDescriptors(target, site.keys);
      await expect(site.probe(llm)).resolves.toEqual(site.raw);

      const a = site.install(llm);
      const b = site.install(llm);
      expect(a).toBeTypeOf("function");
      expect(b).toBeTypeOf("function");
      const installedB = ownValues(target, site.keys);
      for (const key of site.keys) {
        expect(installedB.get(key), key).toBeTypeOf("function");
        expect(installedB.get(key), key).not.toBe(before.get(key)?.value);
        // B REPLACED A rather than wrapping it: both are live entries of one
        // site id. A per-install id would leave B with no same-site
        // predecessor, and B would wrap A's wrapper (one entry).
        const chain = inspectPatch(installedB.get(key), key);
        expect(chain, `same-site replacement: ${key}`).toHaveLength(2);
        expect(chain?.[0], key).toEqual({
          holdsWrapper: true,
          id: chain?.[1]?.id,
          live: true,
        });
        expect(chain?.[1], key).toEqual({
          holdsWrapper: true,
          id: chain?.[0]?.id,
          live: true,
        });
      }
      await expect(site.probe(llm)).resolves.toEqual(site.decorated);

      a?.();
      for (const key of site.keys) {
        expect(
          Reflect.getOwnPropertyDescriptor(target, key)?.value,
          `B intact: ${key}`
        ).toBe(installedB.get(key));
      }
      await expect(site.probe(llm)).resolves.toEqual(site.decorated);

      b?.();
      for (const key of site.keys) {
        const after = Reflect.getOwnPropertyDescriptor(target, key);
        expect(after, `restored: ${key}`).toEqual(before.get(key));
        expect(after?.value, `restored: ${key}`).toBe(before.get(key)?.value);
      }
      await expect(site.probe(llm)).resolves.toEqual(site.raw);
    }
  );

  it.each(CASES.map((entry) => [entry.title, entry] as const))(
    "%s · apply A → apply B → dispose B → A intact → dispose A → originals restored exactly",
    async (_title, { shape, site }) => {
      expect(site.decorated).not.toEqual(site.raw);
      const llm = site.host(shape);
      const target = site.targetOf(llm);
      const before = ownDescriptors(target, site.keys);

      const a = site.install(llm);
      const installedA = ownValues(target, site.keys);
      const b = site.install(llm);
      expect(a).toBeTypeOf("function");
      expect(b).toBeTypeOf("function");

      b?.();
      for (const key of site.keys) {
        expect(
          Reflect.getOwnPropertyDescriptor(target, key)?.value,
          `A intact: ${key}`
        ).toBe(installedA.get(key));
      }
      await expect(site.probe(llm)).resolves.toEqual(site.decorated);

      a?.();
      for (const key of site.keys) {
        const after = Reflect.getOwnPropertyDescriptor(target, key);
        expect(after, `restored: ${key}`).toEqual(before.get(key));
        expect(after?.value, `restored: ${key}`).toBe(before.get(key)?.value);
      }
      await expect(site.probe(llm)).resolves.toEqual(site.raw);
    }
  );
});

describe("reload · a changed config", () => {
  const RECONFIGURED = CASES.filter(({ site }) => site.reconfigured);

  it.each(RECONFIGURED.map((entry) => [entry.title, entry] as const))(
    "%s · A under another config or option, B under the default: the live answer is B's alone",
    async (_title, { shape, site }) => {
      const { reconfigured } = site;
      if (reconfigured === undefined) {
        throw new TypeError("filtered above");
      }
      // A's install: its own, where what differs is not config.
      const installA =
        reconfigured.installA ??
        ((llm: object) => site.install(llm, reconfigured.config));
      // What each activation answers on its own, each on a fresh host.
      const answerUnder = async (
        install: (llm: object) => (() => void) | undefined
      ): Promise<unknown> => {
        const llm = site.host(shape);
        const stop = install(llm);
        const answer = await reconfigured.probe(llm);
        stop?.();
        return answer;
      };
      const answerA = await answerUnder(installA);
      const answerB = await answerUnder((llm) => site.install(llm));
      expect(answerA).not.toEqual(answerB);

      const llm = site.host(shape);
      const a = installA(llm);
      await expect(reconfigured.probe(llm)).resolves.toEqual(answerA);
      const b = site.install(llm);
      await expect(reconfigured.probe(llm)).resolves.toEqual(answerB);
      a?.();
      await expect(reconfigured.probe(llm)).resolves.toEqual(answerB);
      b?.();
    }
  );
});

describe("reload · under a foreign wrapper, newest disposed first", () => {
  it.each(CASES.map((entry) => [entry.title, entry] as const))(
    "%s · B retires under it and hands the call to A, and the last dispose restores exactly",
    async (_title, { shape, site }) => {
      const llm = site.host(shape);
      const target = site.targetOf(llm);
      const before = ownDescriptors(target, site.keys);
      const a = site.install(llm);
      const b = site.install(llm);

      // Another plugin wraps every key on top of B, and remembers what it
      // found so its own teardown can put it back.
      const captured = ownValues(target, site.keys);
      for (const key of site.keys) {
        const inner = captured.get(key);
        if (typeof inner !== "function") {
          throw new TypeError(`nothing installed at ${key}`);
        }
        Reflect.set(
          target,
          key,
          function foreign(this: unknown, ...args: unknown[]): unknown {
            return Reflect.apply(inner, this, args);
          }
        );
      }

      b?.();
      // A is still live, so the answer stays decorated through B's retired
      // wrapper under the foreign one.
      await expect(site.probe(llm)).resolves.toEqual(site.decorated);

      for (const key of site.keys) {
        Reflect.set(target, key, captured.get(key));
      }
      await expect(site.probe(llm)).resolves.toEqual(site.decorated);

      a?.();
      for (const key of site.keys) {
        const after = Reflect.getOwnPropertyDescriptor(target, key);
        expect(after, `restored: ${key}`).toEqual(before.get(key));
        expect(after?.value, `restored: ${key}`).toBe(before.get(key)?.value);
      }
      await expect(site.probe(llm)).resolves.toEqual(site.raw);
    }
  );
});

describe("reload · on the real host (tier A)", { timeout: 15_000 }, () => {
  let tier: TierA | undefined;

  afterEach(async () => {
    await tier?.dispose();
    tier = undefined;
  });

  // Tier A has no settings service, so the graft's own host stand-ins above
  // are its cases; discovery runs on the real `llm` service here.
  it.each(
    SITES.flatMap((site) =>
      site.name === "discovery"
        ? [
            [site.name, "first disposed first", site, true] as const,
            [site.name, "last disposed first", site, false] as const,
          ]
        : []
    )
  )("%s · %s", async (_siteName, _order, site, fifo) => {
    tier = await mountTierA({ providers: s0Providers() });
    const { llm } = tier;
    const target: object = llm;
    const listed = llm.listProviders();
    const info = await llm.resolveModelInfo("opencode", "deepseek-v4-pro");
    for (const key of site.keys) {
      expect(Object.hasOwn(target, key), key).toBe(false);
    }

    const a = site.install(llm);
    const installedA = ownValues(target, site.keys);
    const b = site.install(llm);
    expect(a).toBeTypeOf("function");
    expect(b).toBeTypeOf("function");
    const installedB = ownValues(target, site.keys);
    for (const key of site.keys) {
      expect(Object.hasOwn(target, key), key).toBe(true);
    }

    (fifo ? a : b)?.();
    const survivor = fifo ? installedB : installedA;
    for (const key of site.keys) {
      expect(
        Reflect.getOwnPropertyDescriptor(target, key)?.value,
        `survivor intact: ${key}`
      ).toBe(survivor.get(key));
    }

    (fifo ? b : a)?.();
    for (const key of site.keys) {
      expect(Object.hasOwn(target, key), `restored: ${key}`).toBe(false);
    }
    expect(llm.listProviders()).toEqual(listed);
    await expect(
      llm.resolveModelInfo("opencode", "deepseek-v4-pro")
    ).resolves.toEqual(info);
  });
});

describe("reload · through apply()", { timeout: 15_000 }, () => {
  let tier: TierA | undefined;

  afterEach(async () => {
    await tier?.dispose();
    tier = undefined;
  });

  it("apply() twice, the first disposed first: every host method the plugin patched is restored exactly", async () => {
    // The global fetch is patched too, and stacks the same way; it is not a host
    // service method and is not asserted here (P6 owns it).
    vi.stubGlobal("fetch", vi.fn());
    vi.spyOn(console, "info").mockImplementation(() => {
      // Silenced: the activation line.
    });
    class HostLlm {
      async discoverModels(): Promise<unknown> {
        return [{ id: "minimax-m3" }];
      }
      listProviders(): unknown {
        return LISTED.map((entry) => ({ ...entry }));
      }
    }
    class HostSettings {
      describe(): unknown {
        return [{ ns: "llm-pi-ai", value: { providers: {} } }];
      }
    }
    const llm = new HostLlm();
    const settings = new HostSettings();
    // The plugin patches `llm.discoverModels` and `settings.describe` now; the
    // plane routes are its own registration, not a patch (P-R1).
    const llmKeys = ["discoverModels"];

    /** One activation: a stand-in whose `inject` hands over a scope with the service. */
    const activation = (): { ctx: CordisContext; dispose: () => void } => {
      const cleanups: (() => void)[] = [];
      const effect = (fn: () => unknown) => {
        const cleanup = fn();
        if (typeof cleanup === "function") {
          cleanups.push(() => {
            cleanup();
          });
        }
      };
      const ctx = {
        effect,
        fiber: { uid: 1 },
        inject: (deps: string[], callback: (scope: unknown) => void) => {
          callback(
            deps.includes("llm") ? { effect, llm } : { effect, settings }
          );
        },
        on: vi.fn(),
      } as unknown as CordisContext;
      return {
        ctx,
        dispose: () => {
          for (const cleanup of cleanups.toReversed()) {
            cleanup();
          }
        },
      };
    };

    const a = activation();
    const b = activation();
    void apply(a.ctx);
    void apply(b.ctx);
    const llmB = ownValues(llm, llmKeys);
    for (const key of llmKeys) {
      expect(llmB.get(key), key).toBeTypeOf("function");
    }
    const describeB = Reflect.getOwnPropertyDescriptor(
      settings,
      "describe"
    )?.value;
    expect(describeB).toBeTypeOf("function");

    a.dispose();
    for (const key of llmKeys) {
      expect(Reflect.getOwnPropertyDescriptor(llm, key)?.value, key).toBe(
        llmB.get(key)
      );
    }
    expect(Reflect.getOwnPropertyDescriptor(settings, "describe")?.value).toBe(
      describeB
    );

    b.dispose();
    for (const key of llmKeys) {
      expect(Object.hasOwn(llm, key), key).toBe(false);
    }
    expect(Object.hasOwn(settings, "describe")).toBe(false);
    expect(llm.listProviders()).toEqual(LISTED);
  });

  it("apply() twice on the real host (tier A): the planes end owned by the second activation, and pi-ai restarts exactly once", async () => {
    vi.stubGlobal("fetch", vi.fn());
    vi.spyOn(console, "info").mockImplementation(() => {
      // Silenced: the activation lines.
    });
    tier = await mountTierA({ plugin: {}, providers: s0Providers() });
    await waitForPlaneOwner(tier.llm);
    const first = tier.pluginFiber;
    const second = await tier.ctx.plugin(
      { apply, Config, inject, name } as never,
      {} as never
    );
    const restarts = piAiRestarts(tier.ctx);
    // The first activation's adapter, which serves the planes until it goes.
    const firstAdapters = new Map(
      PLANES.map((plane) => [plane, adaptersOf(tier!.llm).get(plane)?.adapter])
    );
    for (const plane of PLANES) {
      expect(firstAdapters.get(plane)?.constructor.name).toBe("PlaneAdapter");
    }
    await first?.dispose();
    await until(
      () =>
        PLANES.every((plane) => {
          const adapter = adaptersOf(tier!.llm).get(plane)?.adapter;
          return (
            adapter?.constructor.name === "PlaneAdapter" &&
            adapter !== firstAdapters.get(plane)
          );
        }),
      "the second activation's adapter serves both planes"
    );
    // The first's teardown restarts pi-ai once so it re-resolves; the second
    // activation's listener keeps it off the planes, so they go to the second.
    expect(restarts.count()).toBe(1);
    await second.dispose();
    await waitForPlaneOwner(tier.llm, PLANES, "PiAiAdapter");
    restarts.dispose();
  });
});
