/**
 * `utils/session-id.ts` · the pure half of a session id.
 *
 * Every rule here takes its digest as an argument, so each case hands it a
 * DETERMINISTIC one and checks the construction against the vendor's own
 * arithmetic, restated in the test rather than read from the module: a test
 * that asks the implementation what it does can only ever agree with it.
 *
 * The effect half — hashing a DSH session id and reading the environment — is
 * `test/session.test.ts`.
 *
 * @module test/session-id.test
 */

import { describe, expect, it } from "vitest";

import {
  deriveSessionId,
  isOpenCodeMessageId,
  isOpenCodeSessionId,
  pinnedSessionId,
  type SessionDigest,
  sessionIdForRequest,
} from "./support/src.ts";

/** The vendor's alphabet (`randomBase62` in `packages/opencode/src/id/id.ts`). */
const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

const MASK = 2n ** 48n;

const hexOf = (bytes: Uint8Array): string =>
  [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");

/** A digest built from fixed bytes, so the expected suffix can be computed. */
const fixedDigest = (bytes: Uint8Array): SessionDigest => ({
  bytes,
  hex: hexOf(bytes),
});

/**
 * A DETERMINISTIC digest: the point of injecting it is that the rule can be
 * exercised without arranging a crypto module or depending on a real hash.
 */
const digest = (value: string): SessionDigest => {
  const bytes = new Uint8Array(32);
  for (let i = 0; i < value.length; i += 1) {
    bytes[i % 32] = (bytes[i % 32] ?? 0) + (value.codePointAt(i) ?? 0);
  }
  return fixedDigest(bytes);
};

/** The vendor's descending time part for an anchor, counter 1. */
const descendingTime = (anchor: bigint): bigint =>
  MASK - 1n - ((anchor * 4096n + 1n) % MASK);

const timePart = (id: string): bigint => BigInt(`0x${id.slice(4, 16)}`);

describe("session-id · deriveSessionId", () => {
  const BYTES = Uint8Array.from({ length: 32 }, (_, i) => (i * 7) % 256);

  it("inverts createdAt*4096+1 in 48 bits and takes the suffix from bytes 6..19 in base62", () => {
    const createdAt = 1_700_000_000_000;
    const id = deriveSessionId(fixedDigest(BYTES), createdAt);
    expect(timePart(id)).toBe(descendingTime(BigInt(createdAt)));
    // Counter 1, inverted: the low twelve bits sit at 0xFFE, the gateway's band.
    expect(Number.parseInt(id.slice(4, 16), 16) % 0x1000).toBe(0xffe);
    expect(id.slice(16)).toBe(
      Array.from(BYTES.slice(6, 20), (b) => BASE62[b % 62]).join("")
    );
    expect(id).toHaveLength(30);
    expect(isOpenCodeSessionId(id)).toBe(true);
  });

  it("anchors on the digest's hex[4..16] when createdAt is absent, negative, fractional or unsafe", () => {
    const d = digest("anchor");
    const hashed = deriveSessionId(d);
    for (const createdAt of [undefined, -1, 1.5, 2 ** 53]) {
      expect(deriveSessionId(d, createdAt), String(createdAt)).toBe(hashed);
    }
    expect(timePart(hashed)).toBe(
      descendingTime(BigInt(`0x${d.hex.slice(4, 16)}`))
    );
    // Zero is a time, not an absence.
    expect(deriveSessionId(d, 0)).not.toBe(hashed);
  });

  it("wraps at 48 bits the way the vendor's six-byte buffer does", () => {
    // `2**36 * 4096` is exactly 2**48: the stored value wraps to the counter
    // alone, so the inversion reads all ones but the lowest bit.
    const id = deriveSessionId(digest("wrap"), 2 ** 36);
    expect(timePart(id)).toBe(MASK - 2n);
    expect(id.slice(4, 16)).toBe("fffffffffffe");
  });

  it("keeps the suffix of a digest when only the creation time changes", () => {
    const d = digest("same-digest");
    const early = deriveSessionId(d, 1_600_000_000_000);
    const late = deriveSessionId(d, 1_700_000_000_000);
    expect(early.slice(16)).toBe(late.slice(16));
    expect(early.slice(4, 16)).not.toBe(late.slice(4, 16));
  });

  it("with a digest shorter than 20 bytes still yields the 12-hex time part and does not throw", () => {
    const short: SessionDigest = {
      bytes: new Uint8Array(8),
      hex: "00".repeat(8),
    };
    expect(() => deriveSessionId(short)).not.toThrow();
    const id = deriveSessionId(short);
    expect(id.startsWith("ses_")).toBe(true);
    expect(id.slice(4, 16)).toMatch(/^[0-9a-f]{12}$/u);
    // Bytes 6 and 7 are all the suffix there is.
    expect(id).toHaveLength(4 + 12 + 2);
  });
});

describe("session-id · pinnedSessionId", () => {
  it("returns a pinned id the gateway accepts and derives the same default for anything else", () => {
    const valid = deriveSessionId(digest("any"));
    expect(pinnedSessionId(valid, digest)).toBe(valid);
    const fallback = deriveSessionId(digest("default"));
    for (const pinned of ["ses_dsh_default", "", 42, undefined, null]) {
      const derived = pinnedSessionId(pinned, digest);
      expect(derived, String(pinned)).toBe(fallback);
      expect(isOpenCodeSessionId(derived)).toBe(true);
    }
  });
});

describe("session-id · the shapes the gateway reads", () => {
  it("isOpenCodeSessionId accepts ses_ + 12 hex + 14 base62 and nothing else", () => {
    const derived = deriveSessionId(digest("shape"));
    const table: readonly [unknown, boolean][] = [
      [derived, true],
      [`ses_${"a".repeat(12)}${"Z".repeat(14)}`, true],
      [`ses_${"A".repeat(12)}${"Z".repeat(14)}`, false],
      [`ses_${"a".repeat(12)}${"Z".repeat(13)}`, false],
      [`ses_${"a".repeat(12)}${"Z".repeat(15)}`, false],
      [`msg_${derived.slice(4)}`, false],
      ["ses_dsh_default", false],
      ["", false],
      [42, false],
      [undefined, false],
    ];
    for (const [value, accepted] of table) {
      expect(isOpenCodeSessionId(value), String(value)).toBe(accepted);
    }
  });

  it("isOpenCodeMessageId accepts msg_ + 12 hex + 14 base62 and nothing else", () => {
    const suffix = deriveSessionId(digest("message")).slice(4);
    const table: readonly [unknown, boolean][] = [
      [`msg_${suffix}`, true],
      [`ses_${suffix}`, false],
      [`msg_${suffix.slice(1)}`, false],
      [`msg_${"g".repeat(12)}${"Z".repeat(14)}`, false],
      ["msg_", false],
      [null, false],
    ];
    for (const [value, accepted] of table) {
      expect(isOpenCodeMessageId(value), String(value)).toBe(accepted);
    }
  });
});

describe("session · which id a request carries", () => {
  const VALID = `ses_0123456789ab${"A".repeat(14)}`;
  const PINNED = `ses_abcdef012345${"B".repeat(14)}`;
  // The "absent" case, named so it reads as a value rather than lint noise.
  const ABSENT = undefined;

  it("prefers the turn's own id above everything", () => {
    // The only source with certainty: it is the conversation actually running.
    expect(sessionIdForRequest(VALID, PINNED, PINNED, digest)).toBe(VALID);
  });

  it("ignores an empty turn id and falls through", () => {
    expect(sessionIdForRequest("", PINNED, ABSENT, digest)).toBe(PINNED);
  });

  it("honours a pinned header only when the gateway would accept it", () => {
    expect(sessionIdForRequest(ABSENT, PINNED, ABSENT, digest)).toBe(PINNED);
    // `ses_dsh_default` starts with `ses_` and is not a session id; sending it
    // earns a 401 that reads like a credential fault.
    const derived = sessionIdForRequest(
      ABSENT,
      "ses_dsh_default",
      ABSENT,
      digest
    );
    expect(derived).not.toBe("ses_dsh_default");
    expect(isOpenCodeSessionId(derived)).toBe(true);
  });

  it("prefers a valid pinned header over the environment", () => {
    expect(sessionIdForRequest(ABSENT, PINNED, VALID, digest)).toBe(PINNED);
  });

  it("uses a valid pinned env id, and derives when it is not one", () => {
    expect(sessionIdForRequest(ABSENT, ABSENT, VALID, digest)).toBe(VALID);
    for (const bad of [undefined, null, "", "ses_dsh_default", 42]) {
      const derived = sessionIdForRequest(ABSENT, ABSENT, bad, digest);
      expect(isOpenCodeSessionId(derived), String(bad)).toBe(true);
    }
  });

  it("derives the same default every time, so a conversation stays stable", () => {
    expect(sessionIdForRequest(ABSENT, ABSENT, ABSENT, digest)).toBe(
      sessionIdForRequest(ABSENT, ABSENT, ABSENT, digest)
    );
  });
});
