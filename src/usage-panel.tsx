/**
 * Presentational pieces of the OpenCode Go quota meter. `usage-pill.tsx` owns the
 * state and hands them everything they render; neither uses hooks, so both can be
 * invoked directly and asserted as an element tree.
 *
 * @module dsh-opencode-patch/usage-panel
 */

import React from "react";

import type { GoUsage, UsageWindow } from "./usage-contract.ts";
import {
  BREAKDOWN_WINDOWS,
  formatRelativeReset,
  GO_CONSOLE_URL,
  GO_LIMITS_DOC_URL,
  GO_PLAN_URL,
  getWindowColor,
  RADIUS,
  type UsageFailure,
} from "./usage-ui.ts";

/** The ring / Zen pill that opens the panel. */
export interface UsageTriggerProps {
  displayPercent: number;
  isLimited: boolean;
  isZen: boolean;
  onClick: () => void;
  open: boolean;
  ringColor: string;
  showUsagePrice: boolean;
  /** Pre-computed ring dash array from `ringGeometry()`. */
  strokeDasharray: string;
  t: (key: string) => string;
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
  triggerLabel,
  usage,
}: UsageTriggerProps): React.ReactElement => (
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
    {/*
      The ring is the trigger, for both providers. Zen used to render a coin emoji
      here instead, which the user asked to be removed — and which renders as a
      moon in some font stacks, so it did not even read as a coin. Zen has no quota
      windows of its own, so its ring tracks whatever the API reports and the label
      carries the session spend.
    */}
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
);

/** The hover/click panel: quota breakdown, spend, Zen overflow and actions. */
export interface UsagePanelProps {
  badgeText: string;
  clampedPercent: number;
  failure: UsageFailure | null;
  headline: string;
  isLimited: boolean;
  isZen: boolean;
  locale?: string;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
  refreshing: boolean;
  retry: () => void;
  ringColor: string;
  showUsagePrice: boolean;
  t: (key: string) => string;
  /** Epoch ms of the last successful read, or `null` while loading. */
  updatedAt: number | null;
  usage: GoUsage | undefined;
  zenCardCredit: string;
  zenCardDesc: string;
}

export const UsagePanel = ({
  badgeText,
  clampedPercent,
  failure,
  headline,
  isLimited,
  isZen,
  locale,
  onMouseEnter,
  onMouseLeave,
  refreshing,
  retry,
  ringColor,
  showUsagePrice,
  t,
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
    {/* Header */}
    <div className="dsh-oc-usage-header">
      <div>
        <div className="dsh-oc-usage-headline">{headline}</div>
        {isZen && (
          <div className="dsh-oc-zen-card-desc">{t("zenPaygDesc")}</div>
        )}
      </div>
      <span
        className={`dsh-oc-usage-badge${isLimited && !isZen ? " dsh-oc-badge-limited" : ""}`}
      >
        {badgeText}
      </span>
    </div>

    {!isZen && (
      <>
        {/* Primary Accent Progress Bar */}
        <div className="dsh-oc-usage-bar-track">
          <div
            className="dsh-oc-usage-bar-fill"
            style={{
              backgroundColor: ringColor,
              width: `${clampedPercent}%`,
            }}
          />
        </div>

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
                      Resets {formatRelativeReset(window.resetsAt, locale)}
                    </span>
                    {window.status === "rate-limited" && (
                      <span
                        style={{
                          color: "var(--dsw-alias-state-error-primary)",
                          fontWeight: 600,
                        }}
                      >
                        {t("usageLimited")}
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Divider */}
        <div className="dsh-oc-usage-divider" />

        {/* Balance Cards (Image 2 pattern) */}
        {usage !== undefined && (
          <>
            <div className="dsh-oc-usage-section-title">Quota Overview</div>
            <div className="dsh-oc-usage-cards">
              {BREAKDOWN_WINDOWS.map((entry) => {
                const window: UsageWindow = usage[entry.key];
                const limited = window.status === "rate-limited";
                return (
                  <div
                    className={`dsh-oc-usage-card${limited ? " dsh-oc-card-limited" : ""}`}
                    key={entry.key}
                  >
                    <span className="dsh-oc-usage-card-name">
                      {entry.cardName}
                    </span>
                    <span
                      className="dsh-oc-usage-card-percent"
                      style={{ color: getWindowColor(window) }}
                    >
                      {window.percent}%
                    </span>
                    <span className="dsh-oc-usage-card-reset">
                      {formatRelativeReset(window.resetsAt, locale)}
                    </span>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </>
    )}

    {/* Session spend & active-model rate. Priced on the Host from
        models.dev rates, so the client never ships the catalog. */}
    {showUsagePrice && usage?.session !== undefined && (
      <div className="dsh-oc-zen-card">
        <div className="dsh-oc-zen-card-left">
          <span className="dsh-oc-zen-card-title">{t("sessionSpend")}</span>
          <span className="dsh-oc-zen-card-desc">
            {usage.session.includedInPlan === true
              ? t("includedInPlan")
              : `${usage.session.activeModel ?? ""} · ${usage.session.activeRateFormatted ?? ""}`}
          </span>
        </div>
        <span className="dsh-oc-zen-card-credit">
          {usage.session.costFormatted}
        </span>
      </div>
    )}

    {/* Attached Zen Overflow Card */}
    {(isZen || usage?.zenOverflow === true) && (
      <div className="dsh-oc-zen-card">
        <div className="dsh-oc-zen-card-left">
          <span className="dsh-oc-zen-card-title">{t("zenCredit")}</span>
          <span className="dsh-oc-zen-card-desc">{zenCardDesc}</span>
        </div>
        <span className="dsh-oc-zen-card-credit">{zenCardCredit}</span>
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

    {/* Footer with updated timestamp & retry */}
    <div className="dsh-oc-usage-footer">
      <span>
        {updatedAt === null
          ? t("usageLoading")
          : `${t("usageLastUpdated")} ${new Date(updatedAt).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" })}`}
      </span>
      <button
        className="dsh-oc-usage-retry"
        disabled={refreshing}
        onClick={retry}
        type="button"
      >
        {refreshing ? t("usageRefreshing") : t("usageRetry")}
      </button>
    </div>
    {/*
      The meter says a limit was hit; these say what to do about it.
      Both open in a new tab so the console is not lost, and both carry
      rel="noreferrer noopener" because the target is a third party.
    */}
    <div className="dsh-oc-usage-links">
      <a href={GO_PLAN_URL} rel="noreferrer noopener" target="_blank">
        {t("usageUpgradePlan")}
      </a>
      <a href={GO_CONSOLE_URL} rel="noreferrer noopener" target="_blank">
        {t("usageConsole")}
      </a>
      <a href={GO_LIMITS_DOC_URL} rel="noreferrer noopener" target="_blank">
        {t("usageLimitsDoc")}
      </a>
    </div>
  </div>
);
