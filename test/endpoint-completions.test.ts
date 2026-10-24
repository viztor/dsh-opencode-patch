/**
 * Test: OpenAI v1 Chat Completions Endpoint (/chat/completions).
 *
 * Validates the OpenAI v1 Chat Completions wire protocol:
 * - Endpoint: /chat/completions (or /zen/v1/chat/completions)
 * - Protocol: openai-completions (v1)
 * - Streaming SSE response delivery with v1 chunks and `data: [DONE]` sentinel
 * - Unary JSON response delivery with `choices[0].message` structure
 * - Protocol validation (accepts openai-completions models, rejects others with 400)
 * - Wire header validation (Authorization: Bearer <key>)
 *
 * Note: Stream wire format is parsed and understood by the host's `pi-ai` adapter,
 * not hand-decoded here.
 *
 * @module test/endpoint-completions.test
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
  V1CompletionsUnaryPayload,
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

describe("OpenAI v1 Chat Completions Endpoint (/chat/completions)", () => {
  it("delivers streaming SSE chunk response with completion data and [DONE] sentinel", async () => {
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
    expect(result.headers.get("content-type")).toContain("text/event-stream");
    expect(result.text).toContain("chat.completion.chunk");
    expect(result.text).toContain("Hello from ");
    expect(result.text).toContain("the mock gateway.");
    expect(result.text).toContain("[DONE]");

    const req = result.request!;
    expect(req.kind).toBe("completions");
    expect(req.protocol).toBe("openai-completions");
    expect(req.model).toBe("beam-free");
    expect(req.headers.authorization).toBe(`Bearer ${ZEN_KEY}`);
    expect(req.headers["x-opencode-session-id"]).toBe(MOCK_SESSION);
  });

  it("delivers unary application/json response when stream is false", async () => {
    const result = await runner.execute(
      "opencode",
      "/zen/v1/chat/completions",
      {
        body: {
          messages: [{ content: "hi", role: "user" }],
          model: "beam-free",
          stream: false,
        },
      }
    );

    expect(result.status).toBe(200);
    expect(result.headers.get("content-type")).toContain("application/json");

    const body = result.json<V1CompletionsUnaryPayload>();
    expect(body.object).toBe("chat.completion");
    expect(body.choices[0]!.message.content).toBe(
      "Hello from the mock gateway."
    );
    expect(body.choices[0]!.finish_reason).toBe("stop");
    expect(body.usage.total_tokens).toBeGreaterThan(0);
  });

  it("refuses models not served by openai-completions with 400 ModelProtocolUnsupported", async () => {
    const result = await runner.execute(
      "opencode",
      "/zen/v1/chat/completions",
      {
        body: {
          messages: [{ content: "hi", role: "user" }],
          model: "gpt-5.4",
          stream: true,
        },
      }
    );

    expect(result.status).toBe(400);
    const body = result.json<GatewayErrorPayload>();
    expect(body.error.type).toBe("model_protocol_unsupported");
    expect(body.error.message).toContain("ModelProtocolUnsupported");
    expect(result.request?.reject).toBe("protocol");
  });
});
