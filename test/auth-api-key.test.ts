/**
 * Test: API Key Authentication Method.
 *
 * Validates API Key authentication across:
 * - Configured API keys (Zen & Go)
 * - Environment variables (OPENCODE_API_KEY, OPENCODE_GO_API_KEY)
 * - Wire header routing (Authorization: Bearer, x-api-key, x-goog-api-key)
 * - Placeholder key rejection (none, null, undefined, unused)
 *
 * @module test/auth-api-key.test
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import type { GatewayErrorPayload } from "./mock/protocols/index.ts";
import {
  GatewayTestRunner,
  GO_KEY,
  MOCK_SESSION,
  MOCK_TEXT,
  ZEN_KEY,
} from "./mock/testing-kit.ts";
import { clearCapturedApiKeys } from "./support/src.ts";

let runner: GatewayTestRunner;

beforeAll(async () => {
  runner = new GatewayTestRunner();
  await runner.start();
});

afterAll(async () => {
  await runner.close();
});

beforeEach(() => {
  runner.clearRequests();
  clearCapturedApiKeys();
  vi.stubEnv("OPENCODE_API_KEY", ZEN_KEY);
  vi.stubEnv("OPENCODE_GO_API_KEY", GO_KEY);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("API Key Authentication", () => {
  it("authenticates OpenAI Responses requests using Authorization Bearer header", async () => {
    const result = await runner.execute("opencode", "/zen/v1/responses", {
      body: { input: [], model: "gpt-5.4", stream: true },
    });

    expect(result.status).toBe(200);
    expect(result.headers.get("content-type")).toContain("text/event-stream");
    expect(result.text).toContain(MOCK_TEXT);

    const req = result.request!;
    expect(req.plane).toBe("opencode");
    expect(req.kind).toBe("responses");
    expect(req.protocol).toBe("openai-responses");
    expect(req.headers.authorization).toBe(`Bearer ${ZEN_KEY}`);
    expect(req.headers["x-opencode-session-id"]).toBe(MOCK_SESSION);
    expect(req.reject).toBeNull();
  });

  it("authenticates Chat Completions requests using Authorization Bearer header", async () => {
    const result = await runner.execute(
      "opencode",
      "/zen/v1/chat/completions",
      {
        body: {
          messages: [{ content: "hi", role: "user" }],
          model: "beam-free",
          stream: true,
        },
      }
    );

    expect(result.status).toBe(200);
    expect(result.request?.headers.authorization).toBe(`Bearer ${ZEN_KEY}`);
  });

  it("authenticates Anthropic Messages with x-api-key ALONE", async () => {
    const result = await runner.execute("opencode", "/zen/v1/messages", {
      body: {
        max_tokens: 64,
        messages: [{ content: "hi", role: "user" }],
        model: "claude-sonnet-4-6",
        stream: true,
      },
    });

    expect(result.status).toBe(200);
    expect(result.request?.headers["x-api-key"]).toBe(ZEN_KEY);
    // **Only the protocol's own header.** The official client passes the key as
    // an SDK option and lets the SDK choose the header
    // (`provider/provider.ts:240`); it never sets `Authorization` on an Anthropic
    // request. A second copy of the credential on a header this protocol does not
    // read is not a fallback, it is a divergence.
    expect(result.request?.headers.authorization).toBeUndefined();
  });

  it("authenticates Google Generative AI requests using x-goog-api-key header", async () => {
    const result = await runner.execute(
      "opencode",
      "/zen/v1/models/gemini-3.1-pro:streamGenerateContent?alt=sse",
      {
        body: { contents: [{ parts: [{ text: "hi" }], role: "user" }] },
      }
    );

    expect(result.status).toBe(200);
    expect(result.request?.headers["x-goog-api-key"]).toBe(ZEN_KEY);
    // Same rule as Anthropic: the Google protocol reads its own header.
    expect(result.request?.headers.authorization).toBeUndefined();
  });

  it("authenticates Go plane requests using OPENCODE_GO_API_KEY", async () => {
    const result = await runner.execute("opencode-go", "/zen/go/v1/usage", {});

    expect(result.status).toBe(200);
    const req = result.request!;
    expect(req.plane).toBe("opencode-go");
    expect(req.headers.authorization).toBe(`Bearer ${GO_KEY}`);
  });

  it("rejects placeholder credentials with 401 Invalid API key", async () => {
    vi.stubEnv("OPENCODE_API_KEY", "unused");
    const result = await runner.execute("opencode", "/zen/v1/responses", {
      body: { input: [], model: "gpt-5.4", stream: true },
    });

    expect(result.status).toBe(401);
    const body = result.json<GatewayErrorPayload>();
    expect(body.error.type).toBe("invalid_api_key");
    expect(result.request?.reject).toBe("credential");
  });
});
