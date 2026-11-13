/**
 * The `internal/config` waterfall, pinned on the real host (tier A).
 *
 * The route-claim design (docs/improvement-plan.md, D13) rests on cordis and
 * pi-ai behaving exactly as these cases say: pi-ai registers the keys of its
 * RESOLVED config (F11), a listener another plugin prepends wraps pi-ai's
 * fiber and runs outermost (F8), a commit is told from a validation by
 * identity (F14), and the fiber keeps what the chain answers without anyone
 * mutating the input (F12). A pin that goes red here sends the design back to
 * the plan.
 *
 * Two host cores run these cases, and each listener decodes the call it gets
 * (`configCall`) rather than asking for a version: the OLD core (cordis 4.0.5,
 * 4.0.6-alpha.1) calls `function (this: Fiber, raw, next)`, the NEW one
 * (4.0.6-alpha.2, 4.1.0) calls `(fiber, next)` with `this` null and its own
 * schema as a listener. Where the cores differ, a case holds one expectation
 * per shape, and checks the shape it saw against `coreShapeOf`, a marker read
 * from the fiber's own fields, so each branch is known to run on its core.
 *
 * Host references are into `deepseek-harness` at the tag `host-versions.ts`
 * names: `vendor/cordis/src/…` and `packages/llm/…`.
 *
 * @module test/host-waterfall.test
 */
import type { Context, Fiber } from "@deepseek-ai/cordis";
import { LlmAdapter } from "@deepseek-ai/dsh-llm";
import { afterEach, describe, expect, it } from "vitest";

import {
  configCall,
  type ConfigShape,
  coreShapeOf,
  effectiveConfigOf,
  rawConfigOf,
} from "./support/config-shape.ts";
import {
  deepFreeze,
  mountTierA,
  routeIds,
  s0Providers,
  stripPlanesListener,
  type TierA,
  waterfallSpy,
} from "./support/host.ts";

/** The resolved provider keys pi-ai's fiber holds. */
const resolvedKeys = (fiber: Fiber): string[] =>
  Object.keys(
    (
      effectiveConfigOf(fiber) as {
        providers: { get: () => Record<string, unknown> };
      }
    ).providers.get()
  ).toSorted();

/** An adapter that registers and never streams: the claim's stand-in. */
class StubAdapter extends LlmAdapter {
  // oxlint-disable-next-line require-yield -- never streams; the registry is the subject.
  async *stream(): AsyncIterable<never> {
    throw new Error("never streams");
  }
}

let tier: TierA | undefined;

afterEach(async () => {
  await tier?.dispose();
  tier = undefined;
});

describe("host · the internal/config waterfall (tier A)", () => {
  it("F11 — pi-ai registers exactly the keys of its resolved config (llm-pi-ai/src/index.ts:168-176,299,307)", async () => {
    tier = await mountTierA({ providers: s0Providers() });
    expect(routeIds(tier.llm)).toEqual(resolvedKeys(tier.piFiber));
    expect(routeIds(tier.llm)).toEqual(["deepseek", "opencode", "opencode-go"]);
  });

  it("F11 — the RESOLVED keys, not the raw ones: with a listener stripping the planes, the routes follow the resolved config while the raw still holds all three", async () => {
    tier = await mountTierA({
      before: (ctx) => {
        ctx.on("internal/config", stripPlanesListener);
      },
      providers: s0Providers(),
    });
    expect(routeIds(tier.llm)).toEqual(resolvedKeys(tier.piFiber));
    expect(routeIds(tier.llm)).toEqual(["deepseek"]);
    expect(
      Object.keys(
        (rawConfigOf(tier.piFiber) as { providers: Record<string, unknown> })
          .providers
      ).toSorted()
    ).toEqual(["deepseek", "opencode", "opencode-go"]);
  });

  it("F8/F12 — a listener another plugin prepends fires for pi-ai's fiber outermost, on either call shape (cordis events.ts: OLD 234-243,254-260; NEW 246-261; the NEW schema listener 156-159)", async () => {
    tier = await mountTierA({ providers: s0Providers() });
    const { piFiber } = tier;
    const order: string[] = [];
    const seen: {
      name: string;
      shape: ConfigShape;
      fiber: Fiber;
      self: unknown;
      args: readonly unknown[];
      next: unknown;
    }[] = [];
    // A sibling plugin, mounted AFTER pi-ai: its plain listener lands after
    // pi-ai's own (inner), its prepended one before everything (outer).
    await tier.ctx.plugin({
      apply(c: Context) {
        c.on(
          "internal/config",
          function listenerA(this: unknown, ...args: unknown[]) {
            const call = configCall<Fiber>(this, args);
            const value = call.next();
            if (call.fiber.runtime?.name === "llm-pi-ai") {
              order.push("A");
              seen.push({ ...call, args, name: "A", next: value, self: this });
            }
            return value;
          }
        );
        c.on(
          "internal/config",
          function listenerB(this: unknown, ...args: unknown[]) {
            const call = configCall<Fiber>(this, args);
            if (call.fiber.runtime?.name !== "llm-pi-ai") {
              return call.next();
            }
            order.push("B:enter");
            const value = call.next();
            seen.push({ ...call, args, name: "B", next: value, self: this });
            order.push("B:exit");
            return value;
          },
          { prepend: true }
        );
      },
      name: "claimer",
    });
    const input = { providers: s0Providers() };
    await Promise.resolve(piFiber.update(input));
    await piFiber.await();
    // Two runs: `update` resolves while ACTIVE (OLD fiber.ts:747; NEW
    // fiber.ts:787), then the restart re-resolves the stored raw (OLD
    // fiber.ts:655; NEW fiber.ts:255). B brackets A both times, so B is
    // outermost and A runs inside the chain B started.
    expect(order).toEqual(["B:enter", "A", "B:exit", "B:enter", "A", "B:exit"]);
    const core = coreShapeOf(piFiber);
    const byName = (name: string) =>
      seen.filter((record) => record.name === name);
    for (const record of seen) {
      expect(record.fiber).toBe(piFiber);
      expect(record.shape).toBe(core);
    }
    if (core === "old") {
      // OLD: `this` is the fiber, and the raw candidate is an argument that
      // every listener shares.
      for (const record of seen) {
        expect(record.self).toBe(piFiber);
      }
      expect(byName("A")[0]?.args[0]).toBe(input);
      expect(byName("B")[0]?.args[0]).toBe(input);
    } else {
      // NEW: `this` is null, and the raw candidate is reachable only through
      // `next()`. A is innermost, so its `next()` is the input itself; B is
      // outer to the built-in schema listener, so its `next()` is already
      // resolved (a volatile `providers` with a callable `get`).
      for (const record of seen) {
        expect(record.self).toBeNull();
        expect(record.args[0]).toBe(piFiber);
      }
      expect(byName("A")[0]?.next).toBe(input);
      const outer = byName("B")[0]?.next as {
        providers?: { get?: unknown };
      };
      expect(outer).not.toBe(input);
      expect(typeof outer.providers?.get).toBe("function");
    }
    expect(piFiber.state).toBe(2);
  });

  it("F8/F4 — pi-ai's own listener validates the value its inner chain returns, not what an outer listener will return (llm-pi-ai/src/index.ts:177-186; config.ts:364-368)", async () => {
    // Read for P-R1: an outer listener that strips the planes and returns a
    // copy does NOT shield pi-ai's save check, which runs on `next()`'s value.
    // A listener INSIDE pi-ai's (registered after it, unprepended) is what
    // that check sees. The same on both cores.
    tier = await mountTierA({ providers: s0Providers() });
    const order: string[] = [];
    await tier.ctx.plugin({
      apply(c: Context) {
        c.on(
          "internal/config",
          function addUnknownId(this: unknown, ...args: unknown[]) {
            const call = configCall<Fiber>(this, args);
            const raw = call.next();
            if (call.fiber.runtime?.name !== "llm-pi-ai") {
              return raw;
            }
            order.push("A");
            // A changed plane holding an id pi's catalog does not describe.
            const candidate = structuredClone(raw) as {
              providers: Record<string, { models?: { id: string }[] }>;
            };
            candidate.providers.opencode?.models?.push({
              id: "not-a-real-model",
            });
            return candidate;
          }
        );
        c.on(
          "internal/config",
          function bracket(this: unknown, ...args: unknown[]) {
            const call = configCall<Fiber>(this, args);
            if (call.fiber.runtime?.name !== "llm-pi-ai") {
              return call.next();
            }
            order.push("B:enter");
            try {
              return call.next();
            } catch (error) {
              order.push("B:pi-ai threw");
              throw error;
            }
          },
          { prepend: true }
        );
      },
      name: "claimer",
    });
    // The strict check covers the whole changed plane, so it names the first
    // id it cannot place: S0's stored gap model, ahead of the one A added. An
    // unchanged plane is not checked at all (the case above). The throw is
    // synchronous on both cores: `update` resolves before it returns.
    expect(() => tier?.piFiber.update({ providers: s0Providers() })).toThrow(
      /provider "opencode" model "gpt-5\.3-codex-spark" needs an api/u
    );
    expect(order).toEqual(["B:enter", "A", "B:pi-ai threw"]);
  });

  it("F14 — a run's raw is the fiber's raw config on _reload; on update it is on the OLD core only (cordis fiber.ts: OLD 641-644,655,738,747; NEW 255,787-789)", async () => {
    tier = await mountTierA({ providers: s0Providers() });
    const { piFiber } = tier;
    const core = coreShapeOf(piFiber);
    const spy = waterfallSpy(tier.ctx, () => piFiber);
    await piFiber.restart();
    expect(spy.records).toHaveLength(1);
    expect(spy.records[0]?.shape).toBe(core);
    expect(spy.records[0]?.isCommit).toBe(true);
    expect(spy.records[0]?.state).toBe(1);
    expect(spy.records[0]?.raw).toBe(rawConfigOf(piFiber));

    spy.records.length = 0;
    const next = structuredClone(rawConfigOf(piFiber));
    await Promise.resolve(piFiber.update(next));
    await piFiber.await();
    for (const record of spy.records) {
      expect(record.raw).toBe(next);
    }
    if (core === "old") {
      // OLD assigns `_config` before it resolves (fiber.ts:738,747), so the
      // update's own run is already a commit by identity.
      expect(spy.records.map((record) => record.isCommit)).toEqual([
        true,
        true,
      ]);
    } else {
      // NEW resolves before it assigns (fiber.ts:787-789): the update's own
      // run sees the previous raw, while the fiber is still ACTIVE.
      expect(spy.records.map((record) => record.isCommit)).toEqual([
        false,
        true,
      ]);
      expect(spy.records[0]?.state).toBe(2);
      expect(spy.records[1]?.state).toBe(1);
    }
    expect(rawConfigOf(piFiber)).toBe(next);
  });

  it("F12 — a deep-frozen input is never mutated, and the fiber resolves what the chain answers (cordis fiber.ts: OLD 642,655; NEW 255,676-679; utils.ts:117-125)", async () => {
    const frozen = deepFreeze({ providers: s0Providers() });
    tier = await mountTierA({
      before: (ctx) => {
        ctx.on("internal/config", stripPlanesListener);
      },
      piConfig: frozen,
      providers: {},
    });
    const { piFiber } = tier;
    expect(rawConfigOf(piFiber)).toBe(frozen);
    expect(
      Object.keys((rawConfigOf(piFiber) as typeof frozen).providers).toSorted()
    ).toEqual(["deepseek", "opencode", "opencode-go"]);
    expect(resolvedKeys(piFiber)).toEqual(["deepseek"]);
    expect(routeIds(tier.llm)).toEqual(["deepseek"]);
  });

  it("F13 (tier A half) — with the planes stripped, registerAdapter(planes) passes the duplicate check and the directory still lists both under llm-pi-ai (llm/src/index.ts:401-445; llm-pi-ai/src/index.ts:128-150)", async () => {
    tier = await mountTierA({
      before: (ctx) => {
        ctx.on("internal/config", stripPlanesListener);
      },
      providers: s0Providers(),
    });
    expect(routeIds(tier.llm)).toEqual(["deepseek"]);
    const handle = tier.llm.registerAdapter(
      ["opencode", "opencode-go"],
      new StubAdapter()
    );
    try {
      expect(routeIds(tier.llm)).toEqual([
        "deepseek",
        "opencode",
        "opencode-go",
      ]);
      const directory = tier.llm.listConfigurableProviders();
      for (const id of ["opencode", "opencode-go"]) {
        expect(directory.find((entry) => entry.provider === id)).toMatchObject({
          settingsNs: "llm-pi-ai",
          settingsPath: ["providers", id],
        });
      }
    } finally {
      handle();
    }
  });

  it("F13 control — while pi-ai holds the planes, registering them is DUPLICATE_ADAPTER (llm/src/index.ts:443)", async () => {
    tier = await mountTierA({ providers: s0Providers() });
    expect(() =>
      tier?.llm.registerAdapter(["opencode"], new StubAdapter())
    ).toThrow(expect.objectContaining({ code: "DUPLICATE_ADAPTER" }));
  });
});
