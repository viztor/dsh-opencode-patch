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
 * Two harder shapes follow: a reload whose config (for the listing, its keyless
 * option) CHANGED, where the live answer must be B's alone, which a site that
 * stacked B on A would get wrong; and a foreign wrapper set on top while the
 * newest install is disposed first.
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
  s0Providers,
  type TierA,
} from "./support/host.ts";
import {
  apply,
  baseForProtocol,
  type CordisContext,
  decorateModelDiscovery,
  decorateModelInfo,
  decoratePlaneAdapters,
  findModelSpecOn,
  hideResponsesRoute,
  inspectPatch,
  mergeDiscoveredModels,
  protocolFor,
  type ResolvedPluginConfig,
  RESPONSES_ROUTE,
  resolveConfig,
} from "./support/src.ts";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** Where a fixture's methods live: on the object, or on its prototype. */
type Shape = "inherited" | "own";

type Method = (...args: never[]) => unknown;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

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

const contextWindowOf = (value: unknown): unknown =>
  isRecord(value) && isRecord(value.context)
    ? value.context.contextWindow
    : undefined;

const nameOf = (value: unknown): unknown =>
  isRecord(value) ? value.name : undefined;

const baseUrlOf = (value: unknown): unknown =>
  isRecord(value) ? value.baseUrl : undefined;

/** The base a plane's catalog dispatches `id` to, under the default endpoint. */
const planeBase = (
  route: "opencode" | "opencode-go",
  id: string
): string | undefined => {
  const spec = findModelSpecOn(route === "opencode" ? "zen" : "go", id);
  const protocol = spec === undefined ? undefined : protocolFor(spec);
  if (protocol === undefined) {
    throw new TypeError(`no protocol for ${id} on ${route}`);
  }
  return baseForProtocol(route, protocol, resolveConfig().endpoint);
};

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

const LISTED = [
  { id: "opencode", name: "opencode" },
  { id: RESPONSES_ROUTE, name: RESPONSES_ROUTE },
];

/** A priced Zen id and a free one, for the keyless filter. */
const PRICED_AND_FREE = ["gpt-5.4", "beam-free"] as const;

const listingMethods = (): Record<string, Method> => ({
  listConfigurableProviders: () => [
    { provider: "opencode" },
    { provider: RESPONSES_ROUTE },
  ],
  listModels: async () => PRICED_AND_FREE.map((id) => ({ id })),
  listProviders: () => LISTED.map((entry) => ({ ...entry })),
});

/** The one adapter both plane routes share, as pi-ai registers it. */
const adapterMethods = (): Record<string, Method> => ({
  modelOf: () => ({ id: "x", reasoning: false }),
  prepareCall: async () => ({}),
  resolveModel: async () => ({}),
});

const adapterOf = (llm: Record<string, unknown>): object => {
  const { adapters } = llm;
  const row: unknown =
    adapters instanceof Map ? adapters.get("opencode") : undefined;
  if (!isRecord(row) || !isRecord(row.adapter)) {
    throw new TypeError("no adapter behind the opencode route");
  }
  return row.adapter;
};

const SITES: readonly Site[] = [
  {
    decorated: [{ id: "opencode", name: "opencode" }],
    host: (shape) => shaped(shape, listingMethods()),
    install: (llm) => hideResponsesRoute(asContext(llm), resolveConfig()),
    keys: ["listProviders", "listConfigurableProviders", "listModels"],
    name: "listing",
    probe: (llm) => call(llm, "listProviders"),
    raw: LISTED,
    // The keyless filter is per activation: under A (no credential) a priced
    // id is dropped, under the default (nobody asked) the listing is kept, so
    // a stacked default install would keep A's narrowing.
    reconfigured: {
      installA: (llm) =>
        hideResponsesRoute(asContext(llm), resolveConfig(), {
          hasCredential: () => false,
        }),
      probe: (llm) => call(llm, "listModels", "opencode"),
    },
    targetOf: (llm) => llm,
  },
  {
    decorated: mergeDiscoveredModels([{ id: "minimax-m3" }], "go"),
    host: (shape) =>
      shaped(shape, { discoverModels: async () => [{ id: "minimax-m3" }] }),
    install: (llm, config = resolveConfig()) =>
      decorateModelDiscovery(asContext(llm), config),
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
    decorated: findModelSpecOn("go", "minimax-m3")?.context_window,
    host: (shape) => shaped(shape, { resolveModelInfo: async () => ({}) }),
    install: (llm, config = resolveConfig()) =>
      decorateModelInfo(asContext(llm), config),
    keys: ["resolveModelInfo"],
    name: "model-info",
    probe: async (llm) =>
      contextWindowOf(
        await call(llm, "resolveModelInfo", "opencode-go", "minimax-m3")
      ),
    raw: undefined,
    // A name override is applied only where one is declared, so a stacked
    // default install would keep the first activation's name.
    reconfigured: {
      config: resolveConfig({
        modelOverrides: { "minimax-m3": { name: "Activation A" } },
      }),
      probe: async (llm) =>
        nameOf(
          await call(llm, "resolveModelInfo", "opencode-go", "minimax-m3")
        ),
    },
    targetOf: (llm) => llm,
  },
  {
    decorated: planeBase("opencode", "deepseek-v4-pro"),
    host: (shape) => {
      const adapter = shaped(shape, adapterMethods());
      return {
        adapters: new Map([
          ["opencode", { adapter }],
          ["opencode-go", { adapter }],
        ]),
      };
    },
    install: (llm, config = resolveConfig()) =>
      decoratePlaneAdapters(llm as never, config),
    keys: ["resolveModel", "prepareCall", "modelOf"],
    name: "plane-adapters",
    probe: async (llm) =>
      baseUrlOf(
        await call(
          adapterOf(llm),
          "resolveModel",
          "opencode",
          "deepseek-v4-pro"
        )
      ),
    raw: undefined,
    // The fill keeps a window the adapter already answered, so a stacked
    // default install would keep the first activation's clamp; and `modelOf`
    // (its own patch) fills only the levels the adapter refuses, so a stacked
    // default install would build on A's declared levels instead of the
    // catalog's.
    reconfigured: {
      config: resolveConfig({
        maxContextWindow: 1000,
        modelOverrides: { "deepseek-v4-pro": { reasoningEfforts: ["low"] } },
      }),
      probe: async (llm) => {
        const adapter = adapterOf(llm);
        const resolved = await call(
          adapter,
          "resolveModel",
          "opencode",
          "deepseek-v4-pro"
        );
        const model = await call(
          adapter,
          "modelOf",
          {},
          "opencode",
          "deepseek-v4-pro"
        );
        return {
          contextWindow: contextWindowOf(resolved),
          thinkingLevelMap: isRecord(model)
            ? model.thinkingLevelMap
            : undefined,
        };
      },
    },
    targetOf: adapterOf,
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

  it.each(
    SITES.flatMap((site) => [
      [site.name, "first disposed first", site, true] as const,
      [site.name, "last disposed first", site, false] as const,
    ])
  )("%s · %s", async (name, _order, site, fifo) => {
    tier = await mountTierA({ providers: s0Providers() });
    const { llm } = tier;
    let target: object = llm;
    if (name === "plane-adapters") {
      const shared = adaptersOf(llm).get("opencode")?.adapter;
      expect(shared).toBeDefined();
      // pi-ai serves both planes from one instance, which is the nesting the
      // plane-adapter patch composes over.
      expect(adaptersOf(llm).get("opencode-go")?.adapter).toBe(shared);
      target = shared ?? {};
    }
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
    if (name === "plane-adapters") {
      expect(
        baseUrlOf(
          await call(target, "resolveModel", "opencode", "deepseek-v4-pro")
        )
      ).toBe(planeBase("opencode", "deepseek-v4-pro"));
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

describe("reload · through apply()", () => {
  it("apply() twice, the first disposed first: every host method the plugin patched is restored exactly", async () => {
    // The global fetch is patched too, and stacks the same way; it is not a host
    // service method and is not asserted here (P6 owns it).
    vi.stubGlobal("fetch", vi.fn());
    vi.spyOn(console, "info").mockImplementation(() => {
      // Silenced: the activation line and the hidden-route stand-down.
    });
    class Adapter {
      modelOf(): unknown {
        return { id: "x", reasoning: false };
      }
      async prepareCall(): Promise<unknown> {
        return {};
      }
      async resolveModel(): Promise<unknown> {
        return {};
      }
    }
    const adapter = new Adapter();
    class HostLlm {
      readonly adapters = new Map([
        ["opencode", { adapter }],
        ["opencode-go", { adapter }],
      ]);
      async discoverModels(): Promise<unknown> {
        return [{ id: "minimax-m3" }];
      }
      listConfigurableProviders(): unknown {
        return [{ provider: "opencode" }, { provider: RESPONSES_ROUTE }];
      }
      async listModels(): Promise<unknown> {
        return [{ id: "opencode-model" }];
      }
      listProviders(): unknown {
        return LISTED.map((entry) => ({ ...entry }));
      }
      async resolveModelInfo(): Promise<unknown> {
        return {};
      }
    }
    const llm = new HostLlm();
    const llmKeys = [
      "listProviders",
      "listConfigurableProviders",
      "listModels",
      "discoverModels",
      "resolveModelInfo",
    ];
    const adapterKeys = ["resolveModel", "prepareCall", "modelOf"];

    const cleanups: (() => void)[] = [];
    const ctxFor = (): CordisContext =>
      ({
        effect: (fn: () => unknown) => {
          const cleanup = fn();
          if (typeof cleanup === "function") {
            cleanups.push(() => {
              cleanup();
            });
          }
        },
        llm,
        on: vi.fn(),
      }) as unknown as CordisContext;

    apply(ctxFor());
    apply(ctxFor());
    expect(cleanups).toHaveLength(2);
    const llmB = ownValues(llm, llmKeys);
    const adapterB = ownValues(adapter, adapterKeys);
    for (const key of llmKeys) {
      expect(llmB.get(key), key).toBeTypeOf("function");
    }
    for (const key of adapterKeys) {
      expect(adapterB.get(key), key).toBeTypeOf("function");
    }

    cleanups[0]?.();
    for (const key of llmKeys) {
      expect(Reflect.getOwnPropertyDescriptor(llm, key)?.value, key).toBe(
        llmB.get(key)
      );
    }
    for (const key of adapterKeys) {
      expect(Reflect.getOwnPropertyDescriptor(adapter, key)?.value, key).toBe(
        adapterB.get(key)
      );
    }
    expect(llm.listProviders()).toEqual([{ id: "opencode", name: "opencode" }]);

    cleanups[1]?.();
    for (const key of llmKeys) {
      expect(Object.hasOwn(llm, key), key).toBe(false);
    }
    for (const key of adapterKeys) {
      expect(Object.hasOwn(adapter, key), key).toBe(false);
    }
    expect(llm.listProviders()).toEqual(LISTED);
  });
});
