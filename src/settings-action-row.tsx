/**
 * One action on the settings card, and the line that reports what it did.
 *
 * The purge, the removal of the ids pi cannot serve, and the store check are
 * the same shape — a title and a hint on the left, an outlined button on the
 * right that reads as busy while its action runs — and the shape was written
 * out three times. It is one component now; each row keeps its own state and
 * hands this the words.
 *
 * Hook-free, and styled by the card's sheet (`settings-css.ts`), which the
 * card renders.
 *
 * @module dsh-opencode-patch/settings-action-row
 */

import { Button } from "@deepseek-ai/dsh-client-ui-primitives";
import React from "react";

export interface ActionRowProps {
  /** The button's label at rest. */
  action: string;
  /** The button's label while the action runs. */
  busyAction: string;
  /** Whether the action is running; the button refuses a second click. */
  busy: boolean;
  /** A third line under the hint, for what the action would act on. */
  detail?: string;
  hint: string;
  onAction: () => void;
  title: string;
}

/** A title, a hint and an optional detail, beside the action's button. */
export const ActionRow: React.FC<ActionRowProps> = (props) => (
  <div className="dsh-oc-card-action">
    <div>
      <div className="dsh-oc-card-action-title">{props.title}</div>
      <div className="dsh-oc-card-action-hint">{props.hint}</div>
      {props.detail !== undefined && (
        <div className="dsh-oc-card-action-detail">{props.detail}</div>
      )}
    </div>
    <Button
      disabled={props.busy}
      onClick={props.onAction}
      size="sm"
      variant="outline"
    >
      {props.busy ? props.busyAction : props.action}
    </Button>
  </div>
);

/** One outcome line under an action, in the warn colour when it warns. */
export const OutcomeLine: React.FC<{ line: string; warn: boolean }> = (
  props
) => (
  <div
    className={
      props.warn
        ? "dsh-oc-card-outcome dsh-oc-card-outcome-warn"
        : "dsh-oc-card-outcome"
    }
  >
    {props.line}
  </div>
);
