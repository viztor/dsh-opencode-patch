/**
 * Test: Google Generative AI Endpoint.
 *
 * Validates:
 * - URL path model extraction: /models/{model}:streamGenerateContent vs :generateContent
 * - Streaming SSE response delivery via :streamGenerateContent
 * - Unary JSON response delivery via :generateContent
 * - Authentication via x-goog-api-key wire header
 * - Protocol validation (accepts google-generative-ai models, rejects others with 400)
 *
 * Note: Stream wire format is parsed and understood by the host's `pi-ai` adapter,
 * not hand-decoded here.
 *
 * @module test/endpoint-google.test
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
  GoogleUnaryPayload,
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

describe("Google Generative AI Endpoint", () => {
  it("delivers streaming SSE response via /models/{model}:streamGenerateContent", async () => {
    const result = await runner.execute(
      "opencode",
      "/zen/v1/models/gemini-3.1-pro:streamGenerateContent?alt=sse",
      {
        body: { contents: [{ parts: [{ text: "hi" }], role: "user" }] },
      }
    );

    expect(result.status).toBe(200);
    expect(result.headers.get("content-type")).toContain("text/event-stream");
    expect(result.text).toContain("Hello from ");
    expect(result.text).toContain("the mock gateway.");
    expect(result.text).toContain("STOP");

    const req = result.request!;
    expect(req.kind).toBe("google");
    expect(req.protocol).toBe("google-generative-ai");
    expect(req.model).toBe("gemini-3.1-pro");
    expect(req.headers["x-goog-api-key"]).toBe(ZEN_KEY);
    expect(req.headers["x-opencode-session-id"]).toBe(MOCK_SESSION);
  });

  it("delivers unary application/json response via /models/{model}:generateContent", async () => {
    const result = await runner.execute(
      "opencode",
      "/zen/v1/models/gemini-3.1-pro:generateContent",
      {
        body: { contents: [{ parts: [{ text: "hi" }], role: "user" }] },
      }
    );

    expect(result.status).toBe(200);
    expect(result.headers.get("content-type")).toContain("application/json");

    const body = result.json<GoogleUnaryPayload>();
    expect(body.modelVersion).toBe("gemini-3.1-pro");
    expect(body.candidates[0]!.content.parts[0]!.text).toBe(
      "Hello from the mock gateway."
    );
    expect(body.candidates[0]!.finishReason).toBe("STOP");
    expect(body.usageMetadata.totalTokenCount).toBeGreaterThan(0);
  });

  it("extracts model ID from URL path rather than JSON body", async () => {
    const result = await runner.execute(
      "opencode",
      "/zen/v1/models/gemini-3.1-pro:generateContent",
      {
        body: { contents: [{ parts: [{ text: "hello" }], role: "user" }] },
      }
    );

    expect(result.status).toBe(200);
    expect(result.request?.model).toBe("gemini-3.1-pro");
  });

  it("refuses models not served by google-generative-ai with 400 ModelProtocolUnsupported", async () => {
    const result = await runner.execute(
      "opencode",
      "/zen/v1/models/gpt-5.4:generateContent",
      {
        body: { contents: [{ parts: [{ text: "hi" }], role: "user" }] },
      }
    );

    expect(result.status).toBe(400);
    const body = result.json<GatewayErrorPayload>();
    expect(body.error.type).toBe("model_protocol_unsupported");
    expect(body.error.message).toContain("ModelProtocolUnsupported");
    expect(result.request?.reject).toBe("protocol");
  });
});
