/**
 * `dsh-opencode-patch` — host plugin entry.
 *
 * This module is intentionally thin: identity constants, the `apply()`
 * lifecycle, and the re-exported public surface. Everything else moved to
 * the module that owns the concern:
 *
 * | module             | concern                                          |
 * | ------------------ | ------------------------------------------------ |
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
 * | `debug.ts`         | JSONL stream-debug append log                    |
 *
 * @module dsh-opencode-patch
 */

import { AsyncLocalStorage } from "node:async_hooks";

import { type PluginConfig, resolveConfig } from "./config.ts";
import { type CordisContext, readEntryOptions } from "./cordis-context.ts";
import { patchFetch } from "./fetch-patch.ts";
import { resolveGoBaseURL } from "./go-discovery.ts";
import { isFetchFunction } from "./guards.ts";
import {
  getLiveGoCatalog,
  getLiveZenCatalog,
  type CatalogModelSpec,
} from "./models-catalog.ts";
import { createStreamHook } from "./stream-hook.ts";
import type { ActiveTurnState } from "./turn-store.ts";
import { registerUsageRemotes, GoUsageService } from "./usage.ts";

/** Component identity (log lines, service scoping). */
export const name = "dsh-opencode-patch";
/** Pre-rename component identity; rows using it get a rename notice. */
export const LEGACY_NAME = "dsh-opencode";
/** Pre-rename npm package; rows using it get a rename notice. */
export const LEGACY_PKG = "@viztor/dsh-opencode";
/** Host injections: the plugin needs the `llm` stream lifecycle. */
export const inject = ["llm"];

// ── public surface ──────────────────────────────────────────────────────────
export {
  CONFIG_DEFAULTS,
  Config,
  DEFAULT_FREE_MODEL_MARKER,
  DEFAULT_GATEWAY_URLS,
  DEFAULT_INJECT_PROJECT,
  DEFAULT_ORIGIN_CLIENT,
  DEFAULT_PROVIDERS,
  DEFAULT_SESSION_ID_ENV,
  DEFAULT_USAGE_BASE_URL,
  DEFAULT_USAGE_KEY_ENV,
  DEFAULT_USAGE_PROVIDER_MARKERS,
  resolveConfig,
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
export {
  discoverGoConfig,
  effectiveGoKeyRef,
  resolveGoApiKey,
  resolveGoBaseURL,
} from "./go-discovery.ts";
export { GoUsageService, registerUsageRemotes } from "./usage.ts";
export {
  parseGoUsage,
  parseUsageQuery,
  type GoUsage,
  type UsageQuery,
  type UsageWindow,
  usageRemote,
} from "./usage-contract.ts";
export {
  CATALOG_REVALIDATION_TTL_MS,
  MODELS_DEV_TIMEOUT_MS,
  MODELS_DEV_URL,
  OPENCODE_GO_CATALOG,
  OPENCODE_ZEN_CATALOG,
  enrichModelsResponse,
  getLiveCatalog,
  getLiveGoCatalog,
  getLiveZenCatalog,
  isGoModelsListingUrl,
  isModelsListingUrl,
  parseModelsDevCatalog,
  refreshCatalog,
  type CatalogModelSpec,
  type ParsedCatalogs,
} from "./models-catalog.ts";
export { resolveRoutedKey, type RoutedKeyDetails } from "./go-discovery.ts";
export {
  calculateTurnCost,
  clearSessionUsageStore,
  formatModelRate,
  formatUsd,
  getSessionUsage,
  recordTurnUsage,
  type ModelCostRate,
  type SessionUsageSnapshot,
} from "./session-cost.ts";

/** One catalog row in the shape DSH's model-discovery surface expects. */
const toDiscovered = (specs: readonly CatalogModelSpec[]) =>
  specs.map((m) => ({
    contextWindow: m.context_window,
    id: m.id,
    inputModalities: m.input_modalities,
    maxTokens: m.max_output_tokens,
    name: m.name,
  }));

/**
 * Plugin entry: register the quota service, patch `fetch` for OpenCode
 * traffic, and capture turn state for configured providers.
 *
 * Order matters: the quota service registers before the fetch patch so a
 * composition without `globalThis.fetch` still gets a working meter, while
 * the fetch patch itself refuses to install when there is nothing to wrap
 * (warning and returning early — `on` must not be attached when no patch
 * exists, or turns would run without session affinity).
 */
export const apply = (
  ctx: CordisContext,
  rawConfig: PluginConfig = {}
): void => {
  const config = resolveConfig(rawConfig);
  const { providers } = config;
  const als = new AsyncLocalStorage<ActiveTurnState>();

  const entryOptions = readEntryOptions(ctx);
  if (entryOptions?.name === LEGACY_PKG || entryOptions?.id === LEGACY_NAME) {
    ctx.logger?.info?.(
      '[dsh-opencode-patch] Notice: "@viztor/dsh-opencode" has been renamed to "dsh-opencode-patch". Please update your profile configuration.'
    );
  }

  if (config.usageEnabled && typeof ctx.plugin === "function") {
    ctx.plugin(GoUsageService, {
      baseURL: () => resolveGoBaseURL(ctx, config.usageBaseURL),
      keyEnv: config.usageKeyEnv,
    });
    registerUsageRemotes(ctx);
  }

  const originalFetch: unknown = globalThis.fetch;
  if (!isFetchFunction(originalFetch)) {
    ctx.logger?.warn?.(
      "[dsh-opencode-patch] globalThis.fetch is unavailable; cannot inject x-opencode-session"
    );
    return;
  }

  const patched = patchFetch(originalFetch, als, config);

  ctx.effect?.(() => {
    globalThis.fetch = patched;
    ctx.logger?.info?.(
      "[dsh-opencode-patch] active for providers [%s]",
      [...providers].join(", ")
    );
    return () => {
      if (globalThis.fetch === patched) {
        globalThis.fetch = originalFetch;
      }
    };
  }, "dsh-opencode-patch.fetch-patch");

  ctx.on?.("llm/stream", createStreamHook(ctx, config, als), { prepend: true });

  // Model discovery is part of the same "canonical catalog" feature as the
  // gateway listing enrichment, so both sit behind the one toggle: turning it
  // off leaves DSH's own catalog and the raw gateway listings untouched.
  if (config.enrichModels) {
    try {
      if (typeof ctx.llm?.registerModelDiscovery === "function") {
        ctx.llm.registerModelDiscovery(name, () =>
          Promise.resolve(
            toDiscovered([...getLiveGoCatalog(), ...getLiveZenCatalog()])
          )
        );
        ctx.llm.registerModelDiscovery("opencode-go", () =>
          Promise.resolve(toDiscovered(getLiveGoCatalog()))
        );
        ctx.llm.registerModelDiscovery("opencode", () =>
          Promise.resolve(toDiscovered(getLiveZenCatalog()))
        );
      }
    } catch {
      // Model discovery registration is non-fatal
    }
  }
};
