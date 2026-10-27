/**
 * OpenCode Model Catalog: the bundled shim, as invariants.
 *
 * Every assertion here is a property of the generated shim — non-empty, unique
 * ids, the `is_free` rule the generator applies, a paid row on every protocol a
 * plane serves — never a count, which breaks on every vendor refresh by
 * construction. Retired ids stay named: absence does not break on a refresh.
 * A row a case needs is picked by its shape (a priced Go row, a free Zen
 * row), never by a vendor id a refresh can retire; the one case whose point
 * IS a named id skips, by name, once the catalog no longer carries it.
 * Its siblings: `catalog-enrichment` (the `/models` fill), `catalog-refresh`
 * (the live registry read), `catalog-docs` (the README's table) and
 * `catalog-routing` (protocol and plane coverage).
 *
 * @module test/catalog.test
 */
import assert from "node:assert/strict";

import { describe, expect, it } from "vitest";

import {
  OPENCODE_FAMILY_API,
  OPENCODE_GO_CATALOG,
  OPENCODE_ZEN_CATALOG,
  protocolForSdk,
  findModelSpec,
  isServableSdk,
  parseModelsDevCatalog,
  sanitizeModalities,
} from "./support/src.ts";

/** The paid id the registry retires on zen and keeps on go. */
const MUSE = "muse-spark-1.2-contributor";

/**
 * Every row of a plane's shim names a protocol the plane adapter serves, and
 * each protocol it serves has a paid row to serve, beside at least one free
 * row overall: the cold-start picker always offers both tiers.
 */
const expectServedOnEveryProtocol = (
  rows: readonly { id: string; is_free?: boolean; provider_npm?: string }[]
): void => {
  const served = new Set(rows.map((row) => protocolForSdk(row.provider_npm)));
  expect(served.has(undefined)).toBe(false);
  expect(served.size).toBeGreaterThan(0);
  for (const protocol of served) {
    expect(
      rows.some(
        (row) =>
          protocolForSdk(row.provider_npm) === protocol && row.is_free !== true
      ),
      `${String(protocol)} has a paid row`
    ).toBe(true);
  }
  expect(rows.some((row) => row.is_free === true)).toBe(true);
  expect(rows.some((row) => row.is_free !== true)).toBe(true);
};

describe("OpenCode model catalog · the bundled shim", () => {
  it("keeps every free row fully described, not merely present, and alike on both planes", () => {
    // A free row is offered to a user, so it has to carry what a picker
    // renders: context, output cap, modalities and a name, because an id
    // without its fields is a row that cannot be priced or reasoned about.
    // A free id both planes serve is described the same on each.
    const go = new Map(OPENCODE_GO_CATALOG.map((m) => [m.id, m]));
    for (const catalog of [OPENCODE_ZEN_CATALOG, OPENCODE_GO_CATALOG]) {
      const free = catalog.filter((m) => m.is_free === true);
      expect(free.length).toBeGreaterThan(0);
      for (const spec of free) {
        expect(spec.context_window, spec.id).toBeGreaterThan(0);
        expect(spec.max_output_tokens, spec.id).toBeGreaterThan(0);
        expect(spec.input_modalities.length, spec.id).toBeGreaterThan(0);
        expect(spec.name.length, spec.id).toBeGreaterThan(0);
      }
    }
    for (const zen of OPENCODE_ZEN_CATALOG.filter((m) => m.is_free === true)) {
      const twin = go.get(zen.id);
      if (twin !== undefined) {
        expect(twin.context_window, zen.id).toBe(zen.context_window);
        expect(twin.input_modalities, zen.id).toEqual(zen.input_modalities);
        expect(twin.reasoning, zen.id).toBe(zen.reasoning);
      }
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
  });

  it("scopes a retirement to the plane the registry retires it on", (context) => {
    // Retirement is provider-scoped by the registry's own data, not by a rule
    // of ours: the paid `muse-spark-1.2-contributor` is absent from zen and
    // served on go. The named id IS the point, so once go retires it too the
    // case has nothing to show, and says so rather than failing a refresh.
    const go = new Set(OPENCODE_GO_CATALOG.map((m) => m.id));
    if (!go.has(MUSE)) {
      context.skip(
        `${MUSE} left the Go shim: no provider-scoped retirement to show`
      );
    }
    const zen = new Set(OPENCODE_ZEN_CATALOG.map((m) => m.id));
    expect(zen.has(MUSE)).toBe(false);
    expect(findModelSpec(MUSE)?.id).toBe(MUSE);
  });

  it("ships only active, priced models in the bundled Go shim", () => {
    // Invariants, not counts: a count breaks on every vendor refresh by
    // construction, and says nothing a reader can act on when it does.
    expect(OPENCODE_GO_CATALOG.length).toBeGreaterThan(0);
    expect(new Set(OPENCODE_GO_CATALOG.map((m) => m.id)).size).toBe(
      OPENCODE_GO_CATALOG.length
    );
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

    expectServedOnEveryProtocol(OPENCODE_GO_CATALOG);
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

  it("ships active Zen free tiers and flagships in the bundled shim", () => {
    // The shim answers before the first live refresh, and a refresh merges by
    // replacing the whole set — so these counts are the cold-start picker, and a
    // silent drop here is a model nobody can pick. Regenerate with
    // `scripts/regenerate-catalog-shim.ts` rather than editing by hand.
    expect(OPENCODE_ZEN_CATALOG.length).toBeGreaterThan(0);
    expect(new Set(OPENCODE_ZEN_CATALOG.map((m) => m.id)).size).toBe(
      OPENCODE_ZEN_CATALOG.length
    );
    const freeModels = OPENCODE_ZEN_CATALOG.filter((m) => m.is_free === true);
    expect(freeModels.length).toBeGreaterThan(0);
    // The flag the shim carries is the generator's rule, exactly
    // (`parseModelsDevCatalog`): a `free` id OR a zero price. NOT the suffix
    // alone: `big-pickle` is flagged and is not suffixed.
    for (const model of OPENCODE_ZEN_CATALOG) {
      expect(model.is_free === true, model.id).toBe(
        model.id.includes("free") ||
          (model.cost?.input === 0 && model.cost.output === 0)
      );
    }
    expectServedOnEveryProtocol(OPENCODE_ZEN_CATALOG);

    const ids = new Set(OPENCODE_ZEN_CATALOG.map((m) => m.id));
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
    expect([...buckets.keys()]).toEqual(
      expect.arrayContaining(["@ai-sdk/openai", "@ai-sdk/anthropic"])
    );

    // And each of those SDKs maps to a protocol the plane adapter serves, so no
    // carried model names a format with nowhere to go. `@ai-sdk/mistral` is no
    // exception any more: pi's own data files it as completions (D16).
    for (const [npm, ids] of buckets) {
      expect(protocolForSdk(npm), npm).toBeDefined();
      expect(isServableSdk(npm), npm).toBe(true);
      expect(ids.length).toBeGreaterThan(0);
    }
    expect(protocolForSdk("@ai-sdk/mistral")).toBe("openai-completions");
  });

  it("serves every SDK-routed model on the protocol its SDK names", () => {
    // The end-to-end shape of the split, on cold-start data: the union of both
    // planes' models falls into disjoint protocol sets, and the flagship of
    // each is on the shim, so a cold start can serve it.
    const byProtocol = new Map<string, Set<string>>();
    for (const spec of [...OPENCODE_ZEN_CATALOG, ...OPENCODE_GO_CATALOG]) {
      const protocol = protocolForSdk(spec.provider_npm) ?? "unserved";
      byProtocol.set(
        protocol,
        (byProtocol.get(protocol) ?? new Set()).add(spec.id)
      );
    }
    expect(byProtocol.has("unserved")).toBe(false);
    const responses = [...(byProtocol.get("openai-responses") ?? [])];
    const anthropic = [...(byProtocol.get("anthropic-messages") ?? [])];
    expect(responses.length).toBeGreaterThan(0);
    expect(anthropic.length).toBeGreaterThan(0);
    expect(responses.filter((id) => anthropic.includes(id))).toEqual([]);
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
  // Rows are picked by shape from the shipped shim and the lookup must answer
  // that very row: a price or a context window the vendor changes moves both
  // sides together, so a refresh is never a test edit.
  it("resolves a priced Go model together with its pricing rate", () => {
    // The stream hook prices each turn through this lookup, so the rate must
    // ride along with the spec.
    const row = OPENCODE_GO_CATALOG.find((m) => (m.cost?.input ?? 0) > 0);
    assert.ok(row, "the Go shim carries no priced model");
    const spec = findModelSpec(row.id);
    expect(spec).toEqual(row);
    expect(spec?.cost?.input).toBeGreaterThan(0);
    expect(spec?.is_free).toBeUndefined();
  });

  it("resolves a free Zen model, marked free at an explicit zero rate", () => {
    // A Zen-only row, so the plane-blind lookup (Go first) lands on Zen.
    const go = new Set(OPENCODE_GO_CATALOG.map((m) => m.id));
    const row = OPENCODE_ZEN_CATALOG.find(
      (m) => m.is_free === true && !go.has(m.id)
    );
    assert.ok(row, "the Zen shim carries no free model of its own");
    const spec = findModelSpec(row.id);
    expect(spec).toEqual(row);
    expect(spec?.is_free).toBe(true);
    // A free model still carries an explicit zero rate, so the stream hook
    // prices it as $0 rather than falling back to "unknown model" handling.
    expect(spec?.cost?.input).toBe(0);
    expect(spec?.cost?.output).toBe(0);
  });

  it("resolves a model present only on Go through the plane-blind lookup", () => {
    // A plane-blind lookup finds a Go-only row through go — which Go sessions
    // need for pricing a model the gateway still serves.
    const zen = new Set(OPENCODE_ZEN_CATALOG.map((m) => m.id));
    const row = OPENCODE_GO_CATALOG.find((m) => !zen.has(m.id));
    assert.ok(row, "the Go shim carries no model of its own");
    expect(findModelSpec(row.id)).toEqual(row);
  });

  it("returns undefined for unknown or empty ids", () => {
    expect(findModelSpec("not-a-real-model")).toBeUndefined();
    expect(findModelSpec("")).toBeUndefined();
    // Case matters: model ids are exact.
    expect(findModelSpec("DeepSeek-V4.1-Flash")).toBeUndefined();
  });
});
