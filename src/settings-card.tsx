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
  Button,
  SettingsForm,
  type SettingsFormShell,
} from "@deepseek-ai/dsh-client-ui-primitives";
import React from "react";

import { SettingsBooleanField } from "./settings-boolean-field.tsx";
import { SettingsChoiceField } from "./settings-choice-field.tsx";
import { withBundleCopy, type Translate } from "./settings-copy.ts";
import { CARD_FIELDS, FIELD, type CardFieldSpec } from "./settings-fields.ts";
import type { PurgeOutcome } from "./settings-purge.ts";
import { StoreInspectRow } from "./settings-store-inspect.tsx";
import type { StoreInspectOutcome } from "./settings-store.ts";
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

/**
 * The purge row: one sentence, one button, and the outcome underneath.
 *
 * It says "rewrites your profile" rather than "hides", because that is what it
 * does — a read-time filter would leave the declaration in place and make the
 * model's absence unexplainable from the configuration.
 */
/**
 * What one outcome says, and whether it reads as a warning.
 *
 * Pure, so every branch is reachable from a test without mounting a component —
 * the container below then has no decisions left in it.
 */
export const purgeLine = (
  t: Translate,
  outcome: PurgeOutcome
): { line: string; warn: boolean } => {
  if (outcome.kind === "unavailable") {
    return { line: t("purgeUnavailable"), warn: true };
  }
  if (outcome.kind === "failed") {
    return { line: `${t("purgeFailed")}: ${outcome.message}`, warn: true };
  }
  if (outcome.result.removed.length === 0) {
    return outcome.result.catalogRead
      ? { line: t("purgeNothing"), warn: false }
      : { line: t("purgeCatalogUnread"), warn: true };
  }
  return {
    line: `${String(outcome.result.removed.length)} ${t("purgeRemoved")}`,
    warn: false,
  };
};

const PurgeRow: React.FC<{
  onPurge: () => Promise<PurgeOutcome>;
  t: Translate;
}> = (props) => {
  const [state, setState] = React.useState<{
    busy: boolean;
    line?: string;
    warn?: boolean;
  }>({ busy: false });

  const run = async (): Promise<void> => {
    setState({ busy: true });
    const outcome = await props.onPurge();
    setState({ busy: false, ...purgeLine(props.t, outcome) });
  };

  return (
    <div
      style={{
        borderBottom: "0.5px solid var(--dsw-alias-border-l2)",
        marginBottom: 16,
        paddingBottom: 14,
      }}
    >
      <div
        style={{
          alignItems: "center",
          display: "flex",
          gap: 12,
          justifyContent: "space-between",
        }}
      >
        <div>
          <div style={{ fontSize: 13, fontWeight: 600 }}>
            {props.t("purgeTitle")}
          </div>
          <div
            style={{
              color: "var(--dsw-alias-label-caption)",
              fontSize: 12,
              marginTop: 2,
            }}
          >
            {props.t("purgeHint")}
          </div>
        </div>
        <Button
          disabled={state.busy}
          onClick={() => {
            void run();
          }}
          size="sm"
          variant="outline"
        >
          {state.busy ? props.t("purgeBusy") : props.t("purgeAction")}
        </Button>
      </div>
      {state.line !== undefined && (
        <div
          style={{
            color: state.warn
              ? "var(--dsw-alias-state-warn-label)"
              : "var(--dsw-alias-label-caption)",
            fontSize: 12,
            marginTop: 6,
          }}
        >
          {state.line}
        </div>
      )}
    </div>
  );
};

export interface CardProps {
  discard: () => void;
  /** The active UI language, read at render so a switch moves this section too. */
  getLocale?: () => string | undefined;
  /** The Host's quota read; absent when the usage service is not registered. */
  readUsage?: () => Promise<GoUsage | undefined>;
  /**
   * The Host's purge action, absent when no purge service is mounted. The row is
   * rendered only when this exists: a button that cannot act is worse than no
   * row, because it invites a click that explains nothing.
   */
  purgeDeprecated?: () => Promise<PurgeOutcome>;
  /**
   * The Host's local-store inspection, absent when no store service is mounted.
   * Rendered only when present, for the same reason the purge row is: a button
   * that cannot act invites a click that explains nothing.
   */
  inspectStore?: () => Promise<StoreInspectOutcome>;
  /**
   * The Host's sign-in remote. Never absent: the page always hands over the three
   * calls, and each resolves the service when it is invoked, so a remote that mounts
   * late is still reached and a host that mounts none shows a row that says so.
   */

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
  // The seat's dictionary first, this bundle's second. Not a belt-and-braces
  // measure: the locale service keeps one dictionary per namespace, so a page
  // that outlived a rebuild serves the older one and renders every newer key
  // verbatim — `storeInspectTitle` reached the screen exactly that way. The meter
  // already stopped trusting the seat; the card is the same surface, one row up.
  const t = withBundleCopy(props.t, props.getLocale);
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
    // The host's own font, named explicitly rather than inherited. A plugin card
    // rendered into the settings page inherits from whatever wraps it, and what
    // wraps it does not set the family - so the text fell back to the browser's
    // default and read as a different typeface from the rest of the interface.
    // The token is the host's; the fallback is `inherit`, which is what happened
    // before, so naming it cannot make a correct container worse.
    <div style={{ fontFamily: "var(--dsw-font-family, inherit)" }}>
      {/*
        The quota readout sits ABOVE the form and is deliberately NOT a floating
        card: this is a settings page, so it borrows the page's own row language
        (flat, hairline separator) rather than the composer popover's material.
      */}
      {props.readUsage !== undefined && (
        <div
          style={{
            borderBottom: "0.5px solid var(--dsw-alias-border-l2)",
            // Room to breathe: these blocks are three different things - who is
            // signed in, what the quota is, and the form - and 12px made them
            // read as one crowded column, with the hairline doing all the
            // separating.
            marginBottom: 20,
            paddingBottom: 16,
          }}
        >
          <UsageSummary
            getLocale={props.getLocale}
            readUsage={props.readUsage}
            t={t}
          />
        </div>
      )}
      {props.purgeDeprecated !== undefined && (
        <PurgeRow onPurge={props.purgeDeprecated} t={t} />
      )}
      <SettingsForm
        labels={formLabels(t)}
        onDiscard={props.discard}
        onSave={props.save}
        state={state.shell}
      >
        {CARD_FIELDS.flatMap((entry, index) => {
          const control = controlFor(entry);
          // The permission and the evidence for it travel together: the switch
          // says what MAY be read, the row says what IS there. Splitting them
          // across the card is what left "turn this on" as a blind choice.
          const beside =
            entry.field === FIELD.readOpencodeStore &&
            props.inspectStore !== undefined
              ? [
                  <StoreInspectRow
                    getLocale={props.getLocale}
                    key="store-inspect"
                    onInspect={props.inspectStore}
                    t={t}
                  />,
                ]
              : [];
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
                ...beside,
              ]
            : [control, ...beside];
        })}
      </SettingsForm>
    </div>
  );
};
