/**
 * Presentation data and pure helpers for the OpenCode Go quota meter.
 *
 * Geometry constants, the "where to act" links, window/breakdown helpers,
 * and the stylesheet — all stateless, so meter behavior can be unit-tested
 * without React while `usage-pill.tsx` stays about gating and component
 * state. No React and no host-only imports (client bundle boundary).
 *
 * @module dsh-opencode-patch/usage-ui
 */

import type { GoUsage, UsageWindow } from "./usage-contract.ts";

export const RADIUS = 5.5;
export const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

/**
 * Where a user acts on what this meter shows.
 *
 * The meter reports the Go plan's rolling/weekly/monthly limits, so the useful
 * destinations are the plan page (raise the limit), the console (see the actual
 * usage and Zen balance), and the limits reference (understand the numbers).
 * All three are the vendor's own public pages.
 *
 * There is deliberately no balance *number* in this meter. OpenCode exposes no
 * endpoint for account credit: of every plausible route under
 * `https://opencode.ai/zen/v1` and `/zen/go/v1` — `balance`, `credits`,
 * `billing`, `account`, `me`, `key`, `limits`, `plan`, `subscription` — only
 * `/models` and `/zen/go/v1/usage` exist (the rest 404, while `/models` returns
 * 200 on the same key, so the 404s are real absences rather than an auth
 * problem). The usage payload carries only `status`, `percent`, and `resetsAt`
 * per window — no currency — and a dollar figure cannot be derived from the
 * percentage either, because the monthly cap is per *model* ($15/$30/$60 on Go,
 * $60–$240 on Go Plus) while usage accrues across models. The console is the
 * only place the balance is shown, so the link goes there.
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
