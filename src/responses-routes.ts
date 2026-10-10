/**
 * Which wire protocol each gateway model needs, and the internal route that
 * serves it.
 *
 * OpenCode Zen's provider-level SDK is `@ai-sdk/openai-compatible`; models.dev
 * names a DIFFERENT SDK per model only when that model needs one, so the
 * PRESENCE of `provider.npm` is the signal. Measured 2026-10-05 against
 * `https://models.dev/api.json`, across the 116 `opencode` models: 53 name
 * nothing (the default), **32 name `@ai-sdk/openai`**, **23 name
 * `@ai-sdk/anthropic`**, 8 name `@ai-sdk/google`.
 *
 * So the split is read from the vendor's metadata rather than kept as a list of
 * model ids we would have to notice changing. The hand-written list this
 * replaced named ONE model, and 54 more were on the wrong side of it.
 *
 * DSH cannot express "this model speaks a different format" — `llm-pi-ai`
 * carries one `api` per ROUTE (`modelProfile`/`modelOverride` both exclude
 * `api`), and `llm.registerAdapter` refuses a route that already has an adapter.
 * So the format has to be a property of a route, and a model has to be
 * dispatched to the route whose `api` already names it. {@link internalRouteFor}
 * answers which; the `llm/stream` hook acts on it, and `responses-provider.ts`
 * registers the routes — from the plugin, so the user changes nothing.
 *
 * @module dsh-opencode-patch/responses-routes
 */

/** The SDK whose presence means "this model is served on the Responses API". */
export const RESPONSES_SDK = "@ai-sdk/openai";

/** The SDK whose presence means "this model is served on the Messages API". */
export const ANTHROPIC_SDK = "@ai-sdk/anthropic";

/** The SDK whose presence means "this model is served on Mistral's API". */

/** Route serving the gateway's Responses-API models. */
export const RESPONSES_ROUTE = "opencode-responses";

/** Route serving the gateway's Messages-API models. */
export const ANTHROPIC_ROUTE = "opencode-anthropic";

/** Route serving the gateway's Mistral-API models. */

/** Route serving the Go plane's Responses-API models. */
export const GO_RESPONSES_ROUTE = "opencode-go-responses";

/** Route serving the Go plane's Messages-API models. */
export const GO_ANTHROPIC_ROUTE = "opencode-go-anthropic";

/**
 * The gateway planes: one base URL, one catalog and one credential each.
 *
 * A plane is a property of the ACCOUNT and the base URL, never of a model — the
 * same model id can exist on both planes and be served on a different shape in
 * each. Routes are keyed by (plane, protocol) for exactly that reason: an SDK
 * says which shape a model needs, never which plane it belongs to.
 */
export const PLANES = {
  opencode: "https://opencode.ai/zen/v1",
  "opencode-go": "https://opencode.ai/zen/go/v1",
};

/**
 * The route that serves each (plane, protocol) pair.
 *
 * The plane's own base route (`opencode`, `opencode-go`) is implicit: it is the
 * one a model naming no SDK stays on, and it is not in this table because it is
 * never a redirect target — a model already there has nowhere to go.
 */
export const ROUTE_FOR_PLANE_PROTOCOL: Readonly<
  Record<string, { baseURL: string; routes: Readonly<Record<string, string>> }>
> = {
  opencode: {
    baseURL: PLANES.opencode,
    routes: {
      "openai-responses": RESPONSES_ROUTE,
      "anthropic-messages": ANTHROPIC_ROUTE,
    },
  },
  "opencode-go": {
    baseURL: PLANES["opencode-go"],
    routes: {
      "openai-responses": GO_RESPONSES_ROUTE,
      "anthropic-messages": GO_ANTHROPIC_ROUTE,
    },
  },
} as const;

/**
 * The pi-ai protocol each SDK a model may name corresponds to, when that
 * protocol is not the route's own. Keys are models.dev `provider.npm` values.
 *
 * Only protocols `llm-pi-ai` actually implements belong here. Its
 * `supportedProtocols()` is `Object.keys(PROTOCOLS)`, which today includes
 * `openai-completions`, `openai-responses`, `anthropic-messages` AND
 * `mistral-conversations` — the last one carries its own compatibility gate
 * (`supportsMidConvoSystemMessages: "withhold"`), so it is supported on
 * purpose. `@ai-sdk/google` is absent because no Google protocol exists, and
 * its models keep failing on the completions route rather than being sent
 * somewhere invented.
 */
export const PROTOCOL_FOR_SDK: Readonly<Record<string, string>> = {
  [RESPONSES_SDK]: "openai-responses",
  [ANTHROPIC_SDK]: "anthropic-messages",
};

/**
 * SDKs whose dialect no `llm-pi-ai` protocol implements, so their models are
 * deliberately not offered.
 *
 * Every entry here is a DECISION, not an omission — and the distinction is the
 * point. A model naming an SDK that is in neither this set nor
 * `PROTOCOL_FOR_SDK` is a GAP: the catalog moved and the code did not, which is
 * how `mistral-large-4` went missing from the picker while every gate stayed
 * green. `catalog.test.ts` fails on that case and names the SDK.
 *
 * - `@ai-sdk/google` — no Google protocol exists, in pi-ai or here.
 *
 * `@ai-sdk/mistral` used to be listed here, on the belief that pi-ai had no
 * Mistral protocol. It does — `mistral-conversations`, with its own
 * compatibility gate — so `mistral-large-4` is served instead, through a route
 * of its own.
 */
export const UNSERVED_SDKS: ReadonlySet<string> = new Set([
  "@ai-sdk/google",
  "@ai-sdk/mistral",
]);

/** The route each non-default protocol is served from. */
/** The Zen plane's rows of {@link ROUTE_FOR_PLANE_PROTOCOL}. */
export const ROUTE_FOR_PROTOCOL: Readonly<Record<string, string>> = {
  "openai-responses": RESPONSES_ROUTE,
  "anthropic-messages": ANTHROPIC_ROUTE,
};

/** Every route this plugin registers for itself. */
export const INTERNAL_ROUTES: readonly string[] = Object.values(
  ROUTE_FOR_PLANE_PROTOCOL
).flatMap((plane) => Object.values(plane.routes));

/**
 * Whether a route id is one this plugin owns and keeps out of the UI.
 *
 * @param id - the route id to test.
 * @returns true when the plugin registered it for a non-default protocol.
 */
export const isInternalRoute = (id: unknown): boolean =>
  typeof id === "string" && INTERNAL_ROUTES.includes(id);

/**
 * Whether a model can be served at all.
 *
 * A model naming no SDK speaks the route's own api, and one naming an SDK in
 * {@link PROTOCOL_FOR_SDK} has a route to be dispatched to. Anything else names
 * a protocol `llm-pi-ai` does not implement, so offering it would be offering a
 * model that cannot work — it must not reach a listing the user picks from.
 *
 * @param providerNpm - the model's `provider.npm` from the catalog, if any.
 * @returns true when the model has somewhere to be served from.
 */
export const isServableSdk = (providerNpm?: unknown): boolean =>
  providerNpm === undefined ||
  (typeof providerNpm === "string" &&
    PROTOCOL_FOR_SDK[providerNpm] !== undefined);

/**
 * The route a call should be dispatched through instead, or `undefined` when the
 * call is already going to the right place.
 *
 * Guarded on the SOURCE route as well as the model: a redirected call comes back
 * through the same hook with `provider` already set to an internal route, and
 * redirecting that again would recurse.
 *
 * @param provider - the route the caller selected.
 * @param model - the model id it selected.
 * @param providerNpm - that model's `provider.npm` from the catalog, if any.
 * @returns the route to dispatch through, or `undefined` to dispatch as asked.
 */
export const internalRouteFor = (
  provider: unknown,
  model: unknown,
  providerNpm?: unknown
): string | undefined => {
  if (
    typeof provider !== "string" ||
    typeof model !== "string" ||
    typeof providerNpm !== "string"
  ) {
    return undefined;
  }
  // The plane comes from the route the caller selected, and it must BE a plane:
  // a redirected call arrives back here with `provider` already set to an
  // internal route, which is not a key in this table, so it cannot recurse.
  const plane = ROUTE_FOR_PLANE_PROTOCOL[provider];
  if (plane === undefined) {
    return undefined;
  }
  const protocol = PROTOCOL_FOR_SDK[providerNpm];
  return protocol === undefined ? undefined : plane.routes[protocol];
};
