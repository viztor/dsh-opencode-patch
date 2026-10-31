/**
 * The "check this machine" row: one button, and a report of what the local
 * OpenCode installation actually holds.
 *
 * Why it exists: the `readOpencodeStore` switch is a *permission*, and a
 * permission with no way to see what it would read is a blind choice. Turning it
 * on used to be the only affordance, so the honest question — "is there even an
 * OpenCode credential here, and whose is it?" — had no answer in the UI.
 *
 * Two properties are load-bearing:
 *
 * 1. **The secret never crosses the seam.** The host's inspection answers with a
 *    sanitized summary (account email, org name, credential kind, expiry) and
 *    never with the token. This module therefore cannot leak one: it is not
 *    handed one.
 * 2. **The report is a pure function.** {@link inspectLine} turns an outcome into
 *    rows, so every branch is reachable from a test without mounting React — the
 *    same contract `purgeLine` keeps, and the reason that container has no
 *    decisions left in it.
 *
 * @module dsh-opencode-patch/settings-store-inspect
 */

import { Button } from "@deepseek-ai/dsh-client-ui-primitives";
import React from "react";

import type { OpencodeStoreInspection } from "./opencode-store-contract.ts";
import type { Translate } from "./settings-copy.ts";
import type { StoreInspectOutcome } from "./settings-store.ts";

/** One labelled row of the report. */
export interface InspectRow {
  readonly label: string;
  readonly value: string;
}

/** What one inspection renders: rows when it found something, else one line. */
export interface InspectReport {
  /** Labelled rows, in reading order. Empty when there is nothing to detail. */
  readonly rows: readonly InspectRow[];
  /** A single sentence when there are no rows, or a caveat beside them. */
  readonly note?: string;
  /** Whether the note reads as a problem rather than a fact. */
  readonly warn: boolean;
}

/** The credential kind, in the reader's language. */
const kindLabel = (t: Translate, kind: string): string => {
  if (kind === "oauth") {
    return t("storeInspectKindOauth");
  }
  if (kind === "key") {
    return t("storeInspectKindKey");
  }
  return t("storeInspectKindUnknown");
};

/** The expiry as a date plus a verdict, or `undefined` when the date is junk. */
const expiryLabel = (
  t: Translate,
  locale: string | undefined,
  expiresAt: string,
  expired: boolean | undefined,
  refreshable: boolean
): string | undefined => {
  const at = Date.parse(expiresAt);
  if (!Number.isFinite(at)) {
    return undefined;
  }
  const when =
    locale === undefined
      ? new Date(at).toISOString()
      : new Date(at).toLocaleString(locale);
  // Three verdicts, not two. A session that can refresh is renewed the next time
  // the CLI uses it, so calling that "expired" would be a false alarm on the
  // ordinary state of a working installation — and a reader who learns to ignore
  // the warning is worse off than one who never saw it.
  let verdict = t("storeInspectValid");
  if (expired === true) {
    verdict = refreshable
      ? t("storeInspectRefreshable")
      : t("storeInspectExpired");
  }
  return `${when} · ${verdict}`;
};

/** The report for one inspection result. Pure, so a test can call it. */
export const inspectLine = (
  t: Translate,
  outcome: StoreInspectOutcome,
  locale?: string
): InspectReport => {
  if (outcome.kind === "unavailable") {
    return { note: t("storeInspectUnavailable"), rows: [], warn: true };
  }
  if (outcome.kind === "failed") {
    return {
      note: `${t("storeInspectFailed")}: ${outcome.message}`,
      rows: [],
      warn: true,
    };
  }
  const { inspection } = outcome;
  if (!inspection.found) {
    return { note: t("storeInspectMissing"), rows: [], warn: true };
  }
  const { account } = inspection;
  if (account === undefined) {
    return { note: t("storeInspectNoAccount"), rows: [], warn: true };
  }
  const rows: InspectRow[] = [];
  if (account.email !== undefined) {
    rows.push({ label: t("storeInspectAccount"), value: account.email });
  }
  if (account.orgName !== undefined) {
    rows.push({ label: t("storeInspectOrg"), value: account.orgName });
  }
  rows.push({
    label: t("storeInspectKind"),
    value: kindLabel(t, account.type),
  });
  const refreshable = account.refreshable === true;
  if (account.expiresAt !== undefined) {
    const value = expiryLabel(
      t,
      locale,
      account.expiresAt,
      account.expired === true,
      refreshable
    );
    if (value !== undefined) {
      rows.push({ label: t("storeInspectExpires"), value });
    }
  }
  return {
    rows,
    // Only an expiry the installation cannot renew is worth a warning: that is
    // the state in which the switch can be on and still read nothing.
    warn: account.expired === true && !refreshable,
  };
};

export interface StoreInspectRowProps {
  getLocale?: (() => string | undefined) | undefined;
  onInspect: () => Promise<StoreInspectOutcome>;
  t: Translate;
}

/**
 * The row itself: a heading, the button, and the report once it lands.
 *
 * The report is kept after the click rather than cleared, because the question it
 * answers ("what is on this machine?") does not go stale in seconds — and a row
 * that emptied itself would look like the check had failed.
 */
export const StoreInspectRow: React.FC<StoreInspectRowProps> = (props) => {
  const [state, setState] = React.useState<{
    busy: boolean;
    report?: InspectReport;
  }>({ busy: false });

  const run = async (): Promise<void> => {
    setState({ busy: true });
    const outcome = await props.onInspect();
    setState({
      busy: false,
      report: inspectLine(props.t, outcome, props.getLocale?.()),
    });
  };

  const { report } = state;

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
            {props.t("storeInspectTitle")}
          </div>
          <div
            style={{
              color: "var(--dsw-alias-label-caption)",
              fontSize: 12,
              marginTop: 2,
            }}
          >
            {props.t("storeInspectHint")}
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
          {state.busy ? props.t("storeInspectBusy") : props.t("storeInspect")}
        </Button>
      </div>
      {report !== undefined && (
        <div style={{ fontSize: 12, marginTop: 8 }}>
          {report.rows.map((row) => (
            <div
              key={row.label}
              style={{
                display: "flex",
                gap: 8,
                padding: "1px 0",
              }}
            >
              <span
                style={{
                  color: "var(--dsw-alias-label-caption)",
                  flex: "0 0 auto",
                  minWidth: 72,
                }}
              >
                {row.label}
              </span>
              <span
                style={{
                  color: "var(--dsw-alias-label-secondary)",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {row.value}
              </span>
            </div>
          ))}
          {report.note !== undefined && (
            <div
              style={{
                color: report.warn
                  ? "var(--dsw-alias-state-warn-label, var(--dsw-alias-label-caption))"
                  : "var(--dsw-alias-label-caption)",
                marginTop: 6,
              }}
            >
              {report.note}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

/** Re-exported so a caller need not reach into the contract module. */
export type { OpencodeStoreInspection };
