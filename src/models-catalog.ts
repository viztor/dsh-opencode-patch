/**
 * Authoritative OpenCode Go & Zen model catalog and gateway model list enrichment.
 *
 * The raw OpenCode Go `/models` gateway endpoint frequently returns an incomplete
 * or truncated list of model IDs without display names, context windows, max
 * tokens, or input modalities.
 *
 * This module maintains the canonical catalog (sourced from
 * `models.opencode.ai/api.json`) and intercepts `GET .../models` gateway
 * responses to ensure that all models are present, fully described, and
 * available for DSH model discovery.
 *
 * @module dsh-opencode-patch/models-catalog
 */

import {
  OPENCODE_GO_CATALOG,
  OPENCODE_ZEN_CATALOG,
  type CatalogModelSpec,
  type ReasoningOptionSpec,
} from "./catalog-data.ts";
import { DEFAULT_GATEWAY_URLS } from "./config.ts";
import type { ModelCostRate } from "./session-cost.ts";
import { isRecord } from "./utils/guards.ts";
import { isGoPlaneUrl } from "./utils/request-shape.ts";

// The catalog data is part of this module's public surface (and of the
// package's, via `index.ts`), so re-export it rather than making callers
// reach into `catalog-data.ts` directly.
export {
  OPENCODE_GO_CATALOG,
  OPENCODE_ZEN_CATALOG,
  type CatalogModelSpec,
} from "./catalog-data.ts";

export type CatalogProvider = "go" | "zen";

/**
 * The registry this plugin actually fetches: the OpenCode catalog, served from
 * OpenCode's own host.
 *
 * Measured: this and `https://models.dev/api.json` return the SAME object today —
 * byte-identical body, identical ETag — so the two names are one registry, not two
 * sources. The OpenCode host is the one that is called, and a test pins it: a
 * silent re-point would still return valid data, which is precisely why the
 * assertion is on the request rather than on the answer.
 */
export const MODELS_OPENCODE_URL = "https://models.opencode.ai/api.json";

/**
 * The same registry under its public name, `models.dev`.
 *
 * Exported for callers that want the human-facing URL (documentation links, a
 * health probe). It is NOT what {@link refreshCatalog} fetches, and it need not
 * stay in step with {@link MODELS_OPENCODE_URL}: if the two ever diverge, the
 * OpenCode host wins, because that is the one the plugin reads.
 */
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

/**
 * Timeout for catalog revalidation requests.
 *
 * 8s was measured against the endpoint when it answered in ~200ms, and the
 * vendor has since slowed to 7-12s for the same payload. The budget was tighter
 * than the thing it budgets, so the freshness job - and every runtime revalidation
 * - failed with a `TimeoutError` rather than with a content mismatch. Two CI runs
 * on `catalog freshness` were this, not vendor churn.
 *
 * 30s is comfortably past the observed worst case while still bounded, because a
 * revalidation that hangs is worse than one that fails: the shim ships with the
 * bundled catalog, and the SWR refresh keeps serving it, so a slow answer costs
 * a wait and a dead one costs a retry.
 */
export const MODELS_DEV_TIMEOUT_MS = 30_000;

let activeGoCatalog = new Map<string, CatalogModelSpec>(
  OPENCODE_GO_CATALOG.map((m) => [m.id, m])
);
let activeZenCatalog = new Map<string, CatalogModelSpec>(
  OPENCODE_ZEN_CATALOG.map((m) => [m.id, m])
);
/**
 * Ids the most recent parse saw as `status: "deprecated"`, per plane.
 *
 * Kept beside the active maps because the ADAPTER's own discovery needs it:
 * `mergeDiscoveredModels` merges adapter rows before catalog rows, and pi's
 * installed snapshot still carries ids the live catalog has retired. Dropping
 * them from our catalog alone is not enough — the merge puts them back.
 */
const deprecatedGoIds = new Set<string>();
const deprecatedZenIds = new Set<string>();

let lastRefreshedAt = 0;
/**
 * Bumped whenever either active map is replaced, so a reader that derives
 * something from the catalog (the plane profiles) can tell its derivation is
 * stale without comparing maps.
 */
let generation = 0;
/** Called after a refresh replaced a map; see {@link onCatalogChange}. */
const changeListeners = new Set<() => void>();

/**
 * The catalog's generation: a number that changes whenever the live catalog
 * does, and only then.
 */
export const catalogGeneration = (): number => generation;

/**
 * Be told when a refresh lands new catalog data. The bundled shim is what a
 * process starts from, so the first reader of the catalog sees it and only
 * triggers the refresh; a listener is how that reader learns the refresh
 * landed. A listener that throws is ignored: the refresh stays a success.
 *
 * @param listener - called after the maps are replaced.
 * @returns the unsubscribe.
 */
export const onCatalogChange = (listener: () => void): (() => void) => {
  changeListeners.add(listener);
  return () => {
    changeListeners.delete(listener);
  };
};

/**
 * How many change listeners are subscribed: the probe that shows an
 * unsubscribe happened, since a stale listener that does nothing is otherwise
 * indistinguishable from none.
 */
export const catalogListenerCount = (): number => changeListeners.size;

/** Bump the generation and tell every listener. */
const catalogChanged = (): void => {
  generation += 1;
  for (const listener of changeListeners) {
    try {
      listener();
    } catch {
      // A listener's failure is its own; the catalog changed either way.
    }
  }
};
/**
 * Whether the MOST RECENT refresh attempt read a usable payload.
 *
 * Distinct from {@link lastRefreshedAt}, which only advances on success and so
 * answers "has this process ever refreshed?" — a question that stays `true` for
 * hours after a failure. A caller that must know whether THIS attempt landed
 * (the purge, which reports "nothing was deprecated" versus "the catalog could
 * not be read") needs this one.
 */
let lastRefreshSucceeded = false;
let refreshPromise:
  | Promise<{
      go: readonly CatalogModelSpec[];
      zen: readonly CatalogModelSpec[];
    }>
  | undefined;

/**
 * Put the catalog back to the bundled shim, as a fresh process holds it.
 *
 * The live maps, the retired-id sets and the refresh bookkeeping are module
 * state for the life of the process, which is right for the host and wrong for
 * a test: a case that refreshes from a fixture would otherwise decide what every
 * later case in the file sees. The sibling resets are `clearCapturedApiKeys` and
 * `clearSessionUsageStore`.
 */
export const resetCatalogState = (): void => {
  activeGoCatalog = new Map(OPENCODE_GO_CATALOG.map((m) => [m.id, m]));
  activeZenCatalog = new Map(OPENCODE_ZEN_CATALOG.map((m) => [m.id, m]));
  deprecatedGoIds.clear();
  deprecatedZenIds.clear();
  lastRefreshedAt = 0;
  lastRefreshSucceeded = false;
  refreshPromise = undefined;
  generation += 1;
};

export interface ParsedCatalogs {
  /**
   * The endpoint each plane's provider declares, read from the catalog itself
   * rather than assumed. `models.dev` puts it on the provider entry as `api`, and
   * the client consumes exactly this field
   * (`packages/core/src/models-dev.ts:107`, `settings: { baseURL: item.api }`).
   */
  api: { go: string; zen: string };
  /**
   * The endpoint each WIRE FAMILY declares, per plane, keyed by the SDK package
   * the catalog names for it (`""` for the provider default).
   *
   * The provider-level `api` above is not the whole story: the vendor serves
   * anthropic and google at their own paths, and declares that per model. Read
   * from the same data rather than restated in code, so a vendor move is a shim
   * regeneration and not a source change.
   */
  familyApi: { go: FamilyApi; zen: FamilyApi };
  go: CatalogModelSpec[];
  zen: CatalogModelSpec[];
}

/** One plane's endpoint per SDK package (`""` = the provider's own default). */
export type FamilyApi = Readonly<Record<string, string>>;

/** The endpoint a provider entry declares, or `""` when it declares none. */
const providerApiFor = (entry: unknown): string =>
  isRecord(entry) && typeof entry.api === "string" ? entry.api : "";

/**
 * Each wire family's endpoint, keyed by the SDK package that names it.
 *
 * A model's own `provider.api` wins; otherwise it inherits the provider's. The
 * first value seen for a package is kept — the vendor declares one endpoint per
 * family, and a second value would mean the assumption is wrong rather than that
 * the first should be replaced.
 *
 * **The keys come out SORTED, and that is load-bearing.** The map is built from
 * the order the vendor's JSON happens to list its models in, and that order is
 * not stable: the catalog re-serializes on its own schedule, and the same data
 * arrives with its models in a different sequence. The map is written verbatim
 * into the generated shim, so an unstable order means the nightly freshness job
 * finds a diff that contains no change at all — which is how a pull request
 * arrived whose entire content was three lines of key order.
 *
 * Sorting here fixes it at the source: the parser, the shim and the runtime
 * refresh all read the same map, so one rule governs all three. The values are
 * untouched; only the order is decided rather than inherited.
 *
 * @param entry - one provider entry from the catalog.
 * @returns the family map, empty when the entry carries no models.
 */
const familyApiFor = (entry: unknown): FamilyApi => {
  const found = new Map<string, string>();
  if (!isRecord(entry) || !isRecord(entry.models)) {
    // A plain object, not an empty Map: the caller compares these against `{}`
    // and a Map is a different shape, not an equal one.
    return {};
  }
  const providerApi = providerApiFor(entry);
  for (const rawModel of Object.values(entry.models)) {
    if (!isRecord(rawModel)) {
      continue;
    }
    const provider = isRecord(rawModel.provider) ? rawModel.provider : {};
    const npm = typeof provider.npm === "string" ? provider.npm : "";
    const api = typeof provider.api === "string" ? provider.api : providerApi;
    if (api.length > 0 && !found.has(npm)) {
      found.set(npm, api);
    }
  }
  // Sorted on the way out, so the map's order is decided here rather than
  // inherited from the vendor's serialization.
  const out: Record<string, string> = {};
  for (const key of [...found.keys()].toSorted()) {
    out[key] = found.get(key) ?? "";
  }
  return out;
};

/**
 * The thinking options a model declares, with unknown shapes dropped.
 *
 * A `type` is required because the options are discriminated by it; `values` and
 * `min` are optional and only carried when they are the right kind. An entry
 * that is not an object, or has no string `type`, is skipped rather than
 * repaired.
 *
 * @param raw - `models.dev`'s `reasoning_options`.
 * @returns the options, or `undefined` when there are none to carry.
 */
const sanitizeReasoningOptions = (
  raw: unknown
): ReasoningOptionSpec[] | undefined => {
  if (!Array.isArray(raw)) {
    return undefined;
  }
  const out: ReasoningOptionSpec[] = [];
  for (const entry of raw) {
    if (!isRecord(entry) || typeof entry.type !== "string") {
      continue;
    }
    const values = Array.isArray(entry.values)
      ? entry.values.filter((v): v is string => typeof v === "string")
      : undefined;
    const min = typeof entry.min === "number" ? entry.min : undefined;
    out.push({
      ...(min === undefined ? {} : { min }),
      type: entry.type,
      ...(values === undefined ? {} : { values }),
    });
  }
  return out.length === 0 ? undefined : out;
};

const extractSpecs = (
  modelsObj: Record<string, unknown>,
  defaultContext = 1_000_000,
  deprecated?: Set<string>
): CatalogModelSpec[] => {
  const results: CatalogModelSpec[] = [];
  for (const [id, rawModel] of Object.entries(modelsObj)) {
    if (!isRecord(rawModel)) {
      continue;
    }
    // The bundled shim ships active models only, and a refresh must agree with
    // it: merging a deprecated entry here would put a row the gateway no longer
    // serves back into the model picker on the next successful revalidation.
    //
    // The registry's `status: "deprecated"` is the ONLY source of retirement —
    // there is no hand-maintained list beside it. It was tried, and it failed in
    // the direction that matters: ids the gateway had deprecated stayed offered
    // because the registry lagged the gateway, while ids the registry flagged
    // too eagerly were kept on a hand list and went stale there as well. The
    // flag is also provider-scoped, which the hand list had to encode manually
    // (`muse-spark-1.2-contributor` is retired on zen by absence, served on go).
    // A row that is wrong anyway has a tripwire: `scripts/verify-catalog.ts
    // --probe` POSTs one token per id and fails on any offered model the
    // gateway no longer answers.
    if (rawModel.status === "deprecated") {
      // Recorded, not merely dropped. A model the registry has retired must not
      // come back through the ADAPTER's own discovery: `mergeDiscoveredModels`
      // merges adapter rows first, and pi's installed snapshot still lists ids
      // the live catalog has retired. Without this set the merge re-adds every
      // one, which is a picker led by models the vendor has retired.
      deprecated?.add(id);
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
    // The thinking level: whether the model takes one, and which kinds it takes.
    // Read here rather than derived, because the three shapes differ - effort
    // with values, a token budget with a minimum, and a plain toggle - and a
    // picker that guessed would offer a setting the model refuses.
    const reasoning =
      typeof rawModel.reasoning === "boolean" ? rawModel.reasoning : undefined;
    const reasoning_options = sanitizeReasoningOptions(
      rawModel.reasoning_options
    );
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
      ...(reasoning === undefined ? {} : { reasoning }),
      ...(reasoning_options === undefined ? {} : { reasoning_options }),
    });
  }
  return results;
};

/** Which of the two catalogs a model id should be read from. */
export type CatalogPlane = "go" | "zen";

/**
 * The plane a route's models come from.
 *
 * `opencode-go` is the subscription plane, and so is an `opencode-go-*` relay
 * route; everything else this plugin knows about (`opencode`) is Zen.
 */
export const catalogPlaneForRoute = (route: unknown): CatalogPlane =>
  route === "opencode-go" ||
  (typeof route === "string" && route.startsWith("opencode-go-"))
    ? "go"
    : "zen";

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
    return {
      api: { go: "", zen: "" },
      familyApi: { go: {}, zen: {} },
      go: [],
      zen: [],
    };
  }
  const goObj =
    isRecord(data["opencode-go"]) && isRecord(data["opencode-go"].models)
      ? data["opencode-go"].models
      : {};
  const zenObj =
    isRecord(data.opencode) && isRecord(data.opencode.models)
      ? data.opencode.models
      : {};

  deprecatedGoIds.clear();
  deprecatedZenIds.clear();
  return {
    api: {
      go: providerApiFor(data["opencode-go"]),
      zen: providerApiFor(data.opencode),
    },
    familyApi: {
      go: familyApiFor(data["opencode-go"]),
      zen: familyApiFor(data.opencode),
    },
    go: extractSpecs(goObj, 1_000_000, deprecatedGoIds),
    zen: extractSpecs(zenObj, 1_000_000, deprecatedZenIds),
  };
};

/**
 * Whether the most recent catalog parse saw `id` as retired on `plane`.
 *
 * The complement of {@link findModelSpecOn}: a model can be absent from the
 * catalog because it is NEW or because it is RETIRED, and the two want opposite
 * treatment in a merge. This is what tells them apart.
 *
 * @param plane - `zen` or `go`.
 * @param id - the model id to test.
 * @returns whether the registry has retired it.
 */
export const isDeprecatedModelOn = (plane: "go" | "zen", id: string): boolean =>
  (plane === "go" ? deprecatedGoIds : deprecatedZenIds).has(id);

/**
 * Whether a live parse has ever landed in this process.
 *
 * `refreshCatalog` never throws — an offline host keeps serving the shipped
 * shim — so a caller that needs to distinguish "the catalog says nothing is
 * retired" from "the catalog could not be read" has to ask this instead of
 * reading an empty result as an answer.
 */
export const isCatalogFresh = (): boolean => lastRefreshedAt > 0;

/**
 * Whether the most recent refresh attempt actually read the registry.
 *
 * Set to `false` when an attempt starts and only `true` by a payload that
 * parsed, so a caller can distinguish "the catalog says none are deprecated"
 * from "the catalog could not be read" — the two produce the same empty result
 * and must not produce the same sentence.
 *
 * `refreshCatalog` never rejects, so its promise resolving says nothing about
 * whether the read landed; this is the only way to tell.
 *
 * @returns whether the last attempt read a usable payload.
 */
export const didCatalogRefreshSucceed = (): boolean => lastRefreshSucceeded;

/**
 * Fetch and merge the latest live model specifications from the OpenCode
 * catalog (`models.opencode.ai`).
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
    // Cleared BEFORE the attempt: a success that happens to precede a failed
    // retry must not be reported as this attempt's outcome.
    lastRefreshSucceeded = false;
    try {
      const response = await fetchFn(MODELS_OPENCODE_URL, {
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
          lastRefreshSucceeded = true;
          catalogChanged();
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
 *
 * **Both endpoint families, and the newer one is the one that matters here.**
 * The Go plane's base is the `inference` family (`…/inference/go/openai/v1`),
 * and that path carries no `/models` of its own — the listing lives on the
 * older `zen/go` route, so the answer the gateway gives is a 404 and this
 * enrichment is what fills it. Reading the plane by substring instead put the
 * modern Go path in the ZEN bucket, and the Go plane was then answered with the
 * ZEN catalog: every Zen model, and none of the Go plane's own.
 */
export const isGoModelsListingUrl = (
  url: string,
  gatewayUrls?: readonly string[]
): boolean => isModelsListingUrl(url, gatewayUrls) && isGoPlaneUrl(url);

/**
 * Merge and enrich a gateway `/models` response with the complete OpenCode Go or Zen catalog.
 *
 * Passes any non-2xx other than a 404 through unchanged: a 401, a 403, a 429 or
 * a 5xx is the gateway's verdict on the request — a missing or refused key, a
 * tier the account lacks, a rate limit, an outage — and answering it with a
 * catalog told the caller the listing had succeeded. A 404 is filled on both
 * planes with that plane's catalog: the Go plane's inference base has no
 * `/models` of its own, so the plane's catalog IS the listing there, and a Zen
 * base without one is answered the same way.
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
  if (!response.ok && response.status !== 404) {
    return response;
  }
  let existingData: Record<string, unknown>[] = [];
  try {
    const raw: unknown = await response.clone().json();
    if (isRecord(raw) && Array.isArray(raw.data)) {
      existingData = raw.data.filter(isRecord);
    }
  } catch {
    // A 2xx or 404 whose body is not JSON still yields the full catalog.
  }

  // The plane from the PATH alone. The caller has already decided this is a
  // listing, against the deployment's own gateway markers; asking
  // `isGoModelsListingUrl` again applied the DEFAULT markers, so a relay's
  // `/zen/go/v1/models` was answered with the Zen catalog.
  const isGo = isGoPlaneUrl(url);
  const catalog = isGo ? getLiveGoCatalog(fetchFn) : getLiveZenCatalog(fetchFn);
  const catalogById = new Map(catalog.map((m) => [m.id, m]));
  const merged = new Map<string, Record<string, unknown>>();

  // **This is the CATALOG surface, so it is the one place that seeds.**
  // `discoverModels` in `dsh-llm-pi-ai` returns its installed catalog for a
  // provider it ships and only fetches an endpoint for one it does not — so a
  // `/models` answer is "what this endpoint offers", the list a user browses, not
  // the list a picker shows. Widening is right here and wrong anywhere that
  // decides what a deployment may pick.
  //
  // The seed also covers the ordinary case of a gateway answering with a subset:
  // the vendor's own listing is narrower than its catalog.
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
  for (const item of existingData) {
    const id = typeof item.id === "string" ? item.id : "";
    if (id.length === 0) {
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
