/**
 * Constrained-choice settings field for the OpenCode Patch card.
 *
 * A native `<select>` inside the shared {@link SettingsFieldShell}: keyboard- and
 * screen-reader-correct, and unable to express a value outside the option set.
 * That is the host's own idiom for a stored enum — `ui-settings-models`'
 * `ProviderEditor` renders its protocol picker the same way, down to the "name
 * the empty option so a screen reader does not announce a choice with no
 * identity" rule. Its stylesheet is private, so {@link SELECT_STYLE} mirrors
 * `ModelsSection.module.css`'s `.input` / `select.input` / `.selectInput` with the
 * same design tokens.
 *
 * Copy-agnostic: the card resolves each option's label before passing it.
 *
 * @module dsh-opencode-patch/settings-choice-field
 */

import React from "react";

import { SettingsFieldShell } from "./settings-field-shell.tsx";

/**
 * Chevron for the closed select, lifted verbatim from the host's `.selectInput`.
 * `appearance: none` removes the native arrow, so one has to be drawn; a data
 * URI cannot resolve a CSS variable, hence the hard-coded caption gray that the
 * host shares across both themes.
 */
const CHEVRON =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12' fill='none'%3E%3Cpath d='M3 4.5L6 7.5L9 4.5' stroke='%2381858C' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E\")";

/**
 * The settings form's input metrics (`fields.module.css`'s `.input`), plus the
 * chevron and `appearance: none` an enum picker needs. Matching `.input` rather
 * than a text field's look is the point: this control sits directly beside
 * `SettingsValueField` rows and has to read as the same kind of control.
 */
const SELECT_STYLE: React.CSSProperties = {
  appearance: "none",
  backgroundColor: "var(--dsw-alias-bg-layer-3)",
  backgroundImage: CHEVRON,
  backgroundPosition: "right 12px center",
  backgroundRepeat: "no-repeat",
  backgroundSize: "12px 12px",
  border: "0.5px solid var(--dsw-alias-border-l4)",
  borderRadius: "var(--dsw-radius-md)",
  boxSizing: "border-box",
  color: "var(--dsw-alias-label-primary)",
  cursor: "pointer",
  font: "inherit",
  fontSize: "13px",
  height: "34px",
  lineHeight: 1.5,
  // A field-width dropdown reads as a text field the user is meant to fill.
  maxWidth: "240px",
  padding: "0 32px 0 12px",
};

/** One selectable value, with its label already resolved. */
export interface ChoiceOption {
  label: string;
  value: string;
}

export interface ChoiceFieldProps {
  disabled: boolean;
  /** One-line explanation rendered under the control. */
  hint?: string;
  id: string;
  /** True when the draft is not a value this field accepts. */
  invalid: boolean;
  /** Copy shown in place of the hint while the draft is invalid. */
  invalidLabel: string;
  label: string;
  onEdit: (text: string) => void;
  onReset: () => void;
  options: readonly ChoiceOption[];
  overridden: boolean;
  overriddenLabel: string;
  resetLabel: string;
  text: string;
}

export const SettingsChoiceField: React.FC<ChoiceFieldProps> = (
  props: ChoiceFieldProps
) => {
  // A draft outside the option set cannot be rendered by a select, so it gets a
  // blank carrier option rather than making React fall back to the first one.
  const known = props.options.some((option) => option.value === props.text);
  return (
    <SettingsFieldShell
      disabled={props.disabled}
      hint={props.hint}
      id={props.id}
      invalid={props.invalid}
      invalidLabel={props.invalidLabel}
      label={props.label}
      onReset={props.onReset}
      overridden={props.overridden}
      overriddenLabel={props.overriddenLabel}
      resetLabel={props.resetLabel}
    >
      <select
        aria-label={props.label}
        disabled={props.disabled}
        id={props.id}
        onChange={(event) => {
          props.onEdit(event.target.value);
        }}
        style={SELECT_STYLE}
        value={props.text}
      >
        {known ? null : <option value={props.text} />}
        {props.options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </SettingsFieldShell>
  );
};
