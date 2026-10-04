/**
 * Provider-aware model-discovery decoration.
 *
 * A configured OpenCode route can be answered from its adapter’s installed
 * catalog without a gateway request. In that path, response enrichment never
 * runs, so decorating the discovery answer is the only way to add a missing
 * catalog row or remove a provider-retired row from “fetch available models.”
 *
 * @module test/models-discovery.test
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  decorateModelDiscovery,
  hideResponsesRoute,
  isRouteRegistered,
  mergeDiscoveredModels,
  resolveConfig,
  resolveDiscoveryProvider,
  RESPONSES_ROUTE,
  type CordisContext,
  type CatalogModelSpec,
} from "../src/index.ts";

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.OPENCODE_SESSION_ID;
});

const providers = new Set(["opencode", "opencode-go"]);
const gatewayUrls = ["opencode.ai/zen"];
const config = { ...resolveConfig(), gatewayUrls, providers };

const catalogRow = (
  id: string,
  name = id,
  inputModalities: string[] = ["text"]
): CatalogModelSpec => ({
  context_window: 1000000,
  id,
  input_modalities: inputModalities,
  max_output_tokens: 131072,
  name,
});

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
  it("keeps adapter rows, appends missing rows, and retires Zen 1.2", () => {
    const merged = mergeDiscoveredModels(
      [
        {
          contextWindow: 1,
          id: "adapter-model",
          inputModalities: ["text"],
          maxTokens: 2,
          name: "Adapter Model",
        },
        { id: "muse-spark-1.2-contributor-free", name: "Muse Spark 1.2 Free" },
        { id: "", name: "Nameless" },
      ],
      "zen",
      [
        catalogRow("adapter-model", "Catalog Adapter Model"),
        catalogRow("space-bunny-free", "Space Bunny Free"),
      ]
    );

    expect(merged.map((model) => model.id)).toEqual([
      "adapter-model",
      "space-bunny-free",
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
      "go",
      [catalogRow("space-bunny-free", "Space Bunny Free")]
    );

    expect(merged.map((model) => model.id)).toEqual([
      "muse-spark-1.2-contributor",
      "space-bunny-free",
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
      "go",
      [
        catalogRow("catalog-multimodal", "Catalog Multimodal", [
          "text",
          "image",
          "video",
        ]),
      ]
    );

    expect(merged).toEqual([
      {
        id: "adapter-multimodal",
        inputModalities: ["text", "image"],
      },
      {
        contextWindow: 1000000,
        id: "catalog-multimodal",
        inputModalities: ["text", "image"],
        maxTokens: 131072,
        name: "Catalog Multimodal",
      },
    ]);
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

  it("adds Space Bunny and removes retired 1.2 from an OpenCode answer", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("offline catalog test"))
    );
    const original = vi
      .fn()
      .mockResolvedValue([
        { id: "muse-spark-1.2-contributor-free", name: "Muse Spark 1.2 Free" },
      ]);
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
    expect(ids).toContain("space-bunny-free");
    expect(ids).not.toContain("muse-spark-1.2-contributor-free");
    stop?.();
    expect(ctx.llm?.discoverModels).toBe(original);
  });
});

describe("models-discovery: hiding the internal Responses route", () => {
  const hostWith = () => {
    const seen: string[] = [];
    const ctx = {
      llm: {
        listConfigurableProviders: () => [
          { provider: "opencode" },
          { provider: RESPONSES_ROUTE },
        ],
        listModels: async (provider: string) => {
          seen.push(provider);
          return [{ id: `${provider}-model` }];
        },
        listProviders: () => [
          { id: "opencode", name: "opencode" },
          { id: RESPONSES_ROUTE, name: RESPONSES_ROUTE },
        ],
      },
    } as unknown as CordisContext;
    return { ctx, seen };
  };

  it("removes the route from every listing a user sees", () => {
    // Three surfaces enumerate providers and there is no hidden flag on any of
    // them. `joinProviderDirectory` (Settings → Models) pushes a row for every
    // REGISTERED provider, so filtering only the configurable directory would
    // leave the route on screen — `listProviders` is the one that matters.
    const { ctx } = hostWith();
    const stop = hideResponsesRoute(ctx);
    expect(stop).toBeDefined();

    expect(ctx.llm?.listProviders?.()).toEqual([
      { id: "opencode", name: "opencode" },
    ]);
    expect(ctx.llm?.listConfigurableProviders?.()).toEqual([
      { provider: "opencode" },
    ]);
  });

  it("still reports the route as registered, so the redirect fires", () => {
    // The redirect asks whether it has somewhere to go. Asked of the FILTERED
    // listing the answer would always be no and the re-dispatch would never
    // happen — which is why the check reads the original.
    const { ctx } = hostWith();
    const stop = hideResponsesRoute(ctx);

    expect(isRouteRegistered(RESPONSES_ROUTE)).toBe(true);
    expect(ctx.llm?.listProviders?.()).toHaveLength(1);

    stop?.();
    expect(isRouteRegistered(RESPONSES_ROUTE)).toBe(true);
  });

  it("leaves listModels alone, because nothing reaches it", async () => {
    // Every Host consumer of listModels iterates listProviders() first —
    // buildModelCatalog, modelAvailable and acp's model control all do — so
    // filtering it as well would be a third patch guarding nothing.
    const { ctx, seen } = hostWith();
    const stop = hideResponsesRoute(ctx);

    await expect(ctx.llm?.listModels?.(RESPONSES_ROUTE)).resolves.toEqual([
      { id: `${RESPONSES_ROUTE}-model` },
    ]);
    expect(seen).toEqual([RESPONSES_ROUTE]);

    stop?.();
    expect(ctx.llm?.listProviders?.()).toHaveLength(2);
  });

  it("degrades to a no-op when the Host exposes no listing at all", () => {
    const ctx = { llm: {} } as unknown as CordisContext;
    expect(hideResponsesRoute(ctx)).toBeUndefined();
  });
});
