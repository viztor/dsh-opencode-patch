/**
 * Session token/dollar accounting.
 *
 * Covers the pure pricing math, the accumulator across turns, and the
 * mid-session model switch that must reprice the *active* model without
 * discarding what earlier models already spent.
 *
 * @module test/session-cost.test
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  calculateTurnCost,
  clearSessionUsageStore,
  formatModelRate,
  formatUsd,
  getSessionUsage,
  recordTurnUsage,
  type ModelCostRate,
} from "../src/index.ts";

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.OPENCODE_SESSION_ID;
});

/** Rates are per one million tokens, matching models.dev. */
const GO_FLASH: ModelCostRate = {
  cache_read: 0.003,
  input: 0.15,
  output: 0.6,
};

// The accumulator is a module-level map, so each case starts from empty.
beforeEach(() => {
  clearSessionUsageStore();
});

describe("formatUsd", () => {
  it("keeps sub-cent precision until the amount is legible", () => {
    expect(formatUsd(0)).toBe("$0.00");
    // Below a tenth of a cent, four decimals is the smallest honest reading.
    expect(formatUsd(0.00012)).toBe("$0.0001");
    expect(formatUsd(0.0042)).toBe("$0.004");
    expect(formatUsd(0.42)).toBe("$0.42");
    expect(formatUsd(12.3456)).toBe("$12.35");
  });
});

describe("formatModelRate", () => {
  it("renders both directions of a paid model's rate", () => {
    expect(formatModelRate(GO_FLASH)).toBe("$0.15 / $0.6 per 1M");
  });

  it("says Free Tier for a free model, a zero rate, or no rate at all", () => {
    expect(formatModelRate(GO_FLASH, true)).toBe("Free Tier ($0.00)");
    expect(formatModelRate({ input: 0, output: 0 })).toBe("Free Tier ($0.00)");
    expect(formatModelRate()).toBe("Free Tier ($0.00)");
  });
});

describe("calculateTurnCost", () => {
  it("prices input, output, and cache reads independently", () => {
    // 1M input at $0.15 + 1M output at $0.60 + 1M cache-read at $0.003.
    expect(
      calculateTurnCost(
        {
          cacheReadTokens: 1_000_000,
          inputTokens: 1_000_000,
          outputTokens: 1_000_000,
        },
        GO_FLASH
      )
    ).toBeCloseTo(0.753, 6);
  });

  it("returns zero for a free model or a missing rate", () => {
    const tokens = { inputTokens: 1_000_000, outputTokens: 1_000_000 };
    expect(calculateTurnCost(tokens, GO_FLASH, true)).toBe(0);
    expect(calculateTurnCost(tokens)).toBe(0);
  });

  it("treats absent token fields as zero rather than NaN", () => {
    expect(calculateTurnCost({}, GO_FLASH)).toBe(0);
    expect(
      calculateTurnCost({ outputTokens: 1_000_000 }, GO_FLASH)
    ).toBeCloseTo(0.6, 6);
  });

  it("ignores cache-read pricing when the rate omits it", () => {
    const noCacheRate: ModelCostRate = { input: 1, output: 1 };
    expect(
      calculateTurnCost(
        { cacheReadTokens: 1_000_000, inputTokens: 0, outputTokens: 0 },
        noCacheRate
      )
    ).toBe(0);
  });
});

describe("recordTurnUsage", () => {
  it("accumulates tokens and dollars across turns", () => {
    recordTurnUsage(
      "s1",
      { inputTokens: 1_000_000, outputTokens: 0, totalTokens: 1_000_000 },
      GO_FLASH,
      "deepseek-v4.1-flash"
    );
    const snap = recordTurnUsage(
      "s1",
      { inputTokens: 0, outputTokens: 1_000_000, totalTokens: 1_000_000 },
      GO_FLASH,
      "deepseek-v4.1-flash"
    );

    expect(snap.turns).toBe(2);
    expect(snap.inputTokens).toBe(1_000_000);
    expect(snap.outputTokens).toBe(1_000_000);
    expect(snap.totalTokens).toBe(2_000_000);
    expect(snap.costUsd).toBeCloseTo(0.75, 6);
    expect(snap.costFormatted).toBe("$0.75");
  });

  it("derives the total from parts when the payload omits it", () => {
    const snap = recordTurnUsage(
      "s1",
      { inputTokens: 10, outputTokens: 5 },
      GO_FLASH,
      "m"
    );
    expect(snap.totalTokens).toBe(15);
  });

  it("reports the active model and its rate for the next turn", () => {
    const snap = recordTurnUsage(
      "s1",
      { inputTokens: 1, totalTokens: 1 },
      GO_FLASH,
      "deepseek-v4.1-flash"
    );
    expect(snap.activeModel).toBe("deepseek-v4.1-flash");
    expect(snap.activeRateFormatted).toBe("$0.15 / $0.6 per 1M");
    expect(snap.includedInPlan).toBeUndefined();
  });

  it("marks a free model as plan-included and prices it at zero", () => {
    const snap = recordTurnUsage(
      "s1",
      {
        inputTokens: 5_000_000,
        outputTokens: 5_000_000,
        totalTokens: 10_000_000,
      },
      { input: 0, output: 0 },
      "muse-spark-1.3-contributor-free",
      true
    );
    expect(snap.includedInPlan).toBe(true);
    expect(snap.costUsd).toBe(0);
    expect(snap.activeRateFormatted).toBe("Free Tier ($0.00)");
    expect(snap.modelsUsed).toContain("muse-spark-1.3-contributor-free");
  });

  it("reprices the active model on a mid-session switch but keeps the spend", () => {
    recordTurnUsage(
      "s1",
      { inputTokens: 1_000_000, totalTokens: 1_000_000 },
      GO_FLASH,
      "cheap-model"
    );
    const snap = recordTurnUsage(
      "s1",
      { inputTokens: 1_000_000, totalTokens: 1_000_000 },
      { input: 3, output: 15 },
      "expensive-model"
    );

    // Cumulative spend covers BOTH models...
    expect(snap.costUsd).toBeCloseTo(0.15 + 3, 6);
    expect(snap.modelsUsed).toEqual(["cheap-model", "expensive-model"]);
    // ...while the rate describes the model that will run the next turn.
    expect(snap.activeModel).toBe("expensive-model");
    expect(snap.activeRateFormatted).toBe("$3 / $15 per 1M");
  });

  it("keeps the previous active model when a turn names none", () => {
    recordTurnUsage(
      "s1",
      { inputTokens: 1, totalTokens: 1 },
      GO_FLASH,
      "known-model"
    );
    const snap = recordTurnUsage(
      "s1",
      { inputTokens: 1, totalTokens: 1 },
      GO_FLASH,
      "unknown"
    );
    expect(snap.activeModel).toBe("known-model");
    expect(snap.modelsUsed).toEqual(["known-model"]);
  });

  it("records cache reads on the snapshot separately", () => {
    const snap = recordTurnUsage(
      "s1",
      { cacheReadTokens: 500, inputTokens: 1, totalTokens: 1 },
      GO_FLASH,
      "m"
    );
    expect(snap.cacheReadTokens).toBe(500);
  });
});

describe("getSessionUsage", () => {
  it("returns undefined for an empty store", () => {
    expect(getSessionUsage()).toBeUndefined();
    expect(getSessionUsage("absent")).toBeUndefined();
  });

  it("looks up by session id and falls back to the most recent session", () => {
    recordTurnUsage("a", { inputTokens: 1, totalTokens: 1 }, GO_FLASH, "m");
    recordTurnUsage("b", { inputTokens: 9, totalTokens: 9 }, GO_FLASH, "m");

    expect(getSessionUsage("a")?.totalTokens).toBe(1);
    expect(getSessionUsage("b")?.totalTokens).toBe(9);
    // An unknown id falls through to the latest session rather than nothing.
    expect(getSessionUsage("nope")?.totalTokens).toBe(9);
  });

  it("returns a copy that cannot mutate stored state", () => {
    recordTurnUsage("a", { inputTokens: 1, totalTokens: 1 }, GO_FLASH, "m");
    const first = getSessionUsage("a");
    first?.modelsUsed.push("injected");
    expect(getSessionUsage("a")?.modelsUsed).toEqual(["m"]);
  });
});
