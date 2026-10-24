/**
 * The plugin on the real host, characterized (tier B, pi 1.1.0).
 *
 * The plugin is mounted as it ships — its row carries no config, so the
 * shipped defaults apply (`enrichModels` on, `endpoint: auto`) — beside pi-ai
 * holding the characterization profile (S0 plus a declared catalog-unknown id
 * on each plane) with a key stored for each plane. Every row asserts what was
 * MEASURED, and is tagged so a later phase flips named rows
 * (docs/improvement-plan.md, "Phases"):
 *
 * - `[KNOWN_DEFECT]` is wrong, and a phase fixes it;
 * - `[INTENDED_CHANGE]` is right, and a phase changes it on purpose;
 * - `[BASELINE]` must survive every phase.
 *
 * P-T1b recorded these rows against the hidden-route workaround; P-R1, where
 * the plugin owns the `opencode` and `opencode-go` routes, flipped the
 * fourteen named cases and fourteen `S0_TODAY` facets its PR body lists, so
 * every row here is now `[BASELINE]`.
 *
 * The per-model expectations live in `S0_TODAY` (`support/host.ts`), which the
 * binary e2e reads too, so the in-process host and the published binary cannot
 * drift apart unnoticed. Each model's three facets (model info, the
 * call-config verdict, the wire) carry their own tag there, and this file
 * generates one test per model and facet titled with that tag.
 *
 * Every case boots its own host. The main block boots in the published host's
 * apply order (`plugin-first`: the plugin applies before pi-ai registers,
 * measured on the binary); a second block boots `pi-ai-first`, where the claim
 * restarts pi-ai once, and shows that no facet depends on the order any more.
 *
 * @module test/host-characterization.test
 */
import { readFileSync } from "node:fs";

import { readProfilePatches } from "@deepseek-ai/dsh-app-boot";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  adaptersOf,
  type ApplyOrder,
  APPLY_ORDERS,
  bootTierB,
  CHARACTERIZED_MODELS,
  CHARACTERIZED_PROFILE,
  characterizedProviders,
  drainStream,
  fakeCredentials,
  PLANES,
  piAiRestarts,
  piKnows,
  providerWithApiKey,
  recordingFetch,
  type RecordingFetch,
  type RowFacet,
  S0_TODAY,
  s0Providers,
  SAVE_CANDIDATE,
  type TierB,
  todayRowsFor,
  type TodayRow,
  UNKNOWN_ID,
  waitForPlaneOwner,
} from "./support/host.ts";
import {
  OPENCODE_GO_CATALOG,
  OPENCODE_ZEN_CATALOG,
  protocolForSdk,
  reasoningFor,
} from "./support/src.ts";

/** The ids of a listing, in order. */
const modelIds = (models: readonly { id: string }[]): string[] =>
  models.map((model) => model.id);

type RowKey = keyof typeof S0_TODAY.rows;

let tier: TierB | undefined;
let wire: RecordingFetch;
let restarts: ReturnType<typeof piAiRestarts> | undefined;

/** Boot the characterization profile with a key stored for each plane, the plugin as it ships. */
const bootS0 = async (order: ApplyOrder): Promise<void> => {
  wire = recordingFetch();
  vi.stubGlobal("fetch", wire.fetch);
  tier = await bootTierB({
    credentials: fakeCredentials({
      refs: {
        OPENCODE_API_KEY: "zen-test-key",
        OPENCODE_GO_API_KEY: "go-test-key",
      },
    }),
    order,
    prepare: (root) => {
      restarts = piAiRestarts(root);
    },
    providers: characterizedProviders(),
  });
  // The plugin registers its plane adapter once its mount settles.
  await waitForPlaneOwner(tier.llm);
};

afterEach(async () => {
  restarts?.dispose();
  restarts = undefined;
  await tier?.dispose();
  tier = undefined;
  vi.unstubAllGlobals();
});

/** Poll until `predicate` holds: a committed edit reaches the plane on a microtask. */
const until = async (
  predicate: () => boolean | Promise<boolean>,
  what: string,
  deadlineMs = 5_000
): Promise<void> => {
  const end = Date.now() + deadlineMs;
  while (!(await predicate())) {
    if (Date.now() > end) {
      throw new Error(`never happened: ${what}`);
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
  }
};

/** pi-ai's row as the profile file holds it. */
const savedPiRow = (
  host: TierB
): Record<string, { models?: { id: string }[] }> => {
  const row = readProfilePatches("dsh", host.profile).findLast(
    (patch) => patch.id === "llm-pi-ai" && patch.config !== undefined
  );
  if (row === undefined) {
    throw new Error("no pi-ai row in the profile");
  }
  return (
    row.config as { providers: Record<string, { models?: { id: string }[] }> }
  ).providers;
};

const booted = (): TierB => {
  if (tier === undefined) {
    throw new Error("no host booted");
  }
  return tier;
};

/** One turn's gateway URLs, the catalog read excluded. */
const sentBy = async (route: string, model: string) => {
  const before = wire.requests.length;
  const drained = await drainStream(booted().llm, route, model);
  return {
    drained,
    requests: wire.requests
      .slice(before)
      .filter(
        (request) => !request.url.startsWith("https://models.opencode.ai/")
      ),
  };
};

/** The adapter serving a route, as the registry holds it. */
const adapterOf = (route: string) =>
  adaptersOf(booted().llm).get(route)?.adapter;

/** `resolveCallConfig`'s verdict: "ok", or the code it rejected with. */
const callConfigOf = async (route: string, model: string): Promise<string> => {
  try {
    await booted().llm.resolveCallConfig({ model, provider: route } as never);
    return "ok";
  } catch (error) {
    return String((error as { code?: unknown }).code);
  }
};

const ROW_KEYS = Object.keys(S0_TODAY.rows) as RowKey[];
const split = (key: RowKey): [string, string] => {
  const [route = "", ...rest] = key.split("/");
  return [route, rest.join("/")];
};

/** One facet of one row, measured on the booted host. */
const measureFacet = async (facet: RowFacet, key: RowKey): Promise<unknown> => {
  const [route, model] = split(key);
  if (facet === "info") {
    try {
      const info = await booted().llm.resolveModelInfo(route, model);
      return {
        context: info.context?.contextWindow,
        efforts: info.reasoning?.efforts?.map((effort) => effort.id) ?? [],
      };
    } catch (error) {
      return { error: String((error as { code?: unknown }).code) };
    }
  }
  if (facet === "callConfig") {
    return callConfigOf(route, model);
  }
  const { drained, requests } = await sentBy(route, model);
  // Every body-addressed request carries the model it was for.
  for (const request of requests) {
    if (!request.url.includes(":streamGenerateContent")) {
      expect(request.model).toBe(model);
    }
  }
  return {
    finish: drained.finish?.code,
    sent: requests.map((request) => request.url),
  };
};

/** What `S0_TODAY` (or another order's table) records for one facet of one row. */
const expectedFacet = (
  facet: RowFacet,
  key: RowKey,
  rows: Readonly<Record<RowKey, TodayRow>> = S0_TODAY.rows
): unknown => {
  const row = rows[key];
  if (facet === "info") {
    return row.info;
  }
  if (facet === "callConfig") {
    return row.callConfig;
  }
  return { finish: row.finish, sent: row.sent };
};

/** A config-editor mutation appending `id` to a plane's models. */
const appendTo =
  (plane: string, id: string) =>
  (current: Record<string, unknown>): Record<string, unknown> => {
    const providers = current.providers as Record<
      string,
      { models?: { id: string }[] }
    >;
    return {
      ...current,
      providers: {
        ...providers,
        [plane]: {
          ...providers[plane],
          models: [...(providers[plane]?.models ?? []), { id }],
        },
      },
    };
  };

/** One generated case per row and facet, titled with the facet's own tag. */
const FACET_CASES = ROW_KEYS.flatMap((key) =>
  (["info", "callConfig", "wire"] as const).map((facet) => ({
    facet,
    key,
    tag: S0_TODAY.rows[key].tags[facet],
  }))
);

/** The plane a row key belongs to, and the bundled catalog for it. */
const catalogFor = (key: RowKey) =>
  key.startsWith("opencode-go/") ? OPENCODE_GO_CATALOG : OPENCODE_ZEN_CATALOG;

/** The provider keys one side of a settings descriptor holds. */
const providerKeys = (side: unknown): string[] =>
  Object.keys((side as { providers?: object } | undefined)?.providers ?? {});

/**
 * The `[BASELINE]` session-controller reads after a Sign-in, with only the two
 * plane keys stored (what `bootS0` stores): the Zen plane answers
 * `hasProviderApiKey`, and pi-ai's `settings.describe` value lists both
 * planes. The claim strips the planes from pi-ai's resolved config, which on
 * the host alone turns this false (F20, the plugin-less contract in
 * `test/host-editor-contracts.test.ts`); the D18 graft is what keeps this case
 * green.
 */
const expectSignInReadsTheZenPlane = async (): Promise<void> => {
  const host = booted();
  const from = host.credentials.calls.length;
  expect(await providerWithApiKey(host)).toBe("opencode");
  expect(
    host.credentials.calls
      .slice(from)
      .filter(([method]) => method === "describe")
      .map(([, ref]) => ref)
  ).toContain("OPENCODE_API_KEY");
  const descriptor = host.ctx.settings
    .describe()
    .find((entry) => entry.ns === "llm-pi-ai");
  expect(providerKeys(descriptor?.value).toSorted()).toEqual([
    "deepseek",
    ...PLANES,
  ]);
};

/** Both planes are the plugin's adapter, one instance, and not pi-ai's. */
const expectPlanesOwned = (): void => {
  const zen = adapterOf("opencode");
  expect(zen?.constructor.name).toBe("PlaneAdapter");
  expect(adapterOf("opencode-go")).toBe(zen);
  expect(adapterOf("deepseek")?.constructor.name).toBe("PiAiAdapter");
  expect(adapterOf("deepseek")).not.toBe(zen);
};

describe(
  "characterization · the plugin on pi 1.1.0, the published host's order (tier B)",
  { timeout: 30_000 },
  () => {
    beforeEach(() => bootS0("plugin-first"), 30_000);

    it("fixture: the gap ids are gaps on pi 1.1.0, the unknown id is unknown everywhere, and the known ids are known", () => {
      expect(piKnows("opencode", "gpt-5.3-codex-spark")).toBeUndefined();
      expect(
        piKnows("opencode-go", "gemini-4-argon-contributor")
      ).toBeUndefined();
      expect(piKnows("opencode-go", "minimax-m3.1-flash")).toBeUndefined();
      expect(piKnows("opencode", "deepseek-v4-pro")).toBe("openai-completions");
      expect(piKnows("opencode", "gemini-3-flash")).toBe(
        "google-generative-ai"
      );
      expect(piKnows("opencode-go", "minimax-m3")).toBe("anthropic-messages");
      // The gap ids are ones the plugin's catalog still describes; the
      // declared unknown id is in neither catalog (G1's two classes).
      expect(
        OPENCODE_ZEN_CATALOG.some((model) => model.id === "gpt-5.3-codex-spark")
      ).toBe(true);
      for (const plane of PLANES) {
        expect(piKnows(plane, UNKNOWN_ID)).toBeUndefined();
        expect(CHARACTERIZED_MODELS[plane].at(-1)).toBe(UNKNOWN_ID);
      }
      for (const catalog of [OPENCODE_ZEN_CATALOG, OPENCODE_GO_CATALOG]) {
        expect(catalog.some((model) => model.id === UNKNOWN_ID)).toBe(false);
        expect(catalog.some((model) => model.id === SAVE_CANDIDATE)).toBe(
          false
        );
      }
      expect(ROW_KEYS).toEqual(
        PLANES.flatMap((plane) =>
          CHARACTERIZED_MODELS[plane].map((id) => `${plane}/${id}`)
        )
      );
      // No hidden route: the only opencode routes are the two planes.
      expect(
        booted()
          .llm.listProviders()
          .map((provider) => provider.id)
          .filter((id) => id.startsWith("opencode"))
          .toSorted()
      ).toEqual([...PLANES]);
    });

    it("fixture: each row's context and efforts are what D17 and D1 derive from the profile row and the bundled catalog, so a catalog refresh that moves a fixture model fails here by name", () => {
      // S0_TODAY copies context windows AND effort lists from the generated
      // catalog, which the nightly refresh rewrites, except where the user's
      // row names its own context window (D17: the row wins). The efforts are
      // `reasoningFor` over the catalog spec, on the protocol its SDK names
      // (D1, D16). A refresh that changes one of these ids must update
      // S0_TODAY (and with it the binary e2e) — and must fail HERE, by name,
      // not as a baseline facet that seems to regress.
      //
      // A phase that moves an `info` facet off this derivation on purpose adds
      // its key to INFO_NOT_FROM_CATALOG in the same diff; only a
      // non-BASELINE facet may be exempted, and today none is.
      const INFO_NOT_FROM_CATALOG = new Set<RowKey>();
      for (const key of INFO_NOT_FROM_CATALOG) {
        expect(ROW_KEYS, `${key} is not a characterized row`).toContain(key);
        expect(
          S0_TODAY.rows[key].tags.info,
          `${key}: a BASELINE info facet cannot be exempted from the catalog`
        ).not.toBe("BASELINE");
      }
      let compared = 0;
      for (const key of ROW_KEYS) {
        if (INFO_NOT_FROM_CATALOG.has(key)) {
          continue;
        }
        const [plane, id] = split(key);
        const spec = catalogFor(key).find((model) => model.id === id);
        if (spec === undefined) {
          expect(id, key).toBe(UNKNOWN_ID);
          continue;
        }
        const stale =
          `S0_TODAY's info for ${key} no longer matches the profile row and ` +
          "the bundled catalog: either a catalog refresh moved it (update the " +
          "row in test/support/host.ts), or a phase flipped this facet off " +
          "them (add the key to INFO_NOT_FROM_CATALOG here)";
        const row = (
          CHARACTERIZED_PROFILE[plane as (typeof PLANES)[number]]
            .models as readonly {
            id: string;
            contextWindow?: number;
          }[]
        ).find((model) => model.id === id);
        const info = S0_TODAY.rows[key].info as {
          context?: number;
          efforts?: readonly string[];
        };
        expect(row?.contextWindow ?? spec.context_window, stale).toEqual(
          info.context
        );
        const protocol = protocolForSdk(spec.provider_npm);
        expect(protocol, key).toBeDefined();
        const reasoning = reasoningFor(spec, protocol ?? "openai-completions");
        expect(
          reasoning?.efforts.map((effort) => effort.id) ?? [],
          stale
        ).toEqual(info.efforts);
        compared += 1;
      }
      // The case must have compared something: an `info` shape change that
      // drops `efforts` would otherwise pass vacuously.
      expect(compared).toBeGreaterThan(0);
    });

    it("fixture: the handback's save-block pattern (test/host-planes.test.ts) names the stored gap id, and todayRowsFor answers both orders the same and refuses one it does not know", () => {
      const pinned =
        'provider "opencode" model "gpt-5.3-codex-spark" needs an api';
      expect(pinned).toMatch(S0_TODAY.saveBlockedByStoredGap);
      // The dot is a dot, not a wildcard.
      expect(
        'provider "opencode" model "gpt-5x3-codex-spark" needs an api'
      ).not.toMatch(S0_TODAY.saveBlockedByStoredGap);
      for (const order of APPLY_ORDERS) {
        expect(Object.keys(todayRowsFor(order))).toEqual(ROW_KEYS);
        expect(todayRowsFor(order)).toEqual(S0_TODAY.rows);
      }
      // A probe JSON missing the field reads `undefined`; it must not select
      // any table.
      expect(() => todayRowsFor(undefined as unknown as ApplyOrder)).toThrow(
        /unknown apply order/u
      );
    });

    it("[BASELINE] hasProviderApiKey answers the Zen plane with only the plane keys stored, and llm-pi-ai's settings.describe value lists both planes (F20, D18)", async () => {
      await expectSignInReadsTheZenPlane();
    });

    it("[BASELINE] registry: both planes are the plugin's adapter, pi-ai keeps its other route, no hidden route exists, and Settings still addresses the planes under pi-ai's namespace (D13)", () => {
      const { llm } = booted();
      const registry = adaptersOf(llm);
      expect([...registry.keys()].toSorted()).toEqual([
        "deepseek",
        "opencode",
        "opencode-go",
      ]);
      expect(
        llm
          .listProviders()
          .map((provider) => provider.id)
          .toSorted()
      ).toEqual(["deepseek", "opencode", "opencode-go"]);
      expectPlanesOwned();
      const directory = llm.listConfigurableProviders();
      for (const plane of PLANES) {
        const entry = directory.find((row) => row.provider === plane);
        expect(entry).toMatchObject({
          settingsNs: "llm-pi-ai",
          settingsPath: ["providers", plane],
        });
        // pi-ai no longer resolves the planes, so it reports no gap id.
        expect(entry?.error).toBeUndefined();
      }
    });

    it("[BASELINE] listing before any turn: every declared id is listed on both planes (D21)", async () => {
      const { llm } = booted();
      for (const plane of PLANES) {
        expect(modelIds(await llm.listModels(plane))).toEqual(
          S0_TODAY.listingBeforeTurn[plane]
        );
      }
    });

    it("[BASELINE] listing after a turn on each plane: every declared id is listed, gap ids and the unknown id included (G1)", async () => {
      const { llm } = booted();
      await sentBy("opencode", "deepseek-v4-pro");
      await sentBy("opencode-go", "deepseek-v4-pro");
      for (const plane of PLANES) {
        const listed = modelIds(await llm.listModels(plane));
        expect(listed).toEqual(S0_TODAY.listingAfterTurn[plane]);
        expect(listed).toContain(UNKNOWN_ID);
      }
    });

    it.each(FACET_CASES)("[$tag] $key · $facet", async ({ facet, key }) => {
      expect(await measureFacet(facet, key)).toEqual(expectedFacet(facet, key));
    });

    it("[BASELINE] the toggle-only model is offered Off / On, and a level it does not take is refused (D1)", async () => {
      // Chosen from the bundled catalog, not by name: on/off reasoning, no levels.
      const spec = OPENCODE_GO_CATALOG.find(
        (model) => model.id === "minimax-m3"
      );
      expect(spec?.reasoning_options).toEqual([{ type: "toggle" }]);
      const info = await booted().llm.resolveModelInfo(
        "opencode-go",
        "minimax-m3"
      );
      expect(info.reasoning?.efforts?.map((effort) => effort.id)).toEqual([
        "off",
        "high",
      ]);
      expect(info.reasoning?.efforts?.map((effort) => effort.name)).toEqual([
        "Off",
        "On",
      ]);
      await expect(
        booted().llm.resolveCallConfig({
          model: "minimax-m3",
          provider: "opencode-go",
          reasoningEffort: "minimal",
        } as never)
      ).rejects.toMatchObject({ code: "UNSUPPORTED_REASONING_EFFORT" });
    });

    it("[BASELINE] completions models dispatch to the modern (per-protocol inference) family on both planes", async () => {
      for (const [route, wireUrl] of [
        [
          "opencode",
          "https://opencode.ai/inference/openai/v1/chat/completions",
        ],
        [
          "opencode-go",
          "https://opencode.ai/inference/go/openai/v1/chat/completions",
        ],
      ] as const) {
        const { drained, requests } = await sentBy(route, "deepseek-v4-pro");
        expect(requests.map((request) => request.url)).toEqual([wireUrl]);
        expect(drained.finish).toEqual({ code: "AUTH", kind: "error" });
      }
    });

    it("[BASELINE] the plugin patches nothing on its adapter: it is its own PlaneAdapter, whose methods are its class's", () => {
      const adapter = adapterOf("opencode");
      expect(adapter?.constructor.name).toBe("PlaneAdapter");
      expect(Object.hasOwn(adapter ?? {}, "prepareCall")).toBe(false);
      expect(Object.hasOwn(adapter ?? {}, "resolveModel")).toBe(false);
    });

    it("[BASELINE] Zen gpt-5.3-codex-spark: the user's row reaches model info, resolveCallConfig accepts it, and it is sent on Responses (D17)", async () => {
      const { llm } = booted();
      const info = await llm.resolveModelInfo(
        "opencode",
        "gpt-5.3-codex-spark"
      );
      expect(info.name).toBe("My Spark");
      expect(info.context?.contextWindow).toBe(400_000);
      await expect(
        llm.resolveCallConfig({
          model: "gpt-5.3-codex-spark",
          provider: "opencode",
        } as never)
      ).resolves.toBeDefined();
      const { requests } = await sentBy("opencode", "gpt-5.3-codex-spark");
      expect(requests.map((request) => request.url)).toEqual([
        "https://opencode.ai/inference/openai/v1/responses",
      ]);
    });

    it("[BASELINE] Go minimax-m3.1-flash validates and is sent once as completions on Go's modern base (G1)", async () => {
      const { llm } = booted();
      await expect(
        llm.resolveCallConfig({
          model: "minimax-m3.1-flash",
          provider: "opencode-go",
        } as never)
      ).resolves.toBeDefined();
      const { drained, requests } = await sentBy(
        "opencode-go",
        "minimax-m3.1-flash"
      );
      expect(requests.map((request) => request.url)).toEqual([
        "https://opencode.ai/inference/go/openai/v1/chat/completions",
      ]);
      expect(drained.finish).toEqual({ code: "AUTH", kind: "error" });
    });

    it("[BASELINE] Go gemini-4-argon-contributor validates and is sent on Go's Google base with the Go key (F10)", async () => {
      expect(
        await callConfigOf("opencode-go", "gemini-4-argon-contributor")
      ).toBe("ok");
      const { drained, requests } = await sentBy(
        "opencode-go",
        "gemini-4-argon-contributor"
      );
      expect(requests.map((request) => request.url)).toEqual(
        S0_TODAY.rows["opencode-go/gemini-4-argon-contributor"].sent
      );
      expect(requests[0]?.headers["x-goog-api-key"]).toBe("go-test-key".length);
      // pi maps a Google 401 to its own code, not AUTH (as with pi alone).
      expect(drained.finish).toEqual({ code: "PI_AI_ERROR", kind: "error" });
    });

    it("[BASELINE] a stored gap id blocks no save: a catalog-unknown id is appended and a displayName changed, the file holds both, and the new id is listed, validates and is sent as completions (D15)", async () => {
      const host = booted();
      const { ctx, llm, piEntry } = host;
      await ctx.configEditor.edit(
        piEntry,
        appendTo("opencode", SAVE_CANDIDATE)
      );
      expect(
        savedPiRow(host).opencode?.models?.map((model) => model.id)
      ).toEqual([...CHARACTERIZED_MODELS.opencode, SAVE_CANDIDATE]);
      await ctx.configEditor.edit(piEntry, (current) => {
        const providers = current.providers as Record<string, object>;
        return {
          ...current,
          providers: {
            ...providers,
            opencode: { ...providers.opencode, displayName: "Zen (edited)" },
          },
        };
      });
      await until(
        () =>
          llm.listProviders().find((provider) => provider.id === "opencode")
            ?.name === "Zen (edited)",
        "the displayName edit reaches the registry"
      );
      expect(modelIds(await llm.listModels("opencode"))).toContain(
        SAVE_CANDIDATE
      );
      expect(await callConfigOf("opencode", SAVE_CANDIDATE)).toBe("ok");
      const { requests } = await sentBy("opencode", SAVE_CANDIDATE);
      expect(requests.map((request) => request.url)).toEqual([
        "https://opencode.ai/inference/openai/v1/chat/completions",
      ]);
    });

    it("[BASELINE] the probe's save sequence: the first append of the catalog-unknown id is accepted, with no gap id dropped first", async () => {
      // The binary e2e's probe runs exactly this.
      const host = booted();
      await host.ctx.configEditor.edit(
        host.piEntry,
        appendTo("opencode", SAVE_CANDIDATE)
      );
      const saved = readFileSync(host.profile.patchPath, "utf8");
      expect(saved).toContain(SAVE_CANDIDATE);
      expect(saved).toContain("gpt-5.3-codex-spark");
      expect(saved).toContain(UNKNOWN_ID);
    });
  }
);

describe(
  "characterization · pi-ai applying first (tier B)",
  { timeout: 30_000 },
  () => {
    beforeEach(() => bootS0("pi-ai-first"), 30_000);

    it("[BASELINE] hasProviderApiKey answers the Zen plane with only the plane keys stored, and llm-pi-ai's settings.describe value lists both planes (F20, D18)", async () => {
      await expectSignInReadsTheZenPlane();
    });

    it("[BASELINE] pi-ai held the planes first, so the claim restarted it exactly once; both planes are the plugin's, and completions reach each plane's own modern base", async () => {
      expect(restarts?.count()).toBe(1);
      expectPlanesOwned();
      for (const [route, wireUrl] of [
        [
          "opencode",
          "https://opencode.ai/inference/openai/v1/chat/completions",
        ],
        [
          "opencode-go",
          "https://opencode.ai/inference/go/openai/v1/chat/completions",
        ],
      ] as const) {
        const { drained, requests } = await sentBy(route, "deepseek-v4-pro");
        expect(requests.map((request) => request.url)).toEqual([wireUrl]);
        expect(drained.finish).toEqual({ code: "AUTH", kind: "error" });
      }
    });

    it("[BASELINE] no facet depends on the apply order any more: every row measured in this order equals S0_TODAY", async () => {
      const expected = todayRowsFor("pi-ai-first");
      expect(expected).toEqual(S0_TODAY.rows);
      for (const facet of ["info", "callConfig", "wire"] as const) {
        const measured: Record<string, unknown> = {};
        const want: Record<string, unknown> = {};
        for (const key of ROW_KEYS) {
          measured[key] = await measureFacet(facet, key);
          want[key] = expectedFacet(facet, key, expected);
        }
        expect(measured, facet).toEqual(want);
      }
    });
  }
);

describe(
  "characterization · a gap-free plane (tier B)",
  { timeout: 30_000 },
  () => {
    it("[BASELINE] the catalog-unknown id is accepted by the save check, and the file holds it (D15)", async () => {
      // Plain S0 (no declared unknown id) minus Zen's stored gap id.
      const providers = s0Providers();
      const zen = providers.opencode as { models: { id: string }[] };
      zen.models = zen.models.filter(
        (model) => model.id !== "gpt-5.3-codex-spark"
      );
      // The plugin's row mounts too, so its fetch patch wraps the recording
      // fetch, as in every other case here, and not the suite's offline guard.
      wire = recordingFetch();
      vi.stubGlobal("fetch", wire.fetch);
      tier = await bootTierB({ providers });
      await waitForPlaneOwner(tier.llm);
      const { ctx, piEntry, profile } = tier;
      await ctx.configEditor.edit(
        piEntry,
        appendTo("opencode", SAVE_CANDIDATE)
      );
      expect(readFileSync(profile.patchPath, "utf8")).toContain(SAVE_CANDIDATE);
    });
  }
);
