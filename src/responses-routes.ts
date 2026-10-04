/**
 * The gateway's Responses-API plane, as a dispatch table.
 *
 * OpenCode Zen serves exactly one model over `/responses` and every other model
 * over `/chat/completions` (measured 2026-10-04 against
 * `https://opencode.ai/zen/v1`: every other free model answers `403
 * FreeTierError` on `/chat/completions` and `500` on `/responses`;
 * `muse-spark-1.3-contributor-free` is the exact inverse).
 *
 * DSH cannot express "this model speaks a different format" — `llm-pi-ai`
 * carries one `api` per ROUTE (`modelProfile`/`modelOverride` both exclude
 * `api`), and `llm.registerAdapter` refuses a route that already has an adapter.
 * So the format has to be a property of a route, and the model has to be
 * dispatched to the route whose `api` already names it.
 *
 * This table is the one place that knows the split. {@link responsesRouteFor}
 * answers "which route should this call go to instead", and the `llm/stream`
 * hook in `stream-hook.ts` acts on it. The route itself is declared by this
 * plugin's own layer (`cordis.patch.yml`), so nothing here is user configuration.
 *
 * @module dsh-opencode-patch/responses-routes
 */

/** Route id serving the gateway's Responses-API plane. Declared in `cordis.patch.yml`. */
export const RESPONSES_ROUTE = "opencode-responses";

/** Route ids whose models are dispatched through {@link RESPONSES_ROUTE}. */
const COMPLETIONS_ROUTES = new Set<string>(["opencode"]);

/**
 * Model ids the gateway serves on `/responses` rather than `/chat/completions`.
 * Move a model between here and the route's `models` list in `cordis.patch.yml`
 * when the gateway moves it — `responses-routes.test.ts` asserts the two agree.
 */
export const RESPONSES_FORMAT_MODELS: readonly string[] = [
  "muse-spark-1.3-contributor-free",
];

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
 * @returns the route to dispatch through, or `undefined` to dispatch as asked.
 */
export const responsesRouteFor = (
  provider: unknown,
  model: unknown
): string | undefined => {
  if (typeof provider !== "string" || !COMPLETIONS_ROUTES.has(provider)) {
    return undefined;
  }
  if (typeof model !== "string") {
    return undefined;
  }
  return RESPONSES_FORMAT_MODELS.includes(model) ? RESPONSES_ROUTE : undefined;
};
