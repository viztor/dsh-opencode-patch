/**
 * Which of the two gateway planes a route belongs to: one table, two readers.
 *
 * The question was answered in several places — the catalog's route rule, the
 * captured key's tier, the discovery wrapper, the purge action, the plane
 * adapter's auth, the credential variable a plane asks for — each with its own
 * `=== "opencode-go"`. They agree today; this module is what keeps them
 * agreeing, because there is now one table to disagree with.
 *
 * Two readers, because the callers ask two different questions:
 *
 * - {@link planeOfPlaneRoute}: the plane of one of the two routes the plugin
 *   OWNS, or `undefined` for anything else. Exact: a relay, a renamed route
 *   or an inherited key of every object (`constructor`) is not a plane route.
 * - {@link planeForRoute}: the plane whose CATALOG a route's models are read
 *   from, relays included: `opencode-go` and any `opencode-go-*` relay are Go,
 *   and everything else is Zen. Case-sensitive, as it always was.
 *
 * The URL's plane is a property of its path, and lives beside the path rules
 * in `request-shape.ts` (`planeForUrl`).
 *
 * Every value is a constant or a function of its arguments: this module is in
 * `utils/` and the architecture test holds it to that.
 *
 * @module dsh-opencode-patch/utils/planes
 */

import { isPlaneRoute, type PlaneRoute } from "./protocols.ts";

/** The two gateway planes: the Go subscription and Zen pay-as-you-go. */
export type Plane = "go" | "zen";

/**
 * The plane each owned route serves, keyed in `PLANE_ROUTES`' order
 * (`protocols.ts`), which the purge action walks.
 */
export const PLANE_OF_ROUTE: Readonly<Record<PlaneRoute, Plane>> = {
  opencode: "zen",
  "opencode-go": "go",
};

/**
 * The plane of one of the two owned routes, or `undefined` for any other
 * value. Read through {@link isPlaneRoute}, so a key every object inherits
 * never answers.
 *
 * @param route - a route id, or anything a caller holds in its place.
 * @returns the route's plane, or `undefined`.
 */
export const planeOfPlaneRoute = (route: unknown): Plane | undefined =>
  isPlaneRoute(route) ? PLANE_OF_ROUTE[route] : undefined;

/**
 * The plane a route's models come from: `opencode-go` is the subscription
 * plane, and so is an `opencode-go-*` relay route; everything else (`opencode`,
 * a relay of another name, a value that is not a string) is Zen.
 *
 * `opencode-google` starts with `opencode-go` but not with `opencode-go-`, so
 * it is Zen.
 *
 * @param route - the route id in play.
 * @returns the plane whose catalog describes the route's models.
 */
export const planeForRoute = (route: unknown): Plane =>
  route === "opencode-go" ||
  (typeof route === "string" && route.startsWith("opencode-go-"))
    ? "go"
    : "zen";
