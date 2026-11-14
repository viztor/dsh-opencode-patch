/**
 * Regenerate `src/catalog-data.ts`'s two catalogs from models.dev.
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
 * the generators share (`generator-kit.ts`) over everything the file exports:
 * both catalogs, the plane endpoints and the family endpoints
 * (`catalog-shim.ts`, the pure half). With `--write`, a current shim is left
 * untouched.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";

import {
  OPENCODE_FAMILY_API,
  OPENCODE_GO_CATALOG,
  OPENCODE_PLANE_API,
  OPENCODE_ZEN_CATALOG,
} from "../src/catalog-data.ts";
import {
  type CatalogModelSpec,
  MODELS_DEV_TIMEOUT_MS,
  MODELS_OPENCODE_URL,
  parseModelsDevCatalog,
} from "../src/models-catalog.ts";
import {
  render,
  renderFamilyApi,
  renderPlaneApi,
  shimData,
  shimStale,
  splice,
  spliceObject,
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

/** What the shim holds now, for the report. */
const report = (
  label: string,
  before: readonly CatalogModelSpec[],
  after: readonly CatalogModelSpec[]
) => {
  const ids = (specs: readonly CatalogModelSpec[]) =>
    new Set(specs.map((s) => s.id));
  const had = ids(before);
  const has = ids(after);
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
report("opencode-go", OPENCODE_GO_CATALOG, next.go);
report("opencode  ", OPENCODE_ZEN_CATALOG, next.zen);

const decided = outcome({
  stale: shimStale(
    {
      familyApi: OPENCODE_FAMILY_API,
      go: OPENCODE_GO_CATALOG,
      planeApi: OPENCODE_PLANE_API,
      zen: OPENCODE_ZEN_CATALOG,
    },
    next
  ),
  write,
});

if (decided.action === "write") {
  let source = readFileSync(TARGET, "utf8");
  source = splice(source, "OPENCODE_GO_CATALOG", render(next.go));
  source = splice(source, "OPENCODE_ZEN_CATALOG", render(next.zen));
  source = spliceObject(
    source,
    "OPENCODE_PLANE_API",
    renderPlaneApi(next.planeApi)
  );
  source = spliceObject(
    source,
    "OPENCODE_FAMILY_API",
    renderFamilyApi(next.familyApi)
  );
  writeFileSync(TARGET, source);
  console.log(`\nwrote ${basename(TARGET.pathname)}`);
} else {
  console.log(
    decided.action === "report-stale"
      ? "\nshim is STALE — re-run with --write"
      : "\nshim is current"
  );
}
process.exitCode = decided.exit;
