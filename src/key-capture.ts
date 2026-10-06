/**
 * Credential capture: what a key *is*, and where it was last seen.
 *
 * The plugin can learn a key two ways — observed on a live request, or resolved
 * from declared configuration — and this module owns the first: pulling a
 * credential out of whatever header shape carried it, classifying which account
 * tier it belongs to, and remembering it so later lookups do not have to fall
 * back to a static environment variable that may have gone stale.
 *
 * Split out of `go-discovery.ts`, which keeps the *plan* side (which endpoint,
 * which key reference, and the policy that orders the two sources). The seam is
 * deliberate: everything here is about a credential value, nothing here knows
 * what a provider row or a base URL looks like.
 *
 * @module dsh-opencode-patch/key-capture
 */

import { isRecord } from "./guards.ts";

/** Account tiers a captured credential can belong to. */
export type KeyTier = "go" | "zen" | "unknown";

/**
 * Bearer values the DSH adapter emits when it holds no real credential.
 *
 * These are the exact strings the Authorization fallback exists to repair, so
 * they must never be *recorded* as a captured key: doing so overwrites a working
 * key with a dummy one, and every later lookup then re-injects the dummy.
 */
const PLACEHOLDER_API_KEYS: ReadonlySet<string> = new Set([
  "null",
  "none",
  "undefined",
  "unused",
]);

/** Whether a value is one of the adapter's placeholder credentials. */
export const isPlaceholderApiKey = (key: string): boolean =>
  PLACEHOLDER_API_KEYS.has(key.trim().toLowerCase());

/**
 * Which account tier a request belongs to.
 *
 * Ordered by how much each signal can be trusted, which is the whole point:
 *
 * 1. The **key prefix** is intrinsic to the credential, so it survives a rotated
 *    key and a renamed provider route alike.
 * 2. The **URL** is what the adapter actually called — observed, not configured.
 * 3. The **provider route id** is only a hint. It is user-defined config and may
 *    be named anything (`zen`, `oc`, `my-opencode`), so it must never be the sole
 *    reason a lookup succeeds — that would make a captured, working key
 *    invisible the moment the user renamed a route.
 *
 * @param url - the request URL, when the caller has one.
 * @param provider - the routed provider id, when known.
 * @param key - the credential itself, when known; its prefix is the best signal.
 */
export const tierForRequest = (
  url?: string,
  provider?: string,
  key?: string
): KeyTier => {
  if (typeof key === "string" && key.length > 0) {
    if (key.startsWith("sk-")) {
      return "go";
    }
    if (key.startsWith("oc_sk_")) {
      return "zen";
    }
  }
  if (typeof url === "string" && url.length > 0) {
    if (url.includes("/zen/go") || url.includes("/go/v1")) {
      return "go";
    }
    if (url.includes("/zen/v1")) {
      return "zen";
    }
  }
  if (provider === "opencode-go") {
    return "go";
  }
  if (provider === "opencode") {
    return "zen";
  }
  return "unknown";
};

const readHeaderString = (
  headers: Record<string, unknown>,
  keys: readonly string[]
): string | undefined => {
  for (const key of keys) {
    const val: unknown = headers[key];
    if (typeof val === "string" && val.length > 0) {
      return val;
    }
  }
  return undefined;
};

/** `Authorization: Bearer <key>` reduced to `<key>`, or `undefined`. */
const bearerValue = (raw: string): string | undefined => {
  const match = raw.replace(/^Bearer\s+/i, "").trim();
  return match.length > 0 ? match : undefined;
};

/**
 * Extract an API key from a `Headers` instance or a plain header record.
 *
 * Handles `Authorization: Bearer <key>`, `x-api-key`, and `api-key`. Returns the
 * raw value: deciding whether it is a *usable* credential is the caller's job
 * (see {@link isPlaceholderApiKey}).
 */
export const extractApiKeyFromHeaders = (
  headers: unknown
): string | undefined => {
  if (headers === null || headers === undefined) {
    return undefined;
  }
  if (typeof Headers !== "undefined" && headers instanceof Headers) {
    const auth = headers.get("authorization") ?? headers.get("Authorization");
    if (typeof auth === "string" && auth.length > 0) {
      const bearer = bearerValue(auth);
      if (bearer !== undefined) {
        return bearer;
      }
    }
    const xApiKey =
      headers.get("x-api-key") ??
      headers.get("X-Api-Key") ??
      headers.get("api-key");
    return typeof xApiKey === "string" && xApiKey.trim().length > 0
      ? xApiKey.trim()
      : undefined;
  }
  if (isRecord(headers)) {
    const auth = readHeaderString(headers, ["authorization", "Authorization"]);
    if (auth !== undefined) {
      const bearer = bearerValue(auth);
      if (bearer !== undefined) {
        return bearer;
      }
    }
    const xApiKey = readHeaderString(headers, [
      "x-api-key",
      "X-Api-Key",
      "api-key",
      "API-KEY",
    ]);
    return xApiKey !== undefined && xApiKey.trim().length > 0
      ? xApiKey.trim()
      : undefined;
  }
  return undefined;
};

/**
 * The capture store, read three ways.
 *
 * A lookup can be scoped by route (`capturedKeysByProvider`) or by tier
 * (`capturedKeysByTier`); the tier map is what makes a lookup survive a renamed
 * route. `latestCapturedKey` is the last resort, and is why the tier argument
 * matters: without it, "most recently seen" can hand the Go endpoint a Zen key.
 *
 * The route-scoped map carries the tier ALONGSIDE the key rather than only the
 * key. It used to hold `string`, which made the route lookup the one path that
 * ignored a requested tier: a Zen key seen while the Go route was in play came
 * back verbatim, so it outranked every correctly-filtered source — and it is the
 * FIRST captured step of both `auto` and `request`. Holding the tier is what lets
 * the route lookup apply the same rule the other two already did.
 */
const capturedKeysByProvider = new Map<
  string,
  { key: string; tier: KeyTier }
>();
const capturedKeysByTier = new Map<"go" | "zen", string>();
let latestCapturedKey:
  | { key: string; provider?: string; tier: KeyTier }
  | undefined;

/**
 * Whether a key classified as `tier` may answer a lookup for `wanted`.
 *
 * `unknown` is deliberately permissive, and identically so in all three lookup
 * paths: an unclassifiable key is one we never identified, not one we proved to
 * be the other tier. Filtering on "not the opposite" instead would make the
 * guess fail closed and hide working keys.
 */
const tierSatisfies = (tier: KeyTier, wanted: "go" | "zen"): boolean =>
  tier === wanted || tier === "unknown";

/**
 * Record an API key captured from live HTTP request headers or provider configurations.
 *
 * A blank or placeholder value is ignored rather than stored.
 */
export const recordCapturedApiKey = (
  rawKey: string,
  provider?: string,
  url?: string
): void => {
  const key = rawKey.trim();
  if (key.length === 0 || isPlaceholderApiKey(key)) {
    return;
  }
  // Deliberately NOT `resolveRoutedKey`'s precedence: a key seen on a live
  // request is classified by the request that carried it, not by the route the
  // user named. See `tierForRequest`.
  const tier = tierForRequest(url, provider, key);

  if (typeof provider === "string" && provider.length > 0) {
    capturedKeysByProvider.set(provider, { key, tier });
  }
  if (tier !== "unknown") {
    capturedKeysByTier.set(tier, key);
  }
  latestCapturedKey = { key, provider, tier };
};

/**
 * Retrieve a previously captured API key by provider or tier.
 *
 * @param provider - route id to try first, when the caller has one.
 * @param tier - the tier the key must belong to. Pass it whenever the request
 * already identifies one: omitting it lets the most recently seen key win,
 * which may be for the other tier. A route-scoped hit is filtered by it too —
 * naming a route is a preference, not a licence to ignore the tier.
 */
export const getCapturedApiKey = (
  provider?: string,
  tier?: "go" | "zen"
): string | undefined => {
  if (typeof provider === "string" && provider.length > 0) {
    const direct = capturedKeysByProvider.get(provider);
    if (
      direct !== undefined &&
      direct.key.length > 0 &&
      (tier === undefined || tierSatisfies(direct.tier, tier))
    ) {
      return direct.key;
    }
  }
  if (tier !== undefined) {
    const byTier = capturedKeysByTier.get(tier);
    if (byTier !== undefined && byTier.length > 0) {
      return byTier;
    }
  }
  if (
    latestCapturedKey !== undefined &&
    latestCapturedKey.key.length > 0 &&
    (tier === undefined || tierSatisfies(latestCapturedKey.tier, tier))
  ) {
    return latestCapturedKey.key;
  }
  return undefined;
};

/**
 * Clear all captured API keys (primarily used in test teardown).
 */
export const clearCapturedApiKeys = (): void => {
  capturedKeysByProvider.clear();
  capturedKeysByTier.clear();
  latestCapturedKey = undefined;
};
