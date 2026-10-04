/**
 * Shared chrome for the card's non-text controls: label, override badge with its
 * reset, the control, and one message line. Keeping it here leaves each control
 * only what differs.
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
  id: string;
  /** True when the draft is not a value this field accepts. */
  invalid: boolean;
  /** Copy shown in place of the hint while the draft is invalid. */
  invalidLabel: string;
  label: string;
  onReset: () => void;
  overridden: boolean;
  overriddenLabel: string;
  resetLabel: string;
}

export const SettingsFieldShell: React.FC<FieldShellProps> = (
  props: FieldShellProps
) => {
  const hint = props.hint ?? "";
  // Mirrors `SettingsValueField`: an invalid draft replaces the hint rather
  // than stacking a second message under it.
  const hasMessage = props.invalid || hint !== "";
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "6px",
        padding: "12px 0",
      }}
    >
      <div
        style={{
          alignItems: "center",
          display: "flex",
          gap: "8px",
        }}
      >
        <div
          style={{
            alignItems: "center",
            display: "flex",
            flex: "1",
            gap: "4px",
            minWidth: 0,
          }}
        >
          <label
            htmlFor={props.id}
            style={{
              color: "var(--dsw-alias-label-primary)",
              flex: "0 1 auto",
              fontSize: "13px",
              fontWeight: 500,
              lineHeight: 1.5,
            }}
          >
            {props.label}
          </label>
          {props.overridden ? (
            <span
              style={{
                alignItems: "center",
                display: "inline-flex",
                gap: "8px",
              }}
            >
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
          style={{
            color: props.invalid
              ? "var(--dsw-alias-state-error-primary)"
              : "var(--dsw-alias-label-tertiary)",
            fontSize: "12px",
            lineHeight: 1.5,
            margin: 0,
          }}
        >
          {props.invalid ? props.invalidLabel : hint}
        </p>
      ) : null}
    </div>
  );
};
