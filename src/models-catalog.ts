/**
 * Authoritative OpenCode Go & Zen model catalog and gateway model list enrichment.
 *
 * The raw OpenCode Go `/models` gateway endpoint frequently returns an incomplete
 * or truncated list of model IDs without display names, context windows, max
 * tokens, or input modalities.
 *
 * This module maintains the canonical catalog (sourced from `models.dev/api.json`)
 * and intercepts `GET .../models` gateway responses to ensure that all 33+ models
 * are present, fully described, and available for DSH model discovery.
 *
 * @module dsh-opencode-patch/models-catalog
 */

import { isRecord } from "./guards.ts";
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
    input_modalities: ["text", "image", "audio", "video"],
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
    input_modalities: ["text", "image", "audio", "video"],
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
    input_modalities: ["text", "image", "pdf"],
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
    input_modalities: ["text", "image", "video", "pdf"],
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
    input_modalities: ["text", "image", "video"],
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
    input_modalities: ["text", "image", "video"],
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
    input_modalities: ["text", "image", "video"],
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
    input_modalities: ["text", "image", "audio", "video"],
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
    input_modalities: ["text", "image", "video"],
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
    input_modalities: ["text", "image", "pdf"],
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
    input_modalities: ["text", "image", "video"],
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
    input_modalities: ["text", "image", "video", "pdf", "audio"],
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
    input_modalities: ["text", "image", "pdf"],
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
    input_modalities: ["text", "image", "video", "pdf", "audio"],
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
    input_modalities: ["text", "image", "video"],
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
    input_modalities: ["text", "image", "video"],
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
    input_modalities: ["text", "image", "video"],
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
    input_modalities: ["text", "image", "audio", "video"],
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
    input_modalities: ["text", "image", "video", "pdf", "audio"],
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
    input_modalities: ["text", "image", "pdf"],
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
    input_modalities: ["text", "image", "pdf"],
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
    input_modalities: ["text", "image", "pdf"],
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
    input_modalities: ["text", "image", "pdf"],
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
    input_modalities: ["text", "image", "pdf"],
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
    input_modalities: ["text", "image", "pdf"],
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
    input_modalities: ["text", "image", "video", "audio", "pdf"],
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
    input_modalities: ["text", "image", "video", "audio", "pdf"],
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
    input_modalities: ["text", "image", "video"],
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
    input_modalities: ["text", "image", "pdf"],
    max_output_tokens: 500_000,
    name: "Grok 4.7",
  },
];

/** Official OpenCode model registry URL. */
export const MODELS_DEV_URL = "https://models.dev/api.json";

/** TTL for cached models before triggering a background revalidation (60 minutes). */
export const CATALOG_REVALIDATION_TTL_MS = 60 * 60 * 1000;

/** Timeout for models.dev revalidation requests (8 seconds). */
export const MODELS_DEV_TIMEOUT_MS = 8000;

let activeGoCatalog = new Map<string, CatalogModelSpec>(
  OPENCODE_GO_CATALOG.map((m) => [m.id, m])
);
let activeZenCatalog = new Map<string, CatalogModelSpec>(
  OPENCODE_ZEN_CATALOG.map((m) => [m.id, m])
);
let lastRefreshedAt = 0;
let refreshPromise:
  | Promise<{
      go: readonly CatalogModelSpec[];
      zen: readonly CatalogModelSpec[];
    }>
  | undefined;

export interface ParsedCatalogs {
  go: CatalogModelSpec[];
  zen: CatalogModelSpec[];
}

const extractSpecs = (
  modelsObj: Record<string, unknown>,
  defaultContext = 1_000_000
): CatalogModelSpec[] => {
  const results: CatalogModelSpec[] = [];
  for (const [id, rawModel] of Object.entries(modelsObj)) {
    if (!isRecord(rawModel)) {
      continue;
    }
    const name =
      typeof rawModel.name === "string" && rawModel.name.length > 0
        ? rawModel.name
        : id;
    const limit = isRecord(rawModel.limit) ? rawModel.limit : undefined;
    const context_window =
      typeof limit?.context === "number" && limit.context > 0
        ? limit.context
        : defaultContext;
    const max_output_tokens =
      typeof limit?.output === "number" && limit.output > 0
        ? limit.output
        : 131_072;
    const modalities = isRecord(rawModel.modalities)
      ? rawModel.modalities
      : undefined;
    const input_modalities = Array.isArray(modalities?.input)
      ? modalities.input.filter((m): m is string => typeof m === "string")
      : ["text"];
    const costRaw = isRecord(rawModel.cost) ? rawModel.cost : undefined;
    let cost: ModelCostRate | undefined;
    if (costRaw !== undefined) {
      const input = typeof costRaw.input === "number" ? costRaw.input : 0;
      const output = typeof costRaw.output === "number" ? costRaw.output : 0;
      const cache_read =
        typeof costRaw.cache_read === "number" ? costRaw.cache_read : undefined;
      const cache_write =
        typeof costRaw.cache_write === "number"
          ? costRaw.cache_write
          : undefined;
      cost = {
        input,
        output,
        ...(cache_read === undefined ? {} : { cache_read }),
        ...(cache_write === undefined ? {} : { cache_write }),
      };
    }
    const is_free =
      id.includes("free") || (cost?.input === 0 && cost?.output === 0);

    results.push({
      context_window,
      ...(cost === undefined ? {} : { cost }),
      id,
      input_modalities:
        input_modalities.length > 0 ? input_modalities : ["text"],
      ...(is_free ? { is_free: true } : {}),
      max_output_tokens,
      name,
    });
  }
  return results;
};

/** Look up model specifications and pricing rates by model ID. */
export const findModelSpec = (modelId: string): CatalogModelSpec | undefined =>
  activeGoCatalog.get(modelId) ?? activeZenCatalog.get(modelId);

/**
 * Safely parse raw models.dev JSON data for both opencode-go and opencode providers.
 *
 * @param data - raw parsed JSON from `https://models.dev/api.json`
 * @returns extracted model specifications for both Go and Zen
 */
export const parseModelsDevCatalog = (data: unknown): ParsedCatalogs => {
  if (!isRecord(data)) {
    return { go: [], zen: [] };
  }
  const goObj =
    isRecord(data["opencode-go"]) && isRecord(data["opencode-go"].models)
      ? data["opencode-go"].models
      : {};
  const zenObj =
    isRecord(data.opencode) && isRecord(data.opencode.models)
      ? data.opencode.models
      : {};

  return {
    go: extractSpecs(goObj, 1_000_000),
    zen: extractSpecs(zenObj, 1_000_000),
  };
};

/**
 * Fetch and merge the latest live model specifications from `models.dev`.
 *
 * Never throws: on network failure, timeout, or invalid reply, gracefully falls
 * back to the current active catalog. Concurrent calls coalesce into one in-flight promise.
 *
 * @param fetchFn - fetch implementation to use (defaults to globalThis.fetch)
 * @param force - bypass TTL cache and force immediate refresh
 */
export const refreshCatalog = (
  fetchFn: typeof fetch = globalThis.fetch,
  force = false
): Promise<{
  go: readonly CatalogModelSpec[];
  zen: readonly CatalogModelSpec[];
}> => {
  const now = Date.now();
  if (
    !force &&
    lastRefreshedAt > 0 &&
    now - lastRefreshedAt < CATALOG_REVALIDATION_TTL_MS
  ) {
    return Promise.resolve({
      go: [...activeGoCatalog.values()],
      zen: [...activeZenCatalog.values()],
    });
  }
  if (!force && refreshPromise !== undefined) {
    return refreshPromise;
  }

  refreshPromise = (async () => {
    try {
      const response = await fetchFn(MODELS_DEV_URL, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(MODELS_DEV_TIMEOUT_MS),
      });
      if (response.ok) {
        const json: unknown = await response.json();
        const parsed = parseModelsDevCatalog(json);
        if (parsed.go.length > 0) {
          const nextGo = new Map(activeGoCatalog);
          for (const model of parsed.go) {
            nextGo.set(model.id, model);
          }
          activeGoCatalog = nextGo;
        }
        if (parsed.zen.length > 0) {
          const nextZen = new Map(activeZenCatalog);
          for (const model of parsed.zen) {
            nextZen.set(model.id, model);
          }
          activeZenCatalog = nextZen;
        }
        if (parsed.go.length > 0 || parsed.zen.length > 0) {
          lastRefreshedAt = Date.now();
        }
      }
    } catch {
      // Revalidation failure retains active catalogs and allows later retry
    } finally {
      refreshPromise = undefined;
    }
    return {
      go: [...activeGoCatalog.values()],
      zen: [...activeZenCatalog.values()],
    };
  })();

  return refreshPromise;
};

const triggerBackgroundRefresh = async (
  fetchFn: typeof fetch
): Promise<void> => {
  try {
    await refreshCatalog(fetchFn);
  } catch {
    // Background revalidation failure silently retains active catalogs
  }
};

/**
 * Return current Go models catalog immediately (non-blocking), triggering SWR background revalidation if stale.
 *
 * @param fetchFn - fetch implementation to use for background refresh
 */
export const getLiveGoCatalog = (
  fetchFn: typeof fetch = globalThis.fetch
): readonly CatalogModelSpec[] => {
  const now = Date.now();
  if (
    lastRefreshedAt === 0 ||
    now - lastRefreshedAt >= CATALOG_REVALIDATION_TTL_MS
  ) {
    void triggerBackgroundRefresh(fetchFn);
  }
  return [...activeGoCatalog.values()];
};

/**
 * Return current Zen models catalog immediately (non-blocking), triggering SWR background revalidation if stale.
 *
 * @param fetchFn - fetch implementation to use for background refresh
 */
export const getLiveZenCatalog = (
  fetchFn: typeof fetch = globalThis.fetch
): readonly CatalogModelSpec[] => {
  const now = Date.now();
  if (
    lastRefreshedAt === 0 ||
    now - lastRefreshedAt >= CATALOG_REVALIDATION_TTL_MS
  ) {
    void triggerBackgroundRefresh(fetchFn);
  }
  return [...activeZenCatalog.values()];
};

/** Legacy alias for getLiveGoCatalog. */
export const getLiveCatalog = getLiveGoCatalog;

/** Check whether a request URL is interrogating the models directory on OpenCode. */
export const isModelsListingUrl = (url: string): boolean => {
  if (!url.includes("opencode.ai/zen")) {
    return false;
  }
  return url.endsWith("/models") || url.includes("/models?");
};

export const isGoModelsListingUrl = (url: string): boolean =>
  isModelsListingUrl(url) &&
  (url.includes("/zen/go") || url.includes("/go/v1"));

/**
 * Merge and enrich a gateway `/models` response with the complete OpenCode Go or Zen catalog.
 *
 * @param url - the request URL
 * @param response - the upstream fetch Response
 * @param fetchFn - optional fetch implementation for SWR background refresh
 * @returns an enriched Response with all models and complete metadata
 */
export const enrichModelsResponse = async (
  url: string,
  response: Response,
  fetchFn: typeof fetch = globalThis.fetch
): Promise<Response> => {
  let existingData: Record<string, unknown>[] = [];
  try {
    const raw: unknown = await response.clone().json();
    if (isRecord(raw) && Array.isArray(raw.data)) {
      existingData = raw.data.filter(isRecord);
    }
  } catch {
    // If the upstream returned non-JSON, generate the full catalog response.
  }

  const isGo = isGoModelsListingUrl(url);
  const catalog = isGo ? getLiveGoCatalog(fetchFn) : getLiveZenCatalog(fetchFn);
  const catalogById = new Map(catalog.map((m) => [m.id, m]));
  const merged = new Map<string, Record<string, unknown>>();

  // 1. Seed with known catalog models
  for (const spec of catalog) {
    merged.set(spec.id, {
      context_window: spec.context_window,
      created: 1_727_740_800,
      id: spec.id,
      input_modalities: spec.input_modalities,
      max_output_tokens: spec.max_output_tokens,
      name: spec.name,
      object: "model",
      owned_by: "opencode",
    });
  }

  // 2. Overlay live models returned by gateway
  for (const item of existingData) {
    const id = typeof item.id === "string" ? item.id : "";
    if (id.length === 0) {
      continue;
    }
    const spec = catalogById.get(id);
    const enriched = {
      ...item,
      context_window:
        item.context_window ?? item.contextWindow ?? spec?.context_window,
      id,
      input_modalities:
        item.input_modalities ?? item.inputModalities ?? spec?.input_modalities,
      max_output_tokens:
        item.max_output_tokens ?? item.maxTokens ?? spec?.max_output_tokens,
      name: item.name ?? item.displayName ?? spec?.name ?? id,
      object: "model",
      owned_by: item.owned_by ?? "opencode",
    };
    merged.set(id, enriched);
  }

  const enrichedPayload = {
    data: [...merged.values()],
    object: "list",
  };

  const bodyStr = JSON.stringify(enrichedPayload);
  const newHeaders = new Headers(response.headers);
  newHeaders.set("content-type", "application/json; charset=utf-8");
  newHeaders.set("content-length", Buffer.byteLength(bodyStr).toString());

  return new Response(bodyStr, {
    headers: newHeaders,
    status: 200,
    statusText: "OK",
  });
};
