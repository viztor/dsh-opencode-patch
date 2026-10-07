/**
 * Presentation data and pure helpers for the OpenCode Go quota meter: geometry,
 * action links, window/breakdown helpers and the stylesheet. Stateless and
 * dependency-free, so meter behavior is unit-testable without React.
 *
 * @module dsh-opencode-patch/usage-ui
 */

import { isRecord } from "./guards.ts";
import type { GoUsage, UsageWindow } from "./usage-contract.ts";

export const RADIUS = 5.5;
export const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

/**
 * Clamp a quota percentage to the ring's range and derive its dash array.
 *
 * Shared by the trigger ring (which strokes `strokeDasharray`) and the panel
 * progress bar (which uses `clampedPercent` as a width), so both render the
 * same number.
 *
 * @param percent - the raw quota percentage; out-of-range values clamp.
 */
export const ringGeometry = (
  percent: number
): { clampedPercent: number; strokeDasharray: string } => {
  const clampedPercent = Math.min(100, Math.max(0, percent));
  const dashLength = (CIRCUMFERENCE * clampedPercent) / 100;
  return {
    clampedPercent,
    strokeDasharray: `${dashLength} ${CIRCUMFERENCE}`,
  };
};

/**
 * Where a user acts on what this meter shows. The console is the ONLY place a
 * balance appears: OpenCode exposes no credit endpoint and the payload carries
 * no currency, so no dollar figure can be derived from a percentage.
 * `AGENTS.md` → "OpenCode endpoints" records the probed surface behind that.
 */
export const GO_PLAN_URL = "https://opencode.ai/go";
/**
 * The console, which is also where a pay-as-you-go account is topped up.
 *
 * One URL for both, and deliberately so: it is the only destination verified to
 * exist. Every path under `/console/` answers 200 because the console is a
 * single-page app, so a probe cannot distinguish a real `/billing` route from a
 * catch-all — and a top-up link that 404s in front of a user is worse than one
 * that opens the page where top-up lives.
 */
export const CONSOLE_URL = "https://opencode.ai/console";

/** One action the panel can offer, as data so the two popovers share a body. */
export interface PanelAction {
  href: string;
  labelKey: string;
}

/**
 * What to DO about the quota, rendered inside the GO layer — next to the windows
 * it acts on, not parked under the shared footer.
 *
 * One link, not two. The limits doc went: the panel already names every window
 * with its share and its reset time, so the document explained a list the user
 * is looking at. A link that restates what is on screen is the same redundancy
 * as a card that restates the badge — the doc is one click from the console for
 * anyone who wants the policy.
 *
 * Zen has nothing to add: its single action IS the console on the footer row,
 * labelled 充值 because that is what a pay-as-you-go user wants from it.
 */
export const panelActions = (isZen: boolean): readonly PanelAction[] =>
  isZen ? [] : [{ href: GO_PLAN_URL, labelKey: "usageUpgradePlan" }];

/**
 * Whether a provider route or model id contains any configured marker,
 * case-insensitively. Blank markers never match, so an accidental empty
 * entry cannot reveal the meter everywhere.
 */
export const matchesAny = (
  value: string,
  markers: readonly string[]
): boolean => {
  const lower = value.toLowerCase();
  return markers.some(
    (marker) => marker.length > 0 && lower.includes(marker.toLowerCase())
  );
};

/** Markers for one quota window, driving both the breakdown rows and cards. */
export const BREAKDOWN_WINDOWS: {
  cardName: string;
  key: "monthly" | "rolling" | "weekly";
  labelKey: string;
}[] = [
  { cardName: "5-Hour", key: "rolling", labelKey: "usage_rolling" },
  { cardName: "Weekly", key: "weekly", labelKey: "usage_weekly" },
  { cardName: "Monthly", key: "monthly", labelKey: "usage_monthly" },
];

export const STYLES = `
.dsh-oc-usage-root {
  position: relative;
  display: inline-flex;
  min-width: 0;
  vertical-align: middle;
}

/*
 * The trigger follows the host's own composer pills: a translucent fill rather
 * than a bare glyph on the bar. DSH pairs its ContextMeter ring with a filled
 * pill ("176M tok · 缓存命中 97%"), and an unfilled trigger reads as unfinished
 * next to it.
 */
.dsh-oc-usage-trigger {
  border: 0;
  /*
   * No fill at rest: the composer's own controls are ghost, and a tinted pill
   * beside the model selector reads as a chip with a frame of its own. The hover
   * tint is the affordance — it is what says the ring is a button.
   */
  background: transparent;
  color: var(--dsw-alias-label-secondary, currentColor);
  font: inherit;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  padding: 3px 9px;
  border-radius: 999px;
  cursor: pointer;
  white-space: nowrap;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  transition: background 0.15s ease, color 0.15s ease;
  user-select: none;
}

.dsh-oc-usage-trigger:hover,
.dsh-oc-usage-trigger:focus-visible {
  background: var(--dsw-alias-interactive-bg-hover, color-mix(in srgb, currentColor 7%, transparent));
  color: var(--dsw-alias-label-primary, currentColor);
}

.dsh-oc-usage-trigger.dsh-oc-usage-alert {
  color: var(--dsw-alias-state-error-primary);
}

.dsh-oc-usage-ring-track {
  fill: none;
  stroke: currentColor;
  opacity: 0.2;
  stroke-width: 2;
}

.dsh-oc-usage-ring-fill {
  fill: none;
  stroke-width: 2;
  stroke-linecap: round;
  transition: stroke-dasharray 0.3s ease, stroke 0.2s ease;
}

/*
 * Host rules for a floating surface: no border AND an elevation shadow, never
 * both a border and a shadow (docs/web-styling.md), radius from the panel token,
 * background from the menu material so it matches every other popover.
 */
.dsh-oc-usage-panel {
  position: absolute;
  bottom: calc(100% + 8px);
  right: 0;
  z-index: 1100;
  width: 320px;
  max-width: calc(100vw - 24px);
  max-height: 80vh;
  overflow-y: auto;
  box-sizing: border-box;
  padding: 14px 16px;
  border: 0;
  border-radius: var(--dsw-radius-lg, 16px);
  background-color: Canvas;
  background-image:
    linear-gradient(var(--dsw-specific-menu, transparent), var(--dsw-specific-menu, transparent)),
    linear-gradient(var(--dsw-alias-bg-layer-2, Canvas), var(--dsw-alias-bg-layer-2, Canvas));
  backdrop-filter: var(--dsw-menu-backdrop-filter, blur(20px));
  --dsw-elevation-stroke-color: var(--dsw-alias-border-l1);
  box-shadow: var(--dsw-elevation-prominent, 0 12px 36px rgba(0, 0, 0, 0.28));
  color: var(--dsw-alias-label-primary, CanvasText);
  font-size: 12px;
  line-height: 1.5;
  isolation: isolate;
  animation: dsh-oc-fade-in 0.15s ease-out;
}

@keyframes dsh-oc-fade-in {
  from {
    opacity: 0;
    transform: translateY(4px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

/* Header: title left, the one big number right — the host's own popover shape. */
.dsh-oc-usage-header {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 10px;
}

.dsh-oc-usage-headline {
  font-size: 13px;
  font-weight: 600;
  letter-spacing: -0.01em;
}

.dsh-oc-usage-breakdown {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-top: 6px;
}

.dsh-oc-usage-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
}

.dsh-oc-usage-row-left {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  font-size: 12px;
  color: var(--dsw-alias-label-secondary, currentColor);
}

.dsh-oc-usage-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex-shrink: 0;
}

.dsh-oc-usage-row-right {
  font-variant-numeric: tabular-nums;
  font-weight: 600;
  font-size: 12px;
  color: var(--dsw-alias-label-primary, currentColor);
}

/* The bar is the shape the number takes: one track per window, the fill the
   window's own colour. Two pixels — a progress bar that is also a ruler. */
.dsh-oc-usage-bar {
  height: 2px;
  margin-top: 4px;
  margin-left: 13px;
  border-radius: var(--dsw-radius-full, 999px);
  background: var(--dsw-alias-border-l4, currentColor);
  overflow: hidden;
}

.dsh-oc-usage-bar-fill {
  height: 100%;
  border-radius: inherit;
  transition: width 0.3s ease;
}

.dsh-oc-usage-subrow {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  font-size: 11px;
  color: var(--dsw-alias-label-tertiary, currentColor);
  margin-top: 2px;
  padding-left: 13px;
}

/* Styling lives in the sheet, not inline: an ad-hoc style prop here would be
   the only one surviving in the panel, and a second limited-state tone tomorrow
   would either duplicate it or diverge from it. */
.dsh-oc-usage-limited {
  color: var(--dsw-alias-state-error-primary);
  font-weight: 600;
}

.dsh-oc-usage-divider {
  height: 0.5px;
  background: var(--dsw-alias-border-l3, color-mix(in srgb, currentColor 10%, transparent));
  margin: 14px 0 12px;
}

.dsh-oc-usage-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 11px;
  color: var(--dsw-alias-label-tertiary, currentColor);
  padding-top: 4px;
}

/* Actions: three targets, so they must read as three links. Unstyled, they ran
   together into one sentence; the host's link language is in its MarkdownText
   stylesheet. See AGENTS.md, "The meter's panel". */
.dsh-oc-usage-links {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 14px;
  margin-top: 10px;
}

.dsh-oc-usage-links a {
  color: var(--dsw-alias-link, currentColor);
  font-size: 11px;
  font-weight: 500;
  text-decoration: none;
}

.dsh-oc-usage-links a:hover,
.dsh-oc-usage-links a:focus-visible {
  text-decoration: underline dotted;
  text-underline-offset: 3px;
}

.dsh-oc-usage-links a:focus-visible {
  outline: none;
  border-radius: var(--dsw-radius-xs, 4px);
  box-shadow: 0 0 0 2px var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
}

.dsh-oc-usage-updated {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  min-width: 0;
}

.dsh-oc-usage-refresh {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  margin: -4px 0;
  padding: 0;
  border: 0;
  border-radius: var(--dsw-radius-xs, 4px);
  background: transparent;
  color: var(--dsw-alias-label-tertiary, currentColor);
  cursor: pointer;
  transition:
    background 0.15s ease,
    color 0.15s ease;
}

.dsh-oc-usage-refresh:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover, color-mix(in srgb, currentColor 10%, transparent));
  color: var(--dsw-alias-label-primary, currentColor);
}

.dsh-oc-usage-refresh:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
}

/* The control is busy mid-read; the glyph turns rather than disappearing. */
.dsh-oc-usage-refresh:disabled {
  cursor: default;
  opacity: 0.6;
}

.dsh-oc-usage-refresh:disabled .dsh-oc-usage-refresh-icon {
  animation: dsh-oc-spin 0.9s linear infinite;
}

@keyframes dsh-oc-spin {
  to {
    transform: rotate(360deg);
  }
}

.dsh-oc-usage-console {
  color: var(--dsw-alias-link, currentColor);
  font-size: 11px;
  font-weight: 500;
  text-decoration: none;
}

.dsh-oc-usage-console:hover,
.dsh-oc-usage-console:focus-visible {
  text-decoration: underline dotted;
  text-underline-offset: 3px;
}

/*
 * A failure is the one thing here the user can act on, so unlike every other row
 * it IS a callout — same shape as the overflow notice above, in the error tone.
 * This class rendered with no rule at all until now: a bare <div> with a <p>,
 * which meant UA margins, no colour and no emphasis on the one message that
 * needed it.
 */
.dsh-oc-usage-warning {
  padding: 7px 9px;
  border-radius: var(--dsw-radius-sm, 8px);
  background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 12%, transparent);
  color: var(--dsw-alias-state-error-primary);
  font-size: 11px;
  line-height: 1.45;
  margin-top: 8px;
}

.dsh-oc-usage-warning strong {
  font-weight: 600;
}

/* The detail line is a <p>, whose UA margins would double the padding. */
.dsh-oc-usage-warning p {
  margin: 2px 0 0;
  color: var(--dsw-alias-label-secondary, currentColor);
}

.dsh-oc-usage-zen-notice {
  font-size: 11px;
  line-height: 1.45;
  padding: 7px 9px;
  border-radius: var(--dsw-radius-sm, 8px);
  background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 12%, transparent);
  color: var(--dsw-alias-label-secondary, inherit);
  margin-top: 4px;
}

/*
 * A detail row — label, sub-label, value. NOT a card: the panel is already a
 * floating surface, and a second background inside it draws two nested frames
 * around one line of text. The row reads as one of the breakdown's own rows,
 * which is what it is.
 */
.dsh-oc-usage-detail {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

/* The first detail is spaced by whatever precedes it — the header's own margin
   on Zen, the divider on Go — so only a STACKED one needs a gap of its own. */
.dsh-oc-usage-detail + .dsh-oc-usage-detail {
  margin-top: 10px;
}

.dsh-oc-usage-detail-left {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}

.dsh-oc-usage-detail-title {
  font-size: 11px;
  font-weight: 600;
  color: var(--dsw-alias-label-primary, currentColor);
}

.dsh-oc-usage-detail-desc {
  font-size: 10px;
  color: var(--dsw-alias-label-tertiary, currentColor);
}

/* Same metrics as a breakdown row's value, so the rows line up as one list. */
.dsh-oc-usage-detail-value {
  font-size: 12px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  color: var(--dsw-alias-label-primary, currentColor);
  white-space: nowrap;
}
`;

// The stylesheet is rendered as a `<style>` element inside this component's own
// tree (see `ActiveUsage`) instead of being appended to `document.head`: writing
// DOM outside the component leaks a permanent `<style>` node on unmount and is
// disallowed for DSH client plugins.

/**
 * The ring colour before a window exists.
 *
 * Split from {@link getWindowColor} so the "no data yet" case is a named idea
 * instead of a nested ternary at the call site.
 */
export const getWindowColorFor = (affecting?: AffectingWindowResult): string =>
  affecting === undefined
    ? "var(--dsw-alias-state-success-primary)"
    : getWindowColor(affecting.window);

export const getWindowColor = (window: UsageWindow): string => {
  if (window.status === "rate-limited" || window.percent >= 100) {
    return "var(--dsw-alias-state-error-primary)";
  }
  if (window.percent >= 80) {
    return "var(--dsw-alias-state-warn-primary)";
  }
  return "var(--dsw-alias-state-success-primary)";
};

export const formatRelativeReset = (
  dateStr: string,
  locale?: string
): string => {
  const target = Date.parse(dateStr);
  if (!Number.isFinite(target)) {
    return dateStr;
  }
  const diffMs = target - Date.now();
  if (diffMs <= 0) {
    // Language-neutral, like the durations below: the caller prefixes this with a
    // localised label, so returning an English word here would half-translate it.
    return "<1m";
  }
  const diffMinutes = Math.round(diffMs / 60_000);
  if (diffMinutes < 60) {
    return `${diffMinutes}m`;
  }
  const diffHours = Math.floor(diffMinutes / 60);
  const remMinutes = diffMinutes % 60;
  if (diffHours < 24) {
    return remMinutes > 0 ? `${diffHours}h ${remMinutes}m` : `${diffHours}h`;
  }
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 7) {
    return `${diffDays}d ${diffHours % 24}h`;
  }
  return new Date(target).toLocaleDateString(locale, {
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    month: "short",
  });
};

export interface AffectingWindowResult {
  key: "monthly" | "rolling" | "weekly";
  label: string;
  window: UsageWindow;
}

export const getAffectingWindow = (usage: GoUsage): AffectingWindowResult => {
  // 1. Any rate-limited window is actively blocking the user
  if (usage.monthly.status === "rate-limited") {
    return { key: "monthly", label: "Monthly", window: usage.monthly };
  }
  if (usage.weekly.status === "rate-limited") {
    return { key: "weekly", label: "Weekly", window: usage.weekly };
  }
  if (usage.rolling.status === "rate-limited") {
    return { key: "rolling", label: "5-Hour", window: usage.rolling };
  }

  // 2. Otherwise pick the highest percentage
  const candidates: {
    key: "monthly" | "rolling" | "weekly";
    label: string;
    window: UsageWindow;
  }[] = [
    { key: "monthly", label: "Monthly", window: usage.monthly },
    { key: "weekly", label: "Weekly", window: usage.weekly },
    { key: "rolling", label: "5-Hour", window: usage.rolling },
  ];
  candidates.sort((a, b) => b.window.percent - a.window.percent);

  const [top] = candidates;
  if (top !== undefined && top.window.percent > 0) {
    return top;
  }
  // Default to rolling hourly quota when all are 0
  return { key: "rolling", label: "5-Hour", window: usage.rolling };
};

/**
 * Whether a provider route is OpenCode Zen rather than Go.
 *
 * Both routes share the `opencode` prefix, so the distinguishing signal is
 * the presence of `go`: `opencode-go` is the subscription plan, plain
 * `opencode` is Zen pay-as-you-go.
 */
export const isZenProvider = (provider?: string): boolean => {
  if (typeof provider !== "string") {
    return false;
  }
  const lower = provider.toLowerCase();
  return lower.includes("opencode") && !lower.includes("go");
};

/**
 * The localized copy the meter's header, badge and Zen card render.
 *
 * No tooltip line lives here: the trigger's hover explanation used to be a
 * second composition off the same inputs, and that seam was the wrong place to
 * hang two new keys an older dictionary had never heard of — they rendered raw
 * the first boot a user took the new bundle with an old locale registration.
 * The tooltip is `headline` until that API earns its own contract.
 */
export interface UsageCopy {
  badgeText: string;
  /**
   * What the panel header names: the ACCOUNT, not its state.
   *
   * `OpenCode Go` beside `Go Plan` / the limit badge, exactly as `OpenCode Zen`
   * sits beside `Pay-as-you-go`. The header used to carry `headline` — the
   * ring's own figure — which made the one line that identifies the surface
   * change every poll: it read `42% of Weekly used`, then `Monthly quota
   * limited`. Both facts are already on screen (the badge, and each window's
   * own row), so the line that should be stable was the one that moved.
   */
  title: string;
  /**
   * The ring explained in words — the trigger's hover label.
   *
   * On Go it names the bottleneck window ("90% of Weekly used"); on Zen the
   * trigger shows session spend instead of a ring, so this is the account name
   * and nothing more.
   */
  headline: string;
  zenCardCredit: string;
  zenCardDesc: string;
}

/**
 * Derive the meter's user-facing copy from the active reading.
 *
 * Pure: the component owns state, this owns wording. `t` is the bound
 * translator; `affecting` is the bottleneck window (or `undefined` while the
 * first read is in flight).
 */
export const describeUsage = (
  _usage: GoUsage | undefined,
  affecting: AffectingWindowResult | undefined,
  isZen: boolean,
  t: (key: string) => string
): UsageCopy => {
  const isLimited = affecting?.window.status === "rate-limited";
  const percent = affecting?.window.percent ?? 0;

  const title = isZen ? t("zenPaygTitle") : t("goPlanTitle");

  let headline: string;
  if (isZen) {
    headline = title;
  } else if (isLimited) {
    headline = `${affecting?.label} quota limited`;
  } else {
    headline = `${percent}% of ${affecting?.label ?? "quota"} used`;
  }

  let badgeText: string;
  if (isZen) {
    badgeText = t("zenPaygBadge");
  } else if (isLimited) {
    badgeText = t("usageLimited");
  } else {
    badgeText = "Go Plan";
  }

  // The Zen card renders on a GO route with overflow only (`usage-panel.tsx`),
  // so these two have exactly the two states that card can be in: the plan is
  // limited and the overflow is live, or the plan is fine and the balance is
  // standing by. A Zen route never reaches them — there the badge already says
  // pay-as-you-go, and OpenCode has no balance endpoint to report.
  const zenCardDesc = isLimited
    ? t("zenFallbackNotice")
    : t("zenOverflowActive");
  const zenCardCredit = isLimited ? "Active" : "Ready";

  return { badgeText, headline, title, zenCardCredit, zenCardDesc };
};

/**
 * A failed usage read, normalized from whatever the Host remote threw.
 *
 * `configured === false` is the "no credential at all" state: a configuration
 * fact rather than a fault, which the meter renders as nothing instead of an
 * unavailable state the user cannot act on.
 */
export interface UsageFailure {
  configured?: boolean;
  message?: string;
  retainPrevious: boolean;
  source?: string;
}

/** Normalize a Host remote rejection into a {@link UsageFailure}. */
export const parseFailure = (error: unknown): UsageFailure => {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "opencode-go/usage-unavailable"
  ) {
    const details =
      "details" in error && isRecord(error.details) ? error.details : {};
    return {
      ...(details.configured === false ? { configured: false } : {}),
      message:
        "message" in error && typeof error.message === "string"
          ? error.message
          : undefined,
      retainPrevious:
        details.retryable === true && details.retainPrevious === true,
      source: typeof details.source === "string" ? details.source : undefined,
    };
  }
  return {
    message: error instanceof Error ? error.message : String(error),
    retainPrevious: false,
  };
};
