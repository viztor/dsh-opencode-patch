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
  Button,
  IconInfoOutlineRegular,
  IconRefreshOutlineRegular,
  StateDot,
  Tooltip,
} from "@deepseek-ai/dsh-client-ui-primitives";
import React from "react";

import {
  USAGE_NAMESPACE,
  usageRemote,
  type GoUsage,
} from "./contracts/usage.ts";
import type { Translate } from "./settings-copy.ts";
import {
  callUsageRead,
  findRemoteCall,
  remoteFaceOf,
  unwrapRemote,
} from "./settings-remote.ts";
import { getWindowState } from "./usage-state.ts";
import { formatRelativeReset, resetLabel } from "./usage-time.ts";
import { backoffOver, retryUntilAnswered } from "./utils/retry.ts";
import { formatUsd } from "./utils/usd.ts";

/** The three windows, in the order the panel lists them. */
const WINDOWS = [
  { copy: "usage_rolling", key: "rolling" },
  { copy: "usage_weekly", key: "weekly" },
  { copy: "usage_monthly", key: "monthly" },
] as const;

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
  // settings card down, which is what "the meter is not shown" was.
  //
  // Through the context first (`findRemoteCall`): `ctx.get` does not consult
  // `inject`, which is what makes a namespace this bundle mounts itself
  // readable at all, and `scope.remote` is read only when it misses, inside a
  // guard — the meter's lookup order. Reading `scope.remote` first, unguarded,
  // made a throwing getter reject this read, and a scope with no `remote`
  // property miss a namespace `ctx.get` resolves.
  const found = findRemoteCall(scope, usageRemote, "read");
  if (found.call === undefined) {
    if (remoteFaceOf(scope) === undefined) {
      console.warn(
        "[dsh-opencode-patch] usage read: the settings scope exposes no remote"
      );
    } else {
      console.warn(
        `[dsh-opencode-patch] usage read: no ${USAGE_NAMESPACE} service on the remote`,
        found.exposed
      );
    }
    return undefined;
  }
  // Parsed by the contract's reading parser, so the windows are checked as
  // the Host checks them and only the fields it sends are kept.
  const answer = unwrapRemote(
    usageRemote,
    "read",
    await callUsageRead(found.call, { provider: "opencode-go" })
  );
  if (answer.kind === "refused") {
    const failure: unknown = answer.error ?? new Error("usage call failed");
    throw failure;
  }
  if (answer.kind === "invalid") {
    console.warn(
      "[dsh-opencode-patch] usage read: the answer is not a usage shape",
      answer.value
    );
    return undefined;
  }
  return answer.value;
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
 * mounting — the same contract the meter's panel keeps. Styled by the card's
 * sheet (`settings-css.ts`), which the card renders around it.
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
    <div className="dsh-oc-card-summary">
      <div className="dsh-oc-card-summary-head">
        <span className="dsh-oc-card-summary-title">
          {t("usageSummaryTitle")}
          {/*
            The note is an explanation, so it lives behind this affordance — the
            same rule the composer panel's billing note follows. A paragraph
            under the rows made the caveat the loudest thing on a summary that
            is meant to be read at a glance. A DOM node inside the Tooltip, which
            clones its child: a component would ignore the handlers.
          */}
          <Tooltip label={t("usageSummaryNote")} portal side="top">
            <span className="dsh-oc-card-info" tabIndex={0}>
              <IconInfoOutlineRegular size={13} />
            </span>
          </Tooltip>
        </span>
        <div className="dsh-oc-card-summary-status">
          <span className="dsh-oc-card-summary-status-text">
            {statusText(t, usage, limited, refreshing)}
          </span>
          {/*
            The host's ghost Button with its icon. While a read is in flight it
            is disabled, and the card's sheet turns the glyph off that state —
            the same animation the meter's sheet declares, so it turns with no
            meter on the page.
          */}
          {onRefresh !== undefined && (
            <Button
              aria-label={refreshing ? t("usageRefreshing") : t("usageRetry")}
              className="dsh-oc-card-refresh"
              disabled={refreshing}
              icon={
                <IconRefreshOutlineRegular
                  className="dsh-oc-card-refresh-icon"
                  size={11}
                />
              }
              onClick={() => {
                void onRefresh();
              }}
              size="sm"
              variant="ghost"
            />
          )}
        </div>
      </div>

      {usage !== undefined &&
        WINDOWS.map(({ copy, key }) => {
          const window = usage[key];
          return (
            <div className="dsh-oc-card-summary-row" key={key}>
              <StateDot state={getWindowState(window)} />
              <span className="dsh-oc-card-summary-label">{t(copy)}</span>
              <span className="dsh-oc-card-summary-detail">
                {`${window.percent}% ${t("usageSummaryUsed")} · ${resetLabel(
                  formatRelativeReset(window.resetsAt, locale),
                  t
                )}`}
              </span>
              {/* What is LEFT, held out on the right the way the console does. */}
              <span className="dsh-oc-card-summary-left">
                {`${Math.max(0, 100 - window.percent)}%`}
              </span>
              <span className="dsh-oc-card-summary-remaining">
                {t("usageSummaryRemaining")}
              </span>
            </div>
          );
        })}

      {usage?.allowance !== undefined && (
        <div className="dsh-oc-card-summary-allowance">
          {`${t("usageSummaryAllowance")} ${usage.allowance.model} · ${t(
            "goTier"
          )} ${formatUsd(usage.allowance.go, "allowance")} · ${t("goPlusTier")} ${formatUsd(usage.allowance.goPlus, "allowance")}`}
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
 * The browser's timer and console are supplied here, at the edge, so
 * `utils/retry.ts` stays a function of its arguments.
 *
 * @param read - the read to attempt.
 * @param attempts - how many times to try before giving up.
 * @param sleep - the wait between attempts, called with the attempt number;
 * omitted, a linear backoff on the browser's timer.
 * @param live - asked before each attempt; `false` abandons the loop.
 * @returns the first defined answer, or `undefined`.
 */
export const readUntilAnswered = <T,>(
  read: () => Promise<T | undefined>,
  attempts = 5,
  sleep?: (attempt: number) => Promise<void>,
  live: () => boolean = () => true
): Promise<T | undefined> =>
  retryUntilAnswered(read, {
    attempts,
    live,
    sleep:
      sleep ??
      backoffOver((callback, delayMs) => setTimeout(callback, delayMs)),
    warn: (message, error) => {
      console.warn(message, error);
    },
  });

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
