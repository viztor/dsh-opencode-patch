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

import { isRecord } from "./utils/guards.ts";
import { gatewayPlaneFor } from "./utils/request-shape.ts";

/** Account tiers a captured credential can belong to. */
export type KeyTier = "go" | "zen" | "unknown";

/**
 * Bearer values the DSH adapter emits when it holds no real credential, plus the
 * gateway's own keyless sentinel.
 *
 * These are the exact strings the Authorization fallback exists to repair, so
 * they must never be *recorded* as a captured key: doing so overwrites a working
 * key with a dummy one, and every later lookup then re-injects the dummy.
 *
 * `public` is not an adapter placeholder — it is the gateway's own literal for a
 * keyless request, the vendor's own path for a model whose entry allows
 * anonymous use. The proxy treats no key and the literal alike, strips it and
 * forwards keylessly (`packages/console/app/src/lib/inference-proxy.ts`, both
 * 1.19 and 2.x: `const anonymous = !key || key === "public"`). What the service
 * behind the proxy answers is its own decision — the Zen free tier is refused
 * there — but the sentinel must never become a credential: capturing it would
 * forward `Bearer public`, turning an anonymous request into an authenticated
 * one. See `docs/upstream-findings.md` §1.5.
 */
const PLACEHOLDER_API_KEYS: ReadonlySet<string> = new Set([
  "null",
  "none",
  "public",
  "undefined",
  "unused",
]);

/** Whether a value is one of the adapter's placeholder credentials. */
export const isPlaceholderApiKey = (key: string): boolean =>
  PLACEHOLDER_API_KEYS.has(key.trim().toLowerCase());

/**
 * Which account tier a request belongs to.
 *
 * Ordered by how much each signal can be trusted:
 *
 * 1. The **URL** is what the adapter actually called — observed, not configured.
 * 2. The **provider route id** is only a hint. It is user-defined config and may
 *    be named anything (`zen`, `oc`, `my-opencode`), so it must never be the sole
 *    reason a lookup succeeds — that would make a captured, working key
 *    invisible the moment the user renamed a route.
 *
 * **The key's prefix is not a signal**, and it used to be the first one. It was
 * measured wrong: OpenCode issues `oc_sk_…` for Go credentials too, and such a
 * key answers the Go quota endpoint with real windows (`docs/engineering-notes.md`,
 * "A credential prefix is not an entitlement"). Read first, it filed a working
 * Go key under Zen — invisible to the meter, and injected into Zen requests.
 * And `sk-…` is not OpenCode's to claim: an OpenAI key on a relay the
 * deployment routes through here was filed as a Go key.
 *
 * @param url - the request URL, when the caller has one.
 * @param provider - the routed provider id, when known.
 */
export const tierForRequest = (url?: string, provider?: string): KeyTier => {
  if (typeof url === "string" && url.length > 0) {
    // Both endpoint families, because the gateway answers on both and a request
    // on either belongs to one of the two accounts. Matching only the legacy
    // `zen` shape silently mis-classified every request on the newer
    // `inference` family as `unknown`, which made a captured, working key
    // invisible to the resolver and sent the adapter's `Bearer unused`
    // placeholder instead — a 401 the user reads as an invalid API key.
    //
    // **The path is read as a path**, by the one predicate that answers for
    // every caller. The substring checks this replaces each got a piece of the
    // newer family wrong: `/inference/go` is a PREFIX of `/inference/google`,
    // so the ZEN google family was filed as a Go key, and `/inference/v1` is
    // not in `/inference/openai/v1`, so the ZEN openai family was filed under
    // no account at all. A key filed under the wrong account is worse than one
    // filed under none: it is used, and it is the wrong one.
    const plane = gatewayPlaneFor(url);
    if (plane === "opencode-go") {
      return "go";
    }
    if (plane === "opencode") {
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
 * Handles Bearer, Anthropic and Google key headers. A placeholder in one
 * header must not mask a real credential in another. When every value is a
 * placeholder, returns the first raw value for callers that diagnose it.
 */
export const extractApiKeyFromHeaders = (
  headers: unknown
): string | undefined => {
  if (headers === null || headers === undefined) {
    return undefined;
  }
  let read: ((keys: readonly string[]) => string | undefined) | undefined;
  if (typeof Headers !== "undefined" && headers instanceof Headers) {
    read = (keys) => headers.get(keys[0] ?? "") ?? undefined;
  } else if (isRecord(headers)) {
    read = (keys) => readHeaderString(headers, keys);
  }
  if (read === undefined) {
    return undefined;
  }
  const auth = read(["authorization", "Authorization"]);
  const candidates = [
    auth === undefined ? undefined : bearerValue(auth),
    read(["x-api-key", "X-Api-Key"]),
    read(["api-key", "API-KEY"]),
    read(["x-goog-api-key", "X-Goog-Api-Key"]),
  ]
    .map((value) => value?.trim())
    .filter(
      (value): value is string => value !== undefined && value.length > 0
    );
  return (
    candidates.find((value) => !isPlaceholderApiKey(value)) ?? candidates[0]
  );
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
  const tier = tierForRequest(url, provider);

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
