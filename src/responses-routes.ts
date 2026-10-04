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

/** Route serving the gateway's Responses-API models. */
export const RESPONSES_ROUTE = "opencode-responses";

/** Route serving the gateway's Messages-API models. */
export const ANTHROPIC_ROUTE = "opencode-anthropic";

/**
 * The pi-ai protocol each SDK a model may name corresponds to, when that
 * protocol is not the route's own. Keys are models.dev `provider.npm` values.
 *
 * Only protocols `llm-pi-ai` actually implements belong here — its
 * `supportedProtocols()` is `openai-completions`, `openai-responses` and
 * `anthropic-messages`. `@ai-sdk/google` is therefore absent: 8 models name it
 * and there is no route to dispatch them to, so they keep failing on the
 * completions route rather than being sent somewhere invented.
 */
export const PROTOCOL_FOR_SDK: Readonly<Record<string, string>> = {
  [RESPONSES_SDK]: "openai-responses",
  [ANTHROPIC_SDK]: "anthropic-messages",
};

/** The route each non-default protocol is served from. */
export const ROUTE_FOR_PROTOCOL: Readonly<Record<string, string>> = {
  "openai-responses": RESPONSES_ROUTE,
  "anthropic-messages": ANTHROPIC_ROUTE,
};

/** Every route this plugin registers for itself. */
export const INTERNAL_ROUTES: readonly string[] =
  Object.values(ROUTE_FOR_PROTOCOL);

/** Route ids whose models are dispatched to an internal route. */
const COMPLETIONS_ROUTES = new Set<string>(["opencode"]);

/**
 * Whether a route id is one this plugin owns and keeps out of the UI.
 *
 * @param id - the route id to test.
 * @returns true when the plugin registered it for a non-default protocol.
 */
export const isInternalRoute = (id: unknown): boolean =>
  typeof id === "string" && INTERNAL_ROUTES.includes(id);

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
  if (typeof provider !== "string" || !COMPLETIONS_ROUTES.has(provider)) {
    return undefined;
  }
  if (typeof model !== "string" || typeof providerNpm !== "string") {
    return undefined;
  }
  const protocol = PROTOCOL_FOR_SDK[providerNpm];
  return protocol === undefined ? undefined : ROUTE_FOR_PROTOCOL[protocol];
};
