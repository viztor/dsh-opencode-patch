/**
 * A plane entry another plugin owns, on the real host (tiers A and B; D27).
 *
 * A vendor plugin can serve `opencode`/`opencode-go` through pi-ai itself: it
 * overrides pi-ai's row with `isolate: { credentials: <its realm> }` and a
 * `config` that replaces pi-ai's, provides `credentials` in that realm, and
 * marks each route it writes with an `x-opencode-plugin` header. The route
 * claim steps aside for such an entry: pi-ai keeps it and serves it with its
 * own `PiAiAdapter`, nothing of this plugin's decorates its traffic, and the
 * plugin never reaches into the realm. Detected from the row and the entry,
 * never from a vendor or a version.
 *
 * The fixture is this test's own: a pi-ai row in a realm, a tiny plugin in the
 * same realm whose `credentials` answer only `OPENCODE_CONSOLE_TOKEN`
 * (`realmCredentialsPlugin`), and plane entries that name that token and carry
 * the marker. No vendor file is read. Every case boots its own host and reads
 * the registry, pi-ai's resolved config, the log and the wire.
 *
 * @module test/host-planes-foreign.test
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { effectiveConfigOf } from "./support/config-shape.ts";
import {
  adaptersOf,
  APPLY_ORDERS,
  type ApplyOrder,
  bootTierB,
  drainStream,
  type FakeCredentials,
  fakeCredentials,
  type HostLlm,
  logLines,
  modelsPageRows,
  mountTierA,
  ownerOf,
  PLANES,
  piAiRestarts,
  recordingFetch,
  type RecordedRequest,
  type RecordingFetch,
  SAVE_CANDIDATE,
  type TierA,
  type TierB,
  waitForPlaneOwner,
} from "./support/host.ts";
import {
  clearCapturedApiKeys,
  getCapturedApiKey,
  OPENCODE_UA,
  SESSION_HEADER,
} from "./support/src.ts";

/** The realm label the fixture isolates pi-ai's credentials into. */
const REALM = "console-test-realm";
/** The one reference the realm's credentials answer. */
const TOKEN_REF = "OPENCODE_CONSOLE_TOKEN";
/** Its value; a length no other key here has, since the wire keeps lengths. */
const TOKEN = "realm-token-0123456789-abcdef";
/** The marker header, in the case a vendor writes it. */
const MARKER = { "x-opencode-plugin": "console-fixture/0.0.0" } as const;
/** A model pi's own catalog serves on both planes, on completions. */
const MODEL = "deepseek-v4-pro";

type Providers = Record<string, Record<string, unknown>>;

/** A plane entry the way the vendor writes one: its token, its marker. */
const marked = (): Record<string, unknown> => ({
  apiKeyEnv: TOKEN_REF,
  headers: { ...MARKER },
  models: [{ id: MODEL }],
});

/** A plane entry of the user's own, unmarked. */
const plain = (apiKeyEnv: string): Record<string, unknown> => ({
  apiKeyEnv,
  models: [{ id: MODEL }],
});

/** Headers only this plugin writes on the wire (pi's own set excluded). */
const OURS = [
  "x-opencode-session-id",
  "x-opencode-client",
  "x-opencode-project",
  "x-opencode-request",
  "x-session-affinity",
] as const;

/** A line the claim logs when it leaves a route to pi-ai. */
const STEPPED_ASIDE = /leaves the route (opencode|opencode-go) to pi-ai/u;

let tierA: TierA | undefined;
let tierB: TierB | undefined;
let wire: RecordingFetch;

afterEach(async () => {
  try {
    await tierA?.dispose();
    await tierB?.dispose();
  } finally {
    tierA = undefined;
    tierB = undefined;
    clearCapturedApiKeys();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});

/** Stub `fetch` with a fresh recorder (before mounting the plugin). */
const offline = (): void => {
  wire = recordingFetch();
  vi.stubGlobal("fetch", wire.fetch);
};

/** Let every queued microtask and timer of a settled host run. */
const settle = async (): Promise<void> => {
  for (let index = 0; index < 20; index += 1) {
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
  }
};

/** The plane keys pi-ai's RESOLVED config holds: what it registers. */
const resolvedPlanes = (fiber: unknown): string[] => {
  const config = effectiveConfigOf(fiber as never) as {
    providers?: unknown;
  };
  const providers = config.providers as
    | { get?: () => Record<string, unknown> }
    | Record<string, unknown>
    | undefined;
  const value =
    typeof (providers as { get?: unknown } | undefined)?.get === "function"
      ? (providers as { get: () => Record<string, unknown> }).get()
      : (providers as Record<string, unknown> | undefined);
  return PLANES.filter((plane) => Object.hasOwn(value ?? {}, plane));
};

/** One turn's gateway requests, the catalog read excluded. */
const turn = async (
  llm: HostLlm,
  route: string
): Promise<{
  drained: Awaited<ReturnType<typeof drainStream>>;
  requests: RecordedRequest[];
}> => {
  const before = wire.requests.length;
  const drained = await drainStream(llm, route, MODEL);
  return {
    drained,
    requests: wire.requests
      .slice(before)
      .filter(
        (request) => !request.url.startsWith("https://models.opencode.ai/")
      ),
  };
};

/** Boot tier B with pi-ai's row in the fixture's realm. */
const bootRealm = async (options: {
  readonly order?: ApplyOrder;
  readonly plugin?: boolean;
  readonly pluginConfig?: Record<string, unknown>;
  readonly providers: Providers;
  readonly realm?: boolean;
}): Promise<{
  tier: TierB;
  realm: FakeCredentials;
  restarts: () => number;
  logged: () => string[];
}> => {
  offline();
  const realm = fakeCredentials({ refs: { [TOKEN_REF]: TOKEN } });
  let restarts: ReturnType<typeof piAiRestarts> | undefined;
  let log: ReturnType<typeof logLines> | undefined;
  tierB = await bootTierB({
    // The process-wide service holds the user's own keys and never the
    // realm's token: a plugin outside the realm cannot resolve it.
    credentials: fakeCredentials({
      refs: { OPENCODE_API_KEY: "zen-k", OPENCODE_GO_API_KEY: "go-k" },
    }),
    order: options.order ?? "plugin-first",
    plugin: options.plugin ?? true,
    ...(options.pluginConfig === undefined
      ? {}
      : { pluginConfig: options.pluginConfig }),
    prepare: (root) => {
      restarts = piAiRestarts(root);
      log = logLines(root);
    },
    providers: options.providers,
    ...(options.realm === false
      ? {}
      : { realm: { credentials: realm, label: REALM } }),
  });
  return {
    logged: () => log?.lines() ?? [],
    realm,
    restarts: () => restarts?.count() ?? 0,
    tier: tierB,
  };
};

/** The lines that say a route was left to pi-ai, by route. */
const steppedAsideLines = (lines: readonly string[]): string[] =>
  lines.filter((line) => STEPPED_ASIDE.test(line));

describe(
  "host planes · a route another plugin owns (tier B, D27)",
  { timeout: 30_000 },
  () => {
    it("the fixture is what it says: pi-ai alone in the realm serves both planes with the realm's token (the known answer)", async () => {
      const { realm, tier } = await bootRealm({
        plugin: false,
        providers: { opencode: marked(), "opencode-go": marked() },
      });
      await waitForPlaneOwner(tier.llm, PLANES, "PiAiAdapter");
      expect(tier.piEntry.options.isolate).toEqual({ credentials: REALM });
      const { requests } = await turn(tier.llm, "opencode");
      expect(requests).toHaveLength(1);
      expect(requests[0]?.headers.authorization).toBe(`Bearer ${TOKEN}`.length);
      expect(realm.calls).toContainEqual(["resolve", TOKEN_REF]);
      expect(tier.credentials.calls).not.toContainEqual(["resolve", TOKEN_REF]);
    });

    it.each(APPLY_ORDERS)(
      "%s: pi-ai keeps both realm planes and serves them, the plugin registers none, restarts pi-ai zero times, and says so once per entry",
      async (order) => {
        const { logged, restarts, tier } = await bootRealm({
          order,
          providers: { opencode: marked(), "opencode-go": marked() },
        });
        await waitForPlaneOwner(tier.llm, PLANES, "PiAiAdapter");
        await settle();
        expect(resolvedPlanes(tier.piFiber)).toEqual([...PLANES]);
        expect(
          [...adaptersOf(tier.llm).values()].filter(
            (row) => row.adapter.constructor.name === "PlaneAdapter"
          )
        ).toEqual([]);
        expect(restarts()).toBe(0);
        tier.ctx.logger.info("[host-planes-foreign] the log is read");
        const lines = logged();
        expect(lines.at(-1)).toContain("[host-planes-foreign] the log is read");
        const stepped = steppedAsideLines(lines);
        expect(stepped).toHaveLength(2);
        for (const plane of PLANES) {
          expect(
            stepped.filter((line) =>
              line.includes(`leaves the route ${plane} to pi-ai`)
            )
          ).toHaveLength(1);
        }
        // The realm is the reason, named as the row isolates it.
        expect(stepped.every((line) => line.includes(REALM))).toBe(true);
      }
    );

    it("a turn on a realm plane resolves the realm's token, carries none of the plugin's headers or its session id, and nothing is captured", async () => {
      // The known answer: what pi-ai alone sends for this turn.
      const alone = await bootRealm({
        plugin: false,
        providers: { opencode: marked(), "opencode-go": marked() },
      });
      await waitForPlaneOwner(alone.tier.llm, PLANES, "PiAiAdapter");
      const { requests: baseline } = await turn(alone.tier.llm, "opencode-go");
      await alone.tier.dispose();
      tierB = undefined;

      const { realm, tier } = await bootRealm({
        providers: { opencode: marked(), "opencode-go": marked() },
      });
      await waitForPlaneOwner(tier.llm, PLANES, "PiAiAdapter");
      await settle();
      const { requests } = await turn(tier.llm, "opencode-go");
      expect(requests).toHaveLength(1);
      expect(baseline).toHaveLength(1);
      const [sent] = requests;
      const [expected] = baseline;
      expect(sent?.url).toBe(expected?.url);
      expect(sent?.headers.authorization).toBe(`Bearer ${TOKEN}`.length);
      expect(sent?.headers["x-opencode-plugin"]).toBe(
        MARKER["x-opencode-plugin"]
      );
      // The header NAMES pi-ai alone sends, and no other.
      expect(Object.keys(sent?.headers ?? {}).toSorted()).toEqual(
        Object.keys(expected?.headers ?? {}).toSorted()
      );
      for (const header of OURS) {
        expect(sent?.headers).not.toHaveProperty(header);
      }
      expect(sent?.headers["user-agent"]).not.toBe(OPENCODE_UA);
      expect(sent?.headers[SESSION_HEADER]).toBe(
        expected?.headers[SESSION_HEADER]
      );
      expect(realm.calls).toContainEqual(["resolve", TOKEN_REF]);
      expect(tier.credentials.calls).not.toContainEqual(["resolve", TOKEN_REF]);
      expect(getCapturedApiKey("opencode-go")).toBeUndefined();
      expect(getCapturedApiKey(undefined, "go")).toBeUndefined();
      expect(getCapturedApiKey(undefined, "zen")).toBeUndefined();
    });

    it("the realm alone is enough: unmarked entries in a realm the plugin does not share stay pi-ai's", async () => {
      const { logged, restarts, tier } = await bootRealm({
        order: "pi-ai-first",
        providers: {
          opencode: plain(TOKEN_REF),
          "opencode-go": plain(TOKEN_REF),
        },
      });
      await waitForPlaneOwner(tier.llm, PLANES, "PiAiAdapter");
      await settle();
      expect(restarts()).toBe(0);
      expect(steppedAsideLines(logged())).toHaveLength(2);
      const { requests } = await turn(tier.llm, "opencode");
      expect(requests[0]?.headers.authorization).toBe(`Bearer ${TOKEN}`.length);
    });

    it("a Settings save on a realm plane is judged by pi-ai's own check, not the plugin's", async () => {
      const { tier } = await bootRealm({
        providers: { opencode: marked(), "opencode-go": marked() },
      });
      await waitForPlaneOwner(tier.llm, PLANES, "PiAiAdapter");
      // The plugin's check accepts an id no catalog describes (D15); pi-ai's
      // own refuses it for want of an api. pi-ai's answer is the one given.
      await expect(
        tier.ctx.configEditor.edit(tier.piEntry, (current) => {
          const providers = { ...(current.providers as Providers) };
          providers.opencode = {
            ...providers.opencode,
            models: [{ id: MODEL }, { id: SAVE_CANDIDATE }],
          };
          return { ...current, providers };
        })
      ).rejects.toThrow(/needs an api/u);
    });

    it("disabling the plugin with only realm planes restarts pi-ai zero times and leaves them served", async () => {
      const { restarts, tier } = await bootRealm({
        providers: { opencode: marked(), "opencode-go": marked() },
      });
      await waitForPlaneOwner(tier.llm, PLANES, "PiAiAdapter");
      await settle();
      await tier.pluginEntry?.fiber?.dispose();
      await settle();
      expect(restarts()).toBe(0);
      expect(PLANES.map((plane) => ownerOf(tier.llm, plane))).toEqual([
        "PiAiAdapter",
        "PiAiAdapter",
      ]);
    });
  }
);

describe(
  "host planes · the marker splits one row (tiers A and B, D27)",
  { timeout: 30_000 },
  () => {
    it.each(APPLY_ORDERS)(
      "%s: a marked entry stays pi-ai's while the unmarked one beside it is the plugin's, and pi-ai restarts only for the one the plugin takes",
      async (order) => {
        const { logged, restarts, tier } = await bootRealm({
          order,
          // `debug` makes the stream hook log each turn it decorates.
          pluginConfig: { debug: true },
          providers: {
            opencode: { ...marked(), apiKeyEnv: "OPENCODE_API_KEY" },
            "opencode-go": plain("OPENCODE_GO_API_KEY"),
          },
          realm: false,
        });
        await waitForPlaneOwner(tier.llm, ["opencode-go"]);
        await waitForPlaneOwner(tier.llm, ["opencode"], "PiAiAdapter");
        await settle();
        expect(resolvedPlanes(tier.piFiber)).toEqual(["opencode"]);
        expect(restarts()).toBe(order === "pi-ai-first" ? 1 : 0);
        // Settings shows both: the marked one as pi-ai describes it, the
        // plugin's one through the graft (D18).
        expect(modelsPageRows(tier)).toEqual({
          opencode: { apiKeyEnv: "OPENCODE_API_KEY", configured: true },
          "opencode-go": { apiKeyEnv: "OPENCODE_GO_API_KEY", configured: true },
        });
        const stepped = steppedAsideLines(logged());
        expect(stepped).toHaveLength(1);
        expect(stepped[0]).toContain("leaves the route opencode to pi-ai");
        expect(stepped[0]).toContain("x-opencode-plugin");
        // The unmarked plane is decorated as before; the marked one is not,
        // by the stream hook (no turn of it is logged, so none is priced or
        // carried to the fetch patch) nor by the fetch patch.
        const decorated = (route: string): string[] =>
          logged().filter(
            (line) =>
              line.includes("streaming provider") &&
              line.split(" ").includes(route)
          );
        const go = await turn(tier.llm, "opencode-go");
        expect(go.requests[0]?.headers[SESSION_HEADER]).toMatch(/^ses_/u);
        expect(go.requests[0]?.headers["x-opencode-client"]).toBeDefined();
        expect(decorated("opencode-go")).toHaveLength(1);
        const zen = await turn(tier.llm, "opencode");
        expect(zen.requests[0]?.headers["x-opencode-plugin"]).toBeDefined();
        for (const header of OURS) {
          expect(zen.requests[0]?.headers).not.toHaveProperty(header);
        }
        expect(decorated("opencode")).toEqual([]);
      }
    );

    it("tier A: the marker is read case-insensitively, and an unmarked plane in an unisolated row is still the plugin's (the known answer)", async () => {
      offline();
      tierA = await mountTierA({
        credentials: fakeCredentials({
          refs: { OPENCODE_API_KEY: "zen-k", [TOKEN_REF]: TOKEN },
        }),
        plugin: {},
        providers: {
          opencode: plain("OPENCODE_API_KEY"),
          "opencode-go": {
            ...plain(TOKEN_REF),
            headers: { "X-OpenCode-Plugin": "console-fixture/0.0.0" },
          },
        },
      });
      await waitForPlaneOwner(tierA.llm, ["opencode"]);
      await waitForPlaneOwner(tierA.llm, ["opencode-go"], "PiAiAdapter");
      expect(resolvedPlanes(tierA.piFiber)).toEqual(["opencode-go"]);
      // The marked plane first: its request is left as pi-ai sent it, and
      // nothing is captured from it.
      const go = await turn(tierA.llm, "opencode-go");
      expect(go.requests[0]?.headers.authorization).toBe(
        `Bearer ${TOKEN}`.length
      );
      for (const header of OURS) {
        expect(go.requests[0]?.headers).not.toHaveProperty(header);
      }
      expect(getCapturedApiKey("opencode-go")).toBeUndefined();
      expect(getCapturedApiKey(undefined, "go")).toBeUndefined();
      expect(getCapturedApiKey(undefined, "zen")).toBeUndefined();
      // The known answer: the unmarked plane is decorated, and its key is
      // captured, as before.
      const zen = await turn(tierA.llm, "opencode");
      expect(zen.requests[0]?.headers[SESSION_HEADER]).toMatch(/^ses_/u);
      expect(getCapturedApiKey("opencode")).toBe("zen-k");
    });
  }
);
