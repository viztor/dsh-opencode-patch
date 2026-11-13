/**
 * OpenCode Go Usage.
 *
 * Split out of the former monolithic `plugin.test.ts`.
 *
 * @module test/usage.test
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  clearCapturedApiKeys,
  extractApiKeyFromHeaders,
  getCapturedApiKey,
  isPlaceholderApiKey,
  parseGoUsage,
  parseUsageQuery,
  recordCapturedApiKey,
  tierForRequest,
} from "./support/src.ts";

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.OPENCODE_SESSION_ID;
  delete process.env.OPENCODE_GO_API_KEY;
  delete process.env.OPENCODE_API_KEY;
  clearCapturedApiKeys();
});

describe("OpenCode Go Usage", () => {
  const samplePayload = {
    usage: {
      monthly: {
        percent: 100,
        resetsAt: "2026-10-09T13:53:58.000Z",
        status: "rate-limited",
      },
      rolling: {
        percent: 15,
        resetsAt: "2026-10-01T16:55:56.004Z",
        status: "ok",
      },
      weekly: {
        percent: 42,
        resetsAt: "2026-10-05T00:00:00.000Z",
        status: "ok",
      },
    },
  };

  it("parses valid API usage response with usage wrapper", () => {
    const parsed = parseGoUsage(samplePayload);
    expect(parsed.monthly.status).toBe("rate-limited");
    expect(parsed.monthly.percent).toBe(100);
    expect(parsed.rolling.percent).toBe(15);
    expect(parsed.weekly.percent).toBe(42);
  });

  it("parses unwrapped usage response", () => {
    const parsed = parseGoUsage(samplePayload.usage);
    expect(parsed.monthly.status).toBe("rate-limited");
    expect(parsed.rolling.status).toBe("ok");
    expect(parsed.weekly.percent).toBe(42);
  });

  it("rejects non-object or null payloads", () => {
    expect(() => parseGoUsage(null)).toThrow("expected an object");
    expect(() => parseGoUsage("string")).toThrow("expected an object");
  });

  it("rejects payload missing rolling, weekly, or monthly", () => {
    expect(() =>
      parseGoUsage({
        rolling: { percent: 0, resetsAt: "2026-01-01", status: "ok" },
      })
    ).toThrow();
  });

  it("parseUsageQuery keeps the fields it needs and refuses junk", () => {
    expect(parseUsageQuery()).toEqual({});
    expect(parseUsageQuery(null)).toEqual({});
    // Blank strings mean "not stated", not "the empty route".
    expect(parseUsageQuery({ provider: "", sessionId: "" })).toEqual({});
    expect(
      parseUsageQuery({ provider: "opencode-go", sessionId: "s-1" })
    ).toEqual({ provider: "opencode-go", sessionId: "s-1" });
    // A partial query keeps only the usable half.
    expect(parseUsageQuery({ sessionId: "s-1" })).toEqual({ sessionId: "s-1" });
    expect(parseUsageQuery({ sessionId: 42 })).toEqual({});
    expect(() => parseUsageQuery("nope")).toThrow(/expected an object/);
  });

  it("extractApiKeyFromHeaders extracts keys from Headers and plain objects", () => {
    const h1 = new Headers();
    h1.set("authorization", "Bearer sk-test-bearer-123");
    expect(extractApiKeyFromHeaders(h1)).toBe("sk-test-bearer-123");

    const h2 = new Headers();
    h2.set("x-api-key", "sk-x-api-key-456");
    expect(extractApiKeyFromHeaders(h2)).toBe("sk-x-api-key-456");

    expect(
      extractApiKeyFromHeaders({ authorization: "Bearer oc_sk_record_789" })
    ).toBe("oc_sk_record_789");

    expect(extractApiKeyFromHeaders({ "x-api-key": "sk-record-abc" })).toBe(
      "sk-record-abc"
    );

    expect(extractApiKeyFromHeaders(null)).toBeUndefined();
    expect(extractApiKeyFromHeaders({})).toBeUndefined();
  });

  it("never records a placeholder as a captured key", () => {
    recordCapturedApiKey(
      "sk-real-key-111",
      "opencode-go",
      "https://opencode.ai/zen/go/v1/chat/completions"
    );
    expect(getCapturedApiKey("opencode-go", "go")).toBe("sk-real-key-111");

    // The adapter's dummy values must not overwrite a working key: capturing
    // one poisons every later lookup, which then re-injects the dummy.
    for (const placeholder of [
      "unused",
      "undefined",
      "null",
      "none",
      "  UNUSED  ",
    ]) {
      expect(isPlaceholderApiKey(placeholder)).toBe(true);
      recordCapturedApiKey(
        placeholder,
        "opencode-go",
        "https://opencode.ai/zen/go/v1/chat/completions"
      );
    }
    expect(getCapturedApiKey("opencode-go", "go")).toBe("sk-real-key-111");
    expect(getCapturedApiKey(undefined, "go")).toBe("sk-real-key-111");

    expect(isPlaceholderApiKey("sk-real-key-111")).toBe(false);
    expect(isPlaceholderApiKey("oc_sk_real")).toBe(false);
  });

  describe("tierForRequest", () => {
    it("never reads the key's prefix", () => {
      // Measured: OpenCode issues `oc_sk_…` for Go credentials, so the prefix
      // names no tier. The observed URL decides, and the route after it.
      expect(
        tierForRequest(
          "https://opencode.ai/zen/go/v1/chat/completions",
          "opencode-go"
        )
      ).toBe("go");
      // The signature no longer takes the key, so it cannot be consulted.
      expect(tierForRequest.length).toBe(2);
    });

    it("files an oc_sk_ key seen on the Go plane under Go", () => {
      // The reproduction: read prefix-first, this key was filed under Zen. The
      // meter's Go lookup then missed it, and a Zen request carrying a
      // placeholder was handed the Go key.
      recordCapturedApiKey(
        "oc_sk_GOKEY_fixture",
        "opencode-go",
        "https://opencode.ai/zen/go/v1/chat/completions"
      );
      expect(getCapturedApiKey("opencode-go", "go")).toBe(
        "oc_sk_GOKEY_fixture"
      );
      expect(getCapturedApiKey(undefined, "zen")).toBeUndefined();
    });

    it("does not claim a foreign sk- key for the Go account", () => {
      // An OpenAI key on a relay a deployment routes through the patch. Read by
      // prefix it was filed as Go and offered to every Go request.
      recordCapturedApiKey(
        "sk-openai-fixture",
        "my-relay",
        "https://relay.example/v1/chat/completions"
      );
      expect(
        tierForRequest("https://relay.example/v1/chat/completions", "my-relay")
      ).toBe("unknown");
      // Unknown stays answerable by route, as before, but is not filed by tier.
      expect(getCapturedApiKey("my-relay")).toBe("sk-openai-fixture");
    });

    it("trusts the URL above the provider route id", () => {
      // The URL is what the adapter actually called; the route id is
      // user-defined config and may be named anything.
      expect(
        tierForRequest(
          "https://opencode.ai/zen/go/v1/chat/completions",
          "opencode"
        )
      ).toBe("go");
      expect(
        tierForRequest("https://opencode.ai/zen/v1/messages", "opencode-go")
      ).toBe("zen");
    });

    it("classifies both endpoint families, not just the legacy one", () => {
      // The bug this exists for. The gateway answers on two families and the
      // tier is read from the URL, but only the legacy `zen` shape was matched:
      // `…/inference/v1` matched neither branch, so every Zen request on the
      // newer family came back `unknown`. The resolver then dropped the tier
      // from its captured-key lookup, the captured working key became invisible,
      // and the adapter's `Bearer unused` placeholder went out — a 401 the user
      // read as an invalid API key on a credential that was fine.
      expect(
        tierForRequest(
          "https://opencode.ai/inference/go/v1/messages",
          "opencode"
        )
      ).toBe("go");
      expect(
        tierForRequest(
          "https://opencode.ai/inference/v1/chat/completions",
          "opencode-go"
        )
      ).toBe("zen");
      // And the legacy family still classifies, because both are still served.
      expect(
        tierForRequest(
          "https://opencode.ai/zen/go/v1/chat/completions",
          "opencode"
        )
      ).toBe("go");
      expect(
        tierForRequest("https://opencode.ai/zen/v1/messages", "opencode-go")
      ).toBe("zen");
      // An unrecognised host is still unknown rather than guessed.
      expect(tierForRequest("https://example.test/v1/chat", "my-zen")).toBe(
        "unknown"
      );
    });

    it("files a key captured on the newer family under the right account", () => {
      // The newer family has three paths of its own, and the substring checks
      // this replaces each got one of them wrong: `/inference/go` is a PREFIX of
      // `/inference/google`, so the ZEN google family was filed as a Go key —
      // a credential used on the wrong account, which fails further away than a
      // missing one — and `/inference/v1` is not inside `/inference/openai/v1`,
      // so the ZEN openai family was filed under no account at all, which is
      // the "my key is invalid" report on a key that was fine.
      expect(
        tierForRequest(
          "https://opencode.ai/inference/openai/v1/chat/completions"
        )
      ).toBe("zen");
      expect(
        tierForRequest("https://opencode.ai/inference/anthropic/v1/messages")
      ).toBe("zen");
      expect(
        tierForRequest(
          "https://opencode.ai/inference/google/v1beta/models/x:generateContent"
        )
      ).toBe("zen");
      // And the Go side of the newer family is still the Go side.
      expect(
        tierForRequest(
          "https://opencode.ai/inference/go/openai/v1/chat/completions"
        )
      ).toBe("go");
      expect(
        tierForRequest(
          "https://opencode.ai/inference/go/google/v1beta/models/x:generateContent"
        )
      ).toBe("go");
    });

    it("uses the provider id only when nothing else identifies the tier", () => {
      expect(tierForRequest(undefined, "opencode-go")).toBe("go");
      expect(tierForRequest(undefined, "opencode")).toBe("zen");
      // A renamed route with no key and an unrecognised URL is simply unknown —
      // the caller must not guess a tier from the id.
      expect(tierForRequest("https://example.test/v1/chat", "my-zen")).toBe(
        "unknown"
      );
      expect(tierForRequest()).toBe("unknown");
      expect(tierForRequest("", "")).toBe("unknown");
    });
  });
});
