/**
 * Constrained-choice settings field for the OpenCode Patch card.
 *
 * The host's own `SegmentedControl` inside the shared
 * {@link SettingsFieldShell}: a tablist of one segment per choice, keyboard-
 * and screen-reader-correct, unable to express a value outside the option set,
 * and styled by the host's CSS module, so there is no private stylesheet to
 * mirror. Both choice settings have three options, which is what a segmented
 * control is for.
 *
 * Copy-agnostic: the card resolves each option's label before passing it.
 *
 * @module dsh-opencode-patch/settings-choice-field
 */

import { SegmentedControl } from "@deepseek-ai/dsh-client-ui-primitives";
import React from "react";

import { SettingsFieldShell } from "./settings-field-shell.tsx";

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
  // A draft outside the option set (a hand-edited value, or none at all) is
  // carried on a segment of its own, shown as itself and selected, rather
  // than read as the first option — the select's blank carrier did the same.
  // Selected, it is the one segment in the tab order, so the arrow keys walk
  // from it to the real choices.
  const known = props.options.some((option) => option.value === props.text);
  const options = known
    ? props.options
    : [{ label: props.text, value: props.text }, ...props.options];
  return (
    <SettingsFieldShell
      disabled={props.disabled}
      hint={props.hint}
      invalid={props.invalid}
      invalidLabel={props.invalidLabel}
      label={props.label}
      onReset={props.onReset}
      overridden={props.overridden}
      overriddenLabel={props.overriddenLabel}
      resetLabel={props.resetLabel}
      wraps
    >
      <SegmentedControl
        disabled={props.disabled}
        id={props.id}
        label={props.label}
        onChange={props.onEdit}
        options={options}
        value={props.text}
      />
    </SettingsFieldShell>
  );
};
