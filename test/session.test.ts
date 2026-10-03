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
