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
 * proposes the refresh.
 *
 * ## Where the page is read from
 *
 * Two sources are asked, in turn (`GO_LIMITS_SOURCES`): the page the docs live
 * on, `https://opencode.ai/v2/docs/console/go/`, which serves HTML, and then
 * the old `https://opencode.ai/docs/go.md`. A later source is asked only when
 * the earlier ones carried nothing readable (`firstDoc`). A 2xx answer is read
 * by what its body carries; the status alone is never trusted (`docFrom`): the
 * tabbed markdown, with both plans' tabs, as it is; an HTML page with exactly
 * two allowance tables through `htmlToDoc`; anything else not at all. When no
 * source carries the tables, the error names what each one answered
 * (`noDocMessage`), so the next layout change names itself. All four live in
 * `scripts/go-limits-html.ts`, which `test/go-limits-html.test.ts` exercises
 * with a fake reader; this script only fetches and writes.
 *
 * **How it got here.** The table used to be generated from `go.md` alone, the
 * page's own markdown source, served as `text/plain`. Measured 2026-10-12, that
 * URL answered 404: the docs had moved under `/v2/docs/console/go/` and the new
 * page served HTML, with the allowance figures in one table per plan, so the
 * HTML path was added. From 2026-11-07 the old URL answered 200 again, with a
 * body that had no tab sections, and every nightly refresh failed in the parser
 * because the reader trusted the status. That is why a body is now read by its
 * shape, and why the page the docs live on is asked first.
 *
 * The page's allowance tables have six cells per row, `Model | Input | Output |
 * Cached Read | Cached Write | Monthly limit`, with the allowance in the LAST
 * cell; the request-estimate tables below them repeat the model names with no
 * dollar column, which is why a table is chosen by its header. Stripping tags
 * from `<tr>`/`<td>` is enough; no HTML parser is needed. Same arrangement, and
 * the same reasoning, as `regenerate-catalog-shim.ts` against models.dev.
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
import {
  GO_LIMITS_DOC_TIMEOUT_MS,
  parseGoLimitsDoc,
} from "../src/go-limits.ts";
import {
  type DocAnswer,
  firstDoc,
  type FoundDoc,
  GO_LIMITS_SOURCES,
} from "./go-limits-html.ts";

const TARGET = new URL("../src/go-limits-data.ts", import.meta.url);
const argv = process.argv.slice(2);
const shouldWrite = argv.includes("--write");
const fromIndex = argv.indexOf("--from");
const fromPath = fromIndex === -1 ? undefined : argv[fromIndex + 1];

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
console.log(`source: ${found.source} (${found.answer.body.length} characters)`);

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

/**
 * A model id as an object key, quoted only when it has to be.
 *
 * `vp fmt` strips the quotes from any key that is a valid identifier, so a
 * uniformly-quoted generator produces a file that differs from its own
 * output by whitespace alone — and a staleness check that compares bytes
 * then reports drift that is not there.
 */
const jsKey = (id: string): string =>
  /^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(id) ? id : JSON.stringify(id);

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

/**
 * A number as TypeScript source.
 *
 * A model the vendor's page does not list has no published allowance, which the
 * table records as `NaN`. The bare `NaN` identifier is a lint error, so the
 * literal is written as `Number.NaN`; it stays `NaN` at runtime, which is the
 * point - a model with no figure must not read as `$0`.
 *
 * @param value - the allowance.
 * @returns the literal to emit.
 */
const numberLiteral = (value: number): string =>
  Number.isNaN(value) ? "Number.NaN" : String(value);

const body = [...resolved.keys()]
  .toSorted()
  .map((id) => {
    const row = resolved.get(id) as {
      go: number;
      goPlus: number;
      name: string;
    };
    // One field per line, which is what `vp fmt` produces for an object
    // this size. A compact single line reads better until the formatter
    // reflows it — and then the file no longer matches what this script
    // emits, so the next run reports STALE for a difference that is only
    // whitespace.
    return [
      `  ${jsKey(id)}: {`,
      `    go: ${numberLiteral(row.go)},`,
      `    goPlus: ${numberLiteral(row.goPlus)},`,
      `    name: ${JSON.stringify(row.name)},`,
      "  },",
    ].join("\n");
  })
  .join("\n");

const file = `/**
 * GENERATED by \`scripts/generate-go-limits.ts\` — do not edit by hand.
 *
 * The Go plan's monthly allowance per model, in whole US dollars, for both tiers:
 * \`go\` is the $10/month plan, \`goPlus\` the $40/month one. Source of truth is
 * OpenCode's own Go documentation; \`pnpm run limits:shim\` reports staleness and
 * \`--write\` rewrites this file.
 *
 * ${resolved.size} models.
 */

import type { ModelAllowance } from "./go-limits.ts";

export const GO_MODEL_LIMITS: Readonly<Record<string, ModelAllowance>> = {
${body}
};
`;

/** The file as it stands, or `""` when it does not exist yet. */
const readCurrent = (): string => {
  try {
    return readFileSync(TARGET, "utf8");
  } catch {
    return "";
  }
};

const current = readCurrent();
if (current === file) {
  console.log(`go-limits-data.ts is up to date (${resolved.size} models)`);
} else if (shouldWrite) {
  writeFileSync(TARGET, file);
  console.log(`wrote ${resolved.size} models to src/go-limits-data.ts`);
} else {
  console.error(
    "go-limits-data.ts is STALE — run: pnpm run limits:shim -- --write"
  );
  process.exitCode = 1;
}

if (unmatched.length > 0) {
  console.log(
    `not in the bundled catalog (kept under their own id): ${unmatched.join(", ")}`
  );
}
if (unmapped.length > 0) {
  console.error(`unreadable doc rows: ${unmapped.join("; ")}`);
  process.exitCode = 1;
}
