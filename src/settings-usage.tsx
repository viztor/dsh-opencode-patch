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
  StateDot,
  Tooltip,
} from "@deepseek-ai/dsh-client-ui-primitives";
import React from "react";

import { formatUsd } from "./go-limits.ts";
import { isRecord } from "./guards.ts";
import type { Translate } from "./settings-copy.ts";
import type { GoUsage, UsageWindow } from "./usage-contract.ts";
import { formatRelativeReset, getWindowState, resetLabel } from "./usage-ui.ts";

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

/** Whether a value can be called as the Host's read. A predicate, not a cast. */
const isReadFunction = (
  value: unknown
): value is (query: unknown) => Promise<unknown> => typeof value === "function";

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
  if (!isRecord(scope) || !isRecord(scope.remote)) {
    return undefined;
  }
  const service = scope.remote.opencodeGoUsage;
  if (!isRecord(service) || !isReadFunction(service.read)) {
    return undefined;
  }
  const result: unknown = await service.read({ provider: "opencode-go" });
  const value = isRecord(result) && "value" in result ? result.value : result;
  return isGoUsage(value) ? value : undefined;
};

/** The status word: which of the three states this reading is in. */
const statusText = (
  t: Translate,
  usage: GoUsage | undefined,
  limited: boolean
): string => {
  if (usage === undefined) {
    return t("usageSummaryUnavailable");
  }
  return limited ? t("usageSummaryStatusLimited") : t("usageSummaryStatusOk");
};

export interface UsageSummaryViewProps {
  locale: string | undefined;
  t: Translate;
  usage: GoUsage | undefined;
}

/**
 * The summary itself: pure, so a test can invoke it and read the tree without
 * mounting — the same contract the meter's panel keeps.
 */
export const UsageSummaryView = ({
  locale,
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
          <Tooltip label={t("usageSummaryNote")} side="top">
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
        <span
          style={{ color: "var(--dsw-alias-label-secondary)", fontSize: 11 }}
        >
          {statusText(t, usage, limited)}
        </span>
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
  getLocale: (() => string | undefined) | undefined;
  readUsage: (() => Promise<GoUsage | undefined>) | undefined;
  t: Translate;
}

/** The container: reads once when the card appears, then hands off to the view. */
export const UsageSummary: React.FC<UsageSummaryProps> = ({
  getLocale,
  readUsage,
  t,
}) => {
  const [usage, setUsage] = React.useState<GoUsage | undefined>();
  const [settled, setSettled] = React.useState(false);

  React.useEffect(() => {
    if (readUsage === undefined) {
      // Every path returns a cleanup, so the effect's shape does not depend on
      // which branch ran.
      return () => {
        // No read was started, so there is nothing to cancel.
      };
    }
    let live = true;
    void (async () => {
      try {
        const next = await readUsage();
        if (live) {
          setUsage(next);
        }
      } catch {
        if (live) {
          setUsage(undefined);
        }
      }
      if (live) {
        setSettled(true);
      }
    })();
    return () => {
      live = false;
    };
  }, [readUsage]);

  if (readUsage === undefined) {
    return <></>;
  }
  // `settled` is read so the row does not flash "unavailable" before the first
  // read lands: an empty state and a pending one are different states.
  return (
    <UsageSummaryView
      locale={getLocale?.()}
      t={t}
      usage={settled ? usage : undefined}
    />
  );
};
