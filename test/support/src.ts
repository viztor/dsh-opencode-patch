/**
 * The single indirection through which tests reach `src`.
 *
 * The package's public barrel is the host's contract — `apply`, `Config`,
 * `inject`, `name` and the config types — and nothing else, and P10a
 * moves modules into subject folders. A test that names a `src` path breaks on
 * every such move, so this file is the one place that knows where things live:
 * each name is re-exported from the module that DEFINES it, never through the
 * public barrel. `test/architecture.test.ts` enforces both halves.
 *
 * What keeps its direct path, because the path is its subject or the door
 * would load too much:
 *
 * - a `vi.mock("../src/x.ts")` target and its `importOriginal<typeof
 *   import(…)>` type (vitest mocks by module id);
 * - a fresh-module re-import after `vi.resetModules()` (`purge-service.test.ts`);
 * - the architecture and public-API tests, which are about the `src` layout
 *   and the barrel themselves;
 * - the jsdom (client) tests, because this file re-exports the host graph
 *   (`node:sqlite`, pi, `lifecycle.ts`) and that must stay out of a client
 *   test;
 * - the setup file `test/support/reset-process-state.ts`, which runs before
 *   every test, jsdom ones included, for the same reason; the other setup
 *   file, `offline.ts`, touches no `src` module and is walked like any test.
 *
 * Importing this file loads the whole `src` graph, host and client, so a module
 * that fails to load fails every test that comes through here, not only its own.
 *
 * Two names are defined twice under one name, so the second definition is
 * aliased: the client bundle's `apply` (`applySettingsPage`) and the Go
 * allowance formatter `formatUsd` (`formatAllowanceUsd`).
 *
 * The file is type-checked with the rest of `test/`, so `vp check` proves that
 * every re-export resolves.
 *
 * @module test/support/src
 */

// attachment-services.ts
export { attachmentResolvers } from "../../src/attachment-services.ts";

// catalog-data.ts
export {
  OPENCODE_FAMILY_API,
  OPENCODE_GO_CATALOG,
  OPENCODE_PLANE_API,
  OPENCODE_ZEN_CATALOG,
} from "../../src/catalog-data.ts";
export type { CatalogModelSpec } from "../../src/catalog-data.ts";

// config-values.ts
export {
  ALL_MODELS_MARKER,
  DEFAULT_ENDPOINT_FAMILY,
  DEFAULT_KEY_SOURCE,
  DEFAULT_PROVIDERS,
  ENDPOINT_FAMILIES,
  KEY_SOURCE_POLICIES,
  readBoolean,
  readString,
  readStringList,
  unwrapNode,
} from "../../src/config-values.ts";

// config.ts
export {
  Config,
  CONFIG_DEFAULTS,
  DEFAULT_FREE_MODEL_MARKER,
  DEFAULT_USAGE_BASE_URL,
  DEFAULT_USAGE_KEY_ENV,
  resolveConfig,
} from "../../src/config.ts";
export type { PluginConfig, ResolvedPluginConfig } from "../../src/config.ts";

// cordis-context.ts
export {
  loadHostModules,
  loaderOfContext,
  PI_AI_RUNTIME,
  piAiFibers,
  readCredentialsResolver,
  readEntryOptions,
  readLaunchEnvironment,
  readSessionMetaResolver,
  replaceHostModuleSource,
} from "../../src/cordis-context.ts";
export type {
  CordisContext,
  HostLibraries,
  HostModules,
  HostModuleSource,
  PiAiModule,
} from "../../src/cordis-context.ts";

// debug.ts
export { recordDebug } from "../../src/debug.ts";

// fetch-patch.ts
export {
  hasSessionHeader,
  isOpenCodeRequest,
  patchFetch,
} from "../../src/fetch-patch.ts";
export type { FetchPatchHooks } from "../../src/fetch-patch.ts";

// go-discovery.ts
export {
  discoverGoConfig,
  effectiveGoKeyRef,
  resolveGoApiKey,
  resolveGoBaseURL,
  resolveGoKeyForRef,
  resolveOpencodeStoreKey,
  resolveZenCreditInfo,
  toGoBaseURL,
} from "../../src/go-discovery.ts";
export type { DiscoveredGoConfig } from "../../src/go-discovery.ts";

// go-limits-data.ts
export { GO_MODEL_LIMITS } from "../../src/go-limits-data.ts";

// go-limits.ts
export {
  allowanceFor,
  formatUsd as formatAllowanceUsd,
  GO_PLAN_TIERS,
  normalizeModelLabel,
  parseGoLimitsDoc,
  WINDOW_SHARE,
} from "../../src/go-limits.ts";

// host/describe-graft.ts
export {
  graftPlaneEntries,
  installDescribeGraft,
} from "../../src/host/describe-graft.ts";

// host/host-modules.ts
export {
  asPiAiModule,
  defaultHostModuleSource,
  loadHostPi,
  loadLibrariesFrom,
  loadPiAiModule,
  wrapperEntryFor,
} from "../../src/host/host-modules.ts";
export type { HostPi } from "../../src/host/host-modules.ts";

// host/google-levels.ts
export { withCatalogThinkingLevels } from "../../src/host/google-levels.ts";
export type {
  GoogleLevelPieces,
  GoogleLevelSource,
} from "../../src/host/google-levels.ts";

// host/plane-provider.ts
export {
  buildPlaneProvider,
  createPlaneAdapter,
  hostError,
  planeApiKeyResolver,
  planeAuth,
  relabelEfforts,
} from "../../src/host/plane-provider.ts";

// host/route-claim.ts
export { installRouteClaim } from "../../src/host/route-claim.ts";

// host/patch-method.ts
export {
  inspectPatch,
  patchMethod,
  rewrapOnAdaptersUpdated,
} from "../../src/host/patch-method.ts";

// identity.ts
export {
  inject,
  name,
  OPENCODE_PATCH_USER_AGENT,
  OPENCODE_USER_AGENT,
} from "../../src/identity.ts";

// key-capture.ts
export {
  clearCapturedApiKeys,
  extractApiKeyFromHeaders,
  getCapturedApiKey,
  isPlaceholderApiKey,
  recordCapturedApiKey,
  tierForRequest,
} from "../../src/key-capture.ts";

// lifecycle.ts
export { apply } from "../../src/lifecycle.ts";

// models-catalog.ts
export {
  catalogGeneration,
  catalogListenerCount,
  catalogPlaneForRoute,
  enrichModelsResponse,
  findModelSpec,
  findModelSpecOn,
  getLiveGoCatalog,
  getLiveZenCatalog,
  isDeprecatedModelOn,
  isGoModelsListingUrl,
  isModelsListingUrl,
  MODELS_OPENCODE_URL,
  onCatalogChange,
  parseModelsDevCatalog,
  refreshCatalog,
  resetCatalogState,
  sanitizeModalities,
} from "../../src/models-catalog.ts";

// models-discovery.ts
export {
  decorateModelDiscovery,
  mergeDiscoveredModels,
  resolveDiscoveryProvider,
} from "../../src/models-discovery.ts";

// opencode-paths.ts
export {
  opencodeDatabaseFile,
  opencodeDatabasePath,
  opencodeRoots,
} from "../../src/opencode-paths.ts";

// opencode-store-service.ts
export { OpencodeStoreService } from "../../src/opencode-store-service.ts";

// opencode-store.ts
export {
  inspectOpencodeStore,
  readOpencodeCredentials,
  summarizeCredential,
} from "../../src/opencode-store.ts";

// purge-contract.ts
export { parsePurgeResult } from "../../src/purge-contract.ts";

// purge-service.ts
export {
  ModelPurgeService,
  stripRetiredReferences,
} from "../../src/purge-service.ts";

// session-cost.ts
export {
  calculateTurnCost,
  clearSessionUsageStore,
  describeModel,
  formatModelRate,
  formatUsd,
  getSessionUsage,
  recordTurnUsage,
} from "../../src/session-cost.ts";
export type {
  ModelCostRate,
  SessionUsageSnapshot,
} from "../../src/session-cost.ts";

// session.ts
export {
  fallbackSessionId,
  headerValueFor,
  newOpenCodeMessageId,
  OPENCODE_UA,
  openCodeSessionIdFor,
} from "../../src/session.ts";

// settings-boolean-field.tsx
export { SettingsBooleanField } from "../../src/settings-boolean-field.tsx";
export type { BooleanFieldProps } from "../../src/settings-boolean-field.tsx";

// settings-card.tsx
export { OpencodeCard, purgeLine } from "../../src/settings-card.tsx";

// settings-choice-field.tsx
export { SettingsChoiceField } from "../../src/settings-choice-field.tsx";
export type { ChoiceFieldProps } from "../../src/settings-choice-field.tsx";

// settings-copy.ts
export { en, withBundleCopy, zh } from "../../src/settings-copy.ts";

// settings-field-shell.tsx
export { SettingsFieldShell } from "../../src/settings-field-shell.tsx";
export type { FieldShellProps } from "../../src/settings-field-shell.tsx";

// settings-fields.ts
export {
  CARD_FIELDS,
  CONFIG_ONLY_FIELDS,
  SPECS,
} from "../../src/settings-fields.ts";

// settings-page.tsx
export {
  apply as applySettingsPage,
  LEGACY_NS,
  NS,
  patchRemote,
  PKG,
  SCOPED_PKG,
} from "../../src/settings-page.tsx";

// settings-purge.ts
export { purgeDeprecatedModels } from "../../src/settings-purge.ts";

// settings-remote.ts
export {
  remoteNamespace,
  remoteNamespaceOf,
} from "../../src/settings-remote.ts";

// settings-store-inspect.tsx
export {
  inspectLine,
  StoreInspectRow,
} from "../../src/settings-store-inspect.tsx";

// settings-store.ts
export { inspectStore } from "../../src/settings-store.ts";
export type { StoreInspectOutcome } from "../../src/settings-store.ts";

// settings-usage.tsx
export {
  readGoUsage,
  readUntilAnswered,
  UsageSummary,
  UsageSummaryView,
} from "../../src/settings-usage.tsx";

// stream-hook.ts
export { createStreamHook, projectNameFrom } from "../../src/stream-hook.ts";

// tool-fallback.ts
export {
  DUMMY_BASH_TOOL,
  DUMMY_BASH_TOOL_FUNCTION,
  DUMMY_READ_TOOL,
  DUMMY_READ_TOOL_FUNCTION,
  isCoreToolModel,
  maybeInjectCoreTools,
  RESPONSES_PATH,
} from "../../src/tool-fallback.ts";

// turn-store.ts
export { withStore } from "../../src/turn-store.ts";
export type { ActiveTurnState } from "../../src/turn-store.ts";

// usage-contract.ts
export { parseGoUsage, parseUsageQuery } from "../../src/usage-contract.ts";
export type { GoUsage } from "../../src/usage-contract.ts";

// usage-panel.tsx
export { UsagePanel, UsageTrigger } from "../../src/usage-panel.tsx";
export type {
  UsagePanelProps,
  UsageTriggerProps,
} from "../../src/usage-panel.tsx";

// usage-pill.tsx
export { MIN_FEEDBACK_MS, UsagePill } from "../../src/usage-pill.tsx";
export type {
  ModelDirectoryState,
  SnapshotStore,
} from "../../src/usage-pill.tsx";

// usage-ui.ts
export {
  CIRCUMFERENCE,
  CONSOLE_URL,
  describeUsage,
  formatRelativeReset,
  getAffectingWindow,
  getWindowColorFor,
  GO_PLAN_URL,
  matchesAny,
  parseFailure,
  resetLabel,
  ringGeometry,
  STYLES,
} from "../../src/usage-ui.ts";
export type { RelativeReset } from "../../src/usage-ui.ts";

// usage.ts
export { GoUsageService } from "../../src/usage.ts";

// utils/guards.ts
export {
  getAsyncIterator,
  isAsyncIterableLike,
  isAsyncIteratorLike,
  isFetchFunction,
  isFunctionLike,
  isRecord,
  isUnknownArray,
} from "../../src/utils/guards.ts";

// utils/model-metadata.ts
export {
  canDisableReasoning,
  effortName,
  PI_LEVELS,
  piReasoningFromEfforts,
  reasoningFor,
  usesCatalogThinkingLevels,
} from "../../src/utils/model-metadata.ts";

// utils/plane-model.ts
export {
  AUTO_ENDPOINT_FAMILY,
  baseUrlFor,
  planeModelFor,
} from "../../src/utils/plane-model.ts";
export type {
  EndpointChoice,
  PlaneCatalogSpec,
  PlaneModelInput,
  PlanePiModel,
} from "../../src/utils/plane-model.ts";

// utils/plane-profile.ts
export {
  hasPlaneEntries,
  planeEntriesOf,
  planeProfileFor,
  withoutPlaneProviders,
} from "../../src/utils/plane-profile.ts";
export type { PlaneProfileInput } from "../../src/utils/plane-profile.ts";

// utils/protocols.ts
export {
  allOfferedCompatFields,
  ANTHROPIC_SDK,
  COMPAT_GATES,
  compatProtocols,
  FAMILY_SDK_KEY,
  GO_GOOGLE_BASE_URL,
  GOOGLE_SDK,
  isGatedCompatField,
  isPlaneRoute,
  isProtocol,
  isServableSdk,
  LEGACY_BASE,
  LEGACY_PLANE_API,
  MISTRAL_SDK,
  MODERN_FALLBACK,
  OFFERED_COMPAT,
  PLANE_ROUTES,
  PROTOCOL_FOR_SDK,
  protocolForSdk,
  PROTOCOLS,
  RESPONSES_SDK,
} from "../../src/utils/protocols.ts";
export type { PlaneRoute, Protocol } from "../../src/utils/protocols.ts";

// utils/request-shape.ts
export {
  ANTHROPIC_VERSION,
  authHeaderFor,
  gatewayPlaneFor,
  headerSourceOf,
  isGoPlaneUrl,
  isZenProvider,
  modelIdOf,
  requestUrlOf,
  toolNamesOf,
} from "../../src/utils/request-shape.ts";

// utils/retry.ts
export { backoffOver, retryUntilAnswered } from "../../src/utils/retry.ts";
export type { RetryOptions, RetryTimer } from "../../src/utils/retry.ts";

// utils/session-id.ts
export {
  isOpenCodeMessageId,
  isOpenCodeSessionId,
  PARENT_SESSION_ALT_HEADER,
  PARENT_SESSION_HEADER,
  SESSION_AFFINITY_HEADER,
  SESSION_HEADER,
  sessionIdForRequest,
} from "../../src/utils/session-id.ts";
