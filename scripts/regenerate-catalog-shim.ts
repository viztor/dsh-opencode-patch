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
 * or by hand to answer "is the shim stale?".
 *
 * `RETIRED_*_MODEL_IDS` is deliberately NOT regenerated: retirement is a judgement
 * about what OpenCode CLI still offers, not a fact models.dev carries.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";

import {
  OPENCODE_GO_CATALOG,
  OPENCODE_ZEN_CATALOG,
} from "../src/catalog-data.ts";
import {
  isRetiredModel,
  type CatalogModelSpec,
  MODELS_DEV_TIMEOUT_MS,
  MODELS_DEV_URL,
  parseModelsDevCatalog,
} from "../src/models-catalog.ts";

const TARGET = new URL("../src/catalog-data.ts", import.meta.url);
const argv = process.argv.slice(2);
const shouldWrite = argv.includes("--write");
const fromIndex = argv.indexOf("--from");
const fromPath = fromIndex === -1 ? undefined : argv[fromIndex + 1];

/** The payload, from a local file when given one — the offline path. */
const readPayload = async (): Promise<string> => {
  if (fromPath !== undefined) {
    return readFileSync(fromPath, "utf8");
  }
  const response = await fetch(MODELS_DEV_URL, {
    signal: AbortSignal.timeout(MODELS_DEV_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(
      `models.dev answered ${response.status} ${response.statusText}`
    );
  }
  return response.text();
};

/** Thousands separators, matching how the file already reads. */
const numeral = (value: number): string =>
  String(value).replaceAll(/\B(?=(\d{3})+(?!\d))/gu, "_");

/**
 * One catalog entry, keys sorted so a regeneration produces a minimal diff.
 *
 * Sorting is the whole reason this is a generator and not a hand-edit: the file
 * is formatted by `vp fmt`, which does not sort object keys, so a hand-added key
 * lands wherever it was typed and the next run moves it.
 */
const literal = (spec: CatalogModelSpec): string => {
  const lines = Object.keys(spec)
    .toSorted()
    .map((key) => {
      const value: unknown = (spec as unknown as Record<string, unknown>)[key];
      if (key === "cost" && value !== undefined && value !== null) {
        const rate = value as Record<string, number>;
        const inner = Object.keys(rate)
          .toSorted()
          .map((name) => `      ${name}: ${rate[name]}`)
          .join(",\n");
        return `cost: {\n${inner},\n    },`;
      }
      if (Array.isArray(value)) {
        return `${key}: [${value.map((v) => JSON.stringify(v)).join(", ")}],`;
      }
      if (typeof value === "number") {
        return `${key}: ${numeral(value)},`;
      }
      return `${key}: ${JSON.stringify(value)},`;
    });
  return `  {\n${lines.map((line) => `    ${line}`).join("\n")}\n  }`;
};

/** The array literal for one provider, ready to splice into the file. */
const render = (specs: readonly CatalogModelSpec[]): string =>
  `[\n${specs.map((spec) => `${literal(spec)},`).join("\n")}\n]`;

/** The models one provider contributes, retirement applied per provider. */
const forProvider = (
  parsed: ReturnType<typeof parseModelsDevCatalog>,
  provider: "go" | "zen"
): CatalogModelSpec[] =>
  parsed[provider].filter((spec) => !isRetiredModel(provider, spec.id));

/** Replace one exported array literal, by its `export const NAME` anchor. */
const splice = (source: string, name: string, body: string): string => {
  const anchor = `export const ${name}: readonly CatalogModelSpec[] = `;
  const start = source.indexOf(anchor);
  if (start === -1) {
    throw new Error(`could not find ${name} in ${basename(TARGET.pathname)}`);
  }
  const open = source.indexOf("[", start + anchor.length);
  const close = source.indexOf("\n];", open);
  if (open === -1 || close === -1) {
    throw new Error(`${name} is not an array literal`);
  }
  // `close` is the newline before `];`, so the literal ends two characters on.
  return `${source.slice(0, open)}${body}${source.slice(close + 2)}`;
};

const payload = await readPayload();
const parsed = parseModelsDevCatalog(JSON.parse(payload));
const go = forProvider(parsed, "go");
const zen = forProvider(parsed, "zen");

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
  `source: ${fromPath ?? MODELS_DEV_URL} (${payload.length} bytes${fromPath === undefined ? "" : ", local"})`
);
report("opencode-go", OPENCODE_GO_CATALOG, go);
report("opencode  ", OPENCODE_ZEN_CATALOG, zen);

/**
 * Canonical form for comparison: object keys sorted at every depth.
 *
 * Needed because the parser builds `cost` in its own insertion order while the
 * renderer emits sorted keys, so a plain `JSON.stringify` compares equal data as
 * different and reports the shim stale forever. Order is the renderer's business,
 * not the data's.
 */
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .toSorted()
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
};

const changed =
  canonical(go) !== canonical(OPENCODE_GO_CATALOG) ||
  canonical(zen) !== canonical(OPENCODE_ZEN_CATALOG);

if (!shouldWrite) {
  console.log(
    changed ? "\nshim is STALE — re-run with --write" : "\nshim is current"
  );
  process.exit(changed ? 1 : 0);
}

let source = readFileSync(TARGET, "utf8");
source = splice(source, "OPENCODE_GO_CATALOG", render(go));
source = splice(source, "OPENCODE_ZEN_CATALOG", render(zen));
writeFileSync(TARGET, source);
console.log(`\nwrote ${basename(TARGET.pathname)}`);
