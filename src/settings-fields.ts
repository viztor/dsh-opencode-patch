/**
 * Field registry for the OpenCode Patch card.
 *
 * `FIELD` names the schema knobs, the three conversion helpers turn stored
 * values into drafts and back (booleans accept `true`/`false`/blank, lists
 * round-trip comma text as arrays, text is stock), and `SPECS` composes
 * them in the order the card renders. Splitting this out keeps the page
 * module about wiring rather than form mechanics.
 *
 * @module dsh-opencode-patch/settings-fields
 */

import {
  settingsTextField,
  type SettingsFieldSpec,
} from "@deepseek-ai/dsh-client-ui-primitives";

/** Schema knob names this card edits; keys double as label ids. */
export const FIELD = {
  freeModelMarker: "freeModelMarker",
  gatewayUrls: "gatewayUrls",
  injectCoreTools: "injectCoreTools",
  injectOriginHeaders: "injectOriginHeaders",
  injectProject: "injectProject",
  injectUserAgent: "injectUserAgent",
  originClient: "originClient",
  providers: "providers",
  sessionIdEnv: "sessionIdEnv",
  usageBaseURL: "usageBaseURL",
  usageEnabled: "usageEnabled",
  usageKeyEnv: "usageKeyEnv",
  usageProviderMarkers: "usageProviderMarkers",
  userAgent: "userAgent",
};

const BOOLEAN_DRAFTS: Record<
  string,
  { kind: "set"; value: boolean } | { kind: "clear" }
> = {
  "": { kind: "clear" },
  false: { kind: "set", value: false },
  true: { kind: "set", value: true },
};

const settingsBooleanField = (field: string): SettingsFieldSpec => ({
  field,
  format: (value: unknown) => (typeof value === "boolean" ? String(value) : ""),
  parse: (text: string) => BOOLEAN_DRAFTS[text.trim().toLowerCase()],
});

/**
 * A comma-separated list field. The stock text field round-trips strings,
 * but these fields are stored (and schema-validated) as string arrays — so
 * the draft must FORMAT the stored array into readable text and PARSE back
 * into an array, otherwise the current value is invisible and a save would
 * write a string the array schema rejects.
 */
const settingsListField = (field: string): SettingsFieldSpec => ({
  field,
  format: (value: unknown) =>
    Array.isArray(value)
      ? value
          .filter((item: unknown): item is string => typeof item === "string")
          .join(", ")
      : "",
  parse: (text: string) => {
    const entries = text
      .split(",")
      .map((item: string) => item.trim())
      .filter((item: string) => item.length > 0);
    return entries.length > 0
      ? { kind: "set", value: entries }
      : { kind: "clear" };
  },
});

/** The section fields this card edits, in render order. */
export const SPECS: SettingsFieldSpec[] = [
  settingsBooleanField(FIELD.injectUserAgent),
  settingsTextField(FIELD.userAgent),
  settingsBooleanField(FIELD.injectOriginHeaders),
  settingsTextField(FIELD.originClient),
  settingsBooleanField(FIELD.injectProject),
  settingsBooleanField(FIELD.injectCoreTools),
  settingsTextField(FIELD.freeModelMarker),
  settingsListField(FIELD.providers),
  settingsListField(FIELD.gatewayUrls),
  settingsTextField(FIELD.sessionIdEnv),
  settingsBooleanField(FIELD.usageEnabled),
  settingsTextField(FIELD.usageBaseURL),
  settingsTextField(FIELD.usageKeyEnv),
  settingsListField(FIELD.usageProviderMarkers),
];
