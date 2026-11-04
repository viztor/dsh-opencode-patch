/**
 * openCodeSessionIdFor · headerValueFor · hasSessionHeader · withStore.
 *
 * Split out of the former monolithic `plugin.test.ts`.
 *
 * @module test/session.test
 */

import { AsyncLocalStorage } from "node:async_hooks";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  type ActiveTurnState,
  SESSION_HEADER,
  fallbackSessionId,
  hasSessionHeader,
  headerValueFor,
  isOpenCodeMessageId,
  isOpenCodeSessionId,
  newOpenCodeMessageId,
  openCodeSessionIdFor,
  readSessionMetaResolver,
  sessionIdForRequest,
  withStore,
} from "./support/src.ts";
import { SESSION_RE, createMockStoreStream } from "./test-helpers.ts";

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.OPENCODE_SESSION_ID;
});

describe("openCodeSessionIdFor", () => {
  it("generates a valid OpenCode session ID matching the exact regex format", () => {
    const id = openCodeSessionIdFor("c2a51fb0-578c-4019-80c4-868eff95fd08");
    expect(id).toMatch(SESSION_RE);
    expect(id.length).toBe(30);
  });

  it("is deterministic for identical inputs", () => {
    expect(openCodeSessionIdFor("conversation-alpha-123")).toBe(
      openCodeSessionIdFor("conversation-alpha-123")
    );
  });

  it("handles numeric session IDs identically to their string form", () => {
    const id = openCodeSessionIdFor(123_456_789);
    expect(id).toBe(openCodeSessionIdFor("123456789"));
    expect(id).toMatch(/^ses_/);
  });

  it("produces a valid ID for empty input without throwing", () => {
    expect(openCodeSessionIdFor("")).toMatch(SESSION_RE);
  });

  it("generates unique session IDs across deterministic inputs", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i += 1) {
      const id = openCodeSessionIdFor(`deterministic-session-${i}`);
      expect(seen.has(id)).toBe(false);
      seen.add(id);
    }
    expect(seen.size).toBe(200);
  });

  it("maps distinct conversations to distinct session IDs", () => {
    expect(openCodeSessionIdFor("session-a")).not.toBe(
      openCodeSessionIdFor("session-b")
    );
  });
});

describe("headerValueFor", () => {
  it("derives the same session id on every call without a table", () => {
    const val1 = headerValueFor("dsh-uuid-1");
    expect(val1).toMatch(/^ses_/);

    const val2 = headerValueFor("dsh-uuid-1");
    expect(val2).toBe(val1);
  });

  it("returns undefined for empty, null, or undefined session inputs", () => {
    const missing: string | number | undefined = undefined;
    expect(headerValueFor("")).toBeUndefined();
    expect(headerValueFor(missing)).toBeUndefined();
    expect(headerValueFor(null)).toBeUndefined();
  });

  it("accepts numeric session IDs", () => {
    const value = headerValueFor(987_654);
    expect(value).toMatch(/^ses_/);
  });

  it("derives ses_ IDs even for UUID-shaped input", () => {
    const raw = "c2a51fb0-578c-4019-80c4-868eff95fd08";
    const value = headerValueFor(raw);
    expect(value).toMatch(SESSION_RE);
    expect(value).not.toBe(raw);
  });
});

describe("hasSessionHeader", () => {
  it("detects x-opencode-session in Headers object case-insensitively", () => {
    const headers = new Headers();
    headers.set("X-OpenCode-Session", "ses_mock_header");
    expect(hasSessionHeader("http://example.com", { headers })).toBe(true);
  });

  it("detects x-opencode-session in plain object headers", () => {
    expect(
      hasSessionHeader("http://example.com", {
        headers: { [SESSION_HEADER]: "ses_mock_header" },
      })
    ).toBe(true);
  });

  it("detects x-opencode-session carried by a Request object", () => {
    const req = new Request("http://example.com", {
      headers: { [SESSION_HEADER]: "ses_from_request" },
    });
    expect(hasSessionHeader(req)).toBe(true);
  });

  it("returns false when header is absent", () => {
    expect(
      hasSessionHeader("http://example.com", {
        headers: { "Content-Type": "application/json" },
      })
    ).toBe(false);
    expect(hasSessionHeader("http://example.com")).toBe(false);
  });
});

describe("withStore", () => {
  it("wraps and drives an async iterable inside AsyncLocalStorage context", async () => {
    const als = new AsyncLocalStorage<ActiveTurnState>();
    const wrapped = withStore(
      createMockStoreStream(als),
      { provider: "opencode", value: "store-context-42" },
      als
    );
    const results: unknown[] = [];
    for await (const value of wrapped) {
      results.push(value);
    }
    expect(results).toEqual(["store-context-42", "store-context-42"]);
  });

  it("handles early return on the wrapped iterator", async () => {
    const als = new AsyncLocalStorage<ActiveTurnState>();
    let returned = false;

    const mockIterable: AsyncIterable<number> = {
      [Symbol.asyncIterator]() {
        return {
          next: () => Promise.resolve({ done: false, value: 1 }),
          return: () => {
            returned = true;
            return Promise.resolve({ done: true, value: undefined });
          },
        };
      },
    };

    const wrapped = withStore(
      mockIterable,
      { provider: "opencode", value: "test" },
      als
    );
    const iterator = wrapped[Symbol.asyncIterator]();
    const first = await iterator.next();
    expect(first.value).toBe(1);
    await iterator.return?.();
    expect(returned).toBe(true);
  });

  it("propagates throw through the wrapped iterator with context", async () => {
    const als = new AsyncLocalStorage<ActiveTurnState>();
    const failure = new Error("downstream-boom");
    const mockIterable: AsyncIterable<number> = {
      [Symbol.asyncIterator]() {
        return {
          next: () => Promise.resolve({ done: false, value: 1 }),
          throw: () => Promise.reject(failure),
        };
      },
    };
    const wrapped = withStore(
      mockIterable,
      { provider: "opencode", value: "throw-ctx" },
      als
    );
    const iterator = wrapped[Symbol.asyncIterator]();
    await expect(iterator.throw?.(failure)).rejects.toBe(failure);
  });

  it("passes through iterables whose factory yields no iterator", () => {
    const als = new AsyncLocalStorage<ActiveTurnState>();
    const passthrough: AsyncIterable<string> = {
      // @ts-expect-error -- intentionally broken factory to verify passthrough
      [Symbol.asyncIterator]() {
        return null;
      },
    };
    const wrapped = withStore(
      passthrough,
      { provider: "opencode", value: "x" },
      als
    );
    expect(wrapped).toBe(passthrough);
  });
});

/**
 * The vendor PARSES these ids back, so our encoding has to survive their own
 * reader. These cases run that reader — `timestamp()` from
 * `packages/opencode/src/id/id.ts` — against ids we minted. This is the
 * assertion that would have caught the wrong alphabet: the Crockford change
 * made `BigInt("0x" + hex)` throw for every consumer of that function.
 */
describe("session id · parity with the vendor's own reader", () => {
  /** The vendor's `timestamp()`: slice twelve characters, hex, divide by 0x1000. */
  /**
   * The vendor's own decode, with the inversion applied.
   *
   * Sessions are minted with `direction: "descending"`, so the twelve hex digits
   * are `~((ms << 12) + counter)` masked to 48 bits — never the value itself.
   * Skipping the inversion is the mistake that let this suite certify an
   * encoding the gateway rejects: measured 500 for our ascending ids against 200
   * for a freshly minted descending one, same body, same key, same session.
   */
  const vendorTimestamp = (id: string): number => {
    const prefix = id.split("_")[0] ?? "";
    const hex = id.slice(prefix.length + 1, prefix.length + 13);
    const mask = 2n ** 48n - 1n;
    return Number((mask - BigInt(`0x${hex}`)) / 0x1000n);
  };

  it("embeds the creation time exactly where their reader looks for it", () => {
    const createdAt = 1_759_999_999_999;
    const id = openCodeSessionIdFor("session-abc", createdAt);
    // Their buffer is six bytes, so the value they store is the low 48 bits of
    // `ms * 0x1000 + counter` — their own wrap, every ~795 days
    // (opencode#42589). Matching it, wrap included, is what makes our id
    // indistinguishable from one they minted.
    expect(vendorTimestamp(id)).toBe(createdAt % 2 ** 36);
  });

  it("keeps the counter in the low twelve bits, below the timestamp", () => {
    // Two conversations created in the same millisecond must both read back as
    // that millisecond: the counter disambiguates ids, it does not encode time.
    const createdAt = 1_700_000_000_000;
    for (const session of ["alpha", "beta", "gamma"]) {
      expect(vendorTimestamp(openCodeSessionIdFor(session, createdAt))).toBe(
        createdAt % 2 ** 36
      );
    }
  });

  it("stays identical for the same session and creation time", () => {
    // Affinity needs one id per conversation per turn; the timestamp comes from
    // the SESSION, not from a clock, so nothing here changes on a restart.
    const createdAt = 1_700_000_000_000;
    expect(openCodeSessionIdFor("same-session", createdAt)).toBe(
      openCodeSessionIdFor("same-session", createdAt)
    );
  });

  it("still mints an id their reader accepts when no creation time is known", () => {
    // The degraded path: those twelve characters are hash bits, not a time. The
    // id must still parse rather than throw inside a consumer.
    const id = openCodeSessionIdFor("no-created-at");
    expect(id).toMatch(SESSION_RE);
    expect(() => vendorTimestamp(id)).not.toThrow();
  });
});

/**
 * The session's OWN creation time is what makes the id's embedded timestamp
 * real. These pin the two halves of that wiring — where the Host keeps the
 * value, and that it survives the trip into the header — because either half
 * failing would quietly fall back to hash bits and nobody would see it.
 */
describe("session id · the session's own creation time", () => {
  /** A Host context whose `sessions` service answers for one id. */
  const ctxWith = (record: unknown): unknown => ({
    get: (name: string) =>
      name === "sessions"
        ? { get: (id: string) => (id === "s1" ? record : undefined) }
        : undefined,
  });

  it("reads createdAt off the RECORD, not out of its header", () => {
    // The Host validates `record.createdAt`; the header carries cwd and
    // parentSession. Looking in the wrong one yields no timestamp at all.
    const meta = readSessionMetaResolver(
      ctxWith({ createdAt: 1_700_000_000_000, header: { cwd: "/tmp/x" } })
    )?.("s1");
    expect(meta?.createdAt).toBe(1_700_000_000_000);
    expect(meta?.cwd).toBe("/tmp/x");
  });

  it("drops a createdAt that is not a non-negative safe integer", () => {
    // A malformed value must not become a timestamp in the id: absent is a
    // state we handle, a wrong time is not.
    for (const bad of [-1, 1.5, Number.NaN, "1700", Number.MAX_VALUE * 10]) {
      const meta = readSessionMetaResolver(
        ctxWith({ createdAt: bad, header: {} })
      )?.("s1");
      expect(meta?.createdAt).toBeUndefined();
    }
  });

  it("puts that time where the vendor's reader looks for it", () => {
    const createdAt = 1_700_000_000_000;
    const id = headerValueFor("s1", createdAt) ?? "";
    const hex = id.slice(4, 16);
    const mask = 2n ** 48n - 1n;
    // Inverted: sessions are descending, so the stored value is `~time`.
    expect(Number((mask - BigInt(`0x${hex}`)) / 0x1000n)).toBe(
      createdAt % 2 ** 36
    );
  });
});

describe("session: a session id the gateway will accept", () => {
  it("accepts what the derivation produces and what the client sends", () => {
    // Measured: the client's own ids are ses_ + 12 hex + 14 base62.
    expect(isOpenCodeSessionId(openCodeSessionIdFor("abc"))).toBe(true);
    expect(isOpenCodeSessionId("ses_ed62aae61ffeA6UwzEFN9YNKk8")).toBe(true);
  });

  it("lands in the admitted band by construction, not by clamping", () => {
    // The gateway admits low twelve bits in `0xFC0..0xFFE` and refuses anything
    // else with `403 FreeTierError` — measured by replaying the vendor client's
    // captured body and changing only this header (ascending `0xFFE` and `0xFC0`
    // → 200; ascending `0x001` → 403).
    //
    // The id that rule is about is the vendor's own shape: descending, counter
    // 1. Inverting `(ms << 12) + 1` puts the low twelve bits at `0xFFE` with no
    // clamp anywhere, so this asserts the construction rather than a band we
    // impose on it. PR #35/#37 introduced the band by clamping the counter; that
    // clamp was correct and is now unnecessary.
    const low12 = (id: string): number =>
      Number.parseInt(id.slice(4, 16), 16) % 0x1000;
    for (const id of [
      openCodeSessionIdFor("band-a"),
      openCodeSessionIdFor("band-b", 1792000000000),
      openCodeSessionIdFor("band-c", 1792000000001),
    ]) {
      expect(low12(id)).toBe(0xffe);
    }
  });

  it("rejects a pinned header that merely starts with ses_", () => {
    // The failure this exists for: a deployment pinned
    // `x-opencode-session: ses_dsh_default`, which starts with `ses_` and is not
    // a session id. The gateway answers it 401 Invalid API key, which reads as a
    // credential fault and is really a malformed header — and a request outside
    // any tracked turn, such as an auto-review pass, is exactly where the pinned
    // value would be used.
    for (const bad of [
      "ses_dsh_default",
      "ses_e2e0000000000abcdefghij",
      "ses_",
      "ses_short",
      "ses_ZZZZZZZZZZZZaaaaaaaaaaaaaa",
      "not-a-session",
      "",
    ]) {
      expect(isOpenCodeSessionId(bad), bad).toBe(false);
    }
    expect(isOpenCodeSessionId(42)).toBe(false);
  });
});

describe("newOpenCodeMessageId: the value x-opencode-request carries", () => {
  const MESSAGE_RE = /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/u;

  it("mints the exact shape the client sends", () => {
    // Measured: the client's own ids are msg_ + 12 hex + 14 base62 — the same
    // layout as a session id under a different prefix. The gateway reads this
    // value for per-request metrics, so it has to be that shape, and not
    // something that merely starts with msg_.
    const id = newOpenCodeMessageId();
    expect(id).toMatch(MESSAGE_RE);
    expect(id.length).toBe(30);
    expect(isOpenCodeMessageId(id)).toBe(true);
    expect(isOpenCodeMessageId("msg_ed62aae61ffeA6UwzEFN9YNKk8")).toBe(true);
  });

  it("embeds the mint instant where the vendor's reader looks for it", () => {
    // `timestamp(id)` divides the twelve hex characters by 0x1000; with the
    // counter in the low twelve bits, that recovers the milliseconds modulo the
    // 48-bit field the vendor wraps at.
    const now = 1_792_000_000_000;
    const id = newOpenCodeMessageId(now);
    const time = Number(BigInt(`0x${id.slice(4, 16)}`) / 0x1000n);
    expect(time).toBe(now % 2 ** 36);
  });

  it("mints a distinct id per call, counter and randomness included", () => {
    // Unlike a session id, two calls must NOT agree: two different user
    // messages sharing one id is the failure a derived value would have.
    const now = 1_792_000_000_000;
    const first = newOpenCodeMessageId(now);
    const second = newOpenCodeMessageId(now);
    expect(first).not.toBe(second);

    const low12 = (id: string): number =>
      Number.parseInt(id.slice(4, 16), 16) % 0x1000;
    expect(low12(second)).toBe((low12(first) + 1) % 0x1000);

    const ids = new Set<string>();
    for (let i = 0; i < 200; i += 1) {
      ids.add(newOpenCodeMessageId());
    }
    expect(ids.size).toBe(200);
  });

  it("still mints one when the clock argument is not a time", () => {
    for (const bad of [Number.NaN, -1, 1.5]) {
      expect(newOpenCodeMessageId(bad)).toMatch(MESSAGE_RE);
    }
  });

  it("rejects a header value that merely starts with msg_", () => {
    // The same rule as the session validator: a prefix is not a format, and a
    // malformed value has no fallback — it is dropped, not repaired.
    for (const bad of [
      "msg_dsh_default",
      "msg_",
      "msg_short",
      "msg_ZZZZZZZZZZZZaaaaaaaaaaaaaa",
      "ses_ed62aae61ffeA6UwzEFN9YNKk8",
      "",
    ]) {
      expect(isOpenCodeMessageId(bad), bad).toBe(false);
    }
    expect(isOpenCodeMessageId(42)).toBe(false);
  });
});

describe("session · which id a request carries", () => {
  const VALID = `ses_0123456789ab${"A".repeat(14)}`;
  const PINNED = `ses_abcdef012345${"B".repeat(14)}`;
  // The "absent" case, named so it reads as a value rather than lint noise.
  const ABSENT = undefined;
  // A DETERMINISTIC digest: the point of injecting it is that the rule can be
  // exercised without arranging a crypto module or depending on a real hash.
  const digest = (value: string) => {
    const bytes = new Uint8Array(32);
    for (let i = 0; i < value.length; i += 1) {
      bytes[i % 32] = (bytes[i % 32] ?? 0) + (value.codePointAt(i) ?? 0);
    }
    return {
      bytes,
      hex: [...bytes].map((b) => b.toString(16).padStart(2, "0")).join(""),
    };
  };

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

const VALID_ENV_ID = `ses_0123456789ab${"C".repeat(14)}`;

describe("session · the fallback id reads the environment", () => {
  const AN_ENV_NAME = "DSH_OPENCODE_SESSION_ID_TEST";

  afterEach(() => {
    Reflect.deleteProperty(process.env, AN_ENV_NAME);
  });

  it("uses a pinned environment id when it is a session id", () => {
    // Headless runs pin one id per process, so this path is a real deployment
    // shape rather than a defensive branch.
    process.env[AN_ENV_NAME] = VALID_ENV_ID;
    expect(fallbackSessionId(AN_ENV_NAME)).toBe(VALID_ENV_ID);
  });

  it("derives a default when the variable is unset or malformed", () => {
    // An id the gateway would answer 401 to is replaced, not sent.
    process.env[AN_ENV_NAME] = "ses_dsh_default";
    const derived = fallbackSessionId(AN_ENV_NAME);
    expect(derived).not.toBe("ses_dsh_default");
    expect(isOpenCodeSessionId(derived)).toBe(true);

    Reflect.deleteProperty(process.env, AN_ENV_NAME);
    expect(isOpenCodeSessionId(fallbackSessionId(AN_ENV_NAME))).toBe(true);
  });

  it("derives a default when no variable name is given at all", () => {
    // A blank name is "no variable", not "read the empty name".
    for (const name of [undefined, ""]) {
      const derived = fallbackSessionId(name);
      expect(isOpenCodeSessionId(derived)).toBe(true);
    }
  });
});
