/**
 * Composer-dock component displaying OpenCode Go quota and rate limits.
 *
 * Shows a compact circular progress ring in `conversation.composer.dock` —
 * beside the host's own Context meter — reflecting the hourly or bottleneck
 * quota currently affecting the session. Hovering or clicking reveals a
 * detailed breakdown with rolling, weekly, and monthly meters, countdown
 * timers, balance cards, and links for acting on a hit cap.
 *
 * It renders nothing when the account has no OpenCode Go credential, when the
 * host serves no usage service (the quota toggle is off), or when a non-Go
 * provider is active: an unactionable "unavailable" meter is worse than none.
 *
 * @module dsh-opencode-patch/usage-pill
 */

import React, {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import { DEFAULT_USAGE_PROVIDER_MARKERS } from "./config-values.ts";
import { isRecord } from "./guards.ts";
import type { GoUsage, UsageWindow } from "./usage-contract.ts";
import {
  BREAKDOWN_WINDOWS,
  CIRCUMFERENCE,
  formatRelativeReset,
  getAffectingWindow,
  GO_CONSOLE_URL,
  GO_LIMITS_DOC_URL,
  GO_PLAN_URL,
  getWindowColor,
  matchesAny,
  RADIUS,
  STYLES,
} from "./usage-ui.ts";

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
  /**
   * Deprecated: model markers are no longer used for gating. Kept optional for backward compatibility.
   */
  modelMarkers?: readonly string[];
  /**
   * Provider-route markers that reveal the meter. Defaults to the Go route
   * marker when absent or empty.
   */
  providerMarkers?: readonly string[];
  readUsage: (provider?: string) => Promise<GoUsage>;
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

const parseFailure = (error: unknown): UsageFailure => {
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

interface ActiveUsageProps extends Omit<UsagePillProps, "directory"> {
  provider?: string;
}

const ActiveUsage = ({
  getLocale,
  provider,
  readUsage,
  t,
}: ActiveUsageProps): React.ReactElement | null => {
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
        const value = await readUsage(provider);
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
                          style={{ backgroundColor: getWindowColor(window) }}
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
              {isLimited ? (
                <div className="dsh-oc-usage-zen-notice">
                  {t("usageZenFallbackNotice")}
                </div>
              ) : null}
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
            <a href={GO_CONSOLE_URL} rel="noreferrer noopener" target="_blank">
              {t("usageConsole")}
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
  modelMarkers: _modelMarkers,
  providerMarkers,
  ...props
}: UsagePillProps): React.ReactElement | null => {
  const state = useSyncExternalStore(
    directory.subscribe,
    directory.getSnapshot,
    directory.getSnapshot
  );

  const provider = state?.current?.provider ?? "";
  // The settings scope passes the configured markers at inject time; an
  // absent or empty list falls back to the plugin defaults, so direct
  // callers (and older injected props) keep the stock Go gate.
  const providers =
    providerMarkers !== undefined && providerMarkers.length > 0
      ? providerMarkers
      : DEFAULT_USAGE_PROVIDER_MARKERS;
  const isOpenCodeGo = matchesAny(provider, providers);

  if (!isOpenCodeGo) {
    return null;
  }

  return <ActiveUsage {...props} provider={provider} />;
};
