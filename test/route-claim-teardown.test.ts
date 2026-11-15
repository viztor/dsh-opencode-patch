/**
 * The route claim's teardown: the handback and its diagnostics, on a stand-in
 * host (`support/route-claim-stand-in.ts`).
 *
 * @module test/route-claim-teardown.test
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  flush,
  piFiber,
  restoreTestModules,
  standIn,
  useTestModules,
} from "./support/route-claim-stand-in.ts";
import {
  catalogListenerCount,
  installRouteClaim,
  refreshCatalog,
  resolveConfig,
} from "./support/src.ts";

afterEach(() => {
  restoreTestModules();
  vi.restoreAllMocks();
});

const config = resolveConfig();

describe("route-claim · teardown", () => {
  it("on a reload releases the handle and restarts nothing", async () => {
    useTestModules();
    const pi = piFiber();
    const host = standIn({ fibers: () => [pi] });
    const claim = installRouteClaim(host.ctx, config);
    await claim.mounted;
    await flush();
    expect(host.llm.registerAdapter).toHaveBeenCalledTimes(1);
    expect(claim.claiming()).toBe(true);
    const [teardown] = host.cleanups;
    expect(teardown?.()).toBeUndefined();
    expect(host.handle).toHaveBeenCalledTimes(1);
    expect(pi.restart).not.toHaveBeenCalled();
    expect(claim.claiming()).toBe(false);
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
