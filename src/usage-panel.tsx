/**
 * Presentational pieces of the OpenCode Go quota meter. `usage-pill.tsx` owns the
 * state and hands them everything they render; neither uses hooks, so both can be
 * invoked directly and asserted as an element tree.
 *
 * @module dsh-opencode-patch/usage-panel
 */

import { Tag, Tooltip } from "@deepseek-ai/dsh-client-ui-primitives";
import React from "react";

import { formatUsd } from "./go-limits.ts";
import type { GoUsage, UsageWindow } from "./usage-contract.ts";
import {
  BREAKDOWN_WINDOWS,
  CONSOLE_URL,
  formatRelativeReset,
  getWindowColor,
  panelActions,
  RADIUS,
  type UsageFailure,
} from "./usage-ui.ts";

/**
 * The refresh glyph, drawn here rather than imported: the host kit ships no icon
 * set, and a hand-rolled 12px arrow is smaller than any dependency that would
 * carry one. `currentColor` so it rides the muted label colour beside it.
 */
const RefreshIcon = (): React.ReactElement => (
  <svg
    aria-hidden="true"
    className="dsh-oc-usage-refresh-icon"
    fill="none"
    height="12"
    viewBox="0 0 16 16"
    width="12"
  >
    <path
      d="M13.5 8a5.5 5.5 0 1 1-1.61-3.89"
      stroke="currentColor"
      strokeLinecap="round"
      strokeWidth="1.5"
    />
    <path
      d="M13.2 1.8v3h-3"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.5"
    />
  </svg>
);

/** The ring / Zen pill that opens the panel. */
export interface UsageTriggerProps {
  displayPercent: number;
  isLimited: boolean;
  isZen: boolean;
  onClick: () => void;
  open: boolean;
  /** Stroke colour for the ring, from `getWindowColor`. */
  ringColor: string;
  showUsagePrice: boolean;
  /** Pre-computed ring dash array from `ringGeometry()`. */
  strokeDasharray: string;
  t: (key: string) => string;
  /** What hovering the trigger explains — the panel's own headline. */
  tooltipLabel: string;
  triggerLabel: string;
  usage: GoUsage | undefined;
}

export const UsageTrigger = ({
  displayPercent,
  isLimited,
  isZen,
  onClick,
  open,
  ringColor,
  showUsagePrice,
  strokeDasharray,
  t,
  tooltipLabel,
  triggerLabel,
  usage,
}: UsageTriggerProps): React.ReactElement => (
  // The `Tooltip` wraps the BUTTON, not this component: it clones its child and
  // attaches the handlers there, and a component that ignores them never shows
  // one. See AGENTS.md, "The meter's trigger".
  <Tooltip label={tooltipLabel} side="top">
    <button
      aria-expanded={open}
      aria-haspopup="dialog"
      aria-label={
        isZen
          ? `${t("zenPaygTitle")} (${t("zenPaygBadge")})`
          : `${t("usageTitle")}: ${displayPercent}%`
      }
      className={`dsh-oc-usage-trigger${isLimited ? " dsh-oc-usage-alert" : ""}`}
      onClick={onClick}
      type="button"
    >
      {/* The ring is the trigger for both providers; Zen's label is the spend. */}
      <svg aria-hidden="true" height="14" viewBox="0 0 14 14" width="14">
        <circle className="dsh-oc-usage-ring-track" cx="7" cy="7" r={RADIUS} />
        {/*
          Quota colors are CSS custom properties, which do not resolve in SVG
          presentation attributes — apply the token through `style` instead.
        */}
        <circle
          className="dsh-oc-usage-ring-fill"
          cx="7"
          cy="7"
          r={RADIUS}
          strokeDasharray={strokeDasharray}
          style={{ stroke: ringColor }}
          transform="rotate(-90 7 7)"
        />
      </svg>
      <span>
        {isZen && showUsagePrice && usage?.session !== undefined
          ? usage.session.costFormatted
          : triggerLabel}
      </span>
    </button>
  </Tooltip>
);

/** The hover/click panel: quota breakdown, spend, Zen overflow and actions. */
export interface UsagePanelProps {
  badgeText: string;
  failure: UsageFailure | null;
  isLimited: boolean;
  isZen: boolean;
  locale?: string;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
  refreshing: boolean;
  retry: () => void;
  showUsagePrice: boolean;
  t: (key: string) => string;
  /** The account's name — `OpenCode Go` / `OpenCode Zen`, stable across polls. */
  title: string;
  /** Epoch ms of the last successful read, or `null` while loading. */
  updatedAt: number | null;
  usage: GoUsage | undefined;
  zenCardCredit: string;
  zenCardDesc: string;
}

export const UsagePanel = ({
  badgeText,
  failure,
  isLimited,
  isZen,
  locale,
  onMouseEnter,
  onMouseLeave,
  refreshing,
  retry,
  showUsagePrice,
  t,
  title,
  updatedAt,
  usage,
  zenCardCredit,
  zenCardDesc,
}: UsagePanelProps): React.ReactElement => (
  <div
    aria-busy={refreshing}
    aria-label={isZen ? t("zenPaygTitle") : t("usageTitle")}
    className="dsh-oc-usage-panel"
    onMouseEnter={onMouseEnter}
    onMouseLeave={onMouseLeave}
    role="dialog"
  >
    {/*
      Header. The badge carries the billing model — `Pay-as-you-go` on Zen,
      `Go Plan` / the limit notice on Go — so no second line repeats it.
    */}
    <div className="dsh-oc-usage-header">
      <div className="dsh-oc-usage-headline">{title}</div>
      {/*
        The host's own chip, not a look-alike: a hand-rolled span here used the
        HOVER fill token as its resting background, so it sat permanently lit.
        `danger` is the host's tone for a limit; `neutral` is a plain label.
      */}
      <Tag tone={isLimited && !isZen ? "danger" : "neutral"}>{badgeText}</Tag>
    </div>

    {!isZen && (
      <>
        {/* Breakdown Section */}
        {usage !== undefined && (
          <div className="dsh-oc-usage-breakdown">
            {/* One row per window; the rate-limited badge now appears on
                every window that is limited, not only the monthly one. */}
            {BREAKDOWN_WINDOWS.map((entry) => {
              const window: UsageWindow = usage[entry.key];
              return (
                <div key={entry.key}>
                  <div className="dsh-oc-usage-row">
                    <span className="dsh-oc-usage-row-left">
                      <span
                        className="dsh-oc-usage-dot"
                        style={{
                          backgroundColor: getWindowColor(window),
                        }}
                      />
                      {t(entry.labelKey)}
                    </span>
                    <span className="dsh-oc-usage-row-right">
                      {window.percent}%
                    </span>
                  </div>
                  <div className="dsh-oc-usage-subrow">
                    <span>
                      {t("usageResets")}{" "}
                      {formatRelativeReset(window.resetsAt, locale)}
                    </span>
                    {window.status === "rate-limited" && (
                      <span className="dsh-oc-usage-limited">
                        {t("usageLimited")}
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/*
        What the percentage is a percentage OF. The three windows are shares of a
        per-model monthly dollar allowance, and that allowance is the one figure the
        live payload cannot supply — `/usage` takes no model parameter, so its
        percentages are the ACCOUNT's and multiplying them by this would be a number
        with no referent. So this row states the TOTAL, for both tiers: the plan is
        not discoverable (`/limits`, `/plan`, `/subscription` all 404), and a panel
        that guessed one would misstate the money by 2-3x.
      */}
        {usage?.allowance !== undefined && (
          <div className="dsh-oc-usage-detail">
            <div className="dsh-oc-usage-detail-left">
              <span className="dsh-oc-usage-detail-title">
                {t("monthlyAllowance")}
              </span>
              {/* WHICH model — the allowance is per model, so the figure is
                meaningless without it. */}
              <span className="dsh-oc-usage-detail-desc">
                {usage.allowance.model}
              </span>
            </div>
            <span className="dsh-oc-usage-detail-value">
              {t("goTier")} {formatUsd(usage.allowance.go)} · {t("goPlusTier")}{" "}
              {formatUsd(usage.allowance.goPlus)}
            </span>
          </div>
        )}

        <div className="dsh-oc-usage-divider" />

        {/*
          What to DO about the quota, in the layer that owns the quota. This row
          used to sit at the very bottom, under the update/console footer, where
          it read as one more global action rather than the answer to the windows
          directly above it — and on a Zen route the block it belonged to is not
          even rendered. Data, not branches: `panelActions` is the whole
          difference between the two popovers.
        */}
        {panelActions(isZen).length > 0 && (
          <div className="dsh-oc-usage-links">
            {panelActions(isZen).map((action) => (
              <a
                href={action.href}
                key={action.href}
                rel="noreferrer noopener"
                target="_blank"
              >
                {t(action.labelKey)}
              </a>
            ))}
          </div>
        )}
      </>
    )}

    {/* Session spend & active-model rate. Priced on the Host from
        models.dev rates, so the client never ships the catalog. */}
    {showUsagePrice && usage?.session !== undefined && (
      <div className="dsh-oc-usage-detail">
        <div className="dsh-oc-usage-detail-left">
          <span className="dsh-oc-usage-detail-title">{t("sessionSpend")}</span>
          {/*
            The SAME shape either way: which model, then what it costs. The free
            case used to drop the model entirely and print a bare sentence, so the
            one row that said "$0.00" was also the one row that could not say what
            you are paying for — and the id it fell back to
            (`muse-spark-1.3-contributor-free`) said "free" a third time.
          */}
          <span className="dsh-oc-usage-detail-desc">
            {`${usage.session.activeModelName ?? usage.session.activeModel ?? ""} · ${
              usage.session.freeModel === true
                ? t("freeModel")
                : (usage.session.activeRateFormatted ?? "")
            }`}
          </span>
        </div>
        <span className="dsh-oc-usage-detail-value">
          {usage.session.costFormatted}
        </span>
      </div>
    )}

    {/*
      The Zen card answers "where does an over-limit Go request get billed?"
      — so it belongs on the GO panel only. On a Zen route you are already
      paying per token, and there is no balance to report: OpenCode exposes no
      balance endpoint at all, so the row could only restate the badge.
    */}
    {!isZen && usage?.zenOverflow === true && (
      <div className="dsh-oc-usage-detail">
        <div className="dsh-oc-usage-detail-left">
          <span className="dsh-oc-usage-detail-title">{t("zenCredit")}</span>
          <span className="dsh-oc-usage-detail-desc">{zenCardDesc}</span>
        </div>
        <span className="dsh-oc-usage-detail-value">{zenCardCredit}</span>
      </div>
    )}

    {isLimited && !isZen && usage?.zenOverflow !== true ? (
      <div className="dsh-oc-usage-zen-notice">
        {t("usageZenFallbackNotice")}
      </div>
    ) : null}

    {/* Failure Alert */}
    {failure !== null && (
      <div className="dsh-oc-usage-warning" role="alert">
        <strong>{t("usageRefreshFailed")}</strong>
        <p>{failure.message ?? t("usageUnavailable")}</p>
      </div>
    )}

    {/*
      One row, three jobs: WHEN this reading was taken, a control to take a new
      one, and the console. The refresh is an icon rather than a labelled button
      because "更新于 06:46 PM" beside it already says what it does — a second
      label spelling that out was noise on a row this short.
    */}
    <div className="dsh-oc-usage-footer">
      <span className="dsh-oc-usage-updated">
        <button
          aria-label={refreshing ? t("usageRefreshing") : t("usageRetry")}
          className="dsh-oc-usage-refresh"
          disabled={refreshing}
          onClick={retry}
          type="button"
        >
          <RefreshIcon />
        </button>
        {updatedAt === null
          ? t("usageLoading")
          : `${t("usageLastUpdated")} ${new Date(updatedAt).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" })}`}
      </span>
      <a
        className="dsh-oc-usage-console"
        href={CONSOLE_URL}
        rel="noreferrer noopener"
        target="_blank"
      >
        {t(isZen ? "usageTopUp" : "usageConsole")}
      </a>
    </div>
  </div>
);
