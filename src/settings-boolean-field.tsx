/**
 * Boolean settings field: the injected `Switch` inside the shared
 * {@link SettingsFieldShell}. See `AGENTS.md` → "Why the card owns its
 * boolean/list fields".
 *
 * @module dsh-opencode-patch/settings-boolean-field
 */

import { Switch } from "@deepseek-ai/dsh-client-ui-primitives";
import React from "react";

import { SettingsFieldShell } from "./settings-field-shell.tsx";

export interface BooleanFieldProps {
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
  overridden: boolean;
  overriddenLabel: string;
  resetLabel: string;
  text: string;
}

export const SettingsBooleanField: React.FC<BooleanFieldProps> = (
  props: BooleanFieldProps
) => (
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
    <Switch
      checked={props.text === "true"}
      disabled={props.disabled}
      label={props.label}
      onChange={(next: boolean) => {
        props.onEdit(String(next));
      }}
    />
  </SettingsFieldShell>
);
