/**
 * The fetch patch's credential stage: fill an empty or placeholder key on a
 * claimed request, and fold the gateway's answer back into the key's standing.
 *
 * Both halves go through `credentials.ts`, the one resolver: what this stage
 * owns is which header a protocol reads its key from, the Anthropic version
 * the protocol identifies itself by, and the once-per-plane report of a
 * request that leaves with no credential.
 *
 * @module dsh-opencode-patch/request/credential
 */

import type { FetchCredentials } from "../credentials.ts";
import { isOpenCodeSessionId, SESSION_HEADER } from "../session.ts";
import type { ActiveTurnState } from "../turn-store.ts";
import {
  type KeySourcePolicy,
  needsFill,
  usableKey,
} from "../utils/credential-policy.ts";
import {
  ANTHROPIC_VERSION,
  authHeaderFor,
  gatewayPlaneFor,
  planeForUrl,
} from "../utils/request-shape.ts";
import { isFreeModelBody, type RequestBody } from "./body.ts";

/** What {@link fillCredential} reads. */
export interface FillInputs {
  /** The claimed request's headers, written in place. */
  readonly headers: Headers;
  readonly url: string;
  /** The active turn, when the request belongs to one. */
  readonly state: ActiveTurnState | undefined;
  readonly body: RequestBody;
  readonly credentials: FetchCredentials;
  /** The deployment's key-source policy, named in the report. */
  readonly keySource: KeySourcePolicy;
  /** The planes already reported as missing a credential. */
  readonly warned: Set<string>;
}

/** What {@link fillCredential} found, for {@link settleCredential}. */
export interface FilledCredential {
  /** The request's own usable key, when it carried one the store may keep. */
  readonly requestKey: string | undefined;
  /** The header the request's protocol reads its key from. */
  readonly wireHeader: string;
}

/**
 * Fill a claimed request's credential when its wire key is empty or a
 * placeholder, or report once per plane that there was none to fill.
 */
export const fillCredential = ({
  body,
  credentials,
  headers,
  keySource,
  state,
  url,
  warned,
}: FillInputs): FilledCredential => {
  // The request's own key, recorded only when this request belongs to a turn
  // the plugin decorated (OC3): a key on a turnless request — a Console
  // call, another tool's background request — was not sent by the plugin,
  // and is never kept or replayed. A foreign turn and a marked request were
  // never claimed (`claim.ts`); the rule still takes both, so it is one
  // function.
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
        wireHeader === "authorization" ? `Bearer ${decision.key}` : decision.key
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
      !warned.has(plane) &&
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
      !isFreeModelBody(body, planeForUrl(url))
    ) {
      warned.add(plane);
      const { consulted } = decision;
      // The request's own key and a captured one answer "none" by
      // construction: every policy consults both ahead of the declared
      // variable, so either one present would have filled the wire.
      const sources: string[] = [
        "a key on the request: none",
        `a key captured from a live request (policy ${keySource}): none`,
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
  return { requestKey, wireHeader };
};

/** What {@link settleCredential} reads. */
export interface SettleInputs extends FilledCredential {
  readonly credentials: FetchCredentials;
  /** The headers the request was sent with. */
  readonly headers: Headers;
  readonly state: ActiveTurnState | undefined;
  /** The gateway's status. */
  readonly status: number;
  readonly url: string;
}

/**
 * Fold the gateway's answer into the standing of the key the request carried.
 */
export const settleCredential = ({
  credentials,
  headers,
  requestKey,
  state,
  status,
  url,
  wireHeader,
}: SettleInputs): void => {
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
    status,
    url,
  });
};
