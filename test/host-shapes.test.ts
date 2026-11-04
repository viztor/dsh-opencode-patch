/**
 * The host shapes and exports the plane provider (P-R1) is built from, pinned
 * on the installed packages.
 *
 * The design reaches into pi-ai's private profile shape, its exported `Config`
 * and `recordKeyFor`, the loader's exported `interpolate` and pi's public
 * per-protocol exports (docs/improvement-plan.md, "Target architecture"). None
 * of that is a promise the host made, so each piece is pinned here against the
 * real package, with the host file and line it reads. A host bump that moves
 * one turns this file red before any routing code depends on it.
 *
 * It runs on whichever host cell is installed (`HOST_CELL`: either channel's
 * newest pi, or a channel's floor). What differs between the cells (pi's
 * catalog bases and counts, which ids it can place, whether its Go provider
 * carries Google, pi-ai's own defaults per cluster) carries one expectation
 * per cell (`forHost`) or per channel (`forChannel`), measured on each.
 *
 * `test/mount-protocols.test.ts` already pins the four `api/*.lazy` factories
 * against the catalog's SDKs; this file does not repeat it.
 *
 * @module test/host-shapes.test
 */
import { readFileSync } from "node:fs";

import { Context } from "@deepseek-ai/cordis";
import { interpolate } from "@deepseek-ai/cordis-plugin-loader";
import { resolveRetryPolicy } from "@deepseek-ai/dsh-llm";
import * as LlmPiAi from "@deepseek-ai/dsh-llm-pi-ai";
import z from "@deepseek-ai/schemastery";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  adaptersOf,
  drainStream,
  fakeCredentials,
  hostModulesForTests,
  forChannel,
  forHost,
  HOST_CELL,
  mountTierA,
  PI_GAPS,
  PI_OF_CELL,
  PLANES,
  recordingFetch,
  S0_PROFILE,
  s0Providers,
  type TierA,
} from "./support/host.ts";
import {
  buildPlaneProvider,
  OPENCODE_FAMILY_API,
  OPENCODE_ZEN_CATALOG,
  planeProfileFor,
} from "./support/src.ts";

/** The pi the install under test runs, for the titles. */
const PI = PI_OF_CELL[HOST_CELL];

/** Per protocol: the bases pi's catalog files a plane's models under, and how many. */
type ByProtocol = Record<string, { count: number; bases: string[] }>;

const ZEN_BASE = "https://opencode.ai";

/**
 * F1/F2, measured per cell: a model-less plane resolves pi's whole catalog.
 * The bases moved twice under the plugin: the legacy family on pi 1.1.0, the
 * root `/inference(/go)/v1` on 1.3.0, and per-protocol roots on 1.5.0, where
 * the per-protocol counts moved too (Zen, net of 1.3.0: four fewer
 * completions models and one fewer Anthropic one). Go gained a Google model
 * on 1.3.0 (F10). A pi bump whose catalog moved re-measures the `newest`
 * column in its own pull request, as a reviewed change (CONTRIBUTING, release
 * step 3).
 */
const WHOLE_CATALOG: Readonly<
  Record<
    "alpha-floor" | "newest" | "rc-floor",
    { zen: ByProtocol; go: ByProtocol }
  >
> = {
  "alpha-floor": {
    go: {
      "anthropic-messages": { bases: [`${ZEN_BASE}/inference/go`], count: 5 },
      "google-generative-ai": {
        bases: [`${ZEN_BASE}/inference/go/v1`],
        count: 1,
      },
      "openai-completions": {
        bases: [`${ZEN_BASE}/inference/go/v1`],
        count: 18,
      },
      "openai-responses": { bases: [`${ZEN_BASE}/inference/go/v1`], count: 5 },
    },
    zen: {
      "anthropic-messages": { bases: [`${ZEN_BASE}/inference`], count: 18 },
      "google-generative-ai": {
        bases: [`${ZEN_BASE}/inference/v1`],
        count: 8,
      },
      "openai-completions": { bases: [`${ZEN_BASE}/inference/v1`], count: 28 },
      "openai-responses": { bases: [`${ZEN_BASE}/inference/v1`], count: 30 },
    },
  },
  newest: {
    go: {
      "anthropic-messages": {
        bases: [`${ZEN_BASE}/inference/go/anthropic`],
        count: 5,
      },
      "google-generative-ai": {
        bases: [`${ZEN_BASE}/inference/go/google/v1beta`],
        count: 1,
      },
      "openai-completions": {
        bases: [`${ZEN_BASE}/inference/go/openai/v1`],
        count: 19,
      },
      "openai-responses": {
        bases: [`${ZEN_BASE}/inference/go/openai/v1`],
        count: 5,
      },
    },
    zen: {
      "anthropic-messages": {
        bases: [`${ZEN_BASE}/inference/anthropic`],
        count: 17,
      },
      "google-generative-ai": {
        bases: [`${ZEN_BASE}/inference/google/v1beta`],
        count: 8,
      },
      "openai-completions": {
        bases: [`${ZEN_BASE}/inference/openai/v1`],
        count: 24,
      },
      "openai-responses": {
        bases: [`${ZEN_BASE}/inference/openai/v1`],
        count: 30,
      },
    },
  },
  "rc-floor": {
    go: {
      "anthropic-messages": { bases: [`${ZEN_BASE}/zen/go`], count: 5 },
      "openai-completions": { bases: [`${ZEN_BASE}/zen/go/v1`], count: 19 },
      "openai-responses": { bases: [`${ZEN_BASE}/zen/go/v1`], count: 6 },
    },
    zen: {
      "anthropic-messages": { bases: [`${ZEN_BASE}/zen`], count: 18 },
      "google-generative-ai": { bases: [`${ZEN_BASE}/zen/v1`], count: 7 },
      "openai-completions": { bases: [`${ZEN_BASE}/zen/v1`], count: 28 },
      "openai-responses": { bases: [`${ZEN_BASE}/zen/v1`], count: 30 },
    },
  },
};

/** Collapse one cell's whole catalog onto a single protocol, as F5's route-level `api` does. */
const collapsed = (catalog: ByProtocol, api: string): ByProtocol => {
  const bases = [
    ...new Set(Object.values(catalog).flatMap((row) => row.bases)),
  ].toSorted();
  const count = Object.values(catalog).reduce((sum, row) => sum + row.count, 0);
  return { [api]: { bases, count } };
};

/** Move every protocol of one cell's catalog onto a single base, as F5's route-level `baseURL` does. */
const rebased = (catalog: ByProtocol, base: string): ByProtocol =>
  Object.fromEntries(
    Object.entries(catalog).map(([api, row]) => [
      api,
      { bases: [base], count: row.count },
    ])
  );

/** A schemastery node, as far as the role walk reads it. */
interface SchemaNode {
  readonly type?: string;
  readonly meta?: { readonly role?: string };
  readonly dict?: Readonly<Record<string, SchemaNode>>;
  readonly inner?: SchemaNode;
  readonly list?: readonly SchemaNode[];
}

/**
 * The node types the role walk knows. A host bump that introduces another
 * (a wrapper carrying `inner`, say) fails the pin by name instead of being
 * walked blind.
 */
const KNOWN_NODE_TYPES = new Set([
  "any",
  "array",
  "boolean",
  "const",
  "dict",
  "intersect",
  "number",
  "object",
  "string",
  "transform",
  "union",
]);

/** The path segment an `inner` node is walked under: none for a wrapper. */
const INNER_SEGMENT: Readonly<Record<string, readonly string[]>> = {
  array: ["[]"],
  dict: ["*"],
};

/**
 * Every node under `node` that declares a role, as `[...path, role]`, and
 * every node type visited. A dict's value is walked under `*`, an array's item
 * under `[]`, and any other node's `inner` (a transform, or a wrapper a later
 * schemastery adds) at its parent's path; union and intersect members share
 * their parent's path too.
 */
const rolesUnder = (
  node: SchemaNode,
  path: string[],
  types = new Set<string>()
): string[][] => {
  const found: string[][] = [];
  types.add(String(node.type));
  if (node.meta?.role !== undefined) {
    found.push([...path, node.meta.role]);
  }
  if (node.type === "object") {
    for (const [key, child] of Object.entries(node.dict ?? {})) {
      found.push(...rolesUnder(child, [...path, key], types));
    }
  }
  if (node.inner !== undefined) {
    found.push(
      ...rolesUnder(
        node.inner,
        [...path, ...(INNER_SEGMENT[String(node.type)] ?? [])],
        types
      )
    );
  }
  for (const member of node.list ?? []) {
    found.push(...rolesUnder(member, path, types));
  }
  return found;
};

/** A resolved provider profile as pi-ai's adapter holds it (private). */
const profileOf = (tier: TierA, route: string): Record<string, unknown> => {
  const adapter = adaptersOf(tier.llm).get(route)?.adapter as unknown as {
    config: { profiles: () => ReadonlyMap<string, Record<string, unknown>> };
  };
  const profile = adapter.config.profiles().get(route);
  if (profile === undefined) {
    throw new Error(`no resolved profile for ${route}`);
  }
  return profile;
};

/** A pi model, as far as these pins read one. */
interface PiModel {
  readonly api: string;
  readonly baseUrl: string;
}

/** Per protocol, how many models a pi provider carries and on which bases. */
const byProtocol = (
  provider: unknown
): Record<string, { count: number; bases: string[] }> => {
  const models = (
    provider as { getModels: () => readonly PiModel[] }
  ).getModels();
  const out: Record<string, { count: number; bases: string[] }> = {};
  for (const model of models) {
    const row = out[model.api] ?? { bases: [], count: 0 };
    out[model.api] = row;
    row.count += 1;
    if (!row.bases.includes(model.baseUrl)) {
      row.bases.push(model.baseUrl);
    }
  }
  return out;
};

let tier: TierA | undefined;

afterEach(async () => {
  await tier?.dispose();
  tier = undefined;
  vi.unstubAllGlobals();
});

describe("host · pi-ai's Config (llm-pi-ai/src/config.ts)", () => {
  it("resolves an empty profile to these defaults, and providers is volatile (config.ts:47-80,326-354)", () => {
    const resolved = (
      LlmPiAi.Config({ providers: { x: {} } } as never) as unknown as {
        providers: { get: () => Record<string, unknown> };
      }
    ).providers.get().x;
    // pi-ai's own defaults are the cluster's, not pi's: the alpha cluster
    // raised both (llm-pi-ai config.ts:65,68), the rc one keeps the old pair.
    expect(resolved).toEqual({
      compat: { chatTemplateArgs: {}, chatTemplateKwargs: {} },
      defaultContextWindow: forChannel({ alpha: 1_000_000, rc: 262_144 }),
      defaultInput: ["text"],
      defaultMaxTokens: forChannel({ alpha: 128_000, rc: 32_768 }),
      headers: {},
      maxRequestImageBytes: 20_971_520,
      modelOverrides: {},
      models: [],
      requestImageMaxBytes: 1_048_576,
      requestImagePixelBudget: 4_194_304,
      streamIdleTimeoutMs: 300_000,
      thinkingBudgets: {},
    });
    const schema = LlmPiAi.Config as unknown as SchemaNode & {
      dict: { providers: { meta: { volatile?: boolean } } };
    };
    expect(schema.dict.providers.meta.volatile).toBe(true);
  });

  it("resolves an absent retry policy to normal mode with five retries (dsh-llm retry-policy.ts:149)", () => {
    expect(resolveRetryPolicy(undefined, "t")).toEqual({
      initialDelayMs: 500,
      jitterRatio: 0.1,
      maxDelayMs: 10_000,
      maxRetries: 5,
      mode: "normal",
      retryableCodes: [
        "EMPTY_RESPONSE",
        "RATE_LIMIT",
        "SERVER",
        "TIMEOUT",
        "TRANSPORT",
      ],
    });
  });

  it("carries no role('secret') under providers; apiKeyEnv is the only role, credential-ref (config.ts:327)", () => {
    const schema = LlmPiAi.Config as unknown as SchemaNode;
    const types = new Set<string>();
    expect(rolesUnder(schema, [], types)).toEqual([
      ["providers", "*", "apiKeyEnv", "credential-ref"],
    ]);
    expect(
      [...types].filter((type) => !KNOWN_NODE_TYPES.has(type)),
      "a node type the walk does not know"
    ).toEqual([]);
    // The walk reads roles at every depth: a planted secret is reported.
    const planted = z.object({
      providers: z.dict(
        z.object({
          models: z.array(z.object({ token: z.string().role("secret") })),
        })
      ),
    }) as unknown as SchemaNode;
    expect(rolesUnder(planted, [])).toEqual([
      ["providers", "*", "models", "[]", "token", "secret"],
    ]);
    // ...including one under a transform, whose `inner` is walked too.
    const wrapped = z.object({
      providers: z.dict(
        z.transform(
          z.object({ token: z.string().role("secret") }),
          (value: unknown) => value
        )
      ),
    }) as unknown as SchemaNode;
    expect(rolesUnder(wrapped, [])).toEqual([
      ["providers", "*", "token", "secret"],
    ]);
  });
});

describe("host · ResolvedPiAiProviderProfile (llm-pi-ai/src/config.ts:186-219,490-507)", () => {
  it("declares exactly these fields in the published types", () => {
    const text = readFileSync(
      new URL(
        "../node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/types/config.d.ts",
        import.meta.url
      ),
      "utf8"
    );
    const start = text.indexOf("export interface ResolvedPiAiProviderProfile");
    expect(start).toBeGreaterThan(-1);
    const block = text.slice(start, text.indexOf("\n}", start));
    // The heritage clause names what is inherited; the body what is resolved.
    expect(block).toContain(
      "extends Omit<PiAiProviderProfile, 'apiKeyEnv' | 'retryPolicy' | 'models' | 'displayName'>"
    );
    const fields = [...block.matchAll(/^ {4}(\w+\??):/gmu)].map(
      (match) => match[1]
    );
    expect(fields).toEqual([
      "provider",
      "displayName",
      "apiKeyEnv?",
      "streamIdleTimeoutMs",
      "maxRequestImageBytes",
      "requestImagePixelBudget",
      "requestImageMaxBytes",
      "retryPolicy",
      "piProvider?",
      "catalogError?",
      "modelErrors",
      "configuredMaxTokens",
    ]);
  });

  it("resolves a profile with these keys at runtime, models destructured out; F4 — a stored id pi cannot place is deferred to modelErrors and catalogError (config.ts:487)", async () => {
    tier = await mountTierA({ providers: s0Providers() });
    const profile = profileOf(tier, "opencode");
    expect(Object.keys(profile).toSorted()).toEqual([
      "apiKeyEnv",
      "catalogError",
      "compat",
      "configuredMaxTokens",
      "defaultContextWindow",
      "defaultInput",
      "defaultMaxTokens",
      "displayName",
      "headers",
      "maxRequestImageBytes",
      "modelErrors",
      "modelOverrides",
      "piProvider",
      "provider",
      "requestImageMaxBytes",
      "requestImagePixelBudget",
      "retryPolicy",
      "streamIdleTimeoutMs",
      "thinkingBudgets",
    ]);
    expect(profile.modelErrors).toBeInstanceOf(Map);
    expect(profile.configuredMaxTokens).toBeInstanceOf(Map);
    // A stored gap id is a deferred diagnostic, not a refusal (config.ts:487).
    expect([...(profile.modelErrors as Map<string, string>).keys()]).toEqual([
      "gpt-5.3-codex-spark",
    ]);
    expect(profile.catalogError).toMatch(
      /model "gpt-5\.3-codex-spark" needs an api/u
    );
    // The Go gap ids are gaps on the floors only: pi 1.5.0 places both.
    expect([
      ...(
        profileOf(tier, "opencode-go").modelErrors as Map<string, string>
      ).keys(),
    ]).toEqual(PI_GAPS["opencode-go"]);
  });

  it("F4 — a stored id pi cannot place is not listed, and a turn on it is INVALID_CONFIG with no request (index.ts:171; adapter.ts:271-311)", async () => {
    // Plugin-less, so this half of F4 outlives the characterization rows that
    // also show it with the plugin mounted (P-R1 flips those). A key is stored
    // for each plane: with none, F18's empty listing would mask the check.
    const wire = recordingFetch();
    vi.stubGlobal("fetch", wire.fetch);
    const mounted = await mountTierA({
      credentials: fakeCredentials({
        refs: { OPENCODE_API_KEY: "zen-k", OPENCODE_GO_API_KEY: "go-k" },
      }),
      providers: s0Providers(),
    });
    tier = mounted;
    const listed = async (route: string): Promise<string[]> => {
      const models = await mounted.llm.listModels(route);
      return models.map((model) => model.id);
    };
    // Every declared id the installed pi places is listed, in declaration
    // order; none of its gap ids is.
    for (const plane of PLANES) {
      expect(await listed(plane), plane).toEqual(
        S0_PROFILE[plane].models
          .map((model) => model.id)
          .filter((id) => !PI_GAPS[plane].includes(id))
      );
    }
    expect(PI_GAPS.opencode).toEqual(["gpt-5.3-codex-spark"]);
    for (const [route, model] of PLANES.flatMap((plane) =>
      PI_GAPS[plane].map((id) => [plane, id] as const)
    )) {
      const drained = await drainStream(mounted.llm, route, model);
      expect(drained.finish, `${route}/${model}`).toEqual({
        code: "INVALID_CONFIG",
        kind: "error",
      });
    }
    expect(wire.requests).toEqual([]);
  });

  it(`F1/F2 — a model-less plane resolves pi ${PI}'s whole catalog, per protocol, on pi's own bases for this cell`, async () => {
    tier = await mountTierA({
      providers: { opencode: {}, "opencode-go": {} },
    });
    const zen = profileOf(tier, "opencode");
    expect(zen.catalogError).toBeUndefined();
    expect(byProtocol(zen.piProvider)).toEqual(forHost(WHOLE_CATALOG).zen);
    expect(byProtocol(profileOf(tier, "opencode-go").piProvider)).toEqual(
      forHost(WHOLE_CATALOG).go
    );
  });

  it("F5 — a route-level api and baseURL override every model, collapsing pi's four protocols onto one (llm-pi-ai/src/catalog.ts:917,922)", async () => {
    tier = await mountTierA({
      providers: {
        opencode: { api: "openai-responses" },
        "opencode-go": { baseURL: "https://gateway.test/go" },
      },
    });
    const zen = profileOf(tier, "opencode");
    expect(zen.catalogError).toBeUndefined();
    // Every one of F2's Zen models now speaks Responses; each keeps its own
    // base, which only the route's baseURL would override.
    const whole = forHost(WHOLE_CATALOG);
    expect(byProtocol(zen.piProvider)).toEqual(
      collapsed(whole.zen, "openai-responses")
    );
    // Go's models keep their protocols and all move to the route's base.
    expect(byProtocol(profileOf(tier, "opencode-go").piProvider)).toEqual(
      rebased(whole.go, "https://gateway.test/go")
    );
    // A known answer for the derivation: pi 1.1.0's 83 Zen models, on two
    // bases, measured before the tables existed.
    expect(
      collapsed(WHOLE_CATALOG["rc-floor"].zen, "openai-responses")
    ).toEqual({
      "openai-responses": {
        bases: ["https://opencode.ai/zen", "https://opencode.ai/zen/v1"],
        count: 83,
      },
    });
  });
});

describe("host · pi-ai's credential key (llm-pi-ai/src/auth.ts:29-39; credentials/src/index.ts:69-78)", () => {
  it("addresses a route's record as llm-pi-ai/<route>, and refuses a key outside the grammar", () => {
    expect(LlmPiAi.recordKeyFor("opencode")).toBe("llm-pi-ai/opencode");
    expect(LlmPiAi.recordKeyFor("opencode-go")).toBe("llm-pi-ai/opencode-go");
    expect(() => LlmPiAi.recordKeyFor("Not Valid")).toThrow(TypeError);
  });
});

describe("host · the loader's interpolate (vendor/loader/src/config/utils.ts:12-22; index.ts:19)", () => {
  it("replaces {__jsExpr} nodes at any depth and leaves the rest alone", () => {
    expect(
      interpolate(new Context(), {
        a: { __jsExpr: "1 + 1" },
        b: [{ __jsExpr: '"x"' }],
        c: "c",
      })
    ).toEqual({ a: 2, b: ["x"], c: "c" });
  });
});

describe(`host · pi ${PI}'s public exports (package.json exports ./providers/*, ./api/*, ./models)`, () => {
  it("opencodeProvider/opencodeGoProvider resolve keys through pi's ambient auth (providers/opencode.js:10-24; opencode-go.js:8-20)", async () => {
    const { opencodeProvider } =
      await import("@earendil-works/pi-ai/providers/opencode");
    const { opencodeGoProvider } =
      await import("@earendil-works/pi-ai/providers/opencode-go");
    for (const provider of [opencodeProvider(), opencodeGoProvider()]) {
      const auth = provider.auth as {
        apiKey?: {
          resolve: (input: {
            ctx: { env: (name: string) => Promise<string | undefined> };
            credential?: { key?: string };
            signal: AbortSignal;
          }) => Promise<
            { auth: { apiKey: string }; source: string } | undefined
          >;
        };
      };
      expect(typeof auth.apiKey?.resolve).toBe("function");
      const asked: string[] = [];
      const resolved = await auth.apiKey?.resolve({
        ctx: {
          env: async (name) => {
            asked.push(name);
            return name === "OPENCODE_API_KEY" ? "ambient" : undefined;
          },
        },
        signal: new AbortController().signal,
      });
      // Both planes read the one Zen variable: Go has no variable of its own.
      expect(asked).toEqual(["OPENCODE_API_KEY"]);
      expect(resolved).toMatchObject({
        auth: { apiKey: "ambient" },
        source: "OPENCODE_API_KEY",
      });
    }
  });

  /**
   * F10, per cell: pi 1.1.0's Go provider has no Google API; pi 1.3.0 added
   * it and 1.5.0 keeps it. A fact about pi, not a limitation of the plugin:
   * the gateway's Go plane serves Google models whichever pi runs, and the
   * plugin routes them itself (the Google bridge today, the plane adapter
   * from P-R1), so neither cell's row is a `HOST_LIMITATION`.
   */
  const GO_HAS_GOOGLE = forHost({
    "alpha-floor": true,
    newest: true,
    "rc-floor": false,
  });

  it.runIf(GO_HAS_GOOGLE)(
    `[BASELINE] F10 — pi ${PI}'s Go provider carries the Google API (pi 1.3.0 added it)`,
    async () => {
      const { opencodeGoProvider } =
        await import("@earendil-works/pi-ai/providers/opencode-go");
      const models = opencodeGoProvider().getModels() as readonly PiModel[];
      expect([...new Set(models.map((model) => model.api))].toSorted()).toEqual(
        [
          "anthropic-messages",
          "google-generative-ai",
          "openai-completions",
          "openai-responses",
        ]
      );
    }
  );

  it.skipIf(GO_HAS_GOOGLE)(
    `[BASELINE] F10 — pi ${PI}'s Go provider has no Google API: a Google model streams pi's own 'no API implementation' error`,
    async () => {
      const { opencodeProvider } =
        await import("@earendil-works/pi-ai/providers/opencode");
      const { opencodeGoProvider } =
        await import("@earendil-works/pi-ai/providers/opencode-go");
      const apisOf = (provider: { getModels: () => readonly PiModel[] }) =>
        [...new Set(provider.getModels().map((model) => model.api))].toSorted();
      expect(apisOf(opencodeProvider())).toEqual([
        "anthropic-messages",
        "google-generative-ai",
        "openai-completions",
        "openai-responses",
      ]);
      expect(apisOf(opencodeGoProvider())).toEqual([
        "anthropic-messages",
        "openai-completions",
        "openai-responses",
      ]);
      const gemini = opencodeProvider()
        .getModels()
        .find((model) => model.api === "google-generative-ai");
      expect(gemini).toBeDefined();
      const events: unknown[] = [];
      for await (const event of opencodeGoProvider().stream(
        { ...gemini, provider: "opencode-go" } as never,
        { messages: [] } as never,
        {}
      )) {
        events.push(event);
      }
      expect(JSON.stringify(events)).toContain(
        'Provider opencode-go has no API implementation for \\"google-generative-ai\\"'
      );
    }
  );

  it("exports createProvider and withOpenCodeSessionHeader (models.js:527; providers/opencode-headers.js:15)", async () => {
    const { createProvider } = await import("@earendil-works/pi-ai/models");
    expect(typeof createProvider).toBe("function");
    const { withOpenCodeSessionHeader } =
      await import("@earendil-works/pi-ai/providers/opencode-headers");
    const wrapped = withOpenCodeSessionHeader({
      stream: (_model: unknown, _context: unknown, options: unknown) => options,
      streamSimple: (_model: unknown, _context: unknown, options: unknown) =>
        options,
    } as never) as {
      streamSimple: (
        model: unknown,
        context: unknown,
        options: unknown
      ) => unknown;
    };
    expect(wrapped.streamSimple({}, {}, { sessionId: "ses_x" })).toEqual({
      headers: { "x-opencode-session": "ses_x" },
      sessionId: "ses_x",
    });
    // A caller-set header is kept, whatever its case.
    expect(
      wrapped.streamSimple(
        {},
        {},
        { headers: { "X-OpenCode-Session": "mine" }, sessionId: "ses_x" }
      )
    ).toEqual({
      headers: { "X-OpenCode-Session": "mine" },
      sessionId: "ses_x",
    });
  });
});

describe("host · parity of the plane profile with pi-ai's own resolution", () => {
  it("planeProfileFor resolves a catalog-known plane entry's scalar fields exactly as pi-ai resolves them", async () => {
    const entry = {
      apiKeyEnv: "OPENCODE_API_KEY",
      displayName: "Zen",
      headers: { "x-a": "1" },
      maxRequestImageBytes: 1024,
      models: [{ id: "deepseek-v4-pro", maxTokens: 9 }],
      reasoning: "high",
      retryPolicy: { maxRetries: 2, mode: "normal" },
      streamIdleTimeoutMs: 1000,
      thinkingBudgets: { high: 7 },
    };
    tier = await mountTierA({
      providers: { opencode: structuredClone(entry) },
    });
    const piAi = profileOf(tier, "opencode");
    const libraries = await hostModulesForTests().libraries();
    if (libraries === undefined) {
      throw new Error("no libraries");
    }
    const { profile } = planeProfileFor({
      buildProvider: buildPlaneProvider(libraries),
      catalog: OPENCODE_ZEN_CATALOG,
      endpoint: "auto",
      entry,
      familyApi: OPENCODE_FAMILY_API.zen,
      normalize: (raw) =>
        (
          LlmPiAi.Config({
            providers: { opencode: raw },
          } as never) as unknown as {
            providers: { get: () => Record<string, unknown> };
          }
        ).providers.get().opencode,
      piModels: libraries.builtinModels("opencode"),
      resolveRetryPolicy: libraries.resolveRetryPolicy,
      route: "opencode",
    });
    const scalar = (resolved: Record<string, unknown>) => {
      const {
        configuredMaxTokens,
        modelErrors,
        piProvider: _provider,
        ...rest
      } = resolved;
      return {
        ...rest,
        configuredMaxTokens: [...(configuredMaxTokens as Map<string, number>)],
        modelErrors: [...(modelErrors as Map<string, string>)],
      };
    };
    expect(scalar(profile)).toEqual(scalar(piAi));
  });
});
