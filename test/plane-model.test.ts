/**
 * `planeModelFor`: one row per field × a known or gap model × the `modern` or
 * `legacy` family × a vendor or foreign route base (`src/utils/plane-model.ts`).
 *
 * The specs are the bundled catalog's and the pi entries pi 1.1.0's own, so a
 * row here is the model the plane adapter actually serves.
 *
 * @module test/plane-model.test
 */
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import { describe, expect, it } from "vitest";

import {
  baseUrlFor,
  type CatalogModelSpec,
  OPENCODE_FAMILY_API,
  OPENCODE_GO_CATALOG,
  OPENCODE_ZEN_CATALOG,
  type PlaneModelInput,
  type PlanePiModel,
  planeModelFor,
  PROTOCOLS,
} from "./support/src.ts";

type Plane = "opencode" | "opencode-go";

const specOf = (plane: Plane, id: string): CatalogModelSpec | undefined =>
  (plane === "opencode" ? OPENCODE_ZEN_CATALOG : OPENCODE_GO_CATALOG).find(
    (model) => model.id === id
  );

const piOf = (plane: Plane, id: string): PlanePiModel | undefined =>
  (getBuiltinModels(plane as never) as unknown as PlanePiModel[]).find(
    (model) => model.id === id
  );

const DEFAULTS = { contextWindow: 262_144, input: ["text"], maxTokens: 32_768 };

/** The input a plane builds for one declared id, with overrides. */
const inputFor = (
  plane: Plane,
  id: string,
  extra: Partial<PlaneModelInput> = {}
): PlaneModelInput => {
  const spec = specOf(plane, id);
  const pi = piOf(plane, id);
  return {
    defaults: DEFAULTS,
    endpoint: "modern",
    entry: { id },
    familyApi:
      plane === "opencode" ? OPENCODE_FAMILY_API.zen : OPENCODE_FAMILY_API.go,
    route: plane,
    ...(spec === undefined ? {} : { spec }),
    ...(pi === undefined ? {} : { pi }),
    ...extra,
  };
};

const modelOf = (input: PlaneModelInput) => {
  const result = planeModelFor(input);
  if (result.model === undefined) {
    throw new Error(`no model: ${result.error}`);
  }
  return result.model;
};

describe("plane-model · protocol (D16)", () => {
  it("comes from the catalog SDK, then pi's entry, then the route's api for an id nobody classifies, then completions", () => {
    expect(modelOf(inputFor("opencode", "gpt-5.4")).api).toBe(
      "openai-responses"
    );
    expect(modelOf(inputFor("opencode", "deepseek-v4-pro")).api).toBe(
      "openai-completions"
    );
    expect(modelOf(inputFor("opencode", "mistral-large-4")).api).toBe(
      "openai-completions"
    );
    const gemini = inputFor("opencode-go", "gemini-4-argon");
    expect(gemini.pi).toBeUndefined();
    expect(modelOf(gemini).api).toBe("google-generative-ai");
    expect(modelOf(inputFor("opencode", "not-a-real-model")).api).toBe(
      "openai-completions"
    );
    expect(
      modelOf(
        inputFor("opencode", "not-a-real-model", {
          routeApi: "anthropic-messages",
        })
      ).api
    ).toBe("anthropic-messages");
    // A route-level api never reclassifies an id the catalog describes.
    expect(
      modelOf(
        inputFor("opencode", "gpt-5.4", { routeApi: "anthropic-messages" })
      ).api
    ).toBe("openai-responses");
    // No spec, a pi entry: pi's protocol.
    expect(
      modelOf({
        ...inputFor("opencode", "x"),
        pi: { api: "anthropic-messages", id: "x" },
      }).api
    ).toBe("anthropic-messages");
    // A pi protocol the plane does not dispatch is not taken.
    expect(
      modelOf({
        ...inputFor("opencode", "x"),
        pi: { api: "mistral-conversations", id: "x" },
      }).api
    ).toBe("openai-completions");
    // A spec whose SDK nothing maps falls through to pi.
    expect(
      modelOf({
        ...inputFor("opencode", "x"),
        pi: { api: "openai-responses", id: "x" },
        spec: {
          context_window: 1,
          id: "x",
          input_modalities: ["text"],
          max_output_tokens: 1,
          name: "x",
          provider_npm: "@ai-sdk/cohere",
        },
      }).api
    ).toBe("openai-responses");
  });
});

describe("plane-model · base (modern, legacy, route-level)", () => {
  const modern = {
    opencode: {
      "anthropic-messages": "https://opencode.ai/inference/anthropic",
      "google-generative-ai": "https://opencode.ai/inference/google/v1beta",
      "openai-completions": "https://opencode.ai/inference/openai/v1",
      "openai-responses": "https://opencode.ai/inference/openai/v1",
    },
    "opencode-go": {
      "anthropic-messages": "https://opencode.ai/inference/go/anthropic",
      "google-generative-ai": "https://opencode.ai/inference/go/google/v1beta",
      "openai-completions": "https://opencode.ai/inference/go/openai/v1",
      "openai-responses": "https://opencode.ai/inference/go/openai/v1",
    },
  } as const;

  it("modern: the per-protocol inference family, Anthropic without /v1, and auto is modern in every cell", () => {
    for (const plane of ["opencode", "opencode-go"] as const) {
      const family =
        plane === "opencode" ? OPENCODE_FAMILY_API.zen : OPENCODE_FAMILY_API.go;
      for (const protocol of PROTOCOLS) {
        const modernBase = baseUrlFor(
          plane,
          protocol,
          undefined,
          "modern",
          family
        );
        expect(modernBase, `${plane} ${protocol}`).toBe(
          modern[plane][protocol]
        );
        expect(baseUrlFor(plane, protocol, undefined, "auto", family)).toBe(
          modernBase
        );
        // A family map that names nothing falls back to the measured table.
        expect(baseUrlFor(plane, protocol, undefined, "modern", {})).toBe(
          modernBase
        );
      }
    }
    // The model's own SDK key wins, as the catalog files it.
    expect(
      baseUrlFor(
        "opencode",
        "openai-completions",
        "@ai-sdk/mistral",
        "modern",
        {
          "": "https://a.example/v1",
          "@ai-sdk/mistral": "https://m.example/v1",
        }
      )
    ).toBe("https://m.example/v1");
  });

  it("legacy: pi's own /zen base when pi files the model under the protocol, else the fixed table, Go's Google on its one base", () => {
    const legacy = { endpoint: "legacy" as const };
    expect(piOf("opencode", "claude-haiku-5-5")).toMatchObject({
      api: "anthropic-messages",
      baseUrl: "https://opencode.ai/zen",
    });
    expect(
      modelOf(inputFor("opencode", "claude-haiku-5-5", legacy)).baseUrl
    ).toBe("https://opencode.ai/zen");
    expect(
      modelOf(inputFor("opencode", "deepseek-v4-pro", legacy)).baseUrl
    ).toBe("https://opencode.ai/zen/v1");
    expect(piOf("opencode", "gpt-5.3-codex-spark")).toBeUndefined();
    expect(
      modelOf(inputFor("opencode", "gpt-5.3-codex-spark", legacy)).baseUrl
    ).toBe("https://opencode.ai/zen/v1");
    expect(
      modelOf(inputFor("opencode-go", "gemini-4-argon", legacy)).baseUrl
    ).toBe("https://opencode.ai/inference/go/google/v1beta");
    expect(
      modelOf(inputFor("opencode-go", "minimax-m3.1-flash", legacy)).baseUrl
    ).toBe("https://opencode.ai/zen/go/v1");
    expect(
      modelOf({
        ...inputFor("opencode-go", "gap-claude", legacy),
        routeApi: "anthropic-messages",
      }).baseUrl
    ).toBe("https://opencode.ai/zen/go");
    // pi on a modern base, or under another protocol, is not taken.
    expect(
      baseUrlFor(
        "opencode",
        "openai-completions",
        undefined,
        "legacy",
        {},
        undefined,
        {
          api: "openai-completions",
          baseUrl: "https://opencode.ai/inference/openai/v1",
          id: "x",
        }
      )
    ).toBe("https://opencode.ai/zen/v1");
    expect(
      baseUrlFor(
        "opencode",
        "openai-responses",
        undefined,
        "legacy",
        {},
        undefined,
        {
          api: "openai-completions",
          baseUrl: "https://opencode.ai/zen/beta/v1",
          id: "x",
        }
      )
    ).toBe("https://opencode.ai/zen/v1");
    // Taken: pi files the model under the same protocol on a /zen root that
    // is NOT the fixed table's, and that root is what is answered — the one
    // case where pi's own base and the table disagree.
    expect(
      baseUrlFor(
        "opencode",
        "openai-completions",
        undefined,
        "legacy",
        {},
        undefined,
        {
          api: "openai-completions",
          baseUrl: "https://opencode.ai/zen/beta/v1",
          id: "x",
        }
      )
    ).toBe("https://opencode.ai/zen/beta/v1");
  });

  it("a route-level base: a vendor root selects its family, a foreign root is used as written (Anthropic without /v1)", () => {
    const family = OPENCODE_FAMILY_API.zen;
    for (const protocol of PROTOCOLS) {
      expect(
        baseUrlFor(
          "opencode",
          protocol,
          undefined,
          "modern",
          family,
          "https://opencode.ai/zen/v1"
        )
      ).toBe(
        {
          "anthropic-messages": "https://opencode.ai/zen",
          "google-generative-ai": "https://opencode.ai/zen/v1",
          "openai-completions": "https://opencode.ai/zen/v1",
          "openai-responses": "https://opencode.ai/zen/v1",
        }[protocol]
      );
      expect(
        baseUrlFor(
          "opencode",
          protocol,
          undefined,
          "legacy",
          family,
          "https://opencode.ai/inference/v1"
        )
      ).toBe(modern.opencode[protocol]);
      expect(
        baseUrlFor(
          "opencode",
          protocol,
          undefined,
          "modern",
          family,
          "https://relay.example/llm"
        )
      ).toBe("https://relay.example/llm");
    }
    expect(
      baseUrlFor(
        "opencode",
        "openai-completions",
        undefined,
        "modern",
        family,
        "https://relay.example/v1/"
      )
    ).toBe("https://relay.example/v1");
    expect(
      baseUrlFor(
        "opencode",
        "anthropic-messages",
        undefined,
        "modern",
        family,
        "https://relay.example/v1/"
      )
    ).toBe("https://relay.example");
    // Another opencode.ai path is a foreign root; a malformed one is too.
    expect(
      baseUrlFor(
        "opencode",
        "openai-completions",
        undefined,
        "modern",
        family,
        "https://opencode.ai/custom"
      )
    ).toBe("https://opencode.ai/custom");
    expect(
      baseUrlFor(
        "opencode",
        "openai-completions",
        undefined,
        "modern",
        family,
        "not a url"
      )
    ).toBe("not a url");
    // An empty route base states nothing.
    expect(
      baseUrlFor(
        "opencode",
        "openai-completions",
        undefined,
        "legacy",
        family,
        ""
      )
    ).toBe("https://opencode.ai/zen/v1");
  });
});

describe("plane-model · metadata (D17) and the model object", () => {
  it("takes the user's row, then the override, then the catalog, then pi, then the defaults", () => {
    const spark = modelOf(
      inputFor("opencode", "gpt-5.3-codex-spark", {
        entry: {
          contextWindow: 400_000,
          id: "gpt-5.3-codex-spark",
          name: "My Spark",
        },
      })
    );
    expect(spark.contextWindow).toBe(400_000);
    expect(spark.name).toBe("My Spark");
    const overridden = planeModelFor(
      inputFor("opencode", "gpt-5.3-codex-spark", {
        override: { contextWindow: 300_000, maxTokens: 9 },
      })
    );
    expect(overridden.model?.contextWindow).toBe(300_000);
    expect(overridden.configuredMaxTokens).toBe(9);
    const catalog = planeModelFor(inputFor("opencode", "gpt-5.3-codex-spark"));
    expect(catalog.model?.contextWindow).toBe(128_000);
    expect(catalog.configuredMaxTokens).toBeUndefined();
    expect(catalog.model?.cost).toEqual({
      cacheRead: 0.175,
      cacheWrite: 0,
      input: 1.75,
      output: 14,
    });
    const fromPi = modelOf({
      ...inputFor("opencode", "x"),
      pi: {
        contextWindow: 77,
        cost: { cacheRead: 1, cacheWrite: 1, input: 1, output: 1 },
        id: "x",
        input: ["text", "image"],
        maxTokens: 7,
        name: "Pi X",
      },
    });
    expect(fromPi).toMatchObject({
      contextWindow: 77,
      cost: { input: 1 },
      input: ["text", "image"],
      maxTokens: 7,
      name: "Pi X",
    });
    const bare = modelOf(inputFor("opencode", "x"));
    expect(bare).toMatchObject({
      contextWindow: 262_144,
      cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
      input: ["text"],
      maxTokens: 32_768,
      name: "x",
      provider: "opencode",
      reasoning: false,
    });
    expect(bare).not.toHaveProperty("thinkingLevelMap");
    const rowed = planeModelFor(
      inputFor("opencode", "deepseek-v4-pro", {
        entry: { id: "deepseek-v4-pro", input: ["image"], maxTokens: 5 },
      })
    );
    expect(rowed.configuredMaxTokens).toBe(5);
    expect(rowed.model?.input).toEqual(["image"]);
    // An empty modality list states nothing; the catalog's applies.
    expect(
      modelOf(
        inputFor("opencode", "gpt-5.4", { entry: { id: "gpt-5.4", input: [] } })
      ).input
    ).toEqual(["text", "image"]);
    expect(
      modelOf(inputFor("opencode", "x", { override: { input: ["image"] } }))
        .input
    ).toEqual(["image"]);
    expect(
      modelOf(
        inputFor("opencode", "x", {
          spec: {
            context_window: 1,
            id: "x",
            input_modalities: ["audio"],
            max_output_tokens: 1,
            name: "x",
          },
        })
      ).input
    ).toEqual(["text"]);
    expect(
      modelOf(inputFor("opencode", "x", { override: { name: "Ov" } })).name
    ).toBe("Ov");
    // A name that is not a string is no name; a cost the catalog leaves out is zero.
    const unnamed = modelOf(
      inputFor("opencode", "x", {
        entry: { id: "x", name: 5 },
        spec: {
          context_window: 1,
          cost: {},
          id: "x",
          input_modalities: ["text"],
          max_output_tokens: 1,
          name: "",
        },
      })
    );
    expect(unnamed.name).toBe("");
    expect(unnamed.cost).toEqual({
      cacheRead: 0,
      cacheWrite: 0,
      input: 0,
      output: 0,
    });
  });

  it("reasoning: the user's dict, the override's, the catalog's (with D1 names), pi's, else none", () => {
    const user = modelOf(
      inputFor("opencode", "gpt-5.4", {
        entry: { id: "gpt-5.4", reasoningEfforts: { high: "hi" } },
      })
    );
    expect(user.thinkingLevelMap).toMatchObject({ high: "hi", low: null });
    // A value in the dict that is neither a wire string nor null is no value.
    expect(
      modelOf(
        inputFor("opencode", "gpt-5.4", {
          entry: { id: "gpt-5.4", reasoningEfforts: { high: "hi", low: 5 } },
        })
      ).thinkingLevelMap
    ).toEqual(user.thinkingLevelMap);
    expect(
      modelOf(
        inputFor("opencode", "gpt-5.4", {
          entry: { id: "gpt-5.4", reasoningEfforts: false },
        })
      ).reasoning
    ).toBe(false);
    expect(
      modelOf(
        inputFor("opencode", "gpt-5.4", {
          override: { reasoningEfforts: { low: "l" } },
        })
      ).thinkingLevelMap
    ).toMatchObject({ low: "l" });
    expect(
      planeModelFor(
        inputFor("opencode", "gpt-5.4", {
          entry: { id: "gpt-5.4", reasoningEfforts: "bad" },
        })
      ).error
    ).toMatch(/has an empty reasoningEfforts/u);
    const toggle = planeModelFor(inputFor("opencode-go", "minimax-m3"));
    expect(toggle.effortNames).toEqual({ high: "On", off: "Off" });
    expect(toggle.model?.thinkingLevelMap).not.toHaveProperty("off");
    // A completions model whose effort list names none serves the map pi
    // 1.1.0's own entry carries: Off offered, with none as its wire value.
    for (const [plane, id] of [
      ["opencode", "mistral-large-4"],
      ["opencode-go", "hy3"],
      ["opencode-go", "hy4-preview"],
    ] as const) {
      const pi = piOf(plane, id);
      expect(pi?.thinkingLevelMap?.off, `${plane}/${id}`).toBe("none");
      expect(
        modelOf(inputFor(plane, id)).thinkingLevelMap,
        `${plane}/${id}`
      ).toEqual(pi?.thinkingLevelMap);
    }
    const fromPi = modelOf({
      ...inputFor("opencode", "x"),
      pi: { id: "x", reasoning: true, thinkingLevelMap: { high: "h" } },
    });
    expect(fromPi).toMatchObject({
      reasoning: true,
      thinkingLevelMap: { high: "h" },
    });
  });

  it("compat: pi's block only when pi files the model under the same protocol; route switches the protocol takes; a model switch it does not take is pi-ai's error", () => {
    const piCompat = { thinkingFormat: "deepseek" };
    const pi = { api: "openai-completions", compat: piCompat, id: "x" };
    expect(modelOf({ ...inputFor("opencode", "x"), pi }).compat).toEqual(
      piCompat
    );
    expect(
      modelOf({
        ...inputFor("opencode", "x"),
        pi,
        spec: {
          context_window: 1,
          id: "x",
          input_modalities: ["text"],
          max_output_tokens: 1,
          name: "x",
          provider_npm: "@ai-sdk/openai",
        },
      })
    ).not.toHaveProperty("compat");
    expect(
      modelOf({
        ...inputFor("opencode", "x"),
        pi,
        routeCompat: {
          chatTemplateArgs: {},
          supportsStore: true,
          supportsTemperature: true,
        },
      }).compat
    ).toEqual({ ...piCompat, supportsStore: true });
    expect(
      modelOf(
        inputFor("opencode", "gpt-5.4", {
          entry: { compat: { supportsStrictMode: true }, id: "gpt-5.4" },
        })
      ).compat
    ).toEqual({
      ...piOf("opencode", "gpt-5.4")?.compat,
      supportsStrictMode: true,
    });
    expect(
      planeModelFor(
        inputFor("opencode", "gpt-5.4", {
          entry: { compat: { thinkingFormat: "deepseek" }, id: "gpt-5.4" },
        })
      ).error
    ).toBe(
      'llm-pi-ai: provider "opencode" model "gpt-5.4" sets compat "thinkingFormat", but its api is "openai-responses", which does not take it; that switch exists on openai-completions, and "openai-responses" offers supportsDeveloperRole, supportsMaxOutputTokens, supportsStrictMode, supportsLongCacheRetention'
    );
    expect(
      planeModelFor(
        inputFor("opencode", "gemini-3-flash", {
          entry: { compat: { supportsStore: true }, id: "gemini-3-flash" },
        })
      ).error
    ).toMatch(/offers no configurable compat$/u);
  });

  it("validates sizes in pi-ai's words, names the route on the model, and never throws on garbage", () => {
    expect(modelOf(inputFor("opencode", "deepseek-v4-pro")).provider).toBe(
      "opencode"
    );
    expect(
      planeModelFor(
        inputFor("opencode", "x", { entry: { contextWindow: 0, id: "x" } })
      ).error
    ).toBe(
      'llm-pi-ai: provider "opencode" model "x" contextWindow must be a positive integer'
    );
    expect(
      planeModelFor(
        inputFor("opencode", "x", { entry: { id: "x", maxTokens: 1.5 } })
      ).error
    ).toMatch(/maxTokens must be a positive integer/u);
    let result: ReturnType<typeof planeModelFor> | undefined;
    expect(() => {
      result = planeModelFor({
        ...inputFor("opencode", "x"),
        entry: { id: 5 },
      });
    }).not.toThrow();
    expect(result?.error).toMatch(/id is not a string/u);
    expect(result?.model).toBeUndefined();
  });
});
