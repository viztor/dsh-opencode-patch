/**
 * Presentational pieces of the OpenCode Go quota meter. `usage-pill.tsx` owns the
 * state and hands them everything they render; neither uses hooks, so both can be
 * invoked directly and asserted as an element tree.
 *
 * @module dsh-opencode-patch/usage-panel
 */

import {
  IconRefreshOutlineRegular,
  StateDot,
  Tag,
  Tooltip,
} from "@deepseek-ai/dsh-client-ui-primitives";
import React from "react";

import { formatUsd } from "./go-limits.ts";
import type { GoUsage, UsageWindow } from "./usage-contract.ts";
import {
  BREAKDOWN_WINDOWS,
  CONSOLE_URL,
  formatRelativeReset,
  getWindowState,
  WINDOW_STATE_COLOR,
  panelActions,
  RADIUS,
  type UsageFailure,
} from "./usage-ui.ts";

/**
 * The refresh glyph is the HOST'S, not a hand-drawn arrow.
 *
 * This used to carry a comment claiming the kit ships no icon set, and that
 * claim is why the arrow stayed hand-drawn — it ships ~150 icons. Every icon is
 * `(props) => <Artwork {...props} strokeWidth={…}>` over a `size = 16` default,
 * so the only thing we choose is the size. `currentColor` comes from the
 * artwork, which is what lets it ride the muted label colour beside it.
 *
 * General rule, and it cost a hand-rolled divider, dot and pill before it was
 * written down: **a claim about what the host does NOT ship must be verified
 * before it is written, because it freezes the decision.**
 */
const RefreshIcon = (): React.ReactElement => (
  <IconRefreshOutlineRegular
    aria-hidden="true"
    className="dsh-oc-usage-refresh-icon"
    size={14}
  />
);

/** The ring / Zen pill that opens the panel. */
export interface UsageTriggerProps {
  displayPercent: number;
  isLimited: boolean;
  isZen: boolean;
  onClick: () => void;
  open: boolean;
  /** Stroke colour for the ring, from `getWindowColorFor`. */
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
    /* The host's own Menu opts into the menu material by rendering exactly this
     * attribute, and the theme reads it to choose the stroke PER THEME — l4 in
     * light, l3 in dark. Declaring the stroke by hand would pin one theme. */
    data-menu-material="translucent"
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
        {/* No window rows when Go's quota could not be read. The three figures
            would be a type floor, not a measurement — and they rendered as three
            confident 0% rows all counting down from <1m. The overflow row below
            still shows: that inference came from the 403 and is honest. */}
        {usage !== undefined && usage.quotaUnavailable !== true && (
          <div className="dsh-oc-usage-breakdown">
            {/* One row per window; the rate-limited badge now appears on
                every window that is limited, not only the monthly one. */}
            {BREAKDOWN_WINDOWS.map((entry) => {
              const window: UsageWindow = usage[entry.key];
              return (
                <div key={entry.key}>
                  <div className="dsh-oc-usage-window">
                    <div className="dsh-oc-usage-row">
                      <span className="dsh-oc-usage-row-left">
                        {/*
                          The kit's dot, driven by the state the window IS —
                          done / warning / error — not by a colour string this
                          file used to inline. Its CSS maps the same three
                          states to the same `--dsw-alias-state-*` tokens the
                          hand-rolled 6px circle carried, so the look is
                          unchanged and the theme owns it again.
                        */}
                        <StateDot state={getWindowState(window)} />
                        {t(entry.labelKey)}
                      </span>
                      {/*
                        The reset used to own its own line below the bar, which
                        made every window THREE blocks deep and the three windows
                        nine lines tall — and the last reset sat flush against the
                        session spend with nothing between them. It belongs on
                        the label row: label left, reset and percent right, one
                        line per window plus the bar that gives the number its
                        shape.
                      */}
                      <span className="dsh-oc-usage-row-reset">
                        {t("usageResets")}{" "}
                        {formatRelativeReset(window.resetsAt, locale)}
                        {window.status === "rate-limited" && (
                          <span className="dsh-oc-usage-limited">
                            {t("usageLimited")}
                          </span>
                        )}
                      </span>
                      <span className="dsh-oc-usage-row-right">
                        {window.percent}%
                      </span>
                    </div>
                    {/*
                      The bar is the shape the number takes. A bare "42%" is an
                      abstraction; a track two pixels tall makes the share
                      legible at a glance and gives the three windows a common
                      ruler — which is what the quota cards used to provide,
                      before they became rows.
                    */}
                    <div className="dsh-oc-usage-bar">
                      <div
                        className="dsh-oc-usage-bar-fill"
                        style={{
                          width: `${Math.min(100, Math.max(0, window.percent))}%`,
                          backgroundColor:
                            WINDOW_STATE_COLOR[getWindowState(window)],
                        }}
                      />
                    </div>
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
        {/* A rejected credential is not a failed refresh, so it does not borrow
            the refresh copy: the heading tells the user WHICH state they are in
            and what to do, and the raw HTTP message stays as the detail. */}
        <strong>
          {failure.reason === "auth"
            ? t("usageAuthRejected")
            : t("usageRefreshFailed")}
        </strong>
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
      {/* The control comes AFTER the value, not before it. Leading with the
          icon made the cell read as a lone button with a caption beside it, and
          the 20px hit box around a 14px glyph plus a 5px gap left a hole where
          the sentence should be. A value followed by the thing that refreshes it
          is the same reading as any "as of" field. */}
      <span className="dsh-oc-usage-updated">
        {/* Nothing at all until the first read lands. A "Loading usage..." cell
            is a state that exists for a moment and then disappears, so the row
            changes width and the footer jumps on every mount — a blip from
            showing progress nobody needs. The refresh button already carries the
            affordance; the timestamp is the only thing here worth reading. */}
        {updatedAt === null
          ? ""
          : `${t("usageLastUpdated")} ${new Date(updatedAt).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" })}`}
        <button
          aria-label={refreshing ? t("usageRefreshing") : t("usageRetry")}
          className="dsh-oc-usage-refresh"
          disabled={refreshing}
          onClick={retry}
          type="button"
        >
          <RefreshIcon />
        </button>
      </span>
      {/* Every link lives in the footer now. `升级套餐` used to have its own row,
          between a divider and the spend block, where it read as a section
          header rather than the answer to the windows above it — and it put a
          second action in a second place on a 320px panel, so the panel was one
          row taller for it. Beside 控制台 they read as what they are: actions.
          Still two links because they are two destinations — opencode.ai/go is
          the plan page, /console is the console SPA, both probed, neither
          reachable from the other. */}
      {panelActions(isZen).map((action) => (
        <a
          className="dsh-oc-usage-console"
          href={action.href}
          key={action.href}
          rel="noreferrer noopener"
          target="_blank"
        >
          {t(action.labelKey)}
        </a>
      ))}
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
