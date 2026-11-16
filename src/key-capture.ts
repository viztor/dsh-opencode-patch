/**
 * Credential capture: what a key *is*, and which account it belongs to.
 *
 * The plugin can learn a key two ways — observed on a live request, or resolved
 * from declared configuration — and this module reads the first: pulling a
 * credential out of whatever header shape carried it, and classifying which
 * account tier it belongs to. Remembering it is the capture store's, one per
 * root (`credentials.ts`), and what counts as a credential at all is
 * `utils/credential-policy.ts`'s.
 *
 * Split out of `go-discovery.ts`, which keeps the *plan* side (which endpoint,
 * which key reference, and the policy that orders the two sources). The seam is
 * deliberate: everything here is about a credential value, nothing here knows
 * what a provider row or a base URL looks like.
 *
 * @module dsh-opencode-patch/key-capture
 */

import { isPlaceholderApiKey } from "./utils/credential-policy.ts";
import { isRecord } from "./utils/guards.ts";
import { gatewayPlaneFor } from "./utils/request-shape.ts";

/** Account tiers a captured credential can belong to. */
export type KeyTier = "go" | "zen" | "unknown";

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
    // so the ZEN google family was filed as a Go key, and `/inference/go` is
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
