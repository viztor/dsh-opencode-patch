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
 * So it is GENERATED from the vendor's own machine-readable doc
 * (`https://opencode.ai/docs/go.md`, which is the page's markdown source, not a
 * scrape of rendered HTML) by `scripts/generate-go-limits.ts`, and CI fails when
 * it drifts — the same arrangement as `catalog-data.ts` / models.dev, for the
 * same reason.
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
  /** The vendor's display name, as the doc table spells it. */
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

/** A dollar figure with no cents when it is whole — `$60`, not `$60.00`. */
export const formatUsd = (value: number): string =>
  Number.isInteger(value) ? `$${value}` : `$${value.toFixed(2)}`;

/**
 * Normalize a doc-table row label to a model id.
 *
 * The doc distinguishes variants in the label — `DeepSeek V4.1 Flash (Off-Peak)`,
 * `GPT 5.6 Luna (> 272K tokens)` — and those variants share their base model's
 * allowance. Parentheticals and `Preview`/spacing noise come off; what is left is
 * slugified and matched against the catalog's own ids.
 *
 * Returning `undefined` means "row I could not map", and the generator reports
 * those rather than dropping them: an unmapped row is either a new model (the
 * table is stale) or a parsing bug, and both need a human.
 */
export const normalizeModelLabel = (label: string): string | undefined => {
  const base = label
    .replace(/\s*\([^)]*\)\s*$/u, "")
    .replaceAll(/\s+/gu, " ")
    .trim();
  if (base.length === 0) {
    return undefined;
  }
  return base
    .toLowerCase()
    .replaceAll(/[‐-―]/gu, "-")
    .replaceAll(/[^a-z0-9.]+/gu, "-")
    .replaceAll(/^-+|-+$/gu, "");
};

/** The doc URL — the page's own markdown, served as `text/plain`. */
export const GO_LIMITS_DOC_URL = "https://opencode.ai/docs/go.md";
export const GO_LIMITS_DOC_TIMEOUT_MS = 20_000;

/**
 * Parse both tier tables out of `go.md`.
 *
 * Deliberately narrow: it looks for the two `<TabItem label="Go">` /
 * `label="Go Plus">` table headers and reads the LAST column of each body row.
 * Anything it cannot read it reports in `unmapped` instead of guessing, so the
 * generator fails loudly on a layout change rather than shipping a table with
 * holes in it.
 */
export const parseGoLimitsDoc = (
  markdown: string
): { limits: Map<string, ModelAllowance>; unmapped: string[] } => {
  const limits = new Map<string, ModelAllowance>();
  const unmapped: string[] = [];
  const tiers: [GoPlanTier, string][] = [
    ["go", '<TabItem label="Go">'],
    ["goPlus", '<TabItem label="Go Plus">'],
  ];

  for (const [tier, tab] of tiers) {
    const start = markdown.indexOf(tab);
    if (start === -1) {
      throw new Error(`go-limits: no ${tab} section in the doc`);
    }
    // Stop at the tab's closing tag: the request-estimates table below repeats
    // model names with no dollar column at all, and reading past it would
    // invent allowances out of request counts.
    const close = markdown.indexOf("</TabItem>", start);
    const body = markdown.slice(start, close === -1 ? undefined : close);

    let matched = 0;
    for (const line of body.split("\n")) {
      if (!line.trimStart().startsWith("|")) {
        continue;
      }
      // Cells are split, not regexed: the last one is `**$60**`, bold in the
      // source, and the separator row is dashes.
      const cells = line
        .split("|")
        .slice(1, -1)
        .map((cell) => cell.trim());
      if (cells.length < 6) {
        continue;
      }
      const label = cells[0] ?? "";
      const dollars = /^\**\$(\d[\d,]*)\**$/u.exec(cells.at(-1) ?? "");
      if (dollars === null) {
        // `Unlimited limited time` and the header/separator rows land here. A
        // model with no allowance is not an error; a NAMED row we failed to read
        // is, and it is reported rather than skipped.
        if (label.length > 0 && !/^-+$/u.test(label)) {
          const last = (cells.at(-1) ?? "").toLowerCase();
          if (!last.includes("unlimited") && !last.includes("monthly limit")) {
            unmapped.push(`${tier}: ${label} → ${cells.at(-1) ?? ""}`);
          }
        }
        continue;
      }
      const id = normalizeModelLabel(label);
      if (id === undefined || id.length === 0) {
        unmapped.push(`${tier}: ${label}`);
        continue;
      }
      const amount = Number((dollars[1] ?? "0").replaceAll(",", ""));
      const entry = limits.get(id);
      if (entry === undefined) {
        limits.set(id, { go: 0, goPlus: 0, name: label });
      } else {
        // Variant rows (peak/off-peak, >N tokens) share the base model's name.
        const held = limits.get(id) as ModelAllowance;
        if (held.name === id) {
          held.name = label;
        }
      }
      (limits.get(id) as ModelAllowance)[tier] = amount;
      matched += 1;
    }
    if (matched === 0) {
      throw new Error(`go-limits: the ${tier} table parsed to zero rows`);
    }
  }

  return { limits, unmapped };
};
