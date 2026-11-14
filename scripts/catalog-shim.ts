/**
 * The pure half of `regenerate-catalog-shim.ts`: what a parsed models.dev
 * payload makes of `src/catalog-data.ts`, rendered as the file writes it, and
 * whether the shipped shim is stale against it.
 *
 * Every export the generator writes counts: the two catalogs, the plane
 * endpoints (`OPENCODE_PLANE_API`) and the family endpoints
 * (`OPENCODE_FAMILY_API`). The generator used to compare only the catalogs,
 * so a vendor that moved an endpoint left the shim reporting "current" while
 * the mount read the old address. `verify-catalog.ts` asks the same question
 * through `shimStale`, so the two can never disagree about it.
 *
 * @module scripts/catalog-shim
 */
import type { CatalogModelSpec } from "../src/catalog-data.ts";
import { stale } from "./generator-kit.ts";

/** One plane's endpoint per SDK package (`""` is the provider's default). */
type FamilyApi = Readonly<Record<string, string>>;

/** The four values the shim carries, in the shape `shimStale` compares. */
export interface ShimData {
  readonly familyApi: Readonly<Record<"go" | "zen", FamilyApi>>;
  readonly go: readonly CatalogModelSpec[];
  readonly planeApi: Readonly<Record<"go" | "zen", string>>;
  readonly zen: readonly CatalogModelSpec[];
}

/** What `parseModelsDevCatalog` answers, read-only. */
export interface ParsedShim {
  readonly api: Readonly<Record<"go" | "zen", string>>;
  readonly familyApi: Readonly<Record<"go" | "zen", FamilyApi>>;
  readonly go: readonly CatalogModelSpec[];
  readonly zen: readonly CatalogModelSpec[];
}

/** The file the shim lives in, for the messages. */
const TARGET = "catalog-data.ts";

/** Rows sorted deterministically by id, which is how the shim lists them. */
const byId = (specs: readonly CatalogModelSpec[]): CatalogModelSpec[] =>
  specs.toSorted((a, b) => a.id.localeCompare(b.id));

/**
 * What a parsed payload makes of the shim.
 *
 * @param parsed - `parseModelsDevCatalog`'s answer.
 * @returns the four values, each catalog sorted by id.
 */
export const shimData = (parsed: ParsedShim): ShimData => ({
  familyApi: parsed.familyApi,
  go: byId(parsed.go),
  planeApi: parsed.api,
  zen: byId(parsed.zen),
});

/**
 * Whether the shipped shim is stale against `next`: the one rule
 * (`generator-kit.ts`'s `stale`) over all four values. Row order is the
 * renderer's, so both sides are sorted by id first.
 *
 * @param shipped - what `src/catalog-data.ts` exports.
 * @param next - what the source makes of it today (`shimData`).
 * @returns whether any of the four differs in data.
 */
export const shimStale = (shipped: ShimData, next: ShimData): boolean =>
  stale(
    { ...shipped, go: byId(shipped.go), zen: byId(shipped.zen) },
    { ...next, go: byId(next.go), zen: byId(next.zen) }
  );

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
export const literal = (spec: CatalogModelSpec): string => {
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
export const render = (specs: readonly CatalogModelSpec[]): string =>
  `[\n${specs.map((spec) => `${literal(spec)},`).join("\n")}\n]`;

/**
 * Replace one exported object literal, by its `export const NAME` anchor.
 *
 * `splice` is array-shaped: it looks for `[` and ends at `];`. The plane export
 * is an object, so it needs its own opener and terminator - and using the array
 * one on it would have thrown rather than half-written the file.
 */
export const spliceObject = (
  source: string,
  name: string,
  body: string,
  target = TARGET
): string => {
  const anchorName = `export const ${name}: `;
  const start = source.indexOf(anchorName);
  if (start === -1) {
    throw new Error(`could not find ${name} in ${target}`);
  }
  const open = source.indexOf("{", start + anchorName.length);
  const close = source.indexOf("\n};", open);
  if (open === -1 || close === -1) {
    throw new Error(`${name} is not an object literal`);
  }
  // `close` is the newline before `};`, so the literal ends two characters on.
  return `${source.slice(0, open)}${body}${source.slice(close + 2)}`;
};

/** Replace one exported array literal, by its `export const NAME` anchor. */
export const splice = (
  source: string,
  name: string,
  body: string,
  target = TARGET
): string => {
  const anchor = `export const ${name}: readonly CatalogModelSpec[] = `;
  const start = source.indexOf(anchor);
  if (start === -1) {
    throw new Error(`could not find ${name} in ${target}`);
  }
  const open = source.indexOf("[", start + anchor.length);
  const close = source.indexOf("\n];", open);
  if (open === -1 || close === -1) {
    throw new Error(`${name} is not an array literal`);
  }
  // `close` is the newline before `];`, so the literal ends two characters on.
  return `${source.slice(0, open)}${body}${source.slice(close + 2)}`;
};

/**
 * The plane-level export: the endpoint each plane's provider declares.
 *
 * The client consumes exactly this field (`models-dev.ts:107` lifts `item.api`
 * into `settings.baseURL`), so the shim carries the same value and the mount
 * reads it instead of hard-coding a family.
 */
export const renderPlaneApi = (
  planeApi: Readonly<Record<"go" | "zen", string>>
): string =>
  `{
  go: ${JSON.stringify(planeApi.go)},
  zen: ${JSON.stringify(planeApi.zen)},
}`;

/**
 * The endpoint each wire family declares, per plane, keyed by its SDK package.
 *
 * The provider-level `api` is only the default family's address: anthropic and
 * google are served at their own paths and the catalog records that per model.
 * Emitting it keeps the mount reading DATA, so a vendor move is a regeneration.
 */
export const renderFamilyApi = (
  familyApi: Readonly<Record<"go" | "zen", FamilyApi>>
): string =>
  `{
  go: ${JSON.stringify(familyApi.go)},
  zen: ${JSON.stringify(familyApi.zen)},
}`;
