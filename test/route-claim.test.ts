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
 * This file holds the claim standing down, and Settings' fetch following the
 * claim's engagement on the new core; its siblings hold the `internal/config`
 * listener on both call shapes and a second pi-ai row (`route-claim-listener`),
 * the live catalog and reconcile (`route-claim-reconcile`), and the teardown
 * (`route-claim-teardown`). The stand-in is `support/route-claim-stand-in.ts`.
 *
 * @module test/route-claim.test
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { hostModulesForTests } from "./support/host.ts";
import {
  flush,
  newPiFiber,
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
    // No row is judged, so none is foreign: discovery keeps its merge.
    expect(claim.wouldTake("opencode")).toBe(true);
    expect([...claim.steppedAside()]).toEqual([]);
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
