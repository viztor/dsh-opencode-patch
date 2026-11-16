/**
 * The plugin's settings, one row per key: the table the schema, resolver,
 * types, defaults and config-only list (`config.ts`), the card's fields
 * (`settings-fields.ts`), its copy keys and the manifest test all read. Client-safe: no schemastery.
 *
 * @module dsh-opencode-patch/settings-table
 */

import {
  DEFAULT_ENDPOINT_FAMILY,
  DEFAULT_KEY_SOURCE,
  DEFAULT_PROVIDERS,
  ENDPOINT_FAMILIES,
  KEY_SOURCE_POLICIES,
} from "./config-values.ts";

/** The card's sections, in the order they render. */
export type GroupId = "access" | "requests" | "models" | "quota";

/**
 * One setting. `kind` decides the schema node, the resolver's reader and the
 * card's control; `volatile` is the schema's flag (without it the settings
 * page omits the namespace); `card` is the section a card field renders under,
 * and a row without it is config-only.
 */
export type SettingRow =
  | { card?: GroupId; default: boolean; kind: "boolean"; volatile: boolean }
  | { default?: string; kind: "string"; volatile: boolean }
  | {
      card?: GroupId;
      default: string;
      kind: "choice";
      values: readonly string[];
      volatile: boolean;
    }
  /** A list the row may replace; empty means the default. */
  | { default: readonly string[]; kind: "list"; volatile: boolean }
  /** A list the row adds to: the default is always included. */
  | { default: readonly string[]; kind: "routes"; volatile: boolean };

// Adding a setting is one row here, plus its copy when the card shows it.
// The card imports this module and never `config.ts`, so schemastery stays on
// the host; the prose (`SETTING_PROSE`) is a separate export no client module
// imports (`config.ts` is its one reader), so the bundler drops it from the
// page. JSDoc ships with the client bundle, which is why the row docs below
// stay to a line.

/**
 * Every setting: the card's rows in render order, each group adjacent (a
 * heading goes where the group changes), then the config-only rows.
 */
export const SETTINGS = {
  // The endpoint family and the credential choice both live under `access`:
  // together they are "which account, on which endpoint", and filing the
  // credential knob under the quota meter instead is what made it hard to find.
  /** Endpoint family: `auto` (= `modern`), `modern` or `legacy`. */
  endpoint: {
    card: "access",
    default: DEFAULT_ENDPOINT_FAMILY,
    kind: "choice",
    values: ENDPOINT_FAMILIES,
    volatile: true,
  },
  /** Which credential source wins when several resolve. */
  keySource: {
    card: "access",
    default: DEFAULT_KEY_SOURCE,
    kind: "choice",
    values: KEY_SOURCE_POLICIES,
    volatile: true,
  },
  /** May the OpenCode installation's own store be read (LAST). */
  readOpencodeStore: {
    card: "access",
    default: false,
    kind: "boolean",
    volatile: true,
  },
  injectUserAgent: {
    card: "requests",
    default: true,
    kind: "boolean",
    volatile: true,
  },
  injectOriginHeaders: {
    card: "requests",
    default: true,
    kind: "boolean",
    volatile: true,
  },
  injectProject: {
    card: "requests",
    default: true,
    kind: "boolean",
    volatile: true,
  },
  enrichModels: {
    card: "models",
    default: true,
    kind: "boolean",
    volatile: true,
  },
  injectCoreTools: {
    card: "models",
    default: true,
    kind: "boolean",
    volatile: true,
  },
  usageEnabled: {
    card: "quota",
    default: true,
    kind: "boolean",
    volatile: true,
  },
  /** Org sent with an account credential that carries none. */
  credentialOrg: { kind: "string", volatile: true },
  debug: { default: false, kind: "boolean", volatile: false },
  debugFile: { kind: "string", volatile: false },
  userAgent: { kind: "string", volatile: true },
  /** Value restored into `x-opencode-client`. */
  originClient: { default: "cli", kind: "string", volatile: true },
  /** Env var holding a fallback session id. */
  sessionIdEnv: {
    default: "OPENCODE_SESSION_ID",
    kind: "string",
    volatile: true,
  },
  /** Model-id substring marking free-tier; `*` is every model. */
  freeModelMarker: { default: "free", kind: "string", volatile: true },
  /** Routes whose turns this plugin decorates: the planes, always. */
  providers: { default: DEFAULT_PROVIDERS, kind: "routes", volatile: true },
  /** URL substrings marking gateway traffic. */
  gatewayUrls: {
    default: ["opencode.ai/zen", "opencode.ai/inference"],
    kind: "list",
    volatile: true,
  },
  /** OpenCode Go quota endpoint. */
  usageBaseURL: {
    default: "https://opencode.ai/zen/go/v1",
    kind: "string",
    volatile: true,
  },
} as const satisfies Record<string, SettingRow>;

/** The table's rows, by key. */
export type SettingRows = typeof SETTINGS;

/** Every setting's key. */
export type SettingKey = keyof SettingRows;

/** The keys the card renders a control for. */
export type CardSettingKey = {
  [K in SettingKey]: SettingRows[K] extends { card: GroupId } ? K : never;
}[SettingKey];

/** The keys whose value is one of a fixed set. */
export type ChoiceSettingKey = {
  [K in SettingKey]: SettingRows[K] extends { kind: "choice" } ? K : never;
}[SettingKey];

/** The copy key naming one value of a choice field: `endpoint` + `Auto`. */
export type OptionCopyKey = {
  [
    K in ChoiceSettingKey
  ]: `${K}${Capitalize<SettingRows[K]["values"][number]>}`;
}[ChoiceSettingKey];

/**
 * Every copy key the table implies: a card field's label (its own key) and
 * hint, each choice's label, and each group's heading. `settings-copy.ts`
 * checks its dictionary against this, so a card row without its copy fails to
 * compile.
 */
export type SettingsCopyKey =
  | CardSettingKey
  | `${CardSettingKey}Hint`
  | OptionCopyKey
  | `group${Capitalize<GroupId>}`;

/** Every setting's key, in the table's order. */
export const SETTING_KEYS: readonly SettingKey[] = Object.keys(SETTINGS).filter(
  (key): key is SettingKey => key in SETTINGS
);

/** Whether the card renders `key`. */
export const isCardSetting = (key: SettingKey): key is CardSettingKey =>
  "card" in SETTINGS[key];

/** Whether the card leaves `key` to the row. */
export const isConfigOnlySetting = (
  key: SettingKey
): key is Exclude<SettingKey, CardSettingKey> => !isCardSetting(key);

/** Whether `key` holds one of a fixed set of values. */
export const isChoiceSetting = (key: SettingKey): key is ChoiceSettingKey =>
  SETTINGS[key].kind === "choice";

/** Every value a choice field offers. */
type ChoiceValue = SettingRows[ChoiceSettingKey]["values"][number];

// Each choice value and group id as a copy key spells it. A lookup rather than
// a capitaliser: the type makes every entry exact, so a new value or group
// without its spelling fails to compile, and the level names keep the one
// capitalisation in `src` (`effortName`).
const CAPITALIZED: { readonly [W in ChoiceValue | GroupId]: Capitalize<W> } = {
  access: "Access",
  auto: "Auto",
  configured: "Configured",
  legacy: "Legacy",
  models: "Models",
  modern: "Modern",
  quota: "Quota",
  request: "Request",
  requests: "Requests",
};

/** A card field's label key: the field's own name. */
export const labelKeyOf = <K extends CardSettingKey>(field: K): K => field;

/** A card field's hint key. */
export const hintKeyOf = <K extends CardSettingKey>(field: K): `${K}Hint` =>
  `${field}Hint`;

/**
 * The label key of one choice of a choice field: `endpoint` and `auto` give
 * `endpointAuto`. Typed as the table's option keys: with a union of fields the
 * compiler cannot pair each field with its own values, and the caller reads
 * both off the same row.
 */
export const optionKeyOf = <K extends ChoiceSettingKey>(
  field: K,
  value: SettingRows[K]["values"][number]
): OptionCopyKey =>
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the caller reads the field and the value off the same row.
  `${field}${CAPITALIZED[value]}` as OptionCopyKey;

/** A card group's heading key. */
export const groupKeyOf = <G extends GroupId>(
  group: G
): `group${Capitalize<G>}` => `group${CAPITALIZED[group]}`;

/**
 * What the row's reader is told about each key: the schema's description, and
 * for a key the card does not show, why (the type requires it there, and only
 * there). Host-side reading only, kept apart
 * from {@link SETTINGS} so the client bundle, which imports the table, drops
 * it.
 *
 * Why a key stays off the card, in general: the card shows the decisions a
 * user makes, behaviour toggles and the credential policy. A config-only key is
 * an override: a literal (a UA string, a header value, an endpoint), a marker
 * (a model-id or URL substring), or a reference (an env-var name, a credential
 * ref, a route list). Its default is right for every documented setup, so a
 * control would only invite someone to break their own routing; it stays
 * editable in the row's `config`, and `cordis.patch.yml` documents it.
 */
export const SETTING_PROSE: {
  readonly [K in SettingKey]: K extends CardSettingKey
    ? { description: string }
    : { description: string; reason: string };
} = {
  credentialOrg: {
    description:
      "The org id (wrk_...) to send with an account credential. A login through " +
      "this plugin stores the org with the token, so this is only for a token " +
      "that came from elsewhere.",
    reason:
      "the org an account credential belongs to; a login through this plugin " +
      "stores it with the token, so the row is for a token that came from " +
      "elsewhere and has no UI to belong to",
  },
  debug: {
    description: "Log injected streamed calls.",
    reason:
      "diagnostic console logging of streamed calls, not a behaviour a user " +
      "tunes in the UI",
  },
  debugFile: {
    description: "Server-side path for JSONL stream-debug entries.",
    reason:
      "the JSONL file both debug halves append to; naming it writes the file " +
      "whether or not debug is on, and a server-side path is a deployment fact " +
      "rather than a card control",
  },
  endpoint: {
    description:
      "Which endpoint family the gateway's requests go to. modern: the " +
      "per-protocol inference family, " +
      "https://opencode.ai/inference/{openai,anthropic,google}/... on Zen " +
      "and https://opencode.ai/inference/go/{openai,anthropic,google}/... " +
      "on Go. auto: an alias of modern, and the default. legacy: the older " +
      "single base per plane, https://opencode.ai/zen/v1 and " +
      "https://opencode.ai/zen/go/v1. The two families are separately " +
      "entitled and both still answer, so this is a choice rather than a " +
      "migration; an unrecognised value falls back to auto.",
  },
  enrichModels: {
    description:
      "Enrich the gateway /models listing and Settings model discovery from the OpenCode catalog; a plane's model info follows the user's row and the catalog either way.",
  },
  freeModelMarker: {
    description:
      "Model-id marker triggering the core-tool fallback; * applies to every model.",
    reason:
      "model-id substring; 'free' tracks the vendor's ids, '*' forces the fallback",
  },
  gatewayUrls: {
    description:
      "URL substrings marking OpenCode gateway traffic (matched before providers).",
    reason: "URL substrings; only a mirror or relay needs to change them",
  },
  injectCoreTools: {
    description:
      "Auto-inject read and bash tool schemas on free-tier requests.",
  },
  injectOriginHeaders: {
    description: "Inject x-opencode-client header.",
  },
  injectProject: {
    description:
      "Attach the active workspace folder name (or 'global' if outside a project) in x-opencode-project.",
  },
  injectUserAgent: {
    description:
      "Restore the opencode CLI User-Agent stripped by the DSH LLM adapter.",
  },
  keySource: {
    description:
      "Which credential source wins when several resolve. auto: a literal key declared in another entry, then a key captured from a live request, then the declared reference, then a captured key for the other plane. request: a captured key first, then a literal one, then the declared reference. configured: a literal key, then the declared reference, then captured ones. An unrecognised value falls back to auto.",
  },
  originClient: {
    description: "Value restored into the x-opencode-client header.",
    reason:
      "literal x-opencode-client value; the default ('cli') is what the gateway expects",
  },
  providers: {
    description:
      "Route ids whose turns this plugin decorates; opencode and opencode-go are always included.",
    reason:
      "route ids whose turns are decorated; both planes are always included, so only a relay route needs adding",
  },
  readOpencodeStore: {
    description:
      "Read the credential the OpenCode installation already holds, from its " +
      "own database, as the LAST resort: after every credential this " +
      "deployment declares. Off by default — reading another tool's store is " +
      "something a user turns on, not something that happens to them.",
  },
  sessionIdEnv: {
    description:
      "Environment variable consulted for the fallback session id outside a turn.",
    reason: "names an env var only a caller-supplied session id would use",
  },
  usageBaseURL: {
    description: "OpenCode Go gateway base URL.",
    reason: "endpoint override; auto-discovered from the composition",
  },
  usageEnabled: {
    description: "Enable host-side OpenCode Go usage querying.",
  },
  userAgent: {
    description:
      "Custom User-Agent string. Leave blank to use the canonical OpenCode CLI one.",
    reason:
      "literal User-Agent override; the default is the canonical CLI string",
  },
};
