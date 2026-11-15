/**
 * An `internal/config` call, and a fiber's two configs, read the same way on
 * either host core: told apart by the shape of the call and the fields of the
 * fiber, never by a version.
 *
 * - **OLD** (cordis 4.0.5, 4.0.6-alpha.1) calls a listener as
 *   `function (this: Fiber, raw, next)`, every listener sharing the raw
 *   candidate as an argument. The fiber keeps the raw input in `_config` and
 *   the resolved value in `config`; 4.0.6-alpha.1 adds the
 *   `rawConfig`/`effectiveConfig` accessors over those two fields.
 * - **NEW** (cordis 4.0.6-alpha.2, 4.1.0, which both channel records run)
 *   calls it as `(fiber, next)` with `this === null`; the raw candidate is
 *   reachable only through `next()`, and the schema is a built-in listener.
 *   `config` is the RAW input (`rawConfig` is an accessor over it), `_config`
 *   is gone, and the resolved value is readable only through
 *   `effectiveConfig`.
 *
 * A fiber is recognised structurally: its own context names it
 * (`fiber.ctx.fiber === fiber`), which neither a config value nor another
 * fiber's context does. The fiber predicate and the two feature-detected
 * accessors are the plugin's own (`src/utils/config-run.ts`, which the route
 * claim reads every fiber config through), re-exported here so a contract
 * and the claim cannot read a fiber two ways. What stays here is what only a
 * contract needs: decoding a call strictly (a third shape throws), the core
 * a fiber was built by, and naming one fiber across handles. Pure: every
 * function is one of its arguments, so `test/config-shape.test.ts` drives
 * both shapes with known answers, the OLD one included, which no supported
 * channel's newest build runs any more.
 *
 * @module test/support/config-shape
 */

import { effectiveConfigOf, isFiber, rawConfigOf } from "./src.ts";

export { effectiveConfigOf, isFiber, rawConfigOf };

/** The two `internal/config` call shapes. */
export type ConfigShape = "new" | "old";

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** One `internal/config` call, decoded from the shape it arrived in. */
export interface ConfigCall<F = unknown> {
  readonly shape: ConfigShape;
  /** The fiber the run is for: `this` on OLD, the first argument on NEW. */
  readonly fiber: F;
  /** The rest of the chain: the last argument on both shapes. */
  readonly next: () => unknown;
}

/**
 * Decode an `internal/config` listener's call: OLD when `this` is a fiber,
 * NEW when `this` is null and the first argument is one. Anything else
 * throws, so a third shape cannot pass a contract by falling through.
 *
 * @param thisArg - the listener's `this`.
 * @param args - the listener's arguments.
 * @returns the shape, the fiber and `next`.
 */
export const configCall = <F = unknown>(
  thisArg: unknown,
  args: readonly unknown[]
): ConfigCall<F> => {
  const next = args.at(-1);
  if (typeof next === "function") {
    if (isFiber(thisArg)) {
      return {
        fiber: thisArg as F,
        next: next as () => unknown,
        shape: "old",
      };
    }
    if (thisArg === null && isFiber(args[0])) {
      return {
        fiber: args[0] as F,
        next: next as () => unknown,
        shape: "new",
      };
    }
  }
  throw new Error("an internal/config call in neither shape");
};

/**
 * Whether two handles name the same fiber. A handle read through a context
 * (a loader entry's `fiber`, say) can be a different object from the one a
 * waterfall hands its listeners, so identity alone answers false for one
 * fiber; the uid (unique in its registry, `null` once disposed) and the
 * shared plugin runtime together do not.
 *
 * @param a - a fiber handle.
 * @param b - another.
 * @returns whether both name one live fiber.
 */
export const sameFiber = (a: unknown, b: unknown): boolean =>
  a === b ||
  (isObject(a) &&
    isObject(b) &&
    typeof a.uid === "number" &&
    a.uid === b.uid &&
    a.runtime === b.runtime);

/**
 * The core a fiber was built by, read off its own fields: only the OLD core
 * keeps the raw input in an own `_config`. Independent of any call, so a
 * contract can check the shape a listener saw against the fiber it was for.
 *
 * @param fiber - a fiber, or a handle whose context names one.
 * @returns `"old"` or `"new"`; throws for a value that names no fiber.
 */
export const coreShapeOf = (fiber: unknown): ConfigShape => {
  const self = isObject(fiber) && isObject(fiber.ctx) ? fiber.ctx.fiber : null;
  if (!isFiber(self)) {
    throw new Error("not a fiber");
  }
  return Object.hasOwn(self as object, "_config") ? "old" : "new";
};
