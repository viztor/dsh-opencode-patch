/**
 * `GoUsageService` — every typed failure a gateway answer becomes.
 *
 * @module test/usage-service-failures.test
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { clearCapturedApiKeys, clearSessionUsageStore } from "./support/src.ts";
import {
  failureOf,
  GO_USAGE_URL,
  okBody,
  serviceWithKey,
  stubFetch,
} from "./support/usage-fixture.ts";

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.OPENCODE_API_KEY;
  delete process.env.OPENCODE_GO_API_KEY;
  clearCapturedApiKeys();
  clearSessionUsageStore();
});

describe("GoUsageService gateway failures", () => {
  it("turns a 403 EntitlementError into the Zen-overflow reading", async () => {
    // The account overflowed onto Zen: Go refuses with `EntitlementError`, and
    // with Zen configured the right answer is the zeroed reading rather than an
    // outage. The account id carries over from the last healthy poll because it
    // is still the same account.
    process.env.OPENCODE_API_KEY = "oc_sk_zen-key";
    let calls = 0;
    stubFetch(() => {
      calls += 1;
      return calls === 1
        ? new Response(okBody())
        : new Response(
            '{"error":{"code":"EntitlementError","message":"no Go subscription"}}',
            { status: 403 }
          );
    });
    const service = serviceWithKey("sk-live-key");

    const before = await service.read();
    const after = await service.read();
    expect(after.zenOverflow).toBe(true);
    expect(after.source).toBe(before.source);

    // The zeros are a TYPE FLOOR — they exist only to satisfy the shape, and
    // the flag is what stops them being drawn. Verified against the live API:
    // the same key returns real figures moments after an EntitlementError, so
    // asserting `percent === 0` here would pin a fabricated number as if it
    // were a reading.
    expect(after.quotaUnavailable).toBe(true);
    expect(after.rolling.percent).toBe(0);
  });

  it("does NOT mark a healthy reading as quota-unavailable", async () => {
    // Overflow being CONFIGURED is the normal case — a Zen key exists and Go
    // still reports real windows. Only the unreadable reading carries the flag,
    // or every Go user would lose their quota rows.
    stubFetch(() => new Response(okBody()));
    process.env.OPENCODE_API_KEY = "oc_sk_zen-key";
    const usage = await serviceWithKey("sk-live-key").read();
    expect(usage.quotaUnavailable).toBeUndefined();
    expect(usage.rolling.percent).toBeGreaterThan(0);
  });

  it("refuses an EntitlementError when there is no Zen credit to overflow into", async () => {
    // Without Zen the account simply has no Go plan, and the meter must say so
    // as an unconfigured state instead of drawing zeros forever.
    stubFetch(
      () =>
        new Response('{"error":{"code":"EntitlementError"}}', { status: 403 })
    );
    const failure = await failureOf(serviceWithKey("sk-live-key").read());
    expect(failure.message).toBe("OpenCode Go subscription required");
    expect(failure.details).toEqual({
      configured: false,
      retainPrevious: false,
      retryable: false,
    });
  });

  it("separates a transient HTTP status from a final one", async () => {
    // 408/429/5xx are worth retrying and must keep the last reading on screen;
    // 4xx means the request itself is wrong and retrying just hammers the
    // gateway with the same answer.
    const cases: [number, boolean][] = [
      [408, true],
      [429, true],
      [500, true],
      [503, true],
      [400, false],
      [404, false],
    ];
    for (const [status, transient] of cases) {
      stubFetch(() => new Response("upstream said no", { status }));
      const failure = await failureOf(serviceWithKey("sk-live-key").read());
      expect(failure.message).toBe(
        `OpenCode Go usage unavailable (HTTP ${status})`
      );
      expect(failure.details.retryable).toBe(transient);
      expect(failure.details.retainPrevious).toBe(transient);
      expect(typeof failure.details.source).toBe("string");
      // Only a rejected credential is worth naming; an outage is not.
      expect(failure.details.reason).toBeUndefined();
    }
  });

  it("names a rejected credential instead of calling it an outage", async () => {
    // A 401 is what an ACCOUNT SWITCH looks like: the console identity is an
    // OAuth browser session, not an sk-... Go key, and /usage refuses it. Folded
    // into the generic status message it read as "unavailable" with nothing to
    // act on, so it now carries its own reason all the way to the panel.
    stubFetch(() => new Response('{"type":"error"}', { status: 401 }));
    const failure = await failureOf(serviceWithKey("sk-live-key").read());
    expect(failure.message).toBe(
      "OpenCode Go rejected the API key for this account"
    );
    expect(failure.details.reason).toBe("auth");
    // Retrying a rejected credential cannot help, exactly as before.
    expect(failure.details.retryable).toBe(false);
    expect(failure.details.retainPrevious).toBe(false);
  });

  it("falls back to Zen overflow when Go usage rejects a 401 on a Zen provider", async () => {
    // A Zen route (opencode) has no Go quota window: when an OAuth session or non-Go key
    // answers 401 on the Go endpoint, it must fall back to the session-spend Zen overflow
    // rather than displaying a spurious "Go key rejected" alert on a Zen card.
    stubFetch(() => new Response('{"type":"error"}', { status: 401 }));
    const service = serviceWithKey("oc_sk_zen-key");
    const reading = await service.read({ provider: "opencode" });
    expect(reading.zenOverflow).toBe(true);
    expect(reading.quotaUnavailable).toBe(true);
    expect(reading.monthly.percent).toBe(0);
  });

  it("falls back to Zen overflow when Go usage rejects a 401 on the Zen Google route", async () => {
    // `opencode-google` is Zen's Google route, not a Go one: the same 401 that
    // falls back on plain `opencode` must fall back here, rather than reaching
    // the card as a rejected Go key.
    stubFetch(() => new Response('{"type":"error"}', { status: 401 }));
    const reading = await serviceWithKey("oc_sk_zen-key").read({
      provider: "opencode-google",
    });
    expect(reading.zenOverflow).toBe(true);
    expect(reading.quotaUnavailable).toBe(true);
  });

  it("rejects an oversized body before parsing it", async () => {
    // The cap exists because the body is read into memory first; rejecting
    // after `JSON.parse` would already have paid for the megabyte.
    stubFetch(() => new Response("x".repeat(1024 * 1024 + 1)));
    const failure = await failureOf(serviceWithKey("sk-live-key").read());
    expect(failure.message).toBe(
      `Response from ${GO_USAGE_URL} exceeds 1048576 byte limit`
    );
    expect(failure.details.retryable).toBe(true);
    expect(failure.details.retainPrevious).toBe(false);
  });

  it("surfaces a transport failure against the URL it could not read", async () => {
    // The meter shows the diagnostic verbatim, so the endpoint and the socket
    // error both have to survive into the message.
    vi.stubGlobal("fetch", (): Promise<Response> =>
      Promise.reject(new Error("ECONNRESET"))
    );
    const failure = await failureOf(serviceWithKey("sk-live-key").read());
    expect(failure.message).toBe(`Could not read ${GO_USAGE_URL}: ECONNRESET`);
    expect(failure.details.retryable).toBe(true);
    expect(failure.details.retainPrevious).toBe(true);
  });

  it("reports malformed JSON as retryable", async () => {
    // A truncated body from a proxy is worth retrying; the previous reading
    // stays on screen meanwhile.
    stubFetch(() => new Response("<html>502 Bad Gateway</html>"));
    const failure = await failureOf(serviceWithKey("sk-live-key").read());
    expect(failure.message).toBe("Invalid JSON in OpenCode Go usage response");
    expect(failure.details.retryable).toBe(true);
    expect(failure.details.retainPrevious).toBe(false);
  });

  it("reports a valid body of the wrong shape as a structure error", async () => {
    // The vendor changing the payload shape is the failure a hand-rolled stub
    // cannot catch, so the parse error must stay a real, retryable reading
    // rather than a crash — and its cause must survive in-process.
    stubFetch(() =>
      Response.json({
        usage: {
          rolling: {
            percent: 1,
            resetsAt: "2026-10-01T00:00:00.000Z",
            status: "ok",
          },
          weekly: {
            percent: 2,
            resetsAt: "2026-10-02T00:00:00.000Z",
            status: "ok",
          },
        },
      })
    );
    const failure = await failureOf(serviceWithKey("sk-live-key").read());
    expect(failure.message).toBe(
      "Invalid OpenCode Go usage response structure"
    );
    expect(failure.details.retryable).toBe(true);
    expect(failure.cause).toBeInstanceOf(TypeError);
    expect(failure.details.source).toBeDefined();
  });

  it("reads a healthy payload without a wrapper into the same reading", async () => {
    // The gateway has shipped both shapes; both must produce one reading, so a
    // wrapper-less body is not an outage.
    stubFetch(() =>
      Response.json({
        monthly: {
          percent: 3,
          resetsAt: "2026-10-09T00:00:00.000Z",
          status: "ok",
        },
        rolling: {
          percent: 4,
          resetsAt: "2026-10-01T00:00:00.000Z",
          status: "ok",
        },
        weekly: {
          percent: 5,
          resetsAt: "2026-10-05T00:00:00.000Z",
          status: "ok",
        },
      })
    );
    const usage = await serviceWithKey("sk-live-key").read();
    expect(usage.monthly.percent).toBe(3);
    expect(usage.rolling.percent).toBe(4);
    expect(usage.weekly.percent).toBe(5);
    expect(usage.monthly.status).toBe("ok");
  });
});
