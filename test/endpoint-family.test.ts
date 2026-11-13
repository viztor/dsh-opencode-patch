/**
 * The endpoint family each `endpoint` setting sends a turn to, pinned (P-R2).
 *
 * P-R2 measures which families the live gateway serves
 * (`test/e2e/keyless-matrix.e2e.ts`, `test/e2e/keyed-probes.e2e.ts`) and keeps
 * the default: `auto`, an alias of `modern`. This file holds the two halves of
 * that decision offline — the default sends every protocol on both planes to
 * the modern family, and `endpoint: legacy` still maps every protocol on both
 * planes, Go's Google on its one base. The family `auto` resolves to is one
 * constant (`AUTO_ENDPOINT_FAMILY`), but a flip is not a one-word edit: it
 * also moves the copy, `TODAY_DISPATCH`, the bases pinned here and the
 * re-tagged wire facets (`docs/redirect-planes.md` §13), and this file turns
 * red until they move together. `endpoint: legacy` is recorded, not guarded,
 * on the live gateway; these pins are what guard its mapping. The setting
 * moves only the planes the route claim takes: a plane entry another plugin
 * owns (D27) is pi-ai's, and leaves at the URL pi-ai alone sends under every
 * setting (the last block, on a tier-A host).
 *
 * @module test/endpoint-family.test
 */
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  drainStream,
  fakeCredentials,
  mountTierA,
  recordingFetch,
  type RecordingFetch,
  type TierA,
  waitForPlaneOwner,
} from "./support/host.ts";
import {
  cellKey,
  keylessMatrix,
  LEGACY_DISPATCH,
  MATRIX_FAMILIES,
  matrixUrl,
  TODAY_DISPATCH,
} from "./support/keyless-matrix.ts";
import {
  AUTO_ENDPOINT_FAMILY,
  baseUrlFor,
  CONFIG_DEFAULTS,
  DEFAULT_ENDPOINT_FAMILY,
  type EndpointChoice,
  GO_GOOGLE_BASE_URL,
  LEGACY_BASE,
  OPENCODE_FAMILY_API,
  OPENCODE_GO_CATALOG,
  OPENCODE_ZEN_CATALOG,
  PLANE_ROUTES,
  type PlanePiModel,
  planeModelFor,
  type PlaneRoute,
  type Protocol,
  PROTOCOLS,
  resolveConfig,
} from "./support/src.ts";

const familyApiOf = (plane: PlaneRoute): Readonly<Record<string, string>> =>
  OPENCODE_FAMILY_API[plane === "opencode" ? "zen" : "go"];

/**
 * The path each protocol appends to a model's base, restated from
 * `docs/redirect-planes.md` §9 (the query aside): the Anthropic SDK appends
 * its own `/v1/messages`, and Google names the model in the path.
 */
const SENT_PATH: Readonly<Record<Protocol, (id: string) => string>> = {
  "anthropic-messages": () => "/v1/messages",
  "google-generative-ai": (id) => `/models/${id}:streamGenerateContent`,
  "openai-completions": () => "/chat/completions",
  "openai-responses": () => "/responses",
};

/**
 * The route's defaults as pi-ai's `Config` fills them. Stand-in values, on
 * purpose not either channel's: the plugin restates none of pi-ai's defaults
 * (D17), and the family a turn is sent to does not depend on them.
 */
const DEFAULTS = { contextWindow: 123_456, input: ["text"], maxTokens: 6_543 };

/** Every plane × protocol's base under one `endpoint` setting. */
const basesFor = (endpoint: EndpointChoice): Record<string, string> =>
  Object.fromEntries(
    PLANE_ROUTES.flatMap((plane) =>
      PROTOCOLS.map((protocol) => [
        `${plane} ${protocol}`,
        baseUrlFor(plane, protocol, undefined, endpoint, familyApiOf(plane)),
      ])
    )
  );

describe("endpoint family · the default", () => {
  it("the default is auto, and auto sends every protocol on both planes to the modern family", () => {
    expect(DEFAULT_ENDPOINT_FAMILY).toBe("auto");
    expect(CONFIG_DEFAULTS.endpoint).toBe("auto");
    expect(resolveConfig({}).endpoint).toBe("auto");
    // A family the setting does not know degrades to the default.
    expect(resolveConfig({ endpoint: "zen" as never }).endpoint).toBe("auto");

    const bases = basesFor(DEFAULT_ENDPOINT_FAMILY);
    expect(bases).toEqual({
      "opencode anthropic-messages": "https://opencode.ai/inference/anthropic",
      "opencode google-generative-ai":
        "https://opencode.ai/inference/google/v1beta",
      "opencode openai-completions": "https://opencode.ai/inference/openai/v1",
      "opencode openai-responses": "https://opencode.ai/inference/openai/v1",
      "opencode-go anthropic-messages":
        "https://opencode.ai/inference/go/anthropic",
      "opencode-go google-generative-ai":
        "https://opencode.ai/inference/go/google/v1beta",
      "opencode-go openai-completions":
        "https://opencode.ai/inference/go/openai/v1",
      "opencode-go openai-responses":
        "https://opencode.ai/inference/go/openai/v1",
    });
    const modern = basesFor("modern");
    for (const [cell, base] of Object.entries(bases)) {
      expect(base, cell).toBe(modern[cell]);
    }
  });
});

describe("endpoint family · the one constant", () => {
  it("snapshots AUTO_ENDPOINT_FAMILY as modern; auto's bases equal the constant's, a guard that bites once the constant flips", () => {
    // The family `auto` resolves to; P-R2 keeps it while the families are
    // measured in CI (docs/redirect-planes.md §13, pending the first run), and
    // a measured flip is P-R2b's `fix:`.
    expect(AUTO_ENDPOINT_FAMILY).toBe("modern");
    // While the constant is `modern` this loop restates the first describe.
    // It is the guard for the flip: change the constant, and a `baseUrlFor`
    // that ignored it would leave `auto` on the old family and fail here.
    for (const plane of PLANE_ROUTES) {
      for (const protocol of PROTOCOLS) {
        expect(
          baseUrlFor(plane, protocol, undefined, "auto", familyApiOf(plane)),
          `${plane} ${protocol}`
        ).toBe(
          baseUrlFor(
            plane,
            protocol,
            undefined,
            AUTO_ENDPOINT_FAMILY,
            familyApiOf(plane)
          )
        );
      }
    }
    expect(
      [...TODAY_DISPATCH].every((cell) =>
        cell.endsWith(` ${AUTO_ENDPOINT_FAMILY}`)
      )
    ).toBe(true);
  });
});

describe("endpoint family · legacy", () => {
  it("endpoint: legacy maps every protocol on both planes: the /zen bases, Go's Google on its one base", () => {
    const bases = basesFor("legacy");
    expect(bases).toEqual({
      "opencode anthropic-messages": "https://opencode.ai/zen",
      "opencode google-generative-ai": "https://opencode.ai/zen/v1",
      "opencode openai-completions": "https://opencode.ai/zen/v1",
      "opencode openai-responses": "https://opencode.ai/zen/v1",
      "opencode-go anthropic-messages": "https://opencode.ai/zen/go",
      "opencode-go google-generative-ai":
        "https://opencode.ai/inference/go/google/v1beta",
      "opencode-go openai-completions": "https://opencode.ai/zen/go/v1",
      "opencode-go openai-responses": "https://opencode.ai/zen/go/v1",
    });
    expect(Object.keys(bases)).toHaveLength(8);
    for (const plane of PLANE_ROUTES) {
      for (const protocol of PROTOCOLS) {
        const base = bases[`${plane} ${protocol}`];
        expect(base, `${plane} ${protocol}`).toBeDefined();
        expect(base).toBe(LEGACY_BASE[plane][protocol]);
        const url = new URL(base ?? "");
        expect(url.hostname).toBe("opencode.ai");
        if (plane === "opencode-go" && protocol === "google-generative-ai") {
          expect(base).toBe(GO_GOOGLE_BASE_URL);
        } else {
          expect(url.pathname.startsWith("/zen"), `${plane} ${protocol}`).toBe(
            true
          );
        }
      }
    }
  });
});

describe("endpoint family · what a turn reaches", () => {
  const cells = keylessMatrix({
    go: OPENCODE_GO_CATALOG,
    zen: OPENCODE_ZEN_CATALOG,
  });

  /** The matrix cells a turn of each plane × protocol reaches under `endpoint`. */
  const reachedUnder = (endpoint: EndpointChoice): string[] => {
    const reached: string[] = [];
    for (const plane of PLANE_ROUTES) {
      const catalog =
        plane === "opencode" ? OPENCODE_ZEN_CATALOG : OPENCODE_GO_CATALOG;
      const pis = getBuiltinModels(plane as never) as unknown as PlanePiModel[];
      for (const protocol of PROTOCOLS) {
        const id = cells.find(
          (cell) =>
            cell.plane === plane &&
            cell.protocol === protocol &&
            cell.family === "modern"
        )?.model;
        expect(id, `${plane} ${protocol}`).toBeDefined();
        const spec = catalog.find((row) => row.id === id);
        const pi = pis.find((row) => row.id === id);
        const result = planeModelFor({
          defaults: DEFAULTS,
          endpoint,
          entry: { id },
          familyApi: familyApiOf(plane),
          route: plane,
          ...(spec === undefined ? {} : { spec }),
          ...(pi === undefined ? {} : { pi }),
        });
        expect(result.error, `${plane} ${protocol}`).toBeUndefined();
        expect(result.model?.api).toBe(protocol);
        const sent =
          new URL(result.model?.baseUrl ?? "").pathname.replace(/\/$/u, "") +
          SENT_PATH[protocol](id ?? "");
        const matches = MATRIX_FAMILIES.filter(
          (family) =>
            new URL(matrixUrl(plane, protocol, family, id)).pathname === sent
        ).map((family) => cellKey({ family, plane, protocol }));
        expect(
          matches,
          `${endpoint} ${plane} ${protocol} ${sent}`
        ).toHaveLength(1);
        reached.push(matches[0] ?? "");
      }
    }
    return reached;
  };

  it("a turn reaches exactly the cells each setting dispatches to: auto and modern TODAY_DISPATCH, legacy LEGACY_DISPATCH", () => {
    const expected: Record<EndpointChoice, ReadonlySet<string>> = {
      auto: TODAY_DISPATCH,
      legacy: LEGACY_DISPATCH,
      modern: TODAY_DISPATCH,
    };
    for (const endpoint of [
      DEFAULT_ENDPOINT_FAMILY,
      "modern",
      "legacy",
    ] as const) {
      const reached = reachedUnder(endpoint);
      expect(reached.toSorted(), endpoint).toEqual(
        [...expected[endpoint]].toSorted()
      );
      expect(new Set(reached).size, endpoint).toBe(8);
      // Every plane × protocol once.
      expect(
        new Set(reached.map((cell) => cell.split(" ").slice(0, 2).join(" ")))
          .size
      ).toBe(8);
    }
  });
});

describe(
  "endpoint family · a plane another plugin owns (D27)",
  { timeout: 30_000 },
  () => {
    /** A model pi's own catalog serves on both planes, on completions. */
    const MODEL = "deepseek-v4-pro";
    /** The marker a vendor's setup writes on each route it owns. */
    const MARKED = {
      apiKeyEnv: "OPENCODE_GO_API_KEY",
      headers: { "x-opencode-plugin": "console-fixture/0.0.0" },
      models: [{ id: MODEL }],
    };
    const PLAIN = { apiKeyEnv: "OPENCODE_API_KEY", models: [{ id: MODEL }] };

    /** The hosts this block mounted, disposed after each case. */
    const mounted: TierA[] = [];
    const release = async (): Promise<void> => {
      try {
        for (const tier of mounted.splice(0)) {
          // oxlint-disable-next-line no-await-in-loop -- one host at a time, as each was mounted
          await tier.dispose();
        }
      } finally {
        vi.unstubAllGlobals();
      }
    };
    afterEach(release);

    /** The gateway URL one turn on `route` is sent to, the catalog read excluded. */
    const sentUrl = async (
      host: { readonly tier: TierA; readonly wire: RecordingFetch },
      route: string
    ): Promise<string | undefined> => {
      const before = host.wire.requests.length;
      await drainStream(host.tier.llm, route, MODEL);
      const sent = host.wire.requests
        .slice(before)
        .filter(
          (request) => !request.url.startsWith("https://models.opencode.ai/")
        );
      expect(sent, route).toHaveLength(1);
      return sent[0]?.url;
    };

    /** Mount pi-ai, and the plugin under `endpoint` unless it is `undefined`. */
    const mount = async (
      endpoint: EndpointChoice | undefined
    ): Promise<{ readonly tier: TierA; readonly wire: RecordingFetch }> => {
      const wire = recordingFetch();
      vi.stubGlobal("fetch", wire.fetch);
      const tier = await mountTierA({
        credentials: fakeCredentials({
          refs: { OPENCODE_API_KEY: "zen-k", OPENCODE_GO_API_KEY: "go-k" },
        }),
        ...(endpoint === undefined ? {} : { plugin: { endpoint } }),
        providers: { opencode: PLAIN, "opencode-go": MARKED },
      });
      mounted.push(tier);
      if (endpoint !== undefined) {
        await waitForPlaneOwner(tier.llm, ["opencode"]);
      }
      await waitForPlaneOwner(tier.llm, ["opencode-go"], "PiAiAdapter");
      return { tier, wire };
    };

    it.each([DEFAULT_ENDPOINT_FAMILY, "modern", "legacy"] as const)(
      "endpoint: %s moves the plane the claim takes and leaves the marked one at the URL pi-ai alone sends",
      async (endpoint) => {
        // The known answer: pi-ai alone, no plugin mounted.
        const alone = await sentUrl(await mount(undefined), "opencode-go");
        expect(alone).toBeDefined();
        await release();

        const host = await mount(endpoint);
        // The plane the claim takes follows the setting: the completions
        // cell of the family it names.
        const family = endpoint === "auto" ? AUTO_ENDPOINT_FAMILY : endpoint;
        expect(await sentUrl(host, "opencode")).toBe(
          matrixUrl("opencode", "openai-completions", family, MODEL)
        );
        // The marked plane does not: pi-ai serves it as it would alone.
        expect(await sentUrl(host, "opencode-go")).toBe(alone);
      }
    );

    it("the case above can see a move: what pi-ai alone sends for the marked plane is not the legacy cell `endpoint: legacy` would send it to", async () => {
      const alone = await sentUrl(await mount(undefined), "opencode-go");
      expect(alone).toBeDefined();
      expect(alone).not.toBe(
        matrixUrl("opencode-go", "openai-completions", "legacy", MODEL)
      );
    });
  }
);
