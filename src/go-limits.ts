/**
 * The Go plan's per-model allowance, and the ONLY honest way to put a dollar
 * amount on the meter's percentages.
 *
 * ## Why this file exists, and why it is generated
 *
 * The meter shows `42%`. That is the one live number the gateway gives us, and
 * it is a **percentage of a monthly dollar allowance** — OpenCode's own docs say
 * so: *"Usage limits are defined as monthly dollar amounts… 5-hour — 20% of the
 * monthly limit; weekly — 50%; and monthly — 100%."* Without the allowance the
 * percentage means nothing in money, and a panel that shows `42%` when the user
 * asked "how much is left, in dollars" is dodging the question.
 *
 * The allowance is **per model** (`MiMo-V2.6-Flash` gets $60 on Go, `Grok 4.7`
 * gets $15) and **per tier** (Go Plus roughly doubles or triples it), so the
 * table is not a constant — it tracks the vendor's pricing page, which states
 * outright that *"usage limits may change as we learn from early usage and
 * feedback."* A hand-typed table would be wrong within a release, and a wrong
 * dollar figure is worse than none: it looks authoritative.
 *
 * So it is GENERATED from the gateway's own models endpoint
 * (`https://opencode.ai/inference/go/v1/models`, whose `go.monthly_usage`
 * carries each tier's figure; until 2026-11-18 the figures came from the
 * docs page's allowance table, which the page no longer carries) by
 * `scripts/generate-go-limits.ts`, and CI checks it for drift — the same
 * arrangement as `catalog-data.ts` / models.dev, for the same reason: a pull
 * request that changes the generator (or a module it loads) fails on a stale
 * table; any other pull request, and a push to main, warns, and the nightly
 * run proposes the refresh.
 *
 * ## What still cannot be shown, and why that is not an oversight
 *
 * The allowance above is a **total**, not a balance. `GET /zen/go/v1/usage` takes
 * **no model parameter** — the plugin calls it bare, `src/usage.ts` — so its
 * three percentages describe the ACCOUNT, not the model you are looking at. Every
 * sibling that might name the remaining balance returns 404 (`/limits`, `/plan`,
 * `/subscription`, `/account`, `/me`, `/credits`, `/balance`), and `/models`
 * carries only `id`/`object`/`created`.
 *
 * That is why `percent × allowance` is NOT computed anywhere in this plugin: with
 * an account-level percentage and a per-model allowance, the product is a number
 * with no referent. It would look like a balance and mean nothing. The panel
 * shows the live percentage next to the model's real monthly total, and the
 * remaining balance stays where it can be read exactly — the console.
 *
 * @module dsh-opencode-patch/go-limits
 */

/** One model's monthly allowance, in whole US dollars, per plan tier. */
export interface ModelAllowance {
  /** Go, the $10/month plan. */
  go: number;
  /** Go Plus, the $40/month plan. */
  goPlus: number;
  /** The model's display name, as the models endpoint spells it. */
  name: string;
}

/** Tier keys, shortest first, so the renderer can iterate them in a stable order. */
export type GoPlanTier = keyof Omit<ModelAllowance, "name">;

export const GO_PLAN_TIERS: readonly GoPlanTier[] = ["go", "goPlus"];

/**
 * Which share of the monthly allowance each window enforces.
 *
 * From the doc: 5-hour is 20%, weekly 50%, monthly 100% — so a window's ceiling
 * is the model's monthly total times this fraction.
 */
export const WINDOW_SHARE: Readonly<
  Record<"rolling" | "weekly" | "monthly", number>
> = {
  monthly: 1,
  rolling: 0.2,
  weekly: 0.5,
};

/** `mimo-v2.6-flash` → its allowance, or `undefined` when the doc does not list it. */
export const allowanceFor = (
  limits: ReadonlyMap<string, ModelAllowance>,
  model: string
): ModelAllowance | undefined => limits.get(model.trim().toLowerCase());
