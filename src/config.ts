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
  DEFAULT_ENDPOINT_FAMILY,
  DEFAULT_KEY_SOURCE,
  DEFAULT_PROVIDERS,
  ENDPOINT_FAMILIES,
  isEndpointFamily,
  isKeySourcePolicy,
  KEY_SOURCE_POLICIES,
  type EndpointFamily,
  type KeySourcePolicy,
  readBoolean,
  readString,
  readStringList,
} from "./config-values.ts";
import { PLANE_ROUTES } from "./utils/protocols.ts";

export {
  DEFAULT_ENDPOINT_FAMILY,
  DEFAULT_KEY_SOURCE,
  DEFAULT_PROVIDERS,
  ENDPOINT_FAMILIES,
  KEY_SOURCE_POLICIES,
  type EndpointFamily,
  type KeySourcePolicy,
};

/**
 * URL substrings that mark a request as OpenCode gateway traffic even when no
 * turn is active. Configurable so mirrors, proxies, and self-hosted gateways
 * can be targeted without a code change.
 */
/**
 * URL substrings marking gateway traffic.
 *
 * Both endpoint families: the older `zen` one and the `inference` one OpenCode
 * 2.x's catalog names. A request on either belongs to this plugin, and the
 * credential's format decides which of the two it is actually sent to - see
 * `endpoint-pairing.ts`.
 */
export const DEFAULT_GATEWAY_URLS = [
  "opencode.ai/zen",
  "opencode.ai/inference",
];

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
  credentialOrg: undefined as string | undefined,
  debug: false,
  enrichModels: true,
  endpoint: DEFAULT_ENDPOINT_FAMILY,
  freeModelMarker: DEFAULT_FREE_MODEL_MARKER,
  gatewayUrls: DEFAULT_GATEWAY_URLS,
  injectCoreTools: true,
  injectOriginHeaders: true,
  injectProject: DEFAULT_INJECT_PROJECT,
  injectUserAgent: true,
  keySource: DEFAULT_KEY_SOURCE,
  originClient: DEFAULT_ORIGIN_CLIENT,
  providers: DEFAULT_PROVIDERS,
  readOpencodeStore: false,
  sessionIdEnv: DEFAULT_SESSION_ID_ENV,
  usageBaseURL: DEFAULT_USAGE_BASE_URL,
  usageEnabled: true,
} as const;

/** The raw shape a cordis row's `config` may carry (all optional). */
export interface PluginConfig {
  credentialOrg?: string;
  debug?: boolean;
  debugFile?: string;
  enrichModels?: boolean;
  endpoint?: EndpointFamily;
  freeModelMarker?: string;
  gatewayUrls?: string[];
  injectCoreTools?: boolean;
  injectOriginHeaders?: boolean;
  injectProject?: boolean;
  injectUserAgent?: boolean;
  keySource?: KeySourcePolicy;
  originClient?: string;
  providers?: string[];
  readOpencodeStore?: boolean;
  sessionIdEnv?: string;
  userAgent?: string;
  usageBaseURL?: string;
  usageEnabled?: boolean;
}

/** The fully-defaulted shape the plugin's runtime branches read. */
export interface ResolvedPluginConfig {
  /**
   * The org to send with an account credential, when the credential does not
   * carry one itself.
   *
   * A session token needs the org it belongs to: measured on a paid model,
   * `200` with the org and `403` without. It never unlocked the free tier —
   * nothing sent from a request does. A login performed by this plugin stores
   * the org beside the token, so a deployment that logged in needs nothing
   * here — this is for one whose token came from somewhere else.
   */
  readonly credentialOrg: string | undefined;
  debug: boolean;
  debugFile?: string;
  enrichModels: boolean;
  /**
   * Which endpoint family the gateway's requests go to.
   *
   * The two families are independently entitled and both are still served, so
   * the choice is the user's: `auto` is an alias of `modern` (the default), and
   * `legacy` pins the older single base per plane. See {@link ENDPOINT_FAMILIES}.
   */
  endpoint: EndpointFamily;
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
  /**
   * The route ids whose turns this plugin decorates: the two planes, always,
   * and any relay route the row names beside them.
   */
  providers: Set<string>;
  /**
   * Whether the OpenCode installation's own credential store may be read.
   *
   * Off by default, and LAST in the resolution order when on: reading another
   * program's private store is something a user turns on, and a credential they
   * declared in DSH always outranks one inferred from the installation.
   */
  readonly readOpencodeStore: boolean;
  sessionIdEnv: string;
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

/**
 * A row's endpoint family, or the default when it names something else.
 *
 * Lenient for the same reason {@link resolvedKeySource} is: a typo in a
 * hand-edited row degrades to `auto`, the default, so a typo cannot select a
 * family the user never named.
 */
const resolvedEndpoint = (raw: unknown): EndpointFamily => {
  const value = readString(raw);
  return isEndpointFamily(value) ? value : CONFIG_DEFAULTS.endpoint;
};

export const resolveConfig = (
  rawInput: PluginConfig = {}
): ResolvedPluginConfig => {
  const config = rawInput ?? {};

  const providers = readStringList(config.providers);
  const gatewayUrls = readStringList(config.gatewayUrls);

  return {
    credentialOrg: readString(config.credentialOrg),
    debug: readBoolean(config.debug, CONFIG_DEFAULTS.debug),
    debugFile: readString(config.debugFile),
    enrichModels: readBoolean(
      config.enrichModels,
      CONFIG_DEFAULTS.enrichModels
    ),
    endpoint: resolvedEndpoint(config.endpoint),
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
    // The planes are the plugin's own routes (D19), so a row's list adds
    // relay routes to them and can never take one away.
    providers: new Set([...PLANE_ROUTES, ...providers]),
    readOpencodeStore: readBoolean(
      config.readOpencodeStore,
      CONFIG_DEFAULTS.readOpencodeStore
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
    .description(
      "Route ids whose turns this plugin decorates; opencode and opencode-go are always included."
    ),
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
      "Which credential source wins when several resolve. auto: a literal key declared in another entry, then a key captured from a live request, then the declared reference, then a captured key for the other plane. request: a captured key first, then a literal one, then the declared reference. configured: a literal key, then the declared reference, then captured ones. An unrecognised value falls back to auto."
    ),
  readOpencodeStore: z
    .boolean()
    .default(CONFIG_DEFAULTS.readOpencodeStore)
    .volatile()
    .description(
      "Read the credential the OpenCode installation already holds, from its " +
        "own database, as the LAST resort: after every credential this " +
        "deployment declares. Off by default — reading another tool's store is " +
        "something a user turns on, not something that happens to them."
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
      "Enrich the gateway /models listing and Settings model discovery from the OpenCode catalog; a plane's model info follows the user's row and the catalog either way."
    ),
  endpoint: z
    .string()
    .default(CONFIG_DEFAULTS.endpoint)
    .description(
      "Which endpoint family the gateway's requests go to. modern: the " +
        "per-protocol inference family, " +
        "https://opencode.ai/inference/{openai,anthropic,google}/... on Zen " +
        "and https://opencode.ai/inference/go/{openai,anthropic,google}/... " +
        "on Go. auto: an alias of modern, and the default. legacy: the older " +
        "single base per plane, https://opencode.ai/zen/v1 and " +
        "https://opencode.ai/zen/go/v1. The two families are separately " +
        "entitled and both still answer, so this is a choice rather than a " +
        "migration; an unrecognised value falls back to auto."
    )
    .volatile(),
  usageBaseURL: z
    .string()
    .default(CONFIG_DEFAULTS.usageBaseURL)
    .volatile()
    .description("OpenCode Go gateway base URL."),
  credentialOrg: z
    .string()
    .volatile()
    .description(
      "The org id (wrk_...) to send with an account credential. A login through " +
        "this plugin stores the org with the token, so this is only for a token " +
        "that came from elsewhere."
    ),
  debug: z
    .boolean()
    .default(CONFIG_DEFAULTS.debug)
    .description("Log injected streamed calls."),
  debugFile: z
    .string()
    .description(
      "Server-side path for JSONL stream-debug entries; written only while debug is on."
    ),
});
