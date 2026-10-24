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
import { afterEach, describe, expect, it } from "vitest";

import {
  adaptersOf,
  mountTierA,
  s0Providers,
  type TierA,
} from "./support/host.ts";

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
});

describe("host · pi-ai's Config (llm-pi-ai/src/config.ts)", () => {
  it("resolves an empty profile to these defaults, and providers is volatile (config.ts:47-80,326-354)", () => {
    const resolved = (
      LlmPiAi.Config({ providers: { x: {} } } as never) as unknown as {
        providers: { get: () => Record<string, unknown> };
      }
    ).providers.get().x;
    expect(resolved).toEqual({
      compat: { chatTemplateArgs: {}, chatTemplateKwargs: {} },
      defaultContextWindow: 262_144,
      defaultInput: ["text"],
      defaultMaxTokens: 32_768,
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

  it("resolves a profile with these keys at runtime, models destructured out", async () => {
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
    expect([
      ...(
        profileOf(tier, "opencode-go").modelErrors as Map<string, string>
      ).keys(),
    ]).toEqual(["gemini-4-argon-contributor", "minimax-m3.1-flash"]);
  });

  it("F1/F2 — a model-less plane resolves pi 1.1.0's whole catalog, per protocol, on the legacy bases", async () => {
    tier = await mountTierA({
      providers: { opencode: {}, "opencode-go": {} },
    });
    const zen = profileOf(tier, "opencode");
    expect(zen.catalogError).toBeUndefined();
    expect(byProtocol(zen.piProvider)).toEqual({
      "anthropic-messages": { bases: ["https://opencode.ai/zen"], count: 18 },
      "google-generative-ai": {
        bases: ["https://opencode.ai/zen/v1"],
        count: 7,
      },
      "openai-completions": {
        bases: ["https://opencode.ai/zen/v1"],
        count: 28,
      },
      "openai-responses": { bases: ["https://opencode.ai/zen/v1"], count: 30 },
    });
    // F10: no Google model on Go.
    expect(byProtocol(profileOf(tier, "opencode-go").piProvider)).toEqual({
      "anthropic-messages": { bases: ["https://opencode.ai/zen/go"], count: 5 },
      "openai-completions": {
        bases: ["https://opencode.ai/zen/go/v1"],
        count: 19,
      },
      "openai-responses": {
        bases: ["https://opencode.ai/zen/go/v1"],
        count: 6,
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

describe("host · pi 1.1.0's public exports (package.json exports ./providers/*, ./api/*, ./models)", () => {
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

  it("F10 — the Go provider has no Google API: a Google model streams pi's own 'no API implementation' error", async () => {
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
  });

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
