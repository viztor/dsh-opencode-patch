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

import {
  OPENCODE_GO_CATALOG,
  OPENCODE_ZEN_CATALOG,
  RETIRED_ZEN_MODEL_IDS,
  type CatalogModelSpec,
} from "./catalog-data.ts";
import { DEFAULT_GATEWAY_URLS } from "./config.ts";
import { isRecord } from "./guards.ts";
import type { ModelCostRate } from "./session-cost.ts";

// The catalog data is part of this module's public surface (and of the
// package's, via `index.ts`), so re-export it rather than making callers
// reach into `catalog-data.ts` directly.
export {
  OPENCODE_GO_CATALOG,
  OPENCODE_ZEN_CATALOG,
  RETIRED_ZEN_MODEL_IDS,
  type CatalogModelSpec,
} from "./catalog-data.ts";

export type CatalogProvider = "go" | "zen";

/** Whether OpenCode CLI no longer offers this model ID on this provider. */
export const isRetiredModel = (
  provider: CatalogProvider,
  id: string
): boolean => provider === "zen" && RETIRED_ZEN_MODEL_IDS.has(id);

/** Official OpenCode model registry URL. */
export const MODELS_DEV_URL = "https://models.dev/api.json";

/**
 * Modalities supported by DeepSeek Harness model configuration schemas.
 * DSH strictly accepts ("text" | "image")[], rejecting "video", "audio", "pdf".
 */
export const DSH_SUPPORTED_MODALITIES = new Set(["text", "image"]);

/**
 * Sanitize an input modalities list to match the DSH schema ("text" | "image").
 * Drops "video", "audio", "pdf", and defaults to ["text"] if empty.
 */
export const sanitizeModalities = (
  modalities: unknown
): ("text" | "image")[] => {
  if (!Array.isArray(modalities)) {
    return ["text"];
  }
  const filtered = modalities.filter(
    (m): m is "text" | "image" =>
      typeof m === "string" && DSH_SUPPORTED_MODALITIES.has(m)
  );
  return filtered.length > 0 ? filtered : ["text"];
};

/** TTL for cached models before triggering a background revalidation (60 minutes). */
export const CATALOG_REVALIDATION_TTL_MS = 60 * 60 * 1000;

/**
 * What an enriched row falls back to when neither the live row nor the catalog
 * describes the model. Matches the shim's own defaults, so a model that reaches
 * the picker before either source knows it is still fully described.
 */
const FALLBACK_CONTEXT_WINDOW = 1_000_000;

/** @see FALLBACK_CONTEXT_WINDOW */
const FALLBACK_MAX_OUTPUT_TOKENS = 131_072;

/** Timeout for models.dev revalidation requests (8 seconds). */
export const MODELS_DEV_TIMEOUT_MS = 8000;

let activeGoCatalog = new Map<string, CatalogModelSpec>(
  OPENCODE_GO_CATALOG.filter((m) => !isRetiredModel("go", m.id)).map((m) => [
    m.id,
    m,
  ])
);
let activeZenCatalog = new Map<string, CatalogModelSpec>(
  OPENCODE_ZEN_CATALOG.filter((m) => !isRetiredModel("zen", m.id)).map((m) => [
    m.id,
    m,
  ])
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
    // The bundled shim ships active models only, and a refresh must agree with
    // it: merging a deprecated entry here would put a row the gateway no longer
    // serves back into the model picker on the next successful revalidation.
    if (rawModel.status === "deprecated") {
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
    const input_modalities = sanitizeModalities(modalities?.input);
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
    // models.dev sets `provider.npm` only as an override of the provider's
    // default SDK, so its PRESENCE is the signal: a model naming `@ai-sdk/openai`
    // is served on the Responses API, one naming nothing uses the default.
    const provider = isRecord(rawModel.provider)
      ? rawModel.provider
      : undefined;
    const provider_npm =
      typeof provider?.npm === "string" && provider.npm.length > 0
        ? provider.npm
        : undefined;

    results.push({
      context_window,
      ...(cost === undefined ? {} : { cost }),
      id,
      input_modalities:
        input_modalities.length > 0 ? input_modalities : ["text"],
      ...(is_free ? { is_free: true } : {}),
      max_output_tokens,
      name,
      ...(provider_npm === undefined ? {} : { provider_npm }),
    });
  }
  return results;
};

/** Which of the two catalogs a model id should be read from. */
export type CatalogPlane = "go" | "zen";

/**
 * The plane a route's models come from.
 *
 * `opencode-go` is the subscription plane; everything else this plugin knows
 * about (`opencode`, and the internal routes derived from it) is Zen.
 */
export const catalogPlaneForRoute = (route: unknown): CatalogPlane =>
  route === "opencode-go" ? "go" : "zen";

/**
 * The spec a given PLANE declares for a model.
 *
 * **The two planes declare different SDKs for the same model id**, which is why
 * this exists at all. models.dev's `opencode-go` names `@ai-sdk/anthropic` for
 * `qwen3.8-max`, `minimax-m2.7` and `minimax-m3`, while its `opencode` names
 * nothing — the default, i.e. completions. A single Go-first lookup therefore
 * answers a ZEN question with GO data, and for those three models that is a
 * mis-route rather than a detail.
 *
 * Measured 2026-10-06 against the live Zen gateway: `qwen3.8-max` and
 * `minimax-m3` answer `200` on `/chat/completions` and
 * `400 ModelProtocolUnsupported` on `/messages` — and `/messages` is exactly
 * where the Go-first read sent them. Both were reachable and failing.
 */
export const findModelSpecOn = (
  plane: CatalogPlane,
  modelId: string
): CatalogModelSpec | undefined =>
  plane === "go" ? activeGoCatalog.get(modelId) : activeZenCatalog.get(modelId);

/**
 * Look up model specifications and pricing rates by model ID, preferring the Go
 * plane.
 *
 * Correct for "does either plane know this model" — pricing and limits, which
 * agree across the planes for every shared id. **Not** correct for routing: see
 * {@link findModelSpecOn}. Anywhere the answer decides which ENDPOINT serves a
 * model, the plane has to come from the route in play.
 */
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
          for (const retiredId of RETIRED_ZEN_MODEL_IDS) {
            nextZen.delete(retiredId);
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
 * Serve one catalog map immediately (non-blocking), kicking off a background
 * SWR revalidation when it is stale.
 *
 * Both providers share a single freshness clock: `lastRefreshedAt` is only
 * advanced by a refresh that returned something for at least one provider, so
 * an offline start keeps retrying on every read until the first success.
 *
 * @param catalog - the active map to snapshot.
 * @param fetchFn - fetch implementation used for the background refresh.
 */
const readLiveCatalog = (
  catalog: ReadonlyMap<string, CatalogModelSpec>,
  fetchFn: typeof fetch
): readonly CatalogModelSpec[] => {
  const now = Date.now();
  if (
    lastRefreshedAt === 0 ||
    now - lastRefreshedAt >= CATALOG_REVALIDATION_TTL_MS
  ) {
    void triggerBackgroundRefresh(fetchFn);
  }
  return [...catalog.values()];
};

/**
 * Return the current Go catalog immediately, triggering SWR revalidation if stale.
 *
 * @param fetchFn - fetch implementation to use for background refresh
 */
export const getLiveGoCatalog = (
  fetchFn: typeof fetch = globalThis.fetch
): readonly CatalogModelSpec[] => readLiveCatalog(activeGoCatalog, fetchFn);

/**
 * Return the current Zen catalog immediately, triggering SWR revalidation if stale.
 *
 * @param fetchFn - fetch implementation to use for background refresh
 */
export const getLiveZenCatalog = (
  fetchFn: typeof fetch = globalThis.fetch
): readonly CatalogModelSpec[] => readLiveCatalog(activeZenCatalog, fetchFn);

/** Legacy alias for getLiveGoCatalog. */
export const getLiveCatalog = getLiveGoCatalog;

/**
 * Check whether a request URL is interrogating the models directory.
 *
 * The gateway marker is a PARAMETER, not a constant. It used to be hardcoded to
 * `opencode.ai/zen` while `isOpenCodeRequest` already took `gatewayUrls` — so a
 * relay or mirror that matched every other OpenCode rule got the headers and the
 * session id but no catalog enrichment, and the only symptom was a shorter model
 * list. Same shape as that predicate: match any configured marker, defaulting to
 * the stock one.
 *
 * @param url - the request URL
 * @param gatewayUrls - configured gateway markers; defaults to the stock one
 */
export const isModelsListingUrl = (
  url: string,
  gatewayUrls: readonly string[] = DEFAULT_GATEWAY_URLS
): boolean => {
  const onGateway = gatewayUrls.some(
    (marker) => marker.length > 0 && url.includes(marker)
  );
  if (!onGateway) {
    return false;
  }
  return url.endsWith("/models") || url.includes("/models?");
};

/**
 * Whether that listing is on the GO plane.
 *
 * The plane is a property of the PATH, never of the host: a custom gateway's Go
 * route is still `/go/v1`, so this reads the same way for a relay as for
 * opencode.ai — which is exactly why the marker above had to be lifted out.
 */
export const isGoModelsListingUrl = (
  url: string,
  gatewayUrls?: readonly string[]
): boolean =>
  isModelsListingUrl(url, gatewayUrls) &&
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
    const input_modalities = sanitizeModalities(spec.input_modalities);
    merged.set(spec.id, {
      context_window: spec.context_window,
      created: 1_727_740_800,
      id: spec.id,
      input: input_modalities,
      input_modalities,
      inputModalities: input_modalities,
      max_output_tokens: spec.max_output_tokens,
      name: spec.name,
      object: "model",
      owned_by: "opencode",
    });
  }

  // 2. Overlay live models returned by gateway
  for (const item of existingData) {
    const id = typeof item.id === "string" ? item.id : "";
    if (id.length === 0 || isRetiredModel(isGo ? "go" : "zen", id)) {
      continue;
    }
    const spec = catalogById.get(id);
    const rawModalities =
      item.input_modalities ??
      item.inputModalities ??
      item.input ??
      spec?.input_modalities;
    const input_modalities = sanitizeModalities(rawModalities);
    const enriched = {
      ...item,
      // A live row the catalog does not describe must still be fully described.
      // The gateway adds models before models.dev — or the bundled shim — knows
      // them, and DSH needs a number to size the context meter; a row carrying
      // `undefined` here reaches the picker as a model with no limits at all.
      context_window:
        item.context_window ??
        item.contextWindow ??
        spec?.context_window ??
        FALLBACK_CONTEXT_WINDOW,
      id,
      input: input_modalities,
      input_modalities,
      inputModalities: input_modalities,
      max_output_tokens:
        item.max_output_tokens ??
        item.maxTokens ??
        spec?.max_output_tokens ??
        FALLBACK_MAX_OUTPUT_TOKENS,
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
