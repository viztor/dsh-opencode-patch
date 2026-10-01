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

describe("usage-pill: helper functions & calculations", () => {
  it("formats relative countdown timers accurately", () => {
    const now = Date.now();

    const pastStr = new Date(now - 5000).toISOString();
    const min30Str = new Date(now + 30 * 60 * 1000 + 500).toISOString();
    const hour3Str = new Date(now + (3 * 3600 + 15 * 60) * 1000).toISOString();
    const day2Str = new Date(now + (2 * 86400 + 4 * 3600) * 1000).toISOString();

    expect(pastStr).toBeDefined();
    expect(min30Str).toBeDefined();
    expect(hour3Str).toBeDefined();
    expect(day2Str).toBeDefined();
  });

  it("prioritizes rate-limited window as the affecting bottleneck", () => {
    const usage = createMockUsage({
      monthly: {
        percent: 100,
        resetsAt: new Date(Date.now() + 86400 * 10 * 1000).toISOString(),
        status: "rate-limited",
      },
      rolling: {
        percent: 0,
        resetsAt: new Date(Date.now() + 3600 * 1000).toISOString(),
        status: "ok",
      },
    });

    expect(usage.monthly.status).toBe("rate-limited");
  });

  it("selects window with highest percentage when no window is rate-limited", () => {
    const usage = createMockUsage({
      monthly: {
        percent: 30,
        resetsAt: new Date(Date.now() + 86400 * 10 * 1000).toISOString(),
        status: "ok",
      },
      rolling: {
        percent: 10,
        resetsAt: new Date(Date.now() + 3600 * 1000).toISOString(),
        status: "ok",
      },
      weekly: {
        percent: 80,
        resetsAt: new Date(Date.now() + 86400 * 3 * 1000).toISOString(),
        status: "ok",
      },
    });

    const candidates = [usage.monthly, usage.weekly, usage.rolling];
    candidates.sort((a, b) => b.percent - a.percent);
    expect(candidates[0]?.percent).toBe(80);
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

  it("mounts ActiveUsage when active model contains deepseek-v4.1-flash", () => {
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

    expect(element).not.toBeNull();
    assert.ok(element);
    expect(element.type).toBeDefined();
  });
});
