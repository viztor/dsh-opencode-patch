/**
 * The gateway's refusals, given their own failure codes (L2).
 *
 * The gateway refuses a turn it will not serve with a typed body, and pi hands
 * the host that body inside its failure text. The host's bridge classifies the
 * text by status and words, and two of its readings hide the refusal from the
 * person in the conversation, measured on both channels' published chat UI
 * (`@deepseek-ai/dsh-client-ui-chat` `failureMessage` and `displayFailure`):
 *
 * - a 403 (`FreeTierError`, `RegionError`) reads as AUTH, and the conversation
 *   blanks an AUTH failure's message and shows "API key is invalid";
 * - "Free usage limit reached" (`FreeUsageLimitError`) reads as QUOTA by its
 *   words, on every protocol (Google's bare body included), shown as
 *   "Request quota exhausted." with the gateway's words dropped.
 *
 * `failureMessage` replaces six codes with words of its own: AUTH, QUOTA,
 * ACCOUNT_QUOTA, ACCOUNT_SIGNED_OUT, INTERRUPTED and ACCOUNT_SIGN_IN_REQUIRED.
 * Every other code shows the failure's own message, so the two codes here are
 * new ones, outside those six: {@link FREE_TIER_CODE} for the free tier's two
 * refusals and {@link MODEL_UNAVAILABLE_CODE} for the model's three. (The UI
 * is not a dependency of this repository, so that was read off the published
 * bundles and the host source, not exercised by a test here.) Neither code is
 * in dsh-llm's default retryable set (EMPTY_RESPONSE, RATE_LIMIT, SERVER,
 * TIMEOUT, TRANSPORT), which dsh-llm-retry reads before it retries a turn.
 *
 * pi's text keeps the gateway's body on every protocol, around one of four
 * heads (pi 1.5.2, measured; pi 1.3.0 shares the path): completions
 * `403: {…}`, Responses `opencode API error (403): {…}`, Anthropic
 * `403 {…}`, and Google the body alone. Google's text carries no status, which
 * is pi's gap and not filled here (D26): such a refusal gets its code and no
 * status. The message is never changed.
 *
 * @module dsh-opencode-patch/utils/gateway-refusal
 */

import { isRecord } from "./guards.ts";

/** The free tier refused the turn: `FreeTierError`, `FreeUsageLimitError`. */
export const FREE_TIER_CODE = "FREE_TIER";

/** The model is not served here: region, deprecation, protocol. */
export const MODEL_UNAVAILABLE_CODE = "MODEL_UNAVAILABLE";

/** The code each refusal type the gateway sends finishes with. */
export const GATEWAY_REFUSAL_CODES: Readonly<Record<string, string>> =
  Object.freeze({
    FreeTierError: FREE_TIER_CODE,
    FreeUsageLimitError: FREE_TIER_CODE,
    ModelDeprecated: MODEL_UNAVAILABLE_CODE,
    ModelProtocolUnsupported: MODEL_UNAVAILABLE_CODE,
    RegionError: MODEL_UNAVAILABLE_CODE,
  });

/** A refusal type, as a whole token anywhere in the text. */
const REFUSAL_TYPE =
  /\b(FreeTierError|FreeUsageLimitError|RegionError|ModelDeprecated|ModelProtocolUnsupported)\b/u;

/**
 * A status at the text's head: `403: `, `403 `, or `… (403): ` before any
 * body, and never a number inside the body. Only 1xx-5xx, because the host
 * rebuilds an error from the failure and refuses a status outside that range.
 */
const LEADING_STATUS = /^(?:[^{(]*\()?([1-5]\d{2})(?=[\s:)])/u;

/**
 * The refusal type a failure's text names, or `undefined`.
 *
 * @param message - pi's failure text.
 */
export const refusalTypeOf = (message: string): string | undefined =>
  REFUSAL_TYPE.exec(message)?.[1];

/**
 * The HTTP status at the head of pi's failure text, or `undefined`.
 *
 * @param message - pi's failure text.
 */
export const leadingStatusOf = (message: string): number | undefined => {
  const status = LEADING_STATUS.exec(message)?.[1];
  return status === undefined ? undefined : Number(status);
};

/**
 * A failure reclassified as the gateway's refusal, or `undefined` when its
 * text names none. The copy keeps every field, the message unchanged; the
 * status is the failure's own when it carries a number, else the text's head.
 *
 * @param failure - a failure record, as a stream's finish carries one.
 */
export const classifyGatewayRefusal = (
  failure: Readonly<Record<string, unknown>>
): Record<string, unknown> | undefined => {
  const { message } = failure;
  if (typeof message !== "string") {
    return undefined;
  }
  const type = refusalTypeOf(message);
  const code = type === undefined ? undefined : GATEWAY_REFUSAL_CODES[type];
  if (code === undefined) {
    return undefined;
  }
  const status =
    typeof failure.status === "number"
      ? failure.status
      : leadingStatusOf(message);
  return { ...failure, code, ...(status === undefined ? {} : { status }) };
};

/**
 * A stream chunk with its refusal reclassified: a copy when it is an error
 * finish whose failure classifies (chunks may be frozen), else the same
 * object.
 *
 * @param chunk - one chunk of a host stream.
 */
export const reclassifyFinish = (chunk: unknown): unknown => {
  if (!isRecord(chunk) || chunk.type !== "finish") {
    return chunk;
  }
  const { reason } = chunk;
  if (
    !isRecord(reason) ||
    reason.kind !== "error" ||
    !isRecord(reason.failure)
  ) {
    return chunk;
  }
  const failure = classifyGatewayRefusal(reason.failure);
  return failure === undefined
    ? chunk
    : { ...chunk, reason: { ...reason, failure } };
};

/**
 * A stream with its refusal reclassified, every other chunk passed through as
 * the same object. A consumer that stops early closes the source.
 *
 * @param chunks - a host stream.
 * @yields {unknown} each chunk, a refusal's finish as a reclassified copy.
 */
export const reclassifyRefusals = async function* reclassifyRefusals(
  chunks: AsyncIterable<unknown>
): AsyncGenerator {
  // oxlint-disable-next-line no-await-in-loop -- a stream is read in order, one chunk at a time.
  for await (const chunk of chunks) {
    yield reclassifyFinish(chunk);
  }
};
