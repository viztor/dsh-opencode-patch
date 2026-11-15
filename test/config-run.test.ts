/**
 * The route claim's reading of an `internal/config` run and a fiber's two
 * configs, on both host cores (`src/utils/config-run.ts`).
 *
 * Every case drives a shape or a core with a value whose answer is known: an
 * OLD-core fiber (cordis 4.0.5: own `_config` raw, `config` resolved), the
 * accessor fiber 4.0.6-alpha.1 adds, and a NEW-core fiber (cordis
 * 4.0.6-alpha.2, 4.1.0: `config` raw, `effectiveConfig` resolved, no
 * `_config`), each named by its own context as a real fiber is.
 *
 * @module test/config-run.test
 */
import { describe, expect, it } from "vitest";

import {
  configRunOf,
  effectiveConfigOf,
  entryConfigOf,
  isCommitRun,
  isFiber,
  rawConfigOf,
} from "./support/src.ts";

const ACTIVE = 2;
const LOADING = 1;

/** A fiber of the OLD core (4.0.5): own `_config` raw, `config` resolved. */
const oldFiber = (raw: unknown, resolved: unknown, extra = {}) => {
  const fiber = {
    _config: raw,
    config: resolved,
    ctx: {} as Record<string, unknown>,
    state: ACTIVE,
    ...extra,
  };
  fiber.ctx.fiber = fiber;
  return fiber;
};

/** A fiber of the NEW core (4.0.6-alpha.2, 4.1.0): `config` raw, no `_config`. */
const newFiber = (raw: unknown, resolved: unknown, extra = {}) => {
  const fiber = {
    config: raw,
    ctx: {} as Record<string, unknown>,
    get effectiveConfig(): unknown {
      return resolved;
    },
    get rawConfig(): unknown {
      return fiber.config;
    },
    state: ACTIVE,
    ...extra,
  };
  fiber.ctx.fiber = fiber;
  return fiber;
};

describe("config-run · isFiber", () => {
  it("is true only for an object its own context names", () => {
    expect(isFiber(oldFiber({}, {}))).toBe(true);
    expect(isFiber(newFiber({}, {}))).toBe(true);
    const other = oldFiber({}, {});
    expect(isFiber({ ctx: { fiber: other } })).toBe(false);
    expect(isFiber({ ctx: null })).toBe(false);
    expect(isFiber({ providers: {} })).toBe(false);
    expect(isFiber(null)).toBe(false);
    expect(isFiber([other])).toBe(false);
  });
});

describe("config-run · configRunOf", () => {
  const next = () => "inner";

  it("OLD shape: this is the fiber, next is the last argument", () => {
    const fiber = oldFiber({}, {});
    const run = configRunOf(fiber, [{ raw: true }, next]);
    expect(run.fiber).toBe(fiber);
    expect(run.next).toBe(next);
  });

  it("NEW shape: this is null, the fiber is the first argument, next the last", () => {
    const fiber = newFiber({}, {});
    const run = configRunOf(null, [fiber, next]);
    expect(run.fiber).toBe(fiber);
    expect(run.next).toBe(next);
  });

  it("a call in neither shape names no fiber, and a call without a callable last argument has no next", () => {
    expect(configRunOf(null, [{ providers: {} }, next]).fiber).toBeUndefined();
    expect(configRunOf({ runtime: {} }, [{}, next]).fiber).toBeUndefined();
    const fiber = newFiber({}, {});
    expect(configRunOf(null, [fiber]).next).toBeUndefined();
    expect(configRunOf(null, [fiber, "next"]).next).toBeUndefined();
    expect(configRunOf(null, []).fiber).toBeUndefined();
  });
});

describe("config-run · the accessors", () => {
  it("OLD (4.0.5): raw is _config, resolved is config", () => {
    const raw = { r: 1 };
    const resolved = { e: 1 };
    const fiber = oldFiber(raw, resolved);
    expect(rawConfigOf(fiber)).toBe(raw);
    expect(effectiveConfigOf(fiber)).toBe(resolved);
  });

  it("4.0.6-alpha.1: the accessors over the same two fields win", () => {
    const raw = { r: 1 };
    const resolved = { e: 1 };
    const fiber = oldFiber(
      { stale: true },
      { stale: true },
      {
        effectiveConfig: resolved,
        rawConfig: raw,
      }
    );
    expect(rawConfigOf(fiber)).toBe(raw);
    expect(effectiveConfigOf(fiber)).toBe(resolved);
  });

  it("NEW (4.0.6-alpha.2, 4.1.0): raw is config through rawConfig, resolved only through effectiveConfig", () => {
    const raw = { r: 1 };
    const resolved = { e: 1 };
    const fiber = newFiber(raw, resolved);
    expect(rawConfigOf(fiber)).toBe(raw);
    expect(effectiveConfigOf(fiber)).toBe(resolved);
    // Known answer: a direct read of `config` is the RAW value on this core.
    expect(fiber.config).toBe(raw);
  });

  it("a value that is not a fiber reads as nothing", () => {
    expect(rawConfigOf(undefined)).toBeUndefined();
    expect(effectiveConfigOf("fiber")).toBeUndefined();
    expect(entryConfigOf(null)).toBeUndefined();
    expect(entryConfigOf({ entry: null })).toBeUndefined();
    expect(entryConfigOf({ entry: { options: null } })).toBeUndefined();
    const stored = { providers: {} };
    expect(entryConfigOf({ entry: { options: { config: stored } } })).toBe(
      stored
    );
  });
});

describe("config-run · isCommitRun", () => {
  it("a commit is the fiber's own raw config, on either core", () => {
    const raw = { providers: {} };
    expect(isCommitRun(raw, oldFiber(raw, {}), ACTIVE)).toBe(true);
    expect(isCommitRun(raw, newFiber(raw, {}), ACTIVE)).toBe(true);
  });

  it("a commit is the loader's stored row config, which the NEW core's update() resolves before it stores", () => {
    const stored = { providers: {} };
    const fiber = newFiber(
      { providers: { old: {} } },
      {},
      {
        entry: { options: { config: stored } },
      }
    );
    expect(isCommitRun(stored, fiber, ACTIVE)).toBe(true);
  });

  it("every run while the fiber is not ACTIVE is a commit (an activation)", () => {
    const fiber = newFiber({}, {}, { state: LOADING });
    expect(isCommitRun({ fresh: true }, fiber, ACTIVE)).toBe(true);
  });

  it("an editor candidate (a fresh object on an ACTIVE fiber) is not, and neither is a run for no fiber", () => {
    const fiber = newFiber({}, {}, { entry: { options: {} } });
    expect(isCommitRun({ fresh: true }, fiber, ACTIVE)).toBe(false);
    // A row with no stored config: undefined never matches.
    expect(isCommitRun(undefined, oldFiber({}, {}), ACTIVE)).toBe(false);
    expect(isCommitRun({}, undefined, ACTIVE)).toBe(false);
  });
});
