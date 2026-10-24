/**
 * The harness's own seams, each exercised once (`test/support/host.ts`).
 *
 * P-R1 builds on options no contract or characterization case passes: this
 * plugin mounted in tier A (through the host-module seam, since tier A has no
 * loader), a profile row for it in tier B, and a custom responder on the
 * recording fetch. A builder nobody has run is a builder whose behaviour a
 * later phase would assume, so each is run here and what it does is recorded. So are
 * tier B's two failure paths: a first row whose config the schema rejects (in
 * each apply order), and a key the contributor's shell exports.
 *
 * @module test/host-harness.test
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  adaptersOf,
  type ApplyOrder,
  bootTierB,
  characterizedProviders,
  drainStream,
  fakeCredentials,
  mountTierA,
  PLANES,
  piAiRestarts,
  recordingFetch,
  S0_TODAY,
  s0Providers,
  type TierA,
  type TierB,
  waitForPlaneOwner,
} from "./support/host.ts";

/** The ids of a listing, in order. */
const modelIds = (models: readonly { id: string }[]): string[] =>
  models.map((model) => model.id);

let tierA: TierA | undefined;
let tierB: TierB | undefined;

afterEach(async () => {
  try {
    await tierA?.dispose();
    await tierB?.dispose();
  } finally {
    tierA = undefined;
    tierB = undefined;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  }
});

/** cordis `FiberState`: the two a booted row ends in here. */
const ACTIVE = 2;
const FAILED = 3;

/** A two-chunk chat-completions stream that ends with `stop`. */
const completionStream = (model: string): Response => {
  const chunk = (delta: object, finish: string | null) =>
    `data: ${JSON.stringify({
      choices: [{ delta, finish_reason: finish, index: 0 }],
      created: 1,
      id: "harness",
      model,
      object: "chat.completion.chunk",
    })}\n\n`;
  return new Response(
    `${chunk({ content: "hello", role: "assistant" }, null)}${chunk({}, "stop")}data: [DONE]\n\n`,
    { headers: { "content-type": "text/event-stream" }, status: 200 }
  );
};

describe(
  "host harness · its seams (tiers A and B)",
  { timeout: 30_000 },
  () => {
    it("tier A with the plugin: it reads the host's modules through the seam, claims both planes with one pi-ai restart (pi-ai mounted first), and disposal hands them back and restores fetch", async () => {
      vi.spyOn(console, "info").mockImplementation(() => {
        // Silenced: the activation line.
      });
      const wire = recordingFetch();
      vi.stubGlobal("fetch", wire.fetch);
      let restarts: ReturnType<typeof piAiRestarts> | undefined;
      tierA = await mountTierA({
        before: (ctx) => {
          restarts = piAiRestarts(ctx);
        },
        plugin: {},
        providers: {
          opencode: { models: [{ id: "deepseek-v4-pro" }] },
          "opencode-go": { models: [{ id: "deepseek-v4-pro" }] },
        },
      });
      expect(tierA.pluginFiber?.state).toBe(2);
      expect(globalThis.fetch).not.toBe(wire.fetch);
      // Tier A mounts pi-ai first, so it held the planes; the mount restarted
      // it once, through the claim's listener, and registered its own adapter.
      await waitForPlaneOwner(tierA.llm);
      expect(restarts?.count()).toBe(1);
      expect(
        adaptersOf(tierA.llm).get("opencode")?.adapter.constructor.name
      ).toBe("PlaneAdapter");
      expect([...adaptersOf(tierA.llm).keys()].toSorted()).toEqual([...PLANES]);
      await tierA.pluginFiber?.dispose();
      await waitForPlaneOwner(tierA.llm, PLANES, "PiAiAdapter");
      expect(globalThis.fetch).toBe(wire.fetch);
    });

    it("tier B with pluginConfig: the profile row reaches the plugin's fiber config", async () => {
      vi.stubGlobal("fetch", recordingFetch().fetch);
      tierB = await bootTierB({ pluginConfig: { debug: true } });
      const config = tierB.pluginEntry?.fiber?.config as
        | { debug?: unknown }
        | undefined;
      // `debug` defaults to false, so only the row can make it true.
      expect(config?.debug).toBe(true);
    });

    it("recordingFetch with a responder: a turn is answered by it and still recorded, so a test can drive a stream to completion", async () => {
      const wire = recordingFetch({
        respond: (request) => completionStream(request.model ?? ""),
      });
      vi.stubGlobal("fetch", wire.fetch);
      tierA = await mountTierA({
        credentials: fakeCredentials({ refs: { OPENCODE_API_KEY: "k" } }),
        providers: {
          opencode: {
            apiKeyEnv: "OPENCODE_API_KEY",
            models: [{ id: "deepseek-v4-pro" }],
          },
        },
      });
      const drained = await drainStream(
        tierA.llm,
        "opencode",
        "deepseek-v4-pro"
      );
      expect(drained.error).toBeUndefined();
      expect(drained.finish).toEqual({ code: undefined, kind: "stop" });
      expect(drained.types).toContain("text-delta");
      expect(wire.requests.map((request) => request.model)).toEqual([
        "deepseek-v4-pro",
      ]);
    });
    it.each([
      [
        "plugin-first",
        "an invalid plugin row",
        { pluginConfig: { debug: "not-a-boolean" } },
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
        vi.stubGlobal("fetch", recordingFetch().fetch);
        tierB = await bootTierB({ order: order as ApplyOrder, ...rows });
        const [failedEntry, heldEntry] =
          order === "plugin-first"
            ? [tierB.pluginEntry, tierB.piEntry]
            : [tierB.piEntry, tierB.pluginEntry];
        expect(failedEntry?.fiber?.state).toBe(FAILED);
        // The real error is readable, not a hook timeout.
        await expect(failedEntry?.fiber?.await()).rejects.toThrow(
          order === "plugin-first" ? /debug/u : /displayName/u
        );
        expect(heldEntry?.fiber?.state).toBe(ACTIVE);
      },
      15_000
    );

    it("tier B with OPENCODE_API_KEY exported: the boot blanks it, so the deployment measured is still the keyless one, and dispose puts it back", async () => {
      vi.stubEnv("OPENCODE_API_KEY", "sk-ambient-not-a-key");
      vi.stubEnv("OPENCODE_GO_API_KEY", "sk-ambient-go-not-a-key");
      vi.stubGlobal("fetch", recordingFetch().fetch);
      tierB = await bootTierB({
        credentials: fakeCredentials({
          refs: {
            OPENCODE_API_KEY: "zen-test",
            OPENCODE_GO_API_KEY: "go-test",
          },
        }),
        providers: characterizedProviders(),
      });
      await waitForPlaneOwner(tierB.llm);
      expect(process.env.OPENCODE_API_KEY).toBe("");
      expect(process.env.OPENCODE_GO_API_KEY).toBe("");
      // The listing no longer depends on a key (D21): every declared id.
      for (const plane of PLANES) {
        expect(modelIds(await tierB.llm.listModels(plane)), plane).toEqual(
          S0_TODAY.listingBeforeTurn[plane]
        );
      }
      await tierB.dispose();
      tierB = undefined;
      expect(process.env.OPENCODE_API_KEY).toBe("sk-ambient-not-a-key");
      expect(process.env.OPENCODE_GO_API_KEY).toBe("sk-ambient-go-not-a-key");
    });

    it("tier B leaves an unset key unset", async () => {
      // oxlint-disable-next-line unicorn/no-useless-undefined -- `stubEnv` deletes the variable only when handed `undefined`, and restores it after.
      vi.stubEnv("OPENCODE_API_KEY", undefined);
      tierB = await bootTierB({ plugin: false, providers: s0Providers() });
      expect(process.env.OPENCODE_API_KEY).toBeUndefined();
      await tierB.dispose();
      tierB = undefined;
      expect(process.env.OPENCODE_API_KEY).toBeUndefined();
    });
  }
);
