/**
 * The route claim's clauses on a stand-in host (`src/host/route-claim.ts`).
 *
 * The behaviour on the real host — who owns the planes, how often pi-ai
 * restarts, the lifecycle and the config flow — is pinned in
 * `test/host-planes.test.ts` and the characterization. This file drives the
 * branches a real composition reaches only by accident: a host without the
 * cordis members the claim needs, a registry that refuses, a pi-ai that
 * fails, restarts or goes away, and the teardown's handback with its
 * diagnostics. The stand-in records what the claim registered, and the pi-ai
 * fiber is a plain object the claim reads through `ctx.registry`.
 *
 * @module test/route-claim.test
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { hostModulesForTests } from "./support/host.ts";
import {
  catalogListenerCount,
  type CordisContext,
  type HostModuleSource,
  installRouteClaim,
  refreshCatalog,
  replaceHostModuleSource,
  resolveConfig,
} from "./support/src.ts";

let restore: (() => void) | undefined;

afterEach(() => {
  restore?.();
  restore = undefined;
  vi.restoreAllMocks();
});

const flush = async (): Promise<void> => {
  for (let index = 0; index < 5; index += 1) {
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
  }
};

type Listener = (this: unknown, ...args: unknown[]) => unknown;

interface FakeFiber {
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

const zen = { models: [{ id: "deepseek-v4-pro" }] };

/**
 * A pi-ai fiber of the OLD core (cordis 4.0.5): `_config` raw, `config`
 * resolved, holding `providers` raw and resolving `resolved`. Its own context
 * names it, as a real fiber's does.
 */
const piFiber = (
  providers?: Record<string, unknown>,
  resolved?: Record<string, unknown>
): FakeFiber => {
  const fiber: FakeFiber = {
    _config: { providers: providers ?? { deepseek: {}, opencode: zen } },
    await: vi.fn(async () => {}),
    config: { providers: { get: () => resolved ?? { deepseek: {} } } },
    ctx: {},
    entry: { options: { id: "llm-pi-ai" } },
    parent: { fiber: { state: 2 } },
    restart: vi.fn(async () => {}),
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
const oldRun = (
  listener: Listener | undefined,
  fiber: unknown,
  raw: unknown
): unknown => listener?.call(fiber, raw, () => raw);

/** A stand-in plugin context: records listeners, effects and registrations. */
const standIn = (
  options: {
    fibers?: () => readonly object[];
    llm?: Record<string, unknown>;
    uid?: number | null;
  } = {}
) => {
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
const servedModel = (
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

const useTestModules = (
  source: HostModuleSource = hostModulesForTests()
): void => {
  restore = replaceHostModuleSource(source);
};

const config = resolveConfig();

describe("route-claim · standing down", () => {
  it("leaves the planes to pi-ai on a host without the cordis members it needs, and says which", async () => {
    const warn = vi.fn();
    const claim = installRouteClaim(
      { logger: { warn } } as unknown as CordisContext,
      config
    );
    await expect(claim.mounted).resolves.toBeUndefined();
    expect(claim.committedEntries()).toEqual({});
    expect(claim.piAiNamespace()).toBe("llm-pi-ai");
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("offers no on, inject, effect")
    );
  });

  it("hands the planes back when the host's modules cannot be read, and says so", async () => {
    useTestModules({
      libraries: async () => {},
      piAi: async () => {},
    });
    const pi = piFiber();
    const host = standIn({ fibers: () => [pi] });
    await installRouteClaim(host.ctx, config).mounted;
    await flush();
    expect(host.llm.registerAdapter).not.toHaveBeenCalled();
    expect(pi.restart).toHaveBeenCalledTimes(1);
    expect(host.warn).toHaveBeenCalledWith(
      expect.stringContaining("unavailable; the plane routes stay pi-ai's")
    );
    // Inert from here: the listener passes through.
    expect(oldRun(host.listeners.get("internal/config"), pi, pi._config)).toBe(
      pi._config
    );
  });

  it("when the modules cannot be read at mount and pi-ai already holds a plane, it stands down with no restart at all", async () => {
    useTestModules({
      libraries: async () => {},
      piAi: async () => {},
    });
    const pi = piFiber(undefined, { deepseek: {}, opencode: {} });
    const host = standIn({ fibers: () => [pi] });
    await installRouteClaim(host.ctx, config).mounted;
    await flush();
    // A restart would strip the planes through the still-active listener,
    // and the handback would need a second to give them back.
    expect(pi.restart).not.toHaveBeenCalled();
    expect(host.llm.registerAdapter).not.toHaveBeenCalled();
    const unavailable = host.warn.mock.calls.filter(([message]) =>
      String(message).includes("unavailable; the plane routes stay pi-ai's")
    );
    expect(unavailable).toHaveLength(1);
    expect(oldRun(host.listeners.get("internal/config"), pi, pi._config)).toBe(
      pi._config
    );
  });

  it("with the modules unreadable and no plane declared, the claim stands down, says so exactly once, and a Settings save adding a plane reaches pi-ai's own check", async () => {
    useTestModules({
      libraries: async () => {},
      piAi: async () => {},
    });
    const pi = piFiber({ deepseek: {} });
    const host = standIn({ fibers: () => [pi] });
    await installRouteClaim(host.ctx, config).mounted;
    await flush();
    host.listeners.get("llm/adapters-updated")?.();
    await flush();
    host.listeners.get("llm/adapters-updated")?.();
    await flush();
    const unavailable = host.warn.mock.calls.filter(([message]) =>
      String(message).includes("unavailable; the plane routes stay pi-ai's")
    );
    expect(unavailable).toHaveLength(1);
    // Nothing was declared, so the handback had nothing to give back.
    expect(pi.restart).not.toHaveBeenCalled();
    expect(host.llm.registerAdapter).not.toHaveBeenCalled();
    // The module lookup never recovers within a live row: an active claim
    // would refuse this save with "try the save again" for good. Inert, it
    // hands the candidate to pi-ai unstripped, whose own check decides.
    const listener = host.listeners.get("internal/config");
    const candidate = { providers: { deepseek: {}, opencode: zen } };
    expect(oldRun(listener, pi, candidate)).toBe(candidate);
    // And the commit run that follows passes through untouched.
    pi._config = candidate;
    expect(oldRun(listener, pi, pi._config)).toBe(pi._config);
    await flush();
    expect(host.llm.registerAdapter).not.toHaveBeenCalled();
  });

  it("a stand-down after a registration releases the plugin's handle before pi-ai restarts", async () => {
    const real = hostModulesForTests();
    let readable = true;
    useTestModules({
      libraries: real.libraries,
      piAi: async (...args) => (readable ? real.piAi(...args) : undefined),
    });
    const pi = piFiber();
    const host = standIn({ fibers: () => [pi] });
    await installRouteClaim(host.ctx, config).mounted;
    await flush();
    expect(host.llm.registerAdapter).toHaveBeenCalledTimes(1);
    expect(pi.restart).not.toHaveBeenCalled();
    // pi-ai's entry is reloaded and its module can no longer be read.
    readable = false;
    host.listeners.get("loader/partial-dispose")?.({ fiber: pi });
    await flush();
    expect(host.handle).toHaveBeenCalledTimes(1);
    expect(pi.restart).toHaveBeenCalledTimes(1);
    const [released] = host.handle.mock.invocationCallOrder;
    const [restarted] = vi.mocked(pi.restart).mock.invocationCallOrder;
    expect(released).toBeLessThan(restarted ?? 0);
  });

  it("a failing handback restart is reported, not thrown", async () => {
    useTestModules({
      libraries: async () => {},
      piAi: async () => {},
    });
    const pi = piFiber();
    pi.restart = vi.fn(async () => {
      throw new Error("busy");
    });
    const host = standIn({ fibers: () => [pi] });
    await installRouteClaim(host.ctx, config).mounted;
    await flush();
    expect(host.warn).toHaveBeenCalledWith(
      expect.stringContaining("did not restart to take the plane routes back"),
      expect.any(Error)
    );
  });
});

describe("route-claim · the listener", () => {
  it("passes through for another plugin, strips the planes for pi-ai, and validates only a changed plane of a candidate", async () => {
    useTestModules();
    const pi = piFiber();
    const host = standIn({ fibers: () => [pi] });
    const claim = installRouteClaim(host.ctx, config);
    await claim.mounted;
    await flush();
    const listener = host.listeners.get("internal/config");
    if (listener === undefined) {
      throw new Error("no listener");
    }
    // Another plugin's run, and a run that names no fiber, pass through.
    const other = {};
    expect(oldRun(listener, { runtime: { name: "other" } }, other)).toBe(other);
    expect(Reflect.apply(listener, null, [other, () => other])).toBe(other);
    // A commit holding a plane: the copy without it, and no throw.
    const committed = oldRun(listener, pi, pi._config) as {
      providers: Record<string, unknown>;
    };
    expect(Object.keys(committed.providers)).toEqual(["deepseek"]);
    // A commit holding none passes the raw value on.
    const bare = { providers: { deepseek: {} } };
    pi._config = bare;
    expect(oldRun(listener, pi, bare)).toBe(bare);
    // A candidate whose plane did not change is not validated: with a
    // malformed model stored on the plane (pi-ai keeps it as a deferred
    // error), validating it would refuse every save that touches only a
    // sibling.
    const malformed = { models: [{ id: "" }] };
    pi._config = { providers: { deepseek: {}, opencode: malformed } };
    const same = structuredClone(pi._config);
    expect(oldRun(listener, pi, same)).toEqual({
      providers: { deepseek: {} },
    });
    const siblingOnly = structuredClone(pi._config);
    siblingOnly.providers.deepseek = { displayName: "D" };
    expect(oldRun(listener, pi, siblingOnly)).toEqual({
      providers: { deepseek: { displayName: "D" } },
    });
    // The same plane changed is validated, and refused in pi-ai's words.
    expect(() =>
      oldRun(listener, pi, {
        providers: {
          deepseek: {},
          opencode: { models: [{ id: "" }, { id: "x" }] },
        },
      })
    ).toThrow(/has a model with an empty id/u);
    pi._config = { providers: { deepseek: {}, opencode: zen } };
    // A changed, malformed plane is refused in pi-ai's words.
    expect(() =>
      oldRun(listener, pi, {
        providers: { "opencode-go": { models: [{ id: "" }] } },
      })
    ).toThrow(/has a model with an empty id/u);
  });

  it("refuses to validate before the host's modules are read", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const real = hostModulesForTests();
    useTestModules({
      libraries: async () => {
        await gate;
        return real.libraries();
      },
      piAi: real.piAi,
    });
    const pi = piFiber();
    const host = standIn({ fibers: () => [pi] });
    const claim = installRouteClaim(host.ctx, config);
    expect(() =>
      oldRun(host.listeners.get("internal/config"), pi, {
        providers: { opencode: { models: [{ id: "x" }] } },
      })
    ).toThrow(/cannot be validated yet/u);
    release?.();
    await claim.mounted;
  });
});

/** A NEW-core fiber's own fields, as the claim reads them. */
interface NewFakeFiber {
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
const newPiFiber = (
  providers?: Record<string, unknown>,
  resolved?: Record<string, unknown>
): NewFakeFiber => {
  const fiber = {
    await: vi.fn(async () => {}),
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
    restart: vi.fn(async () => {}),
    runtime: { name: "llm-pi-ai" },
    state: 2,
    uid: 1 as number | null,
  };
  fiber.ctx.fiber = fiber;
  return fiber;
};

/** A plane entry pi-ai's own check refuses: a model with an empty id. */
const MALFORMED = { models: [{ id: "" }, { id: "x" }] };

describe("route-claim · the new core's call shape (cordis 4.0.6-alpha.2, 4.1.0)", () => {
  it("a commit run, (fiber, next) with this null, resolves the served pi-ai without either plane, another fiber passes through, and a candidate with a changed malformed plane is refused in pi-ai's words", async () => {
    useTestModules();
    const pi = newPiFiber();
    const host = standIn({ fibers: () => [pi] });
    const claim = installRouteClaim(host.ctx, config);
    await claim.mounted;
    await flush();
    // The activation and restart run: next() answers the fiber's own raw.
    expect(host.waterfall(pi, () => pi.rawConfig)).toEqual({
      providers: { deepseek: {} },
    });
    expect(host.llm.registerAdapter.mock.calls[0]?.[0]).toEqual(["opencode"]);
    expect(claim.committedEntries()).toHaveProperty("opencode");
    // Another plugin's fiber, read the same way, passes through untouched.
    const other = { ctx: {} as { fiber?: unknown }, runtime: { name: "x" } };
    other.ctx.fiber = other;
    const otherRaw = { providers: { opencode: MALFORMED } };
    expect(host.waterfall(other, () => otherRaw)).toBe(otherRaw);
    // An editor candidate: a fresh object, its plane changed and valid.
    const valid = {
      providers: {
        deepseek: {},
        opencode: { models: [{ id: "deepseek-v4-pro" }, { id: "x" }] },
      },
    };
    expect(host.waterfall(pi, () => valid)).toEqual({
      providers: { deepseek: {} },
    });
    // The same candidate with the plane malformed is refused.
    expect(() =>
      host.waterfall(pi, () => ({
        providers: { deepseek: {}, opencode: MALFORMED },
      }))
    ).toThrow(/has a model with an empty id/u);
  });

  it("calls next() exactly once per run, on either shape: a commit, a candidate and a pass-through", async () => {
    useTestModules();
    const pi = newPiFiber();
    const old = piFiber();
    old.uid = 2;
    const host = standIn({ fibers: () => [pi] });
    await installRouteClaim(host.ctx, config).mounted;
    await flush();
    const listener = host.listeners.get("internal/config");
    const counted = (raw: unknown) => {
      const next = vi.fn(() => raw);
      return next;
    };
    const candidate = {
      providers: { opencode: { models: [{ id: "deepseek-v4-pro" }] } },
    };
    for (const raw of [pi.rawConfig, candidate]) {
      const next = counted(raw);
      Reflect.apply(listener ?? (() => {}), null, [pi, next]);
      expect(next).toHaveBeenCalledTimes(1);
    }
    // The OLD shape, for a row the claim does not serve and for one it does.
    for (const fiber of [old, pi]) {
      const next = counted(candidate);
      listener?.call(fiber, candidate, next);
      expect(next).toHaveBeenCalledTimes(1);
    }
  });

  it("a commit never throws: a malformed plane in the fiber's own raw config, in the loader's stored row config, or in any run while pi-ai is not ACTIVE is stripped unjudged", async () => {
    useTestModules();
    const pi = newPiFiber();
    const host = standIn({ fibers: () => [pi] });
    await installRouteClaim(host.ctx, config).mounted;
    await flush();
    const stripped = { providers: { deepseek: {} } };
    // Known answer: the same value as a fresh candidate is refused.
    expect(() =>
      host.waterfall(pi, () => ({
        providers: { deepseek: {}, opencode: MALFORMED },
      }))
    ).toThrow(/has a model with an empty id/u);
    // The fiber's own raw config: a restart, a volatile run.
    pi.config = { providers: { deepseek: {}, opencode: MALFORMED } };
    expect(host.waterfall(pi, () => pi.rawConfig)).toEqual(stripped);
    // The loader's stored row config: a loader update, which the NEW core
    // resolves BEFORE it stores the raw value.
    const stored = { providers: { deepseek: {}, opencode: MALFORMED } };
    pi.entry.options.config = stored;
    expect(host.waterfall(pi, () => stored)).toEqual(stripped);
    // An activation run (LOADING): a FAILED fiber on this core recovers only
    // through update(), so no run of an activation may throw.
    pi.state = 1;
    expect(
      host.waterfall(pi, () => ({
        providers: { deepseek: {}, opencode: MALFORMED },
      }))
    ).toEqual(stripped);
  });

  it("stays inner to pi-ai's own listener: one pi-ai re-registered after the claim sees a plane only until pi-ai reaches ACTIVE, when the claim re-appends itself", async () => {
    useTestModules();
    const pi = newPiFiber();
    const host = standIn({ fibers: () => [pi] });
    await installRouteClaim(host.ctx, config).mounted;
    await flush();
    // pi-ai's own listener checks what its next() answers (dsh-llm-pi-ai
    // `lib/index.js` 2927-2933 at 0.2.2-rc.1), and pi-ai registers it at
    // every activation, so a restart appends it after the claim's.
    const seen: unknown[] = [];
    host.ctx.on?.("internal/config", (fiber: unknown, next: () => unknown) => {
      const raw = next();
      if (fiber === pi) {
        seen.push(raw);
      }
      return raw;
    });
    const candidate = {
      providers: {
        deepseek: {},
        opencode: { models: [{ id: "deepseek-v4-pro" }, { id: "x" }] },
      },
    };
    host.waterfall(pi, () => candidate);
    // Known answer: inner to the claim, pi-ai's listener sees the plane.
    expect(seen.at(-1)).toBe(candidate);
    // A status change of another fiber, or of pi-ai to a state other than
    // ACTIVE, leaves the order alone.
    host.emit("internal/status", { runtime: { name: "x" }, state: 2 }, 1);
    pi.state = 1;
    host.emit("internal/status", pi, 0);
    host.waterfall(pi, () => candidate);
    expect(seen.at(-1)).toBe(candidate);
    // pi-ai reaches ACTIVE: the claim re-appends itself after pi-ai's.
    pi.state = 2;
    host.emit("internal/status", pi, 1);
    expect(host.waterfall(pi, () => candidate)).toEqual({
      providers: { deepseek: {} },
    });
    expect(seen.at(-1)).toEqual({ providers: { deepseek: {} } });
    expect(host.hooks.get("internal/config")).toHaveLength(2);
  });
});

describe("route-claim · validating while the modules are unloaded", () => {
  it("accepts a valid plane save in the window after pi-ai's partial dispose, and still refuses a malformed one in pi-ai's words", async () => {
    useTestModules();
    const pi = piFiber();
    const host = standIn({ fibers: () => [pi] });
    await installRouteClaim(host.ctx, config).mounted;
    await flush();
    expect(host.llm.registerAdapter).toHaveBeenCalledTimes(1);
    // pi-ai's row is partially disposed (a profile reload that updated it):
    // the claim drops the modules it serves with and reconciles on a
    // microtask. A Settings save that lands before then is still judged.
    host.listeners.get("loader/partial-dispose")?.({ fiber: pi });
    const listener = host.listeners.get("internal/config");
    const candidate = {
      providers: {
        deepseek: {},
        opencode: { models: [{ id: "deepseek-v4-pro" }, { id: "x" }] },
      },
    };
    expect(oldRun(listener, pi, candidate)).toEqual({
      providers: { deepseek: {} },
    });
    expect(() =>
      oldRun(listener, pi, {
        providers: { opencode: { models: [{ id: "" }] } },
      })
    ).toThrow(/has a model with an empty id/u);
    await flush();
  });
});

describe("route-claim · a second pi-ai row", () => {
  it("strips and serves only one row's planes when both declare one; the other keeps and serves its own", async () => {
    useTestModules();
    const first = piFiber();
    const second = piFiber({
      "opencode-go": { models: [{ id: "glm-5.1" }] },
    });
    second.uid = 2;
    const host = standIn({ fibers: () => [first, second] });
    await installRouteClaim(host.ctx, config).mounted;
    await flush();
    const listener = host.listeners.get("internal/config");
    // The second row's config passes through untouched: pi-ai serves its plane.
    expect(oldRun(listener, second, second._config)).toBe(second._config);
    // The first row's is stripped, and only its plane is registered.
    expect(oldRun(listener, first, first._config)).toEqual({
      providers: { deepseek: {} },
    });
    expect(host.llm.registerAdapter).toHaveBeenCalledTimes(1);
    expect(host.llm.registerAdapter.mock.calls[0]?.[0]).toEqual(["opencode"]);
  });

  it("serves the row that declares the planes, whatever the registry order: a re-enabled row cordis appended last", async () => {
    useTestModules();
    const bare = piFiber({ deepseek: {} });
    const declaring = piFiber();
    declaring.uid = 2;
    const host = standIn({ fibers: () => [bare, declaring] });
    const claim = installRouteClaim(host.ctx, config);
    await claim.mounted;
    await flush();
    const listener = host.listeners.get("internal/config");
    // The plane-less row ahead of it passes through: nothing to strip.
    expect(oldRun(listener, bare, bare._config)).toBe(bare._config);
    // The declaring row is the served one, though it comes second.
    expect(oldRun(listener, declaring, declaring._config)).toEqual({
      providers: { deepseek: {} },
    });
    expect(host.llm.registerAdapter.mock.calls[0]?.[0]).toEqual(["opencode"]);
    expect(claim.committedEntries()).toHaveProperty("opencode");
  });

  it("the served row is sticky: a row that stops declaring hands over, and declaring again does not take the planes from the row now served", async () => {
    useTestModules();
    const first = piFiber();
    first.restart = vi.fn(async () => {});
    const second = piFiber(
      { deepseek: {}, "opencode-go": { models: [{ id: "glm-5.1" }] } },
      // Passed through at boot: it resolved and registered its plane itself.
      { deepseek: {}, "opencode-go": {} }
    );
    second.uid = 2;
    second.entry = { options: { id: "llm-pi-ai:go" } };
    second.restart = vi.fn(async () => {
      // It re-resolves through the listener: the plane is stripped.
      second.config = { providers: { get: () => ({ deepseek: {} }) } };
    });
    const host = standIn({ fibers: () => [first, second] });
    const claim = installRouteClaim(host.ctx, config);
    await claim.mounted;
    await flush();
    const listener = host.listeners.get("internal/config");
    expect(host.llm.registerAdapter.mock.calls[0]?.[0]).toEqual(["opencode"]);

    // A Settings save removes the first row's plane: the second row, which
    // declares one, becomes the served row and is restarted once to strip it.
    first._config = { providers: { deepseek: {} } };
    expect(oldRun(listener, first, first._config)).toBe(first._config);
    host.listeners.get("llm/adapters-updated")?.();
    await flush();
    expect(host.handle).toHaveBeenCalledTimes(1);
    expect(second.restart).toHaveBeenCalledTimes(1);
    host.listeners.get("llm/adapters-updated")?.();
    await flush();
    expect(host.llm.registerAdapter).toHaveBeenCalledTimes(2);
    expect(host.llm.registerAdapter.mock.calls[1]?.[0]).toEqual([
      "opencode-go",
    ]);

    // The first row declares `opencode` again. It does not take the served
    // seat back: were it to, the second row would keep its stripped config
    // and nobody would serve `opencode-go`. It passes through and serves its
    // own plane, and is reported once.
    first._config = { providers: { deepseek: {}, opencode: zen } };
    expect(oldRun(listener, first, first._config)).toBe(first._config);
    first.config = {
      providers: { get: () => ({ deepseek: {}, opencode: {} }) },
    };
    host.listeners.get("llm/adapters-updated")?.();
    await flush();
    expect(oldRun(listener, second, second._config)).toEqual({
      providers: { deepseek: {} },
    });
    expect(host.handle).toHaveBeenCalledTimes(1);
    expect(host.llm.registerAdapter).toHaveBeenCalledTimes(2);
    expect(Object.keys(claim.committedEntries())).toEqual(["opencode-go"]);
    expect(claim.piAiNamespace()).toBe("llm-pi-ai:go");
    expect(second.restart).toHaveBeenCalledTimes(1);
    expect(first.restart).not.toHaveBeenCalled();
    const reported = host.warn.mock.calls.filter(([message]) =>
      String(message).includes('"llm-pi-ai" serves opencode itself')
    );
    expect(reported).toHaveLength(1);
  });

  it("a plane-less row ahead of the served row that gains a plane passes through: the served row keeps its plane", async () => {
    useTestModules();
    const bare = piFiber({ deepseek: {} });
    const declaring = piFiber({
      deepseek: {},
      "opencode-go": { models: [{ id: "glm-5.1" }] },
    });
    declaring.uid = 2;
    const host = standIn({ fibers: () => [bare, declaring] });
    const claim = installRouteClaim(host.ctx, config);
    await claim.mounted;
    await flush();
    const listener = host.listeners.get("internal/config");
    expect(host.llm.registerAdapter.mock.calls[0]?.[0]).toEqual([
      "opencode-go",
    ]);
    bare._config = { providers: { deepseek: {}, opencode: zen } };
    expect(oldRun(listener, bare, bare._config)).toBe(bare._config);
    bare.config = {
      providers: { get: () => ({ deepseek: {}, opencode: {} }) },
    };
    host.listeners.get("llm/adapters-updated")?.();
    await flush();
    // Nothing was released or restarted, and `opencode-go` is still the plugin's.
    expect(host.handle).not.toHaveBeenCalled();
    expect(declaring.restart).not.toHaveBeenCalled();
    expect(bare.restart).not.toHaveBeenCalled();
    expect(host.llm.registerAdapter).toHaveBeenCalledTimes(1);
    expect(Object.keys(claim.committedEntries())).toEqual(["opencode-go"]);
    expect(oldRun(listener, declaring, declaring._config)).toEqual({
      providers: { deepseek: {} },
    });
  });

  it("a disposed served row is handed over: its planes are released, the next row holding one is restarted once and then served", async () => {
    useTestModules();
    const first = piFiber();
    const second = piFiber(
      { deepseek: {}, "opencode-go": { models: [{ id: "glm-5.1" }] } },
      // It was passed through, so it resolved and registered its plane itself.
      { deepseek: {}, "opencode-go": {} }
    );
    second.uid = 2;
    second.entry = { options: { id: "llm-pi-ai:second" } };
    second.restart = vi.fn(async () => {
      // It re-resolves through the listener: the plane is stripped.
      second.config = { providers: { get: () => ({ deepseek: {} }) } };
    });
    const host = standIn({ fibers: () => [first, second] });
    const claim = installRouteClaim(host.ctx, config);
    await claim.mounted;
    await flush();
    expect(host.llm.registerAdapter.mock.calls[0]?.[0]).toEqual(["opencode"]);
    // The row serving a plane itself is reported, once.
    host.listeners.get("llm/adapters-updated")?.();
    await flush();
    const reported = host.warn.mock.calls.filter(([message]) =>
      String(message).includes('"llm-pi-ai:second" serves opencode-go itself')
    );
    expect(reported).toHaveLength(1);
    expect(second.restart).not.toHaveBeenCalled();

    first.uid = null;
    host.listeners.get("llm/adapters-updated")?.();
    await flush();
    // The disposed row's plane is no longer served, nor grafted into Settings.
    expect(host.handle).toHaveBeenCalledTimes(1);
    expect(claim.committedEntries()).not.toHaveProperty("opencode");
    // The new served row held its plane, so it was restarted once to strip it.
    expect(second.restart).toHaveBeenCalledTimes(1);
    expect(
      oldRun(host.listeners.get("internal/config"), second, second._config)
    ).toEqual({ providers: { deepseek: {} } });
    // Its registry change brings the claim back: the plugin serves its plane.
    host.listeners.get("llm/adapters-updated")?.();
    await flush();
    expect(host.llm.registerAdapter).toHaveBeenCalledTimes(2);
    expect(host.llm.registerAdapter.mock.calls[1]?.[0]).toEqual([
      "opencode-go",
    ]);
    expect(Object.keys(claim.committedEntries())).toEqual(["opencode-go"]);
    expect(claim.piAiNamespace()).toBe("llm-pi-ai:second");
    expect(second.restart).toHaveBeenCalledTimes(1);
  });
});

describe("route-claim · the live catalog", () => {
  it("a catalog refresh that lands after boot reaches the profiles: a declared id the shim does not describe changes protocol", async () => {
    useTestModules();
    const id = "future-responses-model";
    const pi = piFiber({ deepseek: {}, opencode: { models: [{ id }] } });
    const host = standIn({ fibers: () => [pi] });
    await installRouteClaim(host.ctx, config).mounted;
    await flush();
    const adapter = host.llm.registerAdapter.mock.calls[0]?.[1];
    // Before the refresh the shim does not describe it: completions (D16).
    expect(servedModel(adapter, "opencode", id)?.api).toBe(
      "openai-completions"
    );
    await refreshCatalog(
      (async () =>
        Response.json({
          opencode: {
            models: {
              [id]: { name: "Future", provider: { npm: "@ai-sdk/openai" } },
            },
          },
        })) as unknown as typeof fetch,
      true
    );
    await flush();
    // No plane edit and no registry change: the refresh alone re-ran it.
    expect(servedModel(adapter, "opencode", id)?.api).toBe("openai-responses");
    expect(host.llm.registerAdapter).toHaveBeenCalledTimes(1);
  });
});

describe("route-claim · reconcile", () => {
  it("retries a DUPLICATE_ADAPTER refusal after pi-ai settles, and moves the routes on a rename", async () => {
    useTestModules();
    const pi = piFiber();
    const host = standIn({ fibers: () => [pi] });
    let refusals = 1;
    host.llm.registerAdapter.mockImplementation(() => {
      if (refusals > 0) {
        refusals -= 1;
        throw Object.assign(new Error("taken"), { code: "DUPLICATE_ADAPTER" });
      }
      return host.handle;
    });
    const claim = installRouteClaim(host.ctx, config);
    await claim.mounted;
    await flush();
    expect(host.info).toHaveBeenCalledWith(
      expect.stringContaining("still held elsewhere")
    );
    host.listeners.get("llm/adapters-updated")?.();
    await flush();
    expect(pi.await).toHaveBeenCalled();
    expect(host.llm.registerAdapter).toHaveBeenCalledTimes(2);
    expect(host.llm.registerAdapter.mock.calls[1]?.[0]).toEqual(["opencode"]);
    expect(claim.committedEntries()).toHaveProperty("opencode");
    expect(claim.piAiNamespace()).toBe("llm-pi-ai");
    // A rename is a registration fact: the live handle moves the routes.
    pi._config = {
      providers: { deepseek: {}, opencode: { ...zen, displayName: "Zen X" } },
    };
    oldRun(host.listeners.get("internal/config"), pi, pi._config);
    await flush();
    expect(host.handle.replace).toHaveBeenCalledWith(["opencode"]);
    // A commit that removes the last plane withdraws the routes through the
    // live handle, replace([]), never by releasing it; committing the plane
    // back moves it through the same handle, with no second registration.
    pi._config = { providers: { deepseek: {} } };
    oldRun(host.listeners.get("internal/config"), pi, pi._config);
    await flush();
    expect(host.handle.replace).toHaveBeenLastCalledWith([]);
    expect(host.handle).not.toHaveBeenCalled();
    expect(claim.committedEntries()).toEqual({});
    pi._config = { providers: { deepseek: {}, opencode: zen } };
    oldRun(host.listeners.get("internal/config"), pi, pi._config);
    await flush();
    expect(host.handle.replace).toHaveBeenLastCalledWith(["opencode"]);
    expect(host.handle).not.toHaveBeenCalled();
    expect(host.llm.registerAdapter).toHaveBeenCalledTimes(2);
    // pi-ai going away withdraws them through the same handle.
    pi.state = 3;
    host.listeners.get("llm/adapters-updated")?.();
    await flush();
    expect(host.handle.replace).toHaveBeenLastCalledWith([]);
    expect(claim.committedEntries()).toEqual({});
  });

  it("reports a registry refusal and a failed profile build, and waits while pi-ai still holds a plane", async () => {
    const real = hostModulesForTests();
    const libraries = await real.libraries();
    if (libraries === undefined) {
      throw new Error("no libraries");
    }
    useTestModules({
      libraries: async () => ({
        ...libraries,
        builtinModels: () => {
          throw new Error("no catalog");
        },
      }),
      piAi: real.piAi,
    });
    const pi = piFiber();
    const host = standIn({ fibers: () => [pi] });
    await installRouteClaim(host.ctx, config).mounted;
    await flush();
    expect(host.warn).toHaveBeenCalledWith(
      expect.stringContaining("the plane profiles did not build"),
      expect.any(Error)
    );
    restore?.();
    useTestModules();
    const refused = standIn({
      fibers: () => [piFiber()],
      llm: {
        registerAdapter: vi.fn(() => {
          throw new Error("no");
        }),
      },
    });
    await installRouteClaim(refused.ctx, config).mounted;
    await flush();
    expect(refused.warn).toHaveBeenCalledWith(
      expect.stringContaining("did not register"),
      expect.any(Error)
    );
    // pi-ai resolved a plane before the listener existed: nothing registers
    // until it restarts, and the mount restarts it once it has settled.
    const holding = piFiber(undefined, { deepseek: {}, opencode: {} });
    const waiting = standIn({ fibers: () => [holding] });
    await installRouteClaim(waiting.ctx, config).mounted;
    await flush();
    expect(holding.await).toHaveBeenCalled();
    expect(holding.restart).toHaveBeenCalledTimes(1);
    expect(waiting.llm.registerAdapter).not.toHaveBeenCalled();
  });

  it("follows pi-ai's loader entry being disposed, and ignores another entry's", async () => {
    const piAi = vi.fn(hostModulesForTests().piAi);
    useTestModules({ ...hostModulesForTests(), piAi });
    const pi = piFiber();
    const host = standIn({ fibers: () => [pi] });
    await installRouteClaim(host.ctx, config).mounted;
    await flush();
    const loads = piAi.mock.calls.length;
    const partial = host.listeners.get("loader/partial-dispose");
    partial?.({ fiber: { runtime: { name: "other" } } });
    await flush();
    expect(piAi.mock.calls.length).toBe(loads);
    partial?.({ fiber: pi });
    await flush();
    expect(piAi.mock.calls.length).toBe(loads + 1);
  });
});

describe("route-claim · teardown", () => {
  it("on a reload releases the handle and restarts nothing", async () => {
    useTestModules();
    const pi = piFiber();
    const host = standIn({ fibers: () => [pi] });
    await installRouteClaim(host.ctx, config).mounted;
    await flush();
    expect(host.llm.registerAdapter).toHaveBeenCalledTimes(1);
    const [teardown] = host.cleanups;
    expect(teardown?.()).toBeUndefined();
    expect(host.handle).toHaveBeenCalledTimes(1);
    expect(pi.restart).not.toHaveBeenCalled();
  });

  it("unsubscribes from the catalog on a reload too, so a reloaded activation leaves nothing behind", async () => {
    useTestModules();
    const pi = piFiber();
    const host = standIn({ fibers: () => [pi], uid: 1 });
    const before = catalogListenerCount();
    await installRouteClaim(host.ctx, config).mounted;
    await flush();
    expect(catalogListenerCount()).toBe(before + 1);
    // A reload: the plugin's own fiber keeps its uid.
    host.cleanups[0]?.();
    expect(catalogListenerCount()).toBe(before);
    await refreshCatalog(
      (async () =>
        Response.json({
          opencode: {
            models: {
              "after-reload-model": {
                name: "After",
                provider: { npm: "@ai-sdk/openai" },
              },
            },
          },
        })) as unknown as typeof fetch,
      true
    );
    await flush();
    expect(host.llm.registerAdapter).toHaveBeenCalledTimes(1);
    expect(host.handle.replace).not.toHaveBeenCalled();
  });

  it("on a real dispose restarts pi-ai to take the planes back, and says when it did not", async () => {
    useTestModules();
    const pi = piFiber();
    const host = standIn({ fibers: () => [pi], uid: 1 });
    await installRouteClaim(host.ctx, config).mounted;
    await flush();
    host.fiber.uid = null as never;
    await host.cleanups[0]?.();
    expect(pi.await).toHaveBeenCalled();
    expect(pi.restart).toHaveBeenCalledTimes(1);
    expect(host.warn).toHaveBeenCalledWith(
      expect.stringContaining("pi-ai did not take back opencode")
    );
  });

  it("restarts nothing while pi-ai's parent unloads, and reports a failed restart", async () => {
    useTestModules();
    const shuttingDown = piFiber();
    shuttingDown.parent = { fiber: { state: 5 } };
    const host = standIn({ fibers: () => [shuttingDown] });
    await installRouteClaim(host.ctx, config).mounted;
    await flush();
    host.fiber.uid = null as never;
    expect(host.cleanups[0]?.()).toBeUndefined();
    expect(shuttingDown.restart).not.toHaveBeenCalled();

    const failing = piFiber();
    const second = standIn({ fibers: () => [failing] });
    await installRouteClaim(second.ctx, config).mounted;
    await flush();
    failing.restart = vi.fn(async () => {
      throw new Error("busy");
    });
    second.fiber.uid = null as never;
    await second.cleanups[0]?.();
    expect(second.warn).toHaveBeenCalledWith(
      expect.stringContaining("did not take the plane routes back"),
      expect.any(Error)
    );
    // A handle that throws on release is reported too.
    const third = standIn({ fibers: () => [piFiber()] });
    third.handle.mockImplementation(() => {
      throw new Error("gone");
    });
    await installRouteClaim(third.ctx, config).mounted;
    await flush();
    third.cleanups[0]?.();
    expect(third.warn).toHaveBeenCalledWith(
      expect.stringContaining("did not release"),
      expect.any(Error)
    );
  });

  it("an llm scope that goes away drops the handle, so the next one registers afresh", async () => {
    useTestModules();
    const pi = piFiber();
    const host = standIn({ fibers: () => [pi] });
    await installRouteClaim(host.ctx, config).mounted;
    await flush();
    // The llm scope's own effect is the last cleanup registered.
    host.cleanups.at(-1)?.();
    host.listeners.get("llm/adapters-updated")?.();
    await flush();
    // No llm, nothing to register on.
    expect(host.llm.registerAdapter).toHaveBeenCalledTimes(1);
    // A new llm scope: a fresh registration on it, never a `replace` through
    // the old scope's handle.
    const nextHandle = Object.assign(vi.fn(), { replace: vi.fn() });
    const nextLlm = {
      listProviders: () => [],
      registerAdapter: vi.fn(() => nextHandle),
    };
    host.reinject({ llm: nextLlm });
    await flush();
    expect(nextLlm.registerAdapter).toHaveBeenCalledTimes(1);
    expect((nextLlm.registerAdapter.mock.calls[0] as unknown[])[0]).toEqual([
      "opencode",
    ]);
    expect(host.handle.replace).not.toHaveBeenCalled();
    expect(host.llm.registerAdapter).toHaveBeenCalledTimes(1);
  });

  it("a real dispose while pi-ai is still LOADING restarts it once it settles without the planes; one that settled holding them is left alone", async () => {
    useTestModules();
    const loading = piFiber();
    const host = standIn({ fibers: () => [loading] });
    await installRouteClaim(host.ctx, config).mounted;
    await flush();
    loading.state = 1;
    loading.await = vi.fn(async () => {
      loading.state = 2;
    });
    host.fiber.uid = null as never;
    await host.cleanups[0]?.();
    expect(loading.await).toHaveBeenCalled();
    expect(loading.restart).toHaveBeenCalledTimes(1);

    const settled = piFiber();
    const other = standIn({ fibers: () => [settled] });
    await installRouteClaim(other.ctx, config).mounted;
    await flush();
    settled.state = 1;
    settled.await = vi.fn(async () => {
      // It resolved after the claim went inert: it holds its plane.
      settled.config = {
        providers: { get: () => ({ deepseek: {}, opencode: {} }) },
      };
      settled.state = 2;
    });
    other.fiber.uid = null as never;
    await other.cleanups[0]?.();
    expect(settled.await).toHaveBeenCalled();
    expect(settled.restart).not.toHaveBeenCalled();
  });
});
