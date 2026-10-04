/**
 * Which models the gateway serves on the Responses API, and where to send them.
 *
 * OpenCode Zen's provider-level SDK is `@ai-sdk/openai-compatible`; models.dev
 * names a DIFFERENT SDK per model only when that model needs one. Measured
 * 2026-10-05 against `https://models.dev/api.json`, across the 116 `opencode`
 * models: 53 name nothing (the default), **32 name `@ai-sdk/openai`**, 23 name
 * `@ai-sdk/anthropic`, 8 name `@ai-sdk/google`.
 *
 * `@ai-sdk/openai` is the OpenAI SDK proper, which speaks the Responses API —
 * the same mapping OpenCode's own adapter applies. So the split is read from the
 * vendor's metadata rather than kept as a list of model ids we would have to
 * notice changing: the hand-written list this replaced named ONE model, and 31
 * more were already on the wrong side of it.
 *
 * DSH cannot express "this model speaks a different format" — `llm-pi-ai`
 * carries one `api` per ROUTE (`modelProfile`/`modelOverride` both exclude
 * `api`), and `llm.registerAdapter` refuses a route that already has an adapter.
 * So the format has to be a property of a route, and the model has to be
 * dispatched to the route whose `api` already names it.
 *
 * {@link responsesRouteFor} answers "which route should this call go to
 * instead"; the `llm/stream` hook in `stream-hook.ts` acts on it. The route
 * itself is declared in the profile (`cordis.patch.yml`), because a second
 * `llm-pi-ai` row cannot mount.
 *
 * @module dsh-opencode-patch/responses-routes
 */

/** Route id serving the gateway's Responses-API plane. */
export const RESPONSES_ROUTE = "opencode-responses";

/** The SDK whose presence means "this model is served on the Responses API". */
export const RESPONSES_SDK = "@ai-sdk/openai";

/**
 * The pi-ai protocol each SDK a model may name corresponds to, when that
 * protocol is not the route's own. Keys are models.dev `provider.npm` values.
 *
 * Only entries that CHANGE the answer belong here. `@ai-sdk/google` is absent
 * because `llm-pi-ai` has no such protocol — `supportedProtocols()` is
 * `openai-completions`, `openai-responses`, `anthropic-messages` — so those
 * models have no route to be dispatched to.
 */
const PROTOCOL_FOR_SDK: Readonly<Record<string, string>> = {
  [RESPONSES_SDK]: "openai-responses",
};

/** Route ids whose models are dispatched through {@link RESPONSES_ROUTE}. */
const COMPLETIONS_ROUTES = new Set<string>(["opencode"]);

/**
 * The route a call should be dispatched through instead, or `undefined` when the
 * call is already going to the right place.
 *
 * Guarded on the SOURCE route as well as the model: the redirected call comes
 * back through the same hook with `provider` already set to
 * {@link RESPONSES_ROUTE}, and redirecting that again would recurse.
 *
 * @param provider - the route the caller selected.
 * @param model - the model id it selected.
 * @param providerNpm - that model's `provider.npm` from the catalog, if any.
 * @returns the route to dispatch through, or `undefined` to dispatch as asked.
 */
export const responsesRouteFor = (
  provider: unknown,
  model: unknown,
  providerNpm?: unknown
): string | undefined => {
  if (typeof provider !== "string" || !COMPLETIONS_ROUTES.has(provider)) {
    return undefined;
  }
  if (typeof model !== "string") {
    return undefined;
  }
  if (
    typeof providerNpm !== "string" ||
    PROTOCOL_FOR_SDK[providerNpm] !== "openai-responses"
  ) {
    return undefined;
  }
  return RESPONSES_ROUTE;
};
