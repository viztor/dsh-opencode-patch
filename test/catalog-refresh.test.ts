/**
 * OpenCode Model Catalog: reading, refreshing and resetting the live catalog.
 *
 * @module test/catalog-refresh.test
 */
import { describe, expect, it, vi } from "vitest";

import {
  OPENCODE_GO_CATALOG,
  OPENCODE_ZEN_CATALOG,
  getLiveGoCatalog,
  getLiveZenCatalog,
  parseModelsDevCatalog,
  refreshCatalog,
  resetCatalogState,
} from "./support/src.ts";

describe("catalog · the live registry read", () => {
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

  it("resetCatalogState puts a refreshed catalog back to the bundled shim", async () => {
    // The per-test reset in `test/support/` relies on this, and a reset that
    // restored nothing would let every catalog count depend on run order again.
    await refreshCatalog(
      (async () =>
        Response.json({
          "opencode-go": {
            models: { "reset-probe-model": { name: "Reset Probe" } },
          },
        })) as unknown as typeof fetch,
      true
    );
    expect(getLiveGoCatalog().some((m) => m.id === "reset-probe-model")).toBe(
      true
    );
    resetCatalogState();
    expect(getLiveGoCatalog().some((m) => m.id === "reset-probe-model")).toBe(
      false
    );
    expect(getLiveGoCatalog()).toHaveLength(OPENCODE_GO_CATALOG.length);
    expect(getLiveZenCatalog()).toHaveLength(OPENCODE_ZEN_CATALOG.length);
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
});
