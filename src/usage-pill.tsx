/**
 * Composer-dock component displaying OpenCode Go quota and rate limits.
 *
 * Owns the meter's *state* (polling, dismissal, retry, gating); `usage-panel.tsx`
 * renders it and `usage-ui.ts` reads it, so both are testable without a DOM.
 *
 * @module dsh-opencode-patch/usage-pill
 */

import React, {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import { DEFAULT_PROVIDERS } from "./config-values.ts";
import type { GoUsage } from "./usage-contract.ts";
import { UsagePanel, UsageTrigger } from "./usage-panel.tsx";
import {
  describeUsage,
  getAffectingWindow,
  getWindowColor,
  isZenProvider,
  matchesAny,
  parseFailure,
  ringGeometry,
  STYLES,
  type UsageFailure,
} from "./usage-ui.ts";

export interface SnapshotStore<T> {
  getSnapshot: () => T;
  subscribe: (onStoreChange: () => void) => () => void;
}

/** The provider/model pair the directory reports for one selection. */
interface DirectorySelection {
  model?: string;
  provider?: string;
}

export interface ModelDirectoryState {
  /**
   * Saved selection, retained even when it leaves the catalog — and `null` until
   * one is saved, which is why the gate must not read it as "not OpenCode".
   */
  current?: DirectorySelection;
  /** Selection submitted by the latest `select` until it settles; null otherwise. */
  pending?: DirectorySelection;
}

export interface UsagePillProps {
  directory: SnapshotStore<ModelDirectoryState>;
  getLocale?: () => string;
  /**
   * Deprecated: model markers are no longer used for gating. Kept optional for backward compatibility.
   */
  modelMarkers?: readonly string[];
  /**
   * Provider routes the meter is shown for — the same list the host claims
   * traffic for. Defaults to the stock routes when absent or empty.
   */
  meterProviders?: readonly string[];
  readUsage: (provider?: string) => Promise<GoUsage>;
  /** Whether to show accumulated session spend and the active model's rate. */
  showUsagePrice?: boolean;
  t: (key: string) => string;
}

const noop = (): void => {
  /* no-op */
};

interface ActiveUsageProps extends Omit<UsagePillProps, "directory"> {
  provider?: string;
}

const ActiveUsage = ({
  getLocale,
  provider,
  readUsage,
  showUsagePrice = true,
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

  const isZen = isZenProvider(provider);

  const affecting = usage === undefined ? undefined : getAffectingWindow(usage);
  const isLimited = affecting?.window.status === "rate-limited";
  const displayPercent = affecting?.window.percent ?? 0;
  const ringColor =
    affecting === undefined
      ? "var(--dsw-alias-state-success-primary)"
      : getWindowColor(affecting.window);

  const { clampedPercent, strokeDasharray } = ringGeometry(displayPercent);

  let triggerLabel = "…";
  if (usage !== undefined) {
    triggerLabel = `${displayPercent}%`;
  } else if (failure !== null) {
    triggerLabel = "!";
  }

  const locale = getLocale?.();

  // Wording lives in `usage-ui.ts` so it can be unit-tested without React.
  const { badgeText, headline, zenCardCredit, zenCardDesc } = describeUsage(
    usage,
    affecting,
    isZen,
    t
  );

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
      <UsageTrigger
        displayPercent={displayPercent}
        isLimited={isLimited}
        isZen={isZen}
        onClick={() => {
          setOpen((prev) => !prev);
        }}
        open={open}
        ringColor={ringColor}
        showUsagePrice={showUsagePrice}
        strokeDasharray={strokeDasharray}
        t={t}
        triggerLabel={triggerLabel}
        usage={usage}
      />
      {open && (
        <UsagePanel
          badgeText={badgeText}
          clampedPercent={clampedPercent}
          failure={failure}
          headline={headline}
          isLimited={isLimited}
          isZen={isZen}
          locale={locale}
          onMouseEnter={handleMouseEnter}
          onMouseLeave={handleMouseLeave}
          refreshing={refreshing}
          retry={() => {
            retry.current();
          }}
          ringColor={ringColor}
          showUsagePrice={showUsagePrice}
          t={t}
          updatedAt={current === null ? null : current.updatedAt}
          usage={usage}
          zenCardCredit={zenCardCredit}
          zenCardDesc={zenCardDesc}
        />
      )}
    </span>
  );
};

export const UsagePill = ({
  directory,
  meterProviders,
  modelMarkers: _modelMarkers,
  ...props
}: UsagePillProps): React.ReactElement | null => {
  const state = useSyncExternalStore(
    directory.subscribe,
    directory.getSnapshot,
    directory.getSnapshot
  );

  const provider = state?.current?.provider ?? state?.pending?.provider ?? "";
  // The settings scope passes the claimed routes at inject time; an absent or
  // empty list falls back to the stock ones, so direct callers (and older
  // injected props) keep the default gate.
  const providers =
    meterProviders !== undefined && meterProviders.length > 0
      ? meterProviders
      : DEFAULT_PROVIDERS;
  // No saved or pending selection means the provider is UNKNOWN, not "not
  // OpenCode" — and `current` stays null until a selection is saved, so hiding
  // on it made the meter vanish for a whole fresh session. The Host is the
  // authority on whether there is a Go account to report: its read answers
  // `configured: false` when there is not, and the panel renders nothing then.
  if (provider.length > 0 && !matchesAny(provider, providers)) {
    return null;
  }

  return <ActiveUsage {...props} provider={provider} />;
};
