/**
 * The plane headers (session, parent, org, origin), from the one table
 * `planeHeadersFor` builds, written by two writers.
 *
 * - **Per call** ({@link callHeadersFor}): the plane adapter's
 *   `prepareHeaders` (OC5) writes them on a decorated turn's own requests,
 *   and marks the turn so the fetch patch leaves them alone (L1's per-call
 *   shaping).
 * - **In the fetch patch** ({@link writePlaneHeaders}): a relay, a turnless
 *   URL-claimed request and a turn the plane adapter did not shape. On a turn
 *   the adapter shaped, the patch writes none of them while the request
 *   carries a well-formed session id: the adapter's are the plugin's own, and
 *   a contributor's change to them is the contributor's.
 *
 * @module dsh-opencode-patch/request/headers
 */

import type { AsyncLocalStorage } from "node:async_hooks";

import type { ResolvedPluginConfig } from "../config.ts";
import {
  digestOf,
  isOpenCodeSessionId,
  OPENCODE_UA,
  SESSION_HEADER,
  sessionIdForRequest,
} from "../session.ts";
import type { ActiveTurnState } from "../turn-store.ts";
import {
  gatewayPlaneFor,
  type PlaneHeaderInputs,
  planeHeadersFor,
  projectHeaderOf,
} from "../utils/request-shape.ts";

/** The origin headers a turn carries, when the deployment sends them. */
const originFor = (
  config: ResolvedPluginConfig,
  state: ActiveTurnState | undefined
): PlaneHeaderInputs["origin"] =>
  config.injectOriginHeaders
    ? {
        client: config.originClient,
        project: config.injectProject
          ? projectHeaderOf(state?.project)
          : undefined,
        request: state?.requestValue,
      }
    : undefined;

/**
 * The plane headers of the current turn, written per call by the plane
 * adapter's `prepareHeaders` (OC5): the values the stream hook derived for the
 * turn, from the one table the fetch patch writes from. A request outside any
 * turn the plugin decorated, or on another plugin's plane, gets none, and the
 * turn is marked so the fetch patch leaves what was set here alone.
 *
 * @param als - the turn store the stream hook fills.
 * @param config - the plugin's settings.
 * @returns the writer `installRouteClaim` hands the adapter.
 */
export const callHeadersFor =
  (als: AsyncLocalStorage<ActiveTurnState>, config: ResolvedPluginConfig) =>
  (headers: Headers): void => {
    const state = als.getStore();
    if (state === undefined || state.foreign === true) {
      return;
    }
    for (const [name, value] of planeHeadersFor({
      org: config.credentialOrg,
      origin: originFor(config, state),
      parent: state.parentValue,
      relay: !state.provider.startsWith("opencode"),
      session: state.value,
    })) {
      headers.set(name, value);
    }
    state.perCall = true;
  };

/** What {@link writePlaneHeaders} reads. */
export interface HeaderStageInputs {
  /** The claimed request's headers, written in place. */
  readonly headers: Headers;
  readonly url: string;
  /** The active turn, when the request belongs to one. */
  readonly state: ActiveTurnState | undefined;
  readonly config: ResolvedPluginConfig;
  /** The pinned session id a deployment exported under `sessionIdEnv`. */
  readonly sessionPin: (name: string | undefined) => string | undefined;
  /** The org a plane's credential belongs to, when the deployment knows it. */
  readonly resolveOrg?: (plane: string) => string | undefined;
}

/**
 * The fetch patch's header stage: the plane headers, unless the plane adapter
 * shaped this request per call, and the User-Agent either way.
 */
export const writePlaneHeaders = ({
  config,
  headers,
  resolveOrg,
  sessionPin,
  state,
  url,
}: HeaderStageInputs): void => {
  // The plane headers (`planeHeadersFor`, the one table the per-call seam
  // writes from too). On a turn the plane adapter shaped per call (OC5) a
  // request that carries a well-formed session id keeps the headers it was
  // given; a malformed one is still replaced, because the gateway answers
  // it with `401 Invalid API key` (L8), whoever wrote it.
  const shaped =
    state?.perCall === true && isOpenCodeSessionId(headers.get(SESSION_HEADER));
  if (!shaped) {
    const sessionVal = sessionIdForRequest(
      state?.value,
      headers.get(SESSION_HEADER),
      sessionPin(config.sessionIdEnv),
      digestOf
    );
    // The org: the configured one wins, because it is the one thing here
    // the user said out loud; the hook is the deployment's own source.
    const org = config.credentialOrg ?? resolveOrg?.(gatewayPlaneFor(url));
    for (const [name, value] of planeHeadersFor({
      org,
      origin: originFor(config, state),
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
};
