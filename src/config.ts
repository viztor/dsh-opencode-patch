/**
 * Host-side plugin configuration: defaults, raw/resolved types, the row
 * schema, and the resolver that folds either into one resolved shape.
 *
 * Every one of them is read from the settings table (`settings-table.ts`):
 * a row's kind picks its schema node and its reader, and its default is the
 * schema's `.default()` and the resolver's fallback both, so the schema, the
 * resolver and the types cannot drift apart. The one exception is `routes`,
 * whose resolved floor is the planes themselves (`PLANE_ROUTES`, D19), not the
 * row's default; `test/settings-table.test.ts` holds the two equal. This
 * module is the host half: it imports schemastery and carries the prose, so
 * the client reads the table and never this file.
 *
 * @module dsh-opencode-patch/config
 */

import z from "@deepseek-ai/schemastery";

import {
  DEFAULT_ENDPOINT_FAMILY,
  DEFAULT_KEY_SOURCE,
  DEFAULT_PROVIDERS,
  ENDPOINT_FAMILIES,
  KEY_SOURCE_POLICIES,
  type EndpointFamily,
  type KeySourcePolicy,
  readBoolean,
  readString,
  readStringList,
} from "./config-values.ts";
import {
  isConfigOnlySetting,
  SETTING_KEYS,
  SETTING_PROSE,
  SETTINGS,
  type SettingKey,
  type SettingRow,
  type SettingRows,
} from "./settings-table.ts";
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
 * URL substrings marking gateway traffic.
 *
 * Both endpoint families: the older `zen` one and the `inference` one OpenCode
 * 2.x's catalog names. A request on either belongs to this plugin, and the
 * credential's format decides which of the two it is actually sent to - see
 * `endpoint-pairing.ts`.
 */
export const DEFAULT_GATEWAY_URLS: readonly string[] =
  SETTINGS.gatewayUrls.default;

/** Value restored into `x-opencode-client` by default. */
export const DEFAULT_ORIGIN_CLIENT: string = SETTINGS.originClient.default;

/**
 * Model-id substring that marks a request as free-tier (and therefore in need
 * of the core-tool schema fallback).
 */
export const DEFAULT_FREE_MODEL_MARKER: string =
  SETTINGS.freeModelMarker.default;

/** Default OpenCode Go quota endpoint. */
export const DEFAULT_USAGE_BASE_URL: string = SETTINGS.usageBaseURL.default;

/** Default environment variable / credential ref holding the Go key. */
export const DEFAULT_USAGE_KEY_ENV = "OPENCODE_GO_API_KEY";

/** The value a row of this shape holds, before resolution. */
type RawOf<R> = R extends { kind: "boolean" }
  ? boolean
  : R extends { kind: "choice"; values: readonly (infer V)[] }
    ? V
    : R extends { kind: "list" | "routes" }
      ? string[]
      : string;

/** The value a row of this shape resolves to. */
type ResolvedOf<R> = R extends { kind: "routes" } ? Set<string> : RawOf<R>;

/** The keys whose row has a default, so they always resolve to a value. */
type DefaultedKey = {
  [K in SettingKey]: SettingRows[K] extends { default: unknown } ? K : never;
}[SettingKey];

/** The raw shape a cordis row's `config` may carry (all optional). */
export type PluginConfig = {
  -readonly [K in keyof SettingRows]?: RawOf<SettingRows[K]>;
};

/**
 * The fully-defaulted shape the plugin's runtime branches read: a key whose
 * row has a default always holds a value, and the three without one
 * (`credentialOrg`, `debugFile`, `userAgent`) hold `undefined` until a row
 * sets them.
 */
export type ResolvedPluginConfig = {
  -readonly [
    K in keyof SettingRows as K extends DefaultedKey ? K : never
  ]: ResolvedOf<SettingRows[K]>;
} & {
  -readonly [
    K in keyof SettingRows as K extends DefaultedKey ? never : K
  ]?: ResolvedOf<SettingRows[K]>;
};

/**
 * Every default, by key: the table's, read back. Blank or absent user values
 * fall back to these, and the `Config` schema `.default()`s to the same ones.
 */
export const CONFIG_DEFAULTS =
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- `Object.fromEntries` forgets the keys; the filter keeps exactly the rows with a default.
  Object.fromEntries(
    SETTING_KEYS.flatMap((key) => {
      const row: SettingRow = SETTINGS[key];
      return row.default === undefined ? [] : [[key, row.default]];
    })
  ) as { readonly [K in DefaultedKey]: SettingRows[K]["default"] };

/**
 * Knobs that exist in the schema but deliberately render no control: the
 * table's rows without a `card` group, each with the reason it gives
 * (`SETTING_PROSE`, which says why a key stays off the card in general).
 *
 * A test pins that this list and the card's `CARD_FIELDS` partition the schema
 * exactly: no knob may be in both, and none may be in neither. It lives here,
 * on the host side, so no client module imports the prose it carries.
 */
export const CONFIG_ONLY_FIELDS: readonly {
  field: string;
  /** Why this knob stays out of the card. */
  reason: string;
}[] = SETTING_KEYS.filter(isConfigOnlySetting).map((field) => ({
  field,
  reason: SETTING_PROSE[field].reason,
}));

/**
 * One row's value, read by its kind. Lenient throughout: a typo or a wrong type
 * in a hand-edited row degrades to the default rather than failing the plugin
 * load, and a choice outside its values cannot select one the user never named.
 */
const readSetting = (row: SettingRow, raw: unknown): unknown => {
  if (row.kind === "boolean") {
    return readBoolean(raw, row.default);
  }
  if (row.kind === "choice") {
    const value = readString(raw);
    return value !== undefined && row.values.includes(value)
      ? value
      : row.default;
  }
  if (row.kind === "list") {
    const list = readStringList(raw);
    return list.length > 0 ? list : [...row.default];
  }
  if (row.kind === "routes") {
    // The planes are the plugin's own routes (D19), so a row's list adds
    // relay routes to them and can never take one away.
    return new Set([...PLANE_ROUTES, ...readStringList(raw)]);
  }
  return readString(raw) ?? row.default;
};

/**
 * Fold a raw row config (or schema-validated output) into the resolved shape.
 *
 * Blank strings and empty lists inherit the defaults, so a row that mentions a
 * key without a usable value behaves exactly like a row that omits it. Every
 * key is present on the result, holding `undefined` when it has no default.
 *
 * @param rawInput - raw or validated row config.
 */
export const resolveConfig = (
  rawInput: PluginConfig = {}
): ResolvedPluginConfig => {
  const config: Record<string, unknown> = rawInput ?? {};
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- one entry per table row, each read by its own row's kind.
  return Object.fromEntries(
    SETTING_KEYS.map((key) => [key, readSetting(SETTINGS[key], config[key])])
  ) as ResolvedPluginConfig;
};

/** One row's schema node, before its flag and description. */
const nodeFor = (row: SettingRow): z => {
  if (row.kind === "boolean") {
    return z.boolean().default(row.default);
  }
  if (row.kind === "list" || row.kind === "routes") {
    return z.array(z.string()).default([...row.default]);
  }
  // A choice is a string here: the schema does not hold the option set, so a
  // typo passes the load and the resolver degrades it (see `readSetting`).
  return row.default === undefined
    ? z.string()
    : z.string().default(row.default);
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
export const Config = z.object(
  Object.fromEntries(
    SETTING_KEYS.map((key) => {
      const row: SettingRow = SETTINGS[key];
      const node = nodeFor(row);
      return [
        key,
        (row.volatile ? node.volatile() : node).description(
          SETTING_PROSE[key].description
        ),
      ];
    })
  )
);
