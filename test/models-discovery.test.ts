/**
 * Provider-aware model-discovery decoration.
 *
 * A configured OpenCode route can be answered from its adapter’s installed
 * catalog without a gateway request. In that path, response enrichment never
 * runs, so decorating the discovery answer is the only way to add a missing
 * catalog row or remove a provider-retired row from “fetch available models.”
 *
 * The listing, model-info and plane-adapter decorations this file used to
 * cover are gone (P-R1): the plane adapter answers those itself, and
 * `test/host-characterization.test.ts` and `test/host-planes.test.ts` pin
 * what it answers on the real host.
 *
 * @module test/models-discovery.test
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  type CordisContext,
  decorateModelDiscovery,
  isDeprecatedModelOn,
  mergeDiscoveredModels,
  parseModelsDevCatalog,
  resolveConfig,
  resolveDiscoveryProvider,
} from "./support/src.ts";

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.OPENCODE_SESSION_ID;
});

const providers = new Set(["opencode", "opencode-go"]);
const gatewayUrls = ["opencode.ai/zen"];
const config = { ...resolveConfig(), gatewayUrls, providers };

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

  it("keeps adapter rows, drops an empty id, and does NOT append the catalog", () => {
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

    // **Exactly what the adapter reported.** The catalog supplies metadata, not
    // rows: a refresh must not widen the deployment's list, so `beam-free`
    // — catalogued, servable, and NOT declared here — stays out.
    expect(merged.map((model) => model.id)).toEqual([
      "adapter-model",
      "beam-free",
    ]);
    // The adapter’s own capacities win over the canonical catalog.
    expect(merged[0]).toEqual({
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

    // Kept — it is not retired — and the catalog appends nothing.
    expect(merged.map((model) => model.id)).toEqual([
      "muse-spark-1.2-contributor",
    ]);
  });

  it("sanitizes candidate modalities to DSH-supported text and image only", () => {
    const merged = mergeDiscoveredModels(
      [
        {
          id: "adapter-multimodal",
          inputModalities: ["text", "image", "video", "audio", "pdf"],
        },
      ],
      "go"
    );

    // Unsupported modalities are stripped from the adapter row, and the catalog
    // row is not appended — the adapter answered.
    expect(merged).toEqual([
      {
        contextWindow: undefined,
        id: "adapter-multimodal",
        inputModalities: ["text", "image"],
        maxTokens: undefined,
        name: undefined,
      },
    ]);
  });

  it("adds nothing when the adapter reported nothing", () => {
    // An empty answer is an ABSENCE, and the previous reading of it — "no
    // preference, so the catalog stands in" — is how a deployment that had
    // declared four models saw eighty-six. The merge enriches what it is given and
    // never widens it, in this case as in every other.
    const merged = mergeDiscoveredModels([], "zen");
    expect(merged).toEqual([]);
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
      decorateModelDiscovery(ctx, resolveConfig({ enrichModels: false }))
    ).toBe(undefined);
    expect(ctx.llm?.discoverModels).toBe(original);
  });

  it("leaves a non-extensible discovery service installed", () => {
    const original = async () => [{ id: "adapter-model" }];
    const ctx = {
      llm: Object.freeze({ discoverModels: original }),
    } as unknown as CordisContext;

    expect(decorateModelDiscovery(ctx, resolveConfig())).toBe(undefined);
    expect(ctx.llm?.discoverModels).toBe(original);
  });

  it("forwards adapter errors and unclaimed routes unchanged", async () => {
    const failure = new Error("boom");
    const original = vi.fn().mockRejectedValue(failure);
    const ctx = {
      llm: { discoverModels: original },
    } as unknown as CordisContext;
    const stop = decorateModelDiscovery(ctx, resolveConfig());
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

  it("keeps the 1.2 row the zen plane serves and adds nothing on refresh", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("offline catalog test"))
    );
    const original = vi
      .fn()
      .mockResolvedValue([{ id: "beam-free", name: "Beam Free" }]);
    const ctx = {
      llm: { discoverModels: original },
    } as unknown as CordisContext;
    const stop = decorateModelDiscovery(ctx, resolveConfig());
    const wrapped = ctx.llm?.discoverModels;
    expect(typeof wrapped).toBe("function");
    if (typeof wrapped !== "function") {
      throw new TypeError("discovery decorator was not installed");
    }

    const merged = (await wrapped("llm-pi-ai", {
      baseURL: "https://opencode.ai/zen/v1",
      provider: "opencode",
    })) as Array<{ id: string }>;
    const ids = merged.map((model) => model.id);
    expect(original).toHaveBeenCalledWith(
      "llm-pi-ai",
      { baseURL: "https://opencode.ai/zen/v1", provider: "opencode" },
      undefined
    );
    // **Discovery does NOT join the catalog.** It briefly did — reasoning that
    // "browse to pick" is a different surface from "what this route serves" — and
    // the owner's instruction had been explicit: *user can select them from the
    // list, but we shouldn't override the user's config for what is usable*. The
    // join made Settings list models the deployment never declared.
    //
    // The refresh adds nothing the adapter did not answer. The free model the
    // catalog knows is `mimo-v2.6-flash-free` — a DIFFERENT one from the row the
    // adapter answered, so the assertion is about the join and not about a name.
    expect(ids).not.toContain("mimo-v2.6-flash-free");
    expect(ids).toHaveLength(1);
    // Kept, not removed: it answers on zen, so it is not retired.
    expect(ids).toContain("beam-free");
    stop?.();
    expect(ctx.llm?.discoverModels).toBe(original);
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
      resolveConfig()
    );

    await expect(
      llm.discoverModels("llm-pi-ai", { provider: "other" })
    ).resolves.toEqual([{ id: "adapter-model" }]);
    stop?.();
  });

  it("leaves a wrapper installed on top of it in place on dispose", () => {
    const original = async () => [{ id: "adapter-model" }];
    const llm: Record<string, unknown> = { discoverModels: original };
    const stop = decorateModelDiscovery(
      { llm } as unknown as CordisContext,
      resolveConfig()
    );
    const foreign = async () => [];
    llm.discoverModels = foreign;
    stop?.();

    expect(llm.discoverModels).toBe(foreign);
  });
});
