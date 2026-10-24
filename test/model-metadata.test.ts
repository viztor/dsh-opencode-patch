/**
 * One model's reasoning levels, in pi's map, a profile's dict and the picker's
 * efforts at once (`src/utils/model-metadata.ts`, D1).
 *
 * The rule the picker shows and the rule dispatch validates must be one rule,
 * so the decisive case runs pi's OWN `getSupportedThinkingLevels` over the map
 * for every bundled catalog model and compares it with the efforts offered.
 *
 * @module test/model-metadata.test
 */
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";

import {
  canDisableReasoning,
  type CatalogModelSpec,
  effortName,
  OPENCODE_GO_CATALOG,
  OPENCODE_ZEN_CATALOG,
  PI_LEVELS,
  piReasoningFromEfforts,
  protocolForSdk,
  reasoningFor,
} from "./support/src.ts";

const zen = (id: string): CatalogModelSpec => {
  const spec = OPENCODE_ZEN_CATALOG.find((model) => model.id === id);
  if (spec === undefined) {
    throw new Error(`no Zen spec ${id}`);
  }
  return spec;
};

const go = (id: string): CatalogModelSpec => {
  const spec = OPENCODE_GO_CATALOG.find((model) => model.id === id);
  if (spec === undefined) {
    throw new Error(`no Go spec ${id}`);
  }
  return spec;
};

const ids = (reasoning: ReturnType<typeof reasoningFor>): string[] =>
  reasoning?.efforts.map((effort) => effort.id) ?? [];

describe("model-metadata · reasoningFor (D1)", () => {
  it("offers a toggle-only model Off/On where its protocol can disable reasoning, in both vocabularies", () => {
    expect(go("minimax-m3").reasoning_options).toEqual([{ type: "toggle" }]);
    const reasoning = reasoningFor(go("minimax-m3"), "anthropic-messages");
    expect(reasoning?.efforts).toEqual([
      { id: "off", name: "Off" },
      { id: "high", name: "On" },
    ]);
    expect(reasoning?.thinkingLevelMap).toEqual({
      high: "high",
      low: null,
      max: null,
      medium: null,
      minimal: null,
      xhigh: null,
    });
    expect("off" in (reasoning?.thinkingLevelMap ?? {})).toBe(false);
    expect(reasoning?.reasoningEfforts).toEqual({ high: "high", off: null });
    expect(reasoning?.effortNames).toEqual({ high: "On", off: "Off" });
  });

  it("offers On alone on completions with no disabling dialect, and Off/On with one", () => {
    const plain = reasoningFor(zen("minimax-m3"), "openai-completions");
    expect(plain?.efforts).toEqual([{ id: "high", name: "On" }]);
    expect(plain?.thinkingLevelMap.off).toBeNull();
    expect(plain?.reasoningEfforts).toEqual({ high: "high" });
    const deepseek = reasoningFor(zen("minimax-m3"), "openai-completions", {
      thinkingFormat: "deepseek",
    });
    expect(ids(deepseek)).toEqual(["off", "high"]);
  });

  it("offers an effort list exactly, never Off for none/off, and low/medium/high for a bare reasoning flag", () => {
    const gpt = reasoningFor(zen("gpt-5.4"), "openai-responses");
    expect(zen("gpt-5.4").reasoning_options?.[0]?.values).toContain("none");
    expect(ids(gpt)).toEqual(["low", "medium", "high", "xhigh"]);
    expect(gpt?.thinkingLevelMap.off).toBeNull();
    expect(gpt?.efforts[0]?.name).toBe("Low");
    expect(
      ids(reasoningFor(zen("deepseek-v4-pro"), "openai-completions"))
    ).toEqual(["high", "max"]);
    expect(
      ids(reasoningFor(zen("minimax-m2.5"), "openai-completions"))
    ).toEqual(["low", "medium", "high"]);
    expect(
      reasoningFor({ reasoning: false }, "openai-completions")
    ).toBeUndefined();
    expect(reasoningFor({}, "openai-completions")).toBeUndefined();
    // An effort option with no values is no list.
    expect(
      ids(
        reasoningFor(
          {
            reasoning: true,
            reasoning_options: [{ type: "effort" }, { type: "toggle" }],
          },
          "openai-responses"
        )
      )
    ).toEqual(["off", "high"]);
    // An effort list naming no pi level falls through to the default.
    expect(
      ids(
        reasoningFor(
          {
            reasoning: true,
            reasoning_options: [{ type: "effort", values: ["none"] }],
          },
          "openai-responses"
        )
      )
    ).toEqual(["low", "medium", "high"]);
  });

  it("is one rule for picker and dispatch: pi's own getSupportedThinkingLevels over the map equals the efforts, for every bundled catalog model on both planes", () => {
    let compared = 0;
    for (const catalog of [OPENCODE_ZEN_CATALOG, OPENCODE_GO_CATALOG]) {
      for (const spec of catalog) {
        const protocol = protocolForSdk(spec.provider_npm);
        expect(protocol, spec.id).toBeDefined();
        const reasoning = reasoningFor(spec, protocol ?? "openai-completions");
        if (reasoning === undefined) {
          continue;
        }
        expect(
          getSupportedThinkingLevels({
            reasoning: true,
            thinkingLevelMap: reasoning.thinkingLevelMap,
          } as never),
          spec.id
        ).toEqual(ids(reasoning));
        compared += 1;
      }
    }
    expect(compared).toBeGreaterThan(50);
  });
});

describe("model-metadata · canDisableReasoning and effortName", () => {
  it("answers per protocol, completions only in the disabling dialects", () => {
    expect(canDisableReasoning("anthropic-messages")).toBe(true);
    expect(canDisableReasoning("openai-responses")).toBe(true);
    expect(canDisableReasoning("google-generative-ai")).toBe(true);
    expect(canDisableReasoning("openai-completions")).toBe(false);
    for (const format of [
      "deepseek",
      "openrouter",
      "string-thinking",
      "together",
    ]) {
      expect(
        canDisableReasoning("openai-completions", { thinkingFormat: format })
      ).toBe(true);
    }
    expect(
      canDisableReasoning("openai-completions", { thinkingFormat: "qwen" })
    ).toBe(false);
    expect(
      canDisableReasoning("openai-completions", { thinkingFormat: 1 })
    ).toBe(false);
    expect(PI_LEVELS.map(effortName)).toEqual([
      "Off",
      "Minimal",
      "Low",
      "Medium",
      "High",
      "Xhigh",
      "Max",
    ]);
  });
});

describe("model-metadata · piReasoningFromEfforts (pi-ai's resolveModelReasoning)", () => {
  it("translates a dict with every level decided, and refuses what pi-ai refuses in its words", () => {
    expect(piReasoningFromEfforts("m", "opencode", false)).toEqual({
      reasoning: false,
    });
    expect(
      piReasoningFromEfforts("m", "opencode", { high: "hi", off: null })
    ).toEqual({
      reasoning: true,
      thinkingLevelMap: {
        high: "hi",
        low: null,
        max: null,
        medium: null,
        minimal: null,
        xhigh: null,
      },
    });
    expect(
      piReasoningFromEfforts("m", "opencode", { high: "hi", off: "none" })
    ).toMatchObject({ thinkingLevelMap: { off: "none" } });
    const error = (dict: Record<string, string | null> | null): string =>
      (piReasoningFromEfforts("m", "opencode", dict) as { error: string })
        .error;
    expect(error({ low: null })).toMatch(
      /reasoningEfforts\.low needs the wire value/u
    );
    expect(error({})).toMatch(/has an empty reasoningEfforts/u);
    expect(error(null)).toMatch(/has an empty reasoningEfforts/u);
    expect(error({ low: "" })).toMatch(
      /reasoningEfforts\.low must not be an empty string/u
    );
    expect(error({ off: null })).toMatch(/offers no level beyond "off"/u);
    expect(error({ low: null })).toMatch(
      /^llm-pi-ai: provider "opencode" model "m" /u
    );
  });
});
