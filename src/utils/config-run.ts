/**
 * An `internal/config` run, and a fiber's two configs, read the same way on
 * either host core: told apart by the shape of each call and the fields of
 * the fiber, never by a version.
 *
 * - **OLD** (cordis 4.0.5, 4.0.6-alpha.1) calls a listener as
 *   `function (this: Fiber, raw, next)`, every listener sharing the raw
 *   candidate as an argument. The fiber keeps the raw input in `_config` and
 *   the resolved value in `config`; 4.0.6-alpha.1 adds the
 *   `rawConfig`/`effectiveConfig` accessors over those two fields.
 * - **NEW** (cordis 4.0.6-alpha.2 and 4.1.0) calls it as `(fiber, next)` with
 *   `this === null`; the raw candidate is reachable only through `next()`,
 *   and a second `next()` throws. `config` is the RAW input (`rawConfig` is
 *   an accessor over it), `_config` is gone, and the resolved value is
 *   readable only through `effectiveConfig`.
 *
 * On both, `next` is the LAST argument, and an innermost listener's `next()`
 * answers the run's raw candidate. A fiber is recognised structurally: its
 * own context names it (`fiber.ctx.fiber === fiber`), which neither a config
 * value nor another fiber's context does. The shape is a property of the
 * call, not of the installed core, so a caller that still dispatches the old
 * shape on a new core is read correctly too.
 *
 * @module dsh-opencode-patch/utils/config-run
 */

import { isFunctionLike, isRecord } from "./guards.ts";

/**
 * True for a cordis fiber: an object whose own context's `fiber` is itself.
 *
 * @param value - anything.
 * @returns whether `value` is a fiber.
 */
export const isFiber = (value: unknown): boolean =>
  isRecord(value) && isRecord(value.ctx) && value.ctx.fiber === value;

/** One `internal/config` call, decoded from whichever shape it arrived in. */
export interface ConfigRun {
  /** The fiber the run is for: `this` on the OLD shape, the first argument on the NEW one, else `undefined`. */
  readonly fiber: unknown;
  /** The rest of the chain: the last argument on both shapes, or `undefined` when the call carried none. */
  readonly next: (() => unknown) | undefined;
}

/**
 * Decode an `internal/config` listener's call.
 *
 * @param thisArg - the listener's `this` (the fiber on the OLD shape).
 * @param args - the listener's arguments (the fiber first on the NEW shape;
 *   `next` last on both).
 * @returns the run's fiber and `next`, each `undefined` when the call does
 *   not carry one.
 */
export const configRunOf = (
  thisArg: unknown,
  args: readonly unknown[]
): ConfigRun => {
  const last = args.at(-1);
  const next = isFunctionLike(last) ? last : undefined;
  if (isFiber(thisArg)) {
    return { fiber: thisArg, next };
  }
  return { fiber: isFiber(args[0]) ? args[0] : undefined, next };
};

/**
 * A fiber's RAW config: the input it retains for its next activation.
 *
 * @param fiber - a fiber of either core.
 * @returns `rawConfig` where the core has it, else `_config`.
 */
export const rawConfigOf = (fiber: unknown): unknown => {
  if (!isRecord(fiber)) {
    return undefined;
  }
  return "rawConfig" in fiber ? fiber.rawConfig : fiber._config;
};

/**
 * A fiber's RESOLVED config: the value its plugin was activated or last
 * updated with.
 *
 * @param fiber - a fiber of either core.
 * @returns `effectiveConfig` where the core has it, else `config`.
 */
export const effectiveConfigOf = (fiber: unknown): unknown => {
  if (!isRecord(fiber)) {
    return undefined;
  }
  return "effectiveConfig" in fiber ? fiber.effectiveConfig : fiber.config;
};

/**
 * The config the loader stores for a fiber's row (`entry.options.config`),
 * which a loader update hands `update()` itself.
 *
 * @param fiber - a fiber of either core.
 * @returns the stored row config, or `undefined` for a fiber with no entry.
 */
export const entryConfigOf = (fiber: unknown): unknown => {
  const entry = isRecord(fiber) ? fiber.entry : undefined;
  const options = isRecord(entry) ? entry.options : undefined;
  return isRecord(options) ? options.config : undefined;
};

/**
 * Whether an `internal/config` run is a COMMIT (the value the fiber is
 * activated or updated with) rather than a candidate being checked (a
 * Settings save the config editor resolves before it writes).
 *
 * A commit is recognised by identity, on either core: the run's raw value is
 * the fiber's own raw config (an activation, a restart, a volatile run, and
 * the OLD core's `update()`, which stores the raw value before it resolves),
 * or the loader's stored row config (the NEW core's `update()` resolves
 * BEFORE it stores, and the loader hands it `entry.options.config`). A fiber
 * that is not ACTIVE is mid-activation, and every run of an activation is a
 * commit: on the NEW core a FAILED fiber recovers only through `update()`,
 * so an activation run must never be judged as a candidate (and refused).
 *
 * @param raw - the run's raw value, as `next()` answered it.
 * @param fiber - the fiber the run is for.
 * @param active - the fiber state that means ACTIVE.
 * @returns whether the run is a commit.
 */
export const isCommitRun = (
  raw: unknown,
  fiber: unknown,
  active: number
): boolean => {
  if (!isRecord(fiber)) {
    return false;
  }
  if (fiber.state !== active) {
    return true;
  }
  if (raw === rawConfigOf(fiber)) {
    return true;
  }
  const stored = entryConfigOf(fiber);
  return stored !== undefined && raw === stored;
};
