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
import { goQuotaTooltip, UsagePanel, UsageTrigger } from "./usage-panel.tsx";
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
  t: (key: string) => string;
}

/**
 * One full turn of the refresh glyph, and the minimum a click stays busy.
 *
 * These two must agree: the CSS animates `dsh-oc-spin` for 0.9s per cycle, and
 * the manual refresh holds its state open for at least this long, so the button
 * always completes a turn instead of flickering. A test pins the number against
 * the keyframes, because the two drifting apart is exactly how the glyph went
 * from "a full cycle" back to "an unreadable flicker".
 */
export const MIN_FEEDBACK_MS = 900;

/**
 * Whether the reader has asked for less motion.
 *
 * Read at call time, not at module load: the query can change between renders,
 * and a cached answer would pin the first preference the reader ever had.
 */
const reducedMotion = (): boolean =>
  globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

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
      const startedAt = Date.now();
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
          // A click must show AT LEAST one full turn of the refresh glyph. The
          // spin already exists (rotate 360deg, 0.9s, infinite) but the read is
          // usually faster than that, so the icon flickered for ~100ms and
          // completed no cycle at all — the click looked like it did nothing.
          //
          // Only a MANUAL refresh is padded. The 60s poll is invisible, and
          // holding its state open would just delay the next tick. Skipped
          // entirely under prefers-reduced-motion, where a full turn is motion
          // the reader has opted out of — the data still lands, just without the
          // animation to wait for.
          const remaining = MIN_FEEDBACK_MS - (Date.now() - startedAt);
          if (manual && remaining > 0 && !reducedMotion()) {
            await new Promise((resolve) => {
              setTimeout(resolve, remaining);
            });
          }
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
  // A free model has nothing to run out of, so its ring is hollow rather than
  // red. (Zen needs no clause here: it draws no ring at all — a gauge with no
  // measurement is decoration.)
  const isFree = usage?.session?.freeModel === true;
  // `undefined` affecting means the first read is still in flight; success is
  // the neutral assumption, and the ring refills the moment data lands.
  const ringColor = isFree
    ? "var(--dsw-alias-label-tertiary)"
    : getWindowColorFor(affecting);

  const strokeDasharray = isFree
    ? `0 ${CIRCUMFERENCE}`
    : ringGeometry(displayPercent).strokeDasharray;

  // Empty, never an ellipsis. "…" is a promise that a number is coming, and on
  // a poll that cannot answer it the pill flickers … / 42% / … / 42% — which
  // reads as a glitch, not as progress. The ring already says there is a meter;
  // a failed read says "!" because that IS information.
  let triggerLabel = "";
  if (usage !== undefined) {
    // The percentage is the GO plan's window, and the Zen route does not bill
    // against it: printing it beside a per-token bill states a fact about a
    // plan this route never touches. Zen's number is the spend, which the
    // trigger prefers above; with no session record yet it shows NOTHING rather
    // than a Go figure.
    triggerLabel = isZen ? "" : `${displayPercent}%`;
  } else if (failure !== null) {
    triggerLabel = "!";
  }

  const locale = getLocale?.();

  // Wording lives in `usage-ui.ts` so it can be unit-tested without React.
  // The hover label is the SAME string the panel opens under: no second
  // composition, no keys an older served dictionary has not heard of.
  const { badgeText, title, tooltip, zenCardCredit } = describeUsage(
    usage,
    affecting,
    isZen,
    t
  );

  // A Zen hover answers the question its number raises, and that number is the
  // spend — so the label leads with the price. With no record to price it falls
  // back to the billing model, which is the only other true thing to say.
  const zenSpend =
    usage?.session === undefined
      ? undefined
      : (usage.session.planeCostFormatted ?? usage.session.costFormatted);
  const zenTooltip =
    zenSpend === undefined
      ? tooltip
      : `${t("sessionSpend")} ${zenSpend} · ${t("zenPaygBadge")}`;
  // Go lists every window: the trigger prints one number, and the next question
  // is always "and the other two?".
  const tooltipLabel = isZen ? zenTooltip : goQuotaTooltip(t, usage);

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
        strokeDasharray={strokeDasharray}
        t={t}
        tooltipLabel={tooltipLabel}
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
          t={t}
          title={title}
          updatedAt={current === null ? null : current.updatedAt}
          usage={usage}
          zenCardCredit={zenCardCredit}
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
