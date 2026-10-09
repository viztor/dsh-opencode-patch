/**
 * `dsh-opencode-patch` — host plugin entry (public barrel).
 *
 * This module is intentionally thin: it re-exports identity, the `apply()`
 * lifecycle, and the public surface of every module. Each concern lives in
 * the module that owns it:
 *
 * | module             | concern                                          |
 * | ------------------ | ------------------------------------------------ |
 * | `identity.ts`      | component/package name constants + `inject`      |
 * | `lifecycle.ts`     | `apply()` and its per-side-effect installers     |
 * | `guards.ts`        | structural `unknown` predicates                  |
 * | `config-values.ts` | host/client-shared config coercion readers       |
 * | `config.ts`        | defaults, types, resolver, settings schema       |
 * | `session.ts`       | deterministic `ses_…` session identity           |
 * | `turn-store.ts`    | ALS turn state carried across a streamed turn    |
 * | `tool-fallback.ts` | free-tier `/responses` read+bash schema fallback |
 * | `fetch-patch.ts`   | gateway request recognition + header fixes       |
 * | `stream-hook.ts`   | `llm/stream` turn capture                        |
 * | `cordis-context.ts`| structural view of the Cordis host context       |
 * | `go-discovery.ts`  | Go credential/gateway discovery + resolution     |
 * | `usage.ts`         | Go quota service + typert remote registration    |
 * | `usage-contract.ts`| remote shapes, validation, typert descriptor     |
 * | `session-cost.ts`  | per-turn token/dollar accounting                 |
 * | `catalog-data.ts`  | the static Go/Zen model catalog (pure data)      |
 * | `models-catalog.ts`| catalog parsing, SWR refresh, `/models` enrich   |
 * | `models-discovery.ts` | provider-aware model-discovery decoration     |
 * | `debug.ts`         | JSONL stream-debug append log                    |
 *
 * @module dsh-opencode-patch
 */

// ── identity & lifecycle ────────────────────────────────────────────────────
export { inject, LEGACY_NAME, LEGACY_PKG, name } from "./identity.ts";
export { apply } from "./lifecycle.ts";

// ── configuration ───────────────────────────────────────────────────────────
export {
  CONFIG_DEFAULTS,
  Config,
  DEFAULT_FREE_MODEL_MARKER,
  DEFAULT_GATEWAY_URLS,
  DEFAULT_INJECT_PROJECT,
  DEFAULT_KEY_SOURCE,
  DEFAULT_ORIGIN_CLIENT,
  DEFAULT_PROVIDERS,
  DEFAULT_SESSION_ID_ENV,
  DEFAULT_USAGE_BASE_URL,
  DEFAULT_USAGE_KEY_ENV,
  KEY_SOURCE_POLICIES,
  resolveConfig,
  type KeySourcePolicy,
  type PluginConfig,
  type ResolvedPluginConfig,
} from "./config.ts";
export {
  ALL_MODELS_MARKER,
  readBoolean,
  readString,
  readStringList,
  unwrapNode,
} from "./config-values.ts";

// ── session identity & turn state ───────────────────────────────────────────
export {
  fallbackSessionId,
  headerValueFor,
  openCodeSessionIdFor,
  OPENCODE_UA,
  PARENT_SESSION_ALT_HEADER,
  PARENT_SESSION_HEADER,
  SESSION_AFFINITY_HEADER,
  SESSION_HEADER,
} from "./session.ts";
export { type ActiveTurnState, withStore } from "./turn-store.ts";

// ── request patching ────────────────────────────────────────────────────────
export {
  DUMMY_BASH_TOOL,
  DUMMY_READ_TOOL,
  isCoreToolModel,
  maybeInjectCoreTools,
  RESPONSES_PATH,
} from "./tool-fallback.ts";
export {
  hasSessionHeader,
  isOpenCodeRequest,
  patchFetch,
} from "./fetch-patch.ts";
export { type CordisContext } from "./cordis-context.ts";

// ── Go discovery & quota ────────────────────────────────────────────────────
export {
  clearCapturedApiKeys,
  extractApiKeyFromHeaders,
  getCapturedApiKey,
  isPlaceholderApiKey,
  recordCapturedApiKey,
  tierForRequest,
} from "./key-capture.ts";
export {
  discoverGoConfig,
  effectiveGoKeyRef,
  resolveGoApiKey,
  resolveGoBaseURL,
  resolveRoutedKey,
  resolveZenCreditInfo,
  toGoBaseURL,
  type RoutedKeyDetails,
} from "./go-discovery.ts";
export { GoUsageService } from "./usage.ts";
export {
  parseGoUsage,
  parseUsageQuery,
  type GoUsage,
  type UsageQuery,
  type UsageWindow,
} from "./usage-contract.ts";
export {
  calculateTurnCost,
  clearSessionUsageStore,
  describeModel,
  formatModelRate,
  formatUsd,
  getSessionUsage,
  recordTurnUsage,
  type ModelCostRate,
  type SessionUsageSnapshot,
} from "./session-cost.ts";

// ── model catalog & discovery ───────────────────────────────────────────────
export {
  CATALOG_REVALIDATION_TTL_MS,
  DSH_SUPPORTED_MODALITIES,
  MODELS_DEV_TIMEOUT_MS,
  MODELS_DEV_URL,
  OPENCODE_GO_CATALOG,
  OPENCODE_ZEN_CATALOG,
  RETIRED_ZEN_MODEL_IDS,
  enrichModelsResponse,
  catalogPlaneForRoute,
  findModelSpec,
  findModelSpecOn,
  getLiveCatalog,
  getLiveGoCatalog,
  getLiveZenCatalog,
  isGoModelsListingUrl,
  isModelsListingUrl,
  isRetiredModel,
  parseModelsDevCatalog,
  refreshCatalog,
  sanitizeModalities,
  type CatalogModelSpec,
  type CatalogProvider,
  type ParsedCatalogs,
} from "./models-catalog.ts";
export {
  decorateModelDiscovery,
  hideResponsesRoute,
  isRouteRegistered,
  mergeDiscoveredModels,
  resolveDiscoveryProvider,
  type DiscoveryCandidate,
} from "./models-discovery.ts";
export {
  ANTHROPIC_ROUTE,
  ANTHROPIC_SDK,
  INTERNAL_ROUTES,
  PROTOCOL_FOR_SDK,
  RESPONSES_ROUTE,
  RESPONSES_SDK,
  ROUTE_FOR_PROTOCOL,
  UNSERVED_SDKS,
  internalRouteFor,
  isInternalRoute,
  isServableSdk,
} from "./responses-routes.ts";
export {
  inheritedCredentialRef,
  loadPiAi,
  modelsForSdk,
  registerResponsesProvider,
} from "./responses-provider.ts";
