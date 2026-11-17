/**
 * The OpenCode Go quota meter's state: the ring's geometry, which window the
 * meter answers for, and the fill state each window is in. Pure, so the
 * meter's behaviour is unit-testable without React.
 *
 * @module dsh-opencode-patch/usage-state
 */

import type { GoUsage, UsageWindow } from "./contracts/usage.ts";

export const RADIUS = 5.5;
export const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

/**
 * Clamp a quota percentage to the ring's range and derive its dash array.
 *
 * Shared by the trigger ring (which strokes `strokeDasharray`) and the panel
 * progress bar (which uses `clampedPercent` as a width), so both render the
 * same number.
 *
 * @param percent - the raw quota percentage; out-of-range values clamp.
 */
export const ringGeometry = (
  percent: number
): { clampedPercent: number; strokeDasharray: string } => {
  const clampedPercent = Math.min(100, Math.max(0, percent));
  const dashLength = (CIRCUMFERENCE * clampedPercent) / 100;
  return {
    clampedPercent,
    strokeDasharray: `${dashLength} ${CIRCUMFERENCE}`,
  };
};

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

/**
 * What a window's fill state IS, in the kit's own vocabulary.
 *
 * `StateDotState` — the same union `@deepseek-ai/dsh-client-ui-primitives`'
 * `StateDot` takes — reads `done` / `warning` / `error`, and its CSS maps each
 * to the host's state tokens (`--dsw-alias-state-success-primary`,
 * `--dsw-alias-state-warn-primary`, `--dsw-alias-state-error-primary`).
 * Returning the SEMANTIC instead of a colour string is what let the window rows
 * adopt the kit's dot: a hand-rolled 6px circle with an inline
 * `backgroundColor` per state was one more look-alike of a primitive this repo
 * already ships.
 *
 * The ring and the bar carry the same names as a `data-state` attribute, and
 * the meter's sheet (`usage-css.ts`) maps each to its token, so the theme owns
 * those colours too and no colour string is written here.
 */
export type WindowState = "done" | "warning" | "error";

export const getWindowState = (window: UsageWindow): WindowState => {
  if (window.status === "rate-limited" || window.percent >= 100) {
    return "error";
  }
  if (window.percent >= 80) {
    return "warning";
  }
  return "done";
};

/**
 * The ring's state: the affecting window's, and `done` before a window exists
 * — the neutral assumption; the ring refills the moment data lands.
 */
export const getRingState = (affecting?: AffectingWindowResult): WindowState =>
  affecting === undefined ? "done" : getWindowState(affecting.window);

export interface AffectingWindowResult {
  key: "monthly" | "rolling" | "weekly";
  label: string;
  window: UsageWindow;
}

/** Whether a window is OUT: the vendor says so, or it is at the cap. */
const isExhausted = (window: UsageWindow): boolean =>
  window.status === "rate-limited" || window.percent >= 100;

export const getAffectingWindow = (usage: GoUsage): AffectingWindowResult => {
  // 1. A window that is OUT is what the reader has to see, widest first: a
  //    monthly cap explains a refusal that the 5-hour window does not.
  if (isExhausted(usage.monthly)) {
    return { key: "monthly", label: "Monthly", window: usage.monthly };
  }
  if (isExhausted(usage.weekly)) {
    return { key: "weekly", label: "Weekly", window: usage.weekly };
  }
  if (isExhausted(usage.rolling)) {
    return { key: "rolling", label: "5-Hour", window: usage.rolling };
  }

  // 2. Otherwise the 5-HOUR window, which resets soonest and so is the one the
  //    reader can still act on. Picking the HIGHEST percentage made the meter
  //    answer for the weekly window (33%) while the 5-hour window (11%) was the
  //    live constraint — read as "why is it showing the weekly limit?".
  return { key: "rolling", label: "5-Hour", window: usage.rolling };
};
