/**
 * The route claim's `internal/config` listener on both cordis call shapes (the
 * OLD core's `function (this: Fiber, raw, next)`, run through `oldRun`; the
 * NEW core's `(fiber, next)` with `this` null, run through the stand-in's
 * `waterfall`), and a second pi-ai row, on a stand-in host
 * (`support/route-claim-stand-in.ts`).
 *
 * @module test/route-claim-listener.test
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { hostModulesForTests } from "./support/host.ts";
import {
  type FakeFiber,
  flush,
  MALFORMED,
  newPiFiber,
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

  it("leaves an entry another plugin owns to pi-ai's own save check: an edit to it passes a check the plugin's would refuse, while the same edit on a plane the claim takes is refused (D27)", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const real = hostModulesForTests();
    // The plugin's check is refused outright until the modules load, so any
    // entry it judges is refused: the edit below tells the two checks apart.
    useTestModules({
      libraries: async () => {
        await gate;
        return real.libraries();
      },
      piAi: real.piAi,
    });
    const marked = {
      headers: { "x-opencode-plugin": "vendor/1.0.0" },
      models: [{ id: "deepseek-v4-pro" }],
    };
    const pi = piFiber({ deepseek: {}, opencode: marked, "opencode-go": zen });
    const host = standIn({ fibers: () => [pi] });
    const claim = installRouteClaim(host.ctx, config);
    const listener = host.listeners.get("internal/config");
    const edited = {
      providers: {
        deepseek: {},
        opencode: { ...marked, models: [{ id: "x" }] },
        "opencode-go": zen,
      },
    };
    const copy = oldRun(listener, pi, edited) as {
      providers: Record<string, unknown>;
    };
    // Kept for pi-ai, which judges it; the plane the claim takes is stripped.
    expect(copy.providers.opencode).toEqual(edited.providers.opencode);
    expect(copy.providers).not.toHaveProperty("opencode-go");
    // The known answer: the same edit on the taken plane is the plugin's to judge.
    expect(() =>
      oldRun(listener, pi, {
        providers: {
          deepseek: {},
          opencode: marked,
          "opencode-go": { models: [{ id: "x" }] },
        },
      })
    ).toThrow(/provider "opencode-go" cannot be validated yet/u);
    release?.();
    await claim.mounted;
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

  it("a plane the served row takes is the plugin's, whatever a second row that steps aside for it declares; it is stepped aside once that row is gone (D27)", async () => {
    useTestModules();
    const served = piFiber();
    const vendor = piFiber({
      deepseek: {},
      opencode: { ...zen, headers: { "x-opencode-plugin": "vendor/1.0.0" } },
    });
    vendor.uid = 2;
    const host = standIn({ fibers: () => [served, vendor] });
    const claim = installRouteClaim(host.ctx, config);
    await claim.mounted;
    await flush();
    expect(host.llm.registerAdapter.mock.calls[0]?.[0]).toEqual(["opencode"]);
    // The stream hook and the fetch patch read this: the plugin's own turns
    // on `opencode` stay decorated.
    expect([...claim.steppedAside()]).toEqual([]);
    // The known answer: with the served row gone, the second row's marked
    // entry is the only `opencode` left, and it is another plugin's.
    served.uid = null;
    expect([...claim.steppedAside()]).toEqual(["opencode"]);
  });

  it.each([
    [
      "its realm",
      {
        entry: {
          options: {
            id: "llm-pi-ai:vendor",
            isolate: { credentials: "vendor-realm" },
          },
        },
        goEntry: { models: [{ id: "glm-5.1" }] },
      },
    ],
    [
      "its marker",
      {
        entry: { options: { id: "llm-pi-ai:vendor" } },
        goEntry: {
          headers: { "x-opencode-plugin": "vendor/1.0.0" },
          models: [{ id: "glm-5.1" }],
        },
      },
    ],
  ] as const)(
    "serves the row whose planes the claim TAKES: a row ahead of it that declares only a plane another plugin owns, by %s, is passed over (D27)",
    async (_reason, shape) => {
      useTestModules();
      const vendor = piFiber({ deepseek: {}, "opencode-go": shape.goEntry });
      vendor.entry = shape.entry;
      const own = piFiber();
      own.uid = 2;
      const host = standIn({ fibers: () => [vendor, own] });
      const claim = installRouteClaim(host.ctx, config);
      await claim.mounted;
      await flush();
      const listener = host.listeners.get("internal/config");
      expect(oldRun(listener, vendor, vendor._config)).toBe(vendor._config);
      expect(oldRun(listener, own, own._config)).toEqual({
        providers: { deepseek: {} },
      });
      expect(host.llm.registerAdapter).toHaveBeenCalledTimes(1);
      expect(host.llm.registerAdapter.mock.calls[0]?.[0]).toEqual(["opencode"]);
      expect([...claim.steppedAside()]).toEqual(["opencode-go"]);
    }
  );

  it("wouldTake reads the served row's realm per call: a row in a foreign realm takes no plane, declared or not yet; a row sharing the plugin's takes both (D27)", async () => {
    useTestModules();
    const vendor = piFiber({ deepseek: {}, "opencode-go": { ...zen } });
    vendor.entry = {
      options: {
        id: "llm-pi-ai:vendor",
        isolate: { credentials: "vendor-realm" },
      },
    };
    let rows = [vendor];
    const host = standIn({ fibers: () => rows });
    const claim = installRouteClaim(host.ctx, config);
    await claim.mounted;
    await flush();
    // The realm row is served (it takes nothing, and is the only one): its
    // declared plane is stepped aside, and the undeclared one is not taken
    // either, though nothing steps aside for it.
    expect([...claim.steppedAside()]).toEqual(["opencode-go"]);
    expect(claim.wouldTake("opencode-go")).toBe(false);
    expect(claim.wouldTake("opencode")).toBe(false);
    // The known answer: a row sharing the plugin's realm takes either plane.
    const own = piFiber({ deepseek: {} });
    own.uid = 2;
    rows = [own];
    expect(claim.wouldTake("opencode")).toBe(true);
    expect(claim.wouldTake("opencode-go")).toBe(true);
    // No live row: nothing is judged foreign.
    rows = [];
    expect(claim.wouldTake("opencode")).toBe(true);
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

  /** Rows ahead of the served one in the registry, and rows behind it. */
  interface Neighbours {
    readonly ahead: readonly FakeFiber[];
    readonly behind: readonly FakeFiber[];
  }

  it.each([
    ["alone (the known answer)", (): Neighbours => ({ ahead: [], behind: [] })],
    [
      "behind a plane-less row",
      (): Neighbours => {
        const bare = piFiber({ deepseek: {} });
        bare.uid = 2;
        bare.entry = { options: { id: "llm-pi-ai:bare" } };
        return { ahead: [bare], behind: [] };
      },
    ],
    [
      "ahead of a row that declares a plane of its own",
      (): Neighbours => {
        const go = piFiber(
          { deepseek: {}, "opencode-go": { models: [{ id: "glm-5.1" }] } },
          { deepseek: {}, "opencode-go": {} }
        );
        go.uid = 2;
        go.entry = { options: { id: "llm-pi-ai:go" } };
        return { ahead: [], behind: [go] };
      },
    ],
  ] as const)(
    "a save that marks the served row's only plane releases it inside the commit run, %s (D27)",
    async (_shape, neighbours) => {
      useTestModules();
      const served = piFiber();
      // In both shapes with a second row, the served row, once it declares
      // nothing the claim takes, is no longer the row `servedRow` answers.
      const { ahead, behind } = neighbours();
      const fibers = [...ahead, served, ...behind];
      const host = standIn({ fibers: () => fibers });
      const claim = installRouteClaim(host.ctx, config);
      await claim.mounted;
      await flush();
      expect(host.llm.registerAdapter.mock.calls[0]?.[0]).toEqual(["opencode"]);
      const listener = host.listeners.get("internal/config");
      // The loader's volatile path stores the row's new raw config first, then
      // runs `internal/config` with it: a commit run.
      served._config = {
        providers: {
          deepseek: {},
          opencode: {
            ...zen,
            headers: { "x-opencode-plugin": "vendor/1.0.0" },
          },
        },
      };
      expect(oldRun(listener, served, served._config)).toBe(served._config);
      // Released before the run returns, so pi-ai's own registration of the
      // plane, which follows the run at once, meets no duplicate.
      expect(host.handle.replace).toHaveBeenLastCalledWith([]);
      expect([...claim.steppedAside()]).toEqual(["opencode"]);
    }
  );
});
