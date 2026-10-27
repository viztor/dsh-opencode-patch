/**
 * A stand-in host for the route claim's clauses (`src/host/route-claim.ts`).
 *
 * Kept on purpose: these model fiber states the real host cannot be put in on
 * demand — a pi-ai fiber LOADING or FAILED, a plugin fiber whose `uid` is
 * already `null`, a registry that refuses — and `host-planes` covers the real
 * host. The stand-in records what the claim registered, and the pi-ai fiber is
 * a plain object the claim reads through `ctx.registry`.
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
  ctx: { waterfall?: (...args: unknown[]) => unknown };
  entry?: unknown;
  parent?: { fiber: { state: number } };
  await: () => Promise<unknown>;
  restart: () => Promise<unknown>;
}

export const zen = { models: [{ id: "deepseek-v4-pro" }] };

/** A pi-ai fiber that holds `providers` raw and resolves `resolved`. */
export const piFiber = (
  providers?: Record<string, unknown>,
  resolved?: Record<string, unknown>
): FakeFiber => ({
  _config: { providers: providers ?? { deepseek: {}, opencode: zen } },
  await: vi.fn(async () => {
    // the stand-in fiber is settled already
  }),
  config: { providers: { get: () => resolved ?? { deepseek: {} } } },
  ctx: {
    waterfall: (
      _fiber: unknown,
      _name: unknown,
      _raw: unknown,
      inner: unknown
    ) => (inner as () => unknown)(),
  },
  entry: { options: { id: "llm-pi-ai" } },
  parent: { fiber: { state: 2 } },
  restart: vi.fn(async () => {
    // a restart the stand-in records and does not perform
  }),
  runtime: { name: "llm-pi-ai" },
  state: 2,
  uid: 1,
});

/** What {@link standIn} records, and the context it hands the claim. */
export interface StandIn {
  readonly cleanups: (() => unknown)[];
  readonly ctx: CordisContext;
  readonly fiber: { uid: number | null };
  readonly handle: Mock & { replace: Mock };
  readonly info: Mock;
  readonly listeners: Map<string, Listener>;
  readonly llm: Record<string, unknown> & {
    readonly registerAdapter: Mock<
      (routes: readonly string[], adapter: unknown) => unknown
    >;
  };
  /** Run the `llm` inject callback again, as cordis does for a new scope. */
  readonly reinject: (scope: Record<string, unknown>) => void;
  readonly warn: Mock;
}

/** A stand-in plugin context: records listeners, effects and registrations. */
export const standIn = (
  options: {
    fibers?: () => FakeFiber[];
    llm?: Record<string, unknown>;
    uid?: number | null;
  } = {}
): StandIn => {
  const listeners = new Map<string, Listener>();
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
    on: (event: string, listener: Listener) => {
      listeners.set(event, listener);
    },
    registry: {
      values: () => [
        { fibers: options.fibers?.() ?? [], name: "llm-pi-ai" },
        { fibers: [], name: "other" },
      ],
    },
  } as unknown as CordisContext;
  /** Run the `llm` inject callback again, as cordis does for a new scope. */
  const reinject = (scope: Record<string, unknown>): void => {
    injected?.({ effect, ...scope });
  };
  return {
    cleanups,
    ctx,
    fiber,
    handle,
    info,
    listeners,
    llm,
    reinject,
    warn,
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
