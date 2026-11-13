/**
 * The real composition: a genuine cordis `Context`, not a stand-in.
 *
 * The DeepSeek harness's testing policy states the rule this file exists for:
 *
 * > A hand-built `ctx.plugin(...)` suite is insufficient. Boot a test-only
 * > composition through Loader and assert model-visible request/log, durable
 * > state, or user-visible output.
 *
 * The bug that motivated it is exactly that class. Every unit test passed while
 * `opencodeModelPurge` was mounted on the host and unreachable from the browser,
 * because each asserted the CALL rather than the RESULT: "the service was
 * mounted", "the descriptors list what they list". Neither was false. The
 * feature was still dead.
 *
 * **Why a real `Context` and not an object literal.** Their plugins use
 * `new Context()` because `@deepseek-ai/cordis` is a peer dependency in every one
 * of their 312 packages. It is one here too now, so this test can mount the
 * plugin the way the Loader does — `ctx.plugin({ inject, apply })` — which means
 * cordis itself decides whether the plugin activates. A missing or wrong
 * declaration then fails HERE, in the suite, instead of throwing in a deployment
 * as `cannot get property "loader" without inject`.
 *
 * @module test/composition.test
 */
import { Context } from "@deepseek-ai/cordis";
import { describe, expect, it } from "vitest";

import {
  type CordisContext,
  apply,
  inject,
  inspectPatch,
} from "./support/src.ts";

/** The `llm` service, shaped as the plugin reads it, with its own discovery. */
const llmService = () => ({
  discoverModels: async (): Promise<unknown> => [],
  listModels: async () => [],
  listProviders: () => [],
  registerAdapter: () => () => {},
});

/**
 * Mount the plugin the way the Loader does.
 *
 * `inject` is the plugin's OWN declaration — empty, so the root activates
 * before `llm` exists and everything that needs `llm` waits in a child scope —
 * and cordis itself decides when each part runs, which a hand-built context
 * could not.
 */
const mount = async (
  options: {
    readonly withLlm?: boolean;
    readonly config?: Record<string, unknown>;
  } = {}
) => {
  const ctx = new Context();
  if (options.withLlm !== false) {
    ctx.provide("llm", llmService() as never);
  }
  let activated = false;
  const fiber = ctx.plugin({
    inject,
    apply: (scope: unknown) => {
      activated = true;
      return apply(scope as CordisContext, options.config ?? {});
    },
  });
  await fiber.await?.();
  await new Promise((resolve) => {
    setTimeout(resolve, 10);
  });
  return { activated, ctx };
};

describe("composition · a real cordis Context", () => {
  it("activates without `llm`, and what needs `llm` waits in a child scope until it is provided", async () => {
    // The root declares nothing (`inject` is []), so its `internal/config`
    // listener is in place before `llm` — and before pi-ai — exists. What does
    // need `llm` is reached through `ctx.inject`, and runs only once cordis
    // provides it.
    expect(inject).toEqual([]);
    const service = llmService();
    const original = service.discoverModels;
    const without = await mount({ withLlm: false });
    expect(without.activated, "the root waits for nothing").toBe(true);
    without.ctx.provide("llm", service as never);
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
    // The `llm` scope ran: Settings' discovery is wrapped on the service.
    const installed = Reflect.getOwnPropertyDescriptor(
      service,
      "discoverModels"
    )?.value;
    expect(installed).not.toBe(original);
    expect(inspectPatch(installed, "discoverModels")).toEqual([
      expect.objectContaining({
        id: "dsh-opencode-patch/model-discovery",
        live: true,
      }),
    ]);
  });

  it("leaves the purge service reachable through ctx.get", async () => {
    // The exact failure that shipped: the service mounted, the namespace was
    // never contributed, and the row said "unavailable" forever. Here the
    // question is the consumer's, through the same access path the host uses.
    const { ctx } = await mount({ config: { usageEnabled: false } });
    const purge = ctx.get("opencodeModelPurge") as
      | { purge?: unknown }
      | undefined;
    expect(purge, "the purge service must be reachable").toBeDefined();
    expect(typeof purge?.purge).toBe("function");
  });

  it("leaves the store-inspection service reachable through ctx.get", async () => {
    // The same failure mode as the purge row, for the same reason: the card's
    // "check this machine" button resolves the namespace at click time, and a
    // service that mounted under the wrong name answers `undefined` there — which
    // the card can only report as "this host mounted no inspection service".
    const { ctx } = await mount({ config: { usageEnabled: false } });
    const store = ctx.get("opencodeStore") as { inspect?: unknown } | undefined;
    expect(store, "the inspection service must be reachable").toBeDefined();
    expect(typeof store?.inspect).toBe("function");
  });

  it("leaves the usage service reachable only while the meter is on", async () => {
    const off = await mount({ config: { usageEnabled: false } });
    expect(off.ctx.get("opencodeGoUsage")).toBeUndefined();

    const on = await mount({ config: { usageEnabled: true } });
    const usage = on.ctx.get("opencodeGoUsage") as
      | { read?: unknown }
      | undefined;
    expect(usage, "the meter needs a reachable usage service").toBeDefined();
    expect(typeof usage?.read).toBe("function");
  });

  it("installs without a config editor, which must not throw", async () => {
    // A composition without the settings service is a real deployment: the
    // card's purge row reports unavailability rather than the plugin failing to
    // load. Proven by mounting, not by reading a branch.
    const { activated, ctx } = await mount({ config: { usageEnabled: false } });
    expect(activated).toBe(true);
    expect(ctx.get("opencodeModelPurge")).toBeDefined();
  });
});
