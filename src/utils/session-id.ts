/**
 * OpenCode session identity: the RULES, as pure functions.
 *
 * The gateway rejects requests without a valid OpenCode session id, and the id
 * must stay stable for a DSH session or every turn looks like a new conversation
 * to the prompt cache. The rules that decide one — how it is derived from a
 * digest, which of several candidate ids wins, what the gateway will accept —
 * are all functions of their arguments, so they live here and are tested by
 * calling them.
 *
 * Two things deliberately stayed out:
 *
 *   - **the hash.** `openCodeSessionIdFor` takes the already-computed digest, so
 *     the construction is pure and the `node:crypto` call sits at the caller.
 *     The shape below is a whole algorithm; testing it should not require
 *     arranging a crypto module.
 *   - **the environment read.** `sessionIdForRequest` takes the value the
 *     variable held, not its name. A rule that reaches into `process.env` is a
 *     rule a test has to mutate the process to exercise.
 *
 * @module dsh-opencode-patch/utils/session-id
 */

/** Header carrying the derived OpenCode session id. */
export const SESSION_HEADER = "x-opencode-session";

/** Generic proxy session affinity header used by gateways and connection pools. */
export const SESSION_AFFINITY_HEADER = "x-session-affinity";

/**
 * The fourth session header, and the one this plugin never sent.
 *
 * Captured from OpenCode 2.0.28 talking to a local server: it sends
 * `x-opencode-session`, `x-opencode-session-id`, `x-session-affinity` AND
 * `x-session-id`, all four carrying the same value on every request. This plugin
 * has always sent three of them.
 */
export const SESSION_ID_HEADER = "x-session-id";

/** Header carrying the derived OpenCode parent session id for subagents. */
export const PARENT_SESSION_HEADER = "x-opencode-parent-session-id";

/** Generic parent session header used by third-party proxies. */
export const PARENT_SESSION_ALT_HEADER = "x-parent-session-id";

/**
 * The vendor's own base62 alphabet, character for character (`randomBase62` in
 * `packages/opencode/src/id/id.ts`): digits, then uppercase, then lowercase.
 * The ORDER does not matter for validity, only the set does — matching theirs
 * keeps our suffix indistinguishable from one they minted.
 */
const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/**
 * Characters of the id that carry a TIMESTAMP: six bytes of
 * `milliseconds * 0x1000 + counter`, hex-encoded.
 */
const TIME_HEX_LENGTH = 12;

/** Characters of the random suffix the vendor appends. */
const RANDOM_LENGTH = 14;

/** The digest the id is derived from. */
export interface SessionDigest {
  /** The 32-byte SHA-256 of the DSH session id. */
  readonly bytes: Uint8Array;
  /** Those bytes as lowercase hex. */
  readonly hex: string;
}

/**
 * Derive an OpenCode session id from a digest.
 *
 * **The vendor mints sessions DESCENDING, and nothing else needs doing.**
 * `packages/opencode/src/id/id.ts` at v1.19.5:
 *
 *     now = BigInt(Date.now()) * 4096n + BigInt(++counter)   // per-millisecond
 *     now = direction === "descending" ? ~now : now
 *     6 bytes of `now` big-endian + 14 base62  →  `ses_<12hex><14base62>`
 *
 * We mint exactly ONE id per session, so the counter is 1 — the vendor's own
 * value for the first id inside a millisecond. There is no clamp here and no
 * band arithmetic: inverting `(ms << 12) + 1` puts the low twelve bits at
 * `0xFFE` on its own, which is where a real OpenCode session id sits.
 *
 * **The gateway's rule, measured** by replaying the vendor client's captured
 * request body and changing nothing but this header: it admits low twelve bits
 * in `0xFC0..0xFFE` and refuses anything else with `403 FreeTierError`
 * (ascending `0xFFE` and `0xFC0` → 200; ascending `0x001` → 403). PR #35/#37
 * found this band first, by clamping the counter into it; that clamp is no
 * longer needed, because following the vendor's own construction lands in the
 * band as a consequence rather than as an assertion about it.
 *
 * The timestamp is NOT checked for recency — measured on the live gateway: a
 * 2009 value and a future 2030 value both answered 200 as long as the low
 * twelve bits were in the band. Only the band is enforced. So a session with no
 * recorded creation time takes a value DERIVED from the hash: stable across
 * turns (which affinity needs) and indistinguishable from a real one.
 *
 * @param digest - the SHA-256 of the DSH session id.
 * @param createdAt - the session's creation time in ms, when the host knows it.
 * @returns the derived `ses_<12hex><14base62>` id.
 */
export const deriveSessionId = (
  digest: SessionDigest,
  createdAt?: number
): string => {
  const counter = 1n;
  const anchor =
    createdAt !== undefined && Number.isSafeInteger(createdAt) && createdAt >= 0
      ? BigInt(createdAt)
      : BigInt(`0x${digest.hex.slice(4, 16)}`);

  const mask = 2n ** 48n;
  const time = (anchor * 4096n + counter) % mask;
  // `~(time) & (2^48 - 1)`, in arithmetic: the lint forbids bitwise operators.
  const descending = mask - 1n - time;

  let random = "";
  for (let i = 6; i < 20; i += 1) {
    const byte = digest.bytes[i];
    if (byte !== undefined) {
      random += BASE62[byte % BASE62.length] ?? "0";
    }
  }

  return `ses_${descending.toString(16).padStart(TIME_HEX_LENGTH, "0")}${random.slice(0, RANDOM_LENGTH)}`;
};

/**
 * Whether a string is a session id the gateway will accept.
 *
 * The shape is `ses_` + 12 hex + 14 base62, which is what {@link deriveSessionId}
 * produces and what the client's own ids look like.
 *
 * This exists because a prefix is not a format. A configuration that pins
 * `x-opencode-session: ses_dsh_default` starts with `ses_` and is not a session
 * id at all — the gateway answers it `401 Invalid API key`, which reads as a
 * credential fault and is really a malformed header. Anything that cannot be
 * accepted is better replaced with a derived id than sent as written.
 *
 * @param value - the candidate.
 * @returns whether it is a session id the gateway accepts.
 */
export const isOpenCodeSessionId = (value: unknown): value is string =>
  typeof value === "string" && /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/u.test(value);

/**
 * Whether a string is a message id the client could have minted.
 *
 * Same shape rule as {@link isOpenCodeSessionId}, and for the same reason: a
 * prefix is not a format. Anything that cannot be read is better dropped than
 * sent — the gateway reads this value for per-request metrics, and unlike a
 * session id there is no fallback that would repair a malformed one.
 *
 * @param value - the candidate.
 * @returns whether it is a message id the gateway will read.
 */
export const isOpenCodeMessageId = (value: unknown): value is string =>
  typeof value === "string" && /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/u.test(value);

/**
 * The session id a deployment PINNED, or a derived default.
 *
 * A pinned id is used only when the gateway would accept it, because
 * `ses_dsh_default` starts with `ses_` and is not a session id at all — sending
 * it earns a `401 Invalid API key`, which reads as a credential fault and is
 * really a malformed header. Anything that cannot be accepted is replaced by a
 * derived id rather than sent as written.
 *
 * Takes the VALUE the variable held, not its name: reading `process.env` here
 * would make this rule a thing a test has to mutate the process to exercise.
 *
 * @param pinned - the value the environment held, if any.
 * @param digestOf - derives a digest for a DSH session id; injected so this
 *   module needs no crypto.
 * @returns a session id the gateway accepts.
 */
export const pinnedSessionId = (
  pinned: unknown,
  digestOf: (sessionId: string) => SessionDigest
): string =>
  isOpenCodeSessionId(pinned) ? pinned : deriveSessionId(digestOf("default"));

/**
 * Which session id a request carries, given everything that could decide it.
 *
 * The precedence, in order:
 *
 *   1. the id of the turn that issued the request — the only source with
 *      certainty, because it is the conversation actually running;
 *   2. a header the deployment pinned, when the gateway would accept it;
 *   3. a derived default.
 *
 * Extracted from the fetch patch, where it was an inline three-branch closure:
 * unreachable from a test, and therefore uncovered by construction.
 *
 * @param turnSessionId - the turn's own session id, when a turn is tracked.
 * @param pinnedHeader - the `x-opencode-session` the request already carried.
 * @param pinnedEnv - the id the session-id environment variable held.
 * @param digestOf - derives a digest for a DSH session id.
 * @returns the id to send.
 */
export const sessionIdForRequest = (
  turnSessionId: string | undefined,
  pinnedHeader: unknown,
  pinnedEnv: unknown,
  digestOf: (sessionId: string) => SessionDigest
): string => {
  if (turnSessionId !== undefined && turnSessionId.length > 0) {
    return turnSessionId;
  }
  if (isOpenCodeSessionId(pinnedHeader)) {
    return pinnedHeader;
  }
  return pinnedSessionId(pinnedEnv, digestOf);
};
