/**
 * How a live probe's answer is READ — the rules that decide skip, and the rules
 * that decide failure.
 *
 * These live here, outside the e2e file, for the reason every other pure
 * predicate in this repository was extracted: **a predicate that lives in a
 * closure cannot be exercised alone**. The e2e suite only runs with a key
 * against the live gateway, so a rule in there is tested by the vendor's
 * schedule — and the rules are exactly what decides whether a red run means
 * "the plugin is wrong" or "the vendor moved".
 *
 * The distinction is not academic. Two of the last four rotations turned a live
 * case red for a vendor-side reason (a retired model answered `410`, a loaded
 * gateway answered `429`), and each time the fix was to the RULE, not to the
 * plugin. Those rules are now unit-tested.
 *
 * @module test/e2e/verdict
 */

/** What one endpoint said about one model. */
export interface Probe {
  /** The HTTP status, or `0` when nothing answered at all. */
  readonly status: number;
  /** The body, truncated — the gateway names its refusals in it. */
  readonly summary: string;
}

/**
 * Whether the free tier's usage cap answered: `429 FreeUsageLimitError`, the
 * gate refusing the caller's usage of the tier. It is one way the tier is
 * closed ({@link freeTierClosed}), but a different fact from the session
 * gate: it measures the account a run spends from, not whether the tier
 * serves this plugin, so a case that met only the cap reports the cap.
 *
 * @param result - the probe's answer.
 * @returns whether the answer names the usage cap.
 */
export const freeUsageCapped = (result: Probe): boolean =>
  result.summary.includes("FreeUsageLimitError");

/**
 * Whether the gateway is refusing the FREE TIER rather than the route.
 *
 * Measured: the deployment's key answers `403 FreeTierError` on every endpoint,
 * with and without an org id, and the literal `public` answers the same — while
 * a real client, whose captured request carries a session token, is served.
 *
 * Read that as a statement about the CLIENT, not the credential: the gateway's
 * message is "OpenCode's free tier can only be used from within OpenCode", and
 * presenting as that client is what this plugin does. So a refusal here is not
 * the plugin's failure to route — it is a gate this repository cannot open.
 *
 * @param result - the probe's answer.
 * @returns whether the free tier closed the request.
 */
export const freeTierClosed = (result: Probe): boolean =>
  result.summary.includes("FreeTierError") ||
  // The tier's usage cap, `429 FreeUsageLimitError`, is the same gate
  // refusing for the caller's usage: closed, not busy (lesson L3).
  freeUsageCapped(result);

/**
 * Whether the account cannot spend on this model — an entitlement answer, not a
 * routing answer.
 *
 * Four shapes, and they are not the same refusal: `402` is "no funds", a `403`
 * naming `Model access is disabled` is a per-model entitlement, a `429` is the
 * gateway's own load ({@link gatewayBusy}) or the free tier's usage cap
 * ({@link freeUsageCapped}) — neither says anything about the route — and `0`
 * is silence.
 *
 * @param result - the probe's answer.
 * @returns whether the account (or the gateway) refused for a reason other than
 * routing.
 */
export const accessDisabled = (result: Probe): boolean =>
  result.status === 402 ||
  result.summary.includes("Insufficient account funds") ||
  (result.status === 403 &&
    result.summary.includes("Model access is disabled")) ||
  result.status === 429 ||
  // No answer at all is the third shape of "cannot tell": the gateway is busy,
  // so nothing about the route was observed either way.
  result.status === 0;

/**
 * The gateway says this model is retired.
 *
 * **The registry does not always know.** The catalog's deprecation flag is the
 * vendor's own bookkeeping and the gateway's answer is the authority: a model
 * can still be listed, still be priced, and still sit in the catalog's active
 * slice while the gateway answers `410 ModelDeprecated`. Measured: the registry
 * listed `gemini-3-flash` as active while the gateway refused it.
 *
 * A third shape says the same thing about an upstream rather than the
 * gateway's own entry: `400 Upstream request failed: Model is unavailable`.
 * Measured on a free model the catalog still listed as active, answered
 * identically on two runs a minute apart. The status alone is not enough — a
 * `400` is also how a malformed request is refused — so the body has to say it.
 *
 * Such a model is not a subject to assert on — the case would fail on a
 * retirement the plugin had nothing to do with.
 *
 * @param result - the probe's answer.
 * @returns whether the answer is a retirement.
 */
export const retiredAtTheGateway = (result: Probe): boolean =>
  result.status === 410 ||
  result.summary.includes("ModelDeprecated") ||
  (result.status === 400 && result.summary.includes("Model is unavailable"));

/**
 * The gateway is busy: it answered, but not about the route. A 429 naming the
 * free tier's usage cap is not busy: it is the tier closing
 * ({@link freeTierClosed}).
 */
export const gatewayBusy = (result: Probe): boolean =>
  result.status === 429 && !freeUsageCapped(result);

/** Why a walk of free candidates ended without a completion. */
export type FreeWalkGap = "busy" | "capped" | "closed";

/**
 * Why no free candidate answered with a completion, from every answer the
 * walk read: `busy` when the gateway was loaded for any of them
 * ({@link gatewayBusy}), which says nothing about the tier; else `capped`
 * when any met the usage cap ({@link freeUsageCapped}), which measures the
 * account, not the tier; else `closed` — each was gated, withdrawn or
 * refused for the account, which is worth reporting rather than skipping.
 *
 * @param answers - every candidate's answer, in the order sent.
 * @returns why the walk found no completion.
 */
export const freeWalkGap = (answers: readonly Probe[]): FreeWalkGap => {
  if (answers.some(gatewayBusy)) {
    return "busy";
  }
  return answers.some(freeUsageCapped) ? "capped" : "closed";
};

/**
 * Whether a candidate model may be USED as a case's subject.
 *
 * The rule the pickers apply: a candidate that answered is a subject, except
 * when the answer was about the account (a refusal) or about the model's
 * retirement. Both are vendor-side facts, and a case built on either fails for
 * a reason that is not its own.
 *
 * @param result - the probe's answer for this candidate.
 * @returns whether the case may proceed with this model.
 */
export const usableAsSubject = (result: Probe): boolean =>
  !accessDisabled(result) &&
  !retiredAtTheGateway(result) &&
  result.status !== 0;
