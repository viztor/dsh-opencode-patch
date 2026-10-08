/**
 * The OpenCode Patch configuration card: a `SettingsForm` wrapping one control
 * per {@link CARD_FIELDS} entry, in register order — so adding a field is a
 * register entry rather than a JSX edit.
 *
 * A pure view: `settings-page.tsx` owns the store, the actions and the slot
 * registration, and hands them in as props.
 *
 * @module dsh-opencode-patch/settings-card
 */

import {
  SettingsForm,
  type SettingsFormShell,
} from "@deepseek-ai/dsh-client-ui-primitives";
import React from "react";

import { SettingsBooleanField } from "./settings-boolean-field.tsx";
import { SettingsChoiceField } from "./settings-choice-field.tsx";
import type { Translate } from "./settings-copy.ts";
import { CARD_FIELDS, type CardFieldSpec } from "./settings-fields.ts";
import { UsageSummary } from "./settings-usage.tsx";
import type { GoUsage } from "./usage-contract.ts";

interface CardField {
  invalid: boolean;
  overridden: boolean;
  text: string;
}

interface CardState {
  fields: Record<string, CardField>;
  shell: SettingsFormShell;
}

/** Section heading between register groups; `first` drops the separator rule. */
const GroupHeading: React.FC<{ first: boolean; label: string }> = (props) => (
  <div
    style={{
      borderTop: props.first
        ? undefined
        : "0.5px solid var(--dsw-alias-border-l2)",
      marginTop: props.first ? undefined : "10px",
      paddingTop: "6px",
    }}
  >
    <span
      style={{
        color: "var(--dsw-alias-label-caption)",
        fontSize: "12px",
        fontWeight: 600,
        letterSpacing: "0.02em",
      }}
    >
      {props.label}
    </span>
  </div>
);

export interface CardProps {
  discard: () => void;
  /** The active UI language, read at render so a switch moves this section too. */
  getLocale?: () => string | undefined;
  /** The Host's quota read; absent when the usage service is not registered. */
  readUsage?: () => Promise<GoUsage | undefined>;
  edit: (field: string, text: string) => void;
  resetField: (field: string) => void;
  save: () => void;
  t: Translate;
  useOpencodeCard: (selector: (snapshot: CardState) => CardState) => CardState;
  view: "summary" | "page";
}

const formLabels = (t: Translate) => ({
  readOnly: t("readOnly"),
  save: t("save"),
  saveFailed: t("saveFailed"),
  saving: t("saving"),
  unavailable: t("unavailable"),
});

export const OpencodeCard: React.FC<CardProps> = (props: CardProps) => {
  const { t } = props;
  if (props.view === "summary") {
    return <>{t("description")}</>;
  }

  const state = props.useOpencodeCard((snapshot) => snapshot);
  const disabled = !state.shell.writable;

  /** The staged draft for a field; a never-touched field is empty, not invalid. */
  const staged = (name: string): CardField =>
    state.fields[name] ?? { invalid: false, overridden: false, text: "" };

  /** Chrome shared by every control: id, edit/reset wiring, staged state. */
  const field = (name: string) => ({
    disabled,
    id: `plugin-config-opencode-${name}`,
    invalidLabel: t("invalidText"),
    onEdit: (text: string) => {
      props.edit(name, text);
    },
    onReset: () => {
      props.resetField(name);
    },
    overriddenLabel: t("overridden"),
    resetLabel: t("reset"),
    ...staged(name),
  });

  /** The subset a toggle needs: no placeholder, but the same invalid contract. */
  const boolField = (name: string) => {
    const { invalid, overridden, text: draft } = staged(name);
    return {
      disabled,
      id: `plugin-config-opencode-${name}`,
      invalid,
      invalidLabel: t("invalidText"),
      onEdit: (text: string) => {
        props.edit(name, text);
      },
      onReset: () => {
        props.resetField(name);
      },
      overridden,
      overriddenLabel: t("overridden"),
      resetLabel: t("reset"),
      text: draft,
    };
  };

  /** The control a register entry renders, chosen by its `kind`. */
  const controlFor = (entry: CardFieldSpec): React.ReactElement => {
    const label = t(entry.labelKey);
    const hint = t(entry.hintKey);
    if (entry.kind === "select") {
      return (
        <SettingsChoiceField
          {...field(entry.field)}
          hint={hint}
          key={entry.field}
          label={label}
          options={(entry.options ?? []).map((option) => ({
            label: t(option.labelKey),
            value: option.value,
          }))}
        />
      );
    }
    return (
      <SettingsBooleanField
        {...boolField(entry.field)}
        hint={hint}
        key={entry.field}
        label={label}
      />
    );
  };

  return (
    <>
      {/*
        The quota readout sits ABOVE the form and is deliberately NOT a floating
        card: this is a settings page, so it borrows the page's own row language
        (flat, hairline separator) rather than the composer popover's material.
      */}
      {props.readUsage !== undefined && (
        <div
          style={{
            borderBottom: "0.5px solid var(--dsw-alias-border-l2)",
            marginBottom: 12,
            paddingBottom: 12,
          }}
        >
          <UsageSummary
            getLocale={props.getLocale}
            readUsage={props.readUsage}
            t={t}
          />
        </div>
      )}
      <SettingsForm
        labels={formLabels(t)}
        onDiscard={props.discard}
        onSave={props.save}
        state={state.shell}
      >
        {CARD_FIELDS.flatMap((entry, index) => {
          const control = controlFor(entry);
          // The register keeps each group's entries contiguous, so a heading is
          // inserted exactly where the group changes — no second list of sections
          // to drift out of step with the fields.
          const startsGroup =
            index === 0 || CARD_FIELDS[index - 1]?.group !== entry.group;
          return startsGroup
            ? [
                <GroupHeading
                  first={index === 0}
                  key={`group-${entry.group}`}
                  label={t(entry.group)}
                />,
                control,
              ]
            : [control];
        })}
      </SettingsForm>
    </>
  );
};
