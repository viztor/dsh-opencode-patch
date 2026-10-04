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
  DEFAULT_KEY_SOURCE,
  DEFAULT_PROVIDERS,
  DEFAULT_SHOW_USAGE_PRICE,
  isKeySourcePolicy,
  KEY_SOURCE_POLICIES,
  type KeySourcePolicy,
  readBoolean,
  readString,
  readStringList,
} from "./config-values.ts";

export {
  DEFAULT_KEY_SOURCE,
  DEFAULT_PROVIDERS,
  DEFAULT_SHOW_USAGE_PRICE,
  KEY_SOURCE_POLICIES,
  type KeySourcePolicy,
};

/**
 * URL substrings that mark a request as OpenCode gateway traffic even when no
 * turn is active. Configurable so mirrors, proxies, and self-hosted gateways
 * can be targeted without a code change.
 */
export const DEFAULT_GATEWAY_URLS = ["opencode.ai/zen"];

/** Value restored into `x-opencode-client` by default. */
export const DEFAULT_ORIGIN_CLIENT = "cli";

/** Whether to attach the workspace project identifier (x-opencode-project) by default. */
export const DEFAULT_INJECT_PROJECT = true;

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
  enrichModels: true,
  freeModelMarker: DEFAULT_FREE_MODEL_MARKER,
  gatewayUrls: DEFAULT_GATEWAY_URLS,
  injectCoreTools: true,
  injectOriginHeaders: true,
  injectProject: DEFAULT_INJECT_PROJECT,
  injectUserAgent: true,
  keySource: DEFAULT_KEY_SOURCE,
  originClient: DEFAULT_ORIGIN_CLIENT,
  providers: DEFAULT_PROVIDERS,
  sessionIdEnv: DEFAULT_SESSION_ID_ENV,
  showUsagePrice: DEFAULT_SHOW_USAGE_PRICE,
  usageBaseURL: DEFAULT_USAGE_BASE_URL,
  usageEnabled: true,
} as const;

/** The raw shape a cordis row's `config` may carry (all optional). */
export interface PluginConfig {
  debug?: boolean;
  debugFile?: string;
  enrichModels?: boolean;
  freeModelMarker?: string;
  gatewayUrls?: string[];
  injectCoreTools?: boolean;
  injectOriginHeaders?: boolean;
  injectProject?: boolean;
  injectUserAgent?: boolean;
  keySource?: KeySourcePolicy;
  originClient?: string;
  providers?: string[];
  sessionIdEnv?: string;
  showUsagePrice?: boolean;
  userAgent?: string;
  usageBaseURL?: string;
  usageEnabled?: boolean;
}

/** The fully-defaulted shape the plugin's runtime branches read. */
export interface ResolvedPluginConfig {
  debug: boolean;
  debugFile?: string;
  enrichModels: boolean;
  /** `*` when the core-tool fallback should run for every model. */
  freeModelMarker: string;
  /** URL substrings marking gateway traffic; never empty after resolution. */
  gatewayUrls: string[];
  injectCoreTools: boolean;
  injectOriginHeaders: boolean;
  injectProject: boolean;
  injectUserAgent: boolean;
  /** Which credential source wins when more than one resolves. */
  keySource: KeySourcePolicy;
  originClient: string;
  providers: Set<string>;
  sessionIdEnv: string;
  showUsagePrice: boolean;
  userAgent?: string;
  usageBaseURL: string;
  usageEnabled: boolean;
}

/**
 * Fold a raw row config (or schema-validated output) into the resolved shape.
 *
 * Blank strings and empty lists inherit the defaults, so a row that mentions a
 * key without a usable value behaves exactly like a row that omits it.
 *
 * @param rawInput - raw or validated row config.
 */
/**
 * A row's key-source policy, or the default when it names something else.
 *
 * Deliberately lenient: a typo in a hand-edited row degrades to `auto` rather
 * than failing the plugin load.
 */
const resolvedKeySource = (raw: unknown): KeySourcePolicy => {
  const value = readString(raw);
  return isKeySourcePolicy(value) ? value : CONFIG_DEFAULTS.keySource;
};

export const resolveConfig = (
  rawInput: PluginConfig = {}
): ResolvedPluginConfig => {
  const config = rawInput ?? {};

  const providers = readStringList(config.providers);
  const gatewayUrls = readStringList(config.gatewayUrls);

  return {
    debug: readBoolean(config.debug, CONFIG_DEFAULTS.debug),
    debugFile: readString(config.debugFile),
    enrichModels: readBoolean(
      config.enrichModels,
      CONFIG_DEFAULTS.enrichModels
    ),
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
    injectProject: readBoolean(
      config.injectProject,
      CONFIG_DEFAULTS.injectProject
    ),
    injectUserAgent: readBoolean(
      config.injectUserAgent,
      CONFIG_DEFAULTS.injectUserAgent
    ),
    keySource: resolvedKeySource(config.keySource),
    originClient:
      readString(config.originClient) ?? CONFIG_DEFAULTS.originClient,
    providers: new Set(
      providers.length > 0 ? providers : [...CONFIG_DEFAULTS.providers]
    ),
    sessionIdEnv:
      readString(config.sessionIdEnv) ?? CONFIG_DEFAULTS.sessionIdEnv,
    showUsagePrice: readBoolean(
      config.showUsagePrice,
      CONFIG_DEFAULTS.showUsagePrice
    ),
    userAgent: readString(config.userAgent),
    usageBaseURL:
      readString(config.usageBaseURL) ?? CONFIG_DEFAULTS.usageBaseURL,
    usageEnabled: readBoolean(
      config.usageEnabled,
      CONFIG_DEFAULTS.usageEnabled
    ),
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
  keySource: z
    .string()
    .default(CONFIG_DEFAULTS.keySource)
    .volatile()
    .description(
      "Which credential source wins when several resolve: auto (composition, then a key captured from a live request), request (live request first), or configured (declared key first). An unrecognised value falls back to auto."
    ),
  injectOriginHeaders: z
    .boolean()
    .default(CONFIG_DEFAULTS.injectOriginHeaders)
    .volatile()
    .description("Inject x-opencode-client header."),
  originClient: z
    .string()
    .default(CONFIG_DEFAULTS.originClient)
    .volatile()
    .description("Value restored into the x-opencode-client header."),
  injectProject: z
    .boolean()
    .default(CONFIG_DEFAULTS.injectProject)
    .volatile()
    .description(
      "Attach the active workspace folder name (or 'global' if outside a project) in x-opencode-project."
    ),
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
  enrichModels: z
    .boolean()
    .default(CONFIG_DEFAULTS.enrichModels)
    .volatile()
    .description(
      "Enrich and override gateway models list using canonical models.dev catalog."
    ),
  showUsagePrice: z
    .boolean()
    .default(CONFIG_DEFAULTS.showUsagePrice)
    .volatile()
    .description("Display session spend and model pricing in usage meter."),
  usageBaseURL: z
    .string()
    .default(CONFIG_DEFAULTS.usageBaseURL)
    .volatile()
    .description("OpenCode Go gateway base URL."),
  debug: z
    .boolean()
    .default(CONFIG_DEFAULTS.debug)
    .description("Log injected streamed calls."),
  debugFile: z
    .string()
    .description("Server-side path for JSONL stream-debug entries."),
});
