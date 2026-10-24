/**
 * The harness's own seams, each exercised once (`test/support/host.ts`).
 *
 * P-R1 builds on options no contract or characterization case passes: this
 * plugin mounted in tier A, a profile row for it in tier B, and a custom
 * responder on the recording fetch. A builder nobody has run is a builder
 * whose behaviour a later phase would assume, so each is run here and what it
 * does is recorded — including that tier A's plugin is a DEGRADED one. So are
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
  recordingFetch,
  S0_TODAY,
  s0Providers,
  type TierA,
  type TierB,
  waitForRoutes,
} from "./support/host.ts";
import { INTERNAL_ROUTES, loadPiAiAdapterHost } from "./support/src.ts";

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

/** Poll until `predicate` holds, or fail after `deadlineMs`. */
const until = async (
  predicate: () => boolean,
  what: string,
  deadlineMs = 10_000
): Promise<void> => {
  const end = Date.now() + deadlineMs;
  while (!predicate()) {
    if (Date.now() > end) {
      throw new Error(`never happened: ${what}`);
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
  }
};

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
    it("tier A with the plugin: it applies and patches fetch, but WITHOUT a loader it cannot find pi-ai, so no hidden route mounts; disposal restores fetch", async () => {
      const info = vi.spyOn(console, "info").mockImplementation(() => {
        // Silenced: the case reads the calls, not the console.
      });
      const wire = recordingFetch();
      vi.stubGlobal("fetch", wire.fetch);
      tierA = await mountTierA({
        plugin: {},
        providers: { opencode: { models: [{ id: "deepseek-v4-pro" }] } },
      });
      expect(tierA.pluginFiber?.state).toBe(2);
      expect(globalThis.fetch).not.toBe(wire.fetch);
      // The plugin finds pi-ai through the loader's entries
      // (`piAiEntry` in src/responses-provider.ts), and tier A has no loader: the mount
      // reports that and stands down. A P-R1 case that needs the real plugin
      // beside pi-ai belongs in tier B.
      await until(
        () =>
          info.mock.calls.some((call) =>
            String(call[0]).includes("no loaded llm-pi-ai in this composition")
          ),
        "the mount's stand-down line"
      );
      const registry = adaptersOf(tierA.llm);
      for (const route of INTERNAL_ROUTES) {
        expect(registry.has(route), route).toBe(false);
      }
      expect([...registry.keys()]).toEqual(["opencode"]);
      // The Google bridge's absence is pinned by its CAUSE, not its outcome:
      // this case declares no Google model, so an empty registry above would
      // hold for that reason alone. The bridge builds its adapter from the
      // record `loadPiAiAdapterHost` answers (src/responses-provider.ts), and
      // registerGoogleBridge stands down without its `PiAiAdapter`
      // (src/google-bridge.ts) — and without a loader there is no record.
      await expect(loadPiAiAdapterHost(tierA.ctx)).resolves.toBeUndefined();
      await tierA.dispose();
      tierA = undefined;
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
      await waitForRoutes(tierB.llm, ["opencode-responses"]);
      expect(process.env.OPENCODE_API_KEY).toBe("");
      expect(process.env.OPENCODE_GO_API_KEY).toBe("");
      // The plugin reads the environment for its keyless listing filter: with
      // the shell's key left in place, the paid models would be listed here.
      for (const plane of PLANES) {
        expect(await tierB.llm.listModels(plane), plane).toEqual(
          S0_TODAY.keylessListing[plane]
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
