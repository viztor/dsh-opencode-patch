/**
 * openCodeSessionIdFor · headerValueFor · hasSessionHeader · withStore.
 *
 * Split out of the former monolithic `plugin.test.ts`.
 *
 * @module test/session.test
 */

import { AsyncLocalStorage } from "node:async_hooks";

import { afterEach, describe, expect, it, vi } from "vitest";

import { readSessionMetaResolver } from "../src/cordis-context.ts";
import {
  SESSION_HEADER,
  hasSessionHeader,
  headerValueFor,
  openCodeSessionIdFor,
  type ActiveTurnState,
  withStore,
} from "../src/index.ts";
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
  const vendorTimestamp = (id: string): number => {
    const prefix = id.split("_")[0] ?? "";
    const hex = id.slice(prefix.length + 1, prefix.length + 13);
    return Number(BigInt(`0x${hex}`) / 0x1000n);
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
    expect(Number(BigInt(`0x${hex}`) / 0x1000n)).toBe(createdAt % 2 ** 36);
  });
});
