/**
 * Deterministic OpenCode session identity.
 *
 * The gateway rejects requests without a valid `ses_<12hex><14base62>`
 * session id, and it must stay stable for a DSH session or every turn looks
 * like a new conversation to the prompt cache. Everything here is a pure
 * SHA-256 derivation — no table, no randomness, no state to lose on restart.
 *
 * @module dsh-opencode-patch/session
 */

import { createHash } from "node:crypto";

/** Header carrying the derived OpenCode session id. */
export const SESSION_HEADER = "x-opencode-session";

/** Header carrying the derived OpenCode parent session id for subagents. */
export const PARENT_SESSION_HEADER = "x-opencode-parent-session-id";

/** Canonical OpenCode CLI User-Agent the DSH LLM adapter strips. */
export const OPENCODE_UA =
  "opencode/1.18.33 ai-sdk/provider-utils/4.0.40 runtime/bun/1.3.14";

const BASE62 = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

/**
 * Derive a valid OpenCode session ID (`ses_<12hex><14base62>`)
 * deterministically from a DSH sessionId.
 *
 * @param sessionId - DSH session identifier (stringified before hashing, so
 * numeric ids match their string form).
 */
export const openCodeSessionIdFor = (sessionId: string | number): string => {
  const hash = createHash("sha256").update(String(sessionId)).digest();
  const hexPart = hash.subarray(0, 6).toString("hex");
  let randPart = "";
  for (let i = 6; i < 20; i += 1) {
    const byte = hash[i];
    if (byte !== undefined) {
      randPart += BASE62[byte % BASE62.length];
    }
  }
  return `ses_${hexPart}${randPart}`;
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
