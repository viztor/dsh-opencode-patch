/**
 * The plane's per-call headers, on the real host (OC4, OC5).
 *
 * pi-ai shapes a request's headers through its adapter's `prepareHeaders`
 * option, which its own `apply` wires to the `llm-pi-ai/request-headers`
 * waterfall; the plugin's `PlaneAdapter` is built with one too, so a
 * contributor of another plugin's runs on the planes the plugin serves (OC4),
 * and the plugin sets its own plane headers there, per call, before any
 * contributor (OC5). The fetch patch then leaves a per-call-shaped request's
 * plane headers alone.
 *
 * Tier B registers a contributor on the root before any row mounts, as a
 * plugin of the composition would; tier A replaces `globalThis.fetch` after
 * the mount with a recorder that never calls through, so the fetch patch is
 * out of the path and what reaches the wire is what the adapter sent.
 *
 * @module test/host-planes-headers.test
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { disposeBooted, offline, wire } from "./support/host-planes.ts";
import {
  bootTierB,
  drainStream,
  fakeCredentials,
  mountTierA,
  recordingFetch,
  type TierA,
  type TierB,
  waitForPlaneOwner,
} from "./support/host.ts";
import { DEFAULT_ORIGIN_CLIENT, openCodeSessionIdFor } from "./support/src.ts";

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
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});

const MODEL = "deepseek-v4-pro";
const ZEN_BASE = "https://opencode.ai/inference/openai/v1";

describe(
  "host planes · a request-headers contributor runs on the planes the plugin serves (tier B, OC4)",
  { timeout: 30_000 },
  () => {
    it("is called once per call with pi-ai's frozen request, sees the plugin's session header, and its own header reaches the wire", async () => {
      const seen: unknown[] = [];
      let sawSession: string | null = null;
      offline();
      tierB = await bootTierB({
        credentials: fakeCredentials({ refs: { OPENCODE_API_KEY: "k" } }),
        prepare: (root) => {
          root.on(
            "llm-pi-ai/request-headers" as never,
            ((request: unknown, headers: Headers, next: () => Headers) => {
              seen.push(request);
              sawSession = headers.get("x-opencode-session");
              headers.set("x-contributor", "1");
              headers.set("x-opencode-project", "from-listener");
              return next();
            }) as never
          );
        },
        providers: {
          opencode: { apiKeyEnv: "OPENCODE_API_KEY", models: [{ id: MODEL }] },
        },
      });
      await waitForPlaneOwner(tierB.llm, ["opencode"]);
      const before = wire.requests.length;
      await drainStream(tierB.llm, "opencode", MODEL, {
        sessionId: "oc4-session",
      });
      const sent = wire.requests
        .slice(before)
        .filter((request) => !request.url.startsWith("https://models."));
      expect(seen).toHaveLength(1);
      const [request] = seen as Record<string, unknown>[];
      expect(Object.isFrozen(request)).toBe(true);
      expect(request?.provider).toBe("opencode");
      expect(request?.model).toBe(MODEL);
      expect(request?.sessionId).toBe("oc4-session");
      expect(request?.baseURL).toBe(ZEN_BASE);
      expect(sawSession).toBe(openCodeSessionIdFor("oc4-session"));
      expect(sent).toHaveLength(1);
      expect(sent[0]?.headers["x-contributor"]).toBe("1");
      expect(sent[0]?.headers["x-opencode-project"]).toBe("from-listener");
      expect(sent[0]?.headers["x-opencode-session"]).toBe(
        openCodeSessionIdFor("oc4-session")
      );
    });

    it("a contributor that throws fails the turn with REQUEST_HEADERS and sends nothing, as on pi-ai's own routes", async () => {
      offline();
      tierB = await bootTierB({
        credentials: fakeCredentials({ refs: { OPENCODE_API_KEY: "k" } }),
        prepare: (root) => {
          root.on(
            "llm-pi-ai/request-headers" as never,
            (() => {
              throw new Error("policy");
            }) as never
          );
        },
        providers: {
          opencode: { apiKeyEnv: "OPENCODE_API_KEY", models: [{ id: MODEL }] },
        },
      });
      await waitForPlaneOwner(tierB.llm, ["opencode"]);
      const before = wire.requests.length;
      const drained = await drainStream(tierB.llm, "opencode", MODEL);
      const sent = wire.requests
        .slice(before)
        .filter((request) => !request.url.startsWith("https://models."));
      expect(drained.finish?.code).toBe("REQUEST_HEADERS");
      expect(sent).toEqual([]);
    });
  }
);

describe(
  "host planes · the plane headers are set per call, with the fetch patch out of the path (tier A, OC5)",
  { timeout: 30_000 },
  () => {
    /**
     * One characterized model per protocol on Zen, and one Go row, each with
     * the path its protocol posts to: asserted on the request, so a catalog
     * move of an id cannot quietly drop a protocol from the table.
     */
    const ROWS = [
      ["opencode", "deepseek-v4-pro", "/chat/completions"],
      ["opencode", "gpt-5.4", "/responses"],
      ["opencode", "claude-haiku-5-5", "/messages"],
      ["opencode", "gemini-3-flash", ":streamGenerateContent"],
      ["opencode-go", "minimax-m3", "/messages"],
    ] as const;

    it.each(ROWS)(
      "%s/%s (%s) carries the derived session id and the plane headers",
      async (route, model, path) => {
        offline();
        tierA = await mountTierA({
          credentials: fakeCredentials({
            refs: { OPENCODE_API_KEY: "k", OPENCODE_GO_API_KEY: "g" },
          }),
          plugin: {},
          providers: {
            opencode: {
              apiKeyEnv: "OPENCODE_API_KEY",
              models: ROWS.filter(([plane]) => plane === "opencode").map(
                ([, id]) => ({ id })
              ),
            },
            "opencode-go": {
              apiKeyEnv: "OPENCODE_GO_API_KEY",
              models: [{ id: "minimax-m3" }],
            },
          },
        });
        await waitForPlaneOwner(tierA.llm);
        // Out of the path: a recorder that never calls through to the patch.
        const recorder = recordingFetch();
        vi.stubGlobal("fetch", recorder.fetch);
        await drainStream(tierA.llm, route, model, { sessionId: "oc5" });
        const sent = recorder.requests.filter(
          (request) => !request.url.startsWith("https://models.")
        );
        expect(sent).toHaveLength(1);
        expect(new URL(sent[0]?.url ?? "").pathname, sent[0]?.url).toMatch(
          new RegExp(`${path.replace(".", "\\.")}$`, "u")
        );
        const headers = sent[0]?.headers ?? {};
        const derived = openCodeSessionIdFor("oc5");
        expect(headers["x-opencode-session"]).toBe(derived);
        expect(headers["x-opencode-session-id"]).toBe(derived);
        expect(headers["x-opencode-client"]).toBe(DEFAULT_ORIGIN_CLIENT);
        expect(headers["x-opencode-project"]).toBe("global");
        // L4, a characterization rather than a decision (P-R2 measured
        // nothing; carried to P10a): a minted `msg_` id, sent on every
        // protocol. Dropping it is this line and `planeHeadersFor`.
        expect(headers["x-opencode-request"]).toMatch(
          /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/u
        );
        expect(headers["x-session-affinity"]).toBeUndefined();
      }
    );
  }
);
