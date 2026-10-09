/**
 * Deterministic OpenCode session identity.
 *
 * The gateway rejects requests without a valid OpenCode session id, and it must
 * stay stable for a DSH session or every turn looks like a new conversation to
 * the prompt cache. Everything here is a pure SHA-256 derivation — no table, no
 * randomness, no state to lose on restart.
 *
 * @module dsh-opencode-patch/session
 */

import { createHash } from "node:crypto";

/** Header carrying the derived OpenCode session id. */
export const SESSION_HEADER = "x-opencode-session";

/** Generic proxy session affinity header used by gateways and connection pools. */
export const SESSION_AFFINITY_HEADER = "x-session-affinity";

/** Header carrying the derived OpenCode parent session id for subagents. */
export const PARENT_SESSION_HEADER = "x-opencode-parent-session-id";

/** Generic parent session header used by third-party proxies. */
export const PARENT_SESSION_ALT_HEADER = "x-parent-session-id";

/** Canonical OpenCode CLI User-Agent the DSH LLM adapter strips. */
export const OPENCODE_UA =
  "opencode/1.18.33 ai-sdk/provider-utils/4.0.40 runtime/bun/1.3.14";

/**
 * The alphabet the official ids are written in: Crockford base32, which drops
 * I, L, O and U so a transcribed id cannot be misread.
 */
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** Characters in a ULID, and therefore in every official id suffix. */
const ULID_LENGTH = 26;

/** Bytes of SHA-256 needed for 26 base32 characters: 26 x 5 = 130 bits. */
const ULID_BYTES = 17;

/**
 * Derive a valid OpenCode session ID from a DSH sessionId.
 *
 * The official CLI mints `ses_` followed by a **ULID**: 26 characters of
 * Crockford base32, whose first 10 encode a millisecond timestamp. A gateway
 * validating the shape expects that alphabet, and this used to emit
 * `ses_<12hex><14base62>` — the right LENGTH in the wrong alphabet, since
 * base62 carries lowercase letters a ULID never contains.
 *
 * The suffix stays a pure function of the DSH session id: affinity has to
 * survive a host restart, and a real clock reading would mint a new id on every
 * boot. 26 characters is 130 bits, taken from the top of SHA-256.
 *
 * @param sessionId - DSH session identifier (stringified before hashing, so
 * numeric ids match their string form).
 */
export const openCodeSessionIdFor = (sessionId: string | number): string => {
  const hash = createHash("sha256").update(String(sessionId)).digest();
  // Arithmetic, never bitwise: the lint forbids the operators, and base 256
  // into base 32 needs only multiply and divide.
  let value = 0n;
  for (const byte of hash.subarray(0, ULID_BYTES)) {
    value = value * 256n + BigInt(byte);
  }
  // Drop the low bits so exactly 130 remain, then read them out in fives,
  // most significant digit first.
  value /= 2n ** BigInt(ULID_BYTES * 8 - ULID_LENGTH * 5);
  let suffix = "";
  for (let index = 0; index < ULID_LENGTH; index += 1) {
    suffix = (CROCKFORD[Number(value % 32n)] ?? "0") + suffix;
    value /= 32n;
  }
  return `ses_${suffix}`;
};
/**
 * Session id for a streamed turn, or `undefined` when there is none to carry.
 *
 * Always derives (pure SHA-256): raw DSH UUIDs satisfy no gateway, while
 * derived `ses_…` values route stably everywhere a UUID would.
 *
 * @param sessionId - the DSH session id carried by the turn.
 */
export const headerValueFor = (
  sessionId: string | number | undefined | null
): string | undefined => {
  if (sessionId === undefined || sessionId === null) {
    return undefined;
  }
  const raw = String(sessionId);
  if (raw.length === 0) {
    return undefined;
  }
  return openCodeSessionIdFor(raw);
};

/**
 * Fallback session id for requests issued outside any tracked turn.
 *
 * Prefers the configured environment variable (headless runs pin one id per
 * process) and otherwise derives a stable id for the reserved `"default"`
 * conversation.
 *
 * @param envName - environment variable consulted first; defaults to
 * `OPENCODE_SESSION_ID` when blank.
 */
export const fallbackSessionId = (envName?: string): string => {
  const name =
    envName !== undefined && envName.length > 0 ? envName : undefined;
  if (name !== undefined) {
    const envId: unknown = process.env[name];
    if (typeof envId === "string" && envId.length > 0) {
      return envId;
    }
  }
  return openCodeSessionIdFor("default");
};
