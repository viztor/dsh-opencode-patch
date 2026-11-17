/**
 * OpenCode Model Catalog: reading, refreshing and resetting the live catalog.
 *
 * @module test/catalog-refresh.test
 */
import { describe, expect, it, vi } from "vitest";

import { payload, registryOf, shippedShimData } from "./support/catalogs.ts";
import {
  OPENCODE_GO_CATALOG,
  OPENCODE_ZEN_CATALOG,
  catalogGeneration,
  catalogLastError,
  deprecatedIdsOf,
  findModelSpecOn,
  getLiveGoCatalog,
  getLiveZenCatalog,
  isDeprecatedModelOn,
  parseModelsDevCatalog,
  refreshCatalog,
  resetCatalogState,
  shippedDeprecatedIds,
} from "./support/src.ts";

/** A fetch answering one catalog payload, or a failure status. */
const answering = (body: unknown, status = 200): typeof fetch =>
  (async () =>
    status === 200
      ? Response.json(body)
      : new Response("no", { status })) as unknown as typeof fetch;

/** The ids one plane's live catalog holds, in its order. */
const liveIds = (plane: "go" | "zen"): string[] =>
  (plane === "go" ? getLiveGoCatalog : getLiveZenCatalog)(
    answering({}, 503)
  ).map((model) => model.id);

describe("catalog · the live registry read", () => {
  it("parseModelsDevCatalog handles malformed data gracefully", () => {
    // `api` and `familyApi` are carried alongside the arrays and are empty when
    // nothing declares them — not `undefined`, so callers never guard two shapes.
    const empty = {
      api: { go: "", zen: "" },
      deprecated: { go: [], zen: [] },
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

  it("getLiveGoCatalog and getLiveZenCatalog return local shims, and a refresh replaces a plane's rows: what the registry no longer lists is gone", async () => {
    expect(getLiveGoCatalog(answering({}, 503))).toHaveLength(
      OPENCODE_GO_CATALOG.length
    );
    expect(getLiveZenCatalog(answering({}, 503))).toHaveLength(
      OPENCODE_ZEN_CATALOG.length
    );
    const shimGo = OPENCODE_GO_CATALOG[0]?.id ?? "";
    expect(shimGo).not.toBe("");

    const result = await refreshCatalog(
      answering(
        payload({
          go: [{ id: "only-go", name: "Only Go" }],
          zen: [{ id: "only-zen" }],
        })
      ),
      true
    );

    // Replaced, not merged: the base answered the shim's length plus one.
    expect(liveIds("go")).toEqual(["only-go"]);
    expect(liveIds("zen")).toEqual(["only-zen"]);
    expect(findModelSpecOn("go", shimGo)).toBeUndefined();
    expect(result.go.map((model) => model.id)).toEqual(["only-go"]);
    expect(result.go[0]?.name).toBe("Only Go");
  });

  it("an id the registry retires leaves the live map on the refresh that retires it", async () => {
    const shipped = shippedShimData();
    const shimGo = OPENCODE_GO_CATALOG[0]?.id ?? "";
    expect(OPENCODE_GO_CATALOG.length).toBeGreaterThan(1);

    await refreshCatalog(
      answering(registryOf(shipped, { retire: { go: [shimGo] } })),
      true
    );

    expect(findModelSpecOn("go", shimGo)).toBeUndefined();
    expect(isDeprecatedModelOn("go", shimGo)).toBe(true);
    for (const row of OPENCODE_GO_CATALOG.slice(1)) {
      expect(findModelSpecOn("go", row.id), row.id).toBeDefined();
    }
  });

  it("a parse moves nothing: the live retirements survive parsing another payload", async () => {
    await refreshCatalog(
      answering({
        opencode: {
          models: { gone: { status: "deprecated" }, keep: { name: "K" } },
        },
      }),
      true
    );
    expect(isDeprecatedModelOn("zen", "gone")).toBe(true);
    const generation = catalogGeneration();

    parseModelsDevCatalog({ opencode: { models: { other: { name: "O" } } } });
    parseModelsDevCatalog({});

    expect(isDeprecatedModelOn("zen", "gone")).toBe(true);
    expect(findModelSpecOn("zen", "other")).toBeUndefined();
    expect(catalogGeneration()).toBe(generation);
  });

  it("the parse answers the retired ids it read, per plane, sorted", () => {
    const parsed = parseModelsDevCatalog({
      opencode: {
        models: {
          b: { status: "deprecated" },
          live: { name: "Live" },
          a: { status: "deprecated" },
        },
      },
      "opencode-go": {
        models: { z: { status: "deprecated" }, live: { name: "Live" } },
      },
    });
    expect(parsed.deprecated).toEqual({ go: ["z"], zen: ["a", "b"] });
    for (const data of [null, {}, { "opencode-go": { models: "invalid" } }]) {
      expect(parseModelsDevCatalog(data).deprecated).toEqual({
        go: [],
        zen: [],
      });
    }
  });

  it("L12: a failed or empty read replaces nothing, and a partial one replaces only the plane it carries", async () => {
    const worldA = {
      opencode: {
        models: { za: { name: "ZA" }, zr: { status: "deprecated" } },
      },
      "opencode-go": {
        models: { ga: { name: "GA" }, gr: { status: "deprecated" } },
      },
    };
    const landed = await refreshCatalog(answering(worldA), true);
    expect(landed.ok).toBe(true);

    const NO_ACTIVE = "the registry's answer listed no active model";
    const failing: [string, typeof fetch, string | undefined][] = [
      [
        "a rejecting fetch",
        (async () => {
          throw new Error("offline");
        }) as unknown as typeof fetch,
        "offline",
      ],
      ["a 503", answering({}, 503), "models.opencode.ai answered 503"],
      [
        "a body that is not JSON",
        (async () => new Response("not json")) as unknown as typeof fetch,
        undefined,
      ],
      ["an empty registry", answering({}), NO_ACTIVE],
      [
        "a registry of retired rows only",
        answering({ opencode: { models: { x: { status: "deprecated" } } } }),
        NO_ACTIVE,
      ],
    ];
    for (const [label, fetchFn, message] of failing) {
      const generation = catalogGeneration();
      const result = await refreshCatalog(fetchFn, true);
      expect(result.ok, label).toBe(false);
      expect(liveIds("go"), label).toEqual(["ga"]);
      expect(liveIds("zen"), label).toEqual(["za"]);
      expect(isDeprecatedModelOn("zen", "zr"), label).toBe(true);
      expect(isDeprecatedModelOn("zen", "x"), label).toBe(false);
      expect(catalogGeneration(), label).toBe(generation);
      expect(result.deprecated, label).toEqual({ go: ["gr"], zen: ["zr"] });
      if (message === undefined) {
        // The JSON parser's own wording, which the engine owns.
        expect(catalogLastError(), label).toBeDefined();
        expect(catalogLastError(), label).not.toBe(NO_ACTIVE);
      } else {
        expect(catalogLastError(), label).toBe(message);
      }
    }

    const partial = await refreshCatalog(
      answering({ opencode: { models: { zb: { name: "B" } } } }),
      true
    );
    expect(partial.ok).toBe(true);
    expect(liveIds("zen")).toEqual(["zb"]);
    expect(isDeprecatedModelOn("zen", "zr")).toBe(false);
    expect(liveIds("go")).toEqual(["ga"]);
    // Zen's retirements from the payload (none), Go's held from world A.
    expect(partial.deprecated).toEqual({ go: ["gr"], zen: [] });
    expect(catalogLastError()).toBe(
      "the registry listed no active model for opencode-go"
    );
  });

  it("the refresh resolves { ok, deprecated } and keeps its last error with the state", async () => {
    const full = await refreshCatalog(
      answering({
        opencode: {
          models: {
            live: { name: "L" },
            zb: { status: "deprecated" },
            za: { status: "deprecated" },
          },
        },
        "opencode-go": {
          models: { g: { name: "G" }, gr: { status: "deprecated" } },
        },
      }),
      true
    );
    expect(full.ok).toBe(true);
    expect(full.deprecated).toEqual({ go: ["gr"], zen: ["za", "zb"] });
    expect(catalogLastError()).toBeUndefined();

    await refreshCatalog(
      (async () => {
        throw new Error("offline");
      }) as unknown as typeof fetch,
      true
    );
    expect(catalogLastError()).toContain("offline");

    await refreshCatalog(answering({}, 503), true);
    expect(catalogLastError()).toContain("503");

    await refreshCatalog(
      (async () => {
        throw new Error("x".repeat(500));
      }) as unknown as typeof fetch,
      true
    );
    expect(catalogLastError()).toBe("x".repeat(200));

    await refreshCatalog(
      answering(payload({ go: [{ id: "g" }], zen: [{ id: "z" }] })),
      true
    );
    expect(catalogLastError()).toBeUndefined();

    await refreshCatalog(answering({}, 503), true);
    expect(catalogLastError()).toBeDefined();
    resetCatalogState();
    expect(catalogLastError()).toBeUndefined();
  });

  it("a refresh inside the TTL answers the state it holds without a read, and a thrown non-Error is named", async () => {
    await refreshCatalog(
      answering(payload({ go: [{ id: "g" }], zen: [{ id: "z" }] })),
      true
    );
    const unread = vi.fn(answering({}, 503));
    const cached = await refreshCatalog(unread);
    expect(unread).not.toHaveBeenCalled();
    // Read nothing, and still `ok`: the state it reports is a landed read's
    // (the field's doc says so). The purge never sees this answer: it forces.
    expect(cached.ok).toBe(true);
    expect(cached.go.map((model) => model.id)).toEqual(["g"]);

    await refreshCatalog(
      (async () => {
        // oxlint-disable-next-line no-throw-literal, typescript/only-throw-error -- the case is a fetch that throws something other than an Error.
        throw "refused";
      }) as unknown as typeof fetch,
      true
    );
    expect(catalogLastError()).toBe("refused");
  });

  it("an older attempt that fails after a newer forced one landed leaves no error behind", async () => {
    // A background read on a cold start, slow and then failing...
    let fail: (error: Error) => void = () => {};
    const slow = (() =>
      new Promise<Response>((_resolve, reject) => {
        fail = reject;
      })) as unknown as typeof fetch;
    const background = refreshCatalog(slow);
    // ...overtaken by the purge's forced read, which lands both planes.
    const forced = await refreshCatalog(
      answering(payload({ go: [{ id: "g" }], zen: [{ id: "z" }] })),
      true
    );
    expect(forced.ok).toBe(true);
    expect(catalogLastError()).toBeUndefined();

    fail(new Error("timed out"));
    const late = await background;

    expect(late.ok).toBe(false);
    expect(catalogLastError()).toBeUndefined();
    expect(liveIds("go")).toEqual(["g"]);
  });

  it("an older attempt that settles first leaves the newer one in flight, and a plain call joins it", async () => {
    // A cold start (nothing landed, so no TTL answer): a background read and
    // the purge's forced read, both still pending.
    let fail: (error: Error) => void = () => {};
    const olderFetch = (() =>
      new Promise<Response>((_resolve, reject) => {
        fail = reject;
      })) as unknown as typeof fetch;
    let land: (response: Response) => void = () => {};
    const newerFetch = (() =>
      new Promise<Response>((resolve) => {
        land = resolve;
      })) as unknown as typeof fetch;
    const older = refreshCatalog(olderFetch);
    const forced = refreshCatalog(newerFetch, true);

    // The older one settles first. It is not the newest, so it must not
    // clear the in-flight promise the forced attempt owns.
    fail(new Error("timed out"));
    const settledOlder = await older;
    expect(settledOlder.ok).toBe(false);

    const unread = vi.fn(answering({}, 503));
    const joined = refreshCatalog(unread);
    expect(joined).toBe(forced);
    expect(unread).not.toHaveBeenCalled();

    land(Response.json(payload({ go: [{ id: "g" }], zen: [{ id: "z" }] })));
    const settledJoined = await joined;
    expect(settledJoined.ok).toBe(true);
    expect(unread).not.toHaveBeenCalled();
  });

  it("an older attempt that lands both planes after a newer failure clears the error", async () => {
    let land: (response: Response) => void = () => {};
    const slow = (() =>
      new Promise<Response>((resolve) => {
        land = resolve;
      })) as unknown as typeof fetch;
    const older = refreshCatalog(slow);
    await refreshCatalog(answering({}, 503), true);
    expect(catalogLastError()).toBe("models.opencode.ai answered 503");
    land(Response.json(payload({ go: [{ id: "g" }], zen: [{ id: "z" }] })));
    const settled = await older;
    expect(settled.ok).toBe(true);
    // The state is now wholly that payload's, so the card must not say the
    // last refresh failed beside it.
    expect(liveIds("go")).toEqual(["g"]);
    expect(catalogLastError()).toBeUndefined();
  });

  it("an older attempt that lands one plane after a newer failure leaves the newer error", async () => {
    let land: (response: Response) => void = () => {};
    const slow = (() =>
      new Promise<Response>((resolve) => {
        land = resolve;
      })) as unknown as typeof fetch;
    const older = refreshCatalog(slow);
    await refreshCatalog(answering({}, 503), true);
    land(Response.json(payload({ go: [{ id: "g" }] })));
    const settled = await older;
    expect(settled.ok).toBe(true);
    // A partial landing writes no error of its own unless it is the newest,
    // and it does not clear the newer one: Zen is still not the registry's.
    expect(catalogLastError()).toBe("models.opencode.ai answered 503");
  });

  it("the state starts from the shim's own retirements, read tolerantly", () => {
    for (const value of [undefined, "x", { go: "x" }]) {
      expect(deprecatedIdsOf(value)).toEqual({ go: [], zen: [] });
    }
    expect(deprecatedIdsOf({ go: ["b", 1, "a"], zen: ["z"] })).toEqual({
      go: ["a", "b"],
      zen: ["z"],
    });
    resetCatalogState();
    // Over the shipped shim's own ids, which are none until it is regenerated
    // with its retired ids: `purge-service`'s "a shim that carries retired
    // ids…" plants the export and performs the seeding either way.
    const shipped = shippedDeprecatedIds();
    for (const plane of ["go", "zen"] as const) {
      for (const id of shipped[plane]) {
        expect(isDeprecatedModelOn(plane, id), `${plane}: ${id}`).toBe(true);
      }
    }
    for (const row of OPENCODE_GO_CATALOG) {
      expect(isDeprecatedModelOn("go", row.id), row.id).toBe(false);
    }
    for (const row of OPENCODE_ZEN_CATALOG) {
      expect(isDeprecatedModelOn("zen", row.id), row.id).toBe(false);
    }
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
