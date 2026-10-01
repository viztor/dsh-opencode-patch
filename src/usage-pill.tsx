/**
 * Conversation slot component displaying OpenCode Go quota and rate limits.
 *
 * Shows a compact circular progress ring in `conversation.input.right` reflecting the
 * hourly or bottleneck quota currently affecting the session. Hovering or clicking
 * reveals a detailed breakdown modal with rolling, weekly, and monthly meters,
 * countdown timers, and balance cards.
 *
 * @module dsh-opencode-patch/usage-pill
 */

import React, {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import type { GoUsage, UsageWindow } from "./usage-contract.ts";

export interface SnapshotStore<T> {
  getSnapshot: () => T;
  subscribe: (onStoreChange: () => void) => () => void;
}

export interface ModelDirectoryState {
  current?: {
    model?: string;
    provider?: string;
  };
}

export interface UsagePillProps {
  directory: SnapshotStore<ModelDirectoryState>;
  getLocale?: () => string;
  readUsage: () => Promise<GoUsage>;
  t: (key: string) => string;
}

interface UsageFailure {
  /**
   * `false` when the Host reports the account has no OpenCode Go credential.
   * That is a configuration state rather than a fault — there is no quota to
   * measure — so the meter renders nothing instead of an unavailable state
   * the user cannot act on.
   */
  configured?: boolean;
  message?: string;
  retainPrevious: boolean;
  source?: string;
}

const noop = (): void => {
  /* no-op */
};

const RADIUS = 5.5;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

/**
 * Where a user acts on what this meter shows.
 *
 * The meter reports the Go plan's rolling/weekly/monthly limits, so the useful
 * destinations are the plan page (raise the limit) and the limits reference
 * (understand it). Both are the vendor's own public pages.
 */
const GO_PLAN_URL = "https://opencode.ai/go";
const GO_LIMITS_DOC_URL = "https://opencode.ai/docs/go/";

const STYLES = `
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

const getWindowColor = (window: UsageWindow): string => {
  if (window.status === "rate-limited" || window.percent >= 100) {
    return "var(--dsw-alias-state-error-primary)";
  }
  if (window.percent >= 80) {
    return "var(--dsw-alias-state-warn-primary)";
  }
  return "var(--dsw-alias-state-success-primary)";
};

const formatRelativeReset = (dateStr: string, locale?: string): string => {
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

interface AffectingWindowResult {
  key: "monthly" | "rolling" | "weekly";
  label: string;
  window: UsageWindow;
}

const getAffectingWindow = (usage: GoUsage): AffectingWindowResult => {
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

const parseFailure = (error: unknown): UsageFailure => {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "opencode-go/usage-unavailable"
  ) {
    const details =
      "details" in error &&
      typeof error.details === "object" &&
      error.details !== null
        ? (error.details as Record<string, unknown>)
        : {};
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

const ActiveUsage = ({
  getLocale,
  readUsage,
  t,
}: Omit<UsagePillProps, "directory">): React.ReactElement | null => {
  const [snapshot, setSnapshot] = useState<{
    reader: typeof readUsage;
    updatedAt: number;
    usage: GoUsage;
  } | null>(null);
  const [failed, setFailed] = useState<{
    failure: UsageFailure;
    reader: typeof readUsage;
  } | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [open, setOpen] = useState(false);

  const root = useRef<HTMLSpanElement>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retry = useRef<() => void>(noop);

  useEffect(() => {
    let alive = true;
    let busy = false;
    setSnapshot(null);
    setFailed(null);
    setRefreshing(false);

    const refresh = async (manual = false): Promise<void> => {
      if (busy || (!manual && document.visibilityState === "hidden")) {
        return;
      }
      busy = true;
      setRefreshing(true);
      try {
        const value = await readUsage();
        if (alive) {
          setSnapshot({
            reader: readUsage,
            updatedAt: Date.now(),
            usage: value,
          });
          setFailed(null);
        }
      } catch (error: unknown) {
        if (alive) {
          const failure = parseFailure(error);
          setFailed({ failure, reader: readUsage });
          setSnapshot((previous) =>
            previous?.reader === readUsage &&
            failure.retainPrevious &&
            typeof previous.usage.source === "string" &&
            previous.usage.source === failure.source
              ? previous
              : null
          );
        }
      } finally {
        busy = false;
        if (alive) {
          setRefreshing(false);
        }
      }
    };

    retry.current = () => {
      void refresh(true);
    };
    void refresh();

    const timer = setInterval(() => {
      void refresh();
    }, 60_000);
    const onVisible = (): void => {
      void refresh();
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      alive = false;
      retry.current = noop;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [readUsage]);

  useEffect(() => {
    if (!open) {
      return noop;
    }
    const click = (event: MouseEvent): void => {
      if (
        root.current !== null &&
        event.target instanceof Node &&
        !root.current.contains(event.target)
      ) {
        setOpen(false);
      }
    };
    const key = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", click);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("mousedown", click);
      document.removeEventListener("keydown", key);
    };
  }, [open]);

  const handleMouseEnter = (): void => {
    if (hoverTimer.current !== null) {
      clearTimeout(hoverTimer.current);
    }
    hoverTimer.current = setTimeout(() => {
      setOpen(true);
    }, 120);
  };

  const handleMouseLeave = (): void => {
    if (hoverTimer.current !== null) {
      clearTimeout(hoverTimer.current);
    }
    hoverTimer.current = setTimeout(() => {
      setOpen(false);
    }, 200);
  };

  const current = snapshot?.reader === readUsage ? snapshot : null;
  const usage = current?.usage;
  const failure = failed?.reader === readUsage ? failed.failure : null;

  // Nothing to show when the account has no OpenCode Go credential: the meter
  // exists to report a quota, and there is no quota to report. Rendering an
  // "unavailable" chip instead would put a permanent, unactionable error in
  // the composer for every user who never configured OpenCode Go.
  if (failure?.configured === false) {
    return null;
  }

  const affecting = usage === undefined ? undefined : getAffectingWindow(usage);
  const isLimited = affecting?.window.status === "rate-limited";
  const displayPercent = affecting?.window.percent ?? 0;
  const ringColor =
    affecting === undefined
      ? "var(--dsw-alias-state-success-primary)"
      : getWindowColor(affecting.window);

  // Clamp stroke dash array for circular SVG meter
  const clampedPercent = Math.min(100, Math.max(0, displayPercent));
  const dashLength = (CIRCUMFERENCE * clampedPercent) / 100;
  const strokeDasharray = `${dashLength} ${CIRCUMFERENCE}`;

  let triggerLabel = "…";
  if (usage !== undefined) {
    triggerLabel = `${displayPercent}%`;
  } else if (failure !== null) {
    triggerLabel = "!";
  }

  const locale = getLocale?.();

  return (
    <span
      className="dsh-oc-usage-root"
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      ref={root}
    >
      {/*
        Component-local styles render as an element so React removes them when
        the component unmounts; nothing is appended to `document.head`.
      */}
      <style>{STYLES}</style>
      <button
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={`${t("usageTitle")}: ${displayPercent}%`}
        className={`dsh-oc-usage-trigger${isLimited ? " dsh-oc-usage-alert" : ""}`}
        onClick={() => {
          setOpen((prev) => !prev);
        }}
        type="button"
      >
        <svg aria-hidden="true" height="14" viewBox="0 0 14 14" width="14">
          <circle
            className="dsh-oc-usage-ring-track"
            cx="7"
            cy="7"
            r={RADIUS}
          />
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
        <span>{triggerLabel}</span>
      </button>

      {open && (
        <div
          aria-busy={refreshing}
          aria-label={t("usageTitle")}
          className="dsh-oc-usage-panel"
          onMouseEnter={handleMouseEnter}
          onMouseLeave={handleMouseLeave}
          role="dialog"
        >
          {/* Header */}
          <div className="dsh-oc-usage-header">
            <div>
              <div className="dsh-oc-usage-headline">
                {isLimited
                  ? `${affecting?.label} quota limited`
                  : `${displayPercent}% of ${affecting?.label ?? "quota"} used`}
              </div>
            </div>
            {isLimited ? (
              <span className="dsh-oc-usage-badge dsh-oc-badge-limited">
                {t("usageLimited")}
              </span>
            ) : (
              <span className="dsh-oc-usage-badge">Go Plan</span>
            )}
          </div>

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
              {/* 5-Hour Rolling */}
              <div>
                <div className="dsh-oc-usage-row">
                  <span className="dsh-oc-usage-row-left">
                    <span
                      className="dsh-oc-usage-dot"
                      style={{ backgroundColor: getWindowColor(usage.rolling) }}
                    />
                    {t("usage_rolling")}
                  </span>
                  <span className="dsh-oc-usage-row-right">
                    {usage.rolling.percent}%
                  </span>
                </div>
                <div className="dsh-oc-usage-subrow">
                  <span>
                    Resets {formatRelativeReset(usage.rolling.resetsAt, locale)}
                  </span>
                </div>
              </div>

              {/* Weekly */}
              <div>
                <div className="dsh-oc-usage-row">
                  <span className="dsh-oc-usage-row-left">
                    <span
                      className="dsh-oc-usage-dot"
                      style={{ backgroundColor: getWindowColor(usage.weekly) }}
                    />
                    {t("usage_weekly")}
                  </span>
                  <span className="dsh-oc-usage-row-right">
                    {usage.weekly.percent}%
                  </span>
                </div>
                <div className="dsh-oc-usage-subrow">
                  <span>
                    Resets {formatRelativeReset(usage.weekly.resetsAt, locale)}
                  </span>
                </div>
              </div>

              {/* Monthly */}
              <div>
                <div className="dsh-oc-usage-row">
                  <span className="dsh-oc-usage-row-left">
                    <span
                      className="dsh-oc-usage-dot"
                      style={{ backgroundColor: getWindowColor(usage.monthly) }}
                    />
                    {t("usage_monthly")}
                  </span>
                  <span className="dsh-oc-usage-row-right">
                    {usage.monthly.percent}%
                  </span>
                </div>
                <div className="dsh-oc-usage-subrow">
                  <span>
                    Resets {formatRelativeReset(usage.monthly.resetsAt, locale)}
                  </span>
                  {usage.monthly.status === "rate-limited" && (
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
            </div>
          )}

          {/* Divider */}
          <div className="dsh-oc-usage-divider" />

          {/* Balance Cards (Image 2 pattern) */}
          {usage !== undefined && (
            <>
              <div className="dsh-oc-usage-section-title">Quota Overview</div>
              <div className="dsh-oc-usage-cards">
                <div
                  className={`dsh-oc-usage-card${usage.rolling.status === "rate-limited" ? " dsh-oc-card-limited" : ""}`}
                >
                  <span className="dsh-oc-usage-card-name">5-Hour</span>
                  <span
                    className="dsh-oc-usage-card-percent"
                    style={{ color: getWindowColor(usage.rolling) }}
                  >
                    {usage.rolling.percent}%
                  </span>
                  <span className="dsh-oc-usage-card-reset">
                    {formatRelativeReset(usage.rolling.resetsAt, locale)}
                  </span>
                </div>

                <div
                  className={`dsh-oc-usage-card${usage.weekly.status === "rate-limited" ? " dsh-oc-card-limited" : ""}`}
                >
                  <span className="dsh-oc-usage-card-name">Weekly</span>
                  <span
                    className="dsh-oc-usage-card-percent"
                    style={{ color: getWindowColor(usage.weekly) }}
                  >
                    {usage.weekly.percent}%
                  </span>
                  <span className="dsh-oc-usage-card-reset">
                    {formatRelativeReset(usage.weekly.resetsAt, locale)}
                  </span>
                </div>

                <div
                  className={`dsh-oc-usage-card${usage.monthly.status === "rate-limited" ? " dsh-oc-card-limited" : ""}`}
                >
                  <span className="dsh-oc-usage-card-name">Monthly</span>
                  <span
                    className="dsh-oc-usage-card-percent"
                    style={{ color: getWindowColor(usage.monthly) }}
                  >
                    {usage.monthly.percent}%
                  </span>
                  <span className="dsh-oc-usage-card-reset">
                    {formatRelativeReset(usage.monthly.resetsAt, locale)}
                  </span>
                </div>
              </div>
            </>
          )}

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
              {current === null
                ? t("usageLoading")
                : `${t("usageLastUpdated")} ${new Date(current.updatedAt).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" })}`}
            </span>
            <button
              className="dsh-oc-usage-retry"
              disabled={refreshing}
              onClick={() => {
                retry.current();
              }}
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
            <a
              href={GO_LIMITS_DOC_URL}
              rel="noreferrer noopener"
              target="_blank"
            >
              {t("usageLimitsDoc")}
            </a>
          </div>
        </div>
      )}
    </span>
  );
};

export const UsagePill = ({
  directory,
  ...props
}: UsagePillProps): React.ReactElement | null => {
  const state = useSyncExternalStore(
    directory.subscribe,
    directory.getSnapshot,
    directory.getSnapshot
  );

  const provider = state?.current?.provider ?? "";
  const model = state?.current?.model ?? "";
  const isOpenCodeGo =
    provider === "opencode-go" ||
    provider === "dsh-opencode-go" ||
    /opencode-go/i.test(provider) ||
    /deepseek-v4\.1-flash/i.test(model);

  if (!isOpenCodeGo) {
    return null;
  }

  return <ActiveUsage {...props} />;
};
