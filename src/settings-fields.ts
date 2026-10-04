/**
 * Field registry for the OpenCode Patch card — the single source of truth for
 * which knobs the card edits: knob, section, control kind and copy keys.
 *
 * {@link SPECS} and the card's JSX are both derived from it, so a field can no
 * longer be bound but never rendered. See `AGENTS.md` → "Why the card owns its
 * boolean/list fields" for why the helpers below are ours.
 *
 * @module dsh-opencode-patch/settings-fields
 */

import type { SettingsFieldSpec } from "@deepseek-ai/dsh-client-ui-primitives";

import type { CopyKey } from "./settings-copy.ts";

/** Schema knob names the card edits; keys double as label ids. */
export const FIELD = {
  enrichModels: "enrichModels",
  injectCoreTools: "injectCoreTools",
  injectOriginHeaders: "injectOriginHeaders",
  injectProject: "injectProject",
  injectUserAgent: "injectUserAgent",
  keySource: "keySource",
  showUsagePrice: "showUsagePrice",
  usageEnabled: "usageEnabled",
} as const;

/**
 * Knobs that exist in the schema but deliberately render no control.
 *
 * The card shows the decisions a user actually makes — behaviour toggles and the
 * credential policy. Everything here is an *override*: a literal (a UA string, a
 * header value, an endpoint), a marker (a model-id or URL substring), or a
 * reference (an env-var name, a credential ref, a route list). Their defaults are
 * correct for every documented setup, so exposing them only invites someone to
 * break their own routing — and they are all still editable in the row's
 * `config` (`cordis.patch.yml` carries the reference).
 *
 * A test pins that this list and {@link CARD_FIELDS} partition the schema
 * exactly: no knob may be in both, and none may be in neither.
 */
export const CONFIG_ONLY_FIELDS: readonly {
  field: string;
  /** Why this knob stays out of the card. */
  reason: string;
}[] = [
  {
    field: "debug",
    reason: "diagnostic JSONL logging, not a behaviour a user tunes in the UI",
  },
  {
    field: "userAgent",
    reason:
      "literal User-Agent override; the default is the canonical CLI string",
  },
  {
    field: "originClient",
    reason:
      "literal x-opencode-client value; the default ('cli') is what the gateway expects",
  },
  {
    field: "sessionIdEnv",
    reason: "names an env var only a caller-supplied session id would use",
  },
  {
    field: "freeModelMarker",
    reason:
      "model-id substring; 'free' tracks the vendor's ids, '*' forces the fallback",
  },
  {
    field: "providers",
    reason: "route ids to intercept; the default covers the documented routes",
  },
  {
    field: "gatewayUrls",
    reason: "URL substrings; only a mirror or relay needs to change them",
  },
  {
    field: "usageBaseURL",
    reason: "endpoint override; auto-discovered from the composition",
  },
];

/** Which control renders a field, and which draft conversion backs it. */
export type FieldKind = "boolean" | "select";

/**
 * Section headings, in the order they appear.
 *
 * A field names its group and the card inserts a heading wherever it changes, so
 * the display order comes from {@link CARD_FIELDS} rather than a second list.
 * Keeping each group's entries adjacent is what makes the heading appear once.
 */
export const GROUP = {
  models: "groupModels",
  quota: "groupQuota",
  requests: "groupRequests",
} as const;

/** One choice a `select` field offers: the label is copy, the value is stored. */
export interface CardFieldOption {
  labelKey: CopyKey;
  value: string;
}

/** One rendered field: the knob, its control kind, and its copy. */
export interface CardFieldSpec {
  field: string;
  /** Section heading this field renders under. */
  group: CopyKey;
  hintKey: CopyKey;
  kind: FieldKind;
  labelKey: CopyKey;
  /** Choices for `kind: "select"`; ignored by the boolean kind. */
  options?: readonly CardFieldOption[];
}

const BOOLEAN_DRAFTS: Record<
  string,
  { kind: "set"; value: boolean } | { kind: "clear" }
> = {
  "": { kind: "clear" },
  false: { kind: "set", value: false },
  true: { kind: "set", value: true },
};

/**
 * Boolean draft conversion (the host ships no boolean spec).
 *
 * A blank draft clears the field so it re-inherits the default; anything that
 * is not `true`/`false` is invalid, which `SettingsFormModel` reports rather
 * than silently writing a value.
 */
const settingsBooleanField = (field: string): SettingsFieldSpec => ({
  field,
  format: (value: unknown) => (typeof value === "boolean" ? String(value) : ""),
  parse: (text: string) => BOOLEAN_DRAFTS[text.trim().toLowerCase()],
});

/**
 * Constrained-choice draft conversion (the host ships no enum spec).
 *
 * Blank clears so the field re-inherits the default; a value outside `allowed`
 * is invalid, which the form model reports rather than letting the host quietly
 * coerce a typo back to the default.
 */
const settingsSelectField = (
  field: string,
  allowed: readonly string[]
): SettingsFieldSpec => ({
  field,
  format: (value: unknown) => (typeof value === "string" ? value : ""),
  parse: (text: string) => {
    const trimmed = text.trim();
    if (trimmed.length === 0) {
      return { kind: "clear" };
    }
    return allowed.includes(trimmed)
      ? { kind: "set", value: trimmed }
      : undefined;
  },
});

/** Draft-conversion factory per control kind; a missing kind is a type error. */
const FIELD_SPEC_BUILDERS: Record<
  FieldKind,
  (entry: CardFieldSpec) => SettingsFieldSpec
> = {
  boolean: (entry) => settingsBooleanField(entry.field),
  select: (entry) =>
    settingsSelectField(
      entry.field,
      (entry.options ?? []).map((option) => option.value)
    ),
};

const toSettingsFieldSpec = (entry: CardFieldSpec): SettingsFieldSpec =>
  FIELD_SPEC_BUILDERS[entry.kind](entry);

/**
 * Every field the card renders, in render order, grouped into sections.
 *
 * Entries are ordered so each {@link GROUP} stays contiguous: the card inserts a
 * heading where the group changes. Only decisions a user makes live here — the
 * override knobs are in {@link CONFIG_ONLY_FIELDS}.
 */
export const CARD_FIELDS: readonly CardFieldSpec[] = [
  {
    field: FIELD.injectUserAgent,
    group: GROUP.requests,
    hintKey: "injectUserAgentHint",
    kind: "boolean",
    labelKey: "injectUserAgent",
  },
  {
    field: FIELD.injectOriginHeaders,
    group: GROUP.requests,
    hintKey: "injectOriginHeadersHint",
    kind: "boolean",
    labelKey: "injectOriginHeaders",
  },
  {
    field: FIELD.injectProject,
    group: GROUP.requests,
    hintKey: "injectProjectHint",
    kind: "boolean",
    labelKey: "injectProject",
  },
  {
    field: FIELD.enrichModels,
    group: GROUP.models,
    hintKey: "enrichModelsHint",
    kind: "boolean",
    labelKey: "enrichModels",
  },
  {
    field: FIELD.injectCoreTools,
    group: GROUP.models,
    hintKey: "injectCoreToolsHint",
    kind: "boolean",
    labelKey: "injectCoreTools",
  },
  {
    field: FIELD.usageEnabled,
    group: GROUP.quota,
    hintKey: "usageEnabledHint",
    kind: "boolean",
    labelKey: "usageEnabled",
  },
  {
    field: FIELD.showUsagePrice,
    group: GROUP.quota,
    hintKey: "showUsagePriceHint",
    kind: "boolean",
    labelKey: "showUsagePrice",
  },
  {
    field: FIELD.keySource,
    group: GROUP.quota,
    hintKey: "keySourceHint",
    kind: "select",
    labelKey: "keySource",
    // Values must stay in step with `KEY_SOURCE_POLICIES`; a test pins that.
    options: [
      { labelKey: "keySourceAuto", value: "auto" },
      { labelKey: "keySourceRequest", value: "request" },
      { labelKey: "keySourceConfigured", value: "configured" },
    ],
  },
];

/** The draft conversions the form model binds, derived from {@link CARD_FIELDS}. */
export const SPECS: SettingsFieldSpec[] = CARD_FIELDS.map(toSettingsFieldSpec);
