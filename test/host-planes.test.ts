/**
 * The plugin owning the plane routes, on the real host (tiers A and B; D13).
 *
 * The P-R1 rows of the plan's test matrix that the characterization does not
 * already carry: who owns the planes and how often pi-ai restarts for it, the
 * claim's lifecycle, how an edit flows through it, which routes are
 * registered, where a key comes from (D20), and that nothing of a sibling
 * route leaks into a plane. Every case boots its own host and reads the
 * registry, the profile file and the wire — never the plugin's own state.
 *
 * This file holds who owns the planes and the claim's lifecycle; its siblings
 * hold the config flow and the route set (`host-planes-config`) and the
 * credentials and isolation (`host-planes-credentials`). The shared boot and
 * readers are `support/host-planes.ts`.
 *
 * @module test/host-planes.test
 */
import { readFileSync, writeFileSync } from "node:fs";

import {
  readProfilePatches,
  reconcileProfilePatches,
} from "@deepseek-ai/dsh-app-boot";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  appendTo,
  bootPlanes,
  disposeBooted,
  offline,
  routeIds,
  settle,
  stateOf,
  wire,
} from "./support/host-planes.ts";
import {
  type ApplyOrder,
  bootTierB,
  characterizedProviders,
  drainStream,
  fakeCredentials,
  FIBER_STATE,
  mountTierA,
  ownerOf,
  PLANES,
  S0_TODAY,
  s0Providers,
  SAVE_CANDIDATE,
  type TierA,
  type TierB,
  until,
  waitForPlaneOwner,
} from "./support/host.ts";
import {
  apply,
  clearCapturedApiKeys,
  Config,
  inject,
  LEGACY_NAME,
  LEGACY_PKG,
  name,
} from "./support/src.ts";

let tierA: TierA | undefined;

let tierB: TierB | undefined;

afterEach(async () => {
  try {
    await tierA?.dispose();
    await tierB?.dispose();
    await disposeBooted();
  } finally {
    tierA = undefined;
    tierB = undefined;
    clearCapturedApiKeys();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});

describe(
  "host planes · ownership and restart counts (tier B)",
  { timeout: 30_000 },
  () => {
    it.each([
      ["pi-ai-first", 1],
      ["plugin-first", 0],
    ] as const)(
      "%s: pi-ai restarts %i time(s), both planes are the plugin's, and no registration is ever refused",
      async (order, expected) => {
        const { logged, restarts, tier } = await bootPlanes({ order });
        await waitForPlaneOwner(tier.llm);
        await settle();
        expect(restarts()).toBe(expected);
        expect(routeIds(tier.llm)).toEqual(["deepseek", ...PLANES]);
        // A DUPLICATE_ADAPTER that escaped into pi-ai's apply fails pi-ai; one
        // the claim caught is logged as "still held elsewhere", and any other
        // refusal as "did not register". None of them happens in either order.
        expect(tier.piFiber.state).toBe(FIBER_STATE.ACTIVE);
        expect(tier.pluginEntry?.fiber?.state).toBe(FIBER_STATE.ACTIVE);
        tier.ctx.logger.info("[host-planes] the log is read");
        const lines = logged();
        expect(lines.at(-1)).toContain("[host-planes] the log is read");
        expect(
          lines.filter((line) =>
            /still held elsewhere|plane routes did not register|DUPLICATE_ADAPTER/u.test(
              line
            )
          )
        ).toEqual([]);
        // A row filed under the current id and package is not told to rename.
        expect(lines).not.toContainEqual(
          expect.stringContaining("has been renamed")
        );
      }
    );

    it.each([
      [
        "plugin-first",
        "an invalid plugin row",
        { pluginRow: { config: { debug: "not-a-boolean" } } },
      ],
      [
        "pi-ai-first",
        "an invalid pi-ai profile",
        { providers: { deepseek: { displayName: 42 } } },
      ],
    ] as const)(
      "tier B, %s with %s: the first row FAILS without applying, the held row is still released, and the boot finishes promptly",
      async (order, _what, rows) => {
        // Before the fallback release, the held row waited for an `apply` that
        // never came, and the boot hung until the hook timed out.
        vi.spyOn(process.stderr, "write").mockImplementation(() => true);
        offline();
        tierB = await bootTierB({ order: order as ApplyOrder, ...rows });
        const [failedEntry, heldEntry] =
          order === "plugin-first"
            ? [tierB.pluginEntry, tierB.piEntry]
            : [tierB.piEntry, tierB.pluginEntry];
        expect(failedEntry?.fiber?.state).toBe(FIBER_STATE.FAILED);
        // The real error is readable, not a hook timeout.
        await expect(failedEntry?.fiber?.await()).rejects.toThrow(
          order === "plugin-first" ? /debug/u : /displayName/u
        );
        expect(heldEntry?.fiber?.state).toBe(FIBER_STATE.ACTIVE);
      },
      15_000
    );

    it("pi-ai FAILED for a sibling route while its plane entries are valid: nothing is claimed, the plugin stays active, and no plane is listed", async () => {
      const providers = characterizedProviders();
      // A route-level error on `deepseek` fails pi-ai's whole fiber; the
      // plane entries themselves are well formed and stay in its raw config.
      providers.deepseek = { ...providers.deepseek, api: "nope" };
      const { tier } = await bootPlanes({ order: "pi-ai-first", providers });
      await until(
        () =>
          stateOf(tier.piFiber) === FIBER_STATE.FAILED &&
          stateOf(tier.pluginEntry?.fiber) === FIBER_STATE.ACTIVE,
        "pi-ai fails and the plugin is active"
      );
      // The claim reconciles on every registry change and after its mount;
      // let every one of them run before reading the registry.
      await settle();
      const raw = (
        tier.piFiber as unknown as { _config: { providers: object } }
      )._config.providers;
      expect(Object.keys(raw)).toEqual(expect.arrayContaining([...PLANES]));
      expect(
        tier.llm
          .listProviders()
          .filter((provider) =>
            (PLANES as readonly string[]).includes(provider.id)
          )
      ).toEqual([]);
    });
  }
);

describe("host planes · lifecycle", { timeout: 30_000 }, () => {
  // Either half of the old filing is enough: the notice fires on the legacy
  // id OR the legacy package, so each is booted on its own (the other half is
  // the current one).
  it.each([
    ["id", { id: LEGACY_NAME }],
    ["package", { name: LEGACY_PKG }],
  ] as const)(
    "a row still filed under the pre-rename %s is told to rename, and serves the planes all the same (tier B)",
    async (_half, pluginRow) => {
      const { logged, tier } = await bootPlanes({ pluginRow });
      await waitForPlaneOwner(tier.llm);
      // The row really is filed the way the case says.
      expect(tier.pluginEntry?.options.id).toBe(
        "id" in pluginRow ? pluginRow.id : name
      );
      tier.ctx.logger.info("[host-planes] the log is read");
      const lines = logged();
      expect(lines.at(-1)).toContain("[host-planes] the log is read");
      expect(lines).toContainEqual(
        expect.stringContaining(`"${LEGACY_PKG}" has been renamed to "${name}"`)
      );
    }
  );

  it("disabling the plugin's row hands both planes back to pi-ai, and the next Settings save of a plane holding a gap id is refused with the file unchanged (tier B)", async () => {
    const { tier } = await bootPlanes();
    await waitForPlaneOwner(tier.llm);
    const { pluginEntry } = tier;
    if (pluginEntry === undefined) {
      throw new Error("no plugin row");
    }
    // Disable the row in the profile patch and reload the profile, the way
    // a profile edit reaches a running host: the loader disposes its fiber.
    const rows = JSON.parse(
      readFileSync(tier.profile.patchPath, "utf8")
    ) as unknown[];
    writeFileSync(
      tier.profile.patchPath,
      `${JSON.stringify([...rows, { disabled: true, id: pluginEntry.options.id }], null, 2)}\n`
    );
    await reconcileProfilePatches(
      tier.ctx as never,
      readProfilePatches("dsh", tier.profile),
      "dsh"
    );
    await until(
      () => pluginEntry.fiber === undefined || pluginEntry.fiber.uid === null,
      "the plugin row is disposed"
    );
    await waitForPlaneOwner(tier.llm, PLANES, "PiAiAdapter");
    expect(routeIds(tier.llm)).toEqual(["deepseek", ...PLANES]);
    const before = readFileSync(tier.profile.patchPath);
    await expect(
      tier.ctx.configEditor.edit(
        tier.piEntry,
        appendTo("opencode", SAVE_CANDIDATE)
      )
    ).rejects.toThrow(S0_TODAY.saveBlockedByStoredGap);
    expect(readFileSync(tier.profile.patchPath)).toEqual(before);
  });

  it("dispose, then apply again (tier A): the planes go back to the plugin", async () => {
    offline();
    tierA = await mountTierA({ plugin: {}, providers: s0Providers() });
    await waitForPlaneOwner(tierA.llm);
    expect(globalThis.fetch, "the mounted plugin patches fetch").not.toBe(
      wire.fetch
    );
    await tierA.pluginFiber?.dispose();
    await waitForPlaneOwner(tierA.llm, PLANES, "PiAiAdapter");
    // The real composition's teardown — the claim restarting pi-ai while the
    // patch unwinds — leaves the wire's own fetch in place.
    expect(globalThis.fetch, "the disposed plugin restored fetch").toBe(
      wire.fetch
    );
    await tierA.ctx.plugin(
      { apply, Config, inject, name } as never,
      {} as never
    );
    await waitForPlaneOwner(tierA.llm);
    expect(routeIds(tierA.llm)).toEqual(["deepseek", ...PLANES]);
  });

  it("an edit of the plugin's own row restarts pi-ai zero times and keeps the planes the plugin's (tier B)", async () => {
    const { restarts, tier } = await bootPlanes();
    await waitForPlaneOwner(tier.llm);
    const before = restarts();
    const { pluginEntry } = tier;
    if (pluginEntry === undefined) {
      throw new Error("no plugin row");
    }
    await tier.ctx.configEditor.edit(pluginEntry, (current) => ({
      ...current,
      debug: true,
    }));
    await until(
      () => (pluginEntry.fiber?.config as { debug?: boolean })?.debug === true,
      "the plugin row reloads"
    );
    await waitForPlaneOwner(tier.llm);
    expect(restarts() - before).toBe(0);
  });

  it("an llm restart registers every route again, the planes the plugin's (tier B)", async () => {
    const { tier } = await bootPlanes();
    await waitForPlaneOwner(tier.llm);
    const llmEntry = tier.ctx.configEditor
      .entries()
      .find((entry) => entry.options.id === "llm");
    await llmEntry?.fiber?.restart();
    await until(
      () => routeIds(tier.ctx.llm).length === 3,
      "every route registers again"
    );
    await waitForPlaneOwner(tier.ctx.llm);
    expect(routeIds(tier.ctx.llm)).toEqual(["deepseek", ...PLANES]);
  });

  it("pi-ai restarting itself while claimed keeps the planes the plugin's, and throws nothing (tier B)", async () => {
    const { tier } = await bootPlanes();
    await waitForPlaneOwner(tier.llm);
    await expect(tier.piFiber.restart()).resolves.toBeUndefined();
    await waitForPlaneOwner(tier.llm);
    expect(ownerOf(tier.llm, "deepseek")).toBe("PiAiAdapter");
  });

  it("a turn in flight completes after the plugin is disposed under it (tier A)", async () => {
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    offline({
      respond: (request) => {
        const chunk = (delta: object, finish: string | null) =>
          `data: ${JSON.stringify({
            choices: [{ delta, finish_reason: finish, index: 0 }],
            created: 1,
            id: "inflight",
            model: request.model,
            object: "chat.completion.chunk",
          })}\n\n`;
        const encoder = new TextEncoder();
        const body = new ReadableStream<Uint8Array>({
          async start(controller) {
            controller.enqueue(
              encoder.encode(chunk({ content: "hi", role: "assistant" }, null))
            );
            await held;
            controller.enqueue(encoder.encode(chunk({}, "stop")));
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();
          },
        });
        return new Response(body, {
          headers: { "content-type": "text/event-stream" },
          status: 200,
        });
      },
    });
    tierA = await mountTierA({
      credentials: fakeCredentials({ refs: { OPENCODE_API_KEY: "k" } }),
      plugin: {},
      providers: {
        opencode: {
          apiKeyEnv: "OPENCODE_API_KEY",
          models: [{ id: "deepseek-v4-pro" }],
        },
      },
    });
    await waitForPlaneOwner(tierA.llm, ["opencode"]);
    const inFlight = drainStream(tierA.llm, "opencode", "deepseek-v4-pro");
    await until(() => wire.requests.length > 0, "the turn is sent");
    await tierA.pluginFiber?.dispose();
    release?.();
    const drained = await inFlight;
    expect(drained.error).toBeUndefined();
    expect(drained.finish?.kind).not.toBe("error");
    expect(drained.types).toContain("text-delta");
  });
});
