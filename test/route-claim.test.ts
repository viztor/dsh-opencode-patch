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
  ctx: { waterfall?: (...args: unknown[]) => unknown };
  entry?: unknown;
  parent?: { fiber: { state: number } };
  await: () => Promise<unknown>;
  restart: () => Promise<unknown>;
}

const zen = { models: [{ id: "deepseek-v4-pro" }] };

/** A pi-ai fiber that holds `providers` raw and resolves `resolved`. */
const piFiber = (
  providers?: Record<string, unknown>,
  resolved?: Record<string, unknown>
): FakeFiber => ({
  _config: { providers: providers ?? { deepseek: {}, opencode: zen } },
  await: vi.fn(async () => {}),
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
  restart: vi.fn(async () => {}),
  runtime: { name: "llm-pi-ai" },
  state: 2,
  uid: 1,
});

/** A stand-in plugin context: records listeners, effects and registrations. */
const standIn = (
  options: {
    fibers?: () => FakeFiber[];
    llm?: Record<string, unknown>;
    uid?: number | null;
  } = {}
) => {
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
    const next = vi.fn(() => "next");
    expect(
      host.listeners.get("internal/config")?.call(pi, pi._config, next)
    ).toBe("next");
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
    const next = vi.fn(() => "next");
    expect(
      host.listeners.get("internal/config")?.call(pi, pi._config, next)
    ).toBe("next");
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
    const next = vi.fn(() => "next");
    const candidate = { providers: { deepseek: {}, opencode: zen } };
    expect(listener?.call(pi, candidate, next)).toBe("next");
    // And the commit run that follows passes through untouched.
    pi._config = candidate;
    expect(listener?.call(pi, pi._config, next)).toBe("next");
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
    const next = vi.fn(() => "next");
    expect(listener.call({ runtime: { name: "other" } }, {}, next)).toBe(
      "next"
    );
    // A commit holding a plane: the copy without it, and no throw.
    const committed = listener.call(pi, pi._config, next) as {
      providers: Record<string, unknown>;
    };
    expect(Object.keys(committed.providers)).toEqual(["deepseek"]);
    // A commit holding none passes the raw value on.
    const bare = { providers: { deepseek: {} } };
    pi._config = bare;
    expect(listener.call(pi, bare, next)).toBe("next");
    // A candidate whose plane did not change is not validated: with a
    // malformed model stored on the plane (pi-ai keeps it as a deferred
    // error), validating it would refuse every save that touches only a
    // sibling.
    const malformed = { models: [{ id: "" }] };
    pi._config = { providers: { deepseek: {}, opencode: malformed } };
    const same = structuredClone(pi._config);
    expect(listener.call(pi, same, next)).toEqual({
      providers: { deepseek: {} },
    });
    const siblingOnly = structuredClone(pi._config);
    siblingOnly.providers.deepseek = { displayName: "D" };
    expect(listener.call(pi, siblingOnly, next)).toEqual({
      providers: { deepseek: { displayName: "D" } },
    });
    // The same plane changed is validated, and refused in pi-ai's words.
    expect(() =>
      listener.call(
        pi,
        {
          providers: {
            deepseek: {},
            opencode: { models: [{ id: "" }, { id: "x" }] },
          },
        },
        next
      )
    ).toThrow(/has a model with an empty id/u);
    pi._config = { providers: { deepseek: {}, opencode: zen } };
    // A changed, malformed plane is refused in pi-ai's words.
    expect(() =>
      listener.call(
        pi,
        { providers: { "opencode-go": { models: [{ id: "" }] } } },
        next
      )
    ).toThrow(/has a model with an empty id/u);
    // A host without `waterfall` still gets the copy.
    pi.ctx = {};
    expect(
      listener.call(
        pi,
        { providers: { opencode: { models: [{ id: "x" }] } } },
        next
      )
    ).toEqual({ providers: {} });
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
      host.listeners
        .get("internal/config")
        ?.call(
          pi,
          { providers: { opencode: { models: [{ id: "x" }] } } },
          () => "next"
        )
    ).toThrow(/cannot be validated yet/u);
    release?.();
    await claim.mounted;
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
    expect(listener?.call(pi, candidate, () => "next")).toEqual({
      providers: { deepseek: {} },
    });
    expect(() =>
      listener?.call(
        pi,
        { providers: { opencode: { models: [{ id: "" }] } } },
        () => "next"
      )
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
    const next = vi.fn(() => "next");
    // The second row's config passes through untouched: pi-ai serves its plane.
    expect(listener?.call(second, second._config, next)).toBe("next");
    // The first row's is stripped, and only its plane is registered.
    expect(listener?.call(first, first._config, next)).toEqual({
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
    const next = vi.fn(() => "next");
    // The plane-less row ahead of it passes through: nothing to strip.
    expect(listener?.call(bare, bare._config, next)).toBe("next");
    // The declaring row is the served one, though it comes second.
    expect(listener?.call(declaring, declaring._config, next)).toEqual({
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
    const next = vi.fn(() => "next");
    expect(host.llm.registerAdapter.mock.calls[0]?.[0]).toEqual(["opencode"]);

    // A Settings save removes the first row's plane: the second row, which
    // declares one, becomes the served row and is restarted once to strip it.
    first._config = { providers: { deepseek: {} } };
    expect(listener?.call(first, first._config, next)).toBe("next");
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
    expect(listener?.call(first, first._config, next)).toBe("next");
    first.config = {
      providers: { get: () => ({ deepseek: {}, opencode: {} }) },
    };
    host.listeners.get("llm/adapters-updated")?.();
    await flush();
    expect(listener?.call(second, second._config, next)).toEqual({
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
    const next = vi.fn(() => "next");
    expect(host.llm.registerAdapter.mock.calls[0]?.[0]).toEqual([
      "opencode-go",
    ]);
    bare._config = { providers: { deepseek: {}, opencode: zen } };
    expect(listener?.call(bare, bare._config, next)).toBe("next");
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
    expect(listener?.call(declaring, declaring._config, next)).toEqual({
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
      host.listeners
        .get("internal/config")
        ?.call(second, second._config, () => "next")
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
    host.listeners.get("internal/config")?.call(pi, pi._config, () => "next");
    await flush();
    expect(host.handle.replace).toHaveBeenCalledWith(["opencode"]);
    // A commit that removes the last plane withdraws the routes through the
    // live handle, replace([]), never by releasing it; committing the plane
    // back moves it through the same handle, with no second registration.
    pi._config = { providers: { deepseek: {} } };
    host.listeners.get("internal/config")?.call(pi, pi._config, () => "next");
    await flush();
    expect(host.handle.replace).toHaveBeenLastCalledWith([]);
    expect(host.handle).not.toHaveBeenCalled();
    expect(claim.committedEntries()).toEqual({});
    pi._config = { providers: { deepseek: {}, opencode: zen } };
    host.listeners.get("internal/config")?.call(pi, pi._config, () => "next");
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
