/**
 * The route claim's clauses on a stand-in host (`src/host/route-claim.ts`).
 *
 * The behaviour on the real host — who owns the planes, how often pi-ai
 * restarts, the lifecycle and the config flow — is pinned in the
 * `test/host-planes*.test.ts` files and the characterization. This file drives the
 * branches a real composition reaches only by accident: a host without the
 * cordis members the claim needs, a registry that refuses, a pi-ai that
 * fails, restarts or goes away, and the teardown's handback with its
 * diagnostics. The stand-in records what the claim registered, and the pi-ai
 * fiber is a plain object the claim reads through `ctx.registry`.
 *
 * This file holds the claim standing down, Settings' fetch following the
 * claim's engagement, and the new core's call shape; its siblings hold the
 * `internal/config` listener and a second pi-ai row (`route-claim-listener`),
 * the live catalog and reconcile (`route-claim-reconcile`), and the teardown
 * (`route-claim-teardown`). The stand-in is `support/route-claim-stand-in.ts`.
 *
 * @module test/route-claim.test
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { hostModulesForTests } from "./support/host.ts";
import {
  flush,
  oldRun,
  piFiber,
  restoreTestModules,
  standIn,
  useTestModules,
  zen,
} from "./support/route-claim-stand-in.ts";
import {
  complementDiscoveredModels,
  type CordisContext,
  decorateModelDiscovery,
  installRouteClaim,
  mergeDiscoveredModels,
  resolveConfig,
} from "./support/src.ts";

afterEach(() => {
  restoreTestModules();
  vi.restoreAllMocks();
});

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
    expect(claim.claiming()).toBe(false);
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
    const claim = installRouteClaim(host.ctx, config);
    await claim.mounted;
    await flush();
    expect(host.llm.registerAdapter).not.toHaveBeenCalled();
    expect(pi.restart).toHaveBeenCalledTimes(1);
    expect(host.warn).toHaveBeenCalledWith(
      expect.stringContaining("unavailable; the plane routes stay pi-ai's")
    );
    // Stood down: pi-ai takes the planes and their saves again.
    expect(claim.claiming()).toBe(false);
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

describe("route-claim · Settings' fetch follows the claim's engagement", () => {
  /**
   * A discovery service whose own answer is pi's single row, wrapped by the
   * plugin. `withdrawn` stands for the host's own check: while it reads true
   * pi-ai's discovery is withdrawn and the host answers `NO_DISCOVERY`.
   */
  const wrapped = (
    claim: ReturnType<typeof installRouteClaim>,
    withdrawn: () => boolean = () => false
  ) => {
    const pis = [{ id: "deepseek-v4-pro" }];
    const service = {
      discoverModels: vi.fn(
        async (_settingsNs: string, _request?: unknown): Promise<unknown> => {
          if (withdrawn()) {
            throw Object.assign(new Error("none"), { code: "NO_DISCOVERY" });
          }
          return pis;
        }
      ),
    };
    decorateModelDiscovery(
      { llm: service } as unknown as CordisContext,
      config,
      claim
    );
    return {
      fetch: async (namespace: string, provider: string): Promise<unknown> =>
        service.discoverModels(namespace, { provider }),
      fetchZen: async (): Promise<unknown> =>
        service.discoverModels("llm-pi-ai", { provider: "opencode" }),
      pis,
    };
  };

  it("on the new core, whose internal/config waterfall hands listeners the fiber, the mount's restart moves the planes, claiming() stays true once the mount settles, and Settings' fetch is complemented", async () => {
    useTestModules();
    // pi-ai resolved its planes before the listener existed; its restart
    // re-resolves them through a waterfall that hands each listener the fiber
    // and leaves the config to `next()`, the shape both channels' newest
    // builds run, which the claim speaks.
    let held: Record<string, unknown> = { deepseek: {}, opencode: zen };
    const pi = newPiFiber();
    Object.defineProperty(pi, "effectiveConfig", {
      get: () => ({ providers: { get: () => held } }),
    });
    const host = standIn({ fibers: () => [pi] });
    pi.restart = vi.fn(async () => {
      const resolved = host.waterfall(pi, () => pi.rawConfig) as {
        providers: Record<string, unknown>;
      };
      held = resolved.providers;
    });
    const claim = installRouteClaim(host.ctx, config);
    const { fetchZen, pis } = wrapped(claim);
    expect(claim.claiming()).toBe(true);
    await claim.mounted;
    await flush();
    expect(pi.restart).toHaveBeenCalledTimes(1);
    expect(held).not.toHaveProperty("opencode");
    expect(host.llm.registerAdapter.mock.calls[0]?.[0]).toEqual(["opencode"]);
    // Settled with the planes the plugin's: the claim engaged, so the fetch
    // offers the catalog beyond pi's own row.
    expect(claim.claiming()).toBe(true);
    const answered = (await fetchZen()) as { id: string }[];
    expect(answered.length).toBeGreaterThan(pis.length);
    expect(answered).not.toStrictEqual(mergeDiscoveredModels(pis, "zen"));
  });

  it("a handover's window: while the newly served new-core row's restart is in flight, claiming() stays true and Settings' fetch is complemented before it unloads and the plane's catalog alone while it does, as in the mount's restart", async () => {
    useTestModules();
    // The served row resolved without its plane (the listener was in place).
    const first = newPiFiber();
    // A second row declaring a plane is passed through while the first is
    // served, so it resolved holding that plane: a state the new core reaches.
    const goPlane = { models: [{ id: "glm-5.1" }] };
    let held: Record<string, unknown> = { deepseek: {}, "opencode-go": {} };
    const second = newPiFiber({ deepseek: {}, "opencode-go": goPlane });
    Object.defineProperty(second, "effectiveConfig", {
      get: () => ({ providers: { get: () => held } }),
    });
    second.uid = 2;
    second.entry = { options: { id: "llm-pi-ai:second" } };
    const host = standIn({ fibers: () => [first, second] });
    // cordis 4.0.6-alpha.2 / 4.1.0 (`fiber.ts:630-645,706-722,768-774`):
    // restart() sets UNLOADING synchronously and disposes pi-ai's effects, its
    // discovery among them, so the host answers NO_DISCOVERY until the reload
    // re-resolves the row through the internal/config waterfall.
    let unloading = false;
    let release: (() => void) | undefined;
    second.restart = vi.fn(async () => {
      second.state = 5;
      unloading = true;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      const resolved = host.waterfall(second, () => second.rawConfig) as {
        providers: Record<string, unknown>;
      };
      held = resolved.providers;
      second.state = 2;
      unloading = false;
    });
    const claim = installRouteClaim(host.ctx, config);
    const { fetch, pis } = wrapped(claim, () => unloading);
    await claim.mounted;
    await flush();
    expect(host.llm.registerAdapter.mock.calls[0]?.[0]).toEqual(["opencode"]);
    expect(claim.claiming()).toBe(true);
    // The known answer: the second row serves its own plane, so its fetch is
    // the merge, not the complement, before the handover.
    await expect(fetch("llm-pi-ai:second", "opencode-go")).resolves.toEqual(
      mergeDiscoveredModels(pis, "go")
    );

    // The handover's restart waits for the row to settle first.
    let settle: (() => void) | undefined;
    second.await = vi.fn(
      async () =>
        new Promise<void>((resolve) => {
          settle = resolve;
        })
    );
    first.uid = null;
    host.listeners.get("llm/adapters-updated")?.();
    await flush();
    expect(claim.piAiNamespace()).toBe("llm-pi-ai:second");
    expect(second.restart).not.toHaveBeenCalled();
    // Before the restart begins: pi-ai's discovery still answers, and the
    // claim reads engaged, as from install until the mount's restart settles.
    expect(claim.claiming()).toBe(true);
    const before = (await fetch("llm-pi-ai:second", "opencode-go")) as {
      id: string;
    }[];
    expect(before.length).toBeGreaterThan(pis.length);
    expect(before).not.toStrictEqual(mergeDiscoveredModels(pis, "go"));

    settle?.();
    await flush();
    expect(second.restart).toHaveBeenCalledTimes(1);
    // While the row unloads the host answers NO_DISCOVERY: the fetch is the
    // plane's catalog alone, not the host's error.
    expect(claim.claiming()).toBe(true);
    await expect(fetch("llm-pi-ai:second", "opencode-go")).resolves.toEqual(
      complementDiscoveredModels([], "go")
    );

    release?.();
    await flush();
    expect(held).not.toHaveProperty("opencode-go");
    expect(claim.claiming()).toBe(true);
    host.listeners.get("llm/adapters-updated")?.();
    await flush();
    expect(host.llm.registerAdapter.mock.calls.at(-1)?.[0]).toEqual([
      "opencode-go",
    ]);
    const answered = (await fetch("llm-pi-ai:second", "opencode-go")) as {
      id: string;
    }[];
    expect(answered.length).toBeGreaterThan(pis.length);
    expect(answered).not.toStrictEqual(mergeDiscoveredModels(pis, "go"));
  });

  it("a served row whose restart settles still holding its plane (a call shape the listener does not speak) reads claiming() false once the restart is over, and Settings' fetch is pi's merge", async () => {
    useTestModules();
    const pi = newPiFiber();
    const held: Record<string, unknown> = { deepseek: {}, opencode: zen };
    Object.defineProperty(pi, "effectiveConfig", {
      get: () => ({ providers: { get: () => held } }),
    });
    const host = standIn({ fibers: () => [pi] });
    // The restart re-resolves without reaching the claim's listener.
    let finish: (() => void) | undefined;
    pi.restart = vi.fn(
      async () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        })
    );
    const claim = installRouteClaim(host.ctx, config);
    const { fetchZen, pis } = wrapped(claim);
    await flush();
    expect(pi.restart).toHaveBeenCalledTimes(1);
    // In flight: engaged, as the mount's restart reads.
    expect(claim.claiming()).toBe(true);
    finish?.();
    await claim.mounted;
    await flush();
    expect(host.llm.registerAdapter).not.toHaveBeenCalled();
    // Over, and the row still holds its plane: pi-ai serves and validates it.
    expect(claim.claiming()).toBe(false);
    await expect(fetchZen()).resolves.toStrictEqual(
      mergeDiscoveredModels(pis, "zen")
    );
  });

  it("a mount whose restart throws leaves the new-core pi-ai FAILED: claiming() stays true, nothing registers, Settings' fetch answers the plane's catalog alone, and an update() recovers it through the listener", async () => {
    useTestModules();
    let held: Record<string, unknown> = { deepseek: {}, opencode: zen };
    const pi = newPiFiber();
    Object.defineProperty(pi, "effectiveConfig", {
      get: () => ({ providers: { get: () => held } }),
    });
    const host = standIn({ fibers: () => [pi] });
    // cordis 4.0.6-alpha.2 / 4.1.0 (`fiber.ts:694-700,753-759`): a restart
    // throws only by rethrowing the load error from await(), which leaves the
    // fiber FAILED until update() clears it.
    const failure = new Error("pi-ai did not load");
    pi.restart = vi.fn(async () => {
      pi.state = 3;
      throw failure;
    });
    pi.await = vi.fn(async () => {
      if (pi.state === 3) {
        throw failure;
      }
      return pi;
    });
    const claim = installRouteClaim(host.ctx, config);
    // A FAILED pi-ai's discovery is withdrawn: the host answers NO_DISCOVERY.
    const { fetchZen } = wrapped(claim, () => pi.state === 3);
    await claim.mounted;
    await flush();
    expect(pi.restart).toHaveBeenCalledTimes(1);
    expect(host.warn).toHaveBeenCalledWith(
      expect.stringContaining("did not mount"),
      failure
    );
    // A FAILED row holds nothing to read as pi-ai's, so the claim stays engaged.
    expect(claim.claiming()).toBe(true);
    expect(host.llm.registerAdapter).not.toHaveBeenCalled();
    const alone = (await fetchZen()) as { id: string }[];
    expect(alone.length).toBeGreaterThan(1);
    expect(alone.map((row) => row.id)).toContain("deepseek-v4-pro");

    // A Settings save runs update(), which re-resolves through the listener.
    const resolved = host.waterfall(pi, () => pi.rawConfig) as {
      providers: Record<string, unknown>;
    };
    held = resolved.providers;
    pi.state = 2;
    host.listeners.get("llm/adapters-updated")?.();
    await flush();
    expect(held).not.toHaveProperty("opencode");
    expect(host.llm.registerAdapter.mock.calls[0]?.[0]).toEqual(["opencode"]);
    expect(claim.claiming()).toBe(true);
    expect(((await fetchZen()) as unknown[]).length).toBeGreaterThan(1);
  });
});

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

  it("a re-append the host refuses (its fiber going away) throws nothing into pi-ai's status emit and keeps the claim's listener in place", async () => {
    useTestModules();
    const pi = newPiFiber();
    const host = standIn({ fibers: () => [pi] });
    await installRouteClaim(host.ctx, config).mounted;
    await flush();
    const candidate = { providers: { deepseek: {}, opencode: zen } };
    // Known answer: the claim strips the plane before the refusal.
    expect(host.waterfall(pi, () => candidate)).toEqual({
      providers: { deepseek: {} },
    });
    // The plugin's row is disposed and its teardown has not run yet: cordis
    // refuses every effect, so `ctx.on` throws (`fiber.ts` `effect()`).
    const refusal = Object.assign(
      new Error("cannot create effect on inactive context"),
      { code: "INACTIVE_EFFECT" }
    );
    const on = vi.fn(() => {
      throw refusal;
    });
    Reflect.set(host.ctx, "on", on);
    pi.state = 2;
    expect(() => {
      host.emit("internal/status", pi, 1);
    }).not.toThrow();
    // The host was asked, and the registration it refused left the existing
    // one in place: the claim still strips the plane.
    expect(on).toHaveBeenCalledWith("internal/config", expect.any(Function));
    expect(host.hooks.get("internal/config")).toHaveLength(1);
    expect(host.waterfall(pi, () => candidate)).toEqual({
      providers: { deepseek: {} },
    });
  });
});
