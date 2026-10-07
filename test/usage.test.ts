/**
 * OpenCode Go Usage.
 *
 * Split out of the former monolithic `plugin.test.ts`.
 *
 * @module test/usage.test
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  GoUsageService,
  clearCapturedApiKeys,
  clearSessionUsageStore,
  discoverGoConfig,
  extractApiKeyFromHeaders,
  getCapturedApiKey,
  isPlaceholderApiKey,
  KEY_SOURCE_POLICIES,
  parseGoUsage,
  parseUsageQuery,
  recordCapturedApiKey,
  recordTurnUsage,
  resolveGoApiKey,
  resolveRoutedKey,
  resolveZenCreditInfo,
  tierForRequest,
} from "../src/index.ts";
import { createMockContext } from "./test-helpers.ts";

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

  it("scopes session spend to the conversation that asked for it", async () => {
    clearSessionUsageStore();
    // Two conversations have spend; the Host must not conflate them.
    recordTurnUsage(
      "session-a",
      { inputTokens: 1_000_000, totalTokens: 1_000_000 },
      { input: 1, output: 1 },
      "model-a"
    );
    recordTurnUsage(
      "session-b",
      { inputTokens: 2_000_000, totalTokens: 2_000_000 },
      { input: 1, output: 1 },
      "model-b"
    );

    const originalFetch = globalThis.fetch;
    try {
      // A fresh Response per call: a Response body can only be read once, and
      // this test reads twice.
      globalThis.fetch = vi.fn().mockImplementation(async () =>
        Response.json({
          usage: {
            monthly: {
              percent: 1,
              resetsAt: new Date().toISOString(),
              status: "ok",
            },
            rolling: {
              percent: 1,
              resetsAt: new Date().toISOString(),
              status: "ok",
            },
            weekly: {
              percent: 1,
              resetsAt: new Date().toISOString(),
              status: "ok",
            },
          },
        })
      );
      const service = new GoUsageService(createMockContext(), {
        baseURL: () => "https://opencode.ai/zen/go/v1",
        resolveApiKey: () => Promise.resolve("test_key_123"),
      });

      const a = await service.read({ sessionId: "session-a" });
      expect(a.session?.activeModel).toBe("model-a");
      expect(a.session?.totalTokens).toBe(1_000_000);

      const b = await service.read({ sessionId: "session-b" });
      expect(b.session?.activeModel).toBe("model-b");
      expect(b.session?.totalTokens).toBe(2_000_000);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("GoUsageService throws RemoteError when API key is missing", async () => {
    const service = new GoUsageService(createMockContext(), {
      baseURL: () => "https://opencode.ai/zen/go/v1",
      resolveApiKey: () => Promise.resolve(""),
    });
    await expect(service.read()).rejects.toThrow(
      "OpenCode Go API key is not configured"
    );
  });

  it("GoUsageService reads and parses successfully with valid mock fetch", async () => {
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = vi
        .fn()
        .mockResolvedValue(Response.json(samplePayload));

      const service = new GoUsageService(createMockContext(), {
        baseURL: () => "https://opencode.ai/zen/go/v1",
        resolveApiKey: () => Promise.resolve("test_key_123"),
      });

      const usage = await service.read();
      expect(usage.monthly.percent).toBe(100);
      expect(usage.weekly.percent).toBe(42);
      expect(usage.source).toBeDefined();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("GoUsageService handles upstream 429/temporary error with RemoteError", async () => {
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = vi
        .fn()
        .mockResolvedValue(
          new Response("rate limit exceeded", { status: 429 })
        );

      const service = new GoUsageService(createMockContext(), {
        baseURL: () => "https://opencode.ai/zen/go/v1",
        resolveApiKey: () => Promise.resolve("test_key_123"),
      });

      await expect(service.read()).rejects.toThrow(
        "OpenCode Go usage unavailable (HTTP 429)"
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("discoverGoConfig discovers provider config from llm-pi-ai entries", () => {
    const mockCtx = {
      loader: {
        entries: () => [
          {
            options: {
              config: {
                providers: {
                  "opencode-go": {
                    apiKeyEnv: "CUSTOM_GO_KEY_ENV",
                    baseURL: "https://custom-gateway.com/zen/go/v1",
                  },
                },
              },
              id: "llm-pi-ai",
              name: "@deepseek-ai/dsh-llm-pi-ai",
            },
          },
        ],
      },
    };

    const discovered = discoverGoConfig(mockCtx);
    expect(discovered.keyEnv).toBe("CUSTOM_GO_KEY_ENV");
    expect(discovered.baseURL).toBe("https://custom-gateway.com/zen/go/v1");
  });

  it("discoverGoConfig discovers literal apiKey from standalone opencode-go entry", () => {
    const mockCtx = {
      loader: {
        entries: () => [
          {
            options: {
              config: {
                apiKey: "sk-literal-test-key",
              },
              id: "opencode-go",
              name: "dsh-opencode-go",
            },
          },
        ],
      },
    };

    const discovered = discoverGoConfig(mockCtx);
    expect(discovered.literalKey).toBe("sk-literal-test-key");
  });

  it("discoverGoConfig discovers literal apiKey from headers.authorization in provider entry", () => {
    const mockCtx = {
      loader: {
        entries: () => [
          {
            options: {
              config: {
                providers: {
                  "opencode-go": {
                    headers: {
                      authorization: "Bearer sk-header-discovered-key",
                    },
                  },
                },
              },
              id: "llm-pi-ai",
            },
          },
        ],
      },
    };

    const discovered = discoverGoConfig(mockCtx);
    expect(discovered.literalKey).toBe("sk-header-discovered-key");
  });

  it("discoverGoConfig discovers literal apiKey from options.headers and options.apiKey", () => {
    const mockCtxHeaders = {
      loader: {
        entries: () => [
          {
            options: {
              config: {
                options: {
                  headers: {
                    "x-api-key": "sk-options-headers-key",
                  },
                },
              },
              id: "opencode-go",
            },
          },
        ],
      },
    };
    expect(discoverGoConfig(mockCtxHeaders).literalKey).toBe(
      "sk-options-headers-key"
    );

    const mockCtxOptionKey = {
      loader: {
        entries: () => [
          {
            options: {
              config: {
                options: {
                  apiKey: "sk-options-direct-key",
                },
              },
              id: "opencode-go",
            },
          },
        ],
      },
    };
    expect(discoverGoConfig(mockCtxOptionKey).literalKey).toBe(
      "sk-options-direct-key"
    );
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

  it("resolveGoApiKey resolves key from captured request header when env is unset", async () => {
    delete process.env.OPENCODE_GO_API_KEY;
    delete process.env.OPENCODE_API_KEY;
    const mockCtx = { loader: { entries: () => [] } };

    // Initially unset
    expect(await resolveGoApiKey(mockCtx)).toBeUndefined();

    // Now record a key that was captured from a live request header
    recordCapturedApiKey(
      "sk-live-captured-key-888",
      "opencode-go",
      "https://opencode.ai/zen/go/v1/chat/completions"
    );

    expect(getCapturedApiKey("opencode-go", "go")).toBe(
      "sk-live-captured-key-888"
    );
    expect(await resolveGoApiKey(mockCtx)).toBe("sk-live-captured-key-888");
  });

  it("resolveZenCreditInfo detects captured Zen key when env is unset", async () => {
    delete process.env.OPENCODE_API_KEY;
    const mockCtx = { loader: { entries: () => [] } };

    const before = await resolveZenCreditInfo(mockCtx);
    expect(before.isConfigured).toBe(false);

    recordCapturedApiKey(
      "oc_sk_live_captured_zen_key",
      "opencode",
      "https://opencode.ai/zen/v1/messages"
    );

    const after = await resolveZenCreditInfo(mockCtx);
    expect(after.isConfigured).toBe(true);
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
    it("trusts the key prefix above every configured signal", () => {
      // The prefix is intrinsic to the credential, so it survives both a
      // rotated key and a route the user renamed.
      expect(
        tierForRequest(
          "https://opencode.ai/zen/v1/messages",
          "opencode",
          "sk-x"
        )
      ).toBe("go");
      expect(
        tierForRequest(
          "https://opencode.ai/zen/go/v1/chat/completions",
          "opencode-go",
          "oc_sk_x"
        )
      ).toBe("zen");
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

    it("uses the provider id only when nothing else identifies the tier", () => {
      expect(tierForRequest(undefined, "opencode-go")).toBe("go");
      expect(tierForRequest(undefined, "opencode")).toBe("zen");
      // A renamed route with no key and an unrecognised URL is simply unknown —
      // the caller must not guess a tier from the id.
      expect(tierForRequest("https://example.test/v1/chat", "my-zen")).toBe(
        "unknown"
      );
      expect(tierForRequest()).toBe("unknown");
      expect(tierForRequest("", "", "")).toBe("unknown");
    });
  });

  describe("keySource policy", () => {
    /** A composition that declares a literal Go key, as another row may. */
    const withLiteralKey = () => ({
      loader: {
        entries: () => [
          {
            options: {
              config: {
                providers: { "opencode-go": { apiKey: "sk-literal-key" } },
              },
            },
          },
        ],
      },
    });
    const withoutDeclarations = { loader: { entries: () => [] } };
    const captureGoKey = () =>
      recordCapturedApiKey(
        "sk-captured-key",
        "opencode-go",
        "https://opencode.ai/zen/go/v1/chat/completions"
      );

    it("auto keeps the declared literal ahead of a captured key", async () => {
      captureGoKey();
      expect(await resolveGoApiKey(withLiteralKey(), undefined, "auto")).toBe(
        "sk-literal-key"
      );
    });

    it("request promotes a captured key above the declared literal", async () => {
      // The whole point of the policy: a rotated live key beats a pinned one.
      captureGoKey();
      expect(
        await resolveGoApiKey(withLiteralKey(), undefined, "request")
      ).toBe("sk-captured-key");
    });

    it("configured prefers the declared credential over a captured key", async () => {
      process.env.OPENCODE_GO_API_KEY = "sk-env-key";
      captureGoKey();
      // auto and request both take the live key…
      expect(
        await resolveGoApiKey(withoutDeclarations, undefined, "auto")
      ).toBe("sk-captured-key");
      expect(
        await resolveGoApiKey(withoutDeclarations, undefined, "request")
      ).toBe("sk-captured-key");
      // …while configured takes the declared one.
      expect(
        await resolveGoApiKey(withoutDeclarations, undefined, "configured")
      ).toBe("sk-env-key");
    });

    it("every policy still falls back to a captured key when nothing declares one", async () => {
      // Cold start is the case capture cannot serve, and it is why credentials
      // and the environment stay in every policy's order.
      captureGoKey();
      for (const policy of KEY_SOURCE_POLICIES) {
        expect(
          await resolveGoApiKey(withoutDeclarations, undefined, policy)
        ).toBe("sk-captured-key");
      }
    });

    it("resolveRoutedKey honours the same order", async () => {
      process.env.OPENCODE_GO_API_KEY = "sk-env-key";
      captureGoKey();
      const automatic = await resolveRoutedKey(
        withoutDeclarations,
        "opencode-go",
        "auto"
      );
      expect(automatic.key).toBe("sk-captured-key");
      const requested = await resolveRoutedKey(
        withoutDeclarations,
        "opencode-go",
        "request"
      );
      const declared = await resolveRoutedKey(
        withoutDeclarations,
        "opencode-go",
        "configured"
      );
      expect(requested.key).toBe("sk-captured-key");
      expect(declared.key).toBe("sk-env-key");
    });
  });
});
