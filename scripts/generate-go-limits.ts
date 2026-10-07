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
 * source, served as `text/plain`) and CI fails when it drifts. Same arrangement,
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
import {
  GO_LIMITS_DOC_TIMEOUT_MS,
  GO_LIMITS_DOC_URL,
  parseGoLimitsDoc,
} from "../src/go-limits.ts";

const TARGET = new URL("../src/go-limits-data.ts", import.meta.url);
const argv = process.argv.slice(2);
const shouldWrite = argv.includes("--write");
const fromIndex = argv.indexOf("--from");
const fromPath = fromIndex === -1 ? undefined : argv[fromIndex + 1];

const readDoc = async (): Promise<string> => {
  if (fromPath !== undefined) {
    return readFileSync(fromPath, "utf8");
  }
  const response = await fetch(GO_LIMITS_DOC_URL, {
    signal: AbortSignal.timeout(GO_LIMITS_DOC_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`go.md answered ${response.status} ${response.statusText}`);
  }
  return response.text();
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
      `    go: ${row.go},`,
      `    goPlus: ${row.goPlus},`,
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
