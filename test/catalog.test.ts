import assert from "node:assert/strict";
/**
 * OpenCode Model Catalog & Enrichment.
 *
 * Split out of the former monolithic `plugin.test.ts`.
 *
 * @module test/catalog.test
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { readFile } from "node:fs/promises";

import { afterEach, describe, expect, it, vi } from "vitest";

import { OPENCODE_FAMILY_API } from "../src/catalog-data.ts";
import {
  OPENCODE_GO_CATALOG,
  OPENCODE_ZEN_CATALOG,
  PROTOCOL_FOR_SDK,
  ROUTE_FOR_PROTOCOL,
  SESSION_HEADER,
  UNSERVED_SDKS,
  enrichModelsResponse,
  getLiveGoCatalog,
  getLiveZenCatalog,
  internalRouteFor,
  isGoModelsListingUrl,
  isModelsListingUrl,
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
import { UNSERVED_PLANE_SDKS } from "../src/responses-routes.ts";
import { createCaptureFetch, headerOf, SESSION_RE } from "./test-helpers.ts";

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.OPENCODE_SESSION_ID;
});

describe("OpenCode Model Catalog & Enrichment", () => {
  it("keeps a retained id fully described, not merely present", () => {
    // A free row is offered to a user, so it has to carry what a picker
    // renders. `beam-free` is the active free model both planes serve, so it
    // is the fixture here — and its metadata survives with it: context,
    // output cap, modalities and the thinking levels, because an id without
    // its fields is a row that cannot be priced or reasoned about.
    for (const catalog of [OPENCODE_ZEN_CATALOG, OPENCODE_GO_CATALOG]) {
      const spec = catalog.find((m) => m.id === "beam-free");
      expect(spec).toBeDefined();
      expect(spec?.context_window).toBeGreaterThan(0);
      expect(spec?.max_output_tokens).toBeGreaterThan(0);
      expect(spec?.input_modalities.length).toBeGreaterThan(0);
      expect(spec?.reasoning).toBe(true);
      expect(spec?.reasoning_options?.length).toBeGreaterThan(0);
      expect(spec?.name.length).toBeGreaterThan(0);
    }
  });

  it("derives retirement entirely from the registry, with no hand list", () => {
    // The parser drops every `status: "deprecated"` row and keeps everything
    // else; there is no hand-maintained set beside it. These three were the
    // last content of one, and each is deprecated in the registry itself.
    // `claude-sonnet-4` is deliberately absent: the registry does NOT flag it
    // while the gateway answers `400 Model is unavailable` — the probe in
    // `scripts/verify-catalog.ts` is the tripwire for that class, not a list.
    const deprecated = [
      "muse-spark-1.2-contributor-free",
      "cat-jam-free",
      "exo-free",
    ];
    for (const catalog of [OPENCODE_ZEN_CATALOG, OPENCODE_GO_CATALOG]) {
      const ids = new Set(catalog.map((m) => m.id));
      for (const id of deprecated) {
        expect(ids.has(id), `${id} resurrected in a plane's shim`).toBe(false);
      }
    }
    // Retirement is provider-scoped by the registry's own data, not by a rule
    // of ours: the paid `muse-spark-1.2-contributor` is absent from zen and
    // served on go.
    const zen = new Set(OPENCODE_ZEN_CATALOG.map((m) => m.id));
    const go = new Set(OPENCODE_GO_CATALOG.map((m) => m.id));
    expect(zen.has("muse-spark-1.2-contributor")).toBe(false);
    expect(go.has("muse-spark-1.2-contributor")).toBe(true);
  });

  it("ships only active, priced models in the bundled Go shim", () => {
    expect(OPENCODE_GO_CATALOG.length).toBe(28);
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
    // **The modern family's Go path.** The Go plane's base is the `inference`
    // family now, and that path carries no `/models` of its own — the gateway
    // answers 404 there and this enrichment is what fills it. Reading the plane
    // by substring put it in the ZEN bucket, and the Go plane was then answered
    // with the Zen catalog: every Zen model, and none of the Go plane's own.
    expect(
      isGoModelsListingUrl("https://opencode.ai/inference/go/openai/v1/models")
    ).toBe(true);
    expect(
      isGoModelsListingUrl("https://opencode.ai/inference/openai/v1/models")
    ).toBe(false);
    // And the Zen google family is not the Go plane, though it starts the same.
    expect(
      isGoModelsListingUrl("https://opencode.ai/inference/google/v1beta/models")
    ).toBe(false);
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
    expect(OPENCODE_ZEN_CATALOG.length).toBe(82);
    const freeModels = OPENCODE_ZEN_CATALOG.filter((m) => m.is_free === true);
    // Only the free tiers the registry still lists as active. The count is the
    // `is_free` flag the shim carries, NOT the `-free` suffix: `big-pickle` is
    // flagged and is not suffixed, so a suffix rule would have missed it.
    expect(freeModels.length).toBe(9);

    const ids = new Set(OPENCODE_ZEN_CATALOG.map((m) => m.id));
    expect(ids.has("beam-free")).toBe(true);
    expect(ids.has("beam-free")).toBe(true);
    expect(ids.has("mimo-v2.6-flash-free")).toBe(true);
    expect(ids.has("claude-sonnet-4-5")).toBe(true);
    expect(ids.has("gpt-5.4")).toBe(true);
    expect(ids.has("gemini-3.8-flash")).toBe(true);
    // Deprecated Zen free tiers must not reappear.
    expect(ids.has("qwen3.6-plus-free")).toBe(false);
    expect(ids.has("minimax-m3-free")).toBe(false);
    expect(ids.has("kimi-k2.5-free")).toBe(false);
    expect(ids.has("muse-spark-1.2-contributor-free")).toBe(false);
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
    expect(buckets.get("@ai-sdk/openai")?.length).toBe(31);
    expect(buckets.get("@ai-sdk/anthropic")?.length).toBe(17);

    // And each of those SDKs maps to a protocol this plugin actually serves, so
    // no carried model names a format with nowhere to go.
    for (const [npm, ids] of buckets) {
      const protocol = PROTOCOL_FOR_SDK[npm];
      if (protocol === undefined) {
        // `@ai-sdk/mistral` is the deliberate exception, and it is the only one:
        // `isServableSdk` keeps it out of every picker, so it is carried only to
        // be excluded on purpose rather than being absent by accident.
        // `@ai-sdk/google` used to be here too; it now maps to a protocol the
        // bridge serves, so it takes the branch below.
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
    expect(responses.length).toBe(33);
    expect(anthropic.length).toBe(20);
    expect(responses.filter((id) => anthropic.includes(id))).toEqual([]);
    // The flagship of each plane is on the shim, so a cold start can serve it.
    expect(responses).toContain("muse-spark-1.2");
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
    expect(modelsForSdk("@ai-sdk/openai", zen).length).toBe(31);
    expect(modelsForSdk("@ai-sdk/anthropic", zen).length).toBe(17);
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
    // **The catalog surface seeds, and that is correct here.** `discoverModels`
    // returns its installed catalog for a provider pi ships and only fetches an
    // endpoint for one it does not, so this listing is what the endpoint offers —
    // the surface a user browses, not the list a picker shows. The picker's own
    // path (`mergeDiscoveredModels`) still never widens.
    expect(json.data.length).toBe(OPENCODE_GO_CATALOG.length + 1);

    const deepseek = json.data.find((m) => m.id === "deepseek-v4.1-flash");
    expect(deepseek).toBeDefined();
    expect(deepseek?.name).toBe("DeepSeek V4.1 Flash");
    expect(deepseek?.context_window).toBe(1000000);

    const custom = json.data.find((m) => m.id === "custom-gateway-model");
    expect(custom).toBeDefined();
    expect(custom?.id).toBe("custom-gateway-model");

    // An empty answer is answered with the catalog that endpoint stands for: the
    // vendor's own listing is narrower than its catalog, and this is the surface
    // that says what exists.
    const zenResponse = await enrichModelsResponse(
      "https://opencode.ai/zen/v1/models",
      Response.json({ data: [], object: "list" })
    );
    const zenJson = (await zenResponse.json()) as {
      data: Array<{ id: string }>;
    };
    expect(zenJson.data.length).toBe(getLiveZenCatalog().length);
    expect(zenJson.data.some((m) => m.id === "beam-free")).toBe(true);
  });

  it("answers the modern Go listing with the Go catalog, not the Zen one", async () => {
    // **This is the bug the Go plane's endpoint change exposed.** The Go plane's
    // base is the `inference` family, and the adapter lists its models at
    // `${base}/models` — a path the gateway does not serve, so the answer comes
    // from here. The plane of that URL used to be read by substring, which knew
    // neither `/inference/go` nor the boundary that separates it from
    // `/inference/google`: the Go plane was answered with the ZEN catalog, and
    // its own models — the Gemini contributor, the Muse contributor — were not
    // in the answer at all.
    const goResponse = await enrichModelsResponse(
      "https://opencode.ai/inference/go/openai/v1/models",
      // What the gateway actually answers there: a 404's body.
      Response.json({ error: { message: "not found" } }, { status: 404 })
    );
    const goJson = (await goResponse.json()) as {
      data: Array<{ id: string }>;
    };
    // The GO catalog's own rows are in it…
    expect(goJson.data.some((m) => m.id === "gemini-4-argon-contributor")).toBe(
      true
    );
    expect(goJson.data.some((m) => m.id === "muse-spark-1.3-contributor")).toBe(
      true
    );
    // …and the Zen catalog's are not.
    expect(goJson.data.some((m) => m.id === "claude-opus-4-6")).toBe(false);
    expect(goJson.data.length).toBe(getLiveGoCatalog().length);
  });

  it("keeps the Muse 1.2 rows the zen plane actually serves", async () => {
    const goResponse = await enrichModelsResponse(
      "https://opencode.ai/zen/go/v1/models",
      Response.json({
        data: [
          { id: "beam-free", object: "model" },
          { id: "muse-spark-1.2-contributor", object: "model" },
        ],
        object: "list",
      })
    );
    const goJson = (await goResponse.json()) as {
      data: Array<{ id: string }>;
    };
    expect(goJson.data.some((m) => m.id === "beam-free")).toBe(true);
    expect(goJson.data.some((m) => m.id === "muse-spark-1.2-contributor")).toBe(
      true
    );

    const zenResponse = await enrichModelsResponse(
      "https://opencode.ai/zen/v1/models",
      Response.json({
        data: [
          { id: "beam-free", object: "model" },
          { id: "muse-spark-1.2", object: "model" },
          { id: "mimo-v2.6-flash-free", object: "model" },
        ],
        object: "list",
      })
    );
    const zenJson = (await zenResponse.json()) as {
      data: Array<{ id: string }>;
    };
    expect(zenJson.data.some((m) => m.id === "beam-free")).toBe(true);
    // Active catalog rows the gateway lists are kept: enrichment strips only
    // what the REGISTRY retired, and none of these carries that flag.
    expect(zenJson.data.some((m) => m.id === "muse-spark-1.2")).toBe(true);
    expect(zenJson.data.some((m) => m.id === "mimo-v2.6-flash-free")).toBe(
      true
    );
  });

  it("patchFetch transparently enriches GET .../models calls", async () => {
    const als = new AsyncLocalStorage<ActiveTurnState>();
    const mockFetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes("/models")) {
        return Response.json({
          data: [{ id: "deepseek-v4.1-flash", object: "model" }],
          object: "list",
        });
      }
      return new Response("OK", { status: 200 });
    });

    const patched = patchFetch(mockFetch, als, resolveConfig());
    const res = await patched("https://opencode.ai/zen/go/v1/models");
    expect(res.status).toBe(200);

    const json = (await res.json()) as {
      data: Array<{ id: string; name?: string; context_window?: number }>;
    };
    // The catalog, with the gateway's one row enriched inside it.
    expect(json.data.length).toBeGreaterThanOrEqual(OPENCODE_GO_CATALOG.length);
    const row = json.data.find((m) => m.id === "deepseek-v4.1-flash");
    expect(row?.name).toBe("DeepSeek V4.1 Flash");
    expect(row?.context_window).toBe(1_000_000);
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

  it("declares a distinct endpoint per wire family, per plane", () => {
    // The mount reads its base from this map, so the INVARIANT it depends on is
    // that the families are not one address: anthropic and google are served at
    // their own paths. Asserting the shape rather than the literals keeps a
    // vendor move a regeneration instead of a test edit.
    for (const plane of ["zen", "go"] as const) {
      const map = OPENCODE_FAMILY_API[plane];
      expect(map[""], plane).toBeTruthy();
      expect(map["@ai-sdk/anthropic"], plane).toBeTruthy();
      expect(map["@ai-sdk/google"], plane).toBeTruthy();
      expect(map["@ai-sdk/anthropic"], plane).not.toBe(map[""]);
      expect(map["@ai-sdk/google"], plane).not.toBe(map[""]);
    }
  });

  it("parseModelsDevCatalog handles malformed data gracefully", () => {
    // `api` and `familyApi` are carried alongside the arrays and are empty when
    // nothing declares them — not `undefined`, so callers never guard two shapes.
    const empty = {
      api: { go: "", zen: "" },
      familyApi: { go: {}, zen: {} },
      go: [],
      zen: [],
    };
    expect(parseModelsDevCatalog(null)).toEqual(empty);
    expect(parseModelsDevCatalog({})).toEqual(empty);
    expect(parseModelsDevCatalog({ "opencode-go": {} })).toEqual(empty);
    expect(
      parseModelsDevCatalog({ "opencode-go": { models: "invalid" } })
    ).toEqual(empty);
  });

  it("carries each model's thinking level, in all three shapes", () => {
    // models.dev describes the setting as `reasoning` plus `reasoning_options`,
    // and the three shapes it uses differ: effort with values, a token budget
    // with a minimum, and a plain toggle. The shim dropped both fields, so a
    // picker built from it could offer no thinking level for any model - 117 of
    // 122 Zen models declare one.
    const parsed = parseModelsDevCatalog({
      opencode: {
        models: {
          a: {
            id: "a",
            name: "A",
            reasoning: true,
            reasoning_options: [{ type: "effort", values: ["low", "high"] }],
          },
          b: {
            id: "b",
            name: "B",
            reasoning: true,
            reasoning_options: [{ type: "budget_tokens", min: 1024 }],
          },
          c: {
            id: "c",
            name: "C",
            reasoning: true,
            reasoning_options: [{ type: "toggle" }],
          },
          d: { id: "d", name: "D" },
          e: { id: "e", name: "E", reasoning_options: [{ nope: 1 }, "junk"] },
        },
      },
    });
    const byId = new Map(parsed.zen.map((m) => [m.id, m]));
    expect(byId.get("a")?.reasoning_options).toEqual([
      { type: "effort", values: ["low", "high"] },
    ]);
    expect(byId.get("b")?.reasoning_options).toEqual([
      { min: 1024, type: "budget_tokens" },
    ]);
    expect(byId.get("c")?.reasoning_options).toEqual([{ type: "toggle" }]);
    // A model that declares nothing carries nothing, rather than a default.
    expect(byId.get("d")?.reasoning).toBeUndefined();
    expect(byId.get("d")?.reasoning_options).toBeUndefined();
    // An option with no string `type` is dropped, not repaired.
    expect(byId.get("e")?.reasoning_options).toBeUndefined();
  });

  it("carries the endpoint each plane's provider declares", () => {
    // The client reads exactly this field (models-dev.ts:107 lifts
    // `item.api` into `settings.baseURL`), so the shim can carry the same value
    // instead of the mount hard-coding it.
    const parsed = parseModelsDevCatalog({
      opencode: { api: "https://opencode.ai/zen/v1", models: {} },
      "opencode-go": { api: "https://opencode.ai/zen/go/v1", models: {} },
    });
    expect(parsed.api).toEqual({
      go: "https://opencode.ai/zen/go/v1",
      zen: "https://opencode.ai/zen/v1",
    });
    // A provider with no `api` is empty rather than guessed.
    const bare = parseModelsDevCatalog({
      opencode: { models: {} },
      "opencode-go": { models: {} },
    });
    expect(bare.api).toEqual({ go: "", zen: "" });
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
    // Equal to the generated data: the shim was regenerated, so the retired ids
    // (`claude-sonnet-4`, and the three dead rows) are no longer IN it. Retirement
    // still filters at load; it just has nothing left to remove from this set.
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
          },
        },
      })
    );

    const updated = await refreshCatalog(
      mockFetch as unknown as typeof fetch,
      true
    );
    expect(updated.go.length).toBe(OPENCODE_GO_CATALOG.length + 1);
    // ONE zen row is new to the merged map: the mock's `future-zen-model`. Its
    // `muse-spark-1.2` row is already in the regenerated shim, so it is not an
    // addition. The parser's deprecation filter is the only filter, and the
    // mock carries none, so nothing else can change the count.
    expect(updated.zen.length).toBe(OPENCODE_ZEN_CATALOG.length + 1);

    const futureModel = updated.go.find((m) => m.id === "future-test-model");
    expect(futureModel).toBeDefined();
    expect(futureModel?.name).toBe("Future Test Model");
    expect(futureModel?.context_window).toBe(1500000);
    expect(updated.go.some((m) => m.id === "muse-spark-1.2-contributor")).toBe(
      true
    );
    expect(updated.zen.some((m) => m.id === "muse-spark-1.2")).toBe(true);
  });

  it("refreshes from the OpenCode registry host, not a third-party mirror", async () => {
    // Pinned because nothing else would notice a silent re-point: the two hosts
    // serve the SAME object today (identical ETag), so a wrong URL still returns
    // valid data — which is exactly why the assertion is on the request, not on
    // the answer.
    const seen: string[] = [];
    const recordingFetch = vi.fn((input: unknown) => {
      seen.push(String(input));
      return Promise.resolve({
        json: async () => ({ opencode: { models: {} } }),
        ok: true,
      });
    });

    await refreshCatalog(recordingFetch as unknown as typeof fetch, true);

    expect(seen).toHaveLength(1);
    expect(seen[0]).toBe("https://models.opencode.ai/api.json");
    expect(seen[0]).not.toContain("models.dev");
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

  it("resolves a model present only on Go through the plane-blind lookup", () => {
    // Provider scoping comes from the REGISTRY's data, not from a rule here:
    // the paid 1.2 contributor entry is absent from the zen plane and served
    // on go, and a plane-blind lookup finds it through go — which Go sessions
    // need for pricing a model the gateway still serves.
    const spec = findModelSpec("muse-spark-1.2-contributor");
    assert.ok(spec, "expected the Go shim to keep muse-spark-1.2-contributor");
    expect(spec.id).toBe("muse-spark-1.2-contributor");
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
/**
 * The README's routing table, asserted against the catalog it describes.
 *
 * A count written into prose does not regenerate with the data it counts, and
 * this file's history is the evidence: the table said 28 models named no SDK and
 * had no row for mistral at all, a regeneration after it was written. Nothing
 * failed, because nothing was checking - and a user reading the table would have
 * been told the wrong thing about the catalog they were choosing from.
 *
 * So the table is parsed and compared. When the catalog is regenerated with
 * different counts, this goes red and says which numbers to update, instead of
 * the prose drifting quietly out of date.
 */
describe("catalog · the README's routing table", () => {
  const readme = () =>
    readFile(new URL("../README.md", import.meta.url), "utf8");

  /** `| \`@ai-sdk/x\` | 12 | ... |` and `| _(absent)_ | 12 | ... |`, in order. */
  const documentedCounts = (text: string): Map<string, number> => {
    const counts = new Map<string, number>();
    for (const line of text.split("\n")) {
      const match = /^\|\s*(?:`([^`]+)`|_\(absent\)_)\s*\|\s*(\d+)\s*\|/u.exec(
        line
      );
      if (match !== null) {
        counts.set(match[1] ?? "(absent)", Number(match[2]));
      }
    }
    return counts;
  };

  it("matches the catalog it counts", async () => {
    const measured = new Map<string, number>();
    for (const model of Object.values(OPENCODE_ZEN_CATALOG)) {
      const sdk = model.provider_npm ?? "(absent)";
      measured.set(sdk, (measured.get(sdk) ?? 0) + 1);
    }

    // The table has to describe every SDK the catalog names - a row that is
    // missing is the failure the mistral row was.
    expect(documentedCounts(await readme())).toEqual(measured);
  });

  it("holds the protocol doc's table to the same catalog", async () => {
    // The same class of claim in a second document: "28 of 84" is a count
    // written into prose, and it drifts exactly the way the README's did. The
    // numbers are parsed rather than trusted, and the total has to match too.
    const text = await readFile(
      new URL("../docs/protocol-routing-and-merge.md", import.meta.url),
      "utf8"
    );
    const pairs = [...text.matchAll(/(\d+) of (\d+)/gu)].map((m) => [
      Number(m[1] ?? 0),
      Number(m[2] ?? 0),
    ]);
    const total = Object.keys(OPENCODE_ZEN_CATALOG).length;
    const measured = new Map<string, number>();
    for (const model of Object.values(OPENCODE_ZEN_CATALOG)) {
      const sdk = model.provider_npm ?? "(absent)";
      measured.set(sdk, (measured.get(sdk) ?? 0) + 1);
    }

    expect(pairs.length).toBeGreaterThan(0);
    for (const [count, of] of pairs) {
      expect(of, "a row states a total the catalog does not have").toBe(total);
      expect(
        [...measured.values()],
        `${count} of ${of} matches no SDK count`
      ).toContain(count);
    }
    // And the rows add up, so the table cannot disagree with itself.
    expect(pairs.reduce((sum, pair) => sum + (pair[0] ?? 0), 0)).toBe(total);
  });

  it("holds the prose totals to the catalog, in both languages", async () => {
    // The tables above are parsed; the totals in the sentences beside them were
    // not, and every count this repository has had to correct lived there - the
    // README said 84 for a catalog of 85, the plane table said 120 served where
    // 85 are, and the Chinese README carried both. A number in a sentence is the
    // easiest kind to forget and the one a reader trusts most, so it is parsed
    // too. The regex allows the emphasis markers the number is wrapped in.
    const zen = Object.keys(OPENCODE_ZEN_CATALOG).length;
    const go = Object.keys(OPENCODE_GO_CATALOG).length;
    for (const file of ["../README.md", "../README.zh-CN.md"]) {
      const text = await readFile(new URL(file, import.meta.url), "utf8");
      const stated = [
        ...text.matchAll(
          /(\d+)\*{0,2}\s*(?:active[^.]*models|个\*\*在用\*\*模型)/gu
        ),
      ].map((m) => Number(m[1] ?? 0));
      expect(
        stated.length,
        `${file} states the catalog total nowhere`
      ).toBeGreaterThan(0);
      for (const n of stated) {
        expect(n, `${file} states a Zen total the catalog does not have`).toBe(
          zen
        );
      }
    }
    // "85 served / 120 listed" and "32 served / 36 listed": the served half is
    // ours to assert, the listed half comes from models.dev and is not.
    const planes = await readFile(
      new URL("../docs/redirect-planes.md", import.meta.url),
      "utf8"
    );
    const served = [...planes.matchAll(/(\d+)\s*served\s*\//gu)].map((m) =>
      Number(m[1] ?? 0)
    );
    expect(served).toEqual([zen, go]);
  });

  it("holds the plane-by-plane table to both catalogs", async () => {
    // The third document with counts, and the one whose table is per plane:
    // every cell is a count, and every cell was stale when this was written.
    const text = await readFile(
      new URL("../docs/redirect-planes.md", import.meta.url),
      "utf8"
    );
    const counted = (catalog: readonly { provider_npm?: string }[]) => {
      const bySdk = new Map<string, number>();
      for (const model of Object.values(catalog)) {
        const sdk = model.provider_npm ?? "(none)";
        bySdk.set(sdk, (bySdk.get(sdk) ?? 0) + 1);
      }
      return bySdk;
    };
    const zen = counted(OPENCODE_ZEN_CATALOG);
    const go = counted(OPENCODE_GO_CATALOG);

    const rows: { go: number; sdk: string; zen: number }[] = [];
    for (const line of text.split("\n")) {
      const cells = line.split("|").map((cell) => cell.trim());
      // `| SDK | protocol | Zen | Go |` — five cells once split on the pipes.
      if (cells.length !== 6 || cells[1] === "" || cells[1] === ":--") {
        continue;
      }
      const sdk =
        cells[1] === "_(none)_"
          ? "(none)"
          : /^`([^`]+)`$/u.exec(cells[1] ?? "")?.[1];
      const zenCount = Number(cells[3]?.replaceAll("*", ""));
      const rawGo = cells[4]?.replaceAll("*", "") ?? "";
      const goCount = rawGo === "—" || rawGo === "-" ? 0 : Number(rawGo);
      if (
        sdk === undefined ||
        !Number.isFinite(zenCount) ||
        !Number.isFinite(goCount)
      ) {
        continue;
      }
      rows.push({ go: goCount, sdk, zen: zenCount });
    }

    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.zen, `${row.sdk} on Zen`).toBe(zen.get(row.sdk) ?? 0);
      expect(row.go, `${row.sdk} on Go`).toBe(go.get(row.sdk) ?? 0);
    }
    // Every SDK either plane names has a row, so a new one cannot be missed.
    expect(rows.map((row) => row.sdk).toSorted()).toEqual(
      [...new Set([...zen.keys(), ...go.keys()])].toSorted()
    );
  });

  it("states the same total it lists", async () => {
    const text = await readme();
    const total = /Counts are the \*\*(\d+)\*\*/u.exec(text);
    expect(total, "the README no longer states a total").not.toBeNull();
    expect(Number(total?.[1])).toBe(Object.keys(OPENCODE_ZEN_CATALOG).length);
    // And the rows add up to it, so the table cannot disagree with its own
    // sentence the way it did before this test existed.
    const sum = [...documentedCounts(text).values()].reduce((a, b) => a + b, 0);
    expect(sum).toBe(Number(total?.[1]));
  });
});

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

/**
 * INVARIANT I1 - every model the plugin offers is routable.
 *
 * The picker shows both planes' models. A model naming an SDK is served on that
 * SDK's protocol, so it needs a route on ITS OWN plane: the Go plane's base URL
 * is not Zen's, and a route carries exactly one of them. Checking the SDK alone
 * - which is what the servability check does - cannot see the difference, so
 * this walks (plane, SDK) pairs instead, and names every one that has no route.
 *
 * A knowingly unserved SDK is skipped: that is a decision (I5), not a gap.
 */
describe("catalog · plane and SDK coverage", () => {
  it("has a route for every (plane, SDK) pair the catalogs contain", () => {
    const gaps: string[] = [];
    const planes = [
      ["opencode", OPENCODE_ZEN_CATALOG],
      ["opencode-go", OPENCODE_GO_CATALOG],
    ] as const;
    for (const [plane, catalog] of planes) {
      for (const model of catalog) {
        const sdk = (model as { provider_npm?: string }).provider_npm;
        if (
          sdk === undefined ||
          UNSERVED_SDKS.has(sdk) ||
          UNSERVED_PLANE_SDKS.has(`${plane} + ${sdk}`)
        ) {
          continue;
        }
        if (internalRouteFor(plane, model.id, sdk) === undefined) {
          gaps.push(`${plane} + ${sdk}`);
        }
      }
    }
    expect([...new Set(gaps)].toSorted()).toEqual([]);
  });
});

/**
 * The plane is half of the routing decision. An SDK says which shape a model
 * needs; only the route the caller selected says which account and base URL
 * serve it - and a redirected call comes back with an internal route id, which
 * is not a plane, which is what stops the redirect recursing.
 */
describe("routing · the plane half of the decision", () => {
  it("sends the same SDK to a different route per plane", () => {
    expect(internalRouteFor("opencode", "gpt-5.4", "@ai-sdk/openai")).toBe(
      "opencode-responses"
    );
    expect(internalRouteFor("opencode-go", "grok-4.7", "@ai-sdk/openai")).toBe(
      "opencode-go-responses"
    );
    expect(
      internalRouteFor("opencode-go", "minimax-m3", "@ai-sdk/anthropic")
    ).toBe("opencode-go-anthropic");
  });

  it("refuses to redirect from anything that is not a plane", () => {
    // An internal route id is where a redirected call arrives from, so treating
    // it as a plane would loop.
    expect(
      internalRouteFor("opencode-responses", "gpt-5.4", "@ai-sdk/openai")
    ).toBeUndefined();
    expect(
      internalRouteFor("opencode-go-responses", "grok-4.7", "@ai-sdk/openai")
    ).toBeUndefined();
  });

  it("leaves a model with no protocol alone", () => {
    expect(
      internalRouteFor(
        "opencode-go",
        "gemini-4-argon-contributor",
        "@ai-sdk/google"
      )
    ).toBe("opencode-go-google");
    expect(internalRouteFor("opencode-go", "grok-4.7")).toBeUndefined();
  });
});

/**
 * The default format, which is the only thing the original route has to decide.
 *
 * A model that speaks the route's own protocol has no SDK of its own — the route's
 * `api` IS its protocol — so the call stays where the user configured it. That is
 * the whole of "handling the original opencode default format": there is nothing to
 * redirect, and nothing to hide. Everything the plugin adds lives around this case,
 * not in it.
 */
describe("routing · the default format stays where it is", () => {
  it("never redirects a model with no SDK of its own", () => {
    // `big-pickle` carries no `provider.npm`: completions is the default, and the
    // declared route already speaks it.
    expect(internalRouteFor("opencode", "big-pickle")).toBeUndefined();
    expect(internalRouteFor("opencode-go", "big-pickle")).toBeUndefined();
  });

  it("redirects an id-only family the catalog does not describe", () => {
    // A model nobody catalogued still cannot be sent as a chat completion when its
    // family fixes the protocol by name — the measured behaviour, not a guess.
    expect(internalRouteFor("opencode", "claude-unlisted-9")).toBe(
      "opencode-anthropic"
    );
    expect(internalRouteFor("opencode", "gemini-unlisted-9")).toBe(
      "opencode-google"
    );
  });

  it("leaves the route alone when the declared protocol is its own", () => {
    // The `modelRoutes` override reaches the decision, and a declaration equal to
    // the route's protocol means no move at all.
    expect(
      internalRouteFor(
        "opencode",
        "some-model",
        "@ai-sdk/anthropic",
        "openai-completions"
      )
    ).toBeUndefined();
  });
});
