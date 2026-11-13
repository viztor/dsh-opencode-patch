/**
 * The route claim's `internal/config` listener, and a second pi-ai row, on a
 * stand-in host (`support/route-claim-stand-in.ts`).
 *
 * @module test/route-claim-listener.test
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
import { installRouteClaim, resolveConfig } from "./support/src.ts";

afterEach(() => {
  restoreTestModules();
  vi.restoreAllMocks();
});

const config = resolveConfig();

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
