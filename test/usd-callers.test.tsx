/**
 * The two dollar contracts, read through their callers (P7's pin).
 *
 * A metered spend and a published allowance are different kinds of figure,
 * and they were formatted by two functions both named `formatUsd`. P7 makes
 * them one function with two named styles; this file pins what each caller
 * shows, through names that exist before and after, and it is not edited
 * while the refactor lands.
 *
 * - **Metered** (the session accumulator): always two decimals, so the row's
 *   length does not change with its value; whole dollars keep their cents.
 * - **Allowance** (the settings summary and the meter's panel): a whole
 *   published figure drops the cents, and an unknown one says "—".
 *
 * @module test/usd-callers.test
 */
import { afterEach, describe, expect, it } from "vitest";

import {
  clearSessionUsageStore,
  getSessionUsage,
  type GoUsage,
  recordTurnUsage,
  UsagePanel,
  type UsagePanelProps,
  UsageSummaryView,
} from "./support/src.ts";
import { collectText } from "./test-helpers.ts";

afterEach(() => {
  clearSessionUsageStore();
});

const t = (key: string): string => `t:${key}`;

const usage = (overrides: Partial<GoUsage> = {}): GoUsage => ({
  monthly: { percent: 14, resetsAt: "2026-11-07T00:55:00Z", status: "ok" },
  rolling: { percent: 0, resetsAt: "2026-10-09T06:00:00Z", status: "ok" },
  source: "opencode-go",
  weekly: { percent: 28, resetsAt: "2026-10-12T00:00:00Z", status: "ok" },
  zenOverflow: false,
  ...overrides,
});

/** Every string the tree renders, in order, joined with spaces. */
const textOf = (tree: unknown): string => collectText(tree).join(" ");

describe("dollars · a metered spend always shows two decimals (pin, through the session accumulator)", () => {
  it("formats a session's metered spend to the cent, from the record's return and the reader", () => {
    // input tokens at $1 per million: the spend is tokens / 1e6 dollars. Both
    // reads are the SESSION's snapshot: the per-turn record's own string is
    // written into a history nothing reads, so it is not observable here.
    const cases: readonly (readonly [number, string])[] = [
      [0, "$0.00"],
      [6_000, "$0.01"],
      [420_000, "$0.42"],
      [12_345_600, "$12.35"],
      // Whole dollars keep the cents here, unlike an allowance.
      [60_000_000, "$60.00"],
    ];
    for (const [inputTokens, expected] of cases) {
      const sessionId = `usd-callers-${String(inputTokens)}`;
      const snapshot = recordTurnUsage(
        sessionId,
        { inputTokens },
        { input: 1, output: 0 }
      );
      expect(snapshot.costFormatted, `${String(inputTokens)} tokens`).toBe(
        expected
      );
      expect(getSessionUsage(sessionId)?.costFormatted).toBe(expected);
    }
  });
});

describe("dollars · a published allowance drops the cents of a whole figure and says — for an unknown one (pin, through both views)", () => {
  const summary = (allowance: GoUsage["allowance"]): string =>
    textOf(UsageSummaryView({ locale: "zh", t, usage: usage({ allowance }) }));

  it("the settings summary", () => {
    const priced = summary({ go: 60, goPlus: 7.5, model: "probe-model" });
    expect(priced).toContain("$60 ·");
    expect(priced).toContain("$7.50");
    expect(priced).not.toContain("$60.00");

    const unknown = summary({
      go: Number.NaN,
      goPlus: null as never,
      model: "probe-model",
    });
    expect(unknown.split("—")).toHaveLength(3);
    expect(unknown).not.toContain("$");

    expect(summary({ go: 0, goPlus: 1, model: "probe-model" })).toContain(
      "$0 ·"
    );
    const negative = summary({ go: -1, goPlus: 1, model: "probe-model" });
    expect(negative).toContain("—");
    expect(negative).not.toContain("$-1");
  });

  it("the meter's panel", () => {
    const props: UsagePanelProps = {
      badgeText: "Go Plan",
      failure: null,
      isLimited: false,
      isZen: false,
      locale: undefined,
      onMouseEnter: () => {},
      onMouseLeave: () => {},
      refreshing: false,
      retry: () => {},
      t,
      title: "t:goPlanTitle",
      updatedAt: 1_700_000_000_000,
      usage: usage({
        allowance: { go: 100, goPlus: 200, model: "probe-model" },
      }),
      zenCardCredit: "t:zenPaygBadge",
    };
    const text = collectText(UsagePanel(props));
    expect(text).toContain("$100");
    expect(text).toContain("$200");
    expect(text).not.toContain("$100.00");
  });
});
