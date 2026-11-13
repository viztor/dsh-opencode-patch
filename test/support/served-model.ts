/**
 * The model object the plane adapter serves for one catalog row, built the way
 * the adapter builds it (`planeModelFor`), for the files that read a served
 * model's protocol, base or levels: the offline sweep in
 * `test/dispatch-levels.test.ts` and its live half in
 * `test/e2e/dispatch-levels.e2e.ts`. One copy, so a change to how a served
 * model is built reaches both.
 *
 * Pure: a function of its arguments.
 *
 * @module test/support/served-model
 */
import {
  type CatalogModelSpec,
  OPENCODE_FAMILY_API,
  OPENCODE_GO_CATALOG,
  OPENCODE_ZEN_CATALOG,
  planeModelFor,
  type Protocol,
} from "./src.ts";

/** The two plane routes, and the catalog and family map each resolves from. */
export const PLANE_ROUTES = [
  {
    catalog: OPENCODE_ZEN_CATALOG,
    family: OPENCODE_FAMILY_API.zen,
    route: "opencode",
  },
  {
    catalog: OPENCODE_GO_CATALOG,
    family: OPENCODE_FAMILY_API.go,
    route: "opencode-go",
  },
] as const;

/** What {@link servedModel} reads off a plane: its family map and its route. */
export type ServedPlane = Pick<
  (typeof PLANE_ROUTES)[number],
  "family" | "route"
>;

/**
 * The model the plane adapter serves for one catalog row, on the default
 * family.
 *
 * @param plane - the plane's family map and route.
 * @param spec - the catalog row.
 * @returns the served model.
 * @throws {Error} when the row cannot be served, naming the route and id.
 */
export const servedModel = (
  plane: ServedPlane,
  spec: CatalogModelSpec
): Readonly<Record<string, unknown>> & { api: Protocol; baseUrl: string } => {
  const { model, error } = planeModelFor({
    // Stand-ins for what pi-ai's `Config` fills; the routing read here
    // ignores them, and the plugin restates none of them (D17).
    defaults: { contextWindow: 123_456, input: ["text"], maxTokens: 6_543 },
    endpoint: "modern",
    entry: { id: spec.id },
    familyApi: plane.family,
    route: plane.route,
    spec,
  });
  if (model === undefined) {
    throw new Error(`${plane.route}/${spec.id}: ${error}`);
  }
  return model;
};
