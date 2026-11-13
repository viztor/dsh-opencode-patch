/**
 * A stand-in host for the route claim's clauses (`src/host/route-claim.ts`).
 *
 * Kept on purpose: these model fiber states the real host cannot be put in on
 * demand — a pi-ai fiber LOADING or FAILED, a plugin fiber whose `uid` is
 * already `null`, a registry that refuses — and `host-planes` covers the real
 * host. The stand-in records what the claim registered, and the pi-ai fiber is
 * a plain object the claim reads through `ctx.registry`.
 *
 * Both cordis cores are modelled, each from the fiber's own fields: the OLD
 * core's fiber (`piFiber`: `_config` raw, `config` resolved), whose listener a
 * case calls as `function (this: Fiber, raw, next)` (`oldRun`), and the NEW
 * core's (`newPiFiber`: `config` raw, `effectiveConfig` resolved, no
 * `_config`), whose `internal/config` the stand-in runs as cordis does, each
 * listener `(fiber, next)` with `this` null, outermost first (`waterfall`),
 * and whose status events it emits to every live listener (`emit`).
 *
 * @module test/support/route-claim-stand-in
 */
import { type Mock, vi } from "vitest";

import { hostModulesForTests } from "./host.ts";
import {
  type CordisContext,
  type HostModuleSource,
  replaceHostModuleSource,
} from "./src.ts";

let restore: (() => void) | undefined;

export const flush = async (): Promise<void> => {
  for (let index = 0; index < 5; index += 1) {
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
  }
};

export type Listener = (this: unknown, ...args: unknown[]) => unknown;

export interface FakeFiber {
  uid: number | null;
  state: number;
  runtime: { name: string };
  _config: { providers: Record<string, unknown> };
  config: { providers: { get: () => Record<string, unknown> } };
  ctx: { fiber?: unknown };
  entry?: unknown;
  parent?: { fiber: { state: number } };
  await: () => Promise<unknown>;
  restart: () => Promise<unknown>;
}

export const zen = { models: [{ id: "deepseek-v4-pro" }] };

/**
 * A pi-ai fiber of the OLD core (cordis 4.0.5): `_config` raw, `config`
 * resolved, holding `providers` raw and resolving `resolved`. Its own context
 * names it, as a real fiber's does.
 */
export const piFiber = (
  providers?: Record<string, unknown>,
  resolved?: Record<string, unknown>
): FakeFiber => {
  const fiber: FakeFiber = {
    _config: { providers: providers ?? { deepseek: {}, opencode: zen } },
    await: vi.fn(async () => {
      // the stand-in fiber is settled already
    }),
    config: { providers: { get: () => resolved ?? { deepseek: {} } } },
    ctx: {},
    entry: { options: { id: "llm-pi-ai" } },
    parent: { fiber: { state: 2 } },
    restart: vi.fn(async () => {
      // a restart the stand-in records and does not perform
    }),
    runtime: { name: "llm-pi-ai" },
    state: 2,
    uid: 1,
  };
  fiber.ctx.fiber = fiber;
  return fiber;
};

/**
 * Run the listener in the OLD core's shape, `function (this: Fiber, raw,
 * next)`, as the innermost listener of the run: `next()` answers the raw
 * candidate itself, as cordis's innermost callback does.
 */
export const oldRun = (
  listener: Listener | undefined,
  fiber: unknown,
  raw: unknown
): unknown => listener?.call(fiber, raw, () => raw);

/** A NEW-core fiber's own fields, as the claim reads them. */
export interface NewFakeFiber {
  uid: number | null;
  state: number;
  runtime: { name: string };
  /** The RAW config on the NEW core (`rawConfig` is an accessor over it). */
  config: { providers: Record<string, unknown> };
  readonly rawConfig: unknown;
  readonly effectiveConfig: unknown;
  ctx: { fiber?: unknown };
  entry: { options: { id: string; config?: unknown } };
  parent: { fiber: { state: number } };
  await: () => Promise<unknown>;
  restart: () => Promise<unknown>;
}

/**
 * A pi-ai fiber of the NEW core (cordis 4.0.6-alpha.2, 4.1.0,
 * `fiber.ts:190,211,649-666`): `config` is the RAW input, `rawConfig` an
 * accessor over it, the resolved value readable only through
 * `effectiveConfig`, and no `_config`. Its own context names it.
 */
export const newPiFiber = (
  providers?: Record<string, unknown>,
  resolved?: Record<string, unknown>
): NewFakeFiber => {
  const fiber = {
    await: vi.fn(async () => {
      // the stand-in fiber is settled already
    }),
    config: { providers: providers ?? { deepseek: {}, opencode: zen } },
    ctx: {} as { fiber?: unknown },
    get effectiveConfig(): unknown {
      return { providers: { get: () => resolved ?? { deepseek: {} } } };
    },
    entry: { options: { id: "llm-pi-ai" } as { id: string; config?: unknown } },
    parent: { fiber: { state: 2 } },
    get rawConfig(): unknown {
      return fiber.config;
    },
    restart: vi.fn(async () => {
      // a restart the stand-in records and does not perform
    }),
    runtime: { name: "llm-pi-ai" },
    state: 2,
    uid: 1 as number | null,
  };
  fiber.ctx.fiber = fiber;
  return fiber;
};

/** A plane entry pi-ai's own check refuses: a model with an empty id. */
export const MALFORMED = { models: [{ id: "" }, { id: "x" }] };

/** What {@link standIn} records, and the context it hands the claim. */
export interface StandIn {
  readonly cleanups: (() => unknown)[];
  readonly ctx: CordisContext;
  /** Emit an event to every live listener, `this` null, as cordis's `emit` does. */
  readonly emit: (event: string, ...args: unknown[]) => void;
  readonly fiber: { uid: number | null };
  readonly handle: Mock & { replace: Mock };
  /** Every live listener per event, outermost first, as cordis keeps them. */
  readonly hooks: Map<string, Listener[]>;
  readonly info: Mock;
  /** The last listener registered per event. */
  readonly listeners: Map<string, Listener>;
  readonly llm: Record<string, unknown> & {
    readonly registerAdapter: Mock<
      (routes: readonly string[], adapter: unknown) => unknown
    >;
  };
  /** Run the `llm` inject callback again, as cordis does for a new scope. */
  readonly reinject: (scope: Record<string, unknown>) => void;
  readonly warn: Mock;
  /**
   * Run `internal/config` the way the NEW core does: each listener as
   * `(fiber, next)` with `this` null, outermost first; the innermost `next()`
   * answers `raw()`.
   */
  readonly waterfall: (target: unknown, raw: () => unknown) => unknown;
}

/** A stand-in plugin context: records listeners, effects and registrations. */
export const standIn = (
  options: {
    fibers?: () => readonly object[];
    llm?: Record<string, unknown>;
    uid?: number | null;
  } = {}
): StandIn => {
  const listeners = new Map<string, Listener>();
  /** Every live listener per event, outermost first, as cordis keeps them. */
  const hooks = new Map<string, Listener[]>();
  const cleanups: (() => unknown)[] = [];
  const warn = vi.fn();
  const info = vi.fn();
  const handle = Object.assign(vi.fn(), { replace: vi.fn() });
  const llm = {
    listProviders: () => [{ id: "deepseek" }],
    registerAdapter: vi.fn(
      (_routes: readonly string[], _adapter: unknown) => handle
    ),
    ...options.llm,
  };
  const fiber = { uid: options.uid === undefined ? 1 : options.uid };
  let injected: ((scope: unknown) => void) | undefined;
  const effect = (fn: () => unknown) => {
    const cleanup = fn();
    if (typeof cleanup === "function") {
      cleanups.push(cleanup as () => unknown);
    }
  };
  const ctx = {
    effect,
    fiber,
    get: (name: string) => (name === "llm" ? llm : undefined),
    inject: (deps: string[], callback: (scope: unknown) => void) => {
      injected = callback;
      callback(deps.includes("llm") ? { effect, llm } : {});
    },
    logger: { info, warn },
    on: (
      event: string,
      listener: Listener,
      placement: { prepend?: boolean } = {}
    ) => {
      listeners.set(event, listener);
      const list = hooks.get(event) ?? [];
      if (placement.prepend === true) {
        list.unshift(listener);
      } else {
        list.push(listener);
      }
      hooks.set(event, list);
      return () => {
        const at = list.indexOf(listener);
        if (at !== -1) {
          list.splice(at, 1);
        }
      };
    },
    registry: {
      values: () => [
        { fibers: options.fibers?.() ?? [], name: "llm-pi-ai" },
        { fibers: [], name: "other" },
      ],
    },
  } as unknown as CordisContext;
  /**
   * Run `internal/config` the way the NEW core does (cordis 4.0.6-alpha.2,
   * 4.1.0, `events.ts:246-261`): each listener as `(fiber, next)` with `this`
   * null, outermost first, each with its own `next`, which throws when called
   * twice; the innermost `next()` answers `raw()`.
   */
  const waterfall = (target: unknown, raw: () => unknown): unknown => {
    const chain = (hooks.get("internal/config") ?? []).toSpliced(0, 0);
    const step = (index: number): (() => unknown) => {
      let called = false;
      return () => {
        if (called) {
          throw new Error("next() called multiple times");
        }
        called = true;
        const listener = chain[index];
        return listener === undefined
          ? raw()
          : Reflect.apply(listener, null, [target, step(index + 1)]);
      };
    };
    return step(0)();
  };
  /** Emit an event to every live listener, `this` null, as cordis's `emit` does. */
  const emit = (event: string, ...args: unknown[]): void => {
    const live = hooks.get(event);
    if (live === undefined) {
      return;
    }
    for (const listener of live.toSpliced(0, 0)) {
      Reflect.apply(listener, null, args);
    }
  };
  /** Run the `llm` inject callback again, as cordis does for a new scope. */
  const reinject = (scope: Record<string, unknown>): void => {
    injected?.({ effect, ...scope });
  };
  return {
    cleanups,
    ctx,
    emit,
    fiber,
    handle,
    hooks,
    info,
    listeners,
    llm,
    reinject,
    warn,
    waterfall,
  };
};

/** The model a registered adapter's profile serves for a route. */
export const servedModel = (
  adapter: unknown,
  route: string,
  id: string
): Record<string, unknown> | undefined => {
  const { config: options } = adapter as {
    config: {
      profiles: () => ReadonlyMap<string, { piProvider?: unknown }>;
    };
  };
  const provider = options.profiles().get(route)?.piProvider as
    | { getModels: () => Record<string, unknown>[] }
    | undefined;
  return provider?.getModels().find((model) => model.id === id);
};

/** Serve the host's modules through the seam, until {@link restoreTestModules}. */
export const useTestModules = (
  source: HostModuleSource = hostModulesForTests()
): void => {
  restore = replaceHostModuleSource(source);
};

/** Put the default host-module source back; every case's `afterEach` runs it. */
export const restoreTestModules = (): void => {
  restore?.();
  restore = undefined;
};
