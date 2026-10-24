/**
 * Test: Anthropic Messages Endpoint (/messages).
 *
 * Validates:
 * - Streaming SSE events (message_start, content_block_delta, message_delta, message_stop)
 * - Unary JSON response delivery when stream is false
 * - Authentication via x-api-key wire header
 * - Protocol validation (accepts anthropic-messages models, rejects others with 400)
 *
 * Note: Stream wire format is parsed and understood by the host's `pi-ai` adapter,
 * not hand-decoded here.
 *
 * @module test/endpoint-messages.test
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

import type {
  GatewayErrorPayload,
  MessagesUnaryPayload,
} from "./mock/protocols/index.ts";
import {
  GatewayTestRunner,
  MOCK_SESSION,
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
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("Anthropic Messages Endpoint (/messages)", () => {
  it("delivers streaming SSE response with content_block_delta events", async () => {
    const result = await runner.execute("opencode", "/zen/v1/messages", {
      body: {
        max_tokens: 64,
        messages: [{ content: "hi", role: "user" }],
        model: "claude-sonnet-4-6",
        stream: true,
      },
    });

    expect(result.status).toBe(200);
    expect(result.headers.get("content-type")).toContain("text/event-stream");
    expect(result.text).toContain("message_start");
    expect(result.text).toContain("content_block_delta");
    expect(result.text).toContain("Hello from ");
    expect(result.text).toContain("the mock gateway.");
    expect(result.text).toContain("message_stop");

    const req = result.request!;
    expect(req.kind).toBe("messages");
    expect(req.protocol).toBe("anthropic-messages");
    expect(req.model).toBe("claude-sonnet-4-6");
    expect(req.headers["x-api-key"]).toBe(ZEN_KEY);
    expect(req.headers["x-opencode-session-id"]).toBe(MOCK_SESSION);
  });

  it("delivers unary application/json response when stream is false", async () => {
    const result = await runner.execute("opencode", "/zen/v1/messages", {
      body: {
        max_tokens: 64,
        messages: [{ content: "hi", role: "user" }],
        model: "claude-sonnet-4-6",
        stream: false,
      },
    });

    expect(result.status).toBe(200);
    expect(result.headers.get("content-type")).toContain("application/json");

    const body = result.json<MessagesUnaryPayload>();
    expect(body.type).toBe("message");
    expect(body.role).toBe("assistant");
    expect(body.content[0]!.text).toBe("Hello from the mock gateway.");
    expect(body.stop_reason).toBe("end_turn");
    expect(body.usage.output_tokens).toBeGreaterThan(0);
  });

  it("refuses models not served by anthropic-messages with 400 ModelProtocolUnsupported", async () => {
    const result = await runner.execute("opencode", "/zen/v1/messages", {
      body: {
        max_tokens: 64,
        messages: [{ content: "hi", role: "user" }],
        model: "gpt-5.4",
        stream: true,
      },
    });

    expect(result.status).toBe(400);
    const body = result.json<GatewayErrorPayload>();
    expect(body.error.type).toBe("model_protocol_unsupported");
    expect(body.error.message).toContain("ModelProtocolUnsupported");
    expect(result.request?.reject).toBe("protocol");
  });
});
