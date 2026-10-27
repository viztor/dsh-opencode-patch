/**
 * The `internal/config` waterfall, pinned on the real host (tier A).
 *
 * The route-claim design (docs/improvement-plan.md, D13) rests on cordis and
 * pi-ai behaving exactly as these cases say: pi-ai registers the keys of its
 * RESOLVED config (F11), a listener another plugin prepends wraps pi-ai's
 * fiber and runs outermost (F8), a commit is told from a validation by
 * identity (F14), and the fiber keeps the outermost listener's return value
 * without anyone mutating the input (F12). A pin that goes red here sends the
 * design back to the plan.
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
  deepFreeze,
  mountTierA,
  routeIds,
  s0Providers,
  type TierA,
  waterfallSpy,
  withoutPlanes,
} from "./support/host.ts";

/** The resolved provider keys pi-ai's fiber holds. */
const resolvedKeys = (fiber: Fiber): string[] =>
  Object.keys(
    (
      fiber.config as { providers: { get: () => Record<string, unknown> } }
    ).providers.get()
  ).toSorted();

/** The raw config the fiber stores (`fiber._config`). */
const rawOf = (fiber: Fiber): unknown =>
  (fiber as unknown as { _config: unknown })._config;

/** An adapter that registers and never streams: the claim's stand-in. */
class StubAdapter extends LlmAdapter {
  // oxlint-disable-next-line require-yield -- never streams; the registry is the subject.
  async *stream(): AsyncIterable<never> {
    throw new Error("never streams");
  }
}

/**
 * The listener the claim design installs: for pi-ai's fiber only, the inner
 * chain runs and the fiber keeps a fresh copy without the planes.
 */
function stripPlanesForPiAi(
  this: Fiber,
  raw: unknown,
  next: () => unknown
): unknown {
  if (this.runtime?.name !== "llm-pi-ai") {
    return next();
  }
  const copy = withoutPlanes(raw);
  next();
  return copy;
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
        ctx.on("internal/config", stripPlanesForPiAi, { prepend: true });
      },
      providers: s0Providers(),
    });
    expect(routeIds(tier.llm)).toEqual(resolvedKeys(tier.piFiber));
    expect(routeIds(tier.llm)).toEqual(["deepseek"]);
    expect(
      Object.keys(
        (rawOf(tier.piFiber) as { providers: Record<string, unknown> })
          .providers
      ).toSorted()
    ).toEqual(["deepseek", "opencode", "opencode-go"]);
  });

  it("F8/F12 — a listener another plugin prepends fires for pi-ai's fiber with this === fiber, outermost (cordis events.ts:234-243,254-260)", async () => {
    tier = await mountTierA({ providers: s0Providers() });
    const order: string[] = [];
    const seen: { name: string; self: unknown; raw: unknown }[] = [];
    // A sibling plugin, mounted AFTER pi-ai: its plain listener lands after
    // pi-ai's own (inner), its prepended one before everything (outer).
    await tier.ctx.plugin({
      apply(c: Context) {
        c.on(
          "internal/config",
          function listenerA(this: Fiber, raw: unknown, next: () => unknown) {
            if (this.runtime?.name === "llm-pi-ai") {
              order.push("A");
              seen.push({ name: "A", raw, self: this });
            }
            return next();
          }
        );
        c.on(
          "internal/config",
          function listenerB(this: Fiber, raw: unknown, next: () => unknown) {
            if (this.runtime?.name !== "llm-pi-ai") {
              return next();
            }
            order.push("B:enter");
            seen.push({ name: "B", raw, self: this });
            const value = next();
            order.push("B:exit");
            return value;
          },
          { prepend: true }
        );
      },
      name: "claimer",
    });
    const input = { providers: s0Providers() };
    tier.piFiber.update(input);
    await tier.piFiber.await();
    // Two runs: `update` resolves while ACTIVE (fiber.ts:747), then the
    // restart re-resolves the stored raw (fiber.ts:655). B brackets A both
    // times, so B is outermost and A runs inside the chain B started.
    expect(order).toEqual(["B:enter", "A", "B:exit", "B:enter", "A", "B:exit"]);
    for (const record of seen) {
      expect(record.self).toBe(tier.piFiber);
    }
    expect(seen[0]?.raw).toBe(input);
    expect(tier.piFiber.state).toBe(2);
  });

  it("F8/F4 — pi-ai's own listener validates the value its inner chain returns, not what an outer listener will return (llm-pi-ai/src/index.ts:177-186; config.ts:364-368)", async () => {
    // Read for P-R1: an outer listener that strips the planes and returns a
    // copy does NOT shield pi-ai's save check, which runs on `next()`'s value.
    // A listener INSIDE pi-ai's (registered after it, unprepended) is what
    // that check sees.
    tier = await mountTierA({ providers: s0Providers() });
    const order: string[] = [];
    await tier.ctx.plugin({
      apply(c: Context) {
        c.on(
          "internal/config",
          function addUnknownId(
            this: Fiber,
            raw: unknown,
            next: () => unknown
          ) {
            if (this.runtime?.name !== "llm-pi-ai") {
              return next();
            }
            order.push("A");
            next();
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
          function bracket(this: Fiber, _raw: unknown, next: () => unknown) {
            if (this.runtime?.name !== "llm-pi-ai") {
              return next();
            }
            order.push("B:enter");
            try {
              return next();
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
    expect(() => {
      tier?.piFiber.update({ providers: s0Providers() });
      // The strict check covers the whole changed plane, so it names the
      // first id it cannot place: S0's stored gap model, ahead of the one A
      // added. An unchanged plane is not checked at all (the case above).
    }).toThrow(
      /provider "opencode" model "gpt-5\.3-codex-spark" needs an api/u
    );
    expect(order).toEqual(["B:enter", "A", "B:pi-ai threw"]);
  });

  it("F14 — raw === fiber._config on _reload and on update (cordis fiber.ts:641-644,655,738,747)", async () => {
    tier = await mountTierA({ providers: s0Providers() });
    const { piFiber } = tier;
    const spy = waterfallSpy(tier.ctx, () => piFiber);
    await piFiber.restart();
    expect(spy.records).toHaveLength(1);
    expect(spy.records[0]?.isCommit).toBe(true);
    expect(spy.records[0]?.raw).toBe(rawOf(piFiber));

    spy.records.length = 0;
    const next = structuredClone(rawOf(piFiber));
    piFiber.update(next);
    await piFiber.await();
    expect(spy.records.map((record) => record.isCommit)).toEqual([true, true]);
    for (const record of spy.records) {
      expect(record.raw).toBe(next);
    }
    expect(rawOf(piFiber)).toBe(next);
  });

  it("F12 — a deep-frozen input is never mutated, and the fiber keeps the outermost listener's return value (cordis fiber.ts:642,655; utils.ts:117-125)", async () => {
    const frozen = deepFreeze({ providers: s0Providers() });
    tier = await mountTierA({
      before: (ctx) => {
        ctx.on("internal/config", stripPlanesForPiAi, { prepend: true });
      },
      piConfig: frozen,
      providers: {},
    });
    const { piFiber } = tier;
    expect(rawOf(piFiber)).toBe(frozen);
    expect(
      Object.keys((rawOf(piFiber) as typeof frozen).providers).toSorted()
    ).toEqual(["deepseek", "opencode", "opencode-go"]);
    expect(resolvedKeys(piFiber)).toEqual(["deepseek"]);
    expect(routeIds(tier.llm)).toEqual(["deepseek"]);
  });

  it("F13 (tier A half) — with the planes stripped, registerAdapter(planes) passes the duplicate check and the directory still lists both under llm-pi-ai (llm/src/index.ts:401-445; llm-pi-ai/src/index.ts:128-150)", async () => {
    tier = await mountTierA({
      before: (ctx) => {
        ctx.on("internal/config", stripPlanesForPiAi, { prepend: true });
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
