/**
 * Regenerate `src/catalog-data.ts` from models.dev: its two catalogs, the
 * plane and family endpoints, and the ids each plane has retired.
 *
 * The shim is the catalog DSH sees **before the first successful refresh** — and
 * if a refresh never succeeds. That makes it load-bearing in a way a normal
 * fallback is not, and it drifted once already: `provider_npm` was added to the
 * parser and to exactly one shim entry by hand, so nine models were routed to the
 * wrong endpoint on every cold start and nothing said so.
 *
 * So the shim is GENERATED, from the plugin's own parser, and this is how it is
 * regenerated. Using `parseModelsDevCatalog` rather than a re-implementation is
 * the point: the shim cannot disagree with what a live refresh produces, because
 * it is produced by the same function.
 *
 * ```sh
 * node --experimental-strip-types scripts/regenerate-catalog-shim.ts            # fetch, then report
 * node --experimental-strip-types scripts/regenerate-catalog-shim.ts --write    # rewrite the file
 * node --experimental-strip-types scripts/regenerate-catalog-shim.ts --from <path>
 * ```
 *
 * Without `--write` it only reports what would change, so it is safe to run in CI
 * or by hand to answer "is the shim stale?". Stale is decided by the one rule
 * the generators share (`generator-kit.ts`) over everything the file exports,
 * read through one function (`shippedShim`): both catalogs, the plane
 * endpoints, the family endpoints and the retired ids (`catalog-shim.ts`, the
 * pure half). With `--write`, a current shim is left untouched, and a shim
 * that predates the retired ids gains their export (`rewriteShim`).
 */

import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";

import * as shipped from "../src/catalog-data.ts";
import {
  type CatalogModelSpec,
  MODELS_DEV_TIMEOUT_MS,
  MODELS_OPENCODE_URL,
  parseModelsDevCatalog,
} from "../src/models-catalog.ts";
import {
  rewriteShim,
  shimData,
  shimStale,
  shippedShim,
} from "./catalog-shim.ts";
import { generatorArgs, outcome, readSource } from "./generator-kit.ts";

const TARGET = new URL("../src/catalog-data.ts", import.meta.url);
const { from: fromPath, write } = generatorArgs(process.argv.slice(2));

const payload = await readSource({
  from: fromPath,
  timeoutMs: MODELS_DEV_TIMEOUT_MS,
  url: MODELS_OPENCODE_URL,
});
const next = shimData(parseModelsDevCatalog(JSON.parse(payload)));
const current = shippedShim(shipped);

/** What the shim holds now against what it would hold, for the report. */
const report = (
  label: string,
  before: readonly string[],
  after: readonly string[]
) => {
  const had = new Set(before);
  const has = new Set(after);
  const added = [...has].filter((id) => !had.has(id));
  const removed = [...had].filter((id) => !has.has(id));
  console.log(`${label}: ${before.length} -> ${after.length}`);
  if (added.length > 0) {
    console.log(`  + ${added.length}: ${added.join(", ")}`);
  }
  if (removed.length > 0) {
    console.log(`  - ${removed.length}: ${removed.join(", ")}`);
  }
};

console.log(
  `source: ${fromPath ?? MODELS_OPENCODE_URL} (${payload.length} bytes${fromPath === undefined ? "" : ", local"})`
);
const ids = (specs: readonly CatalogModelSpec[]): string[] =>
  specs.map((spec) => spec.id);
report("opencode-go", ids(current.go), ids(next.go));
report("opencode  ", ids(current.zen), ids(next.zen));
report("retired opencode-go", current.deprecated.go, next.deprecated.go);
report("retired opencode  ", current.deprecated.zen, next.deprecated.zen);

const decided = outcome({ stale: shimStale(current, next), write });

if (decided.action === "write") {
  writeFileSync(TARGET, rewriteShim(readFileSync(TARGET, "utf8"), next));
  console.log(`\nwrote ${basename(TARGET.pathname)}`);
} else {
  console.log(
    decided.action === "report-stale"
      ? "\nshim is STALE — re-run with --write"
      : "\nshim is current"
  );
}
process.exitCode = decided.exit;
