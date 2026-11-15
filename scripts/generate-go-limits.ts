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
 * is generated from the vendor's own page, and CI checks it for drift: a pull
 * request that changes this generator (or a module it loads) fails on a stale
 * table; any other pull request, and a push to main, warns, and the nightly run
 * proposes the refresh. "Stale" is the rule the generators share
 * (`generator-kit.ts`): the shipped `GO_MODEL_LIMITS` and the page's figures
 * differ in data, never in bytes.
 *
 * ## Where the page is read from
 *
 * Two sources are asked, in turn (`GO_LIMITS_SOURCES`): the page the docs live
 * on, `https://opencode.ai/docs/console/go/`, which serves HTML, and then the
 * old `https://opencode.ai/docs/go.md` (measured 2026-11-12, both it and
 * `/v2/docs/console/go/` redirect to the first). A later source is asked only
 * when the earlier ones carried nothing readable (`firstDoc`). A 2xx answer is
 * read by what its body carries; the status alone is never trusted
 * (`docFrom`): the tabbed markdown, with both plans' tabs, as it is; an HTML
 * page's allowance tables, chosen by the plan label the page attaches to each
 * (`chooseTables`: the table labelled "Go" and the one labelled "Go Plus",
 * from the tab its panel names or the heading before it; two tables with no
 * label keep the measured order, Go first; anything else is refused); and
 * either only when `parseGoLimitsDoc` reads it without an error, so anything
 * else is not read at all and the next source is asked. The Starlight tab
 * markup that labelling reads is assumed, not measured, so the `source:` line
 * names which table was read as each plan and which were ignored, and when no
 * source carries the tables the error names every table each answer carried,
 * with its label, its rows and its first row, and why none was read
 * (`noDocMessage`), so the next layout change names itself. All of it lives
 * in `scripts/go-limits-html.ts`, which `test/go-limits-html.test.ts`
 * exercises with a fake reader; this script only fetches, logs and writes.
 *
 * **How it got here.** The table used to be generated from `go.md` alone, the
 * page's own markdown source, served as `text/plain`. Measured 2026-10-12, that
 * URL answered 404: the docs had moved under `/v2/docs/console/go/` and the new
 * page served HTML, with the allowance figures in one table per plan, so the
 * HTML path was added. From 2026-11-07 the old URL answered 200 again, with a
 * body that had no tab sections, and every nightly refresh failed in the parser
 * because the reader trusted the status. That is why a body is now read by its
 * shape, and why the page the docs live on is asked first. On 2026-11-12 the
 * page carried three allowance tables where it had carried two, and a choice
 * by position or by count could not say which two were Go and Go Plus; that is
 * why a table is chosen by its plan label.
 *
 * The page's allowance tables have six cells per row, `Model | Input | Output |
 * Cached Read | Cached Write | Monthly limit`, with the allowance in the LAST
 * cell; the request-estimate tables below them repeat the model names with no
 * dollar column, which is why a table is chosen by its header. Stripping tags
 * from `<tr>`/`<td>`, and scanning tags for the panel and heading around a
 * table, is enough; no HTML parser is needed. Same arrangement, and
 * the same reasoning, as `regenerate-catalog-shim.ts` against models.dev. The
 * file is rendered by `go-limits-render.ts`.
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
 * node --experimental-strip-types scripts/generate-go-limits.ts --from <path>   # a saved page, markdown or HTML
 * ```
 *
 * Without `--write` it only reports what would change, so it is safe in CI.
 */

import { readFileSync, writeFileSync } from "node:fs";

import { OPENCODE_GO_CATALOG } from "../src/catalog-data.ts";
import { GO_MODEL_LIMITS } from "../src/go-limits-data.ts";
import {
  GO_LIMITS_DOC_TIMEOUT_MS,
  parseGoLimitsDoc,
} from "../src/go-limits.ts";
import { generatorArgs, outcome, stale } from "./generator-kit.ts";
import {
  type DocAnswer,
  firstDoc,
  type FoundDoc,
  GO_LIMITS_SOURCES,
} from "./go-limits-html.ts";
import { renderGoLimits } from "./go-limits-render.ts";

const TARGET = new URL("../src/go-limits-data.ts", import.meta.url);
const { from: fromPath, write } = generatorArgs(process.argv.slice(2));

/**
 * Ask one source and record what it answered.
 *
 * @param url - the source.
 * @returns the answer; the body is read only for a 2xx.
 */
const ask = async (url: string): Promise<DocAnswer> => {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(GO_LIMITS_DOC_TIMEOUT_MS),
  });
  return {
    body: response.ok ? await response.text() : "",
    contentType: response.headers.get("content-type") ?? "",
    finalUrl: response.url || url,
    status: response.status,
    url,
  };
};

/**
 * A saved page, as `--from` names it: read as a 200 with no content type.
 *
 * @param path - the saved file, markdown or HTML.
 * @returns the answer.
 */
const savedAnswer = async (path: string): Promise<DocAnswer> => ({
  body: readFileSync(path, "utf8"),
  contentType: "",
  finalUrl: path,
  status: 200,
  url: path,
});

// A saved page when `--from` names one; otherwise the sources, in their order.
const found: FoundDoc =
  fromPath === undefined
    ? await firstDoc(GO_LIMITS_SOURCES, ask)
    : await firstDoc([fromPath], savedAnswer);
// What the page carried and which table was read as each plan: the tab markup
// is assumed, not measured, so the live run's log is where it gets measured.
const redirected =
  found.answer.finalUrl === found.source
    ? ""
    : ` (redirected to ${found.answer.finalUrl})`;
console.log(
  `source: ${found.source}${redirected} (${found.answer.body.length} characters), ${found.read}`
);

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

const { limits, unmapped } = parseGoLimitsDoc(found.doc);

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
