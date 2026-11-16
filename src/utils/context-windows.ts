/**
 * Context windows measured against the gateway, where they differ from the
 * catalog's (L11): the table pattern, with dated evidence per row.
 *
 * An understated window is the overflow trap: the composer trims to the
 * window it was told, the gateway serves a larger one, and nothing fails —
 * the conversation is just shorter than it could be. An overstated one is
 * worse: the gateway refuses a request the composer thought would fit. A
 * measured window is therefore read ahead of the catalog's, and behind
 * anything the user declared (`plane-model.ts`'s precedence). Settings'
 * discovery rows (`models-discovery.ts`) read it in the catalog's place in
 * each of their field orders: ahead of pi's window on a plane the plugin
 * serves, and still behind it on a route pi-ai serves from pi's own row.
 *
 * The table ships EMPTY: this repository has measured no window that differs
 * from the catalog's. A row is added with the measurement that justifies it —
 * the date and the evidence travel with the number, so a later reader can
 * tell a measurement from a guess, and a vendor fix from a stale override.
 *
 * Every value is a constant or a function of its arguments: this module is in
 * `utils/` and the architecture test holds it to that.
 *
 * @module dsh-opencode-patch/utils/context-windows
 */

import type { Plane } from "./planes.ts";

/** One measured window. */
export interface MeasuredWindow {
  /** The window the gateway serves, in tokens. */
  readonly window: number;
  /** When it was measured, as an ISO date (`2026-11-16`). */
  readonly measured: string;
  /** What was measured, and where the record is. */
  readonly evidence: string;
}

/** A plane's measured windows, by model id. */
export type MeasuredWindows = Readonly<
  Record<Plane, Readonly<Record<string, MeasuredWindow>>>
>;

/** The measured windows this repository ships: none yet. */
export const MEASURED_CONTEXT_WINDOWS: MeasuredWindows = { go: {}, zen: {} };

/**
 * The measured window for a model on a plane, or `undefined` when none was
 * measured. An own row only: an id every object inherits (`toString`) is
 * never a model.
 *
 * @param plane - the plane the model is served on.
 * @param id - the model id.
 * @param table - the table to read; the shipped one by default.
 * @returns the window, or `undefined`.
 */
export const measuredWindowFor = (
  plane: Plane,
  id: string,
  table: MeasuredWindows = MEASURED_CONTEXT_WINDOWS
): number | undefined => {
  const rows = table[plane];
  const row = Object.hasOwn(rows, id) ? rows[id] : undefined;
  return row?.window;
};
