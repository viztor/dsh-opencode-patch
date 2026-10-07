import assert from "node:assert/strict";

import { describe, expect, it, vi } from "vitest";

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useSyncExternalStore: (_sub: unknown, getSnapshot: () => unknown) =>
      getSnapshot(),
  };
});

import type { SessionUsageSnapshot } from "../src/session-cost.ts";
import type { GoUsage } from "../src/usage-contract.ts";
import {
  type ModelDirectoryState,
  type SnapshotStore,
  UsagePill,
} from "../src/usage-pill.tsx";
import {
  CIRCUMFERENCE,
  describeUsage,
  formatRelativeReset,
  getAffectingWindow,
  isZenProvider,
  matchesAny,
  parseFailure,
  ringGeometry,
} from "../src/usage-ui.ts";

const createMockUsage = (overrides?: Partial<GoUsage>): GoUsage => ({
  monthly: {
    percent: 10,
    resetsAt: new Date(Date.now() + 86400 * 20 * 1000).toISOString(),
    status: "ok",
  },
  rolling: {
    percent: 10,
    resetsAt: new Date(Date.now() + 3600 * 2 * 1000).toISOString(),
    status: "ok",
  },
  weekly: {
    percent: 10,
    resetsAt: new Date(Date.now() + 86400 * 3 * 1000).toISOString(),
    status: "ok",
  },
  ...overrides,
});

/** ISO timestamp `offsetMs` from now — negative is in the past. */
const isoAt = (offsetMs: number): string =>
  new Date(Date.now() + offsetMs).toISOString();

/** A priced session, as the Host reports it back to the meter. */
const session = (costFormatted: string): SessionUsageSnapshot => ({
  cacheReadTokens: 0,
  costFormatted,
  costUsd: 0.42,
  inputTokens: 10,
  modelsUsed: ["mimo-v2.6-flash"],
  outputTokens: 20,
  totalTokens: 30,
  turns: 1,
});

describe("usage-pill: helper functions & calculations", () => {
  it("formats relative countdown timers accurately", () => {
    // Pure durations, with no English prefix: the panel supplies a localised label
    // ("Resets" / "重置于"), so an "in …" here would half-translate the line.
    expect(formatRelativeReset(isoAt(-5000))).toBe("<1m");
    expect(formatRelativeReset(isoAt(30 * 60 * 1000 + 500))).toBe("30m");
    expect(formatRelativeReset(isoAt((3 * 3600 + 15 * 60) * 1000))).toBe(
      "3h 15m"
    );
    expect(formatRelativeReset(isoAt((2 * 86400 + 4 * 3600) * 1000))).toBe(
      "2d 4h"
    );
    // Beyond a week it renders a locale date, so just assert it left the
    // relative shape instead of pinning an exact localized string.
    expect(formatRelativeReset(isoAt(9 * 86400 * 1000))).not.toMatch(/^\d+d /);
    // Unparseable input is returned verbatim rather than throwing.
    expect(formatRelativeReset("not-a-date")).toBe("not-a-date");
  });

  it("prioritizes rate-limited window as the affecting bottleneck", () => {
    const usage = createMockUsage({
      monthly: {
        percent: 100,
        resetsAt: isoAt(86400 * 10 * 1000),
        status: "rate-limited",
      },
      rolling: {
        percent: 0,
        resetsAt: isoAt(3600 * 1000),
        status: "ok",
      },
    });

    // The hard monthly cap outranks every healthy window's percentage.
    const affected = getAffectingWindow(usage);
    expect(affected.key).toBe("monthly");
    expect(affected.label).toBe("Monthly");
    expect(affected.window.status).toBe("rate-limited");

    // No rate-limited window at all → highest percentage wins.
    const healthy = createMockUsage({
      monthly: {
        percent: 30,
        resetsAt: isoAt(86400 * 10 * 1000),
        status: "ok",
      },
      rolling: { percent: 0, resetsAt: isoAt(3600 * 1000), status: "ok" },
      weekly: { percent: 0, resetsAt: isoAt(86400 * 3 * 1000), status: "ok" },
    });
    expect(getAffectingWindow(healthy).label).toBe("Monthly");
  });

  it("selects window with highest percentage when no window is rate-limited", () => {
    const usage = createMockUsage({
      monthly: {
        percent: 30,
        resetsAt: isoAt(86400 * 10 * 1000),
        status: "ok",
      },
      rolling: {
        percent: 10,
        resetsAt: isoAt(3600 * 1000),
        status: "ok",
      },
      weekly: {
        percent: 80,
        resetsAt: isoAt(86400 * 3 * 1000),
        status: "ok",
      },
    });

    // Weekly at 80% is the active bottleneck, not monthly or rolling.
    const affecting = getAffectingWindow(usage);
    expect(affecting.key).toBe("weekly");
    expect(affecting.label).toBe("Weekly");
    expect(affecting.window.percent).toBe(80);

    // All-zero usage falls back to the rolling window rather than null.
    const zeroed = createMockUsage({
      monthly: { percent: 0, resetsAt: isoAt(-1), status: "ok" },
      rolling: { percent: 0, resetsAt: isoAt(-1), status: "ok" },
      weekly: { percent: 0, resetsAt: isoAt(-1), status: "ok" },
    });
    expect(getAffectingWindow(zeroed).key).toBe("rolling");
  });

  it("matches markers case-insensitively and skips blanks", () => {
    expect(matchesAny("OPENCODE-GO", ["opencode-go"])).toBe(true);
    expect(matchesAny("My-Custom-Go-Route", ["custom-go"])).toBe(true);
    expect(matchesAny("some-provider", ["opencode-go"])).toBe(false);
    // A blank marker never matches, so an empty entry cannot arm the meter.
    expect(matchesAny("anything", [""])).toBe(false);
    expect(matchesAny("anything", [])).toBe(false);
  });
});

describe("usage-pill: UsagePill component gating", () => {
  const createStore = (
    state: ModelDirectoryState
  ): SnapshotStore<ModelDirectoryState> => ({
    getSnapshot: () => state,
    subscribe: () => () => {},
  });

  it("renders null when active model is not opencode-go or deepseek-v4.1-flash", () => {
    const store = createStore({
      current: {
        model: "deepseek-chat",
        provider: "deepseek",
      },
    });

    const element = UsagePill({
      directory: store,
      readUsage: async () => createMockUsage(),
      t: (k: string) => k,
    });

    expect(element).toBeNull();
  });

  it("shows the meter while the provider is still unknown", () => {
    // `current` stays null until a selection is SAVED, so a fresh session has no
    // provider to match. That is "unknown", not "not OpenCode" — hiding on it
    // made the meter vanish for the whole session. The Host's read is the
    // authority on whether there is a Go account: it answers `configured: false`
    // when there is not, and the panel renders nothing for that.
    const element = UsagePill({
      directory: createStore({}),
      readUsage: async () => createMockUsage(),
      t: (k: string) => k,
    });

    expect(element).not.toBeNull();
  });

  it("shows the meter for a pending selection before it settles", () => {
    const element = UsagePill({
      directory: createStore({ pending: { provider: "opencode-go" } }),
      readUsage: async () => createMockUsage(),
      t: (k: string) => k,
    });

    expect(element).not.toBeNull();
  });

  it("mounts ActiveUsage when active model is opencode-go", () => {
    const store = createStore({
      current: {
        model: "some-model",
        provider: "opencode-go",
      },
    });

    const element = UsagePill({
      directory: store,
      readUsage: async () => createMockUsage(),
      t: (k: string) => k,
    });

    expect(element).not.toBeNull();
    assert.ok(element);
    expect(element.type).toBeDefined();
  });

  it("does not mount ActiveUsage when active provider is not opencode-go even if model is deepseek-v4.1-flash", () => {
    const store = createStore({
      current: {
        model: "deepseek-v4.1-flash",
        provider: "custom-provider",
      },
    });

    const element = UsagePill({
      directory: store,
      readUsage: async () => createMockUsage(),
      t: (k: string) => k,
    });

    expect(element).toBeNull();
  });

  it("honours configured provider markers instead of the built-in gate", () => {
    const store = createStore({
      current: {
        model: "some-model",
        provider: "my-custom-route",
      },
    });

    const element = UsagePill({
      directory: store,
      meterProviders: ["my-custom-route"],
      readUsage: async () => createMockUsage(),
      t: (k: string) => k,
    });

    expect(element).not.toBeNull();
    assert.ok(element);
    expect(element.type).toBeDefined();
  });

  it("replaces the default gate when custom markers exclude the stock route", () => {
    const store = createStore({
      current: {
        model: "deepseek-v4.1-flash",
        provider: "opencode-go",
      },
    });

    const element = UsagePill({
      directory: store,
      modelMarkers: ["only-this-model"],
      meterProviders: ["only-this-route"],
      readUsage: async () => createMockUsage(),
      t: (k: string) => k,
    });

    expect(element).toBeNull();
  });

  it("falls back to the default markers when the configured lists are empty", () => {
    const store = createStore({
      current: {
        model: "some-model",
        provider: "opencode-go",
      },
    });

    const element = UsagePill({
      directory: store,
      modelMarkers: [],
      meterProviders: [],
      readUsage: async () => createMockUsage(),
      t: (k: string) => k,
    });

    expect(element).not.toBeNull();
    assert.ok(element);
    expect(element.type).toBeDefined();
  });
});

describe("usage-pill: derived copy & failure parsing", () => {
  const t = (key: string): string => `t:${key}`;

  it("distinguishes the Zen route from the Go plan", () => {
    expect(isZenProvider("opencode")).toBe(true);
    expect(isZenProvider("OPENCODE")).toBe(true);
    expect(isZenProvider("opencode-go")).toBe(false);
    expect(isZenProvider("OpenCode-Go")).toBe(false);
    expect(isZenProvider("deepseek")).toBe(false);
    expect(isZenProvider()).toBe(false);
  });

  it("describes a healthy Go reading with the bottleneck window", () => {
    const usage = createMockUsage({
      weekly: { percent: 80, resetsAt: isoAt(3600 * 1000), status: "ok" },
    });
    const copy = describeUsage(
      usage,
      getAffectingWindow(usage),
      false,
      undefined,
      t
    );
    expect(copy.headline).toBe("80% of Weekly used");
    expect(copy.badgeText).toBe("Go Plan");
    expect(copy.zenCardDesc).toBe("t:zenOverflowActive");
  });

  it("flags a rate-limited window in the headline and badge", () => {
    const usage = createMockUsage({
      monthly: { percent: 100, resetsAt: isoAt(1000), status: "rate-limited" },
    });
    const copy = describeUsage(
      usage,
      getAffectingWindow(usage),
      false,
      undefined,
      t
    );
    expect(copy.headline).toBe("Monthly quota limited");
    expect(copy.badgeText).toBe("t:usageLimited");
    expect(copy.zenCardDesc).toBe("t:zenFallbackNotice");
  });

  it("switches the copy to pay-as-you-go on a Zen route", () => {
    // The badge is the ONLY place the billing model is said: the Zen panel used
    // to repeat it in a subtitle and again in a balance row that had no balance
    // behind it (OpenCode exposes no such endpoint).
    const usage = createMockUsage({ zenOverflow: true });
    const copy = describeUsage(
      usage,
      getAffectingWindow(usage),
      true,
      undefined,
      t
    );
    expect(copy.headline).toBe("t:zenPaygTitle");
    expect(copy.badgeText).toBe("t:zenPaygBadge");
  });

  it("gives the Zen trigger a tooltip worth reading, not the plan's name", () => {
    // The pill shows session spend, so the plan name says nothing the trigger
    // does not already imply — and there is no balance or remaining-quota
    // figure to offer, because OpenCode exposes neither. So the tooltip says
    // there is no quota window and names what the number on screen is.
    const usage = createMockUsage({ session: session("$0.42") });
    const copy = describeUsage(
      usage,
      getAffectingWindow(usage),
      true,
      undefined,
      t
    );
    expect(copy.tooltip).toBe("t:zenNoQuotaWindow · t:sessionSpend $0.42");

    // Before the first priced turn the spend is absent, not undefined text.
    const fresh = createMockUsage();
    expect(
      describeUsage(fresh, getAffectingWindow(fresh), true, undefined, t)
        .tooltip
    ).toBe("t:zenNoQuotaWindow · t:sessionSpend $0.00");

    // Go keeps the ring's own figure, plus the one thing the pill cannot say in
    // two digits — when the window burns off. The trigger shows the USED
    // share; the tooltip says how long you are stuck with it.
    const go = createMockUsage({
      weekly: { percent: 80, resetsAt: isoAt(3600 * 1000), status: "ok" },
    });
    expect(
      describeUsage(go, getAffectingWindow(go), false, undefined, t).tooltip
    ).toBe("80% of Weekly used · t:usageResets 1h");
  });

  it("says the Go plan is what ran out when Zen overflow is live", () => {
    // The one case where "how much is left" has a real answer on a Zen route:
    // the remaining is zero, and the reason the trigger shows spend instead of a
    // percentage is that billing moved. Without the overflow flag there is
    // nothing to report — which is the other line.
    const usage = createMockUsage({
      monthly: {
        percent: 100,
        resetsAt: isoAt(1000),
        status: "rate-limited",
      },
      session: session("$0.42"),
      zenOverflow: true,
    });
    const copy = describeUsage(
      usage,
      getAffectingWindow(usage),
      true,
      undefined,
      t
    );
    expect(copy.tooltip).toBe("t:zenOverflowLive · t:sessionSpend $0.42");
    expect(copy.tooltip).not.toContain("t:zenNoQuotaWindow");
  });

  it("reports Zen overflow as Ready until the plan is actually limited", () => {
    // The card renders only once overflow is on, so `Ready` is what a healthy
    // Go plan with a Zen key shows, and `Active` what a limited one shows.
    const usage = createMockUsage({ zenOverflow: true });
    expect(
      describeUsage(usage, getAffectingWindow(usage), false, undefined, t)
        .zenCardCredit
    ).toBe("Ready");

    const limited = createMockUsage({
      monthly: { percent: 100, resetsAt: isoAt(1000), status: "rate-limited" },
      zenOverflow: true,
    });
    expect(
      describeUsage(limited, getAffectingWindow(limited), false, undefined, t)
        .zenCardCredit
    ).toBe("Active");
  });

  it("parses a typed usage-unavailable rejection", () => {
    const failure = parseFailure({
      code: "opencode-go/usage-unavailable",
      details: {
        configured: false,
        retainPrevious: true,
        retryable: true,
        source: "abc",
      },
      message: "nope",
    });
    expect(failure).toEqual({
      configured: false,
      message: "nope",
      retainPrevious: true,
      source: "abc",
    });
  });

  it("falls back to a plain message for an untyped error", () => {
    expect(parseFailure(new Error("boom"))).toEqual({
      message: "boom",
      retainPrevious: false,
    });
    expect(parseFailure("boom")).toEqual({
      message: "boom",
      retainPrevious: false,
    });
  });

  it("clamps the ring percentage and derives its dash array", () => {
    const mid = ringGeometry(50);
    expect(mid.clampedPercent).toBe(50);
    expect(mid.strokeDasharray).toBe(
      `${(CIRCUMFERENCE * 50) / 100} ${CIRCUMFERENCE}`
    );

    // Out-of-range input clamps rather than drawing a broken ring.
    expect(ringGeometry(-10).clampedPercent).toBe(0);
    expect(ringGeometry(150).clampedPercent).toBe(100);
    expect(ringGeometry(150).strokeDasharray).toBe(
      `${CIRCUMFERENCE} ${CIRCUMFERENCE}`
    );
  });
});
