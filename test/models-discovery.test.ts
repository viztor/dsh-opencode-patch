/**
 * Settings' model discovery, complemented by the catalog (P3, D3).
 *
 * Settings → Models → Fetch asks pi-ai's namespace, and pi-ai answers a plane
 * from pi's packaged catalog. On a plane the plugin serves, the wrapper keeps
 * pi's rows and order, then offers every servable, non-deprecated catalog model
 * pi does not list, each id once and in the Remote's five fields; while pi-ai
 * restarts (`NO_DISCOVERY`) it answers the catalog alone. Every other request
 * it classifies keeps the enrich-only merge: pi-ai serves those routes, and it
 * cannot serve an id it does not list. Nothing is written (D8).
 *
 * `test/host-discovery.test.ts` pins the same answers on the real host.
 *
 * @module test/models-discovery.test
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  complementDiscoveredModels,
  type CordisContext,
  decorateModelDiscovery,
  type DiscoveryClaim,
  findModelSpecOn,
  isDeprecatedModelOn,
  isServableSdk,
  mergeDiscoveredModels,
  OPENCODE_GO_CATALOG,
  OPENCODE_ZEN_CATALOG,
  parseModelsDevCatalog,
  refreshCatalog,
  resolveConfig,
  resolveDiscoveryProvider,
  sanitizeModalities,
} from "./support/src.ts";

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.OPENCODE_SESSION_ID;
});

const providers = new Set(["opencode", "opencode-go"]);
const gatewayUrls = ["opencode.ai/zen"];
const config = { ...resolveConfig(), gatewayUrls, providers };

/** A live claim on pi-ai's default row: the plugin serves both planes. */
const SERVED: DiscoveryClaim = {
  claiming: () => true,
  piAiNamespace: () => "llm-pi-ai",
};

/** The claim after a stand-down: pi-ai serves the planes again. */
const STOOD_DOWN: DiscoveryClaim = {
  claiming: () => false,
  piAiNamespace: () => "llm-pi-ai",
};

/** The five fields of the Remote's `LlmDiscoveredModel`, sorted. */
const REMOTE_FIELDS = [
  "contextWindow",
  "id",
  "inputModalities",
  "maxTokens",
  "name",
];

/** The servable catalog ids of a plane's bundled shim, in catalog order. */
const servableIds = (
  catalog: readonly { id: string; provider_npm?: string }[]
): string[] =>
  catalog.filter((spec) => isServableSdk(spec.provider_npm)).map((s) => s.id);

/** Every row carries only the Remote's fields, and no value is `undefined`. */
const expectWhitelisted = (rows: readonly object[]): void => {
  for (const row of rows) {
    for (const [key, value] of Object.entries(row)) {
      expect(REMOTE_FIELDS, key).toContain(key);
      expect(value, key).not.toBe(undefined);
    }
  }
};

/** Install the wrapper on a plain `llm` and hand back the installed method. */
const install = (
  original: (...args: never[]) => unknown,
  claim: DiscoveryClaim = SERVED
) => {
  const ctx = {
    llm: { discoverModels: original },
  } as unknown as CordisContext;
  const stop = decorateModelDiscovery(ctx, resolveConfig(), claim);
  const wrapped = ctx.llm?.discoverModels;
  if (typeof wrapped !== "function") {
    throw new TypeError("discovery decorator was not installed");
  }
  return { ctx, stop, wrapped };
};

describe("resolveDiscoveryProvider", () => {
  it("prefers an explicitly claimed route ID", () => {
    expect(resolveDiscoveryProvider({ provider: "opencode" }, config)).toBe(
      "zen"
    );
    expect(resolveDiscoveryProvider({ provider: "opencode-go" }, config)).toBe(
      "go"
    );
  });

  it("ignores unclaimed routes and non-OpenCode gateways", () => {
    expect(resolveDiscoveryProvider({ provider: "other" }, config)).toBe(
      undefined
    );
    expect(
      resolveDiscoveryProvider(
        { baseURL: "https://gateway.example.com/v1" },
        config
      )
    ).toBe(undefined);
    expect(resolveDiscoveryProvider(null, config)).toBe(undefined);
  });

  it("classifies an OpenCode gateway draft by its URL path", () => {
    expect(
      resolveDiscoveryProvider(
        { baseURL: "https://opencode.ai/zen/go/v1", provider: "custom-go" },
        { ...config, providers: new Set(["custom-go"]) }
      )
    ).toBe("go");
    expect(
      resolveDiscoveryProvider(
        { baseURL: "https://opencode.ai/zen/v1", provider: "custom-zen" },
        { ...config, providers: new Set(["custom-zen"]) }
      )
    ).toBe("zen");
  });
});

describe("mergeDiscoveredModels", () => {
  it("drops an adapter row the registry has retired", () => {
    // The adapter's installed snapshot is older than the live catalog and still
    // lists ids the vendor has retired — measured: 5 of pi's 85 opencode ids are
    // deprecated in the live catalog, and 6 live-active ids it lacks. Our own
    // catalog drops the retired ones during parse, so without this filter the
    // MERGE is what puts them back, and the picker leads with models that no
    // longer answer.
    parseModelsDevCatalog({
      opencode: {
        api: "https://opencode.ai/zen/v1",
        models: {
          "still-here": { name: "Still Here" },
          "retired-one": { name: "Retired One", status: "deprecated" },
        },
      },
    });

    // The parser saw the retirement…
    expect(isDeprecatedModelOn("zen", "retired-one")).toBe(true);
    expect(isDeprecatedModelOn("zen", "still-here")).toBe(false);

    // …and the merge honours it for a row the ADAPTER offers.
    const merged = mergeDiscoveredModels(
      [
        {
          contextWindow: 1,
          id: "retired-one",
          inputModalities: ["text"],
          maxTokens: 2,
          name: "Retired One",
        },
        {
          contextWindow: 1,
          id: "adapter-only",
          inputModalities: ["text"],
          maxTokens: 2,
          name: "Adapter Only",
        },
      ],
      "zen"
    );
    const ids = merged.map((m) => m.id);
    expect(ids).not.toContain("retired-one");
    // A model the catalog does not describe is NOT dropped: absent-from-catalog
    // is not the same as retired, and an adapter's own row is still its answer.
    expect(ids).toContain("adapter-only");
  });

  it("the enrich-only merge (a route the plugin does not serve) keeps adapter rows, drops an empty id, and appends nothing", () => {
    const merged = mergeDiscoveredModels(
      [
        {
          contextWindow: 1,
          id: "adapter-model",
          inputModalities: ["text"],
          maxTokens: 2,
          name: "Adapter Model",
        },
        { id: "beam-free", name: "Beam Free" },
        { id: "", name: "Nameless" },
      ],
      "zen"
    );

    // **Exactly what the adapter reported.** This merge is what a route the
    // plugin does NOT serve gets — another pi-ai row's planes, a custom relay,
    // a gateway-URL draft — and pi-ai serves those, so it cannot serve an id it
    // did not list. `mimo-v2.6-flash-free`, catalogued and servable, stays out.
    expect(merged.map((model) => model.id)).toEqual([
      "adapter-model",
      "beam-free",
    ]);
    // The adapter’s own capacities win over the canonical catalog, and the
    // row is the Remote's shape: nothing added, nothing `undefined`.
    expect(merged[0]).toStrictEqual({
      contextWindow: 1,
      id: "adapter-model",
      inputModalities: ["text"],
      maxTokens: 2,
      name: "Adapter Model",
    });
  });

  it("does not retire Go’s paid Muse 1.2 contributor row", () => {
    const merged = mergeDiscoveredModels(
      [{ id: "muse-spark-1.2-contributor" }],
      "go"
    );

    // Kept — it is not retired — and the enrich-only merge appends nothing.
    expect(merged.map((model) => model.id)).toEqual([
      "muse-spark-1.2-contributor",
    ]);
  });

  it("a row is whitelisted to the Remote's five fields: no extra key, no undefined value", () => {
    // Unsupported modalities are stripped, and a field nobody supplied is
    // ABSENT rather than `undefined`: the Remote reads an absent modality list
    // as "unknown", which is not the same as "text".
    expect(
      mergeDiscoveredModels(
        [
          {
            id: "adapter-multimodal",
            inputModalities: ["text", "image", "video", "audio", "pdf"],
          },
        ],
        "go"
      )
    ).toStrictEqual([
      { id: "adapter-multimodal", inputModalities: ["text", "image"] },
    ]);
    // A key the Remote does not carry never leaves the plugin.
    expect(
      mergeDiscoveredModels(
        [
          {
            api: "openai-responses",
            cost: { input: 1 },
            id: "adapter-x",
            reasoning: true,
          },
        ],
        "zen"
      )
    ).toStrictEqual([{ id: "adapter-x" }]);
  });

  it("a supplied modality list with no text or image entry leaves the field absent, not text", () => {
    // An audio-only list says nothing about text: the row reads "unknown", as
    // the composer's plane model does for the same spec, and the Remote's codec
    // accepts the absent field.
    expect(
      mergeDiscoveredModels(
        [{ id: "adapter-audio", inputModalities: ["audio", "video"] }],
        "zen"
      )
    ).toStrictEqual([{ id: "adapter-audio" }]);
    expect(
      mergeDiscoveredModels(
        [{ id: "adapter-empty", inputModalities: [] }],
        "zen"
      )
    ).toStrictEqual([{ id: "adapter-empty" }]);
  });

  it("the enrich-only merge of an empty answer is empty; a served plane's complement of it is the servable catalog", () => {
    // The enrich-only merge enriches what it is given and never widens it: an
    // empty answer from a route the plugin does not serve stays empty.
    expect(mergeDiscoveredModels([], "zen")).toEqual([]);
    // A plane the plugin serves is complemented instead (D3): with pi's list
    // empty, the answer is the catalog's servable models.
    expect(complementDiscoveredModels([], "zen").map((row) => row.id)).toEqual(
      servableIds(OPENCODE_ZEN_CATALOG)
    );
  });

  it("drops a row whose fields are not the Remote's types, and a repeated id; a non-list answer is no rows", () => {
    expect(
      mergeDiscoveredModels(
        [
          { id: "kept" },
          { id: "kept", name: "Second" },
          { id: "bad-name", name: "" },
          { contextWindow: "1", id: "bad-window" },
          { id: "bad-max", maxTokens: "2" },
          { id: "bad-modalities", inputModalities: "text" },
          { id: "bad-modality", inputModalities: [1] },
          { id: 7 },
          null,
        ],
        "zen"
      ).map((row) => row.id)
    ).toEqual(["kept"]);
    expect(mergeDiscoveredModels({ models: [{ id: "kept" }] }, "zen")).toEqual(
      []
    );
  });

  it("enriches candidate rows missing contextWindow or maxTokens from the catalog spec", () => {
    const merged = mergeDiscoveredModels(
      [
        {
          id: "minimax-m3",
          name: "MiniMax-M3",
        },
      ],
      "go"
    );

    expect(merged[0]).toEqual({
      contextWindow: 1_000_000,
      id: "minimax-m3",
      inputModalities: ["text", "image"],
      maxTokens: 131_072,
      name: "MiniMax-M3",
    });
  });
});

describe("decorateModelDiscovery", () => {
  it("leaves discovery alone when enrichment is disabled", () => {
    const original = async () => [{ id: "adapter-model" }];
    const ctx = {
      llm: { discoverModels: original },
    } as unknown as CordisContext;

    expect(
      decorateModelDiscovery(
        ctx,
        resolveConfig({ enrichModels: false }),
        SERVED
      )
    ).toBe(undefined);
    expect(ctx.llm?.discoverModels).toBe(original);
  });

  it("leaves a non-extensible discovery service installed", () => {
    const original = async () => [{ id: "adapter-model" }];
    const ctx = {
      llm: Object.freeze({ discoverModels: original }),
    } as unknown as CordisContext;

    expect(decorateModelDiscovery(ctx, resolveConfig(), SERVED)).toBe(
      undefined
    );
    expect(ctx.llm?.discoverModels).toBe(original);
  });

  it("forwards adapter errors and unclaimed routes unchanged", async () => {
    const failure = new Error("boom");
    const original = vi.fn().mockRejectedValue(failure);
    const ctx = {
      llm: { discoverModels: original },
    } as unknown as CordisContext;
    const stop = decorateModelDiscovery(ctx, resolveConfig(), SERVED);
    const wrapped = ctx.llm?.discoverModels;
    expect(typeof wrapped).toBe("function");
    if (typeof wrapped !== "function") {
      throw new TypeError("discovery decorator was not installed");
    }

    await expect(wrapped("llm-pi-ai", { provider: "other" })).rejects.toBe(
      failure
    );
    expect(original).toHaveBeenCalledWith(
      "llm-pi-ai",
      { provider: "other" },
      undefined
    );
    stop?.();
    expect(ctx.llm?.discoverModels).toBe(original);
  });

  it("Settings' fetch on a plane the plugin serves answers pi's rows first, then every servable, non-deprecated catalog model pi does not list, each id once", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("offline catalog test"))
    );
    const original = vi.fn().mockResolvedValue([
      { id: "beam-free", name: "Beam Free" },
      {
        contextWindow: 7,
        id: "mimo-v2.6-flash-free",
        inputModalities: ["text"],
        maxTokens: 3,
        name: "pi's MiMo",
      },
      {
        contextWindow: 11,
        id: "pi-only-model",
        inputModalities: ["text", "image"],
        maxTokens: 5,
        name: "pi's Own",
      },
    ]);
    const { ctx, stop, wrapped } = install(original);

    const rows = (await wrapped("llm-pi-ai", {
      baseURL: "https://opencode.ai/zen/v1",
      provider: "opencode",
    })) as { id: string }[];
    expect(original).toHaveBeenCalledWith(
      "llm-pi-ai",
      { baseURL: "https://opencode.ai/zen/v1", provider: "opencode" },
      undefined
    );
    // pi's three rows in pi's order, then the catalog's servable rows pi
    // lacks, in catalog order — `mimo-v2.6-flash-free` once, not twice (D3).
    expect(rows.map((row) => row.id)).toEqual([
      "beam-free",
      "mimo-v2.6-flash-free",
      "pi-only-model",
      ...servableIds(OPENCODE_ZEN_CATALOG).filter(
        (id) => id !== "beam-free" && id !== "mimo-v2.6-flash-free"
      ),
    ]);
    // The CATALOG's values win on a plane the plugin serves, in the composer's
    // own order (D17: the user's row, then the catalog, then pi): a row
    // adopted from the fetch is saved as the user's row, and it must carry
    // what the composer already serves, not pi's older capacities.
    const spec = findModelSpecOn("zen", "mimo-v2.6-flash-free");
    expect(spec).toBeDefined();
    expect(spec?.context_window).not.toBe(7);
    expect(rows[1]).toStrictEqual({
      contextWindow: spec?.context_window,
      id: "mimo-v2.6-flash-free",
      inputModalities: sanitizeModalities(spec?.input_modalities),
      maxTokens: spec?.max_output_tokens,
      name: spec?.name,
    });
    // pi fills what the catalog lacks: an id it does not describe keeps pi's.
    expect(findModelSpecOn("zen", "pi-only-model")).toBeUndefined();
    expect(rows[2]).toStrictEqual({
      contextWindow: 11,
      id: "pi-only-model",
      inputModalities: ["text", "image"],
      maxTokens: 5,
      name: "pi's Own",
    });
    expectWhitelisted(rows);
    stop?.();
    expect(ctx.llm?.discoverModels).toBe(original);
  });

  it("NO_DISCOVERY on the served pi-ai row's namespace (pi-ai mid-restart) answers the plane's catalog alone", async () => {
    const failure = Object.assign(
      new Error('no model discovery is registered for "llm-pi-ai"'),
      { code: "NO_DISCOVERY" }
    );
    const original = vi.fn().mockRejectedValue(failure);
    const { wrapped } = install(original);

    const rows = (await wrapped("llm-pi-ai", {
      provider: "opencode-go",
    })) as { id: string }[];
    expect(original).toHaveBeenCalledTimes(1);
    expect(rows.map((row) => row.id)).toEqual(servableIds(OPENCODE_GO_CATALOG));
    expect(rows.length).toBeGreaterThan(0);
    expectWhitelisted(rows);
  });

  it("NO_DISCOVERY with an already-aborted signal still answers the catalog: the wrapper never reads the signal", async () => {
    // The host throws NO_DISCOVERY before it looks at the signal, and pi-ai's
    // plane discovery answers from its installed catalog without reading it
    // either; the restart window resolves as the steady state does.
    const signal = AbortSignal.abort();
    const original = vi
      .fn()
      .mockRejectedValue(
        Object.assign(new Error("none"), { code: "NO_DISCOVERY" })
      );
    const { wrapped } = install(original);

    const rows = (await wrapped(
      "llm-pi-ai",
      { provider: "opencode" },
      signal
    )) as { id: string }[];
    expect(original).toHaveBeenCalledTimes(1);
    expect(original).toHaveBeenCalledWith(
      "llm-pi-ai",
      { provider: "opencode" },
      signal
    );
    expect(rows.map((row) => row.id)).toEqual(
      servableIds(OPENCODE_ZEN_CATALOG)
    );
  });

  it("NO_DISCOVERY anywhere the plugin does not serve a plane still rejects as the host sent it", async () => {
    const failure = Object.assign(
      new Error('no model discovery is registered for "other-ns"'),
      { code: "NO_DISCOVERY" }
    );
    const original = vi.fn().mockRejectedValue(failure);
    const { wrapped } = install(original);

    // Another namespace, a route that is not a plane, and a draft with no
    // route: none of them is the served row's plane.
    await expect(wrapped("other-ns", { provider: "opencode" })).rejects.toBe(
      failure
    );
    await expect(wrapped("llm-pi-ai", { provider: "deepseek" })).rejects.toBe(
      failure
    );
    await expect(
      wrapped("llm-pi-ai", { baseURL: "https://opencode.ai/zen/v1" })
    ).rejects.toBe(failure);
    // After a stand-down pi-ai serves the planes again: its error is its own.
    const { wrapped: stoodDown } = install(original, STOOD_DOWN);
    await expect(stoodDown("llm-pi-ai", { provider: "opencode" })).rejects.toBe(
      failure
    );
  });

  it("a route the plugin does not serve keeps pi's own values over the catalog's: pi-ai serves it, in its own order", async () => {
    // pi-ai serves this route and reads pi's row, never the catalog: the
    // enrich-only merge fills only what pi's row omits.
    const spec = findModelSpecOn("go", "minimax-m3");
    expect(spec?.context_window).not.toBe(7);
    const original = vi
      .fn()
      .mockResolvedValue([
        { contextWindow: 7, id: "minimax-m3", maxTokens: 3 },
      ]);
    const { wrapped } = install(original, STOOD_DOWN);
    expect(
      await wrapped("llm-pi-ai", { provider: "opencode-go" })
    ).toStrictEqual([
      {
        contextWindow: 7,
        id: "minimax-m3",
        inputModalities: sanitizeModalities(spec?.input_modalities),
        maxTokens: 3,
        name: spec?.name,
      },
    ]);
  });

  it("a plane on a pi-ai row the plugin does not serve keeps pi's own list: enriched, never widened", async () => {
    const original = vi.fn().mockResolvedValue([{ id: "minimax-m3" }]);
    // A second pi-ai row serves its own planes, and pi-ai refuses at save an
    // id it does not list: offering the catalog there would offer a refusal.
    const { wrapped } = install(original);
    // Enriched: the row pi listed, its missing fields filled from the Go
    // catalog's spec, and nothing appended.
    const spec = findModelSpecOn("go", "minimax-m3");
    expect(spec).toBeDefined();
    const enriched = [
      {
        contextWindow: spec?.context_window,
        id: "minimax-m3",
        inputModalities: sanitizeModalities(spec?.input_modalities),
        maxTokens: spec?.max_output_tokens,
        name: spec?.name,
      },
    ];
    const second = await wrapped("llm-pi-ai:second", {
      provider: "opencode-go",
    });
    expect(second).toStrictEqual(enriched);
    // The same after a stand-down, on the default row.
    const { wrapped: stoodDown } = install(original, STOOD_DOWN);
    const after = await stoodDown("llm-pi-ai", {
      provider: "opencode-go",
    });
    expect(after).toStrictEqual(enriched);
  });

  it("reads the claim per call: a mid-life stand-down or a renamed pi-ai row moves the complement with it", async () => {
    // One install, one mutable claim: the wrapper must not sample the claim
    // at install, nor assume pi-ai's default namespace.
    let live = true;
    let ns = "llm-pi-ai:custom";
    const claim: DiscoveryClaim = {
      claiming: () => live,
      piAiNamespace: () => ns,
    };
    const original = vi.fn().mockResolvedValue([{ id: "minimax-m3" }]);
    const { wrapped } = install(original, claim);
    const idsOn = async (namespace: string): Promise<string[]> =>
      (
        (await wrapped(namespace, { provider: "opencode-go" })) as {
          id: string;
        }[]
      ).map((row) => row.id);
    const complement = [
      "minimax-m3",
      ...servableIds(OPENCODE_GO_CATALOG).filter((id) => id !== "minimax-m3"),
    ];

    // The served row is the claim's namespace, not the host default.
    expect(await idsOn("llm-pi-ai:custom")).toEqual(complement);
    expect(await idsOn("llm-pi-ai")).toEqual(["minimax-m3"]);
    ns = "llm-pi-ai";
    expect(await idsOn("llm-pi-ai")).toEqual(complement);
    expect(await idsOn("llm-pi-ai:custom")).toEqual(["minimax-m3"]);
    // The claim stands down: the same wrapper now answers pi's list only.
    live = false;
    expect(await idsOn("llm-pi-ai")).toEqual(["minimax-m3"]);
  });

  it("on a served plane the original keeps every error but NO_DISCOVERY, and cancellation, as it threw them", async () => {
    const signal = AbortSignal.abort();
    const invalid = Object.assign(new Error("boom"), {
      code: "INVALID_DISCOVERY",
    });
    const aborted = new DOMException("aborted", "AbortError");
    const thrown = "a thrown string";
    for (const failure of [invalid, aborted, thrown]) {
      const original = vi.fn().mockRejectedValue(failure);
      const { wrapped } = install(original);
      await expect(
        wrapped("llm-pi-ai", { provider: "opencode" }, signal)
      ).rejects.toBe(failure);
      expect(original).toHaveBeenCalledTimes(1);
      expect(original).toHaveBeenCalledWith(
        "llm-pi-ai",
        { provider: "opencode" },
        signal
      );
    }
  });

  it("a call with no request passes the original's answer through unchanged", async () => {
    const answer = [{ api: "x", id: "adapter-model" }];
    const original = vi.fn().mockResolvedValue(answer);
    const { wrapped } = install(original);
    await expect(wrapped("llm-pi-ai")).resolves.toBe(answer);
    expect(original).toHaveBeenCalledWith("llm-pi-ai", undefined, undefined);
  });

  it("calls the host's method with the service as its receiver", async () => {
    // The real registry is a class whose `discoverModels` reads its own
    // discoveries through `this`, so a wrapper that calls it detached fails
    // before any adapter is asked.
    class DiscoveryHost {
      readonly discoveries = new Map([
        ["llm-pi-ai", async () => [{ id: "adapter-model" }]],
      ]);
      async discoverModels(ns: string, _request?: unknown): Promise<unknown> {
        return this.discoveries.get(ns)?.();
      }
    }
    const llm = new DiscoveryHost();
    const stop = decorateModelDiscovery(
      { llm } as unknown as CordisContext,
      resolveConfig(),
      SERVED
    );

    await expect(
      llm.discoverModels("llm-pi-ai", { provider: "other" })
    ).resolves.toEqual([{ id: "adapter-model" }]);
    stop?.();
  });

  it("forwards the caller's receiver, as the describe graft does", async () => {
    // The gateway calls the method through a view of the service, so the
    // receiver is the caller's and not the object the wrapper was set on.
    class DiscoveryHost {
      readonly discoveries = new Map([
        ["llm-pi-ai", async () => [{ id: "installed-model" }]],
      ]);
      async discoverModels(ns: string, _request?: unknown): Promise<unknown> {
        return this.discoveries.get(ns)?.();
      }
    }
    const llm = new DiscoveryHost();
    const stop = decorateModelDiscovery(
      { llm } as unknown as CordisContext,
      resolveConfig(),
      SERVED
    );
    const view = {
      discoveries: new Map([["llm-pi-ai", async () => [{ id: "view-model" }]]]),
    };

    const installed: unknown = Reflect.get(llm, "discoverModels");
    if (typeof installed !== "function") {
      throw new TypeError("discovery decorator was not installed");
    }
    await expect(
      Reflect.apply(installed, view, ["llm-pi-ai", { provider: "other" }])
    ).resolves.toEqual([{ id: "view-model" }]);
    stop?.();
  });

  it("leaves a wrapper installed on top of it in place on dispose", () => {
    const original = async () => [{ id: "adapter-model" }];
    const llm: Record<string, unknown> = { discoverModels: original };
    const stop = decorateModelDiscovery(
      { llm } as unknown as CordisContext,
      resolveConfig(),
      SERVED
    );
    const foreign = async () => [];
    llm.discoverModels = foreign;
    stop?.();

    expect(llm.discoverModels).toBe(foreign);
  });
});

describe("complementDiscoveredModels", () => {
  it("a catalog model the registry retired since the shim, or whose SDK nothing serves, is not offered; pi's retired row is dropped too", async () => {
    const retired = servableIds(OPENCODE_ZEN_CATALOG)[0] ?? "";
    expect(retired.length).toBeGreaterThan(0);
    await refreshCatalog(
      vi.fn().mockResolvedValue(
        Response.json({
          opencode: {
            models: {
              [retired]: { status: "deprecated" },
              "cohere-x": {
                name: "Cohere X",
                provider: { npm: "@ai-sdk/cohere" },
              },
            },
          },
        })
      ) as unknown as typeof fetch,
      true
    );
    // The refresh landed both facts the complement has to honour.
    expect(isDeprecatedModelOn("zen", retired)).toBe(true);
    expect(findModelSpecOn("zen", "cohere-x")?.provider_npm).toBe(
      "@ai-sdk/cohere"
    );

    expect(
      complementDiscoveredModels([{ id: retired }], "zen").map((row) => row.id)
    ).toEqual(servableIds(OPENCODE_ZEN_CATALOG).filter((id) => id !== retired));
  });
});
