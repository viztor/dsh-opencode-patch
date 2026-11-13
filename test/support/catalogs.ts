/**
 * Synthetic catalog rows, for the decisions the REAL catalog cannot express.
 *
 * Two kinds of fixture, both picked so no case names a vendor id a catalog
 * refresh can retire. The first reads the SHIPPED shim by shape
 * (`findCatalogRow`, `catalogRow`, `freeZenModel`): a case about "a Messages
 * model on Go" takes the first such row and reads its expected values off it.
 * The second builds the row a test needs, including the rows the vendor has
 * not produced yet (`spec`, `divergent`, `payload`, `seedDivergentCatalog`).
 *
 * **Why that is necessary rather than convenient.** The plugin's plane-aware
 * decisions — is this model free (so it needs no credential, and gets the free
 * tier's tools), what does it cost, which SDK serves it — are read from the
 * PLANE's row. For that to be testable, the two planes have to disagree, and
 * today they do not: every model on both planes carries the same free flag
 * (`test/catalog.test.ts` holds that invariant as a test). A test built on the
 * real catalog therefore cannot tell a plane-aware lookup from a plane-blind
 * one — both pass. It takes a fixture to make the difference observable.
 *
 * It reaches `src` through the one door, `./src.ts`, like the other fixtures,
 * so a module move edits one file. (The setup file cannot: it loads in the
 * jsdom files too, so it names the defining modules directly.)
 *
 * @module test/support/catalogs
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

/** What a test says about one catalogue row, in the terms the decisions use. */
export interface SpecInput {
  /** The model id, as the gateway spells it. */
  id: string;
  /** The display name; defaults to the id. */
  name?: string;
  /**
   * The SDK the model needs, as `provider.npm` carries it.
   *
   * Absent means the provider default — completions. `@ai-sdk/anthropic`,
   * `@ai-sdk/openai` and `@ai-sdk/google` are the three the plugin routes.
   */
  sdk?: string;
  /** Free on THIS plane: no credential needed, and the free tier's tools. */
  free?: boolean;
  /** Dollars per million tokens; omitted means the model is not priced here. */
  input?: number;
  output?: number;
  cacheRead?: number;
  /** The context window; a plausible default when a test does not care. */
  context?: number;
  /** The output cap; a plausible default when a test does not care. */
  maxOutput?: number;
  /** Whether the model accepts a thinking setting. */
  reasoning?: boolean;
}

/**
 * One catalogue row, as the parser would have built it.
 *
 * The same shape `OPENCODE_ZEN_CATALOG` holds — that is the point: a decision
 * cannot tell this from a row the vendor sent.
 *
 * @param input - what the test says about the row.
 * @returns the row.
 */
export const spec = (input: SpecInput): CatalogModelSpec => ({
  context_window: input.context ?? 1_048_576,
  ...(input.input === undefined
    ? {}
    : {
        cost: {
          ...(input.cacheRead === undefined
            ? {}
            : { cache_read: input.cacheRead }),
          input: input.input,
          output: input.output ?? input.input,
        },
      }),
  id: input.id,
  input_modalities: ["text"],
  ...(input.free === true ? { is_free: true } : {}),
  max_output_tokens: input.maxOutput ?? 65_536,
  name: input.name ?? input.id,
  ...(input.sdk === undefined ? {} : { provider_npm: input.sdk }),
  ...(input.reasoning === true
    ? {
        reasoning: true,
        reasoning_options: [{ type: "effort", values: ["low", "high"] }],
      }
    : {}),
});

/**
 * The same model, described differently on each plane.
 *
 * This is the shape a shared id has when the planes price it differently, and
 * the shape a plane-blind lookup gets wrong: the row is the SAME id, and every
 * field that differs is a field a decision reads.
 *
 * @param id - the model id both planes carry.
 * @param overrides - what differs, per plane.
 * @returns one row per plane.
 */
export const divergent = (
  id: string,
  overrides: { go?: Partial<SpecInput>; zen?: Partial<SpecInput> }
): { go: CatalogModelSpec; zen: CatalogModelSpec } => ({
  go: spec({ id, ...overrides.go }),
  zen: spec({ id, ...overrides.zen }),
});

/** A catalogue indexed the way the lookups read it. */
export type CatalogIndex = ReadonlyMap<string, CatalogModelSpec>;

/**
 * Index rows by id, the way the plugin's active catalogues are.
 *
 * @param rows - the rows.
 * @returns the index.
 */
export const index = (rows: readonly CatalogModelSpec[]): CatalogIndex =>
  new Map(rows.map((row) => [row.id, row]));

/** One row in the shape `models.dev` sends, which the parser reads. */
const modelEntry = (input: SpecInput): Record<string, unknown> => ({
  cost: {
    ...(input.cacheRead === undefined ? {} : { cache_read: input.cacheRead }),
    // **The parser derives `is_free` from the cost**: an id with no "free" in it
    // is free when both rates are zero. So a divergent free flag is spelled as
    // a zero cost on one plane and a real one on the other — which is how it
    // could reach a deployment, since the vendor's data has no flag of its own.
    //
    // A row with no price given is PAID at a nominal rate, not free: "no price"
    // in a fixture means "the test did not care", and a zero would silently
    // turn every such model into a free one.
    input: input.free === true ? 0 : (input.input ?? 1),
    output: input.free === true ? 0 : (input.output ?? input.input ?? 2),
  },
  id: input.id,
  ...(input.maxOutput === undefined
    ? {}
    : { limit: { output: input.maxOutput } }),
  modalities: { input: ["text"] },
  name: input.name ?? input.id,
  provider: input.sdk === undefined ? {} : { npm: input.sdk },
  ...(input.reasoning === true
    ? {
        reasoning: true,
        reasoning_options: [{ type: "effort", values: ["low", "high"] }],
      }
    : {}),
});

/**
 * A whole `models.dev` payload, for the code paths that read the LIVE catalogue.
 *
 * The parser turns this into the same rows `spec` builds, so a test can drive
 * `refreshCatalog` with a world the vendor has not produced and still exercise
 * the real parse → active-map → lookup chain.
 *
 * @param world - the rows each plane carries.
 * @returns the payload the parser reads.
 */
export const payload = (world: {
  go?: readonly SpecInput[];
  zen?: readonly SpecInput[];
}): Record<string, unknown> => {
  const provider = (rows: readonly SpecInput[] | undefined): unknown => ({
    api: "https://opencode.ai/inference/openai/v1",
    models: Object.fromEntries(
      (rows ?? []).map((row) => [row.id, modelEntry(row)])
    ),
  });
  return { "opencode-go": provider(world.go), opencode: provider(world.zen) };
};

/** Free on Zen, paid on Go. Neither probe id contains "free", so only the row decides. */
export const ZEN_FREE_PROBE = "plane-probe";

/** Free on Go, paid on Zen. */
export const GO_FREE_PROBE = "go-probe";

/**
 * Refresh the live catalogue with the two plane-divergent probes.
 *
 * A request-path test needs the world installed where the shipped lookup reads
 * it, so this goes through `refreshCatalog` (the stubbed fetch never touches the
 * network). `refreshCatalog` merges into the live maps, and
 * `test/support/reset-process-state.ts` restores the shim after every test, so
 * a case seeds its own world.
 *
 * @returns once the live maps carry both probes.
 */
export const seedDivergentCatalog = async (): Promise<void> => {
  const body = payload({
    go: [
      { free: true, id: GO_FREE_PROBE, name: "Go Probe" },
      { id: ZEN_FREE_PROBE, name: "Plane Probe" },
    ],
    zen: [
      { id: GO_FREE_PROBE, name: "Go Probe" },
      { free: true, id: ZEN_FREE_PROBE, name: "Plane Probe" },
    ],
  });
  await refreshCatalog(async () => Response.json(body), true);
};
