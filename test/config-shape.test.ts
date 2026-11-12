/**
 * `test/support/config-shape.ts`: how the host contracts read an
 * `internal/config` call and a fiber's configs on either host core, without
 * asking which core it is.
 *
 * Both channel records run the NEW core (cordis 4.0.6-alpha.2 and 4.1.0), so
 * no real host exercises the OLD shape any more. These cases keep it covered:
 * each fiber is the smallest object of one core's shape, each waterfall
 * dispatches the way that core does (OLD: `this` is the fiber and the raw is
 * shared as an argument; NEW: `this` is null, the fiber is the first argument
 * and each listener's `next` refuses a second call, as cordis 4.1.0's
 * `events.ts` does), and each answer is known.
 *
 * @module test/config-shape.test
 */
import { describe, expect, it } from "vitest";

import {
  configCall,
  coreShapeOf,
  effectiveConfigOf,
  isFiber,
  rawConfigOf,
  sameFiber,
} from "./support/config-shape.ts";

/** A value that is genuinely absent, without writing the `undefined` literal. */
const ABSENT: unknown = undefined;

/** A fiber of the OLD core (4.0.5): own `_config` raw, `config` resolved. */
const oldFiber = (raw: unknown, resolved: unknown): Record<string, unknown> => {
  const fiber: Record<string, unknown> = {
    _config: raw,
    config: resolved,
    ctx: {},
  };
  (fiber.ctx as Record<string, unknown>).fiber = fiber;
  return fiber;
};

/** A fiber of 4.0.6-alpha.1: the OLD fields, with the accessors over them. */
class AccessorFiber {
  public _config: unknown;
  public config: unknown;
  public readonly ctx: { fiber: AccessorFiber };

  public constructor(raw: unknown, resolved: unknown) {
    this._config = raw;
    this.config = resolved;
    this.ctx = { fiber: this };
  }

  public get rawConfig(): unknown {
    return this._config;
  }

  public get effectiveConfig(): unknown {
    return this.config;
  }
}

/** A fiber of the NEW core (4.0.6-alpha.2, 4.1.0): raw `config`, accessors. */
class NewFiber {
  public config: unknown;
  public readonly ctx: { fiber: NewFiber };
  readonly #effective: unknown;

  public constructor(raw: unknown, resolved: unknown) {
    this.config = raw;
    this.#effective = resolved;
    this.ctx = { fiber: this };
  }

  public get rawConfig(): unknown {
    return this.config;
  }

  public get effectiveConfig(): unknown {
    return this.#effective;
  }
}

type Listener = (this: unknown, ...args: unknown[]) => unknown;

/** The OLD core's waterfall: `this` is the fiber, the raw an argument. */
const oldWaterfall = (
  listeners: readonly Listener[],
  fiber: unknown,
  raw: unknown
): unknown => {
  const queue = [...listeners];
  const next = (): unknown => {
    const listener = queue.shift();
    return listener === undefined ? raw : listener.call(fiber, raw, next);
  };
  return next();
};

/** The NEW core's waterfall: `this` null, a `next` per listener, used once. */
const newWaterfall = (
  listeners: readonly Listener[],
  fiber: unknown,
  raw: unknown
): unknown => {
  const queue = [...listeners];
  const dispatch = (): unknown => {
    const listener = queue.shift();
    if (listener === undefined) {
      return raw;
    }
    let called = false;
    const next = (): unknown => {
      if (called) {
        throw new Error("next() called multiple times");
      }
      called = true;
      return dispatch();
    };
    return Reflect.apply(listener, null, [fiber, next]);
  };
  return dispatch();
};

describe("config-shape: isFiber", () => {
  it("accepts an object whose ctx.fiber is itself, on every core", () => {
    expect(isFiber(oldFiber({}, {}))).toBe(true);
    expect(isFiber(new AccessorFiber({}, {}))).toBe(true);
    expect(isFiber(new NewFiber({}, {}))).toBe(true);
  });

  it("rejects a config, another fiber's context, and every non-object", () => {
    const other = oldFiber({}, {});
    expect(isFiber({ providers: {} })).toBe(false);
    expect(isFiber({ ctx: { fiber: other } })).toBe(false);
    expect(isFiber({ ctx: null })).toBe(false);
    expect(isFiber({ ctx: "fiber" })).toBe(false);
    expect(isFiber(null)).toBe(false);
    expect(isFiber(ABSENT)).toBe(false);
    expect(isFiber("fiber")).toBe(false);
    expect(isFiber([other])).toBe(false);
  });
});

describe("config-shape: configCall, driven by each core's dispatch", () => {
  it("OLD: this is the fiber, and next is the last of (raw, next)", () => {
    const fiber = oldFiber({}, {});
    const raw = { providers: { deepseek: {} } };
    const seen: { shape: string; fiber: unknown; arg: unknown }[] = [];
    const answer = oldWaterfall(
      [
        function outer(this: unknown, ...args: unknown[]) {
          const call = configCall(this, args);
          seen.push({ arg: args[0], fiber: call.fiber, shape: call.shape });
          return call.next();
        },
      ],
      fiber,
      raw
    );
    expect(seen).toStrictEqual([{ arg: raw, fiber, shape: "old" }]);
    expect(answer).toBe(raw);
    expect(coreShapeOf(fiber)).toBe("old");
    expect(coreShapeOf(new AccessorFiber({}, {}))).toBe("old");
  });

  it("NEW: this is null, the fiber is the first argument, and the raw comes only through next()", () => {
    const raw = { providers: { deepseek: {} } };
    const fiber = new NewFiber(raw, ABSENT);
    const seen: { shape: string; fiber: unknown; value: unknown }[] = [];
    const answer = newWaterfall(
      [
        function outer(this: unknown, ...args: unknown[]) {
          const call = configCall(this, args);
          const value = call.next();
          seen.push({ fiber: call.fiber, shape: call.shape, value });
          return value;
        },
      ],
      fiber,
      raw
    );
    expect(seen).toStrictEqual([{ fiber, shape: "new", value: raw }]);
    expect(answer).toBe(raw);
    expect(coreShapeOf(fiber)).toBe("new");
  });

  it("NEW: a listener's next() runs the inner chain once; a second call throws", () => {
    const fiber = new NewFiber({}, ABSENT);
    expect(() =>
      newWaterfall(
        [
          function twice(this: unknown, ...args: unknown[]) {
            const call = configCall(this, args);
            call.next();
            return call.next();
          },
        ],
        fiber,
        {}
      )
    ).toThrow(/next\(\) called multiple times/u);
  });

  it("refuses a call in neither shape, so a third one cannot fall through", () => {
    const fiber = new NewFiber({}, ABSENT);
    const next = (): unknown => ({});
    // `this` undefined (a plain call in strict mode) is not the NEW shape.
    expect(() => configCall(ABSENT, [fiber, next])).toThrow(/neither shape/u);
    expect(() => configCall(null, [{ providers: {} }, next])).toThrow(
      /neither shape/u
    );
    expect(() => configCall(null, [fiber])).toThrow(/neither shape/u);
    expect(() => configCall({ runtime: {} }, [{}, next])).toThrow(
      /neither shape/u
    );
    expect(() => coreShapeOf({ providers: {} })).toThrow(/not a fiber/u);
  });
});

describe("config-shape: sameFiber, and a fiber read through another handle", () => {
  /** A handle like a loader entry's: a separate object whose ctx names the fiber. */
  const handleOf = (
    fiber: Record<string, unknown>
  ): Record<string, unknown> => ({
    ctx: fiber.ctx,
    runtime: fiber.runtime,
    uid: fiber.uid,
  });

  it("names one fiber by identity, or by its uid and runtime across handles", () => {
    const runtime = { name: "llm-pi-ai" };
    const fiber: Record<string, unknown> = {
      ...oldFiber({}, {}),
      runtime,
      uid: 5,
    };
    (fiber.ctx as Record<string, unknown>).fiber = fiber;
    const handle = handleOf(fiber);
    // Known answer: the handle is not the fiber, and is no fiber itself.
    expect(handle).not.toBe(fiber);
    expect(isFiber(handle)).toBe(false);
    expect(sameFiber(fiber, fiber)).toBe(true);
    expect(sameFiber(handle, fiber)).toBe(true);
    expect(coreShapeOf(handle)).toBe("old");
  });

  it("tells fibers apart by uid or runtime, and never matches a disposed one", () => {
    const runtime = { name: "llm-pi-ai" };
    const a = { runtime, uid: 5 };
    expect(sameFiber(a, { runtime, uid: 6 })).toBe(false);
    expect(sameFiber(a, { runtime: { name: "llm-pi-ai" }, uid: 5 })).toBe(
      false
    );
    expect(sameFiber({ runtime, uid: null }, { runtime, uid: null })).toBe(
      false
    );
    expect(sameFiber(a, null)).toBe(false);
    expect(sameFiber(ABSENT, a)).toBe(false);
  });
});

describe("config-shape: rawConfigOf and effectiveConfigOf", () => {
  it("OLD (4.0.5): raw is _config, the resolved value is config", () => {
    const raw = { providers: { deepseek: {} } };
    const resolved = { providers: { get: () => ({}) } };
    const fiber = oldFiber(raw, resolved);
    expect(rawConfigOf(fiber)).toBe(raw);
    expect(effectiveConfigOf(fiber)).toBe(resolved);
  });

  it("4.0.6-alpha.1: the accessors answer the OLD fields", () => {
    const raw = { a: 1 };
    const resolved = { a: 2 };
    const fiber = new AccessorFiber(raw, resolved);
    expect(rawConfigOf(fiber)).toBe(raw);
    expect(effectiveConfigOf(fiber)).toBe(resolved);
  });

  it("NEW (4.0.6-alpha.2, 4.1.0): raw is config, the resolved value is effectiveConfig", () => {
    const raw = { providers: { deepseek: {} } };
    const resolved = { providers: { get: () => ({}) } };
    const fiber = new NewFiber(raw, resolved);
    expect(rawConfigOf(fiber)).toBe(raw);
    expect(rawConfigOf(fiber)).toBe(fiber.config);
    expect(effectiveConfigOf(fiber)).toBe(resolved);
  });

  it("a fiber not yet resolved, and a non-object, answer undefined", () => {
    expect(effectiveConfigOf(new NewFiber({}, ABSENT))).toBeUndefined();
    expect(rawConfigOf(null)).toBeUndefined();
    expect(rawConfigOf("config")).toBeUndefined();
    expect(effectiveConfigOf(ABSENT)).toBeUndefined();
    expect(effectiveConfigOf([])).toBeUndefined();
  });
});
