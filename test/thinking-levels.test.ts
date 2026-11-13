/**
 * The test-side rule that names the catalog models the gateway serves by
 * Google thinking level (`test/support/thinking-levels.ts`), held to the
 * bundled catalog and to every effort shape the catalog uses.
 *
 * @module test/thinking-levels.test
 */
import { describe, expect, it } from "vitest";

import {
  type CatalogModelSpec,
  OPENCODE_GO_CATALOG,
  OPENCODE_ZEN_CATALOG,
} from "./support/src.ts";
import { usesCatalogThinkingLevels } from "./support/thinking-levels.ts";

const zen = (id: string): CatalogModelSpec => {
  const spec = OPENCODE_ZEN_CATALOG.find((model) => model.id === id);
  if (spec === undefined) {
    throw new Error(`no Zen spec ${id}`);
  }
  return spec;
};

const go = (id: string): CatalogModelSpec => {
  const spec = OPENCODE_GO_CATALOG.find((model) => model.id === id);
  if (spec === undefined) {
    throw new Error(`no Go spec ${id}`);
  }
  return spec;
};

describe("thinking-levels · usesCatalogThinkingLevels (which catalog models think in Google levels)", () => {
  const google = "@ai-sdk/google";
  const effort = (values: readonly string[]) => [{ type: "effort", values }];

  it("a Google model whose catalog efforts are all discrete levels thinks in levels", () => {
    // The live case: pi 1.1.0's own id pattern misses it, the catalog does not.
    expect(usesCatalogThinkingLevels(go("gemini-4-argon"))).toBe(true);
    expect(usesCatalogThinkingLevels(zen("gemini-3-flash"))).toBe(true);
    for (const values of [
      ["low", "medium", "high"],
      ["minimal", "low", "medium", "high"],
      ["high"],
      ["minimal"],
    ]) {
      expect(
        usesCatalogThinkingLevels({
          provider_npm: google,
          reasoning: true,
          reasoning_options: effort(values),
        }),
        values.join(",")
      ).toBe(true);
    }
  });

  it("a budget, a switch or any other effort shape does not", () => {
    for (const reasoning_options of [
      // A value outside Google's four levels.
      effort(["low", "high", "max"]),
      effort(["low", "medium", "high", "xhigh"]),
      effort(["none", "low", "high"]),
      effort(["off", "high"]),
      // No list at all, an empty one, or a switch.
      effort([]),
      [{ type: "effort" }],
      [{ type: "toggle" }],
      // A non-effort option holding level-named values, and the catalog's
      // own budget shapes on their own.
      [{ type: "budget", values: ["low"] }],
      [{ type: "budget_tokens" }],
      [{ min: 1024, type: "budget_tokens" }],
      [],
      undefined,
    ]) {
      expect(
        usesCatalogThinkingLevels({
          provider_npm: google,
          reasoning: true,
          ...(reasoning_options === undefined ? {} : { reasoning_options }),
        }),
        JSON.stringify(reasoning_options)
      ).toBe(false);
    }
    // The first effort list with values is the one read, as reasoningFor reads it.
    expect(
      usesCatalogThinkingLevels({
        provider_npm: google,
        reasoning: true,
        reasoning_options: [
          { type: "effort", values: [] },
          { type: "effort", values: ["low", "xhigh"] },
          { type: "effort", values: ["low"] },
        ],
      })
    ).toBe(false);
  });

  it("a budget_tokens option beside an all-levels effort list does not change the answer", () => {
    // The effort list decides: the catalog lists the levels as accepted, and
    // a budget as accepted too, so the level request stays valid. The budget
    // option is the catalog's own shape (`min` beside the type).
    const budgetTokens = { min: 1024, type: "budget_tokens" };
    expect(
      usesCatalogThinkingLevels({
        provider_npm: google,
        reasoning: true,
        reasoning_options: [...effort(["low", "high"]), budgetTokens],
      })
    ).toBe(true);
    expect(
      usesCatalogThinkingLevels({
        provider_npm: google,
        reasoning: true,
        reasoning_options: [
          { type: "budget_tokens" },
          ...effort(["low", "xhigh"]),
        ],
      })
    ).toBe(false);
  });

  it("a model that does not reason, or is not served on Google, does not", () => {
    for (const reasoning of [false, undefined]) {
      expect(
        usesCatalogThinkingLevels({
          provider_npm: google,
          ...(reasoning === undefined ? {} : { reasoning }),
          reasoning_options: effort(["low", "high"]),
        })
      ).toBe(false);
    }
    for (const provider_npm of [
      "@ai-sdk/anthropic",
      "@ai-sdk/openai",
      "@ai-sdk/mistral",
      "@ai-sdk/unknown",
      undefined,
    ]) {
      expect(
        usesCatalogThinkingLevels({
          ...(provider_npm === undefined ? {} : { provider_npm }),
          reasoning: true,
          reasoning_options: effort(["low", "medium", "high"]),
        }),
        String(provider_npm)
      ).toBe(false);
    }
  });

  it("over the bundled catalogs, every Google reasoning model and nothing else (today's catalogs)", () => {
    // An oracle that does not re-derive the rule: every Google reasoning entry
    // the vendor lists today offers only discrete levels, except the ones
    // named below. A future Google entry with a budget or an `xhigh` flips
    // this row on purpose, and lands here by name.
    //
    // gemini-4-hydrogen (Zen, #171) lists `xhigh`, outside Google's four
    // levels, beside low/medium/high.
    const notLevelOnly = new Map([["gemini-4-hydrogen", ["xhigh"]]]);
    for (const [id, outside] of notLevelOnly) {
      // Each exception is still a Google reasoning entry the catalog lists,
      // and its effort list still names the value that excludes it.
      const spec = zen(id);
      expect(spec.provider_npm, id).toBe(google);
      expect(spec.reasoning, id).toBe(true);
      const values =
        spec.reasoning_options?.find((option) => option.type === "effort")
          ?.values ?? [];
      expect(values, id).toEqual(expect.arrayContaining(outside));
    }
    const goLevelIds: string[] = [];
    let seen = 0;
    for (const spec of [...OPENCODE_GO_CATALOG, ...OPENCODE_ZEN_CATALOG]) {
      const expected =
        spec.provider_npm === google &&
        spec.reasoning === true &&
        !notLevelOnly.has(spec.id);
      seen += expected ? 1 : 0;
      expect(usesCatalogThinkingLevels(spec), spec.id).toBe(expected);
    }
    for (const spec of OPENCODE_GO_CATALOG) {
      if (usesCatalogThinkingLevels(spec)) {
        goLevelIds.push(spec.id);
      }
    }
    // The read is real: the catalogs hold the live case and more.
    expect(seen).toBeGreaterThan(1);
    expect(goLevelIds).toContain("gemini-4-argon");
  });
});
