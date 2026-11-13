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
  REALM_PLUGIN_PACKAGE,
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
  discoverGoConfig,
  getCapturedApiKey,
  OPENCODE_UA,
  resolveGoApiKey,
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
    vi.unstubAllEnvs();
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
  /** The process-wide credentials' refs; by default the user's two keys. */
  readonly userKeys?: Readonly<Record<string, string>>;
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
      refs: options.userKeys ?? {
        OPENCODE_API_KEY: "zen-k",
        OPENCODE_GO_API_KEY: "go-k",
      },
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

    it("the realm alone is enough: unmarked entries in a realm the plugin does not share stay pi-ai's, and their turns leave as pi-ai alone sends them, with nothing captured", async () => {
      const providers = {
        opencode: plain(TOKEN_REF),
        "opencode-go": plain(TOKEN_REF),
      };
      // The known answer: what pi-ai alone sends for these turns.
      const alone = await bootRealm({ plugin: false, providers });
      await waitForPlaneOwner(alone.tier.llm, PLANES, "PiAiAdapter");
      const baseline = new Map<string, RecordedRequest | undefined>();
      for (const plane of PLANES) {
        const { requests } = await turn(alone.tier.llm, plane);
        expect(requests).toHaveLength(1);
        baseline.set(plane, requests[0]);
      }
      await alone.tier.dispose();
      tierB = undefined;

      const { logged, realm, restarts, tier } = await bootRealm({
        order: "pi-ai-first",
        providers,
      });
      await waitForPlaneOwner(tier.llm, PLANES, "PiAiAdapter");
      await settle();
      expect(restarts()).toBe(0);
      expect(steppedAsideLines(logged())).toHaveLength(2);
      for (const plane of PLANES) {
        const { requests } = await turn(tier.llm, plane);
        expect(requests).toHaveLength(1);
        const [sent] = requests;
        const expected = baseline.get(plane);
        expect(sent?.url).toBe(expected?.url);
        expect(sent?.headers.authorization).toBe(`Bearer ${TOKEN}`.length);
        // No marker on these entries: only the realm says they are another
        // plugin's, and the fetch patch must hear it too.
        expect(sent?.headers).not.toHaveProperty("x-opencode-plugin");
        expect(Object.keys(sent?.headers ?? {}).toSorted()).toEqual(
          Object.keys(expected?.headers ?? {}).toSorted()
        );
        for (const header of [...OURS, "x-session-id"]) {
          expect(sent?.headers).not.toHaveProperty(header);
        }
        expect(sent?.headers["user-agent"]).toBe(
          expected?.headers["user-agent"]
        );
        expect(sent?.headers["user-agent"]).not.toBe(OPENCODE_UA);
      }
      expect(realm.calls).toContainEqual(["resolve", TOKEN_REF]);
      for (const plane of PLANES) {
        expect(getCapturedApiKey(plane)).toBeUndefined();
      }
      expect(getCapturedApiKey(undefined, "go")).toBeUndefined();
      expect(getCapturedApiKey(undefined, "zen")).toBeUndefined();
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

describe(
  "host planes · a live edit moves a plane between the plugin and pi-ai (tier B, D27)",
  { timeout: 30_000 },
  () => {
    /** A Settings save that sets, or drops, the marker on `opencode`. */
    const markZen = async (tier: TierB, on: boolean): Promise<void> => {
      await tier.ctx.configEditor.edit(tier.piEntry, (current) => {
        const providers = { ...(current.providers as Providers) };
        const { headers: _headers, ...rest } = providers.opencode ?? {};
        providers.opencode = on ? { ...rest, headers: { ...MARKER } } : rest;
        return { ...current, providers };
      });
      await settle();
    };

    /** A line pi-ai logs when a route it resolved is held by someone else. */
    const CONFLICT = /already registered|conflicts with an existing provider/u;

    it.each(APPLY_ORDERS)(
      "%s: adding the marker to a plane the plugin serves hands it to pi-ai at once, and dropping it takes it back, each save reaching the wire",
      async (order) => {
        const { logged, restarts, tier } = await bootRealm({
          order,
          providers: {
            opencode: plain("OPENCODE_API_KEY"),
            "opencode-go": plain("OPENCODE_GO_API_KEY"),
          },
          realm: false,
        });
        await waitForPlaneOwner(tier.llm, PLANES);
        await settle();
        const before = restarts();

        await markZen(tier, true);
        expect(ownerOf(tier.llm, "opencode")).toBe("PiAiAdapter");
        expect(ownerOf(tier.llm, "opencode-go")).toBe("PlaneAdapter");
        expect(logged().filter((line) => CONFLICT.test(line))).toEqual([]);
        expect(steppedAsideLines(logged())).toEqual([
          expect.stringContaining("leaves the route opencode to pi-ai"),
        ]);
        const handed = await turn(tier.llm, "opencode");
        expect(handed.requests).toHaveLength(1);
        expect(handed.requests[0]?.headers.authorization).toBe(
          "Bearer zen-k".length
        );
        expect(handed.requests[0]?.headers["x-opencode-plugin"]).toBeDefined();
        for (const header of OURS) {
          expect(handed.requests[0]?.headers).not.toHaveProperty(header);
        }

        await markZen(tier, false);
        expect(ownerOf(tier.llm, "opencode")).toBe("PlaneAdapter");
        expect(logged().filter((line) => CONFLICT.test(line))).toEqual([]);
        const taken = await turn(tier.llm, "opencode");
        expect(taken.requests).toHaveLength(1);
        expect(taken.requests[0]?.headers[SESSION_HEADER]).toMatch(/^ses_/u);
        // Neither save restarts pi-ai: each is a live update of its routes.
        expect(restarts()).toBe(before);
      }
    );

    it("adding the marker to the only plane the plugin serves hands it to pi-ai too", async () => {
      const { logged, tier } = await bootRealm({
        providers: { opencode: plain("OPENCODE_API_KEY") },
        realm: false,
      });
      await waitForPlaneOwner(tier.llm, ["opencode"]);
      await settle();
      await markZen(tier, true);
      expect(ownerOf(tier.llm, "opencode")).toBe("PiAiAdapter");
      expect(logged().filter((line) => CONFLICT.test(line))).toEqual([]);
      const { requests } = await turn(tier.llm, "opencode");
      expect(requests).toHaveLength(1);
      expect(requests[0]?.headers.authorization).toBe("Bearer zen-k".length);
    });
  }
);

describe(
  "host planes · a live change of pi-ai's realm alone moves its planes (tier B, D27)",
  { timeout: 30_000 },
  () => {
    /** The user's own key, as the process-wide service answers it. */
    const USER_KEY = "zen-k";

    /**
     * Boot with the realm's credentials row in place and pi-ai's row inside
     * the realm or outside it, declaring `opencode` under the user's own
     * reference. The realm answers that reference with its own token, so the
     * wire says which realm resolved a turn.
     */
    const bootIsolable = async (
      order: ApplyOrder,
      isolated: boolean
    ): Promise<{
      tier: TierB;
      restarts: () => number;
      logged: () => string[];
    }> => {
      offline();
      let restarts: ReturnType<typeof piAiRestarts> | undefined;
      let log: ReturnType<typeof logLines> | undefined;
      const patch = [
        {
          insert: [
            {
              id: "realm-credentials",
              isolate: { credentials: REALM },
              name: REALM_PLUGIN_PACKAGE,
            },
          ],
        },
        {
          config: { providers: { opencode: plain("OPENCODE_API_KEY") } },
          id: "llm-pi-ai",
          ...(isolated ? { isolate: { credentials: REALM } } : {}),
        },
      ];
      tierB = await bootTierB({
        credentials: fakeCredentials({
          refs: { OPENCODE_API_KEY: USER_KEY },
        }),
        order,
        prepare: (root) => {
          restarts = piAiRestarts(root);
          log = logLines(root);
        },
        profilePatchYaml: `${JSON.stringify(patch, null, 2)}\n`,
        realm: {
          credentials: fakeCredentials({
            refs: { OPENCODE_API_KEY: TOKEN },
          }),
          label: REALM,
        },
      });
      return {
        logged: () => log?.lines() ?? [],
        restarts: () => restarts?.count() ?? 0,
        tier: tierB,
      };
    };

    /** Change pi-ai's row's `isolate` and nothing else, as a live edit does. */
    const isolatePiAi = async (
      tier: TierB,
      isolate: Record<string, unknown> | null
    ): Promise<void> => {
      await tier.piEntry.update({ isolate } as never);
      await settle();
    };

    it.each(APPLY_ORDERS)(
      "%s: isolating pi-ai's row into a realm the plugin does not share hands the plane to pi-ai, which serves it with the realm's key",
      async (order) => {
        const { logged, restarts, tier } = await bootIsolable(order, false);
        await waitForPlaneOwner(tier.llm, ["opencode"]);
        await settle();
        const ours = await turn(tier.llm, "opencode");
        expect(ours.requests).toHaveLength(1);
        expect(ours.requests[0]?.headers.authorization).toBe(
          `Bearer ${USER_KEY}`.length
        );
        const before = restarts();

        await isolatePiAi(tier, { credentials: REALM });
        await waitForPlaneOwner(tier.llm, ["opencode"], "PiAiAdapter");
        expect(resolvedPlanes(tier.piFiber)).toEqual(["opencode"]);
        // One restart, so pi-ai re-resolves with the plane it now keeps.
        expect(restarts() - before).toBe(1);
        expect(steppedAsideLines(logged())).toEqual([
          expect.stringContaining(REALM),
        ]);
        const theirs = await turn(tier.llm, "opencode");
        expect(theirs.requests).toHaveLength(1);
        expect(theirs.drained.finish?.code).not.toBe("NO_ADAPTER");
        expect(theirs.requests[0]?.headers.authorization).toBe(
          `Bearer ${TOKEN}`.length
        );
        for (const header of OURS) {
          expect(theirs.requests[0]?.headers).not.toHaveProperty(header);
        }
      }
    );

    it.each(APPLY_ORDERS)(
      "%s: taking pi-ai's row out of the realm hands the plane to the plugin, which serves it with the user's key",
      async (order) => {
        const { restarts, tier } = await bootIsolable(order, true);
        await waitForPlaneOwner(tier.llm, ["opencode"], "PiAiAdapter");
        await settle();
        const theirs = await turn(tier.llm, "opencode");
        expect(theirs.requests[0]?.headers.authorization).toBe(
          `Bearer ${TOKEN}`.length
        );
        const before = restarts();

        await isolatePiAi(tier, null);
        await waitForPlaneOwner(tier.llm, ["opencode"]);
        expect(resolvedPlanes(tier.piFiber)).toEqual([]);
        expect(restarts() - before).toBe(1);
        const ours = await turn(tier.llm, "opencode");
        expect(ours.requests).toHaveLength(1);
        expect(ours.requests[0]?.headers.authorization).toBe(
          `Bearer ${USER_KEY}`.length
        );
        expect(ours.requests[0]?.headers[SESSION_HEADER]).toMatch(/^ses_/u);
      }
    );

    it.each(APPLY_ORDERS)(
      "%s: a row whose reason changes says so again: marked entries isolated into a realm are reported once more, by the realm, and stay pi-ai's",
      async (order) => {
        const { logged, restarts, tier } = await bootRealm({
          order,
          providers: { opencode: marked(), "opencode-go": marked() },
          realm: false,
        });
        await waitForPlaneOwner(tier.llm, PLANES, "PiAiAdapter");
        await settle();
        const byMarker = steppedAsideLines(logged());
        expect(byMarker).toHaveLength(2);
        expect(
          byMarker.every((line) => line.includes("x-opencode-plugin"))
        ).toBe(true);
        const before = restarts();

        await isolatePiAi(tier, { credentials: REALM });
        const lines = steppedAsideLines(logged());
        expect(lines).toHaveLength(4);
        for (const plane of PLANES) {
          expect(
            lines
              .slice(2)
              .filter(
                (line) =>
                  line.includes(`leaves the route ${plane} to pi-ai`) &&
                  line.includes(REALM)
              )
          ).toHaveLength(1);
        }
        expect(restarts()).toBe(before);
        expect(PLANES.map((plane) => ownerOf(tier.llm, plane))).toEqual([
          "PiAiAdapter",
          "PiAiAdapter",
        ]);
      }
    );
  }
);

describe(
  "host planes · the realm is the one each row RESOLVES, a group's included (tier B, D27)",
  { timeout: 30_000 },
  () => {
    it("the plugin's row inside a group isolated into pi-ai's realm shares it: the plugin serves the planes with the realm's key, and nothing steps aside", async () => {
      offline();
      const realm = fakeCredentials({ refs: { [TOKEN_REF]: TOKEN } });
      let log: ReturnType<typeof logLines> | undefined;
      const patch = [
        {
          insert: [
            {
              id: "realm-credentials",
              isolate: { credentials: REALM },
              name: REALM_PLUGIN_PACKAGE,
            },
          ],
        },
        {
          config: {
            providers: {
              opencode: plain(TOKEN_REF),
              "opencode-go": plain(TOKEN_REF),
            },
          },
          id: "llm-pi-ai",
          isolate: { credentials: REALM },
        },
        {
          insert: [
            {
              // The plugin's row declares no realm of its own: it inherits the
              // group's, which is pi-ai's.
              config: [
                { id: "dsh-opencode-patch", name: "dsh-opencode-patch" },
              ],
              id: "realm-group",
              isolate: { credentials: REALM },
              name: "cordis:group",
            },
          ],
        },
      ];
      tierB = await bootTierB({
        credentials: fakeCredentials({ refs: {} }),
        plugin: false,
        prepare: (root) => {
          log = logLines(root);
        },
        profilePatchYaml: `${JSON.stringify(patch, null, 2)}\n`,
        realm: { credentials: realm, label: REALM },
      });
      await waitForPlaneOwner(tierB.llm, PLANES);
      await settle();
      expect(steppedAsideLines(log?.lines() ?? [])).toEqual([]);
      const { requests } = await turn(tierB.llm, "opencode-go");
      expect(requests).toHaveLength(1);
      expect(requests[0]?.headers.authorization).toBe(`Bearer ${TOKEN}`.length);
      expect(requests[0]?.headers[SESSION_HEADER]).toMatch(/^ses_/u);
      expect(realm.calls).toContainEqual(["resolve", TOKEN_REF]);
    });
  }
);

describe(
  "host planes · the meter never reads another plugin's entry (tier B, D27)",
  { timeout: 30_000 },
  () => {
    /**
     * A base the vendor's routes might name, which the meter must not adopt:
     * on the gateway's host, so the recorder answers it, and on neither of its
     * families, so the meter would ask it for `/usage` as written.
     */
    const VENDOR_BASE = "https://opencode.ai/workspace-fixture/v1";

    /** The usage service the plugin mounts on the root. */
    const usageOf = (
      tier: TierB
    ): { readonly read: (query?: unknown) => Promise<unknown> } =>
      tier.ctx.get("opencodeGoUsage") as {
        readonly read: (query?: unknown) => Promise<unknown>;
      };

    /**
     * One meter read; what it answers is not under test (the recorder refuses
     * every key), only what it sent.
     */
    const readUsage = async (tier: TierB): Promise<void> => {
      try {
        await usageOf(tier).read({ provider: "opencode-go" });
      } catch {
        // The 401 the recorder answers, or a missing key.
      }
    };

    const usageRequests = (): RecordedRequest[] =>
      wire.requests.filter((request) => request.url.endsWith("/usage"));

    it("with the realm's token exported and no Go key of the user's own, the meter neither adopts the realm entry's reference nor sends the token", async () => {
      vi.stubEnv(TOKEN_REF, TOKEN);
      const { tier } = await bootRealm({
        userKeys: {},
        providers: {
          opencode: { ...marked(), baseURL: VENDOR_BASE },
          "opencode-go": { ...marked(), baseURL: VENDOR_BASE },
        },
      });
      await waitForPlaneOwner(tier.llm, PLANES, "PiAiAdapter");
      await settle();
      const pluginCtx = tier.pluginEntry?.fiber?.ctx;
      expect(discoverGoConfig(pluginCtx)).toEqual({});
      expect(
        await resolveGoApiKey(pluginCtx, "opencode-go", "auto", false)
      ).toBeUndefined();
      await readUsage(tier);
      for (const request of usageRequests()) {
        expect(request.headers.authorization).not.toBe(
          `Bearer ${TOKEN}`.length
        );
      }
    });

    it("the user's own Go key goes to the Go endpoint, never to a stepped-aside entry's base; an entry of the user's own still names it (the known answer)", async () => {
      const { tier } = await bootRealm({
        providers: {
          opencode: { ...marked(), baseURL: VENDOR_BASE },
          "opencode-go": { ...marked(), baseURL: VENDOR_BASE },
        },
      });
      await waitForPlaneOwner(tier.llm, PLANES, "PiAiAdapter");
      await settle();
      await readUsage(tier);
      const sent = usageRequests();
      expect(sent.length).toBeGreaterThan(0);
      for (const request of sent) {
        expect(request.url).toBe("https://opencode.ai/zen/go/v1/usage");
        expect(request.headers.authorization).toBe("Bearer go-k".length);
      }
      await tier.dispose();
      tierB = undefined;

      // The same entry, unmarked and outside any realm, is the user's: its
      // reference and base are read as before.
      const own = await bootRealm({
        providers: {
          "opencode-go": {
            ...plain("OPENCODE_GO_API_KEY"),
            baseURL: "https://opencode.ai/zen/v1",
          },
        },
        realm: false,
      });
      expect(discoverGoConfig(own.tier.pluginEntry?.fiber?.ctx)).toEqual({
        baseURL: "https://opencode.ai/zen/v1",
        keyEnv: "OPENCODE_GO_API_KEY",
      });
    });
  }
);
