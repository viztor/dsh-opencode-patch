/**
 * OpenCode Model Catalog & Enrichment.
 *
 * Split out of the former monolithic `plugin.test.ts`.
 *
 * @module test/catalog.test
 */

import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  OPENCODE_GO_CATALOG,
  OPENCODE_ZEN_CATALOG,
  PROTOCOL_FOR_SDK,
  RETIRED_ZEN_MODEL_IDS,
  ROUTE_FOR_PROTOCOL,
  SESSION_HEADER,
  UNSERVED_SDKS,
  enrichModelsResponse,
  getLiveGoCatalog,
  getLiveZenCatalog,
  isGoModelsListingUrl,
  isModelsListingUrl,
  isRetiredModel,
  isServableSdk,
  modelsForSdk,
  parseModelsDevCatalog,
  patchFetch,
  refreshCatalog,
  resolveConfig,
  resolveRoutedKey,
  sanitizeModalities,
  type ActiveTurnState,
} from "../src/index.ts";
import { findModelSpec } from "../src/models-catalog.ts";
import { createCaptureFetch, headerOf, SESSION_RE } from "./test-helpers.ts";

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.OPENCODE_SESSION_ID;
});

describe("OpenCode Model Catalog & Enrichment", () => {
  it("ships only active, priced models in the bundled Go shim", () => {
    expect(OPENCODE_GO_CATALOG.length).toBe(31);
    for (const model of OPENCODE_GO_CATALOG) {
      expect(model.id.length).toBeGreaterThan(0);
      expect(model.name.length).toBeGreaterThan(0);
      expect(model.context_window).toBeGreaterThan(0);
      expect(model.max_output_tokens).toBeGreaterThan(0);
      expect(Array.isArray(model.input_modalities)).toBe(true);
      expect(model.input_modalities.length).toBeGreaterThan(0);
      // Pricing is what makes the spend meter work before the first refresh.
      expect(model.cost).toBeDefined();
      expect(model.cost?.input).toBeGreaterThanOrEqual(0);
      expect(model.cost?.output).toBeGreaterThanOrEqual(0);
    }

    const ids = new Set(OPENCODE_GO_CATALOG.map((m) => m.id));
    expect(ids.has("deepseek-v4.1-flash")).toBe(true);
    expect(ids.has("deepseek-v4-pro")).toBe(true);
    expect(ids.has("qwen3.8-flash")).toBe(true);
    expect(ids.has("grok-4.7")).toBe(true);
    expect(ids.has("kimi-k3")).toBe(true);
    expect(ids.has("mimo-v2.6-pro")).toBe(true);
  });

  it("excludes models the gateway no longer serves", () => {
    // These are deprecated upstream; shipping them would put dead rows in the
    // picker whenever the SWR refresh has not succeeded.
    const deprecated = ["qwen3.7-max", "kimi-k2.6", "grok-4.5", "qwen3.6-plus"];
    const ids = new Set(OPENCODE_GO_CATALOG.map((m) => m.id));
    for (const id of deprecated) {
      expect(ids.has(id)).toBe(false);
    }
  });

  it("retires Muse Spark 1.2 only where OpenCode CLI omits it", () => {
    expect([...RETIRED_ZEN_MODEL_IDS].toSorted()).toEqual(
      [
        "muse-spark-1.2",
        "muse-spark-1.2-contributor",
        "muse-spark-1.2-contributor-free",
      ].toSorted()
    );
    expect(isRetiredModel("go", "muse-spark-1.2-contributor")).toBe(false);
    expect(isRetiredModel("zen", "muse-spark-1.2")).toBe(true);
    expect(isRetiredModel("zen", "muse-spark-1.2-contributor")).toBe(true);
    expect(isRetiredModel("zen", "muse-spark-1.2-contributor-free")).toBe(true);

    const liveGoIds = new Set(getLiveGoCatalog().map((m) => m.id));
    const liveZenIds = new Set(getLiveZenCatalog().map((m) => m.id));
    // The CLI still lists this paid Go entry, so the patch must preserve it.
    expect(liveGoIds.has("muse-spark-1.2-contributor")).toBe(true);
    for (const id of RETIRED_ZEN_MODEL_IDS) {
      expect(liveZenIds.has(id)).toBe(false);
    }
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

  it("enriches a configured custom gateway, not just opencode.ai", () => {
    // The gap this closes: `isModelsListingUrl` hardcoded `opencode.ai/zen`
    // while `isOpenCodeRequest` already honoured `gatewayUrls`. A relay that
    // matched every other OpenCode rule got the headers and the session id and
    // then no catalog — the only symptom was a shorter model list, which reads
    // as "fewer models" rather than as a broken rule.
    const gateways = ["https://relay.example.com/opencode"];
    expect(
      isModelsListingUrl(
        "https://relay.example.com/opencode/v1/models",
        gateways
      )
    ).toBe(true);
    // …and the default no longer matches it, because the marker replaced the
    // constant: a custom gateway is opted into, not additionally allowed.
    expect(
      isModelsListingUrl("https://relay.example.com/opencode/v1/models")
    ).toBe(false);

    // The Go plane is the PATH, so a relay's Go route is recognised too.
    expect(
      isGoModelsListingUrl(
        "https://relay.example.com/opencode/go/v1/models",
        gateways
      )
    ).toBe(true);
    expect(
      isGoModelsListingUrl(
        "https://relay.example.com/opencode/v1/models",
        gateways
      )
    ).toBe(false);
  });

  it("ships active Zen free tiers and flagships in the bundled shim", () => {
    // The shim answers before the first live refresh, and a refresh merges by
    // replacing the whole set — so these counts are the cold-start picker, and a
    // silent drop here is a model nobody can pick. Regenerate with
    // `scripts/regenerate-catalog-shim.ts` rather than editing by hand.
    expect(OPENCODE_ZEN_CATALOG.length).toBe(83);
    const freeModels = OPENCODE_ZEN_CATALOG.filter((m) => m.is_free === true);
    // Only the free tiers the gateway still serves.
    expect(freeModels.length).toBe(11);

    const ids = new Set(OPENCODE_ZEN_CATALOG.map((m) => m.id));
    expect(ids.has("muse-spark-1.3-contributor-free")).toBe(true);
    expect(ids.has("space-bunny-free")).toBe(true);
    expect(ids.has("claude-sonnet-4-5")).toBe(true);
    expect(ids.has("gpt-5.4")).toBe(true);
    expect(ids.has("gemini-3.8-flash")).toBe(true);
    // Deprecated Zen free tiers must not reappear.
    expect(ids.has("qwen3.6-plus-free")).toBe(false);
    expect(ids.has("minimax-m3-free")).toBe(false);
    expect(ids.has("kimi-k2.5-free")).toBe(false);
  });

  /**
   * The shim's curation rule, asserted rather than described.
   *
   * A model missing from the shim is merely ABSENT — it appears after the first
   * refresh. A model present but missing its `provider_npm` is WRONG: the hook
   * would dispatch it to a route that does not speak its format, and it would
   * fail with a gateway error that reads like a model problem. So the rule is
   * that every model the shim carries, and every model naming an SDK we have a
   * route for, is carried WITH that field.
   */
  it("carries the SDK on every Zen shim entry that names one", () => {
    const buckets = new Map<string, string[]>();
    for (const spec of OPENCODE_ZEN_CATALOG) {
      const npm = spec.provider_npm;
      if (npm === undefined) {
        continue;
      }
      buckets.set(npm, [...(buckets.get(npm) ?? []), spec.id]);
    }

    // Every plane we declare a route for is present in the cold-start shim, so
    // the mount has models to serve before the first refresh ever runs.
    expect(buckets.get("@ai-sdk/openai")?.length).toBe(30);
    expect(buckets.get("@ai-sdk/anthropic")?.length).toBe(18);

    // And each of those SDKs maps to a protocol this plugin actually serves, so
    // no carried model names a format with nowhere to go.
    for (const [npm, ids] of buckets) {
      const protocol = PROTOCOL_FOR_SDK[npm];
      if (protocol === undefined) {
        // `@ai-sdk/google` is the deliberate exception: `isServableSdk` keeps it
        // out of every picker, so it is carried only to be excluded on purpose
        // rather than being absent by accident.
        expect(isServableSdk(npm)).toBe(false);
        expect(ids.length).toBeGreaterThan(0);
        continue;
      }
      expect(ROUTE_FOR_PROTOCOL[protocol]).toBeDefined();
      expect(isServableSdk(npm)).toBe(true);
    }
  });

  it("serves every SDK-routed model from the route its SDK names", () => {
    // The end-to-end shape of the split, on cold-start data: each plane's model
    // count is exactly the shim's, and the two planes do not overlap.
    const responses = modelsForSdk("@ai-sdk/openai").map((m) => m.id);
    const anthropic = modelsForSdk("@ai-sdk/anthropic").map((m) => m.id);
    expect(responses.length).toBe(32);
    expect(anthropic.length).toBe(22);
    expect(responses.filter((id) => anthropic.includes(id))).toEqual([]);
    // The flagship of each plane is on the shim, so a cold start can serve it.
    expect(responses).toContain("muse-spark-1.3-contributor-free");
    expect(anthropic).toContain("claude-sonnet-4-5");
  });

  it("keeps the Go plane's models off the Zen-based internal routes", () => {
    // `modelsForSdk` unions both planes by default, which is right for "what
    // does this gateway serve". It is wrong for the routes this plugin mounts:
    // they are Zen-based, and the Go plane names six models the Zen endpoint does
    // not serve — `qwen3.8-max`, `minimax-m2.7`, `minimax-m3` and
    // `qwen3.7-plus` among them, none of which carries an SDK override on Zen.
    // Offering one resolves to "model not found" against the route's own base URL.
    const zen = OPENCODE_ZEN_CATALOG;
    for (const sdk of ["@ai-sdk/openai", "@ai-sdk/anthropic"]) {
      expect(modelsForSdk(sdk, zen).length).toBeLessThan(
        modelsForSdk(sdk).length
      );
    }
    expect(modelsForSdk("@ai-sdk/openai", zen).length).toBe(30);
    expect(modelsForSdk("@ai-sdk/anthropic", zen).length).toBe(18);
    // And the ones that would have leaked are genuinely Go-only.
    const goOnly = ["muse-spark-1.3-contributor", "qwen3.7-plus"];
    for (const id of goOnly) {
      expect(zen.some((s) => s.id === id)).toBe(false);
    }
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
    // Every bundled Go model plus the one custom row the gateway added.
    expect(json.data.length).toBe(OPENCODE_GO_CATALOG.length + 1);

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
    expect(zenJson.data.length).toBe(OPENCODE_ZEN_CATALOG.length);
    expect(
      zenJson.data.some((m) => m.id === "muse-spark-1.3-contributor-free")
    ).toBe(true);
  });

  it("preserves Space Bunny while removing retired Muse 1.2 rows", async () => {
    const goResponse = await enrichModelsResponse(
      "https://opencode.ai/zen/go/v1/models",
      Response.json({
        data: [
          { id: "space-bunny-free", object: "model" },
          { id: "muse-spark-1.2-contributor", object: "model" },
        ],
        object: "list",
      })
    );
    const goJson = (await goResponse.json()) as {
      data: Array<{ id: string }>;
    };
    expect(goJson.data.some((m) => m.id === "space-bunny-free")).toBe(true);
    expect(goJson.data.some((m) => m.id === "muse-spark-1.2-contributor")).toBe(
      true
    );

    const zenResponse = await enrichModelsResponse(
      "https://opencode.ai/zen/v1/models",
      Response.json({
        data: [
          { id: "space-bunny-free", object: "model" },
          { id: "muse-spark-1.2", object: "model" },
          { id: "muse-spark-1.2-contributor-free", object: "model" },
        ],
        object: "list",
      })
    );
    const zenJson = (await zenResponse.json()) as {
      data: Array<{ id: string }>;
    };
    expect(zenJson.data.some((m) => m.id === "space-bunny-free")).toBe(true);
    expect(zenJson.data.some((m) => m.id === "muse-spark-1.2")).toBe(false);
    expect(
      zenJson.data.some((m) => m.id === "muse-spark-1.2-contributor-free")
    ).toBe(false);
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
    expect(json.data.length).toBeGreaterThanOrEqual(OPENCODE_GO_CATALOG.length);

    const qwen = json.data.find((m) => m.id === "qwen3.8-flash");
    expect(qwen).toBeDefined();
    expect(qwen?.name).toBe("Qwen3.8 Flash");
  });

  it("leaves the raw gateway listing alone when enrichModels is off", async () => {
    const als = new AsyncLocalStorage<ActiveTurnState>();
    // The gateway advertises one bare model with no name or limits.
    const upstream = {
      data: [{ id: "deepseek-v4-flash", object: "model" }],
      object: "list",
    };
    const mockFetch = vi
      .fn()
      .mockImplementation(async () => Response.json(upstream));

    const patched = patchFetch(
      mockFetch,
      als,
      resolveConfig({ enrichModels: false })
    );
    const response = await patched("https://opencode.ai/zen/go/v1/models");
    const json = (await response.json()) as typeof upstream;

    // Byte-for-byte the gateway's answer: no catalog rows merged in, and no
    // name/context back-filled onto the one model it did advertise.
    expect(json).toEqual(upstream);
  });

  it("still fixes session headers when enrichModels is off", async () => {
    const als = new AsyncLocalStorage<ActiveTurnState>();
    const { capture, mockFetch } = createCaptureFetch();
    const patched = patchFetch(
      mockFetch,
      als,
      resolveConfig({ enrichModels: false })
    );

    await patched("https://opencode.ai/zen/go/v1/models");
    // Turning off the catalog must not disable the header repair this plugin
    // exists for.
    expect(headerOf(capture.init, SESSION_HEADER)).toMatch(SESSION_RE);
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

  it("drops deprecated models from a refresh so they cannot return", () => {
    // The shim ships active models only; the refresh has to agree, or a
    // revalidation would re-add rows the gateway no longer serves.
    const raw = {
      "opencode-go": {
        models: {
          "still-served": { name: "Still Served" },
          "gone-away": { name: "Gone Away", status: "deprecated" },
        },
      },
      opencode: {
        models: {
          "zen-live": { name: "Zen Live" },
          "zen-retired": { name: "Zen Retired", status: "deprecated" },
        },
      },
    };
    const parsed = parseModelsDevCatalog(raw);
    expect(parsed.go.map((m) => m.id)).toEqual(["still-served"]);
    expect(parsed.zen.map((m) => m.id)).toEqual(["zen-live"]);
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
    expect(initialGo.length).toBe(OPENCODE_GO_CATALOG.length);
    const initialZen = getLiveZenCatalog();
    expect(initialZen.length).toBe(OPENCODE_ZEN_CATALOG.length);

    const mockFetch = vi.fn().mockResolvedValue(
      Response.json({
        "opencode-go": {
          models: {
            "future-test-model": {
              limit: { context: 1500000, output: 200000 },
              modalities: { input: ["text"] },
              name: "Future Test Model",
            },
            "muse-spark-1.2-contributor": {
              name: "Muse Spark 1.2 Contributor",
            },
          },
        },
        opencode: {
          models: {
            "future-zen-model": {
              name: "Future Zen Model",
            },
            "muse-spark-1.2": {
              name: "Muse Spark 1.2",
            },
            "muse-spark-1.2-contributor-free": {
              name: "Muse Spark 1.2 Free",
            },
          },
        },
      })
    );

    const updated = await refreshCatalog(
      mockFetch as unknown as typeof fetch,
      true
    );
    expect(updated.go.length).toBe(OPENCODE_GO_CATALOG.length + 1);
    expect(updated.zen.length).toBe(OPENCODE_ZEN_CATALOG.length + 1);

    const futureModel = updated.go.find((m) => m.id === "future-test-model");
    expect(futureModel).toBeDefined();
    expect(futureModel?.name).toBe("Future Test Model");
    expect(futureModel?.context_window).toBe(1500000);
    expect(updated.go.some((m) => m.id === "muse-spark-1.2-contributor")).toBe(
      true
    );
    expect(updated.zen.some((m) => m.id === "muse-spark-1.2")).toBe(false);
    expect(
      updated.zen.some((m) => m.id === "muse-spark-1.2-contributor-free")
    ).toBe(false);
  });

  it("refreshCatalog degrades gracefully on network errors without throwing", async () => {
    const before = {
      go: getLiveGoCatalog().length,
      zen: getLiveZenCatalog().length,
    };
    const mockFailingFetch = vi
      .fn()
      .mockRejectedValue(new Error("Network timeout"));

    const catalog = await refreshCatalog(
      mockFailingFetch as unknown as typeof fetch,
      true
    );

    // A failed refresh must resolve (never throw) and leave the active
    // catalog exactly as it was, so the meter keeps working offline.
    expect(catalog.go.length).toBe(before.go);
    expect(catalog.zen.length).toBe(before.zen);
    expect(catalog.go.length).toBeGreaterThanOrEqual(
      OPENCODE_GO_CATALOG.length
    );
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

  it("sanitizeModalities restricts modalities strictly to text and image", () => {
    expect(
      sanitizeModalities(["text", "image", "video", "audio", "pdf"])
    ).toEqual(["text", "image"]);
    expect(sanitizeModalities(["video", "pdf"])).toEqual(["text"]);
    expect(sanitizeModalities(null)).toEqual(["text"]);
    expect(sanitizeModalities([])).toEqual(["text"]);
    expect(sanitizeModalities(["image"])).toEqual(["image"]);
  });

  it("all bundled Go and Zen models contain only DSH-supported modalities", () => {
    for (const model of [...OPENCODE_GO_CATALOG, ...OPENCODE_ZEN_CATALOG]) {
      for (const modality of model.input_modalities) {
        expect(["text", "image"]).toContain(modality);
      }
    }
  });
});

describe("findModelSpec", () => {
  it("resolves a Go model together with its pricing rate", () => {
    // The stream hook prices each turn through this lookup, so the rate must
    // ride along with the spec.
    const spec = findModelSpec("deepseek-v4.1-flash");
    assert.ok(spec, "expected the Go shim to carry deepseek-v4.1-flash");
    expect(spec.id).toBe("deepseek-v4.1-flash");
    expect(spec.name).toBe("DeepSeek V4.1 Flash");
    expect(spec.context_window).toBe(1_000_000);
    expect(spec.cost).toEqual({ cache_read: 0.003, input: 0.15, output: 0.6 });
    expect(spec.is_free).toBeUndefined();
  });

  it("resolves a free Zen model, marked free at an explicit zero rate", () => {
    const spec = findModelSpec("mimo-v2.6-flash-free");
    assert.ok(spec, "expected the Zen shim to carry mimo-v2.6-flash-free");
    expect(spec.is_free).toBe(true);
    expect(spec.context_window).toBe(200_000);
    expect(spec.max_output_tokens).toBe(32_000);
    // A free model still carries an explicit zero rate, so the stream hook
    // prices it as $0 rather than falling back to "unknown model" handling.
    expect(spec.cost).toEqual({ cache_read: 0, input: 0, output: 0 });
  });

  it("still resolves an id retired on Zen but listed on Go", () => {
    // Retirement is PROVIDER-SCOPED: the OpenCode CLI keeps serving the paid Go
    // 1.2 contributor entry, so the Go catalog retains it while Zen drops it.
    // A provider-blind lookup therefore finds it — and must keep doing so, or
    // Go sessions would lose pricing for a model the gateway still serves.
    expect(isRetiredModel("zen", "muse-spark-1.2-contributor")).toBe(true);
    expect(isRetiredModel("go", "muse-spark-1.2-contributor")).toBe(false);

    const spec = findModelSpec("muse-spark-1.2-contributor");
    assert.ok(spec, "expected the Go shim to keep muse-spark-1.2-contributor");
    expect(spec.id).toBe("muse-spark-1.2-contributor");
  });

  it("never resolves a Zen-retired id that no provider still lists", () => {
    for (const id of ["muse-spark-1.2", "muse-spark-1.2-contributor-free"]) {
      expect(RETIRED_ZEN_MODEL_IDS.has(id)).toBe(true);
      expect(findModelSpec(id)).toBeUndefined();
    }
  });

  it("returns undefined for unknown or empty ids", () => {
    expect(findModelSpec("not-a-real-model")).toBeUndefined();
    expect(findModelSpec("")).toBeUndefined();
    // Case matters: model ids are exact.
    expect(findModelSpec("DeepSeek-V4.1-Flash")).toBeUndefined();
  });
});

describe("enrichModelsResponse: a model neither source describes", () => {
  it("still describes it fully, so the picker never shows a row with no limits", async () => {
    // The gateway adds models before models.dev — or the bundled shim — knows
    // them. DSH sizes its context meter from these numbers, and the live e2e
    // asserts every row the picker sees carries them; an `undefined` here
    // reaches the UI as a model with no limits at all.
    const url = "https://opencode.ai/zen/v1/models";
    const upstream = Response.json({
      data: [{ id: "brand-new-model-nobody-knows", object: "model" }],
    });

    const response = await enrichModelsResponse(url, upstream);
    const body = (await response.json()) as { data: Record<string, unknown>[] };
    const row = body.data.find(
      (entry) => entry.id === "brand-new-model-nobody-knows"
    );
    expect(row).toBeDefined();
    expect(typeof row?.context_window).toBe("number");
    expect(typeof row?.max_output_tokens).toBe("number");
    expect(row?.context_window).toBeGreaterThan(0);
    expect(row?.max_output_tokens).toBeGreaterThan(0);
  });
});

/**
 * Every SDK the generated catalog names must be CLASSIFIED - either mapped to a
 * protocol or listed as deliberately unserved. The failure this prevents is
 * silent: models.dev gains a new SDK, the freshness gate regenerates the shim
 * and passes, and the model disappears from the picker because the servability
 * check treats "unknown" as "unservable".
 */
describe("catalog · SDK coverage", () => {
  it("classifies every provider SDK the catalog names", () => {
    const named = new Set<string>();
    for (const plane of [OPENCODE_ZEN_CATALOG, OPENCODE_GO_CATALOG]) {
      for (const model of Object.values(plane)) {
        const sdk = (model as { provider_npm?: string }).provider_npm;
        if (typeof sdk === "string" && sdk.length > 0) {
          named.add(sdk);
        }
      }
    }
    const classified = new Set([
      ...Object.keys(PROTOCOL_FOR_SDK),
      ...UNSERVED_SDKS,
    ]);
    expect([...named].filter((sdk) => !classified.has(sdk))).toEqual([]);
  });
});
