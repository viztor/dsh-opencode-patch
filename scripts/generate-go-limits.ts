/**
 * Regenerate `src/go-limits-data.ts` from the gateway's models endpoint.
 *
 * The allowance a model gets per plan tier is data the vendor publishes, and a
 * hand-typed table would be stale within a release — a stale dollar figure is
 * worse than none, because it looks authoritative. This script is the effect
 * half: it fetches the payload, hands it to the pure reader
 * (`./go-limits-endpoint.ts`), logs what it read, and lets the shared generator
 * kit decide current/stale/write. The renderer is `./go-limits-render.ts`.
 *
 * ## Where the figures come from
 *
 * `GET https://opencode.ai/inference/go/v1/models` (`/zen/go/v1/models` answers
 * the same body) lists each Go model with `go.monthly_usage`:
 * `{"go": …, "go-plus": …, "go-teams": …}`, in whole US dollars. Until
 * 2026-11-18 the figures were read off the vendor's docs page; that page now
 * carries no allowance table at all, so the endpoint is the source. A model
 * without the field is a free model and is skipped, never priced as $0.
 *
 * ## Usage
 *
 * ```sh
 * node --experimental-strip-types scripts/generate-go-limits.ts            # fetch, then report
 * node --experimental-strip-types scripts/generate-go-limits.ts --write    # rewrite the file
 * node --experimental-strip-types scripts/generate-go-limits.ts --from <path>   # a saved JSON payload
 * ```
 *
 * Without `--write` it only reports what would change, so it is safe in CI.
 *
 * @module scripts/generate-go-limits
 */
import { readFileSync, writeFileSync } from "node:fs";

import { OPENCODE_GO_CATALOG } from "../src/catalog-data.ts";
import { GO_MODEL_LIMITS } from "../src/go-limits-data.ts";
import type { ModelAllowance } from "../src/go-limits.ts";
import { generatorArgs, outcome, stale } from "./generator-kit.ts";
import {
  GO_LIMITS_FETCH_TIMEOUT_MS,
  GO_LIMITS_MODELS_URL,
  readGoAllowances,
} from "./go-limits-endpoint.ts";
import { renderGoLimits } from "./go-limits-render.ts";

const TARGET = new URL("../src/go-limits-data.ts", import.meta.url);
const { from: fromPath, write } = generatorArgs(process.argv.slice(2));

/**
 * The payload to read: a saved one for `--from`, else the live endpoint.
 *
 * @returns the body text and the name to log it by.
 * @throws {Error} when the endpoint refuses the request: a source that does not answer
 * must fail the run rather than report the table current.
 */
const readPayload = async (): Promise<{ body: string; source: string }> => {
  if (fromPath !== undefined) {
    return { body: readFileSync(fromPath, "utf8"), source: fromPath };
  }
  const response = await fetch(GO_LIMITS_MODELS_URL, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(GO_LIMITS_FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(
      `go-limits: ${GO_LIMITS_MODELS_URL} answered ${response.status} ${response.statusText}`
    );
  }
  return { body: await response.text(), source: GO_LIMITS_MODELS_URL };
};

const { body, source } = await readPayload();
let parsed: unknown;
try {
  parsed = JSON.parse(body);
} catch {
  throw new Error(`go-limits: ${source} did not answer JSON`);
}
const { limits, skipped, unmapped } = readGoAllowances(parsed);
const rows: Record<string, ModelAllowance> = Object.fromEntries(limits);
console.log(
  `source: ${source} (${body.length} characters), ${limits.size} priced model(s), ${skipped.length} without a monthly allowance`
);
if (skipped.length > 0) {
  console.log(`free models (no allowance published): ${skipped.join(", ")}`);
}
/** Catalog ids, so a model the bundled catalog has not caught up with is logged. */
const catalogIds = new Set(OPENCODE_GO_CATALOG.map((model) => model.id));
const unknown = [...limits.keys()].filter((id) => !catalogIds.has(id));
if (unknown.length > 0) {
  // Kept under their own id: the gateway may serve a model the bundled catalog
  // has not caught up with yet, and a limit with no model is harmless.
  console.log(
    `not in the bundled catalog (kept under their own id): ${unknown.join(", ")}`
  );
}

const file = renderGoLimits(rows);

// The shipped table is imported, as `src/` imports it: a missing file breaks
// the build long before it breaks this, and the file is committed.
const onDisk = readFileSync(TARGET, "utf8");

// The one staleness rule the generators share: the table's DATA against what
// the source says, so a formatter's reflow or a reordered key is never drift,
// and a current table is left untouched by `--write`.
//
// With `--write`, a table whose data is current is still rewritten when its
// TEXT is not what the renderer makes of that data (`outcome`'s `rewrite`): a
// template change is applied by the generator, never by hand. That compares
// bytes safely only because the renderer's text is already what the formatter
// produces, which `test/generators.test.ts` holds by round-tripping the shipped
// table.
const decided = outcome({
  stale: stale(GO_MODEL_LIMITS, rows),
  textCurrent: onDisk === file,
  write,
});
if (decided.action === "rewrite") {
  writeFileSync(TARGET, file);
  console.log(
    `rewrote src/go-limits-data.ts: its data is current (${limits.size} models), its text was not the renderer's`
  );
} else if (decided.action === "current") {
  console.log(`go-limits-data.ts is up to date (${limits.size} models)`);
} else if (decided.action === "write") {
  writeFileSync(TARGET, file);
  console.log(`wrote ${limits.size} models to src/go-limits-data.ts`);
} else {
  console.error(
    "go-limits-data.ts is STALE — run: pnpm run limits:shim -- --write"
  );
}
process.exitCode = decided.exit;

if (unmapped.length > 0) {
  console.error(`unreadable entries: ${unmapped.join("; ")}`);
  process.exitCode = 1;
}
