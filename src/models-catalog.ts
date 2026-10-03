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

export interface CatalogModelSpec {
  context_window: number;
  id: string;
  input_modalities: string[];
  max_output_tokens: number;
  name: string;
}

/** Complete catalog of OpenCode Go subscription models from models.dev. */
export const OPENCODE_GO_CATALOG: readonly CatalogModelSpec[] = [
  {
    context_window: 1_048_576,
    id: "mimo-v2.6-pro",
    input_modalities: ["text", "image", "audio", "video"],
    max_output_tokens: 131_072,
    name: "MiMo-V2.6-Pro",
  },
  {
    context_window: 1_000_000,
    id: "qwen3.7-max",
    input_modalities: ["text"],
    max_output_tokens: 65_536,
    name: "Qwen3.7 Max",
  },
  {
    context_window: 1_000_000,
    id: "mimo-v2.5",
    input_modalities: ["text", "image", "audio", "video"],
    max_output_tokens: 128_000,
    name: "MiMo V2.5",
  },
  {
    context_window: 500_000,
    id: "grok-4.7",
    input_modalities: ["text", "image", "pdf"],
    max_output_tokens: 500_000,
    name: "Grok 4.7",
  },
  {
    context_window: 1_000_000,
    id: "longcat-2.5-preview-free",
    input_modalities: ["text", "image"],
    max_output_tokens: 131_072,
    name: "LongCat 2.5 Preview Free",
  },
  {
    context_window: 1_000_000,
    id: "glm-5.3-flash",
    input_modalities: ["text", "image", "video", "pdf"],
    max_output_tokens: 131_072,
    name: "GLM-5.3-Flash",
  },
  {
    context_window: 1_000_000,
    id: "qwen3.8-max",
    input_modalities: ["text", "image", "video"],
    max_output_tokens: 131_072,
    name: "Qwen3.8 Max",
  },
  {
    context_window: 1_048_576,
    id: "kimi-k3",
    input_modalities: ["text", "image", "video"],
    max_output_tokens: 131_072,
    name: "Kimi K3",
  },
  {
    context_window: 1_000_000,
    id: "deepseek-v4.1-flash",
    input_modalities: ["text", "image"],
    max_output_tokens: 384_000,
    name: "DeepSeek V4.1 Flash",
  },
  {
    context_window: 1_000_000,
    id: "deepseek-v4-flash-vision-exp",
    input_modalities: ["text", "image"],
    max_output_tokens: 384_000,
    name: "DeepSeek V4 Flash Vision Exp",
  },
  {
    context_window: 262_144,
    id: "kimi-k2.6",
    input_modalities: ["text", "image", "video"],
    max_output_tokens: 65_536,
    name: "Kimi K2.6",
  },
  {
    context_window: 1_000_000,
    id: "longcat-2.0",
    input_modalities: ["text"],
    max_output_tokens: 131_072,
    name: "LongCat-2.0",
  },
  {
    context_window: 500_000,
    id: "grok-4.5",
    input_modalities: ["text", "image"],
    max_output_tokens: 500_000,
    name: "Grok 4.5",
  },
  {
    context_window: 204_800,
    id: "minimax-m2.7",
    input_modalities: ["text"],
    max_output_tokens: 131_072,
    name: "MiniMax-M2.7",
  },
  {
    context_window: 1_048_576,
    id: "space-bunny-free",
    input_modalities: ["text", "image", "video"],
    max_output_tokens: 524_288,
    name: "Space Bunny Free",
  },
  {
    context_window: 1_048_576,
    id: "mimo-v2.5-pro",
    input_modalities: ["text"],
    max_output_tokens: 128_000,
    name: "MiMo V2.5 Pro",
  },
  {
    context_window: 1_048_576,
    id: "mimo-v2.6-flash",
    input_modalities: ["text", "image", "audio", "video"],
    max_output_tokens: 131_072,
    name: "MiMo-V2.6-Flash",
  },
  {
    context_window: 1_000_000,
    id: "minimax-m3",
    input_modalities: ["text", "image", "video"],
    max_output_tokens: 131_072,
    name: "MiniMax-M3",
  },
  {
    context_window: 1_050_000,
    id: "gpt-5.6-luna",
    input_modalities: ["text", "image", "pdf"],
    max_output_tokens: 128_000,
    name: "GPT-5.6 Luna",
  },
  {
    context_window: 1_000_000,
    id: "qwen3.8-flash",
    input_modalities: ["text", "image", "video"],
    max_output_tokens: 131_072,
    name: "Qwen3.8 Flash",
  },
  {
    context_window: 1_000_000,
    id: "glm-5.2",
    input_modalities: ["text"],
    max_output_tokens: 131_072,
    name: "GLM-5.2",
  },
  {
    context_window: 256_000,
    id: "hy3",
    input_modalities: ["text"],
    max_output_tokens: 128_000,
    name: "Hy3",
  },
  {
    context_window: 1_048_576,
    id: "muse-spark-1.2-contributor",
    input_modalities: ["text", "image", "video", "pdf", "audio"],
    max_output_tokens: 131_072,
    name: "Muse Spark 1.2 Contributor",
  },
  {
    context_window: 1_050_000,
    id: "gpt-6-luna",
    input_modalities: ["text", "image", "pdf"],
    max_output_tokens: 128_000,
    name: "GPT-6 Luna",
  },
  {
    context_window: 1_000_000,
    id: "deepseek-v4-pro",
    input_modalities: ["text"],
    max_output_tokens: 384_000,
    name: "DeepSeek V4 Pro (New)",
  },
  {
    context_window: 1_000_000,
    id: "qwen3.6-plus",
    input_modalities: ["text", "image", "video"],
    max_output_tokens: 65_536,
    name: "Qwen3.6 Plus",
  },
  {
    context_window: 1_024_000,
    id: "hy4-preview",
    input_modalities: ["text"],
    max_output_tokens: 64_000,
    name: "Hy4 preview",
  },
  {
    context_window: 1_048_576,
    id: "muse-spark-1.3-contributor",
    input_modalities: ["text", "image", "video", "pdf", "audio"],
    max_output_tokens: 131_072,
    name: "Muse Spark 1.3 Contributor",
  },
  {
    context_window: 1_000_000,
    id: "glm-5.3",
    input_modalities: ["text"],
    max_output_tokens: 131_072,
    name: "GLM-5.3",
  },
  {
    context_window: 262_144,
    id: "kimi-k2.7-code",
    input_modalities: ["text", "image", "video"],
    max_output_tokens: 262_144,
    name: "Kimi K2.7 Code",
  },
  {
    context_window: 500_000,
    id: "grok-4.6",
    input_modalities: ["text", "image"],
    max_output_tokens: 500_000,
    name: "Grok 4.6",
  },
  {
    context_window: 1_000_000,
    id: "qwen3.7-plus",
    input_modalities: ["text", "image", "video"],
    max_output_tokens: 65_536,
    name: "Qwen3.7 Plus",
  },
  {
    context_window: 1_000_000,
    id: "deepseek-v4-flash",
    input_modalities: ["text"],
    max_output_tokens: 384_000,
    name: "DeepSeek V4 Flash",
  },
];

/** Official OpenCode model registry URL. */
export const MODELS_DEV_URL = "https://models.dev/api.json";

/** TTL for cached models before triggering a background revalidation (60 minutes). */
export const CATALOG_REVALIDATION_TTL_MS = 60 * 60 * 1000;

/** Timeout for models.dev revalidation requests (8 seconds). */
export const MODELS_DEV_TIMEOUT_MS = 8000;

let activeCatalog = new Map<string, CatalogModelSpec>(
  OPENCODE_GO_CATALOG.map((m) => [m.id, m])
);
let lastRefreshedAt = 0;
let refreshPromise: Promise<readonly CatalogModelSpec[]> | undefined;

/**
 * Safely parse raw models.dev JSON data for the opencode-go provider.
 *
 * @param data - raw parsed JSON from `https://models.dev/api.json`
 * @returns extracted model specifications
 */
export const parseModelsDevCatalog = (data: unknown): CatalogModelSpec[] => {
  if (!isRecord(data)) {
    return [];
  }
  const goProvider = isRecord(data["opencode-go"])
    ? data["opencode-go"]
    : undefined;
  if (!goProvider || !isRecord(goProvider.models)) {
    return [];
  }
  const results: CatalogModelSpec[] = [];
  for (const [id, rawModel] of Object.entries(goProvider.models)) {
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
        : 1_000_000;
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

    results.push({
      context_window,
      id,
      input_modalities:
        input_modalities.length > 0 ? input_modalities : ["text"],
      max_output_tokens,
      name,
    });
  }
  return results;
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
): Promise<readonly CatalogModelSpec[]> => {
  const now = Date.now();
  if (
    !force &&
    lastRefreshedAt > 0 &&
    now - lastRefreshedAt < CATALOG_REVALIDATION_TTL_MS
  ) {
    return Promise.resolve([...activeCatalog.values()]);
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
        if (parsed.length > 0) {
          const next = new Map(activeCatalog);
          for (const model of parsed) {
            next.set(model.id, model);
          }
          activeCatalog = next;
          lastRefreshedAt = Date.now();
        }
      }
    } catch {
      // Revalidation failure retains the current active catalog and allows later retry
    } finally {
      refreshPromise = undefined;
    }
    return [...activeCatalog.values()];
  })();

  return refreshPromise;
};

const triggerBackgroundRefresh = async (
  fetchFn: typeof fetch
): Promise<void> => {
  try {
    await refreshCatalog(fetchFn);
  } catch {
    // Background revalidation failure silently retains active catalog
  }
};

/**
 * Return the current catalog immediately (non-blocking), triggering background
 * revalidation if the cached data is stale.
 *
 * @param fetchFn - fetch implementation to use for background refresh
 */
export const getLiveCatalog = (
  fetchFn: typeof fetch = globalThis.fetch
): readonly CatalogModelSpec[] => {
  const now = Date.now();
  if (
    lastRefreshedAt === 0 ||
    now - lastRefreshedAt >= CATALOG_REVALIDATION_TTL_MS
  ) {
    // Non-blocking background revalidation
    void triggerBackgroundRefresh(fetchFn);
  }
  return [...activeCatalog.values()];
};

/** Check whether a request URL is interrogating the models directory on OpenCode. */
export const isModelsListingUrl = (url: string): boolean => {
  if (!url.includes("opencode.ai/zen")) {
    return false;
  }
  return url.endsWith("/models") || url.includes("/models?");
};

/**
 * Merge and enrich a gateway `/models` response with the complete OpenCode Go catalog.
 *
 * @param response - the upstream fetch Response
 * @param fetchFn - optional fetch implementation for SWR background refresh
 * @returns an enriched Response with all 33+ models and complete metadata
 */
export const enrichModelsResponse = async (
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
    // If the upstream returned non-JSON, we will generate the full catalog response.
  }

  const catalog = getLiveCatalog(fetchFn);
  const catalogById = new Map(catalog.map((m) => [m.id, m]));
  const merged = new Map<string, Record<string, unknown>>();

  // 1. Seed with known catalog models (so contextWindow, name, maxTokens are populated)
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

  // 2. Overlay live models returned by gateway (preserving any new models or overrides)
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
