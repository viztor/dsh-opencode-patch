/**
 * Host-side plugin configuration: defaults, raw/resolved types, the row
 * schema, and the resolver that folds either into one resolved shape.
 *
 * Every default lives exactly once — in {@link CONFIG_DEFAULTS} — and both
 * `resolveConfig` and the `Config` schema read from it, so the schema and the
 * resolver cannot drift apart (the "defaults mirror resolveConfig" contract
 * is structural rather than a comment asking future editors to keep two
 * literal lists in sync).
 *
 * @module dsh-opencode-patch/config
 */

import z from "@deepseek-ai/schemastery";

import {
  DEFAULT_USAGE_MODEL_MARKERS,
  DEFAULT_USAGE_PROVIDER_MARKERS,
  readBoolean,
  readString,
  readStringList,
} from "./config-values.ts";

// Re-exported so the public surface keeps one import site: the markers are
// defined client-side (in `config-values.ts`) because the pill's fallback
// gate reads them too, but consumers of the config module still get them.
export { DEFAULT_USAGE_MODEL_MARKERS, DEFAULT_USAGE_PROVIDER_MARKERS };

/** Provider route keys the plugin intercepts out of the box. */
export const DEFAULT_PROVIDERS = ["opencode", "opencode-go"];

/**
 * URL substrings that mark a request as OpenCode gateway traffic even when no
 * turn is active. Configurable so mirrors, proxies, and self-hosted gateways
 * can be targeted without a code change.
 */
export const DEFAULT_GATEWAY_URLS = ["opencode.ai/zen"];

/** Value restored into `x-opencode-client` by default. */
export const DEFAULT_ORIGIN_CLIENT = "cli";

/** Value restored into `x-opencode-project` by default. */
export const DEFAULT_ORIGIN_PROJECT = "global";

/**
 * Model-id substring that marks a request as free-tier (and therefore in need
 * of the core-tool schema fallback).
 */
export const DEFAULT_FREE_MODEL_MARKER = "free";

/** Environment variable consulted for the fallback session id. */
export const DEFAULT_SESSION_ID_ENV = "OPENCODE_SESSION_ID";

/** Default OpenCode Go quota endpoint. */
export const DEFAULT_USAGE_BASE_URL = "https://opencode.ai/zen/go/v1";

/** Default environment variable / credential ref holding the Go key. */
export const DEFAULT_USAGE_KEY_ENV = "OPENCODE_GO_API_KEY";

/**
 * The single source of truth for every documented default. Blank / absent
 * user values fall back to these; the `Config` schema `.default()`s to the
 * same values.
 */
export const CONFIG_DEFAULTS = {
  debug: false,
  freeModelMarker: DEFAULT_FREE_MODEL_MARKER,
  gatewayUrls: DEFAULT_GATEWAY_URLS,
  injectCoreTools: true,
  injectOriginHeaders: true,
  injectUserAgent: true,
  originClient: DEFAULT_ORIGIN_CLIENT,
  originProject: DEFAULT_ORIGIN_PROJECT,
  providers: DEFAULT_PROVIDERS,
  sessionIdEnv: DEFAULT_SESSION_ID_ENV,
  usageBaseURL: DEFAULT_USAGE_BASE_URL,
  usageEnabled: true,
  usageKeyEnv: DEFAULT_USAGE_KEY_ENV,
  usageModelMarkers: DEFAULT_USAGE_MODEL_MARKERS,
  usageProviderMarkers: DEFAULT_USAGE_PROVIDER_MARKERS,
} as const;

/** The raw shape a cordis row's `config` may carry (all optional). */
export interface PluginConfig {
  debug?: boolean;
  debugFile?: string;
  freeModelMarker?: string;
  gatewayUrls?: string[];
  injectCoreTools?: boolean;
  injectOriginHeaders?: boolean;
  injectUserAgent?: boolean;
  originClient?: string;
  originProject?: string;
  providers?: string[];
  sessionIdEnv?: string;
  userAgent?: string;
  usageBaseURL?: string;
  usageKeyEnv?: string;
  usageEnabled?: boolean;
  usageModelMarkers?: string[];
  usageProviderMarkers?: string[];
}

/** The fully-defaulted shape the plugin's runtime branches read. */
export interface ResolvedPluginConfig {
  debug: boolean;
  debugFile?: string;
  /** `*` when the core-tool fallback should run for every model. */
  freeModelMarker: string;
  /** URL substrings marking gateway traffic; never empty after resolution. */
  gatewayUrls: string[];
  injectCoreTools: boolean;
  injectOriginHeaders: boolean;
  injectUserAgent: boolean;
  originClient: string;
  originProject: string;
  providers: Set<string>;
  sessionIdEnv: string;
  userAgent?: string;
  usageBaseURL: string;
  usageEnabled: boolean;
  usageKeyEnv: string;
  usageModelMarkers: string[];
  usageProviderMarkers: string[];
}

/**
 * Fold a raw row config (or schema-validated output) into the resolved shape.
 *
 * Blank strings and empty lists inherit the defaults, so a row that mentions a
 * key without a usable value behaves exactly like a row that omits it.
 *
 * @param rawInput - raw or validated row config.
 */
export const resolveConfig = (
  rawInput: PluginConfig = {}
): ResolvedPluginConfig => {
  const config = rawInput ?? {};

  const providers = readStringList(config.providers);
  const gatewayUrls = readStringList(config.gatewayUrls);
  const usageProviderMarkers = readStringList(config.usageProviderMarkers);
  const usageModelMarkers = readStringList(config.usageModelMarkers);

  return {
    debug: readBoolean(config.debug, CONFIG_DEFAULTS.debug),
    debugFile: readString(config.debugFile),
    freeModelMarker:
      readString(config.freeModelMarker) ?? CONFIG_DEFAULTS.freeModelMarker,
    gatewayUrls:
      gatewayUrls.length > 0 ? gatewayUrls : [...CONFIG_DEFAULTS.gatewayUrls],
    injectCoreTools: readBoolean(
      config.injectCoreTools,
      CONFIG_DEFAULTS.injectCoreTools
    ),
    injectOriginHeaders: readBoolean(
      config.injectOriginHeaders,
      CONFIG_DEFAULTS.injectOriginHeaders
    ),
    injectUserAgent: readBoolean(
      config.injectUserAgent,
      CONFIG_DEFAULTS.injectUserAgent
    ),
    originClient:
      readString(config.originClient) ?? CONFIG_DEFAULTS.originClient,
    originProject:
      readString(config.originProject) ?? CONFIG_DEFAULTS.originProject,
    providers: new Set(
      providers.length > 0 ? providers : [...CONFIG_DEFAULTS.providers]
    ),
    sessionIdEnv:
      readString(config.sessionIdEnv) ?? CONFIG_DEFAULTS.sessionIdEnv,
    userAgent: readString(config.userAgent),
    usageBaseURL:
      readString(config.usageBaseURL) ?? CONFIG_DEFAULTS.usageBaseURL,
    usageEnabled: readBoolean(
      config.usageEnabled,
      CONFIG_DEFAULTS.usageEnabled
    ),
    usageKeyEnv: readString(config.usageKeyEnv) ?? CONFIG_DEFAULTS.usageKeyEnv,
    usageModelMarkers:
      usageModelMarkers.length > 0
        ? usageModelMarkers
        : [...CONFIG_DEFAULTS.usageModelMarkers],
    usageProviderMarkers:
      usageProviderMarkers.length > 0
        ? usageProviderMarkers
        : [...CONFIG_DEFAULTS.usageProviderMarkers],
  };
};

/**
 * The plugin's settings schema, in the harness's own `@deepseek-ai/schemastery`
 * fork (not the public line): it implements the `~standard` surface the loader
 * uses to validate the row, and the settings UI relies on the same schema to
 * serve the namespace the client card binds.
 *
 * Exporting this is what makes the row render as a real settings section
 * rather than free-form YAML: `dsh-settings` filters out any schema whose
 * fields are not marked `.volatile()`, so without `.volatile()` on these fields
 * the namespace is omitted from `describe()`, `configForms.whileServed` never
 * fires, and the Plugins page shows the bundle with no card.
 */
export const Config = z.object({
  providers: z
    .array(z.string())
    .default([...CONFIG_DEFAULTS.providers])
    .volatile()
    .description("Provider route keys to intercept."),
  gatewayUrls: z
    .array(z.string())
    .default([...CONFIG_DEFAULTS.gatewayUrls])
    .volatile()
    .description(
      "URL substrings marking OpenCode gateway traffic (matched before providers)."
    ),
  injectUserAgent: z
    .boolean()
    .default(CONFIG_DEFAULTS.injectUserAgent)
    .volatile()
    .description(
      "Restore the opencode CLI User-Agent stripped by the DSH LLM adapter."
    ),
  userAgent: z
    .string()
    .volatile()
    .description(
      "Custom User-Agent string. Leave blank to use the canonical OpenCode CLI one."
    ),
  injectOriginHeaders: z
    .boolean()
    .default(CONFIG_DEFAULTS.injectOriginHeaders)
    .volatile()
    .description("Inject x-opencode-client and x-opencode-project headers."),
  originClient: z
    .string()
    .default(CONFIG_DEFAULTS.originClient)
    .volatile()
    .description("Value restored into the x-opencode-client header."),
  originProject: z
    .string()
    .default(CONFIG_DEFAULTS.originProject)
    .volatile()
    .description("Value restored into the x-opencode-project header."),
  injectCoreTools: z
    .boolean()
    .default(CONFIG_DEFAULTS.injectCoreTools)
    .volatile()
    .description(
      "Auto-inject read and bash tool schemas on free-tier requests."
    ),
  freeModelMarker: z
    .string()
    .default(CONFIG_DEFAULTS.freeModelMarker)
    .volatile()
    .description(
      "Model-id marker triggering the core-tool fallback; * applies to every model."
    ),
  sessionIdEnv: z
    .string()
    .default(CONFIG_DEFAULTS.sessionIdEnv)
    .volatile()
    .description(
      "Environment variable consulted for the fallback session id outside a turn."
    ),
  usageEnabled: z
    .boolean()
    .default(CONFIG_DEFAULTS.usageEnabled)
    .volatile()
    .description("Enable host-side OpenCode Go usage querying."),
  usageBaseURL: z
    .string()
    .default(CONFIG_DEFAULTS.usageBaseURL)
    .volatile()
    .description("OpenCode Go gateway base URL."),
  usageKeyEnv: z
    .string()
    .default(CONFIG_DEFAULTS.usageKeyEnv)
    .volatile()
    .description("Environment variable or credential ref for the Go key."),
  usageProviderMarkers: z
    .array(z.string())
    .default([...CONFIG_DEFAULTS.usageProviderMarkers])
    .volatile()
    .description(
      "Provider-route markers that show the Go quota meter in the composer."
    ),
  usageModelMarkers: z
    .array(z.string())
    .default([...CONFIG_DEFAULTS.usageModelMarkers])
    .volatile()
    .description(
      "Model-id markers that show the Go quota meter under any provider."
    ),
  debug: z
    .boolean()
    .default(CONFIG_DEFAULTS.debug)
    .volatile()
    .description("Log injected streamed calls."),
  debugFile: z
    .string()
    .volatile()
    .description("Server-side path for JSONL stream-debug entries."),
});
