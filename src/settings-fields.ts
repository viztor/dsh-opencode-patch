/**
 * The card's view of the settings table: which keys the card edits, under
 * which heading, with which control and copy.
 *
 * Nothing here is a second list: {@link CARD_FIELDS} is read off
 * `settings-table.ts`, and {@link SPECS} and the card's JSX are derived from
 * it, so a field can no longer be bound but never rendered. The keys the card
 * leaves to the row are `CONFIG_ONLY_FIELDS`, in `config.ts`, beside the prose
 * that says why. The draft conversions below are ours because the host ships
 * no boolean or enum field spec.
 *
 * @module dsh-opencode-patch/settings-fields
 */

import type { SettingsFieldSpec } from "@deepseek-ai/dsh-client-ui-primitives";

import type { CopyKey } from "./settings-copy.ts";
import {
  type CardSettingKey,
  groupKeyOf,
  hintKeyOf,
  isCardSetting,
  isChoiceSetting,
  labelKeyOf,
  optionKeyOf,
  SETTING_KEYS,
  SETTINGS,
} from "./settings-table.ts";

/** Which control renders a field, and which draft conversion backs it. */
export type FieldKind = "boolean" | "select";

/** One choice a `select` field offers: the label is copy, the value is stored. */
export interface CardFieldOption {
  labelKey: CopyKey;
  value: string;
}

/** One rendered field: the knob, its control kind, and its copy. */
export interface CardFieldSpec {
  field: CardSettingKey;
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
 * Every field the card renders, in render order, grouped into sections: the
 * table's rows that name a `card` group, in table order.
 *
 * The table keeps each group's rows adjacent, because the card inserts a
 * heading where the group changes. Only decisions a user makes live here — the
 * override knobs are `CONFIG_ONLY_FIELDS`, in `config.ts`.
 */
export const CARD_FIELDS: readonly CardFieldSpec[] = SETTING_KEYS.filter(
  isCardSetting
).map((field): CardFieldSpec => {
  const entry = {
    field,
    group: groupKeyOf(SETTINGS[field].card),
    hintKey: hintKeyOf(field),
    labelKey: labelKeyOf(field),
  };
  // A boolean entry has no `options` key at all, not an undefined one.
  return isChoiceSetting(field)
    ? {
        ...entry,
        kind: "select",
        options: SETTINGS[field].values.map((value) => ({
          labelKey: optionKeyOf(field, value),
          value,
        })),
      }
    : { ...entry, kind: "boolean" };
});

/** The draft conversions the form model binds, derived from {@link CARD_FIELDS}. */
export const SPECS: SettingsFieldSpec[] = CARD_FIELDS.map(toSettingsFieldSpec);
