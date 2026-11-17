/**
 * The pure half of `regenerate-catalog-shim.ts`: what a parsed models.dev
 * payload makes of `src/catalog-data.ts`, rendered as the file writes it, and
 * whether the shipped shim is stale against it.
 *
 * Every export the generator writes counts: the two catalogs, the plane
 * endpoints (`OPENCODE_PLANE_API`), the family endpoints
 * (`OPENCODE_FAMILY_API`) and the retired ids (`OPENCODE_DEPRECATED_IDS`).
 * The generator used to compare only the catalogs, so a vendor that moved an
 * endpoint left the shim reporting "current" while the mount read the old
 * address. `verify-catalog.ts` asks the same question through `shimStale`,
 * and both read what the file exports through one function (`shippedShim`),
 * so the two can never disagree about it. The whole generated output is one
 * function too (`rewriteShim`), which the script and its tests share.
 *
 * @module scripts/catalog-shim
 */
import type { CatalogModelSpec } from "../src/catalog-data.ts";
import { stale } from "./generator-kit.ts";

/** One plane's endpoint per SDK package (`""` is the provider's default). */
type FamilyApi = Readonly<Record<string, string>>;

/** The retired ids per plane, as the shim carries them. */
type DeprecatedIds = Readonly<Record<"go" | "zen", readonly string[]>>;

/** The five values the shim carries, in the shape `shimStale` compares. */
export interface ShimData {
  readonly deprecated: DeprecatedIds;
  readonly familyApi: Readonly<Record<"go" | "zen", FamilyApi>>;
  readonly go: readonly CatalogModelSpec[];
  readonly planeApi: Readonly<Record<"go" | "zen", string>>;
  readonly zen: readonly CatalogModelSpec[];
}

/** What `parseModelsDevCatalog` answers, read-only. */
export interface ParsedShim {
  readonly api: Readonly<Record<"go" | "zen", string>>;
  readonly deprecated: DeprecatedIds;
  readonly familyApi: Readonly<Record<"go" | "zen", FamilyApi>>;
  readonly go: readonly CatalogModelSpec[];
  readonly zen: readonly CatalogModelSpec[];
}

/** The file the shim lives in, for the messages. */
const TARGET = "catalog-data.ts";

/** Rows sorted deterministically by id, which is how the shim lists them. */
const byId = (specs: readonly CatalogModelSpec[]): CatalogModelSpec[] =>
  specs.toSorted((a, b) => a.id.localeCompare(b.id));

/** Each plane's retired ids, sorted: their order is not data. */
const sortedIds = (deprecated: DeprecatedIds): DeprecatedIds => ({
  go: deprecated.go.toSorted(),
  zen: deprecated.zen.toSorted(),
});

/**
 * What a parsed payload makes of the shim.
 *
 * @param parsed - `parseModelsDevCatalog`'s answer.
 * @returns the five values, each catalog sorted by id and each retired list
 *   sorted.
 */
export const shimData = (parsed: ParsedShim): ShimData => ({
  deprecated: sortedIds(parsed.deprecated),
  familyApi: parsed.familyApi,
  go: byId(parsed.go),
  planeApi: parsed.api,
  zen: byId(parsed.zen),
});

/**
 * Whether the shipped shim is stale against `next`: the one rule
 * (`generator-kit.ts`'s `stale`) over all five values. Row order is the
 * renderer's and retired-id order is not data, so both sides are sorted first.
 *
 * @param shipped - what `src/catalog-data.ts` exports (`shippedShim`).
 * @param next - what the source makes of it today (`shimData`).
 * @returns whether any of the five differs in data.
 */
export const shimStale = (shipped: ShimData, next: ShimData): boolean =>
  stale(
    {
      ...shipped,
      deprecated: sortedIds(shipped.deprecated),
      go: byId(shipped.go),
      zen: byId(shipped.zen),
    },
    {
      ...next,
      deprecated: sortedIds(next.deprecated),
      go: byId(next.go),
      zen: byId(next.zen),
    }
  );

/** One plane's retired ids from an exported value; anything else is none. */
const idList = (value: unknown): readonly string[] =>
  Array.isArray(value)
    ? value.filter((id): id is string => typeof id === "string")
    : [];

/**
 * What the generated file exports, by name, in the shape `shimStale`
 * compares: the one reader of `src/catalog-data.ts` both scripts use, so a
 * new export is added in one place. An absent or malformed
 * `OPENCODE_DEPRECATED_IDS` (a shim generated before it existed) reads as no
 * retired id on either plane.
 *
 * @param exports - the module namespace of `src/catalog-data.ts`.
 * @returns the five values.
 */
export const shippedShim = (
  exports: Readonly<Record<string, unknown>>
): ShimData => {
  const deprecated: unknown = exports.OPENCODE_DEPRECATED_IDS;
  const record =
    typeof deprecated === "object" && deprecated !== null
      ? (deprecated as Readonly<Record<string, unknown>>)
      : {};
  return {
    deprecated: { go: idList(record.go), zen: idList(record.zen) },
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the generated file's own exports, named by the declarations it writes.
    familyApi: exports.OPENCODE_FAMILY_API as ShimData["familyApi"],
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- as above.
    go: exports.OPENCODE_GO_CATALOG as ShimData["go"],
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- as above.
    planeApi: exports.OPENCODE_PLANE_API as ShimData["planeApi"],
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- as above.
    zen: exports.OPENCODE_ZEN_CATALOG as ShimData["zen"],
  };
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

/**
 * The retired ids each plane's registry lists, as the shim carries them.
 *
 * Emitted so a cold or offline start knows what the registry had retired when
 * the shim was generated: pi's installed snapshot still lists such ids, and
 * without them the discovery merge would offer them until the first refresh.
 */
export const renderDeprecated = (deprecated: DeprecatedIds): string =>
  `{
  go: ${JSON.stringify(deprecated.go)},
  zen: ${JSON.stringify(deprecated.zen)},
}`;

/**
 * {@link spliceObject} when the `export const NAME: ` anchor exists; otherwise
 * insert `declaration` immediately before the `export const BEFORE` anchor, so
 * a shim generated before an export existed gains it from a `--write`, with no
 * hand edit.
 *
 * @param source - the file's text.
 * @param name - the export to replace or add.
 * @param declaration - the whole declaration to insert, blank line included.
 * @param body - the object literal to splice when the export exists.
 * @param before - the export the new declaration goes in front of.
 * @returns the rewritten text.
 */
export const upsertObject = (
  source: string,
  name: string,
  declaration: string,
  body: string,
  before: string
): string => {
  if (source.includes(`export const ${name}: `)) {
    return spliceObject(source, name, body);
  }
  const anchor = source.indexOf(`export const ${before}`);
  if (anchor === -1) {
    throw new Error(`could not find ${before} in ${TARGET}`);
  }
  return `${source.slice(0, anchor)}${declaration}${source.slice(anchor)}`;
};

/** The retired-ids declaration, as a shim without one gains it. */
const deprecatedDeclaration = (deprecated: DeprecatedIds): string =>
  `/**
 * The ids each plane's registry lists as \`status: "deprecated"\`, sorted: what
 * a cold or offline start holds as retired until the first refresh lands.
 */
export const OPENCODE_DEPRECATED_IDS: Readonly<
  Record<"go" | "zen", readonly string[]>
> = ${renderDeprecated(deprecated)};

`;

/**
 * The whole generated output: `source` with every value the generator owns
 * replaced by `data`'s, the retired ids added in front of the Go catalog when
 * the file does not carry them yet.
 *
 * @param source - `src/catalog-data.ts` as it stands.
 * @param data - what the source makes of it today (`shimData`).
 * @returns the text `--write` writes, before the formatter.
 */
export const rewriteShim = (source: string, data: ShimData): string => {
  let next = splice(source, "OPENCODE_GO_CATALOG", render(data.go));
  next = splice(next, "OPENCODE_ZEN_CATALOG", render(data.zen));
  next = spliceObject(
    next,
    "OPENCODE_PLANE_API",
    renderPlaneApi(data.planeApi)
  );
  next = spliceObject(
    next,
    "OPENCODE_FAMILY_API",
    renderFamilyApi(data.familyApi)
  );
  return upsertObject(
    next,
    "OPENCODE_DEPRECATED_IDS",
    deprecatedDeclaration(data.deprecated),
    renderDeprecated(data.deprecated),
    "OPENCODE_GO_CATALOG"
  );
};
