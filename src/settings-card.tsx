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

import type { PurgeReview } from "./contracts/purge.ts";
import type { GoUsage } from "./contracts/usage.ts";
import { ActionRow, OutcomeLine } from "./settings-action-row.tsx";
import { SettingsBooleanField } from "./settings-boolean-field.tsx";
import { SettingsChoiceField } from "./settings-choice-field.tsx";
import { withBundleCopy, type Translate } from "./settings-copy.ts";
import { CARD_STYLES } from "./settings-css.ts";
import { CARD_FIELDS, type CardFieldSpec } from "./settings-fields.ts";
import type { PurgeOutcome, ReviewOutcome } from "./settings-purge.ts";
import { StoreInspectRow } from "./settings-store-inspect.tsx";
import type { StoreInspectOutcome } from "./settings-store.ts";
import { UsageSummary } from "./settings-usage.tsx";

interface CardField {
  invalid: boolean;
  overridden: boolean;
  text: string;
}

interface CardState {
  fields: Record<string, CardField>;
  shell: SettingsFormShell;
}

/**
 * Section heading between register groups. The sheet draws the separator rule
 * on every heading after the first, so the heading needs no position prop.
 */
const GroupHeading: React.FC<{ label: string }> = (props) => (
  <div className="dsh-oc-card-group">
    <span className="dsh-oc-card-group-label">{props.label}</span>
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

/**
 * What a review says: the catalog's last error, the ids pi cannot serve
 * grouped by provider in first-seen order (`opencode: a, b · opencode-go: c`),
 * and that pi's installed catalog could not be read, when it could not (a
 * review that read nothing lists nothing, and would otherwise say nothing).
 * Each line is absent when there is nothing to say.
 */
export const reviewLines = (
  t: Translate,
  review: PurgeReview
): { error?: string; piUnread?: string; unserved?: string } => {
  const byProvider = new Map<string, string[]>();
  for (const { id, provider } of review.unserved) {
    byProvider.set(provider, [...(byProvider.get(provider) ?? []), id]);
  }
  return {
    ...(review.catalogError === undefined
      ? {}
      : { error: `${t("catalogLastError")}: ${review.catalogError}` }),
    ...(review.piRead ? {} : { piUnread: t("unservedPiUnreadReview") }),
    ...(byProvider.size === 0
      ? {}
      : {
          unserved: [...byProvider]
            .map(([provider, ids]) => `${provider}: ${ids.join(", ")}`)
            .join(" · "),
        }),
  };
};

/**
 * What one removal of the unserved ids says, and whether it reads as a
 * warning: a refusal as the purge's, and "nothing removed" told apart from
 * "pi's catalog could not be read".
 */
export const unservedLine = (
  t: Translate,
  outcome: PurgeOutcome
): { line: string; warn: boolean } => {
  if (outcome.kind !== "purged") {
    return purgeLine(t, outcome);
  }
  if (outcome.result.removed.length === 0) {
    return outcome.result.catalogRead
      ? { line: t("unservedNothing"), warn: false }
      : { line: t("unservedPiUnread"), warn: true };
  }
  return {
    line: `${String(outcome.result.removed.length)} ${t("unservedRemoved")}`,
    warn: false,
  };
};

const PurgeRow: React.FC<{
  onPurge: () => Promise<PurgeOutcome>;
  onReview?: () => Promise<ReviewOutcome>;
  onRemoveUnserved?: () => Promise<PurgeOutcome>;
  t: Translate;
}> = (props) => {
  const [state, setState] = React.useState<{
    busy: boolean;
    line?: string;
    warn?: boolean;
  }>({ busy: false });
  const [removal, setRemoval] = React.useState<{
    busy: boolean;
    line?: string;
    warn?: boolean;
  }>({ busy: false });
  const [review, setReview] = React.useState<PurgeReview | undefined>();
  // Bumped after each purge or removal settles, so the review is read again.
  const [round, setRound] = React.useState(0);

  // The latest callback, read through a ref: the page builds a fresh closure
  // on every render, and a review per parent render is not what this asks.
  const reviewRef = React.useRef(props.onReview);
  reviewRef.current = props.onReview;
  const reviews = props.onReview !== undefined;
  React.useEffect(() => {
    const onReview = reviewRef.current;
    let live = true;
    if (reviews && onReview !== undefined) {
      void (async () => {
        const outcome = await onReview();
        if (live) {
          setReview(outcome.kind === "review" ? outcome.review : undefined);
        }
      })();
    }
    return () => {
      live = false;
    };
  }, [reviews, round]);

  const run = async (): Promise<void> => {
    setState({ busy: true });
    const outcome = await props.onPurge();
    setState({ busy: false, ...purgeLine(props.t, outcome) });
    setRound((value) => value + 1);
  };

  const remove = async (
    onRemoveUnserved: () => Promise<PurgeOutcome>
  ): Promise<void> => {
    setRemoval({ busy: true });
    const outcome = await onRemoveUnserved();
    setRemoval({ busy: false, ...unservedLine(props.t, outcome) });
    setRound((value) => value + 1);
  };

  const lines = review === undefined ? {} : reviewLines(props.t, review);
  const { onRemoveUnserved } = props;

  return (
    <div className="dsh-oc-card-section">
      <ActionRow
        action={props.t("purgeAction")}
        busy={state.busy}
        busyAction={props.t("purgeBusy")}
        hint={props.t("purgeHint")}
        onAction={() => {
          void run();
        }}
        title={props.t("purgeTitle")}
      />
      {state.line !== undefined && (
        <OutcomeLine line={state.line} warn={state.warn === true} />
      )}
      {lines.error !== undefined && <OutcomeLine line={lines.error} warn />}
      {/*
        The ids pi cannot serve: listed only when there is something to act on,
        because the removal deletes models the plugin serves today. It is the
        step before removing the plugin, which the hint says.
      */}
      {lines.unserved !== undefined && onRemoveUnserved !== undefined && (
        <ActionRow
          action={props.t("unservedAction")}
          busy={removal.busy}
          busyAction={props.t("unservedBusy")}
          detail={lines.unserved}
          hint={props.t("unservedHint")}
          onAction={() => {
            void remove(onRemoveUnserved);
          }}
          title={props.t("unservedTitle")}
        />
      )}
      {lines.piUnread !== undefined && onRemoveUnserved !== undefined && (
        <OutcomeLine line={lines.piUnread} warn />
      )}
      {removal.line !== undefined && (
        <OutcomeLine line={removal.line} warn={removal.warn === true} />
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
   * The Host's review of the declared ids pi cannot serve, read beside the
   * purge row on mount and after each action settles; absent, the row is as
   * it was.
   */
  reviewPurge?: () => Promise<ReviewOutcome>;
  /** The Host's removal of those ids; the block renders only with it. */
  removeUnserved?: () => Promise<PurgeOutcome>;
  /**
   * The Host's local-store inspection, absent when no store service is mounted.
   * Rendered only when present, for the same reason the purge row is: a button
   * that cannot act invites a click that explains nothing.
   */
  inspectStore?: () => Promise<StoreInspectOutcome>;
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

  /**
   * A choice's chrome: the id its segments are named after, edit/reset wiring,
   * staged state.
   */
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

  /**
   * The subset a toggle needs: no id (the Switch takes none, and the shell
   * renders no `for`), but the same invalid contract.
   */
  const boolField = (name: string) => {
    const { invalid, overridden, text: draft } = staged(name);
    return {
      disabled,
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
    // The host's own font, named by the sheet (`settings-css.ts`) rather than
    // inherited: what wraps a plugin card does not set the family.
    <div className="dsh-oc-card">
      {/*
        The card's own stylesheet, rendered as an element of its tree so React
        removes it with the card; nothing is appended to `document.head`. Every
        row below is styled by it, the store row and the summary included.
      */}
      <style>{CARD_STYLES}</style>
      {/*
        The quota readout sits ABOVE the form and is deliberately NOT a floating
        card: this is a settings page, so it borrows the page's own row language
        (flat, hairline separator) rather than the composer popover's material.
      */}
      {props.readUsage !== undefined && (
        <div className="dsh-oc-card-section dsh-oc-card-section-usage">
          <UsageSummary
            getLocale={props.getLocale}
            readUsage={props.readUsage}
            t={t}
          />
        </div>
      )}
      {props.purgeDeprecated !== undefined && (
        <PurgeRow
          onPurge={props.purgeDeprecated}
          onRemoveUnserved={props.removeUnserved}
          onReview={props.reviewPurge}
          t={t}
        />
      )}
      {/*
        A Settings write takes the loader's volatile-only path and the plugin
        reads its row once, at apply: said once, above the form, rather than in
        every control's hint.
      */}
      <div className="dsh-oc-card-note">{t("appliesOnReapply")}</div>
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
            entry.field === "readOpencodeStore" &&
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
