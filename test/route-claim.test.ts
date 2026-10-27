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
 * This file holds the claim standing down; its siblings hold the
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
  piFiber,
  restoreTestModules,
  standIn,
  useTestModules,
  zen,
} from "./support/route-claim-stand-in.ts";
import {
  type CordisContext,
  installRouteClaim,
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
