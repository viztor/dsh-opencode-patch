/**
 * The settings page: the field register and each field's spec.
 *
 * @module test/settings-page-fields.test
 */
import assert from "node:assert/strict";

import { describe, expect, it } from "vitest";

import {
  CARD_FIELDS,
  Config,
  CONFIG_ONLY_FIELDS,
  SPECS,
} from "./support/src.ts";

describe("settings-page: field register", () => {
  it("derives SPECS from CARD_FIELDS in the same order", () => {
    expect(SPECS.map((s) => s.field)).toEqual(CARD_FIELDS.map((f) => f.field));
  });

  it("gives every register entry a usable draft conversion", () => {
    for (const entry of CARD_FIELDS) {
      const spec = SPECS.find((s) => s.field === entry.field);
      assert.ok(spec, `expected a spec for ${entry.field}`);
      expect(typeof spec.format).toBe("function");
      expect(typeof spec.parse).toBe("function");
    }
  });

  it("declares each field at most once", () => {
    const fields = CARD_FIELDS.map((entry) => entry.field);
    expect(new Set(fields).size).toBe(fields.length);
  });
});

describe("settings-page: field specs", () => {
  const specOf = (field: string) => {
    const found = SPECS.find((s) => s.field === field);
    assert.ok(found, `expected a spec for ${field}`);
    return found;
  };

  it("covers every field the card renders, in render order", () => {
    expect(SPECS.map((s) => s.field)).toEqual([
      "endpoint",
      "keySource",
      "readOpencodeStore",
      "injectUserAgent",
      "injectOriginHeaders",
      "injectProject",
      "enrichModels",
      "injectCoreTools",
      "usageEnabled",
    ]);
  });

  it("partitions the schema into card fields and config-only knobs", () => {
    // The card deliberately hides the override knobs, so the two lists must
    // together cover every schema key exactly once. A knob in neither would be
    // unreachable; a knob in both would contradict CONFIG_ONLY_FIELDS.
    //
    // The keys come from `Config.dict`, the schema's own field table.
    // `Config({})` materialises only the keys that carry a default or are
    // `.volatile()`, which is how `debugFile` (neither) went missing from both
    // lists without this test noticing.
    // oxlint-disable-next-line unicorn/no-array-sort -- `Object.keys` returns a fresh array, so in-place sort mutates nothing shared.
    const schemaKeys = Object.keys(Config.dict ?? {}).sort();
    expect(schemaKeys).toContain("debugFile");
    const cardFields = CARD_FIELDS.map((entry) => entry.field);
    const configOnly = CONFIG_ONLY_FIELDS.map((entry) => entry.field);
    const covered = [...cardFields, ...configOnly];

    // oxlint-disable-next-line unicorn/no-array-sort -- the spread above is a fresh array, so nothing shared is mutated.
    expect(covered.sort()).toEqual(schemaKeys);
    expect(new Set(covered).size).toBe(covered.length);
    for (const entry of CONFIG_ONLY_FIELDS) {
      expect(entry.reason.length).toBeGreaterThan(0);
    }
  });

  it("keeps each group's fields contiguous", () => {
    // The card inserts a heading wherever the group changes, so a field whose
    // group is not adjacent to its siblings would render the heading twice.
    const seen = new Set<string>();
    let previous: string | undefined;
    for (const entry of CARD_FIELDS) {
      if (entry.group !== previous) {
        expect(
          seen.has(entry.group),
          `${entry.field} reopens group ${entry.group} after it closed`
        ).toBe(false);
        seen.add(entry.group);
        previous = entry.group;
      }
    }
    expect(seen.size).toBeGreaterThan(1);
  });

  it("keeps the boolean kind on its stock semantics", () => {
    const inject = specOf("injectCoreTools");
    expect(inject.format(true)).toBe("true");
    expect(inject.format("not-a-boolean")).toBe("");
    expect(inject.parse("TRUE")).toEqual({ kind: "set", value: true });
    expect(inject.parse("")).toEqual({ kind: "clear" });
    expect(inject.parse("maybe")).toBeUndefined();
  });

  it("refuses a select draft outside the option set", () => {
    // The enum is the card's only non-boolean kind, so its conversion is the one
    // that must reject a value the schema would not accept.
    const source = specOf("keySource");
    expect(source.format("request")).toBe("request");
    expect(source.format(42)).toBe("");
    expect(source.parse("configured")).toEqual({
      kind: "set",
      value: "configured",
    });
    expect(source.parse("")).toEqual({ kind: "clear" });
    expect(source.parse("hand-edited")).toBeUndefined();
  });
});
