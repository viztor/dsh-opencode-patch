/**
 * A live catalog whose two planes disagree about which models are free.
 *
 * No id the shipped shim lists on both planes disagrees on `is_free`, so a
 * lookup that reads the wrong plane gives the right answer on every shared row
 * and the defect stays invisible. (Zen-only free ids are a different case: the
 * Go plane does not list them at all — see the `big-pickle` case in
 * `test/tool-fallback.test.ts`.) This fixture refreshes the live catalog with two
 * probes that flip between the planes: `plane-probe` is free on Zen and paid on
 * Go, `go-probe` the reverse. `is_free` is derived from `id.includes("free")` or
 * a zero cost, so neither id contains "free" and only the cost decides.
 *
 * `refreshCatalog` merges into the live maps, and
 * `test/support/reset-process-state.ts` restores the shim after every test. The
 * stubbed fetch never touches the network.
 *
 * @module test/support/catalog-fixture
 */
import {
  type CatalogModelSpec,
  OPENCODE_GO_CATALOG,
  OPENCODE_ZEN_CATALOG,
  protocolForSdk,
  refreshCatalog,
} from "./src.ts";

/** The two plane routes the shims describe. */
export type CatalogRoute = "opencode" | "opencode-go";

/** The shipped shim for one plane route. */
export const shimFor = (route: CatalogRoute): readonly CatalogModelSpec[] =>
  route === "opencode" ? OPENCODE_ZEN_CATALOG : OPENCODE_GO_CATALOG;

/**
 * The first shim row on `route` whose SDK speaks `protocol` — or, with no
 * `protocol`, the first row naming no SDK at all — picked by shape
 * so no case names a vendor id a catalog refresh can retire. Answers
 * `undefined` when the plane has none; a caller that needs one says so by
 * name (see {@link catalogRow}).
 *
 * @param route - the plane route.
 * @param protocol - the wire protocol; omitted for "no SDK of its own".
 * @returns the row, or `undefined`.
 */
export const findCatalogRow = (
  route: CatalogRoute,
  protocol?: string
): CatalogModelSpec | undefined =>
  shimFor(route).find((row) =>
    protocol === undefined
      ? row.provider_npm === undefined
      : row.provider_npm !== undefined &&
        protocolForSdk(row.provider_npm) === protocol
  );

/**
 * {@link findCatalogRow}, failing by name when the plane has no such row, so
 * a case that cannot find its fixture fails rather than passing vacuously.
 */
export const catalogRow = (
  route: CatalogRoute,
  protocol?: string
): CatalogModelSpec => {
  const row = findCatalogRow(route, protocol);
  if (row === undefined) {
    throw new Error(
      `the ${route} shim carries no row ${protocol === undefined ? "without an SDK" : `on ${protocol}`}`
    );
  }
  return row;
};

/**
 * A free Zen id, read off the shim rather than named, so a refresh that
 * retires one free model cannot turn a case about free models vacuous.
 *
 * @param excluding - a substring the id must not contain (a marker under test).
 * @returns the id.
 */
export const freeZenModel = (excluding?: string): string => {
  const spec = OPENCODE_ZEN_CATALOG.find(
    (row) =>
      row.is_free === true &&
      (excluding === undefined || !row.id.includes(excluding))
  );
  if (spec === undefined) {
    throw new Error("the Zen shim carries no free model");
  }
  return spec.id;
};

/** Free on Zen, paid on Go. */
export const ZEN_FREE_PROBE = "plane-probe";

/** Free on Go, paid on Zen. */
export const GO_FREE_PROBE = "go-probe";

const FREE = { input: 0, output: 0 } as const;
const PAID = { input: 1, output: 2 } as const;

/** Refresh the live catalog with the two plane-divergent probes. */
export const seedDivergentCatalog = async (): Promise<void> => {
  await refreshCatalog(
    (async () =>
      Response.json({
        opencode: {
          models: {
            [GO_FREE_PROBE]: { cost: PAID, name: "Go Probe" },
            [ZEN_FREE_PROBE]: { cost: FREE, name: "Plane Probe" },
          },
        },
        "opencode-go": {
          models: {
            [GO_FREE_PROBE]: { cost: FREE, name: "Go Probe" },
            [ZEN_FREE_PROBE]: { cost: PAID, name: "Plane Probe" },
          },
        },
      })) as unknown as typeof fetch,
    true
  );
};
