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
export const GO_CONSOLE_URL = "https://opencode.ai/console";
export const GO_LIMITS_DOC_URL = "https://opencode.ai/docs/go/";

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

.dsh-oc-usage-trigger {
  border: 0;
  background: transparent;
  color: var(--dsw-alias-label-secondary, currentColor);
  font: inherit;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  padding: 3px 6px;
  border-radius: 6px;
  cursor: pointer;
  white-space: nowrap;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  transition: background 0.15s ease, opacity 0.15s ease;
  user-select: none;
}

.dsh-oc-usage-trigger:hover,
.dsh-oc-usage-trigger:focus-visible {
  background: color-mix(in srgb, currentColor 8%, transparent);
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

.dsh-oc-usage-panel {
  position: absolute;
  bottom: calc(100% + 8px);
  right: 0;
  z-index: 1100;
  width: 310px;
  max-width: calc(100vw - 24px);
  max-height: 80vh;
  overflow-y: auto;
  box-sizing: border-box;
  padding: 14px;
  border-radius: 14px;
  background-color: Canvas;
  background-image:
    linear-gradient(var(--dsw-specific-menu, transparent), var(--dsw-specific-menu, transparent)),
    linear-gradient(var(--dsw-alias-bg-layer-2, Canvas), var(--dsw-alias-bg-layer-2, Canvas));
  backdrop-filter: var(--dsw-menu-backdrop-filter, blur(20px));
  border: 1px solid color-mix(in srgb, currentColor 14%, transparent);
  box-shadow: 0 12px 36px rgba(0, 0, 0, 0.35);
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

.dsh-oc-usage-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
}

.dsh-oc-usage-headline {
  font-size: 13px;
  font-weight: 600;
  letter-spacing: -0.01em;
}

.dsh-oc-usage-figures {
  font-size: 12px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  color: var(--dsw-alias-label-secondary, currentColor);
}

.dsh-oc-usage-badge {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  font-size: 11px;
  font-weight: 600;
  padding: 1px 6px;
  border-radius: 999px;
  background: color-mix(in srgb, currentColor 10%, transparent);
}

.dsh-oc-usage-badge.dsh-oc-badge-limited {
  background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 15%, transparent);
  color: var(--dsw-alias-state-error-primary);
}

.dsh-oc-usage-bar-track {
  background: color-mix(in srgb, currentColor 10%, transparent);
  border-radius: 999px;
  height: 5px;
  overflow: hidden;
  margin-bottom: 12px;
}

.dsh-oc-usage-bar-fill {
  height: 100%;
  border-radius: 999px;
  transition: width 0.3s ease, background-color 0.2s ease;
}

.dsh-oc-usage-breakdown {
  display: flex;
  flex-direction: column;
  gap: 9px;
  margin-top: 6px;
}

.dsh-oc-usage-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.dsh-oc-usage-row-left {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
}

.dsh-oc-usage-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex-shrink: 0;
}

.dsh-oc-usage-row-right {
  font-variant-numeric: tabular-nums;
  font-weight: 600;
  font-size: 12px;
}

.dsh-oc-usage-subrow {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 11px;
  opacity: 0.65;
  margin-top: 1px;
  padding-left: 13px;
}

.dsh-oc-usage-divider {
  height: 1px;
  background: color-mix(in srgb, currentColor 10%, transparent);
  margin: 12px 0 10px;
}

.dsh-oc-usage-section-title {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  opacity: 0.6;
  margin-bottom: 8px;
}

.dsh-oc-usage-cards {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 6px;
  margin-bottom: 10px;
}

.dsh-oc-usage-card {
  padding: 8px 7px;
  border-radius: 8px;
  background: color-mix(in srgb, currentColor 5%, transparent);
  border: 1px solid color-mix(in srgb, currentColor 8%, transparent);
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.dsh-oc-usage-card.dsh-oc-card-limited {
  background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 8%, transparent);
  border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary) 25%, transparent);
}

.dsh-oc-usage-card-name {
  font-size: 10px;
  opacity: 0.7;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.dsh-oc-usage-card-percent {
  font-size: 13px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}

.dsh-oc-usage-card-reset {
  font-size: 10px;
  opacity: 0.6;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.dsh-oc-usage-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 11px;
  opacity: 0.7;
  padding-top: 4px;
}

.dsh-oc-usage-retry {
  border: 1px solid color-mix(in srgb, currentColor 20%, transparent);
  border-radius: 6px;
  padding: 2px 7px;
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: 11px;
  cursor: pointer;
  transition: background 0.15s ease;
}

.dsh-oc-usage-retry:hover:not(:disabled) {
  background: color-mix(in srgb, currentColor 10%, transparent);
}

.dsh-oc-usage-retry:disabled {
  opacity: 0.4;
  cursor: default;
}

.dsh-oc-usage-zen-notice {
  font-size: 11px;
  line-height: 1.4;
  padding: 6px 8px;
  border-radius: 6px;
  background: color-mix(in srgb, var(--dsw-alias-state-warning-primary, #d97706) 12%, transparent);
  border: 1px solid color-mix(in srgb, var(--dsw-alias-state-warning-primary, #d97706) 25%, transparent);
  color: inherit;
  opacity: 0.95;
  margin-top: 4px;
}

.dsh-oc-zen-card {
  padding: 8px 10px;
  border-radius: 8px;
  background: color-mix(in srgb, currentColor 6%, transparent);
  border: 1px solid color-mix(in srgb, currentColor 10%, transparent);
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: 8px;
}

.dsh-oc-zen-card-left {
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.dsh-oc-zen-card-title {
  font-size: 11px;
  font-weight: 600;
  opacity: 0.85;
}

.dsh-oc-zen-card-desc {
  font-size: 10px;
  opacity: 0.6;
}

.dsh-oc-zen-card-credit {
  font-size: 13px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  color: var(--dsw-alias-state-success-primary);
}

.dsh-oc-zen-pill {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

/* The "what do I do about this" row. Links, not buttons: both navigate away. */
.dsh-oc-usage-links {
  display: flex;
  gap: 12px;
  padding-top: 6px;
  border-top: 1px solid color-mix(in srgb, currentColor 12%, transparent);
  font-size: 11px;
}

.dsh-oc-usage-links a {
  color: var(--dsw-alias-link, currentColor);
  text-decoration: none;
}

.dsh-oc-usage-links a:hover {
  text-decoration: underline;
}
`;

// The stylesheet is rendered as a `<style>` element inside this component's own
// tree (see `ActiveUsage`) instead of being appended to `document.head`: writing
// DOM outside the component leaks a permanent `<style>` node on unmount and is
// disallowed for DSH client plugins.

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
    return "soon";
  }
  const diffMinutes = Math.round(diffMs / 60_000);
  if (diffMinutes < 60) {
    return `in ${diffMinutes}m`;
  }
  const diffHours = Math.floor(diffMinutes / 60);
  const remMinutes = diffMinutes % 60;
  if (diffHours < 24) {
    return remMinutes > 0
      ? `in ${diffHours}h ${remMinutes}m`
      : `in ${diffHours}h`;
  }
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 7) {
    return `in ${diffDays}d ${diffHours % 24}h`;
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

/** The localized copy the meter's header, badge and Zen card render. */
export interface UsageCopy {
  badgeText: string;
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
  usage: GoUsage | undefined,
  affecting: AffectingWindowResult | undefined,
  isZen: boolean,
  t: (key: string) => string
): UsageCopy => {
  const isLimited = affecting?.window.status === "rate-limited";
  const percent = affecting?.window.percent ?? 0;

  let headline: string;
  if (isZen) {
    headline = t("zenPaygTitle");
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

  let zenCardDesc: string;
  if (isZen) {
    zenCardDesc = t("zenPaygDesc");
  } else if (isLimited) {
    zenCardDesc = t("zenFallbackNotice");
  } else {
    zenCardDesc = t("zenOverflowActive");
  }

  let zenCardCredit: string;
  if (isZen) {
    zenCardCredit = t("zenPaygBadge");
  } else if (usage?.zenOverflow === true) {
    zenCardCredit = isLimited ? "Active" : "Ready";
  } else {
    zenCardCredit = t("zenPaygBadge");
  }

  return { badgeText, headline, zenCardCredit, zenCardDesc };
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
