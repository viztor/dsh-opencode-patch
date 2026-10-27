/**
 * The route claim's reconcile, and its read of the live catalog, on a
 * stand-in host (`support/route-claim-stand-in.ts`).
 *
 * @module test/route-claim-reconcile.test
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { hostModulesForTests } from "./support/host.ts";
import {
  flush,
  piFiber,
  restoreTestModules,
  servedModel,
  standIn,
  useTestModules,
  zen,
} from "./support/route-claim-stand-in.ts";
import {
  installRouteClaim,
  refreshCatalog,
  resolveConfig,
} from "./support/src.ts";

afterEach(() => {
  restoreTestModules();
  vi.restoreAllMocks();
});

const config = resolveConfig();

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
    expect(claim.claiming()).toBe(true);
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
    restoreTestModules();
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
