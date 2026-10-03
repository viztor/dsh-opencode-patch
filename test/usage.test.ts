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
  discoverGoConfig,
  parseGoUsage,
  usageRemote,
} from "../src/index.ts";
import { createMockContext } from "./test-helpers.ts";

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.OPENCODE_SESSION_ID;
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

  it("declares usageRemote contribution with correct package and descriptor", () => {
    expect(usageRemote.package).toBe("dsh-opencode-patch");
    expect(usageRemote.descriptors.length).toBe(1);
    expect(usageRemote.descriptors[0]?.namespace).toBe("opencodeGoUsage");
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
});
