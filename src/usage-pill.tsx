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
  CIRCUMFERENCE,
  describeUsage,
  getAffectingWindow,
  getWindowColorFor,
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

/**
 * A STABLE snapshot, not a fresh object per call.
 *
 * `useSyncExternalStore` compares by identity, so a getter that builds a new
 * object every time reports a change on every read and React re-renders forever
 * — "Maximum update depth exceeded" (React error #185), which is how the first
 * version of this fallback failed.
 */
const NO_DIRECTORY_STATE: ModelDirectoryState = {};

const NO_DIRECTORY: SnapshotStore<ModelDirectoryState> = {
  getSnapshot: () => NO_DIRECTORY_STATE,
  subscribe: () => () => {
    // Nothing to unsubscribe from.
  },
};

export interface UsagePillProps {
  /**
   * The session's model-directory store.
   *
   * Optional because absence is a real state: the injector hands over no props
   * when the Host has no model directory or no usage service, and the Host reads
   * `hooks` off whatever it returns — so the pill must render from nothing
   * rather than the entry throwing inside the renderer.
   */
  directory?: SnapshotStore<ModelDirectoryState>;
  getLocale?: () => string;
  /**
   * Deprecated: model markers are no longer used for gating. Kept optional for backward compatibility.
   */
  modelMarkers?: readonly string[];
  /** Why the meter has no directory; set only on the diagnostic path. */
  reason?: string;
  /**
   * Provider routes the meter is shown for — the same list the host claims
   * traffic for. Defaults to the stock routes when absent or empty.
   */
  meterProviders?: readonly string[];
  /**
   * Read the quota, and optionally name the model the picker is on so the Host
   * can price the rate for THAT model — the snapshot alone describes the model
   * that ran the last turn.
   */
  readUsage: (provider?: string, model?: string) => Promise<GoUsage>;
  /** Whether to show accumulated session spend and the active model's rate. */
  showUsagePrice?: boolean;
  t: (key: string) => string;
}

const noop = (): void => {
  /* no-op */
};

interface ActiveUsageProps extends Omit<UsagePillProps, "directory"> {
  /** The model the picker is on, or `undefined` before a selection is saved. */
  model?: string;
  provider?: string;
}

const ActiveUsage = ({
  getLocale,
  model,
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
        const value = await readUsage(provider, model);
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
  }, [readUsage, provider, model]);

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

  /**
   * Hovering no longer opens the panel — it only cancels a pending close, so
   * moving from the trigger onto the panel keeps it open. The panel is opened by
   * a click, and hovering the trigger shows a `Tooltip` instead.
   */
  const handleMouseEnter = (): void => {
    if (hoverTimer.current !== null) {
      clearTimeout(hoverTimer.current);
      hoverTimer.current = null;
    }
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
  // A free model has no allowance to run out of: the plan's limit says nothing
  // about what the user is actually spending, which is zero. Red would read as
  // "you are out of money" against a bill that cannot be charged, so the ring
  // goes hollow instead — the track colour, the empty state.
  const isFree =
    usage?.session?.freeModel === true ||
    (isZen && usage?.allowance === undefined);
  // `undefined` affecting means the first read is still in flight; success is
  // the neutral assumption, and the ring refills the moment data lands.
  const ringColor = isFree
    ? "var(--dsw-alias-label-tertiary)"
    : getWindowColorFor(affecting);

  const strokeDasharray = isFree
    ? `0 ${CIRCUMFERENCE}`
    : ringGeometry(displayPercent).strokeDasharray;

  let triggerLabel = "…";
  if (usage !== undefined) {
    triggerLabel = `${displayPercent}%`;
  } else if (failure !== null) {
    triggerLabel = "!";
  }

  const locale = getLocale?.();

  // Wording lives in `usage-ui.ts` so it can be unit-tested without React.
  // The hover label is the SAME string the panel opens under: no second
  // composition, no keys an older served dictionary has not heard of.
  const { badgeText, headline, title, zenCardCredit, zenCardDesc } =
    describeUsage(usage, affecting, isZen, t);

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
      {/* Hover explains; the click opens. */}
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
        tooltipLabel={headline}
        triggerLabel={triggerLabel}
        usage={usage}
      />
      {open && (
        <UsagePanel
          badgeText={badgeText}
          failure={failure}
          isLimited={isLimited}
          isZen={isZen}
          locale={locale}
          onMouseEnter={handleMouseEnter}
          onMouseLeave={handleMouseLeave}
          refreshing={refreshing}
          retry={() => {
            retry.current();
          }}
          showUsagePrice={showUsagePrice}
          t={t}
          title={title}
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
  reason: _reason,
  ...props
}: UsagePillProps): React.ReactElement | null => {
  // A fallback rather than an early return: `useSyncExternalStore` is a hook, so
  // the call has to happen either way.
  const store = directory ?? NO_DIRECTORY;
  const state = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot
  );

  // No directory means the injector had nothing to hand over — the Host has no
  // model directory for this session, or no usage service. Rendering nothing is
  // the honest state, and it is safe to return here: this is the component's
  // only hook.
  if (directory === undefined) {
    return null;
  }

  const provider = state?.current?.provider ?? state?.pending?.provider ?? "";
  // The selection, so the Host can price the rate for what the NEXT turn runs
  // rather than for whatever ran last. A pending pick wins over the saved one —
  // it is the model the user is looking at.
  const model = state?.pending?.model ?? state?.current?.model ?? undefined;
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

  return <ActiveUsage {...props} model={model} provider={provider} />;
};
