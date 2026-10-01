/**
 * Conversation slot component displaying OpenCode Go quota and rate limits.
 *
 * Shows a compact pill in `conversation.input.right` that activates when an
 * OpenCode Go model is selected. Clicking opens an accessible status panel with
 * rolling, weekly, and monthly quota progress and reset times.
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
  message?: string;
  retainPrevious: boolean;
  source?: string;
}

const noop = (): void => {
  /* no-op */
};

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
  color: inherit;
  opacity: 0.8;
  font: inherit;
  font-size: 12px;
  padding: 3px 7px;
  border-radius: 6px;
  cursor: pointer;
  white-space: nowrap;
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.dsh-oc-usage-trigger:hover,
.dsh-oc-usage-trigger:focus-visible {
  opacity: 1;
  background: color-mix(in srgb, currentColor 8%, transparent);
}
.dsh-oc-usage-trigger.dsh-oc-usage-alert {
  color: #e5484d;
}
.dsh-oc-usage-panel {
  position: absolute;
  bottom: calc(100% + 10px);
  right: 0;
  z-index: 100;
  width: 290px;
  max-width: calc(100vw - 32px);
  max-height: 70vh;
  overflow-y: auto;
  box-sizing: border-box;
  padding: 16px;
  border: 1px solid color-mix(in srgb, currentColor 18%, transparent);
  border-radius: 12px;
  color: var(--dsw-alias-label-primary, CanvasText);
  box-shadow: 0 8px 30px rgba(0, 0, 0, 0.2);
  font-size: 12px;
  isolation: isolate;
  background-color: Canvas;
  background-image:
    linear-gradient(var(--dsw-specific-menu, transparent), var(--dsw-specific-menu, transparent)),
    linear-gradient(var(--dsw-alias-bg-layer-2, Canvas), var(--dsw-alias-bg-layer-2, Canvas));
}
.dsh-oc-usage-hint {
  opacity: 0.7;
  font-size: 11px;
  line-height: 1.5;
  margin: 4px 0;
}
.dsh-oc-usage-warning {
  margin: 10px 0;
  padding: 8px 10px;
  border-radius: 6px;
  background: color-mix(in srgb, #e5484d 12%, transparent);
  color: #e5484d;
  line-height: 1.4;
  overflow-wrap: anywhere;
}
.dsh-oc-usage-warning strong {
  display: block;
  margin-bottom: 2px;
}
.dsh-oc-usage-retry {
  border: 1px solid color-mix(in srgb, currentColor 25%, transparent);
  border-radius: 6px;
  padding: 4px 10px;
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: 11px;
  cursor: pointer;
  margin-top: 6px;
}
.dsh-oc-usage-retry:disabled {
  opacity: 0.5;
  cursor: default;
}
.dsh-oc-usage-window {
  margin-top: 12px;
}
.dsh-oc-usage-row {
  display: flex;
  justify-content: space-between;
  margin-bottom: 4px;
}
.dsh-oc-usage-window progress {
  width: 100%;
  height: 6px;
  display: block;
  appearance: none;
  border: 0;
  border-radius: 4px;
  background: color-mix(in srgb, currentColor 15%, transparent);
}
.dsh-oc-usage-window progress::-webkit-progress-bar {
  background: transparent;
  border-radius: 4px;
}
.dsh-oc-usage-window progress::-webkit-progress-value {
  background: #30a46c;
  border-radius: 4px;
}
.dsh-oc-usage-window progress::-moz-progress-bar {
  background: #30a46c;
  border-radius: 4px;
}
.dsh-oc-usage-window progress.dsh-oc-usage-high::-webkit-progress-value {
  background: #e0a100;
}
.dsh-oc-usage-window progress.dsh-oc-usage-high::-moz-progress-bar {
  background: #e0a100;
}
.dsh-oc-usage-window progress.dsh-oc-usage-limited::-webkit-progress-value {
  background: #e5484d;
}
.dsh-oc-usage-window progress.dsh-oc-usage-limited::-moz-progress-bar {
  background: #e5484d;
}
.dsh-oc-usage-limited-tag {
  color: #e5484d;
  font-weight: 600;
  font-size: 11px;
  margin-top: 2px;
}
`;

const ensureStylesInjected = (): void => {
  if (typeof document === "undefined") {
    return;
  }
  const ATTR = "data-dsh-opencode-usage-styles";
  if (document.head.querySelector(`style[${ATTR}]`) === null) {
    const style = document.createElement("style");
    style.setAttribute(ATTR, "true");
    style.textContent = STYLES;
    document.head.append(style);
  }
};

const usageLevel = (window: UsageWindow): string | undefined => {
  if (window.status === "rate-limited" || window.percent >= 100) {
    return "dsh-oc-usage-limited";
  }
  return window.percent >= 80 ? "dsh-oc-usage-high" : undefined;
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
}: Omit<UsagePillProps, "directory">): React.ReactElement => {
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
  const retry = useRef<() => void>(noop);

  useEffect(() => {
    ensureStylesInjected();
  }, []);

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

  const current = snapshot?.reader === readUsage ? snapshot : null;
  const usage = current?.usage;
  const failure = failed?.reader === readUsage ? failed.failure : null;

  const isLimited =
    usage?.monthly.status === "rate-limited" ||
    usage?.weekly.status === "rate-limited" ||
    usage?.rolling.status === "rate-limited";

  const label = usage
    ? `Go · ${t("usageRollingShort")} ${usage.rolling.percent}% · ${t("usageWeekShort")} ${usage.weekly.percent}%${
        isLimited ? ` · ${t("usageLimitedShort")}` : ""
      }${failure ? ` · ${t("usageStaleShort")}` : ""}`
    : `Go · ${failure ? t("usageUnavailable") : "…"}`;

  let panelContent: React.ReactNode = null;
  if (usage) {
    panelContent = (["rolling", "weekly", "monthly"] as const).map(
      (windowKey) => {
        const item = usage[windowKey];
        return (
          <div className="dsh-oc-usage-window" key={windowKey}>
            <div className="dsh-oc-usage-row">
              <span>{t(`usage_${windowKey}`)}</span>
              <strong>{item.percent}%</strong>
            </div>
            <progress
              className={usageLevel(item)}
              aria-label={t(`usage_${windowKey}`)}
              max={100}
              value={Math.min(100, item.percent)}
            />
            <div className="dsh-oc-usage-hint">
              {t("usageResets")}{" "}
              {new Date(item.resetsAt).toLocaleString(getLocale?.())}
            </div>
            {item.status === "rate-limited" && (
              <div className="dsh-oc-usage-limited-tag">
                {t("usageLimited")}
              </div>
            )}
          </div>
        );
      }
    );
  } else if (!failure) {
    panelContent = <p className="dsh-oc-usage-hint">{t("usageLoading")}</p>;
  }

  return (
    <span className="dsh-oc-usage-root" ref={root}>
      <button
        type="button"
        className={`dsh-oc-usage-trigger${isLimited ? " dsh-oc-usage-alert" : ""}`}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={`${t("usageTitle")}: ${label}`}
        onClick={() => {
          setOpen(!open);
        }}
      >
        {label}
      </button>
      {open && (
        <div
          className="dsh-oc-usage-panel"
          role="dialog"
          aria-label={t("usageTitle")}
          aria-busy={refreshing}
        >
          <strong>{t("usageTitle")}</strong>
          <p className="dsh-oc-usage-hint">{t("usageHint")}</p>
          {failure && (
            <div className="dsh-oc-usage-warning" role="alert">
              <strong>{t("usageRefreshFailed")}</strong>
              <p>{failure.message ?? t("usageUnavailable")}</p>
              {usage && <p>{t("usageStaleHint")}</p>}
            </div>
          )}
          {failure && (
            <button
              type="button"
              className="dsh-oc-usage-retry"
              disabled={refreshing}
              onClick={() => {
                retry.current();
              }}
            >
              {t(refreshing ? "usageRefreshing" : "usageRetry")}
            </button>
          )}
          {current && (
            <p className="dsh-oc-usage-hint">
              {t("usageLastUpdated")}{" "}
              {new Date(current.updatedAt).toLocaleString(getLocale?.())}
            </p>
          )}
          {panelContent}
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
  const isOpenCodeGo =
    provider === "opencode-go" ||
    provider === "dsh-opencode-go" ||
    /opencode-go/i.test(provider);

  if (!isOpenCodeGo) {
    return null;
  }

  return <ActiveUsage {...props} />;
};
