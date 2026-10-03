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

const CATALOG_BY_ID = new Map<string, CatalogModelSpec>(
  OPENCODE_GO_CATALOG.map((m) => [m.id, m])
);

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
 * @returns an enriched Response with all 33+ models and complete metadata
 */
export const enrichModelsResponse = async (
  response: Response
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

  const merged = new Map<string, Record<string, unknown>>();

  // 1. Seed with known catalog models (so contextWindow, name, maxTokens are populated)
  for (const spec of OPENCODE_GO_CATALOG) {
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
    const spec = CATALOG_BY_ID.get(id);
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
