/**
 * The plugin mounted on a genuine cordis `Context`, the way the Loader does.
 *
 * A unit test that means "the plugin, applied" mounts it here rather than
 * handing `apply` an object literal: `ctx.plugin({ apply, Config, inject,
 * name }, config)` is the module's own exports and the row's config, which is
 * what the Loader hands cordis — so the schema resolves the config (and an
 * invalid one fails the fiber), the fiber carries the plugin's name, cordis
 * keys the runtime on the module's own `apply` (repeated activations on one
 * root are fibers of ONE runtime, as the Loader's are), and
 * cordis itself decides when each part runs: the root at once, the `llm`
 * scope once that service exists. `fiber.dispose()` runs the plugin's own
 * effects in reverse, which is the only teardown a deployment has. A stand-in
 * whose `effect` does nothing never runs a disposer, so a restore bug is
 * invisible to it by construction.
 *
 * {@link degradedHost} is the one stand-in for the plugin's COMPOSITION, for
 * the diagnostics a real `Context` cannot reach, because a real one registers
 * what it is asked to and always has `plugin`: (1) a `plugin` that registers
 * nothing, with and without `get`, which drives the three unreachable-service
 * diagnostics; (2) a composition with no `plugin`, or with neither `plugin`
 * nor `provide`. Even there `effect` runs
 * its callback and keeps the disposer, so nothing it installs outlives the
 * case. (The route claim's clause tests keep a stand-in host of their own,
 * `route-claim-stand-in.ts`, for fiber states a real host cannot be put in on
 * demand; that is a module under test, not the composition.)
 *
 * @module test/support/composition
 */
import { Context, type Fiber } from "@deepseek-ai/cordis";

import { FIBER_STATE, logLines, until } from "./cordis-wait.ts";
import { apply, Config, type CordisContext, inject, name } from "./src.ts";

export { until };

/** What {@link mountPlugin} takes. */
export interface MountOptions {
  /** A context to mount on again (a second activation on one root). */
  readonly ctx?: Context;
  /**
   * The plugin's row config, resolved through its schema as the Loader's is;
   * omitted, the shipped defaults apply.
   */
  readonly config?: Record<string, unknown>;
  /** An `llm` service to provide before the mount; omitted, none exists. */
  readonly llm?: object;
}

/** A mounted plugin. */
export interface MountedPlugin {
  readonly ctx: Context;
  readonly fiber: Fiber;
  /**
   * Whether the fiber is active once awaited (it waits for nothing: `inject`
   * is empty). Read off the fiber, so the mount passes the module's own
   * `apply` and repeated activations share one cordis runtime, as the
   * Loader's do.
   */
  readonly activated: () => boolean;
  /** Every line any logger wrote since the mount began. */
  readonly lines: () => string[];
}

/** Fibers mounted and not yet disposed, for {@link disposeMounted}. */
const live = new Set<Fiber>();

/**
 * Mount the plugin the way the Loader does.
 *
 * The module's exports — `apply`, `Config`, `inject`, `name` — with the row
 * config as the second argument. `inject` is the plugin's OWN declaration —
 * empty, so the root activates before `llm` exists and everything that needs
 * `llm` waits in a child scope — and cordis itself decides when each part
 * runs. The fiber is awaited, which
 * is the plugin's `apply` returning (the route claim's mount); anything that
 * settles later is waited for with {@link until}, never with a fixed sleep.
 *
 * @param options - the context, config and `llm` service.
 * @returns the mounted plugin; {@link disposeMounted} disposes it.
 */
export const mountPlugin = async (
  options: MountOptions = {}
): Promise<MountedPlugin> => {
  const ctx = options.ctx ?? new Context();
  const log = logLines(ctx);
  if (options.llm !== undefined) {
    ctx.provide("llm", options.llm as never);
  }
  const fiber = ctx.plugin(
    { apply, Config, inject, name } as never,
    (options.config ?? {}) as never
  );
  live.add(fiber);
  await fiber.await();
  return {
    activated: () => {
      // cordis's `FiberState` is a const enum; read it as the number it is.
      const state: number = fiber.state;
      return state === FIBER_STATE.ACTIVE;
    },
    ctx,
    fiber,
    lines: () => log.lines(),
  };
};

/**
 * Dispose every fiber {@link mountPlugin} mounted, latest first, so the
 * patched `fetch` never leaks into the next case. Latest first is the order
 * that unwinds nested patches cleanly; the other order is P6's open defect
 * (an earlier activation's patch outlives two overlapping ones).
 */
export const disposeMounted = async (): Promise<void> => {
  const fibers = [...live].toReversed();
  live.clear();
  for (const fiber of fibers) {
    await fiber.dispose();
  }
};

/** What {@link degradedHost} takes: the parts a degraded composition has. */
export interface DegradedOptions {
  readonly get?: (name: string) => unknown;
  readonly plugin?: (...args: unknown[]) => unknown;
  readonly provide?: (name: string, value: unknown) => void;
  readonly logger: {
    readonly info?: (...args: unknown[]) => void;
    readonly warn?: (...args: unknown[]) => void;
  };
}

/** A degraded composition, and the disposers its effects returned. */
export interface DegradedHost {
  readonly ctx: CordisContext;
  /** Run every collected disposer, latest first. */
  readonly dispose: () => void;
}

/**
 * A composition a real `Context` cannot stand for: a `plugin` that registers
 * nothing (with or without `get`), or one missing `plugin`, or `provide` too.
 * Its `effect` runs the callback and records the disposer, as
 * cordis does, so the fetch patch it installs is restored by `dispose()`.
 *
 * @param options - the parts the composition has.
 * @returns the host and its teardown.
 */
export const degradedHost = (options: DegradedOptions): DegradedHost => {
  const disposers: (() => void)[] = [];
  const ctx = {
    effect: (callback: () => unknown) => {
      const disposer = callback();
      if (typeof disposer === "function") {
        disposers.push(disposer as () => void);
      }
    },
    ...(options.get === undefined ? {} : { get: options.get }),
    llm: {},
    logger: options.logger,
    on: () => {
      // a degraded composition attaches no stream hook anyone drives
    },
    ...(options.plugin === undefined ? {} : { plugin: options.plugin }),
    ...(options.provide === undefined ? {} : { provide: options.provide }),
  } as unknown as CordisContext;
  return {
    ctx,
    dispose: () => {
      for (const disposer of disposers.splice(0).toReversed()) {
        disposer();
      }
    },
  };
};
