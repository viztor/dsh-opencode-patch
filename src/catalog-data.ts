/**
 * Static OpenCode Go & Zen model catalog data.
 *
 * Pure data, no behavior: the canonical per-model specifications the patch
 * ships as its offline shim, plus the provider-scoped retirement list. Split
 * out of `models-catalog.ts` so the parsing, SWR revalidation and gateway
 * enrichment logic reads without wading through several hundred lines of
 * literals.
 *
 * Prices are USD per million tokens. `models.dev` remains the live source of
 * truth; this shim is what the meter and picker use before the first
 * successful revalidation (and if it never succeeds).
 *
 * @module dsh-opencode-patch/catalog-data
 */

import type { ModelCostRate } from "./session-cost.ts";

export interface CatalogModelSpec {
  context_window: number;
  cost?: ModelCostRate;
  id: string;
  input_modalities: string[];
  is_free?: boolean;
  max_output_tokens: number;
  name: string;
}

/**
 * Model IDs no longer offered by OpenCode CLI for a given provider.
 *
 * Retirement is provider-scoped because OpenCode itself is provider-scoped:
 * `opencode models opencode` omits both Muse Spark 1.2 variants, while
 * `opencode models opencode-go` still offers the paid 1.2 contributor entry.
 * These sets encode that distinction rather than treating every 1.2 ID as
 * retired everywhere.
 */
export const RETIRED_ZEN_MODEL_IDS: ReadonlySet<string> = new Set([
  "muse-spark-1.2",
  "muse-spark-1.2-contributor",
  "muse-spark-1.2-contributor-free",
]);

/** Complete catalog of OpenCode Go subscription models from models.dev. */
export const OPENCODE_GO_CATALOG: readonly CatalogModelSpec[] = [
  {
    context_window: 1_048_576,
    cost: {
      cache_read: 0.003625,
      input: 0.435,
      output: 0.87,
    },
    id: "mimo-v2.6-pro",
    input_modalities: ["text", "image"],
    max_output_tokens: 131_072,
    name: "MiMo-V2.6-Pro",
  },
  {
    context_window: 1_000_000,
    cost: {
      cache_read: 0.0028,
      input: 0.14,
      output: 0.28,
    },
    id: "mimo-v2.5",
    input_modalities: ["text", "image"],
    max_output_tokens: 128_000,
    name: "MiMo V2.5",
  },
  {
    context_window: 500_000,
    cost: {
      cache_read: 0.5,
      input: 2,
      output: 6,
    },
    id: "grok-4.7",
    input_modalities: ["text", "image"],
    max_output_tokens: 500_000,
    name: "Grok 4.7",
  },
  {
    context_window: 1_000_000,
    cost: {
      cache_read: 0,
      input: 0,
      output: 0,
    },
    id: "longcat-2.5-preview-free",
    input_modalities: ["text", "image"],
    max_output_tokens: 131_072,
    name: "LongCat 2.5 Preview Free",
  },
  {
    context_window: 1_000_000,
    cost: {
      cache_read: 0.03,
      input: 0.15,
      output: 0.5,
    },
    id: "glm-5.3-flash",
    input_modalities: ["text", "image"],
    max_output_tokens: 131_072,
    name: "GLM-5.3-Flash",
  },
  {
    context_window: 1_000_000,
    cost: {
      cache_read: 0.25,
      cache_write: 2.5,
      input: 2,
      output: 6,
    },
    id: "qwen3.8-max",
    input_modalities: ["text", "image"],
    max_output_tokens: 131_072,
    name: "Qwen3.8 Max",
  },
  {
    context_window: 1_048_576,
    cost: {
      cache_read: 0.3,
      input: 3,
      output: 15,
    },
    id: "kimi-k3",
    input_modalities: ["text", "image"],
    max_output_tokens: 131_072,
    name: "Kimi K3",
  },
  {
    context_window: 1_000_000,
    cost: {
      cache_read: 0.003,
      input: 0.15,
      output: 0.6,
    },
    id: "deepseek-v4.1-flash",
    input_modalities: ["text", "image"],
    max_output_tokens: 384_000,
    name: "DeepSeek V4.1 Flash",
  },
  {
    context_window: 1_000_000,
    cost: {
      cache_read: 0.003,
      input: 0.15,
      output: 0.6,
    },
    id: "deepseek-v4-flash-vision-exp",
    input_modalities: ["text", "image"],
    max_output_tokens: 384_000,
    name: "DeepSeek V4 Flash Vision Exp",
  },
  {
    context_window: 1_000_000,
    cost: {
      cache_read: 0.006,
      input: 0.3,
      output: 1.2,
    },
    id: "longcat-2.0",
    input_modalities: ["text"],
    max_output_tokens: 131_072,
    name: "LongCat-2.0",
  },
  {
    context_window: 204_800,
    cost: {
      cache_read: 0.06,
      cache_write: 0.375,
      input: 0.3,
      output: 1.2,
    },
    id: "minimax-m2.7",
    input_modalities: ["text"],
    max_output_tokens: 131_072,
    name: "MiniMax-M2.7",
  },
  {
    context_window: 1_048_576,
    cost: {
      cache_read: 0,
      cache_write: 0,
      input: 0,
      output: 0,
    },
    id: "space-bunny-free",
    input_modalities: ["text", "image"],
    max_output_tokens: 524_288,
    name: "Space Bunny Free",
  },
  {
    context_window: 1_048_576,
    cost: {
      cache_read: 0.003625,
      input: 0.435,
      output: 0.87,
    },
    id: "mimo-v2.5-pro",
    input_modalities: ["text"],
    max_output_tokens: 128_000,
    name: "MiMo V2.5 Pro",
  },
  {
    context_window: 1_048_576,
    cost: {
      cache_read: 0.0028,
      input: 0.14,
      output: 0.28,
    },
    id: "mimo-v2.6-flash",
    input_modalities: ["text", "image"],
    max_output_tokens: 131_072,
    name: "MiMo-V2.6-Flash",
  },
  {
    context_window: 1_000_000,
    cost: {
      cache_read: 0.06,
      input: 0.3,
      output: 1.2,
    },
    id: "minimax-m3",
    input_modalities: ["text", "image"],
    max_output_tokens: 131_072,
    name: "MiniMax-M3",
  },
  {
    context_window: 1_050_000,
    cost: {
      cache_read: 0.02,
      cache_write: 0.25,
      input: 0.2,
      output: 1.2,
    },
    id: "gpt-5.6-luna",
    input_modalities: ["text", "image"],
    max_output_tokens: 128_000,
    name: "GPT-5.6 Luna",
  },
  {
    context_window: 1_000_000,
    cost: {
      cache_read: 0.016,
      cache_write: 0.2,
      input: 0.15,
      output: 0.47,
    },
    id: "qwen3.8-flash",
    input_modalities: ["text", "image"],
    max_output_tokens: 131_072,
    name: "Qwen3.8 Flash",
  },
  {
    context_window: 1_000_000,
    cost: {
      cache_read: 0.26,
      input: 1.4,
      output: 4.4,
    },
    id: "glm-5.2",
    input_modalities: ["text"],
    max_output_tokens: 131_072,
    name: "GLM-5.2",
  },
  {
    context_window: 256_000,
    cost: {
      cache_read: 0.035,
      input: 0.14,
      output: 0.58,
    },
    id: "hy3",
    input_modalities: ["text"],
    max_output_tokens: 128_000,
    name: "Hy3",
  },
  {
    context_window: 1_048_576,
    cost: {
      cache_read: 0.002,
      input: 0.1,
      output: 0.2,
    },
    id: "muse-spark-1.2-contributor",
    input_modalities: ["text", "image"],
    max_output_tokens: 131_072,
    name: "Muse Spark 1.2 Contributor",
  },
  {
    context_window: 1_050_000,
    cost: {
      cache_read: 0.01,
      cache_write: 0.125,
      input: 0.1,
      output: 0.5,
    },
    id: "gpt-6-luna",
    input_modalities: ["text", "image"],
    max_output_tokens: 128_000,
    name: "GPT-6 Luna",
  },
  {
    context_window: 1_000_000,
    cost: {
      cache_read: 0.022,
      input: 0.66,
      output: 1.98,
    },
    id: "deepseek-v4-pro",
    input_modalities: ["text"],
    max_output_tokens: 384_000,
    name: "DeepSeek V4 Pro (New)",
  },
  {
    context_window: 1_024_000,
    cost: {
      cache_read: 0.042,
      input: 0.834,
      output: 2.501,
    },
    id: "hy4-preview",
    input_modalities: ["text"],
    max_output_tokens: 64_000,
    name: "Hy4 preview",
  },
  {
    context_window: 1_048_576,
    cost: {
      cache_read: 0.002,
      input: 0.1,
      output: 0.2,
    },
    id: "muse-spark-1.3-contributor",
    input_modalities: ["text", "image"],
    max_output_tokens: 131_072,
    name: "Muse Spark 1.3 Contributor",
  },
  {
    context_window: 1_000_000,
    cost: {
      cache_read: 0.26,
      input: 1.4,
      output: 4.4,
    },
    id: "glm-5.3",
    input_modalities: ["text"],
    max_output_tokens: 131_072,
    name: "GLM-5.3",
  },
  {
    context_window: 262_144,
    cost: {
      cache_read: 0.19,
      input: 0.95,
      output: 4,
    },
    id: "kimi-k2.7-code",
    input_modalities: ["text", "image"],
    max_output_tokens: 262_144,
    name: "Kimi K2.7 Code",
  },
  {
    context_window: 500_000,
    cost: {
      cache_read: 0.5,
      input: 2,
      output: 6,
    },
    id: "grok-4.6",
    input_modalities: ["text", "image"],
    max_output_tokens: 500_000,
    name: "Grok 4.6",
  },
  {
    context_window: 1_000_000,
    cost: {
      cache_read: 0.04,
      cache_write: 0.5,
      input: 0.4,
      output: 1.6,
    },
    id: "qwen3.7-plus",
    input_modalities: ["text", "image"],
    max_output_tokens: 65_536,
    name: "Qwen3.7 Plus",
  },
  {
    context_window: 1_000_000,
    cost: {
      cache_read: 0.003,
      input: 0.15,
      output: 0.6,
    },
    id: "deepseek-v4-flash",
    input_modalities: ["text"],
    max_output_tokens: 384_000,
    name: "DeepSeek V4 Flash",
  },
];

/** Complete catalog of OpenCode Zen models (free tier & flagships) from models.dev. */
export const OPENCODE_ZEN_CATALOG: readonly CatalogModelSpec[] = [
  {
    context_window: 262_144,
    cost: {
      cache_read: 0,
      input: 0,
      output: 0,
    },
    id: "ling-3.0-flash-fin-free",
    input_modalities: ["text"],
    is_free: true,
    max_output_tokens: 32_768,
    name: "Ling 3.0 Flash Fin Free",
  },
  {
    context_window: 1_048_576,
    cost: {
      input: 0,
      output: 0,
    },
    id: "fledge-alpha-free",
    input_modalities: ["text", "image"],
    is_free: true,
    max_output_tokens: 131_072,
    name: "Fledge Alpha Free",
  },
  {
    context_window: 262_144,
    cost: {
      cache_read: 0,
      input: 0,
      output: 0,
    },
    id: "ling-3.1-flash-free",
    input_modalities: ["text"],
    is_free: true,
    max_output_tokens: 32_768,
    name: "Ling 3.1 Flash Free",
  },
  {
    context_window: 1_000_000,
    cost: {
      cache_read: 0,
      input: 0,
      output: 0,
    },
    id: "longcat-2.5-preview-free",
    input_modalities: ["text", "image"],
    is_free: true,
    max_output_tokens: 131_072,
    name: "LongCat 2.5 Preview Free",
  },
  {
    context_window: 1_048_576,
    cost: {
      cache_read: 0,
      cache_write: 0,
      input: 0,
      output: 0,
    },
    id: "space-bunny-free",
    input_modalities: ["text", "image"],
    is_free: true,
    max_output_tokens: 524_288,
    name: "Space Bunny Free",
  },
  {
    context_window: 200_000,
    cost: {
      cache_read: 0,
      input: 0,
      output: 0,
    },
    id: "mimo-v2.6-flash-free",
    input_modalities: ["text", "image"],
    is_free: true,
    max_output_tokens: 32_000,
    name: "MiMo-V2.6-Flash Free",
  },
  {
    context_window: 1_000_000,
    cost: {
      cache_read: 0,
      input: 0,
      output: 0,
    },
    id: "nemotron-3-ultra-free",
    input_modalities: ["text"],
    is_free: true,
    max_output_tokens: 128_000,
    name: "Nemotron 3 Ultra Free",
  },
  {
    context_window: 262_144,
    cost: {
      cache_read: 0,
      input: 0,
      output: 0,
    },
    id: "nemotron-3.5-lightning-free",
    input_modalities: ["text"],
    is_free: true,
    max_output_tokens: 262_144,
    name: "Nemotron 3.5 Lightning Free",
  },
  {
    context_window: 200_000,
    cost: {
      cache_read: 0,
      cache_write: 0,
      input: 0,
      output: 0,
    },
    id: "big-pickle",
    input_modalities: ["text"],
    is_free: true,
    max_output_tokens: 32_000,
    name: "Big Pickle",
  },
  {
    context_window: 1_048_576,
    cost: {
      cache_read: 0,
      input: 0,
      output: 0,
    },
    id: "muse-spark-1.3-contributor-free",
    input_modalities: ["text", "image"],
    is_free: true,
    max_output_tokens: 131_072,
    name: "Muse Spark 1.3 Free",
  },
  {
    context_window: 1_000_000,
    cost: {
      cache_read: 0.3,
      cache_write: 3.75,
      input: 3,
      output: 15,
    },
    id: "claude-sonnet-4-5",
    input_modalities: ["text", "image"],
    max_output_tokens: 64_000,
    name: "Claude Sonnet 4.5",
  },
  {
    context_window: 1_000_000,
    cost: {
      cache_read: 0.5,
      cache_write: 6.25,
      input: 5,
      output: 25,
    },
    id: "claude-opus-4-7",
    input_modalities: ["text", "image"],
    max_output_tokens: 128_000,
    name: "Claude Opus 4.7",
  },
  {
    context_window: 200_000,
    cost: {
      cache_read: 0.1,
      cache_write: 1.25,
      input: 1,
      output: 5,
    },
    id: "claude-haiku-4-5",
    input_modalities: ["text", "image"],
    max_output_tokens: 64_000,
    name: "Claude Haiku 4.5",
  },
  {
    context_window: 1_050_000,
    cost: {
      cache_read: 0.25,
      input: 2.5,
      output: 15,
    },
    id: "gpt-5.4",
    input_modalities: ["text", "image"],
    max_output_tokens: 128_000,
    name: "GPT-5.4",
  },
  {
    context_window: 1_050_000,
    cost: {
      cache_read: 30,
      input: 30,
      output: 180,
    },
    id: "gpt-5.4-pro",
    input_modalities: ["text", "image"],
    max_output_tokens: 128_000,
    name: "GPT-5.4 Pro",
  },
  {
    context_window: 400_000,
    cost: {
      cache_read: 0.175,
      input: 1.75,
      output: 14,
    },
    id: "gpt-5.2-codex",
    input_modalities: ["text", "image"],
    max_output_tokens: 128_000,
    name: "GPT-5.2 Codex",
  },
  {
    context_window: 1_048_576,
    cost: {
      cache_read: 0.15,
      input: 1.5,
      output: 7.5,
    },
    id: "gemini-3.8-flash",
    input_modalities: ["text", "image"],
    max_output_tokens: 65_536,
    name: "Gemini 3.8 Flash",
  },
  {
    context_window: 1_048_576,
    cost: {
      cache_read: 0.2,
      input: 2,
      output: 12,
    },
    id: "gemini-3.1-pro",
    input_modalities: ["text", "image"],
    max_output_tokens: 65_536,
    name: "Gemini 3.1 Pro Preview",
  },
  {
    context_window: 262_144,
    cost: {
      cache_read: 0.25,
      cache_write: 2.5,
      input: 2,
      output: 6,
    },
    id: "qwen3.8-max",
    input_modalities: ["text", "image"],
    max_output_tokens: 131_072,
    name: "Qwen3.8 Max",
  },
  {
    context_window: 1_048_576,
    cost: {
      cache_read: 0.3,
      input: 3,
      output: 15,
    },
    id: "kimi-k3",
    input_modalities: ["text", "image"],
    max_output_tokens: 131_072,
    name: "Kimi K3",
  },
  {
    context_window: 1_000_000,
    cost: {
      cache_read: 0.006,
      input: 0.3,
      output: 1.2,
    },
    id: "deepseek-v4.1-flash",
    input_modalities: ["text", "image"],
    max_output_tokens: 384_000,
    name: "DeepSeek V4.1 Flash",
  },
  {
    context_window: 500_000,
    cost: {
      cache_read: 0.5,
      input: 2,
      output: 6,
    },
    id: "grok-4.7",
    input_modalities: ["text", "image"],
    max_output_tokens: 500_000,
    name: "Grok 4.7",
  },
];
