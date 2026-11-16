/**
 * The `fetch` patch: where OpenCode gateway traffic is recognized and fixed.
 *
 * Only requests the plugin claims (gateway URL match, or a configured
 * provider on the active turn) are touched; everything else returns through
 * the original `fetch` byte-identical, and so does a request of another
 * plugin's (D27): one issued inside a turn the stream hook marked `foreign`,
 * or one that carries an `x-opencode-plugin` marker. For claimed requests the
 * patch fills an empty or placeholder credential (`credentials.ts`, the one
 * resolver), restores the CLI User-Agent, and runs the free-tier core-tool
 * fallback over the body.
 *
 * The plane headers (session, parent, org, origin) are written here for a
 * relay, a turnless URL-claimed request and a turn the plane adapter did not
 * shape. On a turn whose requests the plane adapter shaped per call (OC5,
 * `prepareHeaders` in `host/plane-provider.ts`) the patch writes none of them
 * while the request carries a well-formed session id: the adapter's are the
 * plugin's own, and a contributor's change to them is the contributor's.
 *
 * @module dsh-opencode-patch/fetch-patch
 */

import type { AsyncLocalStorage } from "node:async_hooks";

import { DEFAULT_GATEWAY_URLS, type ResolvedPluginConfig } from "./config.ts";
import {
  createCaptureStore,
  createCredentials,
  type FetchCredentials,
} from "./credentials.ts";
import { extractApiKeyFromHeaders } from "./key-capture.ts";
import {
  type CatalogPlane,
  enrichModelsResponse,
  findModelSpec,
  findModelSpecOn,
  isModelsListingUrl,
} from "./models-catalog.ts";
import {
  isOpenCodeSessionId,
  OPENCODE_UA,
  SESSION_HEADER,
  digestOf,
  sessionIdForRequest,
} from "./session.ts";
import { maybeInjectCoreTools } from "./tool-fallback.ts";
import type { ActiveTurnState } from "./turn-store.ts";
import { needsFill, usableKey } from "./utils/credential-policy.ts";
import {
  ANTHROPIC_VERSION,
  authHeaderFor,
  gatewayPlaneFor,
  headerSourceOf,
  isGoPlaneUrl,
  planeHeadersFor,
  pluginMarkerOn,
  projectHeaderOf,
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
const isFreeModelBody = (
  body: RequestInit["body"],
  plane: CatalogPlane
): boolean => {
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
    // **The plane's own flag.** A model can be free on one plane and not on the
    // other, and this decides whether a credential is required — so the answer
    // has to be the plane's. The plane-agnostic lookup searches Go first, which
    // today agrees with the plane-aware one for every model in the catalog, and
    // is wrong the day it does not.
    const spec = findModelSpecOn(plane, model) ?? findModelSpec(model);
    return spec?.is_free === true;
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
  /**
   * The credential resolver and the capture store it learns into. The plugin
   * hands the one of its root (`captureStoreFor`), so the meter reads what
   * the fill learned; absent, the patch keeps a store of its own.
   */
  readonly credentials?: FetchCredentials;
  /**
   * Whether this patch is still live. A patch disposed while another wraps it
   * stays in the chain as a pass-through link (`host/global-fetch.ts`), so a
   * request through it reaches the fetch underneath untouched.
   */
  readonly live?: () => boolean;
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
  const credentials =
    hooks.credentials ??
    createCredentials({
      keySource: config.keySource,
      readOpencodeStore: config.readOpencodeStore,
      store: createCaptureStore(),
    });
  const patchedFetch = async function patchedFetch(
    this: unknown,
    input: RequestInfo | URL,
    init?: RequestInit
  ): Promise<Response> {
    if (hooks.live?.() === false) {
      return original.call(this, input, init);
    }
    const state = als.getStore();
    // **A turn another plugin owns goes out as it was sent** (D27): the
    // stream hook marks a turn on a stepped-aside plane, whichever rule
    // stepped aside (the realm, which the request cannot show, or the
    // marker). Before the URL claim, which would otherwise take the request
    // by its gateway URL alone.
    if (state?.foreign === true) {
      return original.call(this, input, init);
    }
    const url = requestUrlOf(input);

    if (!isOpenCodeRequest(url, state, config.providers, config.gatewayUrls)) {
      return original.call(this, input, init);
    }

    const headers = new Headers(headerSourceOf(input, init));

    // **Another plugin's request goes out as it was sent** (D27). A route that
    // plugin wrote through pi-ai carries its marker, and its credential comes
    // from a realm this plugin does not share: no header of ours, no key fill
    // and no key capture, so its token is never recorded or replayed.
    if (pluginMarkerOn(headers) !== undefined) {
      return original.call(this, input, init);
    }

    // The body, read once, off whichever half carries it. DSH sends inference as
    // fetch(new Request(url, { body })) — so init.body is undefined, and two
    // things read it: the free-model check on the credential path below and the
    // core-tool fallback after it. The free-model check used to read
    // `init.body` alone, so for every DSH turn it answered "not free" and a
    // keyless free model was reported as a missing credential.
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

    // The request's own key, recorded only when this request belongs to a turn
    // the plugin decorated (OC3): a key on a turnless request — a Console
    // call, another tool's background request — was not sent by the plugin,
    // and is never kept or replayed. A foreign turn and a marked request
    // returned above; the rule still takes both, so it is one function.
    const requestKey = credentials.observe({
      decorated: state !== undefined,
      foreign: false,
      headers,
      marked: false,
      provider: state?.provider,
      url,
    });

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
    const wireKey = headers
      .get(wireHeader)
      ?.replace(/^Bearer\s+/iu, "")
      .trim();
    if (needsFill(wireKey)) {
      const decision = credentials.fillKey({
        plane,
        provider: state?.provider,
        requestKey,
        url,
      });
      if (decision.key !== undefined) {
        headers.set(
          wireHeader,
          wireHeader === "authorization"
            ? `Bearer ${decision.key}`
            : decision.key
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
        // A body the check cannot read answers "not free", which is the safe
        // side - the warning is the status quo, not a new failure.
        !isFreeModelBody(bodyToPatch, isGoPlaneUrl(url) ? "go" : "zen")
      ) {
        warnedNoCredential.add(plane);
        const { consulted } = decision;
        // The request's own key and a captured one answer "none" by
        // construction: every policy consults both ahead of the declared
        // variable, so either one present would have filled the wire.
        const sources: string[] = [
          "a key on the request: none",
          `a key captured from a live request (policy ${config.keySource}): none`,
          `${consulted.declaredName}: ${consulted.declaredSet ? "set" : "unset"}`,
          `the installation's own store: ${
            consulted.storeRead ? "read" : "not enabled"
          }`,
        ];
        console.warn(
          `[dsh-opencode-patch] no credential resolved for ${plane}; sending the adapter's placeholder, which the gateway answers with 401. Consulted: ${sources.join("; ")}.`,
          "set a key on the route or its env var, or turn on readOpencodeStore to use the key an OpenCode installation already holds"
        );
      }
    }

    // The plane headers (`planeHeadersFor`, the one table the per-call seam
    // writes from too). On a turn the plane adapter shaped per call (OC5) a
    // request that carries a well-formed session id keeps the headers it was
    // given; a malformed one is still replaced, because the gateway answers
    // it with `401 Invalid API key` (L8), whoever wrote it.
    const shaped =
      state?.perCall === true &&
      isOpenCodeSessionId(headers.get(SESSION_HEADER));
    if (!shaped) {
      const sessionVal = sessionIdForRequest(
        state?.value,
        headers.get(SESSION_HEADER),
        credentials.sessionPin(config.sessionIdEnv),
        digestOf
      );
      // The org: the configured one wins, because it is the one thing here
      // the user said out loud; the hook is the deployment's own source.
      const org =
        config.credentialOrg ?? hooks.resolveOrg?.(gatewayPlaneFor(url));
      for (const [name, value] of planeHeadersFor({
        org,
        origin: config.injectOriginHeaders
          ? {
              client: config.originClient,
              project: config.injectProject
                ? projectHeaderOf(state?.project)
                : undefined,
              request: state?.requestValue,
            }
          : undefined,
        parent: state?.parentValue,
        relay: !(state?.provider ?? "").startsWith("opencode"),
        session: sessionVal,
      })) {
        headers.set(name, value);
      }
    }

    // User-Agent: injected / restored when enabled, with user override
    // support, whoever shaped the rest — attribution wins after pi-ai's
    // `prepareHeaders`, so the per-call seam cannot carry it.
    if (config.injectUserAgent) {
      headers.set("User-Agent", config.userAgent ?? OPENCODE_UA);
    }

    const newInit: RequestInit = { ...init, headers };
    let requestToSend = input;

    // 4. Core tool schema fallback for free-tier /responses models, over the
    // body read above; a toolless chat-completions body also gets
    // `tool_choice: "none"`.
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

    // What the gateway said about the key a request of a decorated turn
    // carried (L8): a key the plugin captured is dropped after a second
    // well-formed 401 in a row, and comes back once a request of a decorated
    // turn carrying it as its own is accepted. A turnless request (the
    // meter's `/usage` poll among them) settles nothing (OC3).
    const sentKey = usableKey(
      headers.get(wireHeader)?.replace(/^Bearer\s+/iu, "")
    );
    credentials.settle({
      decorated: state !== undefined,
      key: sentKey,
      provider: state?.provider,
      // A dropped key comes back only on a request that may file it: its
      // own key, on a turn the plugin decorated (OC3).
      recordable:
        state !== undefined && sentKey !== undefined && sentKey === requestKey,
      sessionWellFormed: isOpenCodeSessionId(headers.get(SESSION_HEADER)),
      status: response.status,
      url,
    });

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
    // message. Do not rewrite what the gateway said. The CODE is a separate
    // matter, and not decided here: `classifyPiAiError` labels a 403 "AUTH",
    // and the conversation replaces an AUTH failure's message with "API key is
    // invalid" (both channels' `dsh-client-ui-chat`), so on the planes
    // `PlaneAdapter` finishes the gateway's typed refusals as `FREE_TIER` or
    // `MODEL_UNAVAILABLE` with these words, and this status except on
    // Google-protocol models, whose failure text carries none
    // (`src/utils/gateway-refusal.ts`). pi-ai's own routes keep the bridge's
    // reading.
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
