/**
 * Which catalog models the gateway serves by Google's discrete thinking LEVEL,
 * read from the catalog, for the cases that pick a subject by it.
 *
 * Google has two thinking controls, and a model accepts only its own: a
 * discrete `thinkingLevel`, or a token `thinkingBudget`. A model that thinks in
 * levels refuses a budget with 400 INVALID_ARGUMENT ("Thinking budget is not
 * supported for this model. Use thinking level instead."), measured live on the Go
 * plane's level-only model. Which control a request carries is pi's to decide
 * (`usesGoogleThinkingLevel` in `api/google-shared`), never the plugin's
 * (D26): this rule only lets a test name the models whose request a pi that
 * does not name them would build wrong, so the case can run where the
 * installed pi names them and skip, as a `HOST_LIMITATION`, where it does not.
 *
 * Pure: a function of its argument.
 *
 * @module test/support/thinking-levels
 */
import { protocolForSdk, type ReasoningSpec } from "./src.ts";

/** Google's discrete thinking levels (`thinkingConfig.thinkingLevel`). */
const GOOGLE_THINKING_LEVELS: ReadonlySet<string> = new Set([
  "minimal",
  "low",
  "medium",
  "high",
]);

/**
 * Whether the catalog describes a model's reasoning as Google's discrete
 * thinking levels: a reasoning model served on the Google protocol whose first
 * effort list with values names only `minimal`/`low`/`medium`/`high`. A
 * `budget_tokens` option beside it says a budget is ALSO accepted, which
 * leaves a level request valid, so it does not change the answer.
 *
 * @param spec - the catalog spec.
 * @returns whether the model thinks in levels.
 */
export const usesCatalogThinkingLevels = (
  spec: ReasoningSpec & { readonly provider_npm?: string }
): boolean => {
  if (
    spec.reasoning !== true ||
    protocolForSdk(spec.provider_npm) !== "google-generative-ai"
  ) {
    return false;
  }
  const values = spec.reasoning_options?.find(
    (option) => option.type === "effort" && (option.values?.length ?? 0) > 0
  )?.values;
  return (
    values !== undefined &&
    values.every((value) => GOOGLE_THINKING_LEVELS.has(value))
  );
};
