/**
 * The Go usage summary on the plugin settings page.
 *
 * The composer meter answers "how much have I used" at the point of use; this
 * answers the same question where a reader goes to CONFIGURE the plugin, in the
 * layout the vendor's own console uses: one row per window, with what is LEFT
 * held out on the right.
 *
 * What it can say is the vendor's limit, not ours. `/usage` publishes a percent
 * per window and no balance, and the plan tier is not discoverable, so "left" is
 * the complement of the same percentage — never a dollar figure. The allowance
 * is stated as a TOTAL for the same reason the meter states it that way.
 *
 * @module dsh-opencode-patch/settings-usage
 */

import {
  IconInfoOutlineRegular,
  IconRefreshOutlineRegular,
  StateDot,
  Tooltip,
} from "@deepseek-ai/dsh-client-ui-primitives";
import React from "react";

import { formatUsd } from "./go-limits.ts";
import type { Translate } from "./settings-copy.ts";
import {
  callUsageRead,
  isRemoteCall,
  remoteNamespace,
  remoteNamespaceOf,
} from "./settings-remote.ts";
import type { GoUsage, UsageWindow } from "./usage-contract.ts";
import { formatRelativeReset, getWindowState, resetLabel } from "./usage-ui.ts";
import { isRecord } from "./utils/guards.ts";
import { retryUntilAnswered } from "./utils/retry.ts";

/** The three windows, in the order the panel lists them. */
const WINDOWS = [
  { copy: "usage_rolling", key: "rolling" },
  { copy: "usage_weekly", key: "weekly" },
  { copy: "usage_monthly", key: "monthly" },
] as const;

/** Whether a value is one window, as the Host's contract defines it. */
const isWindow = (value: unknown): value is UsageWindow =>
  isRecord(value) &&
  typeof value.percent === "number" &&
  typeof value.resetsAt === "string" &&
  (value.status === "ok" || value.status === "rate-limited");

/** Whether a value is a quota reading. The windows are what this page renders. */
export const isGoUsage = (value: unknown): value is GoUsage =>
  isRecord(value) &&
  isWindow(value.rolling) &&
  isWindow(value.weekly) &&
  isWindow(value.monthly);

/**
 * Read the Go plane's quota through the Host service.
 *
 * The card's scope carries `remote` the same way the meter's does, so the read
 * goes through the one service that owns credential resolution and the endpoint.
 * Anything unrecognised is `undefined` rather than a half-built row: this page
 * has no retry affordance, and a fabricated 0% would be worse than silence.
 */
export const readGoUsage = async (
  scope: unknown
): Promise<GoUsage | undefined> => {
  // Every path out of here is silent, and the meter's empty state is the same
  // for all of them — so each one says which it was. Without this, "no remote",
  // "no service" and "an answer this does not recognise" are one symptom, and
  // finding the cause means reading the host's code instead of the console.
  //
  // The namespace is read through the shared guard, NOT as
  // `scope.remote.opencodeGoUsage`. Cordis guards property access by name and
  // THROWS for a namespace this bundle never declared in `inject`, and an
  // optional chain cannot catch a throw — so the direct read takes the whole
  // settings card down, which is what "the meter is not shown" was. The meter's
  // own injector was fixed for exactly this; this call site was not, and that is
  // the second fix this now does not need.
  const remote = isRecord(scope) ? scope.remote : undefined;
  if (remote === undefined) {
    console.warn(
      "[dsh-opencode-patch] usage read: the settings scope exposes no remote"
    );
    return undefined;
  }
  // Through the context first: `remote.<ns>` is a service property, so an
  // undeclared read THROWS and the guard answers `undefined` — the same answer as
  // "no service". `ctx.get` does not consult `inject`, which is what makes a
  // namespace this bundle mounts itself readable at all.
  const namespace =
    remoteNamespaceOf(scope, "opencodeGoUsage") ??
    remoteNamespace(remote, "opencodeGoUsage");
  if (namespace === undefined) {
    console.warn(
      "[dsh-opencode-patch] usage read: no opencodeGoUsage service on the remote",
      Object.keys(isRecord(remote) ? remote : {})
    );
    return undefined;
  }
  const call = namespace.read;
  if (!isRemoteCall(call)) {
    console.warn(
      "[dsh-opencode-patch] usage read: no opencodeGoUsage service on the remote",
      Object.keys(namespace)
    );
    return undefined;
  }
  const result: unknown = await callUsageRead(call, { provider: "opencode-go" });
  if (isRecord(result) && typeof result.ok === "boolean") {
    if (!result.ok) {
      throw "error" in result ? result.error : new Error("usage call failed");
    }
    const value = "value" in result ? result.value : undefined;
    if (!isGoUsage(value)) {
      return undefined;
    }
    return value;
  }
  const value = isRecord(result) && "value" in result ? result.value : result;
  if (!isGoUsage(value)) {
    console.warn(
      "[dsh-opencode-patch] usage read: the answer is not a usage shape",
      result
    );
    return undefined;
  }
  return value;
};

/** The status word: which of the three states this reading is in. */
const statusText = (
  t: Translate,
  usage: GoUsage | undefined,
  limited: boolean,
  refreshing = false
): string => {
  if (refreshing) {
    return t("usageRefreshing");
  }
  if (usage === undefined) {
    return t("usageSummaryUnavailable");
  }
  return limited ? t("usageSummaryStatusLimited") : t("usageSummaryStatusOk");
};

export interface UsageSummaryViewProps {
  locale: string | undefined;
  onRefresh?: () => void | Promise<void>;
  refreshing?: boolean;
  t: Translate;
  usage: GoUsage | undefined;
}

/**
 * The summary itself: pure, so a test can invoke it and read the tree without
 * mounting — the same contract the meter's panel keeps.
 */
export const UsageSummaryView = ({
  locale,
  onRefresh,
  refreshing = false,
  t,
  usage,
}: UsageSummaryViewProps): React.ReactElement => {
  const limited =
    usage !== undefined &&
    WINDOWS.some(({ key }) => usage[key].status === "rate-limited");

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div
        style={{
          alignItems: "baseline",
          display: "flex",
          justifyContent: "space-between",
        }}
      >
        <span
          style={{
            alignItems: "center",
            display: "inline-flex",
            fontSize: 12,
            fontWeight: 600,
            gap: 4,
          }}
        >
          {t("usageSummaryTitle")}
          {/*
            The note is an explanation, so it lives behind this affordance — the
            same rule the composer panel's billing note follows. A paragraph
            under the rows made the caveat the loudest thing on a summary that
            is meant to be read at a glance. Inline styles because this surface
            has no stylesheet: the meter's classes are not rendered here.
          */}
          <Tooltip label={t("usageSummaryNote")} portal side="top">
            <span
              style={{
                color: "var(--dsw-alias-label-tertiary)",
                cursor: "help",
                display: "inline-flex",
              }}
              tabIndex={0}
            >
              <IconInfoOutlineRegular size={13} />
            </span>
          </Tooltip>
        </span>
        <div
          style={{
            alignItems: "center",
            display: "inline-flex",
            gap: 6,
          }}
        >
          <span
            style={{ color: "var(--dsw-alias-label-secondary)", fontSize: 11 }}
          >
            {statusText(t, usage, limited, refreshing)}
          </span>
          {onRefresh !== undefined && (
            <button
              aria-label={refreshing ? t("usageRefreshing") : t("usageRetry")}
              disabled={refreshing}
              onClick={() => {
                void onRefresh();
              }}
              style={{
                alignItems: "center",
                background: "transparent",
                border: "none",
                borderRadius: 4,
                color: "var(--dsw-alias-label-secondary)",
                cursor: refreshing ? "default" : "pointer",
                display: "inline-flex",
                height: 18,
                justifyContent: "center",
                opacity: refreshing ? 0.6 : 1,
                padding: 2,
                width: 18,
              }}
              type="button"
            >
              <span
                style={{
                  animation: refreshing
                    ? "dsh-oc-spin 0.9s linear infinite"
                    : undefined,
                  display: "inline-flex",
                }}
              >
                <IconRefreshOutlineRegular size={11} />
              </span>
            </button>
          )}
        </div>
      </div>

      {usage !== undefined &&
        WINDOWS.map(({ copy, key }) => {
          const window = usage[key];
          return (
            <div
              key={key}
              style={{
                alignItems: "center",
                display: "flex",
                fontSize: 11,
                gap: 8,
              }}
            >
              <StateDot state={getWindowState(window)} />
              <span style={{ flex: "0 0 46px" }}>{t(copy)}</span>
              <span
                style={{
                  color: "var(--dsw-alias-label-secondary)",
                  flex: 1,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {`${window.percent}% ${t("usageSummaryUsed")} · ${resetLabel(
                  formatRelativeReset(window.resetsAt, locale),
                  t
                )}`}
              </span>
              {/* What is LEFT, held out on the right the way the console does. */}
              <span
                style={{
                  fontVariantNumeric: "tabular-nums",
                  fontWeight: 600,
                  textAlign: "right",
                }}
              >
                {`${Math.max(0, 100 - window.percent)}%`}
              </span>
              <span
                style={{
                  color: "var(--dsw-alias-label-tertiary)",
                  flex: "0 0 26px",
                }}
              >
                {t("usageSummaryRemaining")}
              </span>
            </div>
          );
        })}

      {usage?.allowance !== undefined && (
        <div
          style={{ color: "var(--dsw-alias-label-secondary)", fontSize: 11 }}
        >
          {`${t("usageSummaryAllowance")} ${usage.allowance.model} · ${t(
            "goTier"
          )} ${formatUsd(usage.allowance.go)} · ${t("goPlusTier")} ${formatUsd(
            usage.allowance.goPlus
          )}`}
        </div>
      )}
    </div>
  );
};

export interface UsageSummaryProps {
  attempts?: number;
  getLocale: (() => string | undefined) | undefined;
  readUsage: (() => Promise<GoUsage | undefined>) | undefined;
  sleep?: (attempt: number) => Promise<void>;
  t: Translate;
}

/**
 * Read until an answer arrives, a bounded number of times.
 *
 * The remote is mounted by an asynchronous effect, so a surface that appears first
 * reads against a remote that is not there yet and answers `undefined`. Reading once
 * leaves it empty until the page is reloaded, which is exactly the difference a user
 * sees between this card and the composer meter - the meter reads on every turn.
 *
 * Extracted from the component so the retry is a behaviour a test can perform rather
 * than a branch inside a React effect.
 *
 * @param read - the read to attempt.
 * @param attempts - how many times to try before giving up.
 * @param sleep - the wait between attempts, called with the attempt number.
 * @param live - asked before each attempt; `false` abandons the loop.
 * @returns the first defined answer, or `undefined`.
 */
export const readUntilAnswered = retryUntilAnswered;

/** The container: reads once when the card appears, on window focus, or via manual refresh. */
export const UsageSummary: React.FC<UsageSummaryProps> = ({
  attempts = 5,
  getLocale,
  readUsage,
  sleep,
  t,
}) => {
  const [usage, setUsage] = React.useState<GoUsage | undefined>();
  const [settled, setSettled] = React.useState(false);
  const [refreshing, setRefreshing] = React.useState(false);

  const fetchUsage = React.useCallback(async () => {
    if (readUsage === undefined) {
      return;
    }
    setRefreshing(true);
    let next: GoUsage | undefined;
    try {
      next = await readUntilAnswered(readUsage, attempts, sleep, () => true);
    } catch (error) {
      // The meter's empty state is the same for every cause, so the one place
      // that knows the read failed says which it was. Without this, a failing
      // read and a service that was never mounted look identical.
      console.warn("[dsh-opencode-patch] usage read failed", error);
      next = undefined;
    } finally {
      setRefreshing(false);
    }
    setUsage(next);
    setSettled(true);
  }, [attempts, readUsage, sleep]);

  React.useEffect(() => {
    void fetchUsage();
  }, [fetchUsage]);

  React.useEffect(() => {
    const onFocus = () => {
      void fetchUsage();
    };
    window.addEventListener("focus", onFocus);
    return () => {
      window.removeEventListener("focus", onFocus);
    };
  }, [fetchUsage]);

  if (readUsage === undefined) {
    return <></>;
  }
  // `settled` is read so the row does not flash "unavailable" before the first
  // read lands: an empty state and a pending one are different states.
  return (
    <UsageSummaryView
      locale={getLocale?.()}
      onRefresh={fetchUsage}
      refreshing={refreshing}
      t={t}
      usage={settled ? usage : undefined}
    />
  );
};
