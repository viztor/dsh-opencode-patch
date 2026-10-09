/**
 * `config-values.ts` — the coercion readers shared by the host config resolver
 * and the client card, so both agree on "absent or invalid means default".
 *
 * These are asserted directly because the two callers see different raw shapes:
 * the host reads row YAML (possibly carrying schemastery volatile `.get()`
 * nodes) while the client reads the schema-resolved snapshot.
 */

import { describe, expect, it } from "vitest";

import {
  ALL_MODELS_MARKER,
  DEFAULT_PROVIDERS,
  readBoolean,
  readString,
  readStringList,
  unwrapNode,
} from "../src/config-values.ts";

/** A value that is genuinely absent, without writing the `undefined` literal. */
const ABSENT: unknown = undefined;

/** A schemastery volatile `.get()` node, as the host row carries it. */
const node = (value: unknown) => ({
  get: () => value,
});

describe("config-values: shared defaults", () => {
  it("exposes the marker and defaults both sides read", () => {
    expect(ALL_MODELS_MARKER).toBe("*");
    expect(DEFAULT_PROVIDERS).toEqual([
      "opencode",
      "opencode-go",
      "opencode-responses",
      "opencode-anthropic",
    ]);
  });
});

describe("config-values: unwrapNode", () => {
  it("is idempotent for plain values", () => {
    expect(unwrapNode("text")).toBe("text");
    expect(unwrapNode(7)).toBe(7);
    expect(unwrapNode(true)).toBe(true);
    expect(unwrapNode(null)).toBeNull();
    expect(unwrapNode(ABSENT)).toBeUndefined();
  });

  it("unwraps a callable get() node", () => {
    expect(unwrapNode(node("inner"))).toBe("inner");
    expect(unwrapNode(node(["a", "b"]))).toEqual(["a", "b"]);
  });

  it("leaves an object whose get is not callable untouched", () => {
    const notANode = { get: "not-callable" };
    expect(unwrapNode(notANode)).toBe(notANode);
    // An array is not a node even if it somehow carried `get`.
    expect(unwrapNode([])).toEqual([]);
  });
});

describe("config-values: readBoolean", () => {
  it("takes an explicit boolean", () => {
    expect(readBoolean(true, false)).toBe(true);
    expect(readBoolean(false, true)).toBe(false);
  });

  it("inherits the fallback for anything that is not a boolean", () => {
    // Junk must not silently toggle the feature off (or on).
    expect(readBoolean("true", false)).toBe(false);
    expect(readBoolean("false", true)).toBe(true);
    expect(readBoolean(1, true)).toBe(true);
    expect(readBoolean(null, true)).toBe(true);
    expect(readBoolean(ABSENT, false)).toBe(false);
    expect(readBoolean([], true)).toBe(true);
    expect(readBoolean({}, false)).toBe(false);
  });

  it("unwraps a volatile node before deciding", () => {
    expect(readBoolean(node(true), false)).toBe(true);
    expect(readBoolean(node(false), true)).toBe(false);
    expect(readBoolean(node("nope"), true)).toBe(true);
  });
});

describe("config-values: readString", () => {
  it("returns a trimmed string", () => {
    expect(readString("  opencode/1.0  ")).toBe("opencode/1.0");
  });

  it("returns undefined for absent or blank values", () => {
    expect(readString("")).toBeUndefined();
    expect(readString("   ")).toBeUndefined();
    expect(readString(ABSENT)).toBeUndefined();
    expect(readString(null)).toBeUndefined();
    expect(readString(42)).toBeUndefined();
    expect(readString({})).toBeUndefined();
    expect(readString([])).toBeUndefined();
  });

  it("unwraps a volatile node before trimming", () => {
    expect(readString(node("  cli "))).toBe("cli");
    expect(readString(node("  "))).toBeUndefined();
    expect(readString(node(5))).toBeUndefined();
  });
});

describe("config-values: readStringList", () => {
  it("keeps the valid entries, trimmed, in order", () => {
    expect(readStringList(["a", " b ", "c"])).toEqual(["a", "b", "c"]);
  });

  it("drops blanks and non-strings instead of failing", () => {
    expect(
      readStringList(["a", "", "   ", 1, null, undefined, {}, [], "b"])
    ).toEqual(["a", "b"]);
  });

  it("returns an empty list when the value is not an array", () => {
    expect(readStringList(ABSENT)).toEqual([]);
    expect(readStringList(null)).toEqual([]);
    expect(readStringList("opencode-go")).toEqual([]);
    expect(readStringList({})).toEqual([]);
    expect(readStringList(5)).toEqual([]);
  });

  it("returns an empty list for an array with no usable entry", () => {
    expect(readStringList([])).toEqual([]);
    expect(readStringList(["", "  ", 3])).toEqual([]);
  });

  it("unwraps a volatile node before reading the list", () => {
    expect(readStringList(node(["opencode-go", " opencode "]))).toEqual([
      "opencode-go",
      "opencode",
    ]);
    expect(readStringList(node("not-a-list"))).toEqual([]);
  });
});
