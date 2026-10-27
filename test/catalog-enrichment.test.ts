/**
 * OpenCode Model Catalog: enriching a `/models` listing.
 *
 * @module test/catalog-enrichment.test
 */
import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";

import { describe, expect, it, vi } from "vitest";

import {
  type ActiveTurnState,
  OPENCODE_GO_CATALOG,
  OPENCODE_ZEN_CATALOG,
  SESSION_HEADER,
  enrichModelsResponse,
  getLiveGoCatalog,
  getLiveZenCatalog,
  isGoModelsListingUrl,
  isModelsListingUrl,
  patchFetch,
  resolveConfig,
} from "./support/src.ts";
import { createCaptureFetch, headerOf, SESSION_RE } from "./test-helpers.ts";

describe("catalog · enriching a /models listing", () => {
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

  it("enriches a truncated gateway models response with full catalog metadata", async () => {
    // Upstream gateway returned only 2 models, both missing name/context_window
    const [described] = OPENCODE_GO_CATALOG;
    assert.ok(described !== undefined, "the Go shim is empty");
    const rawGatewayPayload = {
      data: [
        { id: described.id, object: "model" },
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
    // the surface a user browses, not the list a picker shows. The picker lists
    // the plane profile's declared models (`planeProfileFor`, never widened);
    // Settings' fetch on a served plane is what offers the catalog
    // (`complementDiscoveredModels`).
    expect(json.data.length).toBe(OPENCODE_GO_CATALOG.length + 1);

    // The values are the shim row's own, read from the row they describe.
    const enriched = json.data.find((m) => m.id === described.id);
    expect(enriched).toBeDefined();
    expect(enriched?.name).toBe(described.name);
    expect(enriched?.context_window).toBe(described.context_window);

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
    expect(zenJson.data.map((m) => m.id)).toEqual(
      getLiveZenCatalog().map((m) => m.id)
    );
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
    // The ids only one plane serves, taken from the shim rather than named: a
    // refresh moves the names, not the rule.
    const zenIds = new Set(OPENCODE_ZEN_CATALOG.map((m) => m.id));
    const goIds = new Set(OPENCODE_GO_CATALOG.map((m) => m.id));
    const goOnly = [...goIds].filter((id) => !zenIds.has(id));
    const zenOnly = [...zenIds].filter((id) => !goIds.has(id));
    expect(goOnly.length).toBeGreaterThan(0);
    expect(zenOnly.length).toBeGreaterThan(0);
    const answered = new Set(goJson.data.map((m) => m.id));
    // The GO catalog's own rows are in it…
    for (const id of goOnly) {
      expect(answered.has(id), id).toBe(true);
    }
    // …and the Zen catalog's are not.
    for (const id of zenOnly) {
      expect(answered.has(id), id).toBe(false);
    }
    expect(goJson.data.length).toBe(getLiveGoCatalog().length);
    // The fill is the listing, so it answers as one.
    expect(goResponse.status).toBe(200);
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
    // Every row the gateway lists is kept and described, whatever the registry
    // says about it: enrichModelsResponse applies no retirement filter.
    // Retirement acts on the catalog SEED (parsing drops a `status:
    // "deprecated"` row) and on the discovery merge (isDeprecatedModelOn),
    // never on the gateway's own answer, so no refresh can drop these ids here.
    expect(zenJson.data.some((m) => m.id === "muse-spark-1.2")).toBe(true);
    expect(zenJson.data.some((m) => m.id === "mimo-v2.6-flash-free")).toBe(
      true
    );
  });

  it("patchFetch transparently enriches GET .../models calls", async () => {
    const als = new AsyncLocalStorage<ActiveTurnState>();
    const [described] = OPENCODE_GO_CATALOG;
    assert.ok(described !== undefined, "the Go shim is empty");
    const mockFetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes("/models")) {
        return Response.json({
          data: [{ id: described.id, object: "model" }],
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
    const row = json.data.find((m) => m.id === described.id);
    expect(row?.name).toBe(described.name);
    expect(row?.context_window).toBe(described.context_window);
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
});

describe("enrichModelsResponse: the gateway's verdict passes through", () => {
  const url = "https://opencode.ai/zen/v1/models";

  it("enrichModelsResponse: a 401, a 403, a 429 and a 5xx reach the caller as the gateway sent them", async () => {
    // A refused key, a refused tier and an outage are answers about the
    // REQUEST. Filling them with the catalog told discovery the listing had
    // succeeded, and the reason the gateway gave never reached anyone.
    const rows = [
      {
        body: JSON.stringify({ error: { message: "Missing API key" } }),
        status: 401,
        type: "application/json",
      },
      {
        body: JSON.stringify({ error: { type: "FreeTierError" } }),
        status: 403,
        type: "application/json",
      },
      // Not an auth answer and not an outage: the rule is "every non-2xx but
      // 404", and this row records that a rate limit is the gateway's too.
      {
        body: JSON.stringify({ error: { type: "RateLimitError" } }),
        headers: { "retry-after": "30" },
        status: 429,
        type: "application/json",
      },
      { body: "upstream down", status: 503, type: "text/plain" },
    ];
    for (const row of rows) {
      const extra: Record<string, string> =
        "headers" in row && row.headers !== undefined ? row.headers : {};
      const upstream = new Response(row.body, {
        headers: { "content-type": row.type, ...extra },
        status: row.status,
      });
      const out = await enrichModelsResponse(url, upstream);
      expect(out.status).toBe(row.status);
      expect(await out.text()).toBe(row.body);
      expect(out.headers.get("content-type")).toBe(row.type);
      for (const [name, value] of Object.entries(extra)) {
        expect(out.headers.get(name)).toBe(value);
      }
    }
  });

  it("fills a Zen-plane 404 with the Zen catalog, as it does the Go plane's", async () => {
    const out = await enrichModelsResponse(
      url,
      new Response("Not Found", { status: 404 })
    );
    expect(out.status).toBe(200);
    const body = (await out.json()) as { data: unknown[] };
    expect(body.data.length).toBe(getLiveZenCatalog().length);
  });

  it("still answers a 200 whose body is not JSON with the full catalog", async () => {
    const out = await enrichModelsResponse(
      url,
      new Response("not json", { status: 200 })
    );
    expect(out.status).toBe(200);
    const body = (await out.json()) as { data: unknown[] };
    expect(body.data.length).toBe(getLiveZenCatalog().length);
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
