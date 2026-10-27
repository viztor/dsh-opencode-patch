import { Context } from "@deepseek-ai/cordis";
/**
 * `planeProfileFor`: a plane's resolved profile from its raw entry, as pi-ai
 * resolves any route, minus "needs an api" (`src/utils/plane-profile.ts`).
 *
 * The host pieces are the real ones — pi-ai's `Config`, dsh-llm's
 * `resolveRetryPolicy`, pi's `createProvider` and protocol factories — so a
 * profile here is the one the plane adapter reads.
 *
 * @module test/plane-profile.test
 */
import { interpolate } from "@deepseek-ai/cordis-plugin-loader";
import { resolveRetryPolicy } from "@deepseek-ai/dsh-llm";
import * as LlmPiAi from "@deepseek-ai/dsh-llm-pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { googleGenerativeAIApi } from "@earendil-works/pi-ai/api/google-generative-ai.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { createProvider } from "@earendil-works/pi-ai/models";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import { describe, expect, it } from "vitest";

import { deepFreeze } from "./support/host.ts";
import {
  hasPlaneEntries,
  isRecord,
  OPENCODE_FAMILY_API,
  OPENCODE_ZEN_CATALOG,
  type PlaneProfileInput,
  type PlanePiModel,
  planeEntriesOf,
  planeProfileFor,
  withoutPlaneProviders,
} from "./support/src.ts";

const normalize = (entry: unknown): unknown =>
  (
    LlmPiAi.Config({ providers: { opencode: entry } } as never) as unknown as {
      providers: { get: () => Record<string, unknown> };
    }
  ).providers.get().opencode;

const buildProvider: PlaneProfileInput["buildProvider"] = ({
  id,
  models,
  name,
}) =>
  createProvider({
    api: {
      "anthropic-messages": anthropicMessagesApi(),
      "google-generative-ai": googleGenerativeAIApi(),
      "openai-completions": openAICompletionsApi(),
      "openai-responses": openAIResponsesApi(),
    },
    auth: {},
    id,
    models: models as never,
    name,
  } as never);

const input = (
  entry: unknown,
  extra: Partial<PlaneProfileInput> = {}
): PlaneProfileInput => ({
  buildProvider,
  catalog: OPENCODE_ZEN_CATALOG,
  endpoint: "auto",
  entry,
  familyApi: OPENCODE_FAMILY_API.zen,
  normalize,
  piModels: getBuiltinModels("opencode" as never) as unknown as PlanePiModel[],
  resolveRetryPolicy:
    resolveRetryPolicy as PlaneProfileInput["resolveRetryPolicy"],
  route: "opencode",
  ...extra,
});

/** The ids the profile's provider serves. */
const served = (result: ReturnType<typeof planeProfileFor>): string[] =>
  (result.profile.piProvider as { getModels: () => { id: string }[] })
    .getModels()
    .map((model) => model.id);

describe("plane-profile · the field mapping and pi-ai's defaults", () => {
  it("maps a minimal entry onto every field pi-ai resolves, with its defaults", () => {
    const result = planeProfileFor(
      input({
        apiKeyEnv: "OPENCODE_API_KEY",
        models: [{ id: "deepseek-v4-pro" }],
      })
    );
    const { profile } = result;
    // host-shapes' runtime key list, minus catalogError (nothing failed).
    expect(Object.keys(profile).toSorted()).toEqual([
      "apiKeyEnv",
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
    expect(profile.displayName).toBe("opencode");
    expect(profile.streamIdleTimeoutMs).toBe(300_000);
    expect(profile.retryPolicy).toEqual(resolveRetryPolicy(undefined, "t"));
    expect(profile.modelErrors.size).toBe(0);
    expect(
      (
        profile.piProvider as { getModels: () => Record<string, unknown>[] }
      ).getModels()[0]
    ).toMatchObject({
      api: "openai-completions",
      baseUrl: "https://opencode.ai/inference/openai/v1",
      id: "deepseek-v4-pro",
      provider: "opencode",
    });
    expect(result.normalized).toMatchObject({ apiKeyEnv: "OPENCODE_API_KEY" });
  });

  it("D3: no models list, or an empty one, serves the plugin's servable catalog in catalog order", () => {
    const catalogIds = OPENCODE_ZEN_CATALOG.map((spec) => spec.id);
    expect(served(planeProfileFor(input({})))).toEqual(catalogIds);
    expect(served(planeProfileFor(input({ models: [] })))).toEqual(catalogIds);
    // A catalog SDK nothing serves is left out.
    const withUnserved = planeProfileFor(
      input(
        {},
        {
          catalog: [
            ...OPENCODE_ZEN_CATALOG.slice(0, 1),
            {
              context_window: 1,
              id: "cohere-x",
              input_modalities: ["text"],
              max_output_tokens: 1,
              name: "x",
              provider_npm: "@ai-sdk/cohere",
            },
          ],
        }
      )
    );
    expect(served(withUnserved)).toEqual([OPENCODE_ZEN_CATALOG[0]?.id]);
    // modelOverrides apply to the catalog list, and configuredMaxTokens follows.
    const overridden = planeProfileFor(
      input({ modelOverrides: { "gpt-5.4": { maxTokens: 7, name: "G" } } })
    );
    expect(overridden.profile.configuredMaxTokens.get("gpt-5.4")).toBe(7);
    expect(overridden.effortNames.get("gpt-5.4")).toMatchObject({ low: "Low" });
  });

  it("D15: an id no catalog describes is served, with no model error", () => {
    const result = planeProfileFor(
      input({ models: [{ id: "not-a-real-model" }] })
    );
    expect(result.profile.modelErrors.size).toBe(0);
    expect(result.profile.catalogError).toBeUndefined();
    expect(served(result)).toEqual(["not-a-real-model"]);
  });

  it("hands the route-level api, base and compat to each model: api only for ids nobody classifies, the base shaped per protocol", () => {
    const result = planeProfileFor(
      input({
        api: "anthropic-messages",
        baseURL: "https://relay.example/v1",
        compat: { supportsStore: true },
        models: [{ id: "deepseek-v4-pro" }, { id: "unknown-x" }],
      })
    );
    expect(result.profile.catalogError).toBeUndefined();
    const models = (
      result.profile.piProvider as {
        getModels: () => {
          id: string;
          api: string;
          baseUrl: string;
          compat?: object;
        }[];
      }
    ).getModels();
    expect(
      models.map(({ api, baseUrl, id }) => ({ api, baseUrl, id }))
    ).toEqual([
      {
        api: "openai-completions",
        baseUrl: "https://relay.example/v1",
        id: "deepseek-v4-pro",
      },
      {
        api: "anthropic-messages",
        baseUrl: "https://relay.example",
        id: "unknown-x",
      },
    ]);
    expect(models[0]?.compat).toMatchObject({ supportsStore: true });
  });

  it("carries the route's own knobs and nothing else", () => {
    const { profile } = planeProfileFor(
      input({
        displayName: "Zen",
        headers: { "x-a": "1" },
        reasoning: "high",
        thinkingBudgets: { high: 9 },
      })
    );
    expect(profile).toMatchObject({
      displayName: "Zen",
      headers: { "x-a": "1" },
      reasoning: "high",
      thinkingBudgets: { high: 9 },
    });
  });
});

describe("plane-profile · the Google level ids the builder is handed (D16)", () => {
  it("names exactly the served Google ids the catalog describes by level, from the catalog, never the id", () => {
    const handed: (ReadonlySet<string> | undefined)[] = [];
    const recording: PlaneProfileInput["buildProvider"] = (build) => {
      handed.push(build.levelThinkingModels);
      return buildProvider(build);
    };
    // The catalog's Gemini models beside a non-Google one, an id no catalog
    // describes (named like a Gemini model), and one that fails. The filter is
    // "Google with any effort option", not the rule itself: a deliberate shape
    // tripwire beside the model-metadata oracle, so a Google effort list that
    // is not all levels fails here rather than being re-derived.
    const levelIds = OPENCODE_ZEN_CATALOG.filter(
      (spec) =>
        spec.provider_npm === "@ai-sdk/google" &&
        spec.reasoning_options?.some((option) => option.type === "effort")
    ).map((spec) => spec.id);
    expect(levelIds).toContain("gemini-4-argon");
    // Any other level id, picked by shape, serves as the one listed twice.
    const duplicate = levelIds.find((id) => id !== "gemini-4-argon");
    expect(duplicate, "the Zen catalog has a second level model").toBeDefined();
    const result = planeProfileFor(
      input(
        {
          models: [
            ...levelIds.map((id) => ({ id })),
            { id: "deepseek-v4-pro" },
            { id: "gemini-9-unlisted" },
            // Listed twice: a model error, so not served.
            { id: duplicate ?? "" },
          ],
        },
        { buildProvider: recording }
      )
    );
    expect(result.profile.modelErrors.get(duplicate ?? "")).toMatch(
      /more than once/u
    );
    expect(handed).toHaveLength(1);
    expect([...(handed[0] ?? [])].toSorted()).toEqual(
      levelIds.filter((id) => id !== duplicate).toSorted()
    );
    // A catalog that describes the same id by another shape names none.
    handed.length = 0;
    planeProfileFor(
      input(
        { models: [{ id: "gemini-4-argon" }] },
        {
          buildProvider: recording,
          catalog: [
            {
              id: "gemini-4-argon",
              provider_npm: "@ai-sdk/google",
              reasoning: true,
              reasoning_options: [{ type: "effort", values: ["low", "max"] }],
            },
          ],
        }
      )
    );
    expect([...(handed[0] ?? [])]).toEqual([]);
  });

  it("a Google-served id the catalog does not describe stays off the level set, whatever its name", () => {
    // A route-level `api` cannot put an uncatalogued id on Google (pi-ai's own
    // check refuses `google-generative-ai` there), so the reachable case is an
    // id pi's own model table serves on Google that the catalog lacks: with no
    // catalog spec there is nothing to read its thinking control from, so it
    // stays on pi's path, Gemini-named or not.
    expect(
      planeProfileFor(
        input({
          api: "google-generative-ai",
          models: [{ id: "gemini-9-unlisted" }],
        })
      ).profile.catalogError
    ).toMatch(/google-generative-ai/u);
    const handed: (ReadonlySet<string> | undefined)[] = [];
    const recording: PlaneProfileInput["buildProvider"] = (build) => {
      handed.push(build.levelThinkingModels);
      return buildProvider(build);
    };
    const flash = "gemini-3-flash";
    const result = planeProfileFor(
      input(
        { models: [{ id: flash }, { id: "gemini-4-argon" }] },
        {
          buildProvider: recording,
          catalog: OPENCODE_ZEN_CATALOG.filter((spec) => spec.id !== flash),
        }
      )
    );
    expect(result.profile.catalogError).toBeUndefined();
    const models = (
      result.profile.piProvider as {
        getModels: () => { id: string; api: string }[];
      }
    ).getModels();
    expect(models.map(({ api, id }) => ({ api, id }))).toEqual([
      { api: "google-generative-ai", id: flash },
      { api: "google-generative-ai", id: "gemini-4-argon" },
    ]);
    expect(handed).toHaveLength(1);
    expect([...(handed[0] ?? [])]).toEqual(["gemini-4-argon"]);
  });
});

describe("plane-profile · malformed entries, in pi-ai's words, never thrown", () => {
  it("records model failures per model and route failures as catalogError with no provider", () => {
    expect(
      planeProfileFor(input({ models: [{ id: "" }] })).profile.catalogError
    ).toBe('llm-pi-ai: provider "opencode" has a model with an empty id');
    const duplicate = planeProfileFor(
      input({ models: [{ id: "x" }, { id: "y" }, { id: "x" }] })
    );
    expect(duplicate.profile.modelErrors.get("x")).toMatch(
      /lists model "x" more than once/u
    );
    expect(served(duplicate)).toEqual(["y"]);
    const header = planeProfileFor(input({ headers: { "bad header": "v" } }));
    expect(header.profile.catalogError).toMatch(
      /header "bad header" is not valid for Fetch/u
    );
    expect(header.profile.piProvider).toBeUndefined();
    expect(
      planeProfileFor(
        input({ models: [{ id: "m", reasoningEfforts: { high: null } }] })
      ).profile.modelErrors.get("m")
    ).toMatch(/reasoningEfforts\.high needs the wire value/u);
    expect(
      planeProfileFor(input({ maxRetries: 1 })).profile.catalogError
    ).toMatch(/maxRetries or maxRetryDelayMs, which were removed/u);
    expect(
      planeProfileFor(input({ provider: "x" })).profile.catalogError
    ).toMatch(/sets "provider"/u);
  });

  it("mirrors the rest of pi-ai's route checks", () => {
    const failure = (entry: unknown, extra: Partial<PlaneProfileInput> = {}) =>
      planeProfileFor(input(entry, extra)).profile.catalogError;
    expect(failure({ baseURL: "" })).toMatch(/has an empty baseURL/u);
    expect(failure({ displayName: "" })).toMatch(/has an empty displayName/u);
    expect(
      failure({ streamIdleTimeoutMs: 2_147_483_648 }, { normalize: undefined })
    ).toMatch(
      /streamIdleTimeoutMs must be a positive finite number no greater than 2147483647/u
    );
    expect(
      failure({ maxRequestImageBytes: 1.5 }, { normalize: undefined })
    ).toMatch(/maxRequestImageBytes must be a positive integer/u);
    expect(
      failure({ requestImagePixelBudget: 0 }, { normalize: undefined })
    ).toMatch(/requestImagePixelBudget must be a positive safe integer/u);
    expect(failure({ defaultInput: [] })).toMatch(
      /defaultInput must name at least one modality/u
    );
    expect(failure({ apiKeyEnv: "not-a-ref" })).toMatch(/credential ref/u);
    expect(failure({ modelOverrides: { "": {} } })).toMatch(
      /modelOverrides entry with an empty model id/u
    );
    expect(
      failure({ models: [{ id: "x" }], modelOverrides: { "gpt-5.4": {} } })
    ).toMatch(/beside a models list/u);
    expect(
      failure(
        { modelOverrides: { "gpt-5.4": { id: "y" } } },
        { normalize: undefined }
      )
    ).toMatch(/sets "id", which is the dict key/u);
    expect(failure({ modelOverrides: { "no-such": {} } })).toMatch(
      /modelOverrides names "no-such", which the installed catalog does not describe/u
    );
    expect(
      failure({ compat: { openRouterRouting: {} } }, { normalize: undefined })
    ).toMatch(/compat "openRouterRouting", which is not configurable here/u);
    expect(
      failure({ compat: { noSuch: true } }, { normalize: undefined })
    ).toMatch(
      /which no wire protocol declares; the configurable switches are supportsStore/u
    );
    expect(
      failure({ compat: { supportsStore: null } }, { normalize: undefined })
    ).toMatch(/with no value/u);
    expect(failure({ compat: 5 }, { normalize: undefined })).toMatch(
      /compat must be a dict/u
    );
    expect(
      failure({
        compat: { supportsTemperature: true },
        models: [{ id: "deepseek-v4-pro" }],
      })
    ).toMatch(/no model on the route speaks a protocol that takes it/u);
    expect(
      planeProfileFor(
        input(
          { models: [{ compat: { noSuch: true }, id: "m" }] },
          { normalize: undefined }
        )
      ).profile.modelErrors.get("m")
    ).toMatch(/model "m" sets compat "noSuch"/u);
    expect(
      planeProfileFor(
        input(
          { models: [{ contextWindow: 0, id: "m" }] },
          { normalize: undefined }
        )
      ).profile.modelErrors.get("m")
    ).toMatch(/contextWindow must be a positive integer/u);
    expect(failure({ models: [] }, { catalog: [] })).toMatch(
      /resolves no models/u
    );
    expect(
      failure({ retryPolicy: { mode: "nope" } }, { normalize: undefined })
    ).toBeDefined();
    expect(
      planeProfileFor(
        input(
          {},
          {
            buildProvider: () => {
              throw new Error("no protocols");
            },
          }
        )
      ).profile
    ).toMatchObject({ catalogError: "no protocols" });
  });

  it("never throws, whatever the input, and always says why", () => {
    for (const entry of [
      undefined,
      null,
      1,
      "x",
      [],
      { models: "nope" },
      { models: [null] },
      { models: [{ id: 1 }] },
      { headers: 5 },
    ]) {
      for (const normalizer of [normalize, undefined]) {
        let result: ReturnType<typeof planeProfileFor> | undefined;
        expect(() => {
          result = planeProfileFor(input(entry, { normalize: normalizer }));
        }, JSON.stringify(entry)).not.toThrow();
        expect(
          result?.profile.catalogError,
          JSON.stringify(entry)
        ).toBeDefined();
        expect(result?.profile.provider).toBe("opencode");
      }
    }
    // A normalizer that answers no dict fails the route.
    expect(
      planeProfileFor(input({}, { normalize: () => 5 })).profile.catalogError
    ).toMatch(/must be a dict of settings/u);
  });
});

describe("plane-profile · !!js", () => {
  it("interpolates first; without a loader a leftover node fails only its model, or the route at route level", () => {
    const withLoader = planeProfileFor(
      input(
        { displayName: { __jsExpr: '"Z"' } },
        { interpolate: (value) => interpolate(new Context(), value) }
      )
    );
    expect(withLoader.profile.displayName).toBe("Z");
    expect(
      planeProfileFor(
        input(
          {},
          {
            interpolate: () => {
              // oxlint-disable-next-line no-throw-literal, typescript/only-throw-error -- a loader may throw anything.
              throw "evaluation failed";
            },
          }
        )
      ).profile.catalogError
    ).toBe("evaluation failed");
    expect(withLoader.profile.catalogError).toBeUndefined();
    const leftover = planeProfileFor(
      input({
        models: [
          { id: "m", name: { __jsExpr: '"N"' } },
          { id: "deepseek-v4-pro" },
        ],
      })
    );
    expect([...leftover.profile.modelErrors.keys()]).toEqual(["m"]);
    expect(served(leftover)).toEqual(["deepseek-v4-pro"]);
    expect(
      planeProfileFor(input({ displayName: { __jsExpr: '"Z"' } })).profile
        .piProvider
    ).toBeUndefined();
    expect(
      planeProfileFor(
        input({ models: [[{ __jsExpr: "1" }]] })
      ).profile.modelErrors.has("")
    ).toBe(true);
  });
});

describe("plane-profile · withoutPlaneProviders and the plane readers", () => {
  it("copies, never touches a frozen input, and keeps every other key", () => {
    const raw = deepFreeze({
      other: true,
      providers: { deepseek: { a: 1 }, opencode: {}, "opencode-go": {} },
    });
    let copy: unknown;
    expect(() => {
      copy = withoutPlaneProviders(raw);
    }).not.toThrow();
    expect(copy).toEqual({ other: true, providers: { deepseek: { a: 1 } } });
    expect(copy).not.toBe(raw);
    expect(isRecord(copy) && copy.providers).not.toBe(raw.providers);
    expect(withoutPlaneProviders({ a: 1 })).toEqual({ a: 1 });
    expect(withoutPlaneProviders(5)).toBe(5);
    expect(hasPlaneEntries(raw)).toBe(true);
    expect(hasPlaneEntries({ providers: { deepseek: {} } })).toBe(false);
    expect(hasPlaneEntries(null)).toBe(false);
    expect(planeEntriesOf(raw)).toEqual({ opencode: {}, "opencode-go": {} });
    expect(planeEntriesOf({ providers: { opencode: 1 } })).toEqual({
      opencode: 1,
    });
    expect(planeEntriesOf(null)).toEqual({});
  });
});
