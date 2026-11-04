/**
 * `planeModelFor`: one row per field × a known or gap model × the `modern` or
 * `legacy` family × a vendor or foreign route base (`src/utils/plane-model.ts`).
 *
 * The specs are the bundled catalog's and the pi entries the installed pi's
 * own, so a row here is the model the plane adapter actually serves; pi's
 * entry fills only metadata, never a protocol or a base (D26).
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

/**
 * The route's defaults as pi-ai's `Config` fills them. Stand-in values, on
 * purpose not either channel's: the plugin restates none of pi-ai's defaults
 * (D17), it reads back whatever the channel's `Config` filled in.
 */
const DEFAULTS = { contextWindow: 123_456, input: ["text"], maxTokens: 6_543 };

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
  it("comes from the catalog SDK, then the route's api, then completions, never from pi's entry", () => {
    expect(modelOf(inputFor("opencode", "gpt-5.4")).api).toBe(
      "openai-responses"
    );
    expect(modelOf(inputFor("opencode", "deepseek-v4-pro")).api).toBe(
      "openai-completions"
    );
    expect(modelOf(inputFor("opencode", "mistral-large-4")).api).toBe(
      "openai-completions"
    );
    expect(modelOf(inputFor("opencode-go", "gemini-4-argon")).api).toBe(
      "google-generative-ai"
    );
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
    // No spec, a pi entry: pi's protocol is not taken (D26); completions,
    // or the route's api when it names one.
    const piOnly = {
      ...inputFor("opencode", "x"),
      pi: { api: "anthropic-messages", id: "x" },
    };
    expect(modelOf(piOnly).api).toBe("openai-completions");
    expect(modelOf({ ...piOnly, routeApi: "openai-responses" }).api).toBe(
      "openai-responses"
    );
    // A route api the plane does not dispatch is not taken.
    expect(
      modelOf({
        ...inputFor("opencode", "x"),
        routeApi: "mistral-conversations",
      }).api
    ).toBe("openai-completions");
    // A spec whose SDK nothing maps falls through to the route's api, then
    // completions — never to pi's entry.
    const unmapped = {
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
    };
    expect(modelOf(unmapped).api).toBe("openai-completions");
    expect(modelOf({ ...unmapped, routeApi: "anthropic-messages" }).api).toBe(
      "anthropic-messages"
    );
  });

  it("a changed pi catalog entry moves neither a model's protocol nor its base, on either family (D26)", () => {
    // pi 1.5.0 moved its catalog bases to per-protocol roots and refiled
    // models; nothing the plugin routes may follow. Each declared model is
    // built twice, once with pi's own entry and once with that entry
    // reshaped (another protocol, another base), and must not move.
    const reshaped = (pi: PlanePiModel | undefined, id: string) => ({
      ...pi,
      api:
        pi?.api === "anthropic-messages"
          ? "openai-responses"
          : "anthropic-messages",
      baseUrl: "https://opencode.ai/somewhere/else/v1",
      id,
    });
    let compared = 0;
    for (const plane of ["opencode", "opencode-go"] as const) {
      const catalog =
        plane === "opencode" ? OPENCODE_ZEN_CATALOG : OPENCODE_GO_CATALOG;
      for (const spec of catalog) {
        for (const endpoint of ["modern", "legacy"] as const) {
          const own = planeModelFor(inputFor(plane, spec.id, { endpoint }));
          const moved = planeModelFor({
            ...inputFor(plane, spec.id, { endpoint }),
            pi: reshaped(piOf(plane, spec.id), spec.id),
          });
          expect(moved.model?.api, `${plane}/${spec.id} ${endpoint}`).toBe(
            own.model?.api
          );
          expect(moved.model?.baseUrl, `${plane}/${spec.id} ${endpoint}`).toBe(
            own.model?.baseUrl
          );
          compared += 1;
        }
      }
    }
    // The walk is real: every catalog model on both planes, both families.
    expect(compared).toBe(
      2 * (OPENCODE_ZEN_CATALOG.length + OPENCODE_GO_CATALOG.length)
    );
    // And the reshaped entry really differs from what was served.
    const served = modelOf(inputFor("opencode", "deepseek-v4-pro"));
    expect(reshaped(piOf("opencode", "deepseek-v4-pro"), "x").baseUrl).not.toBe(
      served.baseUrl
    );
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

  it("legacy: the fixed table, whatever pi's own entry says, Go's Google on its one base", () => {
    const legacy = { endpoint: "legacy" as const };
    expect(
      modelOf(inputFor("opencode", "claude-haiku-5-5", legacy)).baseUrl
    ).toBe("https://opencode.ai/zen");
    expect(
      modelOf(inputFor("opencode", "deepseek-v4-pro", legacy)).baseUrl
    ).toBe("https://opencode.ai/zen/v1");
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
    // A pi entry on a /zen root of its own, under the same protocol, is not
    // taken either: the table is the only base source (D26).
    expect(
      modelOf({
        ...inputFor("opencode", "x", legacy),
        pi: {
          api: "openai-completions",
          baseUrl: "https://opencode.ai/zen/beta/v1",
          id: "x",
        },
      }).baseUrl
    ).toBe("https://opencode.ai/zen/v1");
    expect(
      baseUrlFor("opencode", "openai-responses", undefined, "legacy", {})
    ).toBe("https://opencode.ai/zen/v1");
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
      contextWindow: DEFAULTS.contextWindow,
      cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
      input: ["text"],
      maxTokens: DEFAULTS.maxTokens,
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

  it("restates none of pi-ai's defaults: a model no source sizes takes the route's filled defaults, and is an error where none was filled (D17)", () => {
    const unsized = {
      ...inputFor("opencode", "x"),
      defaults: { input: ["text"] },
    };
    expect(planeModelFor(unsized).error).toBe(
      'llm-pi-ai: provider "opencode" model "x" contextWindow must be a positive integer'
    );
    expect(
      planeModelFor({
        ...unsized,
        defaults: { contextWindow: 5, input: ["text"] },
      }).error
    ).toBe(
      'llm-pi-ai: provider "opencode" model "x" maxTokens must be a positive integer'
    );
    // A model the catalog sizes needs no default at all.
    expect(
      planeModelFor({
        ...inputFor("opencode", "gpt-5.4"),
        defaults: { input: ["text"] },
      }).model?.contextWindow
    ).toBe(
      OPENCODE_ZEN_CATALOG.find((spec) => spec.id === "gpt-5.4")?.context_window
    );
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
