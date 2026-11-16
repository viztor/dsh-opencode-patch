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
 * The patch is a composition of stages, each a module of its own, in the
 * order they run: the claim (`claim.ts`), the body read once (`body.ts`), the
 * credential (`credential.ts`), the headers (`headers.ts`), then the body's
 * fallback and the call.
 *
 * @module dsh-opencode-patch/request/patch-fetch
 */

import type { AsyncLocalStorage } from "node:async_hooks";

import type { ResolvedPluginConfig } from "../config.ts";
import {
  createCaptureStore,
  createCredentials,
  type FetchCredentials,
} from "../credentials.ts";
import { extractApiKeyFromHeaders } from "../key-capture.ts";
import { enrichModelsResponse, isModelsListingUrl } from "../models-catalog.ts";
import { isOpenCodeSessionId, SESSION_HEADER } from "../session.ts";
import type { ActiveTurnState } from "../turn-store.ts";
import { gatewayPlaneFor, toolNamesIn } from "../utils/request-shape.ts";
import { applyCoreTools, readBody, withSentBody } from "./body.ts";
import { claimRequest } from "./claim.ts";
import { fillCredential, settleCredential } from "./credential.ts";
import { writePlaneHeaders } from "./headers.ts";

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

/**
 * Wrap `fetch` so claimed OpenCode requests carry the gateway's expected
 * headers and session id.
 *
 * @param original - the fetch implementation to wrap (usually `globalThis.fetch`).
 * @param als - turn store consulted for the session id of the current turn.
 * @param config - resolved plugin configuration.
 * @param hooks - the running plugin's seams into the request path.
 */
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
    const claimed = claimRequest(input, init, state, config);
    if (claimed === undefined) {
      return original.call(this, input, init);
    }
    const { headers, url } = claimed;

    // The body, read once, off whichever half carries it. Three things read
    // it: the free-model check on the credential path, the core-tool fallback
    // and the debug entry, and they share one parse.
    const body = await readBody(input, init);

    const { requestKey, wireHeader } = fillCredential({
      body,
      credentials,
      headers,
      keySource: config.keySource,
      state,
      url,
      warned: warnedNoCredential,
    });

    writePlaneHeaders({
      config,
      headers,
      resolveOrg: hooks.resolveOrg,
      sessionPin: (name) => credentials.sessionPin(name),
      state,
      url,
    });

    // 4. Core tool schema fallback for free-tier /responses models, over the
    // body read above; a toolless chat-completions body also gets
    // `tool_choice: "none"`.
    const sent = applyCoreTools(url, body, headers, {
      enabled: config.injectCoreTools,
      modelMarker: config.freeModelMarker,
    });
    const call = withSentBody(input, { ...init, headers }, body, sent);

    const response = await original.call(this, call.input, call.init);

    settleCredential({
      credentials,
      headers,
      requestKey,
      state,
      status: response.status,
      url,
      wireHeader,
    });

    // One line per request the interceptor touched, so a run that misbehaves can
    // be read back instead of guessed at. Presence, never values: whether a
    // credential, a session and an org were SENT is what explains an answer, and
    // the credential itself has no business in a log.
    hooks.debug?.({
      auth: extractApiKeyFromHeaders(headers) !== undefined,
      bodySource: body.source,
      claimed: true,
      org: headers.get("x-opencode-org-id") ?? null,
      plane: gatewayPlaneFor(url),
      request: headers.get("x-opencode-request") ?? null,
      session: headers.get(SESSION_HEADER) ?? null,
      sessionFormat: isOpenCodeSessionId(headers.get(SESSION_HEADER)),
      status: response.status,
      // What was SENT: the rewritten body's record, else the body as it came,
      // which names tools only when it is a string.
      toolNames: toolNamesIn(sent.record ?? body.json()),
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
