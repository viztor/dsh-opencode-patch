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
 * proposes the refresh.
 *
 * **That URL moved, then came back as something else.** Measured 2026-10-12: it
 * answered 404, the docs live under `/v2/docs/console/go/` now, and the new page
 * serves HTML - the allowance figures are in a table on it, so nothing is lost.
 * From 2026-11-07 the old URL answered 200 again, with a body that had no tab
 * sections, and every nightly refresh failed in the parser because this reader
 * trusted the status. So the sources are asked in turn - the page the docs live
 * on, then the old URL - and each answer is read by what its body carries
 * (`docFrom`): the tabbed markdown as it is, the HTML page through `htmlToDoc`,
 * anything else not at all. When none carries the tables, the error names what
 * each one answered (`noDocMessage`), so the next layout change names itself.
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
 * node --experimental-strip-types scripts/generate-go-limits.ts --from <path>   # a saved page, markdown or HTML
 * ```
 *
 * Without `--write` it only reports what would change, so it is safe in CI.
 */

import { readFileSync, writeFileSync } from "node:fs";

import { OPENCODE_GO_CATALOG } from "../src/catalog-data.ts";
import {
  GO_LIMITS_DOC_TIMEOUT_MS,
  GO_LIMITS_DOC_URL,
  parseGoLimitsDoc,
} from "../src/go-limits.ts";
import {
  type DocAnswer,
  docFrom,
  GO_LIMITS_DOC_MOVED_TO,
  noDocMessage,
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

/**
 * The first source whose body carries the tables, asked one at a time.
 *
 * In turn, not all at once: a later source is asked only when every earlier one
 * carried neither shape, and the error then names what each one answered.
 *
 * @param sources - the sources, in the order to ask them.
 * @param read - how a source is asked.
 * @param answers - what the sources before this one answered.
 * @returns the parser's markdown.
 */
const firstDoc = async (
  sources: readonly string[],
  read: (source: string) => Promise<DocAnswer>,
  answers: readonly DocAnswer[] = []
): Promise<string> => {
  const [source, ...rest] = sources;
  if (source === undefined) {
    throw new Error(noDocMessage(answers));
  }
  const answer = await read(source);
  const doc = docFrom(answer);
  if (doc === undefined) {
    return firstDoc(rest, read, [...answers, answer]);
  }
  console.log(`source: ${source} (${answer.body.length} characters)`);
  return doc;
};

// A saved page when `--from` names one. Otherwise the page the docs live on
// first, and the old markdown URL second, in case it is ever the one that
// carries the tables again.
const readDoc = (): Promise<string> =>
  fromPath === undefined
    ? firstDoc([GO_LIMITS_DOC_MOVED_TO, GO_LIMITS_DOC_URL], ask)
    : firstDoc([fromPath], savedAnswer);

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
