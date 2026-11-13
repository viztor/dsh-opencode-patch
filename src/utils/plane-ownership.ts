/**
 * Which plane entries the route claim TAKES, and which it leaves to pi-ai
 * because another plugin owns them (D27, docs/improvement-plan.md).
 *
 * A vendor plugin can serve `opencode`/`opencode-go` through pi-ai itself: it
 * overrides pi-ai's loader row with `isolate: { credentials: <its realm> }`
 * and a `config` of its own, provides `credentials` in that realm, and marks
 * each route it writes with an `x-opencode-plugin` header. The plane adapter
 * resolves a key through the PLUGIN's `credentials` (D20), which is not that
 * realm, so it could never send the vendor's credential; the claim steps
 * aside instead, and pi-ai serves the entry as it would without this plugin.
 *
 * Ownership is detected from the row and the entry, never from a vendor name
 * or a version:
 *
 * 1. **The realm** (structural, primary): pi-ai's row isolates `credentials`
 *    into a realm the plugin's own row does not share. Then no plane entry of
 *    that row can be served by pi-ai's credential rule, and all of them are
 *    left to pi-ai.
 * 2. **The marker**: an entry whose `headers` carry an `x-opencode-plugin` key
 *    (in any case) belongs to the plugin that wrote it, whatever the realm.
 *
 * Every function is a function of its arguments: the caller reads the rows'
 * options and the raw config, and decides with these.
 *
 * @module dsh-opencode-patch/utils/plane-ownership
 */

import { isRecord } from "./guards.ts";
import { PLANE_ROUTES, type PlaneRoute } from "./protocols.ts";

/** The header a vendor plugin marks the routes it writes with. */
export const PLUGIN_MARKER_HEADER = "x-opencode-plugin";

/**
 * A realm label as the loader reads one (`cordis-plugin-loader`
 * `config/isolate.ts`): `true` is a realm private to its row, a non-empty
 * string a realm shared by every row with that label.
 */
export type RealmLabel = string | true;

/** Why the claim leaves a plane entry to pi-ai. */
export type StepAsideReason =
  | { readonly kind: "realm"; readonly realm: RealmLabel }
  | { readonly kind: "marker"; readonly header: string };

/**
 * The `credentials` realm a loader row's options isolate it into.
 *
 * @param options - a row's `entry.options`.
 * @returns the label, or `undefined` for a row that shares the process-wide
 * service (no `isolate`, or a falsy label, which the loader ignores).
 */
export const credentialsRealmOf = (
  options: unknown
): RealmLabel | undefined => {
  const isolate: unknown = isRecord(options) ? options.isolate : undefined;
  const label: unknown = isRecord(isolate) ? isolate.credentials : undefined;
  return label === true || (typeof label === "string" && label.length > 0)
    ? label
    : undefined;
};

/**
 * Whether pi-ai's row resolves credentials in a realm the plugin's row does
 * not share: a private realm always, a shared one unless both rows name it.
 *
 * @param theirs - pi-ai's row's realm.
 * @param ours - the plugin's row's realm.
 * @returns whether the realms differ.
 */
export const isForeignRealm = (
  theirs: RealmLabel | undefined,
  ours: RealmLabel | undefined
): theirs is RealmLabel =>
  theirs !== undefined && (theirs === true || theirs !== ours);

/**
 * The marker header as a plane entry writes it.
 *
 * @param entry - one raw plane entry.
 * @returns the header key as written, or `undefined` when unmarked.
 */
export const pluginMarkerOf = (entry: unknown): string | undefined => {
  const headers: unknown = isRecord(entry) ? entry.headers : undefined;
  return isRecord(headers)
    ? Object.keys(headers).find(
        (key) => key.toLowerCase() === PLUGIN_MARKER_HEADER
      )
    : undefined;
};

/**
 * The plane entries a raw config declares that the claim leaves to pi-ai, by
 * route. The realm wins over the marker: it is the reason no entry of the row
 * could be served.
 *
 * @param raw - a pi-ai row's raw config.
 * @param foreignRealm - the row's realm when the plugin does not share it.
 * @returns the stepped-aside planes and why.
 */
export const steppedAsidePlanes = (
  raw: unknown,
  foreignRealm: RealmLabel | undefined
): ReadonlyMap<PlaneRoute, StepAsideReason> => {
  const out = new Map<PlaneRoute, StepAsideReason>();
  const providers: unknown = isRecord(raw) ? raw.providers : undefined;
  if (!isRecord(providers)) {
    return out;
  }
  for (const plane of PLANE_ROUTES) {
    if (!Object.hasOwn(providers, plane)) {
      continue;
    }
    if (foreignRealm !== undefined) {
      out.set(plane, { kind: "realm", realm: foreignRealm });
      continue;
    }
    const header = pluginMarkerOf(providers[plane]);
    if (header !== undefined) {
      out.set(plane, { header, kind: "marker" });
    }
  }
  return out;
};

/**
 * The plane routes a raw config declares that the claim takes.
 *
 * @param raw - a pi-ai row's raw config.
 * @param foreignRealm - the row's realm when the plugin does not share it.
 * @returns the taken planes, in {@link PLANE_ROUTES} order.
 */
export const takenPlanes = (
  raw: unknown,
  foreignRealm: RealmLabel | undefined
): PlaneRoute[] => {
  const providers: unknown = isRecord(raw) ? raw.providers : undefined;
  if (!isRecord(providers)) {
    return [];
  }
  const aside = steppedAsidePlanes(raw, foreignRealm);
  return PLANE_ROUTES.filter(
    (plane) => Object.hasOwn(providers, plane) && !aside.has(plane)
  );
};

/**
 * The one line the claim logs for a plane it leaves to pi-ai.
 *
 * @param plane - the route.
 * @param reason - why.
 * @param row - pi-ai's row id.
 * @returns the message, without the plugin's log prefix.
 */
export const stepAsideMessage = (
  plane: PlaneRoute,
  reason: StepAsideReason,
  row: string
): string => {
  const why =
    reason.kind === "realm"
      ? `the pi-ai row "${row}" resolves credentials in ${
          reason.realm === true
            ? "a realm private to it"
            : `the realm "${reason.realm}"`
        }, which this plugin's row does not share`
      : `its entry carries the "${reason.header}" header another plugin writes`;
  return `${why}: dsh-opencode-patch leaves the route ${plane} to pi-ai`;
};
