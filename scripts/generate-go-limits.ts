/**
 * Generate `src/go-limits-data.ts` from OpenCode's own Go documentation.
 *
 * ## Why a generated table
 *
 * The meter shows percentages, and a percentage is meaningless in money until
 * you know what it is a percentage **of**. OpenCode's docs answer that: *"Usage
 * limits are defined as monthly dollar amounts… 5-hour — 20% of the monthly
 * limit; weekly — 50%; and monthly — 100%."* But the amounts are **per model**
 * and **per tier** (`MiMo-V2.6-Flash` gets $60 on Go and $120 on Go Plus;
 * `Grok 4.7` gets $15 and $60), and the vendor states plainly that *"usage limits
 * may change as we learn from early usage and feedback."*
 *
 * A hand-typed table would therefore be stale within a release — and a stale
 * dollar figure is worse than none, because it looks authoritative. So the table
 * is generated from `https://opencode.ai/docs/go.md` (the page's own markdown
 * source, served as `text/plain`), and CI checks it for drift: a pull request
 * that changes this generator (or a module it loads) fails on a stale table;
 * any other pull request, and a push to main, warns, and the nightly run
 * proposes the refresh. "Stale" is the rule the generators share
 * (`generator-kit.ts`): the shipped `GO_MODEL_LIMITS` and the page's figures
 * differ in data, never in bytes.
 *
 * **That URL is gone.** Measured 2026-10-12: it answers 404, the docs live under
 * `/v2/docs/console/go/` now, and the new page serves HTML - the allowance figures
 * are in a table on it, so nothing is lost, but this reader parses markdown and
 * needs an HTML path before the check can say anything again. The failure names
 * the new URL so the next person does not have to find it twice.
 *
 * **What the new page looks like, measured, so the HTML path is a small job.**
 * `/v2/llms.txt` indexes it and there is no `.md` beside it. The page carries a
 * plan table (`Plan | Price | Included usage`) and a per-model one whose columns
 * are `Model | input | output | cached | - | allowance`, where the allowance is
 * the LAST cell and a plan with no figure carries `-`:
 *
 *     GLM-5.3-Flash | $0.15 | $0.50 | $0.03 | - | $60
 *     GLM-5.3       | $1.40 | $4.40 | $0.26 | - | $15
 *
 * Stripping tags from `<tr>`/`<td>` is enough; no parser is needed. The shapes
 * differ from this table's, though: the doc states an allowance per MODEL, while
 * `go-limits-data.ts` carries `go`/`goPlus` per plan - so the HTML path has to
 * decide which of the two the shipped table means before it can compare. Same arrangement,
 * and the same reasoning, as `regenerate-catalog-shim.ts` against models.dev.
 *
 * ## Why this script resolves ids against the catalog
 *
 * The doc labels models the way a pricing page does (`Claude Haiku 5.5`) while
 * the catalog spells the same model the way the gateway does
 * (`claude-haiku-5-5`). Slugging the label alone gets `mimo-v2.6-flash` right and
 * `claude-haiku-5.5` wrong, so every id is resolved against the shipped catalog
 * first — exact, then with dots folded to hyphens — and only a label that still
 * matches nothing is kept under its own slug. Those are reported: a doc row with
 * no catalog counterpart is either a new model (the catalog is behind) or a slug
 * rule that needs another step, and both want a human.
 *
 * ```sh
 * node --experimental-strip-types scripts/generate-go-limits.ts            # fetch, then report
 * node --experimental-strip-types scripts/generate-go-limits.ts --write    # rewrite the file
 * node --experimental-strip-types scripts/generate-go-limits.ts --from <path>
 * ```
 *
 * Without `--write` it only reports what would change, so it is safe in CI.
 */

import { readFileSync, writeFileSync } from "node:fs";

import { OPENCODE_GO_CATALOG } from "../src/catalog-data.ts";
import { GO_MODEL_LIMITS } from "../src/go-limits-data.ts";
import {
  GO_LIMITS_DOC_TIMEOUT_MS,
  GO_LIMITS_DOC_URL,
  parseGoLimitsDoc,
} from "../src/go-limits.ts";
import { generatorArgs, outcome, readSource, stale } from "./generator-kit.ts";
import { GO_LIMITS_DOC_MOVED_TO, htmlToDoc } from "./go-limits-html.ts";
import { renderGoLimits } from "./go-limits-render.ts";

const TARGET = new URL("../src/go-limits-data.ts", import.meta.url);
const { from: fromPath, write } = generatorArgs(process.argv.slice(2));

const causeOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * The markdown URL is gone; measured 2026-10-12, the docs moved under
 * `/v2/docs/console/` and the new page serves HTML. Read the page instead of
 * failing: the figures are the same figures, in a table.
 */
const readMovedDoc = async (primary: string): Promise<string> => {
  try {
    return htmlToDoc(
      await readSource({
        timeoutMs: GO_LIMITS_DOC_TIMEOUT_MS,
        url: GO_LIMITS_DOC_MOVED_TO,
      })
    );
  } catch (error) {
    throw new Error(
      `go.md: ${primary}; the moved page ${GO_LIMITS_DOC_MOVED_TO}: ${causeOf(error)}`,
      { cause: error }
    );
  }
};

const readDoc = async (): Promise<string> => {
  if (fromPath !== undefined) {
    return readSource({
      from: fromPath,
      timeoutMs: GO_LIMITS_DOC_TIMEOUT_MS,
      url: GO_LIMITS_DOC_URL,
    });
  }
  try {
    return await readSource({
      timeoutMs: GO_LIMITS_DOC_TIMEOUT_MS,
      url: GO_LIMITS_DOC_URL,
    });
  } catch (error) {
    return readMovedDoc(causeOf(error));
  }
};

/** Catalog ids, so a doc label can be resolved to the id the gateway uses. */
const catalogIds = new Set(OPENCODE_GO_CATALOG.map((model) => model.id));

/**
 * A doc label's slug → the catalog id, when there is one.
 *
 * Two steps and no more: the slug as parsed, then with `.` folded to `-`. A third
 * "fuzzy" step would be where a wrong-but-plausible id sneaks in, and a limit
 * attached to the wrong model is exactly the failure this table must not have.
 */
const resolveId = (slug: string): string | undefined => {
  if (catalogIds.has(slug)) {
    return slug;
  }
  const folded = slug.replaceAll(".", "-");
  return catalogIds.has(folded) ? folded : undefined;
};

const doc = await readDoc();
const { limits, unmapped } = parseGoLimitsDoc(doc);

const resolved = new Map<
  string,
  { go: number; goPlus: number; name: string }
>();
const unmatched: string[] = [];
for (const [slug, allowance] of limits) {
  const id = resolveId(slug);
  if (id === undefined) {
    // Kept under its own slug: the gateway may serve a model the bundled catalog
    // has not caught up with yet, and a limit with no model is harmless.
    unmatched.push(slug);
    resolved.set(slug, allowance);
    continue;
  }
  const held = resolved.get(id);
  // Two doc labels folding onto one id means the slug rule collapsed something
  // real; first writer wins and the collision is reported rather than guessed at.
  if (held === undefined) {
    resolved.set(id, allowance);
  } else if (held.go !== allowance.go || held.goPlus !== allowance.goPlus) {
    unmatched.push(`${slug} collides with ${id}`);
  }
}

const rows = Object.fromEntries(resolved);
const file = renderGoLimits(rows);

// The shipped table is imported, as `src/` imports it: a missing file breaks
// the build long before it breaks this, and the file is committed.
const onDisk = readFileSync(TARGET, "utf8");

// The one staleness rule the generators share: the table's DATA against what
// the page says, so a formatter's reflow or a reordered key is never drift,
// and a current table is left untouched by `--write`.
//
// With `--write`, a table whose data is current is still rewritten when its
// TEXT is not what the renderer makes of that data (`outcome`'s `rewrite`): a
// template change is applied by the generator, never by hand. That compares
// bytes safely only because the renderer's text is already what the
// formatter produces, which `test/generators.test.ts` holds by
// round-tripping the shipped table.
const decided = outcome({
  stale: stale(GO_MODEL_LIMITS, rows),
  textCurrent: onDisk === file,
  write,
});
if (decided.action === "rewrite") {
  writeFileSync(TARGET, file);
  console.log(
    `rewrote src/go-limits-data.ts: its data is current (${resolved.size} models), its text was not the renderer's`
  );
} else if (decided.action === "current") {
  console.log(`go-limits-data.ts is up to date (${resolved.size} models)`);
} else if (decided.action === "write") {
  writeFileSync(TARGET, file);
  console.log(`wrote ${resolved.size} models to src/go-limits-data.ts`);
} else {
  console.error(
    "go-limits-data.ts is STALE — run: pnpm run limits:shim -- --write"
  );
}
process.exitCode = decided.exit;

if (unmatched.length > 0) {
  console.log(
    `not in the bundled catalog (kept under their own id): ${unmatched.join(", ")}`
  );
}
if (unmapped.length > 0) {
  console.error(`unreadable doc rows: ${unmapped.join("; ")}`);
  process.exitCode = 1;
}
