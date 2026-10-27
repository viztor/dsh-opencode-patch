/**
 * TODAY's plugin on the real host, characterized (tier B, pi 1.1.0).
 *
 * The plugin is mounted as it ships — its row carries no config, so the
 * shipped defaults apply: the hidden ids in `providers`, `enrichModels` on,
 * `endpoint: auto` — beside pi-ai holding the characterization profile (S0
 * plus a declared catalog-unknown id on each plane) with a key stored for each
 * plane. Every row asserts what was MEASURED, and is tagged so a later phase
 * flips named rows (docs/improvement-plan.md, "Phases"):
 *
 * - `[KNOWN_DEFECT]` is wrong today, and a phase fixes it;
 * - `[INTENDED_CHANGE]` is right today, and a phase changes it on purpose;
 * - `[BASELINE]` must survive every phase.
 *
 * The per-model expectations live in `S0_TODAY` (`support/host.ts`), which
 * the binary e2e reads too, so the in-process host and the published binary
 * cannot drift apart unnoticed. Each model's three facets (model info, the
 * call-config verdict, the wire) carry their own tag there, and this file
 * generates one test per model and facet titled with that tag, in each apply
 * order (`todayRowsFor(order)` carries that order's tags), so the tag is what
 * a reader and a phase's diff go by. Where a measurement contradicted the
 * plan's expectation the row keeps the measurement and says so.
 *
 * Every case boots its own host, so a key the fetch patch captured in one case
 * cannot change another's listing. The main block boots in the published
 * host's apply order (`plugin-first`: the plugin applies before pi-ai
 * registers, measured on the binary); a second block boots `pi-ai-first` and
 * records the rows that change with the order — the adapter decoration only
 * wraps what was registered when the plugin applied.
 *
 * @module test/host-characterization.test
 */
import { readFileSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  adaptersOf,
  type ApplyOrder,
  APPLY_ORDERS,
  bootTierB,
  CHARACTERIZED_MODELS,
  characterizedProviders,
  drainStream,
  fakeCredentials,
  PLANES,
  piKnows,
  providerWithApiKey,
  recordingFetch,
  type RecordingFetch,
  type RowFacet,
  S0_TODAY,
  s0Providers,
  SAVE_BLOCKED_BY_ANY_UNDESCRIBED,
  SAVE_CANDIDATE,
  type TierB,
  todayRowsFor,
  type TodayRow,
  UNKNOWN_ID,
  waitForRoutes,
  ZEN_UNDESCRIBED,
} from "./support/host.ts";
import {
  INTERNAL_ROUTES,
  OPENCODE_GO_CATALOG,
  OPENCODE_ZEN_CATALOG,
  PI_THINKING_LEVELS,
  thinkingLevelMapFor,
} from "./support/src.ts";

type RowKey = keyof typeof S0_TODAY.rows;

let tier: TierB | undefined;
let wire: RecordingFetch;

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
    providers: characterizedProviders(),
  });
  // The plugin mounts its hidden routes asynchronously (mountInternalRoutes).
  await waitForRoutes(tier.llm, INTERNAL_ROUTES);
};

afterEach(async () => {
  await tier?.dispose();
  tier = undefined;
  vi.unstubAllGlobals();
});

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

/** pi-ai's plane adapter, private methods included. */
const planeAdapter = () =>
  adaptersOf(booted().llm).get("opencode")?.adapter as unknown as {
    prepareCall: (
      route: string,
      model: string
    ) => Promise<{ baseUrl?: string; api?: string }>;
  };

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

/** A config-editor mutation dropping `ids` from a plane's models. */
const dropFrom =
  (plane: string, ids: readonly string[]) =>
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
          models: (providers[plane]?.models ?? []).filter(
            (model) => !ids.includes(model.id)
          ),
        },
      },
    };
  };

const FACETS = ["info", "callConfig", "wire"] as const;

/**
 * One generated case per row and facet, titled with the facet's own tag in
 * that order's table, so a phase's diff names every facet it moves in both
 * orders.
 */
const facetCasesFor = (order: ApplyOrder) =>
  ROW_KEYS.flatMap((key) =>
    FACETS.map((facet) => ({
      facet,
      key,
      tag: todayRowsFor(order)[key].tags[facet],
    }))
  );

/** The plane a row key belongs to, and the bundled catalog for it. */
const catalogFor = (key: RowKey) =>
  key.startsWith("opencode-go/") ? OPENCODE_GO_CATALOG : OPENCODE_ZEN_CATALOG;

/** The provider keys one side of a settings descriptor holds. */
const providerKeys = (side: unknown): string[] =>
  Object.keys((side as { providers?: object } | undefined)?.providers ?? {});

/**
 * The `[BASELINE]` session-controller reads after a Sign-in, on today's plugin
 * with only the two plane keys stored (what `bootS0` stores): the Zen plane
 * answers `hasProviderApiKey`, and pi-ai's `settings.describe` value lists
 * both planes. P-R1 strips the planes from pi-ai's resolved config, which on
 * the host alone turns this false (F20, the plugin-less contract in
 * `test/host-editor-contracts.test.ts`); its D18 wrapper is what must keep
 * this case green.
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

describe(
  "characterization · today's plugin on pi 1.1.0, the published host's order (tier B)",
  { timeout: 30_000 },
  () => {
    beforeEach(() => bootS0("plugin-first"), 30_000);

    it("fixture: the gap ids are gaps on pi 1.1.0, the unknown id is unknown everywhere, and the known ids are known", () => {
      expect(piKnows("opencode", "gpt-5.3-codex-spark")).toBeUndefined();
      expect(piKnows("opencode-go", "gemini-4-argon")).toBeUndefined();
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
      expect(INTERNAL_ROUTES).toHaveLength(6);
    });

    it("fixture: each row's context and efforts are the bundled catalog's, so a catalog refresh that moves a fixture model fails here by name", () => {
      // S0_TODAY copies context windows AND effort lists from the generated
      // catalog, which the nightly refresh rewrites: decorateModelInfo makes
      // the catalog authoritative for both (src/models-discovery.ts, the
      // `thinkingLevelMapFor` → effortsFromLevelMap derivation, re-stated
      // here from its two exported halves). A refresh that changes one of
      // these ids must update S0_TODAY (and with it the binary e2e) — and must
      // fail HERE, by name, not as a baseline facet that seems to regress.
      //
      // Two rows' `info` facets are KNOWN_DEFECT today and still copy the
      // catalog (Zen gpt-5.3-codex-spark's context, Go minimax-m3's efforts);
      // the plan moves them OFF the catalog on purpose (D17: the user's row
      // wins; D1: a toggle model offers Off/On). The phase that flips such a
      // facet adds its key to INFO_NOT_FROM_CATALOG in the same diff — and only
      // a non-BASELINE `info` facet may be exempted, since a BASELINE one is
      // meant to stay the catalog's across phases.
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
        const [, id] = split(key);
        const spec = catalogFor(key).find((model) => model.id === id);
        if (spec === undefined) {
          expect(id, key).toBe(UNKNOWN_ID);
          continue;
        }
        const stale =
          `S0_TODAY's info for ${key} no longer matches the bundled catalog: ` +
          "either a catalog refresh moved it (update the row in " +
          "test/support/host.ts), or a phase flipped this facet off the " +
          "catalog (add the key to INFO_NOT_FROM_CATALOG here)";
        const info = S0_TODAY.rows[key].info as {
          context?: number;
          efforts?: readonly string[];
        };
        expect(spec.context_window, stale).toEqual(info.context);
        if (info.efforts === undefined) {
          continue;
        }
        const map = thinkingLevelMapFor(spec);
        expect(
          map === undefined
            ? []
            : PI_THINKING_LEVELS.filter((level) => map[level] !== null),
          stale
        ).toEqual(info.efforts);
        compared += 1;
      }
      // The case must have compared something: an `info` shape change that
      // drops `efforts` would otherwise pass vacuously.
      expect(compared).toBeGreaterThan(0);
    });

    it("fixture: the binary e2e's cell-aware helpers — the floating save-block pattern names any undescribed id and only those, todayRowsFor refuses an order it does not know, and a facet its pi-ai-first table moves is retagged with it, from KNOWN_DEFECT to BASELINE", () => {
      // The pinned message is one the floating pattern accepts, so the two
      // cells cannot disagree on a pinned run.
      const pinned =
        'provider "opencode" model "gpt-5.3-codex-spark" needs an api';
      expect(pinned).toMatch(S0_TODAY.saveBlockedByStoredGap);
      expect(pinned).toMatch(SAVE_BLOCKED_BY_ANY_UNDESCRIBED);
      // A floating pi that learned gpt-5.3-codex-spark names the next one.
      expect(`provider "opencode" model "${UNKNOWN_ID}" needs an api`).toMatch(
        SAVE_BLOCKED_BY_ANY_UNDESCRIBED
      );
      // A described id, or the dot read as a wildcard, is not a match.
      for (const other of ["deepseek-v4-pro", "gpt-5x3-codex-spark"]) {
        expect(`provider "opencode" model "${other}" needs an api`).not.toMatch(
          SAVE_BLOCKED_BY_ANY_UNDESCRIBED
        );
      }
      for (const order of APPLY_ORDERS) {
        expect(Object.keys(todayRowsFor(order))).toEqual(ROW_KEYS);
      }
      // Structural, so no phase has to edit it: a facet whose VALUE differs
      // between the orders is exactly a facet whose TAG differs, and each one
      // is a defect in the published order whose pi-ai-first value is already
      // what P-R1 keeps. Which facets those are today is pinned by the
      // [KNOWN_DEFECT] apply-order case below; once P-R1 collapses the
      // override, both sets are empty and this still holds.
      const piAiFirst = todayRowsFor("pi-ai-first");
      const moved = ROW_KEYS.flatMap((key) =>
        FACETS.filter(
          (facet) =>
            JSON.stringify(expectedFacet(facet, key, piAiFirst)) !==
            JSON.stringify(expectedFacet(facet, key))
        ).map((facet) => `${key} · ${facet}`)
      );
      const retagged = ROW_KEYS.flatMap((key) =>
        FACETS.filter(
          (facet) =>
            piAiFirst[key].tags[facet] !== S0_TODAY.rows[key].tags[facet]
        ).map((facet) => `${key} · ${facet}`)
      );
      expect(retagged).toEqual(moved);
      for (const key of ROW_KEYS) {
        for (const facet of FACETS) {
          if (moved.includes(`${key} · ${facet}`)) {
            expect(S0_TODAY.rows[key].tags[facet], `${key} · ${facet}`).toBe(
              "KNOWN_DEFECT"
            );
            expect(piAiFirst[key].tags[facet], `${key} · ${facet}`).toBe(
              "BASELINE"
            );
          }
        }
      }
      // A probe JSON missing the field reads `undefined`; it must not select
      // the pi-ai-first table.
      expect(() => todayRowsFor(undefined as unknown as ApplyOrder)).toThrow(
        /unknown apply order/u
      );
    });

    it("[BASELINE] hasProviderApiKey answers the Zen plane with only the plane keys stored, and llm-pi-ai's settings.describe value lists both planes (F20, D18)", async () => {
      await expectSignInReadsTheZenPlane();
    });

    it("[INTENDED_CHANGE] registry: both planes are pi-ai's, and six hidden routes are registered and hidden from listProviders (P-R1 claims the planes)", () => {
      const { llm } = booted();
      const registry = adaptersOf(llm);
      expect([...registry.keys()].toSorted()).toEqual(
        ["deepseek", "opencode", "opencode-go", ...INTERNAL_ROUTES].toSorted()
      );
      expect(
        llm
          .listProviders()
          .map((provider) => provider.id)
          .toSorted()
      ).toEqual(["deepseek", "opencode", "opencode-go"]);
      for (const route of [...PLANES, ...INTERNAL_ROUTES]) {
        expect(registry.get(route)?.adapter.constructor.name).toBe(
          "PiAiAdapter"
        );
      }
      // pi-ai's own adapter serves the planes; the hidden routes are not it.
      const piAdapter = registry.get("opencode")?.adapter;
      expect(registry.get("opencode-go")?.adapter).toBe(piAdapter);
      for (const route of INTERNAL_ROUTES) {
        expect(registry.get(route)?.adapter).not.toBe(piAdapter);
      }
      const directory = llm.listConfigurableProviders();
      for (const plane of PLANES) {
        expect(
          directory.find((entry) => entry.provider === plane)
        ).toMatchObject({
          settingsNs: "llm-pi-ai",
          settingsPath: ["providers", plane],
        });
      }
      // The directory reports each plane's first stored gap id.
      expect(
        directory.find((entry) => entry.provider === "opencode")?.error
      ).toMatch(/model "gpt-5\.3-codex-spark" needs an api/u);
      expect(
        directory.find((entry) => entry.provider === "opencode-go")?.error
      ).toMatch(/model "gemini-4-argon" needs an api/u);
    });

    it("[INTENDED_CHANGE] keyless listing: before a key is captured, the listing patch hides every paid model on both planes (D21)", async () => {
      const { llm } = booted();
      for (const plane of PLANES) {
        expect(await llm.listModels(plane)).toEqual(
          S0_TODAY.keylessListing[plane]
        );
      }
    });

    it("[KNOWN_DEFECT] keyed listing: once a turn captured a key, only pi-resolved ids are listed — every gap id and the declared unknown id are missing (G1)", async () => {
      const { llm } = booted();
      await sentBy("opencode", "deepseek-v4-pro");
      await sentBy("opencode-go", "deepseek-v4-pro");
      const listed: Record<string, string[]> = {};
      for (const plane of PLANES) {
        const models = await llm.listModels(plane);
        listed[plane] = models.map((model) => model.id);
      }
      expect(listed).toEqual(S0_TODAY.keyedListing);
      expect(listed.opencode).not.toContain("gpt-5.3-codex-spark");
      expect(listed["opencode-go"]).not.toContain("gemini-4-argon");
      expect(listed["opencode-go"]).not.toContain("minimax-m3.1-flash");
      for (const plane of PLANES) {
        expect(listed[plane]).not.toContain(UNKNOWN_ID);
      }
    });

    it.each(facetCasesFor("plugin-first"))(
      "[$tag] $key · $facet",
      async ({ facet, key }) => {
        expect(await measureFacet(facet, key)).toEqual(
          expectedFacet(facet, key)
        );
      }
    );

    it("[KNOWN_DEFECT] the toggle-only model is offered Minimal/Xhigh/Max (D1)", async () => {
      // Chosen from the bundled catalog, not by name: on/off reasoning, no levels.
      const spec = OPENCODE_GO_CATALOG.find(
        (model) => model.id === "minimax-m3"
      );
      expect(spec?.reasoning_options).toEqual([{ type: "toggle" }]);
      const info = await booted().llm.resolveModelInfo(
        "opencode-go",
        "minimax-m3"
      );
      const efforts = info.reasoning?.efforts?.map((effort) => effort.id) ?? [];
      expect(efforts).toEqual(
        S0_TODAY.rows["opencode-go/minimax-m3"].info.efforts
      );
      expect(efforts).toEqual(
        expect.arrayContaining(["minimal", "xhigh", "max"])
      );
      expect(efforts).not.toContain("off");
    });

    it("[INTENDED_CHANGE] completions models dispatch to pi 1.1.0's legacy bases", async () => {
      for (const [route, wireUrl] of [
        ["opencode", "https://opencode.ai/zen/v1/chat/completions"],
        ["opencode-go", "https://opencode.ai/zen/go/v1/chat/completions"],
      ] as const) {
        const { drained, requests } = await sentBy(route, "deepseek-v4-pro");
        expect(requests.map((request) => request.url)).toEqual([wireUrl]);
        expect(drained.finish).toEqual({ code: "AUTH", kind: "error" });
      }
    });

    it("[KNOWN_DEFECT] in this order the adapter decoration never runs: pi-ai's plane adapter is not wrapped, so its prepared call carries no repaired base (decoratePlaneAdapters in src/models-discovery.ts)", async () => {
      // decoratePlaneAdapters wraps the adapters the registry holds when the
      // plugin's effect runs, and here pi-ai has not registered yet.
      const adapter = planeAdapter();
      expect(Object.hasOwn(adapter, "prepareCall")).toBe(false);
      expect(Object.hasOwn(adapter, "resolveModel")).toBe(false);
      const prepared = await adapter.prepareCall("opencode", "deepseek-v4-pro");
      expect(prepared.baseUrl).toBeUndefined();
    });

    it("[KNOWN_DEFECT] Zen gpt-5.3-codex-spark: the user's row is ignored and resolveCallConfig refuses what dispatch serves through the hidden Responses route", async () => {
      const { llm } = booted();
      const info = await llm.resolveModelInfo(
        "opencode",
        "gpt-5.3-codex-spark"
      );
      // The row declares name "My Spark" and contextWindow 400000.
      expect(info.context?.contextWindow).toBe(128_000);
      expect(info.name).not.toBe("My Spark");
      await expect(
        llm.resolveCallConfig({
          model: "gpt-5.3-codex-spark",
          provider: "opencode",
        } as never)
      ).rejects.toMatchObject({ code: "INVALID_CONFIG" });
      const { requests } = await sentBy("opencode", "gpt-5.3-codex-spark");
      expect(requests.map((request) => request.url)).toEqual([
        "https://opencode.ai/inference/openai/v1/responses",
      ]);
    });

    it("[KNOWN_DEFECT] Go minimax-m3.1-flash answers INVALID_CONFIG 'needs an api' and sends nothing (F4)", async () => {
      const { llm } = booted();
      await expect(
        llm.resolveCallConfig({
          model: "minimax-m3.1-flash",
          provider: "opencode-go",
        } as never)
      ).rejects.toMatchObject({
        code: "INVALID_CONFIG",
        message: expect.stringMatching(/"minimax-m3\.1-flash" needs an api/u),
      });
      const { drained, requests } = await sentBy(
        "opencode-go",
        "minimax-m3.1-flash"
      );
      expect(requests).toEqual([]);
      expect(drained.finish).toEqual({ code: "INVALID_CONFIG", kind: "error" });
    });

    it("[KNOWN_DEFECT] Go gemini-4-argon: resolveCallConfig refuses it (INVALID_CONFIG) while the turn is served on the Go Google base through the bridge", async () => {
      expect(await callConfigOf("opencode-go", "gemini-4-argon")).toBe(
        "INVALID_CONFIG"
      );
      const { drained, requests } = await sentBy(
        "opencode-go",
        "gemini-4-argon"
      );
      expect(requests.map((request) => request.url)).toEqual(
        S0_TODAY.rows["opencode-go/gemini-4-argon"].sent
      );
      expect(requests[0]?.headers["x-goog-api-key"]).toBe("go-test-key".length);
      // pi maps a Google 401 to its own code, not AUTH (as with pi alone).
      expect(drained.finish).toEqual({ code: "PI_AI_ERROR", kind: "error" });
    });

    it("[KNOWN_DEFECT] a stored gap id blocks every save of its plane: appending a new id and a displayName change are both refused naming the STORED id, and the file is unchanged (F4; llm-pi-ai config.ts:364-368, catalog.ts:917-921)", async () => {
      const { ctx, piEntry, profile } = booted();
      const before = readFileSync(profile.patchPath);
      await expect(
        ctx.configEditor.edit(piEntry, appendTo("opencode", SAVE_CANDIDATE))
      ).rejects.toThrow(S0_TODAY.saveBlockedByStoredGap);
      await expect(
        ctx.configEditor.edit(piEntry, (current) => {
          const providers = current.providers as Record<string, object>;
          return {
            ...current,
            providers: {
              ...providers,
              opencode: { ...providers.opencode, displayName: "Zen (edited)" },
            },
          };
        })
      ).rejects.toThrow(S0_TODAY.saveBlockedByStoredGap);
      expect(readFileSync(profile.patchPath)).toEqual(before);
    });

    it("[KNOWN_DEFECT] the probe's save sequence: dropping the plane's undescribed ids is accepted, then the catalog-unknown id itself is what the check names", async () => {
      // The binary e2e's probe runs exactly this, so its rows isolate the
      // unknown id although every plane of the profile stores a gap id.
      const { ctx, piEntry, profile } = booted();
      await ctx.configEditor.edit(
        piEntry,
        dropFrom("opencode", ZEN_UNDESCRIBED)
      );
      const cleared = readFileSync(profile.patchPath, "utf8");
      expect(cleared).not.toContain("gpt-5.3-codex-spark");
      expect(cleared).toContain("gemini-4-argon");
      await expect(
        ctx.configEditor.edit(piEntry, appendTo("opencode", SAVE_CANDIDATE))
      ).rejects.toThrow(S0_TODAY.saveRejectedUnknown);
      expect(readFileSync(profile.patchPath, "utf8")).toBe(cleared);
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

    it("[INTENDED_CHANGE] the adapter decoration runs, and the base it repairs never reaches the wire", async () => {
      const adapter = planeAdapter();
      expect(Object.hasOwn(adapter, "prepareCall")).toBe(true);
      for (const [route, wireUrl] of [
        ["opencode", "https://opencode.ai/zen/v1/chat/completions"],
        ["opencode-go", "https://opencode.ai/zen/go/v1/chat/completions"],
      ] as const) {
        // Measured: the Go plane's repaired base is ZEN's. pi-ai serves both
        // planes from ONE adapter instance, which decoratePlaneAdapters wraps
        // once per route, so the Go wrapper runs over the Zen one and keeps the
        // base it already filled.
        const decorated = "https://opencode.ai/inference/openai/v1";
        const prepared = await adapter.prepareCall(route, "deepseek-v4-pro");
        expect(prepared).toMatchObject({
          api: "openai-completions",
          baseUrl: decorated,
        });
        const { drained, requests } = await sentBy(route, "deepseek-v4-pro");
        expect(requests.map((request) => request.url)).toEqual([wireUrl]);
        // Measured, not compared as literals: the URL the turn sent does not
        // start with the base the decorated adapter prepared.
        expect(requests[0]?.url.startsWith(String(prepared.baseUrl))).toBe(
          false
        );
        expect(drained.finish).toEqual({ code: "AUTH", kind: "error" });
      }
    });

    // The plan expected INVALID_CONFIG for Go Gemini; that holds in the
    // published host's order (the plugin-first block, where the case is
    // [KNOWN_DEFECT]) and not in this one, where the wrapped plane adapter
    // delegates to opencode-go-google (decoratePlaneAdapters in
    // src/models-discovery.ts), so here it is [BASELINE]. todayRowsFor is the
    // table the binary e2e picks when its probe infers this order; these cases
    // measure every facet of it, and the apply-order case below pins that
    // only that one facet moves.
    it.each(facetCasesFor("pi-ai-first"))(
      "[$tag] $key · $facet",
      async ({ facet, key }) => {
        expect(await measureFacet(facet, key)).toEqual(
          expectedFacet(facet, key, todayRowsFor("pi-ai-first"))
        );
      }
    );
  }
);

describe("characterization · the apply order (no host)", () => {
  // Pure: it reads the two tables the binary e2e picks between, and boots
  // nothing. Each order's generated facet cases measure its table; this case
  // pins WHERE they differ today. The dependence on the order is the defect:
  // when P-R1 flips this row it drops todayRowsFor's pi-ai-first override in
  // the same diff, and this case becomes "[BASELINE] no facet depends on the
  // apply order" (CONTRIBUTING.md, "Tags").
  it("[KNOWN_DEFECT] the apply order decides exactly one facet today: Go gemini-4-argon's callConfig is INVALID_CONFIG in the published order and \"ok\" with pi-ai first (P-R1 drops todayRowsFor's pi-ai-first override with this row's flip)", () => {
    const piAiFirst = todayRowsFor("pi-ai-first");
    const moved = ROW_KEYS.flatMap((key) =>
      FACETS.filter(
        (facet) =>
          JSON.stringify(expectedFacet(facet, key, piAiFirst)) !==
          JSON.stringify(expectedFacet(facet, key))
      ).map((facet) => `${key} · ${facet}`)
    );
    expect(moved).toEqual(["opencode-go/gemini-4-argon · callConfig"]);
    const key = "opencode-go/gemini-4-argon";
    expect(expectedFacet("callConfig", key)).toBe("INVALID_CONFIG");
    expect(expectedFacet("callConfig", key, piAiFirst)).toBe("ok");
  });
});

describe(
  "characterization · a gap-free plane (tier B)",
  { timeout: 30_000 },
  () => {
    it("[KNOWN_DEFECT] the unknown id itself is what the save check names when the plane stores no other gap", async () => {
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
      const { ctx, piEntry, profile } = tier;
      const before = readFileSync(profile.patchPath);
      await expect(
        ctx.configEditor.edit(piEntry, appendTo("opencode", SAVE_CANDIDATE))
      ).rejects.toThrow(S0_TODAY.saveRejectedUnknown);
      expect(readFileSync(profile.patchPath)).toEqual(before);
    });
  }
);
