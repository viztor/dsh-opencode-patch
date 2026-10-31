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
import { resolveOpencodeStoreKey } from "./go-discovery.ts";
import {
  extractApiKeyFromHeaders,
  getCapturedApiKey,
  isPlaceholderApiKey,
  recordCapturedApiKey,
  tierForRequest,
} from "./key-capture.ts";
import {
  enrichModelsResponse,
  findModelSpec,
  isModelsListingUrl,
} from "./models-catalog.ts";
import {
  isOpenCodeMessageId,
  isOpenCodeSessionId,
  OPENCODE_UA,
  PARENT_SESSION_ALT_HEADER,
  PARENT_SESSION_HEADER,
  SESSION_AFFINITY_HEADER,
  SESSION_HEADER,
  SESSION_ID_HEADER,
  digestOf,
  sessionIdForRequest,
} from "./session.ts";
import { maybeInjectCoreTools } from "./tool-fallback.ts";
import type { ActiveTurnState } from "./turn-store.ts";
import {
  ANTHROPIC_VERSION,
  authHeaderFor,
  gatewayPlaneFor,
  headerSourceOf,
  requestUrlOf,
  toolNamesOf,
} from "./utils/request-shape.ts";

/**
 * Whether the model a body names is one the gateway admits with no key.
 *
 * The gateway's free-tier rule is per-model, not per-plane: `allowAnonymous` on
 * the model entry admits a request with no key at all, or with the literal
 * `public`, and the proxy strips it before forwarding
 * (`packages/console/app/src/lib/inference-proxy.ts`, identical in 1.19 and 2.x;
 * `docs/upstream-findings.md` §1.5). So "no credential resolved" is only a fault
 * for a model that NEEDS one, and reporting it for a free model sends the reader
 * to set a key they do not need.
 *
 * The body is read rather than assumed, because the model is the only thing that
 * decides. A plane-level check would be wrong in both directions: the Zen plane
 * offers free models, and so does Go, which serves them by subscription key.
 *
 * @param body - the request body, when there is one to read.
 * @returns whether the model it names is flagged free.
 */
const isFreeModelBody = (body: RequestInit["body"]): boolean => {
  if (typeof body !== "string" || body.length === 0) {
    return false;
  }
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed !== "object" || parsed === null) {
      return false;
    }
    const model: unknown = (parsed as Record<string, unknown>).model;
    // Both JSON routes carry the id under `model`, the Responses API included.
    if (typeof model !== "string" || model.length === 0) {
      return false;
    }
    return findModelSpec(model)?.is_free === true;
  } catch {
    return false;
  }
};

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

/**
 * Wrap `fetch` so claimed OpenCode requests carry the gateway's expected
 * headers and session id.
 *
 * @param original - the fetch implementation to wrap (usually `globalThis.fetch`).
 * @param als - turn store consulted for the session id of the current turn.
 * @param config - resolved plugin configuration.
 */
/**
 * What the interceptor needs from the plugin beyond its configuration.
 *
 * An object rather than more positional parameters, because these are the
 * plugin's own seams into the request path and there will be more of them. The
 * configuration stays separate: it is what the deployment wrote, and these are
 * what the running plugin knows.
 */
export interface FetchPatchHooks {
  /**
   * The org a plane's credential belongs to, when it has one.
   *
   * Asked per request rather than captured once, because a login can arrive
   * while the process runs. The org is not a setting: it is part of the
   * credential, and a request carrying a token without its org is answered as
   * though the token were a plain key.
   *
   * @param plane - the gateway plane the request is bound for.
   * @returns the org id, `wrk_...`, or undefined when the plane's credential has
   * none — which is every key deployment, and the reason this is optional.
   */
  readonly resolveOrg?: (plane: string) => string | undefined;
  /**
   * One entry per claimed request, for the debug file.
   *
   * The question it exists to answer is why a request that should have been
   * patched was not, or was patched wrongly — which is invisible from the
   * outside, because the gateway's answer for a malformed session id reads
   * exactly like the answer for a bad credential. So it records what the
   * interceptor SAW and what it SENT, never the credential itself.
   */
  readonly debug?: (entry: Record<string, unknown>) => void;
}

export const patchFetch = (
  original: typeof fetch,
  als: AsyncLocalStorage<ActiveTurnState>,
  config: ResolvedPluginConfig,
  hooks: FetchPatchHooks = {}
): typeof fetch => {
  // One report per plane for the no-credential case, because this runs on every
  // gateway request and the same missing credential would otherwise log on each.
  const warnedNoCredential = new Set<string>();
  const patchedFetch = async function patchedFetch(
    this: unknown,
    input: RequestInfo | URL,
    init?: RequestInit
  ): Promise<Response> {
    const state = als.getStore();
    const url = requestUrlOf(input);

    if (!isOpenCodeRequest(url, state, config.providers, config.gatewayUrls)) {
      return original.call(this, input, init);
    }

    const headers = new Headers(headerSourceOf(input, init));

    // Capture the API key from the request headers so that quota monitoring,
    // usage display, and key resolution don't have to rely purely on static env vars.
    const extracted = extractApiKeyFromHeaders(headers);
    const requestKey =
      extracted === undefined || isPlaceholderApiKey(extracted)
        ? undefined
        : extracted;
    if (requestKey !== undefined) {
      recordCapturedApiKey(requestKey, state?.provider, url);
    }

    // Ensure an Authorization header is present if the caller omitted it or provided a dummy value.
    const plane = gatewayPlaneFor(url);
    const wireHeader = authHeaderFor(url);
    // **The Anthropic protocol identifies itself by version**, and nothing below
    // this plugin sends it: `@earendil-works/pi-ai`'s anthropic adapter sets
    // `anthropic-beta` and `anthropic-dangerous-direct-browser-access` but not
    // `anthropic-version` (measured against the installed package), while the
    // official client's `@ai-sdk/anthropic` sends `2023-06-01` on every call.
    // The vendor's own API treats a Messages request without it as a client error,
    // so the plugin supplies it rather than depending on the adapter.
    if (wireHeader === "x-api-key" && !headers.has("anthropic-version")) {
      headers.set("anthropic-version", ANTHROPIC_VERSION);
    }
    const authHeader = headers.get(wireHeader);
    const wireKey = authHeader?.replace(/^Bearer\s+/iu, "").trim();
    if (
      wireKey === undefined ||
      wireKey.length === 0 ||
      isPlaceholderApiKey(wireKey)
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
      // Explicit request auth (including x-api-key) and declared sources win.
      // Only a known gateway plane may ask for a login: a configured provider
      // can also claim other URLs, which must not receive an account token.
      const declared =
        plane === "opencode-go" ||
        (plane.length === 0 && state?.provider === "opencode-go")
          ? process.env.OPENCODE_GO_API_KEY
          : process.env.OPENCODE_API_KEY;
      const explicit =
        requestKey ??
        captured ??
        (declared === undefined ||
        declared.length === 0 ||
        isPlaceholderApiKey(declared)
          ? undefined
          : declared);
      // **API key only.** The credential ladder ends at the installation's own
      // store: a login (device flow, session, credential pool) is v2 work and does
      // not live here. `readOpencodeStore` is off unless the deployment opted in.
      const fallbackKey =
        explicit ?? resolveOpencodeStoreKey(plane, config.readOpencodeStore);
      if (typeof fallbackKey === "string" && fallbackKey.length > 0) {
        headers.set(
          wireHeader,
          wireHeader === "authorization" ? `Bearer ${fallbackKey}` : fallbackKey
        );
        // **One credential, on the protocol's own header, and nothing else.**
        // The official client passes the key as an SDK option
        // (`packages/opencode/src/provider/provider.ts:240`, `options: ok ? {} :
        // { apiKey: "public" }`) and lets the SDK choose the header: `x-api-key`
        // for `@ai-sdk/anthropic`, `x-goog-api-key` for `@ai-sdk/google`,
        // `Authorization` for the openai family. Its only per-protocol header of
        // its own is `anthropic-beta` (`:211-219`).
        //
        // A "Bearer fallback" used to be added here for the non-authorization
        // shapes, so an Anthropic request carried BOTH headers. That is a
        // credential on a header the protocol does not read, and it is not what
        // the client does.
      } else if (
        plane.length > 0 &&
        !warnedNoCredential.has(plane) &&
        // A free model is ADMITTED with no credential at all, so "no credential
        // resolved" is not a failure there and saying it is sends the reader to
        // a key they do not need. The gateway's own rule is per-model
        // (`allowAnonymous` on the model entry, with no key or the literal
        // `public` - `docs/upstream-findings.md` §1.5), so the model is asked
        // rather than the plane. Keep the placeholder: the proxy strips it for
        // an anonymous request anyway, so stripping it here would change nothing
        // but would also deprive a keyless-but-paid model of a header to fill.
        //
        // `init.body` is read, not the `Request`: the tool-injection block below
        // resolves a `Request`-carried body, and this check runs before it. A
        // body the switch cannot see answers "not free", which is the safe
        // side - the warning is the status quo, not a new failure.
        !isFreeModelBody(init?.body)
      ) {
        warnedNoCredential.add(plane);
        const sources: string[] = [
          `a key on the request: ${requestKey === undefined ? "none" : "present"}`,
          `a key captured from a live request (policy ${config.keySource}): ${
            captured === undefined ? "none" : "present"
          }`,
          `${plane === "opencode-go" ? "OPENCODE_GO_API_KEY" : "OPENCODE_API_KEY"}: ${
            declared === undefined || declared.length === 0 ? "unset" : "set"
          }`,
          `the installation's own store: ${
            config.readOpencodeStore ? "read" : "not enabled"
          }`,
        ];
        console.warn(
          `[dsh-opencode-patch] no credential resolved for ${plane}; sending the adapter's placeholder, which the gateway answers with 401. Consulted: ${sources.join("; ")}.`,
          "set a key on the route or its env var, or sign in through the settings card"
        );
      }
    }

    // 1. Session headers, as the version this plugin emulates sends them.
    //
    // Read from the 1.x line's last release, v1.19.5, in
    // `packages/opencode/src/session/llm/request.ts`: `x-opencode-session-id`
    // and `x-opencode-session` both carry `sessionID`, and the affinity pair
    // belongs to relays. 2.x splits the first of those into an affinity id; the
    // plugin emulates 1.19.5, so it follows 1.19.5.
    //
    // Which ENDPOINT the request goes to is the deployment's, not this block's:
    // measured, either key serves a paid model on either endpoint - they are two
    // paths into one gateway - so nothing here has to pick one. `x-opencode-
    // request` is the one header of the set this plugin does not send, because
    // the CLI fills it from its own user id and the turn store has no equivalent.
    const envName =
      config.sessionIdEnv !== undefined && config.sessionIdEnv.length > 0
        ? config.sessionIdEnv
        : undefined;
    const sessionVal = sessionIdForRequest(
      state?.value,
      headers.get(SESSION_HEADER),
      envName === undefined ? undefined : process.env[envName],
      digestOf
    );
    headers.set("x-opencode-session-id", sessionVal);
    headers.set(SESSION_HEADER, sessionVal);
    // The affinity pair belongs to the OTHER branch in 1.19.5: for a provider
    // that does not start with `opencode` - a relay a deployment claimed by URL -
    // the client sends `x-session-affinity` and `X-Session-Id`; for an OpenCode
    // plane it sends `x-opencode-session` instead and nothing else. This plugin
    // sent all three everywhere, which is neither generation's behaviour.
    if (!(state?.provider ?? "").startsWith("opencode")) {
      headers.set(SESSION_AFFINITY_HEADER, sessionVal);
      headers.set(SESSION_ID_HEADER, sessionVal);
    }

    // 1b. Parent session header: injected for subagents and child sessions
    if (state?.parentValue !== undefined) {
      headers.set(PARENT_SESSION_HEADER, state.parentValue);
      headers.set(PARENT_SESSION_ALT_HEADER, state.parentValue);
    }

    // 2. User-Agent: injected / restored when enabled, with user override support
    if (config.injectUserAgent) {
      headers.set("User-Agent", config.userAgent ?? OPENCODE_UA);
    }

    // 2b. The org, when this plane's credential belongs to one. A session token
    // needs the org it belongs to — measured on a paid model: `200` with it,
    // `403` without — and the free tier is refused with or without one, which is
    // a gate no header cleared.
    // The configured org wins, because it is the one thing here the user said out
    // loud. The hook is the deployment's own source (an account that ships with
    // the profile); there is no login to infer one from.
    const org =
      config.credentialOrg ?? hooks.resolveOrg?.(gatewayPlaneFor(url));
    if (org !== undefined && org.length > 0) {
      headers.set("x-opencode-org-id", org);
    }

    // 3. Client & Project origin headers: injected when enabled
    if (config.injectOriginHeaders) {
      headers.set("x-opencode-client", config.originClient);

      // The message id, the one header of the captured set this block omitted.
      // Read from v1.19.5's `request.ts`: `"x-opencode-request": input.user.id`,
      // in the same branch as the client and project headers. The console reads
      // it for per-request metrics and rewrites it to `x-opencode-request-id`
      // before the request reaches the inference service
      // (`inference-proxy.ts`); the turn store carries the value because a
      // request cannot know its own message id.
      const requestValue = state?.requestValue;
      if (requestValue !== undefined && isOpenCodeMessageId(requestValue)) {
        headers.set("x-opencode-request", requestValue);
      }

      if (config.injectProject) {
        const project =
          state?.project !== undefined && state.project.length > 0
            ? state.project
            : "global";
        headers.set("x-opencode-project", project);
      }
    }

    const newInit: RequestInit = { ...init, headers };
    let requestToSend = input;

    // 4. Core tool schema fallback for free-tier /responses models.
    //
    // DSH sends inference as fetch(new Request(url, { body })) — so init.body
    // is undefined and the old `init?.body !== undefined` guard skipped the
    // whole block: Agent Team turns left with no bash and the gateway 403s
    // the body as non-OpenCode. Read the body off whichever half carries it.
    let bodySource: "request" | "init" | "none" = "none";
    let bodyToPatch: RequestInit["body"] = init?.body;
    if (bodyToPatch !== undefined) {
      bodySource = "init";
    } else if (input instanceof Request) {
      try {
        bodyToPatch = await input.clone().text();
        bodySource = "request";
      } catch {
        bodyToPatch = undefined;
      }
    }
    let finalBody = bodyToPatch;
    if (bodyToPatch !== undefined) {
      const newBody = maybeInjectCoreTools(url, bodyToPatch, headers, {
        enabled: config.injectCoreTools,
        modelMarker: config.freeModelMarker,
      });
      if (newBody !== bodyToPatch) {
        finalBody = newBody;
        if (bodySource === "request" && input instanceof Request) {
          // The input Request already owns the old body — clone() so the
          // caller's stream is never consumed, and send a new Request.
          // `method` is restated so the lint can see it — the Request copy
          // carries the same method either way. The instanceof repeat is
          // there for the type checker.
          requestToSend = new Request(input, {
            body: newBody,
            method: input.method,
          });
        } else {
          newInit.body = newBody;
        }
      }
    }

    const response = await original.call(this, requestToSend, newInit);

    // One line per request the interceptor touched, so a run that misbehaves can
    // be read back instead of guessed at. Presence, never values: whether a
    // credential, a session and an org were SENT is what explains an answer, and
    // the credential itself has no business in a log.
    hooks.debug?.({
      auth: extractApiKeyFromHeaders(headers) !== undefined,
      bodySource,
      claimed: true,
      org: headers.get("x-opencode-org-id") ?? null,
      plane: gatewayPlaneFor(url),
      request: headers.get("x-opencode-request") ?? null,
      session: headers.get(SESSION_HEADER) ?? null,
      sessionFormat: isOpenCodeSessionId(headers.get(SESSION_HEADER)),
      status: response.status,
      toolNames: toolNamesOf(finalBody),
      url,
      userAgent: headers.get("User-Agent") ?? null,
    });

    // **A 403 is passed through untouched, with the gateway's own words.**
    //
    // A revision remapped it to 400 here, so DSH's classifier would stop reading
    // it as AUTH. That was the wrong trade: it rewrote a status the gateway
    // chose, and the user asked for the opposite — keep the 403, keep the real
    // message. `classifyPiAiError` will label a 403 "AUTH", and that is the
    // classifier's reading; the message under it is the gateway's and is
    // accurate, which is what matters. Do not rewrite what the gateway said.
    //
    // Measured 403 shapes on this gateway, none of them about a credential:
    //   FreeTierError  "…can only be used from within OpenCode…"
    //   server_error   "Upstream request failed: Model access is disabled"
    //   WAF 1010       the request did not look like the OpenCode client
    // The credential case is a 401 (`Missing API key`, `Invalid API key`).
    const method = (
      init?.method ??
      (typeof Request !== "undefined" && input instanceof Request
        ? input.method
        : "GET")
    ).toUpperCase();
    if (
      config.enrichModels &&
      method === "GET" &&
      isModelsListingUrl(url, config.gatewayUrls)
    ) {
      return enrichModelsResponse(url, response);
    }
    return response;
  };
  return patchedFetch;
};
