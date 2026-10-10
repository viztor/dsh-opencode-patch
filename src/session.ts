/**
 * Deterministic OpenCode session identity.
 *
 * The gateway rejects requests without a valid OpenCode session id, and it must
 * stay stable for a DSH session or every turn looks like a new conversation to
 * the prompt cache. Everything here is a pure derivation from the DSH session
 * id and, when the Host knows it, the session's creation time — no table, no
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
  "opencode/1.18.35 ai-sdk/provider-utils/4.0.40 runtime/bun/1.3.14";

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

/** Characters the vendor fills with `randomBase62`. */
const RANDOM_LENGTH = 14;

/**
 * Derive a valid OpenCode session ID: `ses_` + 12 hex + 14 base62.
 *
 * The shape is read off the vendor's own generator rather than inferred
 * (`packages/opencode/src/id/id.ts`):
 *
 * ```ts
 * let now = BigInt(currentTimestamp) * BigInt(0x1000) + BigInt(counter)
 * return prefix + "_" + timeBytes.toString("hex") + randomBase62(LENGTH - 12)
 * ```
 *
 * **Those twelve characters are a timestamp, and the vendor reads them back.**
 * Their `timestamp(id)` divides the hex by `0x1000` to recover milliseconds, so
 * filling them with hash bytes hands them a random creation instant — often in
 * the future — and a non-hex alphabet makes that parser throw. When the Host
 * tells us the session's creation time, that is what goes in.
 *
 * Everything else is derived from the DSH session id, so the value is stable:
 * the same conversation presents the same id on every turn, in every process,
 * and after a restart, which is what session affinity needs. The 12-bit counter
 * only disambiguates ids minted within one millisecond, so it comes from the
 * hash — deterministic and free.
 *
 * With no creation time the timestamp is the one thing this function cannot
 * supply honestly. It then falls back to hash bits, which is the degraded case:
 * the id is still valid and still stable, but its embedded time is not a time.
 *
 * @param sessionId - DSH session identifier (stringified before hashing, so
 * numeric ids match their string form).
 * @param createdAt - the session's creation time in milliseconds, when known.
 */
export const openCodeSessionIdFor = (
  sessionId: string | number,
  createdAt?: number
): string => {
  const hash = createHash("sha256").update(String(sessionId)).digest();

  // The counter occupies the low twelve bits: all of `hash[0]` and the high
  // nibble of `hash[1]`. Arithmetic, not bitwise — the lint forbids the
  // operators, and the value only has to be stable, not well distributed.
  const counter = (hash[0] ?? 0) * 16 + Math.floor((hash[1] ?? 0) / 16);

  const time =
    createdAt !== undefined && Number.isSafeInteger(createdAt) && createdAt >= 0
      ? (BigInt(createdAt) * 4096n + BigInt(counter)) % 2n ** 48n
      : BigInt(`0x${hash.subarray(0, 6).toString("hex")}`);

  let random = "";
  for (let i = 6; i < 20; i += 1) {
    const byte = hash[i];
    if (byte !== undefined) {
      random += BASE62[byte % BASE62.length] ?? "0";
    }
  }

  return `ses_${time.toString(16).padStart(TIME_HEX_LENGTH, "0")}${random.slice(0, RANDOM_LENGTH)}`;
};

/**
 * Session id for a streamed turn, or `undefined` when there is none to carry.
 *
 * Always derives: raw DSH UUIDs satisfy no gateway, while derived `ses_…`
 * values route stably everywhere a UUID would.
 *
 * @param sessionId - the DSH session id carried by the turn.
 * @param createdAt - that session's creation time in milliseconds, when the
 * Host's session service can supply it.
 */
export const headerValueFor = (
  sessionId: string | number | undefined | null,
  createdAt?: number
): string | undefined => {
  if (sessionId === undefined || sessionId === null) {
    return undefined;
  }
  const raw = String(sessionId);
  if (raw.length === 0) {
    return undefined;
  }
  return openCodeSessionIdFor(raw, createdAt);
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
