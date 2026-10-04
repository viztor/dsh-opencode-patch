/**
 * The `fetch` patch: where OpenCode gateway traffic is recognized and fixed.
 *
 * Only requests the plugin claims (gateway URL match, or a configured
 * provider on the active turn) are touched; everything else returns through
 * the original `fetch` byte-identical. For claimed requests the patch
 * restores the session header, the CLI User-Agent, and the gateway origin
 * headers, and runs the free-tier core-tool fallback over the body.
 *
 * @module dsh-opencode-patch/fetch-patch
 */

import type { AsyncLocalStorage } from "node:async_hooks";

import { DEFAULT_GATEWAY_URLS, type ResolvedPluginConfig } from "./config.ts";
import {
  extractApiKeyFromHeaders,
  getCapturedApiKey,
  recordCapturedApiKey,
  tierForRequest,
} from "./key-capture.ts";
import { enrichModelsResponse, isModelsListingUrl } from "./models-catalog.ts";
import {
  fallbackSessionId,
  OPENCODE_UA,
  PARENT_SESSION_ALT_HEADER,
  PARENT_SESSION_HEADER,
  SESSION_AFFINITY_HEADER,
  SESSION_HEADER,
} from "./session.ts";
import { maybeInjectCoreTools } from "./tool-fallback.ts";
import type { ActiveTurnState } from "./turn-store.ts";

const extractUrl = (input: RequestInfo | URL): string => {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.toString();
  }
  if (typeof input === "object" && input !== null && "url" in input) {
    const urlProp: unknown = input.url;
    if (typeof urlProp === "string") {
      return urlProp;
    }
    if (urlProp instanceof URL) {
      return urlProp.toString();
    }
  }
  return "";
};

const readHeaderSource = (
  input: RequestInfo | URL,
  init?: RequestInit
): HeadersInit | undefined => {
  if (init?.headers !== undefined) {
    return init.headers;
  }
  if (typeof Request !== "undefined" && input instanceof Request) {
    return input.headers;
  }
  return undefined;
};

/** Whether the request already carries a session header (any casing). */
export const hasSessionHeader = (
  input: RequestInfo | URL,
  init?: RequestInit
): boolean => {
  const source = readHeaderSource(input, init);
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

const resolveSessionHeader = (
  state: ActiveTurnState | undefined,
  headers: Headers,
  sessionIdEnv: string
): string => {
  if (state) {
    return state.value;
  }
  const existing = headers.get(SESSION_HEADER);
  if (typeof existing === "string" && existing.startsWith("ses_")) {
    return existing;
  }
  return fallbackSessionId(sessionIdEnv);
};

/**
 * Wrap `fetch` so claimed OpenCode requests carry the gateway's expected
 * headers and session id.
 *
 * @param original - the fetch implementation to wrap (usually `globalThis.fetch`).
 * @param als - turn store consulted for the session id of the current turn.
 * @param config - resolved plugin configuration.
 */
export const patchFetch = (
  original: typeof fetch,
  als: AsyncLocalStorage<ActiveTurnState>,
  config: ResolvedPluginConfig
): typeof fetch => {
  const patchedFetch = async function patchedFetch(
    this: unknown,
    input: RequestInfo | URL,
    init?: RequestInit
  ): Promise<Response> {
    const state = als.getStore();
    const url = extractUrl(input);

    if (!isOpenCodeRequest(url, state, config.providers, config.gatewayUrls)) {
      return original.call(this, input, init);
    }

    const headers = new Headers(readHeaderSource(input, init));

    // Capture the API key from the request headers so that quota monitoring,
    // usage display, and key resolution don't have to rely purely on static env vars.
    const requestKey = extractApiKeyFromHeaders(headers);
    if (requestKey !== undefined) {
      recordCapturedApiKey(requestKey, state?.provider, url);
    }

    // Ensure an Authorization header is present if the caller omitted it or provided a dummy value.
    const authHeader =
      headers.get("authorization") ?? headers.get("Authorization");
    if (
      authHeader === null ||
      authHeader.length === 0 ||
      authHeader === "Bearer undefined" ||
      authHeader === "Bearer null" ||
      authHeader === "Bearer unused"
    ) {
      // The captured key is looked up by tier as well as by provider: a user
      // may have named the route anything, and a provider-id miss must not hide
      // a key that is already known to work. Under the `configured` policy the
      // declared credential wins outright, so the capture is skipped entirely.
      const tier = tierForRequest(url, state?.provider);
      const captured =
        config.keySource === "configured"
          ? undefined
          : getCapturedApiKey(
              state?.provider,
              tier === "unknown" ? undefined : tier
            );
      const fallbackKey =
        captured ??
        (url.includes("/zen/go") || state?.provider === "opencode-go"
          ? process.env.OPENCODE_GO_API_KEY
          : process.env.OPENCODE_API_KEY);
      if (typeof fallbackKey === "string" && fallbackKey.length > 0) {
        headers.set("Authorization", `Bearer ${fallbackKey}`);
      }
    }

    // 1. Session header: ALWAYS injected for OpenCode requests
    const sessionVal = resolveSessionHeader(
      state,
      headers,
      config.sessionIdEnv
    );
    headers.set(SESSION_HEADER, sessionVal);
    headers.set("x-opencode-session-id", sessionVal);
    headers.set(SESSION_AFFINITY_HEADER, sessionVal);

    // 1b. Parent session header: injected for subagents and child sessions
    if (state?.parentValue !== undefined) {
      headers.set(PARENT_SESSION_HEADER, state.parentValue);
      headers.set(PARENT_SESSION_ALT_HEADER, state.parentValue);
    }

    // 2. User-Agent: injected / restored when enabled, with user override support
    if (config.injectUserAgent) {
      headers.set("User-Agent", config.userAgent ?? OPENCODE_UA);
    }

    // 3. Client & Project origin headers: injected when enabled
    if (config.injectOriginHeaders) {
      headers.set("x-opencode-client", config.originClient);

      if (config.injectProject) {
        const project =
          state?.project !== undefined && state.project.length > 0
            ? state.project
            : "global";
        headers.set("x-opencode-project", project);
      }
    }

    const newInit: RequestInit = { ...init, headers };

    // 4. Core tool schema fallback for free-tier /responses models
    if (init?.body !== undefined) {
      const newBody = maybeInjectCoreTools(url, init.body, headers, {
        enabled: config.injectCoreTools,
        modelMarker: config.freeModelMarker,
      });
      if (newBody !== init.body) {
        newInit.body = newBody;
      }
    }

    const response = await original.call(this, input, newInit);

    // If upstream returns 403 FreeTierError, demultiplex it to HTTP 400 so DSH's
    // error classifier doesn't falsely categorize it as an invalid API key ("AUTH").
    if (response.status === 403) {
      try {
        const cloned = response.clone();
        const text = await cloned.text();
        if (
          text.includes("FreeTierError") ||
          text.includes("from within OpenCode")
        ) {
          return Response.json(
            {
              error: {
                message:
                  "OpenCode's free tier can only be used from within OpenCode. Use space-bunny-free or a pay-as-you-go model.",
                type: "free_tier_restricted",
              },
            },
            {
              status: 400,
              statusText: "Bad Request",
            }
          );
        }
      } catch {
        // Fall back to original response on clone/text errors
      }
    }

    const method = (
      init?.method ??
      (typeof Request !== "undefined" && input instanceof Request
        ? input.method
        : "GET")
    ).toUpperCase();
    if (config.enrichModels && method === "GET" && isModelsListingUrl(url)) {
      return enrichModelsResponse(url, response);
    }
    return response;
  };
  return patchedFetch;
};
