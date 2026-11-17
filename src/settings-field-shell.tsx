/**
 * Shared chrome for the card's non-text controls: label, override badge with its
 * reset, the control, and one message line. Keeping it here leaves each control
 * only what differs. Styled by the card's sheet (`settings-css.ts`).
 *
 * @module dsh-opencode-patch/settings-field-shell
 */

import { Button, Tag } from "@deepseek-ai/dsh-client-ui-primitives";
import React from "react";

export interface FieldShellProps {
  /** The control this row frames. */
  children: React.ReactNode;
  disabled: boolean;
  /** One-line explanation rendered under the control. */
  hint?: string;
  /** True when the draft is not a value this field accepts. */
  invalid: boolean;
  /** Copy shown in place of the hint while the draft is invalid. */
  invalidLabel: string;
  label: string;
  onReset: () => void;
  overridden: boolean;
  overriddenLabel: string;
  resetLabel: string;
  /**
   * Whether the control may drop under its label when the row is too narrow
   * for both. Set for the segmented choice, which is wider than a label's
   * room; a Switch stays beside its label and the label's text wraps instead.
   */
  wraps?: boolean;
}

export const SettingsFieldShell: React.FC<FieldShellProps> = (
  props: FieldShellProps
) => {
  const hint = props.hint ?? "";
  // Mirrors `SettingsValueField`: an invalid draft replaces the hint rather
  // than stacking a second message under it.
  const hasMessage = props.invalid || hint !== "";
  return (
    <div className="dsh-oc-card-field">
      <div
        className={
          props.wraps === true
            ? "dsh-oc-card-field-head dsh-oc-card-field-head-wraps"
            : "dsh-oc-card-field-head"
        }
      >
        <div className="dsh-oc-card-field-title">
          {/* Not a `<label for>`, and the shell takes no id: no control it
              frames carries the field id (the Switch takes none, the
              SegmentedControl ids only its tabs), and each names itself through
              its own `label`. Aiming `for` at the selected tab would rename that
              tab to the field's label. */}
          <span className="dsh-oc-card-field-label">{props.label}</span>
          {props.overridden ? (
            <span className="dsh-oc-card-field-override">
              <Tag tone="neutral">{props.overriddenLabel}</Tag>
              <Button
                disabled={props.disabled}
                onClick={props.onReset}
                size="sm"
                variant="ghost"
              >
                {props.resetLabel}
              </Button>
            </span>
          ) : null}
        </div>
        {props.children}
      </div>
      {hasMessage ? (
        <p
          className={
            props.invalid
              ? "dsh-oc-card-field-message dsh-oc-card-field-message-invalid"
              : "dsh-oc-card-field-message"
          }
        >
          {props.invalid ? props.invalidLabel : hint}
        </p>
      ) : null}
    </div>
  );
};
