/**
 * `utils/credential-policy.ts` — the credential rules every decider shares.
 *
 * Pure, so every rule is asserted by calling it: the one placeholder filter,
 * the fill's and the meter's orders, the lazy step walk, the capture gate and
 * L8's strike count. The performing cases — the fill and the meter applying
 * the filter at their exits — are in `fetch-patch.test.ts` and
 * `go-discovery-store.test.ts`; the parity across deciders is
 * `credential-parity.test.ts`.
 *
 * @module test/credential-policy.test
 */
import { describe, expect, it, vi } from "vitest";

import {
  countsAsRefusal,
  EVICT_AFTER,
  FILL_ORDER,
  firstUsable,
  firstUsableAsync,
  isPlaceholderApiKey,
  KEY_SOURCE_POLICIES,
  mayCapture,
  METER_ORDER,
  needsFill,
  PLACEHOLDER_API_KEYS,
  strike,
  usableKey,
} from "./support/src.ts";

describe("credential policy · the one placeholder filter", () => {
  it.each([
    ["undefined", undefined],
    ["an empty string", ""],
    ["whitespace", "   "],
    ["the adapter's placeholder", "unused"],
    ["the gateway's keyless sentinel, padded and cased", " Public "],
    ["null", "null"],
    ["none", "none"],
    ["the string undefined", "undefined"],
    ["a non-string", 42],
    ["an object", { key: "k" }],
  ])("%s is no credential", (_label, value) => {
    expect(usableKey(value)).toBeUndefined();
  });

  it("answers a real key, trimmed", () => {
    expect(usableKey(" k ")).toBe("k");
    expect(usableKey("oc_sk_real")).toBe("oc_sk_real");
  });

  it("names the five placeholders, matched case-insensitively and trimmed", () => {
    expect([...PLACEHOLDER_API_KEYS].toSorted()).toEqual([
      "none",
      "null",
      "public",
      "undefined",
      "unused",
    ]);
    expect(isPlaceholderApiKey("  UNUSED  ")).toBe(true);
    expect(isPlaceholderApiKey("sk-real")).toBe(false);
  });

  it("asks for the fill only when the wire key is no credential", () => {
    expect(needsFill(undefined)).toBe(true);
    expect(needsFill("")).toBe(true);
    expect(needsFill("unused")).toBe(true);
    expect(needsFill("  ")).toBe(true);
    expect(needsFill("sk-real")).toBe(false);
  });
});

describe("credential policy · the orders", () => {
  it("restates the three policies config-values declares, in any order", () => {
    expect(Object.keys(FILL_ORDER).toSorted()).toEqual(
      [...KEY_SOURCE_POLICIES].toSorted()
    );
    expect(Object.keys(METER_ORDER).toSorted()).toEqual(
      [...KEY_SOURCE_POLICIES].toSorted()
    );
  });

  it("the fill: the request, a captured key unless configured, the declared variable, the store last", () => {
    expect(FILL_ORDER).toEqual({
      auto: ["request", "captured", "declared", "store"],
      configured: ["request", "declared", "store"],
      request: ["request", "captured", "declared", "store"],
    });
  });

  it("the meter: the original precedence under auto, the store last in all three", () => {
    expect(METER_ORDER).toEqual({
      auto: [
        "literal",
        "captured",
        "configured",
        "capturedAny",
        "opencodeStore",
      ],
      configured: [
        "literal",
        "configured",
        "captured",
        "capturedAny",
        "opencodeStore",
      ],
      request: [
        "captured",
        "capturedAny",
        "literal",
        "configured",
        "opencodeStore",
      ],
    });
  });
});

describe("credential policy · the step walk", () => {
  it("answers the first usable step, filtered once at the exit, and reads no later one", () => {
    const later = vi.fn(() => "later");
    expect(
      firstUsable(["a", "b", "c"] as const, {
        a: () => "unused",
        b: () => " key ",
        c: later,
      })
    ).toEqual({ key: "key", step: "b" });
    expect(later).not.toHaveBeenCalled();
  });

  it("answers undefined when no step does", () => {
    expect(
      firstUsable(["a", "b"] as const, { a: () => null, b: () => "  " })
    ).toBeUndefined();
  });

  it("awaits each step in order, and runs no later one once an earlier answered", async () => {
    const order: string[] = [];
    const later = vi.fn(async () => "later");
    await expect(
      firstUsableAsync(["a", "b", "c"] as const, {
        a: async () => {
          order.push("a");
          return "public";
        },
        b: () => {
          order.push("b");
          return "k";
        },
        c: later,
      })
    ).resolves.toBe("k");
    expect(order).toEqual(["a", "b"]);
    expect(later).not.toHaveBeenCalled();
    await expect(
      firstUsableAsync(["a"] as const, { a: async () => null })
    ).resolves.toBeUndefined();
  });
});

describe("credential policy · whose key may be kept (OC3)", () => {
  it.each([
    [true, false, false, true],
    [true, false, true, false],
    [true, true, false, false],
    [true, true, true, false],
    [false, false, false, false],
    [false, false, true, false],
    [false, true, false, false],
    [false, true, true, false],
  ])(
    "decorated %s, foreign %s, marked %s: %s",
    (decorated, foreign, marked, expected) => {
      expect(mayCapture({ decorated, foreign, marked })).toBe(expected);
    }
  );
});

describe("credential policy · how long a key is kept (L8)", () => {
  it("drops a key at the second refusal in a row, and not before", () => {
    expect(EVICT_AFTER).toBe(2);
    expect(strike(0, "refused")).toEqual({ evict: false, strikes: 1 });
    expect(strike(1, "refused")).toEqual({ evict: true, strikes: 2 });
  });

  it("an acceptance clears the count", () => {
    expect(strike(1, "accepted")).toEqual({ evict: false, strikes: 0 });
    expect(strike(0, "accepted")).toEqual({ evict: false, strikes: 0 });
  });

  it("counts only a 401 on a well-formed session that carried a key", () => {
    expect(
      countsAsRefusal({ keySent: true, sessionWellFormed: true, status: 401 })
    ).toBe(true);
    // A malformed session draws the same 401 whatever the key.
    expect(
      countsAsRefusal({ keySent: true, sessionWellFormed: false, status: 401 })
    ).toBe(false);
    expect(
      countsAsRefusal({ keySent: false, sessionWellFormed: true, status: 401 })
    ).toBe(false);
    for (const status of [200, 403, 429, 500]) {
      expect(
        countsAsRefusal({ keySent: true, sessionWellFormed: true, status })
      ).toBe(false);
    }
  });
});
