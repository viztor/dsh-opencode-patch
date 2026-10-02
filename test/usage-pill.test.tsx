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
  formatRelativeReset,
  getAffectingWindow,
  matchesAny,
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

describe("usage-pill: helper functions & calculations", () => {
  it("formats relative countdown timers accurately", () => {
    expect(formatRelativeReset(isoAt(-5000))).toBe("soon");
    expect(formatRelativeReset(isoAt(30 * 60 * 1000 + 500))).toBe("in 30m");
    expect(formatRelativeReset(isoAt((3 * 3600 + 15 * 60) * 1000))).toBe(
      "in 3h 15m"
    );
    expect(formatRelativeReset(isoAt((2 * 86400 + 4 * 3600) * 1000))).toBe(
      "in 2d 4h"
    );
    // Beyond a week it renders a locale date, so just assert it left the
    // relative shape instead of pinning an exact localized string.
    expect(formatRelativeReset(isoAt(9 * 86400 * 1000))).not.toMatch(/^in /);
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

  it("renders null when current model is missing or undefined", () => {
    const store = createStore({});

    const element = UsagePill({
      directory: store,
      readUsage: async () => createMockUsage(),
      t: (k: string) => k,
    });

    expect(element).toBeNull();
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
      providerMarkers: ["my-custom-route"],
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
      providerMarkers: ["only-this-route"],
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
      providerMarkers: [],
      readUsage: async () => createMockUsage(),
      t: (k: string) => k,
    });

    expect(element).not.toBeNull();
    assert.ok(element);
    expect(element.type).toBeDefined();
  });
});
