/**
 * OpenCode Model Catalog & Enrichment.
 *
 * Split out of the former monolithic `plugin.test.ts`.
 *
 * @module test/catalog.test
 */

import { AsyncLocalStorage } from "node:async_hooks";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  OPENCODE_GO_CATALOG,
  OPENCODE_ZEN_CATALOG,
  enrichModelsResponse,
  getLiveGoCatalog,
  getLiveZenCatalog,
  isGoModelsListingUrl,
  isModelsListingUrl,
  parseModelsDevCatalog,
  patchFetch,
  refreshCatalog,
  resolveConfig,
  resolveRoutedKey,
  type ActiveTurnState,
} from "../src/index.ts";

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.OPENCODE_SESSION_ID;
});

describe("OpenCode Model Catalog & Enrichment", () => {
  it("ships the full canonical catalog of 33 OpenCode Go models", () => {
    expect(OPENCODE_GO_CATALOG.length).toBe(33);
    for (const model of OPENCODE_GO_CATALOG) {
      expect(model.id.length).toBeGreaterThan(0);
      expect(model.name.length).toBeGreaterThan(0);
      expect(model.context_window).toBeGreaterThan(0);
      expect(model.max_output_tokens).toBeGreaterThan(0);
      expect(Array.isArray(model.input_modalities)).toBe(true);
      expect(model.input_modalities.length).toBeGreaterThan(0);
    }

    const ids = new Set(OPENCODE_GO_CATALOG.map((m) => m.id));
    expect(ids.has("deepseek-v4.1-flash")).toBe(true);
    expect(ids.has("deepseek-v4-pro")).toBe(true);
    expect(ids.has("qwen3.8-flash")).toBe(true);
    expect(ids.has("grok-4.7")).toBe(true);
    expect(ids.has("kimi-k3")).toBe(true);
    expect(ids.has("mimo-v2.6-pro")).toBe(true);
  });

  it("identifies model listing URLs accurately", () => {
    expect(isModelsListingUrl("https://opencode.ai/zen/go/v1/models")).toBe(
      true
    );
    expect(
      isModelsListingUrl("https://opencode.ai/zen/v1/models?limit=50")
    ).toBe(true);
    expect(
      isModelsListingUrl("https://opencode.ai/zen/v1/chat/completions")
    ).toBe(false);
    expect(isModelsListingUrl("https://api.openai.com/v1/models")).toBe(false);
  });

  it("identifies model listing URLs accurately", () => {
    expect(isModelsListingUrl("https://opencode.ai/zen/go/v1/models")).toBe(
      true
    );
    expect(
      isModelsListingUrl("https://opencode.ai/zen/v1/models?limit=50")
    ).toBe(true);
    expect(isGoModelsListingUrl("https://opencode.ai/zen/go/v1/models")).toBe(
      true
    );
    expect(isGoModelsListingUrl("https://opencode.ai/zen/v1/models")).toBe(
      false
    );
    expect(
      isModelsListingUrl("https://opencode.ai/zen/v1/chat/completions")
    ).toBe(false);
    expect(isModelsListingUrl("https://api.openai.com/v1/models")).toBe(false);
  });

  it("ships canonical Zen catalog with free-tier and flagship models", () => {
    expect(OPENCODE_ZEN_CATALOG.length).toBeGreaterThanOrEqual(49);
    const freeModels = OPENCODE_ZEN_CATALOG.filter((m) => m.is_free === true);
    expect(freeModels.length).toBe(36);

    const ids = new Set(OPENCODE_ZEN_CATALOG.map((m) => m.id));
    expect(ids.has("muse-spark-1.3-contributor-free")).toBe(true);
    expect(ids.has("space-bunny-free")).toBe(true);
    expect(ids.has("claude-sonnet-4-5")).toBe(true);
    expect(ids.has("gpt-5.4")).toBe(true);
    expect(ids.has("gemini-3.8-flash")).toBe(true);
  });

  it("enriches a truncated gateway models response with full catalog metadata", async () => {
    // Upstream gateway returned only 2 models, both missing name/context_window
    const rawGatewayPayload = {
      data: [
        { id: "deepseek-v4.1-flash", object: "model" },
        { id: "custom-gateway-model", object: "model" },
      ],
      object: "list",
    };
    const mockResponse = Response.json(rawGatewayPayload);

    const enrichedResponse = await enrichModelsResponse(
      "https://opencode.ai/zen/go/v1/models",
      mockResponse
    );
    expect(enrichedResponse.status).toBe(200);

    const json = (await enrichedResponse.json()) as {
      data: Array<{
        context_window?: number;
        id: string;
        name?: string;
      }>;
      object: string;
    };
    expect(json.object).toBe("list");
    // Should contain all 33 catalog models + the 1 custom gateway model = 34 models
    expect(json.data.length).toBe(34);

    const deepseek = json.data.find((m) => m.id === "deepseek-v4.1-flash");
    expect(deepseek).toBeDefined();
    expect(deepseek?.name).toBe("DeepSeek V4.1 Flash");
    expect(deepseek?.context_window).toBe(1000000);

    const custom = json.data.find((m) => m.id === "custom-gateway-model");
    expect(custom).toBeDefined();
    expect(custom?.id).toBe("custom-gateway-model");

    // Also verify Zen models enrichment
    const zenResponse = await enrichModelsResponse(
      "https://opencode.ai/zen/v1/models",
      Response.json({ data: [], object: "list" })
    );
    const zenJson = (await zenResponse.json()) as {
      data: Array<{ id: string }>;
    };
    expect(zenJson.data.length).toBeGreaterThanOrEqual(49);
    expect(
      zenJson.data.some((m) => m.id === "muse-spark-1.3-contributor-free")
    ).toBe(true);
  });

  it("patchFetch transparently enriches GET .../models calls", async () => {
    const als = new AsyncLocalStorage<ActiveTurnState>();
    const mockFetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes("/models")) {
        return Response.json({
          data: [{ id: "deepseek-v4-flash", object: "model" }],
          object: "list",
        });
      }
      return new Response("OK", { status: 200 });
    });

    const patched = patchFetch(mockFetch, als, resolveConfig());
    const res = await patched("https://opencode.ai/zen/go/v1/models");
    expect(res.status).toBe(200);

    const json = (await res.json()) as {
      data: Array<{ id: string; name?: string }>;
    };
    expect(json.data.length).toBeGreaterThanOrEqual(33);

    const qwen = json.data.find((m) => m.id === "qwen3.8-flash");
    expect(qwen).toBeDefined();
    expect(qwen?.name).toBe("Qwen3.8 Flash");
  });

  it("parseModelsDevCatalog handles malformed data gracefully", () => {
    expect(parseModelsDevCatalog(null)).toEqual({ go: [], zen: [] });
    expect(parseModelsDevCatalog({})).toEqual({ go: [], zen: [] });
    expect(parseModelsDevCatalog({ "opencode-go": {} })).toEqual({
      go: [],
      zen: [],
    });
    expect(
      parseModelsDevCatalog({ "opencode-go": { models: "invalid" } })
    ).toEqual({ go: [], zen: [] });
  });

  it("parseModelsDevCatalog extracts complete model specifications for Go and Zen", () => {
    const raw = {
      "opencode-go": {
        models: {
          "new-preview-model": {
            limit: { context: 2000000, output: 256000 },
            modalities: { input: ["text", "image"] },
            name: "New Preview Model",
          },
        },
      },
      opencode: {
        models: {
          "zen-free-test": {
            cost: { input: 0, output: 0 },
            limit: { context: 1000000, output: 128000 },
            name: "Zen Free Test",
          },
        },
      },
    };
    const parsed = parseModelsDevCatalog(raw);
    expect(parsed.go.length).toBe(1);
    expect(parsed.go[0]).toEqual({
      context_window: 2000000,
      id: "new-preview-model",
      input_modalities: ["text", "image"],
      max_output_tokens: 256000,
      name: "New Preview Model",
    });
    expect(parsed.zen.length).toBe(1);
    expect(parsed.zen[0]?.is_free).toBe(true);
    expect(parsed.zen[0]?.name).toBe("Zen Free Test");
  });

  it("getLiveGoCatalog and getLiveZenCatalog return local shims and revalidate", async () => {
    const initialGo = getLiveGoCatalog();
    expect(initialGo.length).toBeGreaterThanOrEqual(33);
    const initialZen = getLiveZenCatalog();
    expect(initialZen.length).toBeGreaterThanOrEqual(49);

    const mockFetch = vi.fn().mockResolvedValue(
      Response.json({
        "opencode-go": {
          models: {
            "future-test-model": {
              limit: { context: 1500000, output: 200000 },
              modalities: { input: ["text"] },
              name: "Future Test Model",
            },
          },
        },
        opencode: {
          models: {
            "future-zen-model": {
              name: "Future Zen Model",
            },
          },
        },
      })
    );

    const updated = await refreshCatalog(
      mockFetch as unknown as typeof fetch,
      true
    );
    expect(updated.go.length).toBeGreaterThanOrEqual(34);
    expect(updated.zen.length).toBeGreaterThanOrEqual(50);

    const futureModel = updated.go.find((m) => m.id === "future-test-model");
    expect(futureModel).toBeDefined();
    expect(futureModel?.name).toBe("Future Test Model");
    expect(futureModel?.context_window).toBe(1500000);
  });

  it("refreshCatalog degrades gracefully on network errors without throwing", async () => {
    const mockFailingFetch = vi
      .fn()
      .mockRejectedValue(new Error("Network timeout"));
    const catalog = await refreshCatalog(
      mockFailingFetch as unknown as typeof fetch,
      true
    );
    expect(catalog.go.length).toBeGreaterThanOrEqual(33);
    expect(catalog.zen.length).toBeGreaterThanOrEqual(49);
  });

  it("resolveRoutedKey identifies routed provider tier and key prefix", async () => {
    const mockCtx = {
      loader: {
        entries: () => [
          {
            options: {
              config: {
                providers: {
                  "opencode-go": {
                    apiKeyEnv: "OPENCODE_GO_API_KEY",
                  },
                  opencode: {
                    apiKeyEnv: "OPENCODE_API_KEY",
                  },
                },
              },
              id: "llm-pi-ai",
              name: "@deepseek-ai/dsh-llm-pi-ai",
            },
          },
        ],
      },
    };

    process.env.OPENCODE_GO_API_KEY = "sk-68klEy0x2_test_go_key";
    process.env.OPENCODE_API_KEY = "oc_sk_ac6304e0f930_test_zen_key";

    try {
      const goDetails = await resolveRoutedKey(mockCtx, "opencode-go");
      expect(goDetails.tier).toBe("go");
      expect(goDetails.keyPrefix).toBe("sk-68klEy0");

      const zenDetails = await resolveRoutedKey(mockCtx, "opencode");
      expect(zenDetails.tier).toBe("zen");
      expect(zenDetails.keyPrefix).toBe("oc_sk_ac63");
    } finally {
      delete process.env.OPENCODE_GO_API_KEY;
      delete process.env.OPENCODE_API_KEY;
    }
  });
});
