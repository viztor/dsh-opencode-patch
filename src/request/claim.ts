/**
 * The fetch patch's first stage: whether a request is the plugin's to touch.
 *
 * Only requests the plugin claims (gateway URL match, or a configured
 * provider on the active turn) are touched; everything else returns through
 * the original `fetch` byte-identical, and so does a request of another
 * plugin's (D27): one issued inside a turn the stream hook marked `foreign`,
 * or one that carries an `x-opencode-plugin` marker.
 *
 * @module dsh-opencode-patch/request/claim
 */

import { DEFAULT_GATEWAY_URLS, type ResolvedPluginConfig } from "../config.ts";
import { SESSION_HEADER } from "../session.ts";
import type { ActiveTurnState } from "../turn-store.ts";
import {
  headerSourceOf,
  pluginMarkerOn,
  requestUrlOf,
} from "../utils/request-shape.ts";

export const hasSessionHeader = (
  input: RequestInfo | URL,
  init?: RequestInit
): boolean => {
  const source = headerSourceOf(input, init);
  if (source === undefined) {
    return false;
  }
  try {
    return new Headers(source).has(SESSION_HEADER);
  } catch {
    return false;
  }
};

/**
 * Determines if a request targets an OpenCode API endpoint.
 *
 * Two independent claims: a URL containing any configured gateway substring
 * (works even with no active turn, which is what keeps session affinity for
 * background calls), or a turn routed to a configured provider.
 *
 * @param url - the request URL.
 * @param state - the active turn, when the request belongs to one.
 * @param providers - configured provider route keys.
 * @param gatewayUrls - URL substrings marking gateway traffic; blank entries
 * are ignored, and the caller's absence of a list falls back to the default
 * gateway markers.
 */
export const isOpenCodeRequest = (
  url: string,
  state: ActiveTurnState | undefined,
  providers: Set<string>,
  gatewayUrls: readonly string[] = DEFAULT_GATEWAY_URLS
): boolean => {
  for (const marker of gatewayUrls) {
    if (marker.length > 0 && url.includes(marker)) {
      return true;
    }
  }
  if (state !== undefined && providers.has(state.provider)) {
    return true;
  }
  return false;
};

/** A claimed request: its URL, and a mutable copy of the headers it carried. */
export interface ClaimedRequest {
  readonly url: string;
  readonly headers: Headers;
}

/**
 * Claim a request for the patch, or leave it to go out as it was sent.
 *
 * @param input - the request or URL `fetch` was called with.
 * @param init - the call's init, when it had one.
 * @param state - the active turn, when the request belongs to one.
 * @param config - the deployment's providers and gateway markers.
 * @returns the URL and a copy of the headers to shape, or `undefined` when the
 * request is not the plugin's to touch.
 */
export const claimRequest = (
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  state: ActiveTurnState | undefined,
  config: Pick<ResolvedPluginConfig, "gatewayUrls" | "providers">
): ClaimedRequest | undefined => {
  // **A turn another plugin owns goes out as it was sent** (D27): the
  // stream hook marks a turn on a stepped-aside plane, whichever rule
  // stepped aside (the realm, which the request cannot show, or the
  // marker). Before the URL claim, which would otherwise take the request
  // by its gateway URL alone.
  if (state?.foreign === true) {
    return undefined;
  }
  const url = requestUrlOf(input);

  if (!isOpenCodeRequest(url, state, config.providers, config.gatewayUrls)) {
    return undefined;
  }

  const headers = new Headers(headerSourceOf(input, init));

  // **Another plugin's request goes out as it was sent** (D27). A route that
  // plugin wrote through pi-ai carries its marker, and its credential comes
  // from a realm this plugin does not share: no header of ours, no key fill
  // and no key capture, so its token is never recorded or replayed.
  if (pluginMarkerOn(headers) !== undefined) {
    return undefined;
  }
  return { headers, url };
};
