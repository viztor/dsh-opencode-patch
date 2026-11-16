/**
 * Dollar amounts, in the two contracts the panels show them in: one function,
 * one row per contract.
 *
 * A metered spend and a published allowance are different kinds of figure,
 * and they used to be formatted by two functions that shared a name
 * (`formatUsd` in `session-cost.ts` and in `go-limits.ts`). Every caller now
 * names the style it wants, so neither contract is the other's by accident.
 *
 * Pure and dependency-free: the client bundle imports it, and the
 * architecture test holds `utils/` to that.
 *
 * @module dsh-opencode-patch/utils/usd
 */

/** Which of the two dollar contracts a figure is shown in. */
export type UsdStyle = "allowance" | "metered";

/** How each style renders a number. */
const RENDER: Readonly<Record<UsdStyle, (usd: number) => string>> = {
  /**
   * A published allowance. Unknown allowances (including NaN serialized as
   * null) are never dollar values, and a negative one is not a figure either;
   * a whole published total drops the cents (`$60`), because it is not the
   * same kind of figure as a metered spend.
   */
  allowance: (usd) => {
    if (!Number.isFinite(usd) || usd < 0) {
      return "—";
    }
    return Number.isInteger(usd) ? `$${usd}` : `$${usd.toFixed(2)}`;
  },
  /**
   * A metered spend, always two decimals.
   *
   * The precision used to tier by magnitude — three decimals below a cent,
   * four below a tenth of one — and the owner read `$0.006` on the trigger
   * and called it too much precision in the wrong place. A meter is a gauge,
   * not an invoice: `$0.01` of a real spend is an honest rounding of six
   * tenths of a cent, the same rounding every wallet UI makes. Precision tiers
   * reintroduce the exact thing the panel keeps paying to remove — a number
   * whose LENGTH changes with its value, so the row shifts on every turn.
   */
  metered: (usd) => `$${usd.toFixed(2)}`,
};

/**
 * Format a dollar amount in a named style.
 *
 * @param value - the amount; anything but a number is "—" in either style.
 * @param style - `allowance` for a published total, `metered` for a spend.
 * @returns the formatted amount.
 */
export const formatUsd = (value: unknown, style: UsdStyle): string =>
  typeof value === "number" ? RENDER[style](value) : "—";
