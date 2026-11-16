/**
 * The OpenCode Go quota meter's words and links: the actions the panel offers,
 * the windows its breakdown names, and the copy its header, badge and tooltip
 * render. Pure: the component owns state, this owns wording.
 *
 * @module dsh-opencode-patch/usage-copy
 */

import type { GoUsage } from "./contracts/usage.ts";
import type { AffectingWindowResult } from "./usage-state.ts";

/**
 * Where a user acts on what this meter shows. The console is the ONLY place a
 * balance appears: OpenCode exposes no credit endpoint and the payload carries
 * no currency, so no dollar figure can be derived from a percentage.
 * `AGENTS.md` → "OpenCode endpoints" records the probed surface behind that.
 */
export const GO_PLAN_URL = "https://opencode.ai/go";
/**
 * The console, which is also where a pay-as-you-go account is topped up.
 *
 * One URL for both, and deliberately so: it is the only destination verified to
 * exist. Every path under `/console/` answers 200 because the console is a
 * single-page app, so a probe cannot distinguish a real `/billing` route from a
 * catch-all — and a top-up link that 404s in front of a user is worse than one
 * that opens the page where top-up lives.
 */
export const CONSOLE_URL = "https://opencode.ai/console";

/** One action the panel can offer, as data so the two popovers share a body. */
export interface PanelAction {
  href: string;
  labelKey: string;
}

/**
 * What to DO about the quota, rendered inside the GO layer — next to the windows
 * it acts on, not parked under the shared footer.
 *
 * One link, not two. The limits doc went: the panel already names every window
 * with its share and its reset time, so the document explained a list the user
 * is looking at. A link that restates what is on screen is the same redundancy
 * as a card that restates the badge — the doc is one click from the console for
 * anyone who wants the policy.
 *
 * Zen has nothing to add: its single action IS the console on the footer row,
 * labelled 充值 because that is what a pay-as-you-go user wants from it.
 */
export const panelActions = (isZen: boolean): readonly PanelAction[] =>
  isZen ? [] : [{ href: GO_PLAN_URL, labelKey: "usageUpgradePlan" }];

/** Markers for one quota window, driving both the breakdown rows and cards. */
export const BREAKDOWN_WINDOWS: {
  cardName: string;
  key: "monthly" | "rolling" | "weekly";
  labelKey: string;
}[] = [
  { cardName: "5-Hour", key: "rolling", labelKey: "usage_rolling" },
  { cardName: "Weekly", key: "weekly", labelKey: "usage_weekly" },
  { cardName: "Monthly", key: "monthly", labelKey: "usage_monthly" },
];

/**
 * The localized copy the meter's header, badge and Zen card render.
 *
 * No tooltip line lives here: the trigger's hover explanation used to be a
 * second composition off the same inputs, and that seam was the wrong place to
 * hang two new keys an older dictionary had never heard of — they rendered raw
 * the first boot a user took the new bundle with an old locale registration.
 * The tooltip is `headline` until that API earns its own contract.
 */
export interface UsageCopy {
  badgeText: string;
  /**
   * What the panel header names: the ACCOUNT, not its state.
   *
   * `OpenCode Go` beside `Go Plan` / the limit badge, exactly as `OpenCode Zen`
   * sits beside `Pay-as-you-go`. The header used to carry `headline` — the
   * ring's own figure — which made the one line that identifies the surface
   * change every poll: it read `42% of Weekly used`, then `Monthly quota
   * limited`. Both facts are already on screen (the badge, and each window's
   * own row), so the line that should be stable was the one that moved.
   */
  title: string;
  /**
   * The ring explained in words — what the GO trigger says on hover.
   *
   * It names the bottleneck window ("90% of Weekly used"). It is a sentence
   * ABOUT A RING, which is why it cannot also be the Zen trigger's label: the
   * Zen trigger shows session spend and has no ring, and binding it to this
   * string is what made the hover say nothing but the account name.
   */
  headline: string;
  /**
   * The trigger's hover label, per provider.
   *
   * A tooltip has to MEAN the number beside it. Go's number is a ring, so
   * `headline` explains it. Zen's number is session spend, and the question that
   * raises is "is this metered?" — answered here once, in words, rather than by
   * repeating the panel header (which is `title`, and is already on screen).
   */
  tooltip: string;
  zenCardCredit: string;
}

/**
 * Derive the meter's user-facing copy from the active reading.
 *
 * Pure: the component owns state, this owns wording. `t` is the bound
 * translator; `affecting` is the bottleneck window (or `undefined` while the
 * first read is in flight).
 */
export const describeUsage = (
  _usage: GoUsage | undefined,
  affecting: AffectingWindowResult | undefined,
  isZen: boolean,
  t: (key: string) => string
): UsageCopy => {
  const isLimited = affecting?.window.status === "rate-limited";
  const percent = affecting?.window.percent ?? 0;

  const title = isZen ? t("zenPaygTitle") : t("goPlanTitle");

  const headline = isLimited
    ? `${affecting?.label} quota limited`
    : `${percent}% of ${affecting?.label ?? "quota"} used`;

  // The trigger's hover label. Go's number IS a ring, so the headline explains
  // it; Zen's number is session spend, which asks a different question —
  // "is this metered?" — and gets the one honest answer we have.
  const tooltip = isZen ? t("zenPaygTooltip") : headline;

  let badgeText: string;
  if (isZen) {
    badgeText = t("zenPaygBadge");
  } else if (isLimited) {
    badgeText = t("usageLimited");
  } else {
    // Nothing. The header already reads `OpenCode Go`, so a `Go Plan` chip
    // beside it repeats the title and adds no fact — the same test every row in
    // this panel has to pass. The chip still appears for `Limited`, where it
    // says something the title does not.
    badgeText = "";
  }

  // The Zen card renders on a GO route with overflow only (`usage-panel.tsx`),
  // so these two have exactly the two states that card can be in: the plan is
  // limited and the overflow is live, or the plan is fine and the balance is
  // standing by. A Zen route never reaches them — there the badge already says
  // pay-as-you-go, and OpenCode has no balance endpoint to report.
  const zenCardCredit = isLimited ? "Active" : "Ready";

  return { badgeText, headline, title, tooltip, zenCardCredit };
};
