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
  getWindowColorFor,
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
/**
 * Slack for every duration fixture, in milliseconds.
 *
 * `formatRelativeReset` floors, and it reads `Date.now()` at CALL time — so a
 * fixture built at exactly 45 minutes and asserted as `45m` is a race that any
 * elapsed millisecond loses. CI lost it: `expected '44m' to be '45m'`. Every
 * fixture below therefore sits this far ABOVE the boundary it asserts, which
 * keeps the floored result stable for any drift under half a minute.
 */
const SLACK_MS = 30_000;

/** A duration fixture that cannot be floored out from under its assertion. */
const ahead = (ms: number): number => ms + SLACK_MS;

const isoAt = (offsetMs: number): string =>
  new Date(Date.now() + offsetMs).toISOString();

describe("usage-pill: helper functions & calculations", () => {
  it("floors the countdown, and never claims a reset that already happened", () => {
    // FLOOR, not round. `Math.round` on the TOTAL minutes turned 1h10m36s into
    // `1h 11m`, 59m59s into `1h`, and pulled a 6d23h window off the relative
    // ladder ~20s early — while the day branch truncated minutes. A countdown
    // must never claim more time than remains, so one policy: floored.
    // An explicit locale: the text is localized now, so a bare call would assert
    // whatever the test runner's default locale happens to be.
    const at = (ms: number): ReturnType<typeof formatRelativeReset> =>
      formatRelativeReset(isoAt(ms), "en");
    expect(at(30 * 60 * 1000 + 500)).toEqual({
      kind: "duration",
      text: "30m",
    });
    expect(at(ahead((3 * 3600 + 15 * 60) * 1000))).toEqual({
      kind: "duration",
      text: "3h 15m",
    });
    expect(at(ahead((2 * 86400 + 4 * 3600) * 1000))).toEqual({
      kind: "duration",
      text: "2d 4h",
    });

    // Boundaries the old rounding got wrong, in both directions.
    expect(at(59 * 60 * 1000 + 59 * 1000).text).toBe("59m");
    expect(at((23 * 3600 + 59 * 60 + 40) * 1000).text).toBe("23h 59m");
    expect(at((6 * 86400 + 23 * 3600 + 59 * 60 + 40) * 1000).text).toBe(
      "6d 23h"
    );
    expect(at(1_000_000).text).toBe("16m");
    // A sub-minute POSITIVE diff. The old code only guarded `diffMs <= 0`, so
    // 1-29s rounded to the string `0m`. Its wording is copy, not a duration, so
    // it is its own kind and `resetLabel` supplies the text per locale.
    expect(at(20_000)).toEqual({ kind: "underMinute", text: "" });

    // A window that already rolled over says so. This is reachable: the panel
    // re-derives at every render from a payload up to a poll old, so for as long
    // as a minute after a boundary the old `resetsAt` is in the past — and the
    // old code answered `<1m`, the exact shape of the fabricated rows this
    // panel removed.
    expect(formatRelativeReset(isoAt(-5000), "en")).toEqual({
      kind: "passed",
      text: "",
    });

    // Exactly N days reads `2d`, not `2d 0h` — the hour branch already guarded
    // its zero and the day branch did not.
    expect(at(ahead(2 * 86400 * 1000)).text).toBe("2d");

    // Beyond a week it renders a locale date, tagged `absolute` because that is
    // the shape that composes with a PREFIX rather than a suffix.
    const far = formatRelativeReset(isoAt(9 * 86400 * 1000), "en");
    expect(far.kind).toBe("absolute");
    expect(far.text).not.toMatch(/^\d+d/);

    // Unparseable input is handed back verbatim rather than thrown away.
    expect(formatRelativeReset("not-a-date")).toEqual({
      kind: "absolute",
      text: "not-a-date",
    });
  });

  it("falls back to a unit table when the engine has no DurationFormat", () => {
    // The fallback is why a missing API cannot blank the row, and it is a unit
    // TABLE rather than a second formatter: same composition, two words per
    // language. Exercised by taking the constructor away, because Node ships it
    // and the branch would otherwise never run.
    const had = Object.hasOwn(Intl, "DurationFormat");
    const original: unknown = Reflect.get(Intl, "DurationFormat");
    assert.equal(Reflect.deleteProperty(Intl, "DurationFormat"), true);
    try {
      const at = (ms: number, locale: string): string =>
        formatRelativeReset(isoAt(ms), locale).text;
      expect(at(ahead((2 * 86400 + 4 * 3600) * 1000), "en")).toBe("2d 4h");
      expect(at(ahead((2 * 86400 + 4 * 3600) * 1000), "zh")).toBe("2天4小时");
      expect(at(30 * 60 * 1000 + 500, "zh")).toBe("30分");
      expect(at(ahead(2 * 86400 * 1000), "en")).toBe("2d");
      expect(at(ahead(45 * 60 * 1000), "en")).toBe("45m");
    } finally {
      if (had) {
        Reflect.set(Intl, "DurationFormat", original);
      }
    }
    // Read through `Reflect`: this project's `lib` is ES2024, which predates
    // the constructor, so `Intl.DurationFormat` is not a typed property.
    expect(typeof Reflect.get(Intl, "DurationFormat")).toBe("function");
  });

  it("renders an absolute reset in Chinese with 点/分, not HH:mm", () => {
    // CLDR's zh time pattern is `HH:mm`, so `Intl.DateTimeFormat` alone gives
    // `11月7日 08:55`. A Chinese sentence writes `11月7日8点55分`, so the
    // platform's own PARTS are reused and only the hour/minute separator is
    // localized — the month/day literals and the numerals stay the platform's.
    const zh = formatRelativeReset(isoAt(9 * 86400 * 1000), "zh");
    expect(zh.kind).toBe("absolute");
    expect(zh.text).toMatch(/月\d+日\d+点\d+分$/u);
    expect(zh.text).not.toContain(":");
    // And the leading zero comes off the hour, because 点 takes the bare number.
    expect(zh.text).not.toMatch(/日0\d点/u);

    // English keeps the platform's whole assembled string.
    const en = formatRelativeReset(isoAt(9 * 86400 * 1000), "en");
    expect(en.kind).toBe("absolute");
    expect(en.text).toMatch(/[A-Z][a-z]{2} \d+, \d+:\d+ [AP]M$/u);
  });

  it("falls back when the engine's own formatter refuses the call", () => {
    // The second reason the fallback exists: an engine that HAS the constructor
    // but throws on this input (a locale it rejects, a malformed part) must
    // still leave a readable row rather than an empty one.
    const had = Object.hasOwn(Intl, "DurationFormat");
    const original: unknown = Reflect.get(Intl, "DurationFormat");
    const refusing = function refusing(): never {
      throw new Error("refused");
    };
    Reflect.set(Intl, "DurationFormat", refusing);
    try {
      expect(formatRelativeReset(isoAt(ahead(45 * 60 * 1000)), "en").text).toBe(
        "45m"
      );
      expect(formatRelativeReset(isoAt(ahead(45 * 60 * 1000)), "zh").text).toBe(
        "45分"
      );
    } finally {
      if (had) {
        Reflect.set(Intl, "DurationFormat", original);
      }
    }
  });

  it("localizes the duration units, not just the label", () => {
    // The units used to be Latin and hardcoded (`1h 11m`), which put an English
    // abbreviation inside a Chinese clause: `1h 11m后重置`. `Intl.DurationFormat`
    // is the platform's own answer — the same call that gives `1h 11m` in en
    // gives `1小时11分钟` in zh, with each locale's ordering and unit words.
    const zh = (ms: number): string =>
      formatRelativeReset(isoAt(ms), "zh").text;
    expect(zh(30 * 60 * 1000 + 500)).toBe("30分钟");
    expect(zh(ahead((3 * 3600 + 15 * 60) * 1000))).toBe("3小时15分钟");
    expect(zh(ahead((2 * 86400 + 4 * 3600) * 1000))).toBe("2天4小时");
    expect(zh(ahead(2 * 86400 * 1000))).toBe("2天");
    // And en keeps the compact Latin form it always had.
    expect(
      formatRelativeReset(isoAt(ahead((2 * 86400 + 4 * 3600) * 1000)), "en")
        .text
    ).toBe("2d 4h");
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

    // Nothing is OUT, so the 5-HOUR window answers — it resets soonest, and
    // picking the highest percentage here made the meter answer for monthly.
    const healthy = createMockUsage({
      monthly: {
        percent: 30,
        resetsAt: isoAt(86400 * 10 * 1000),
        status: "ok",
      },
      rolling: { percent: 0, resetsAt: isoAt(3600 * 1000), status: "ok" },
      weekly: { percent: 0, resetsAt: isoAt(86400 * 3 * 1000), status: "ok" },
    });
    expect(getAffectingWindow(healthy).label).toBe("5-Hour");
  });

  it("shows the 5-hour window when nothing is out, whatever the percentages", () => {
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

    // Nothing is OUT, so the 5-hour window answers even though weekly is the
    // higher percentage: it is the window that resets soonest.
    const affecting = getAffectingWindow(usage);
    expect(affecting.key).toBe("rolling");
    expect(affecting.label).toBe("5-Hour");
    expect(affecting.window.percent).toBe(10);

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
      rolling: { percent: 80, resetsAt: isoAt(3600 * 1000), status: "ok" },
    });
    const copy = describeUsage(usage, getAffectingWindow(usage), false, t);
    expect(copy.headline).toBe("80% of 5-Hour used");
    // No badge: the header already reads `OpenCode Go`, so `Go Plan` beside it
    // was a second statement of the same fact. `Limited` still appears when the
    // plan actually is — that is the case the chip earns its place in.
    expect(copy.badgeText).toBe("");
  });

  it("renders a free model's ring hollow instead of red", () => {
    // A free model has no allowance to run out of; the plan's monthly limit is
    // a fact about money the user is not spending. Red would say "you are out"
    // against a bill that cannot be charged.
    // The colour decision reads the WINDOW, not the free flag — the pill
    // combines the two, so here it is the window side that is pinned: unchanged
    // for every state the plan can be in.
    expect(
      getWindowColorFor(
        getAffectingWindow(
          createMockUsage({
            monthly: {
              percent: 100,
              resetsAt: isoAt(1000),
              status: "rate-limited",
            },
          })
        )
      )
    ).toBe("var(--dsw-alias-state-error-primary)");
    expect(getWindowColorFor()).toBe("var(--dsw-alias-state-success-primary)");
    expect(getWindowColorFor(getAffectingWindow(createMockUsage()))).toBe(
      "var(--dsw-alias-state-success-primary)"
    );
  });

  it("names the account in the header, so the title never moves", () => {
    // The header said the ring's figure, which changed on every poll. Both
    // readings now belong to the rows and the badge; the title is the account.
    const healthy = createMockUsage({
      rolling: { percent: 80, resetsAt: isoAt(3600 * 1000), status: "ok" },
    });
    const limited = createMockUsage({
      monthly: { percent: 100, resetsAt: isoAt(1000), status: "rate-limited" },
    });
    expect(
      describeUsage(healthy, getAffectingWindow(healthy), false, t).title
    ).toBe("t:goPlanTitle");
    expect(
      describeUsage(limited, getAffectingWindow(limited), false, t).title
    ).toBe("t:goPlanTitle");
    expect(
      describeUsage(healthy, getAffectingWindow(healthy), true, t).title
    ).toBe("t:zenPaygTitle");

    // The ring's explanation did not die with the header: it is the hover label.
    expect(
      describeUsage(healthy, getAffectingWindow(healthy), false, t).headline
    ).toBe("80% of 5-Hour used");
  });

  it("flags a rate-limited window in the headline and badge", () => {
    const usage = createMockUsage({
      monthly: { percent: 100, resetsAt: isoAt(1000), status: "rate-limited" },
    });
    const copy = describeUsage(usage, getAffectingWindow(usage), false, t);
    expect(copy.headline).toBe("Monthly quota limited");
    expect(copy.badgeText).toBe("t:usageLimited");
  });

  it("switches the copy to pay-as-you-go on a Zen route", () => {
    // The badge is the ONLY place the billing model is said: the Zen panel used
    // to repeat it in a subtitle and again in a balance row that had no balance
    // behind it (OpenCode exposes no such endpoint).
    const usage = createMockUsage({ zenOverflow: true });
    const copy = describeUsage(usage, getAffectingWindow(usage), true, t);
    expect(copy.badgeText).toBe("t:zenPaygBadge");

    // The hover answers "is this metered?" — it does NOT repeat the account
    // name, which is already the panel header one click away. The trigger showed
    // "OpenCode Zen" here for as long as it borrowed the ring's string, and a
    // tooltip that restates what you can already see explains nothing.
    expect(copy.tooltip).toBe("t:zenPaygTooltip");
    expect(copy.tooltip).not.toBe(copy.title);
  });

  it("reports Zen overflow as Ready until the plan is actually limited", () => {
    // The card renders only once overflow is on, so `Ready` is what a healthy
    // Go plan with a Zen key shows, and `Active` what a limited one shows.
    const usage = createMockUsage({ zenOverflow: true });
    expect(
      describeUsage(usage, getAffectingWindow(usage), false, t).zenCardCredit
    ).toBe("Ready");

    const limited = createMockUsage({
      monthly: { percent: 100, resetsAt: isoAt(1000), status: "rate-limited" },
      zenOverflow: true,
    });
    expect(
      describeUsage(limited, getAffectingWindow(limited), false, t)
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

  it("carries a rejected-credential reason through to the panel", () => {
    // Without `reason` the panel renders this as a failed REFRESH, which is a
    // different fact from "this credential is not one the endpoint accepts".
    expect(
      parseFailure({
        code: "opencode-go/usage-unavailable",
        details: { reason: "auth", retainPrevious: false, retryable: false },
        message: "rejected",
      })
    ).toEqual({
      message: "rejected",
      reason: "auth",
      retainPrevious: false,
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
