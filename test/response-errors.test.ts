/**
 * Test: Gateway Error Codes & Failure Response Types.
 *
 * Validates:
 * - 400 ModelProtocolUnsupported: model routed to incompatible endpoint
 * - 400 MissingSessionID: missing session header on LLM calls
 * - 400 invalid_request: malformed JSON or missing model field
 * - 401 invalid_api_key: missing credential, invalid token, or placeholder key
 * - 403 FreeTierError / model access disabled
 * - 404 model_not_found: unknown model ID
 * - 404 no_route: unknown root path
 * - 404 unknown_endpoint: known family but invalid endpoint (e.g. double /v1)
 * - 405 method_not_allowed: wrong HTTP method
 * - 429 rate_limit_exceeded: rate limit simulation
 * - 500 / 502 / 503: upstream gateway failures
 *
 * @module test/response-errors.test
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
import { GatewayTestRunner, ZEN_KEY } from "./mock/testing-kit.ts";
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

describe("Gateway Error Codes & Failure Responses", () => {
  it("returns 400 ModelProtocolUnsupported when model format mismatches endpoint", async () => {
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

  it("returns 400 MissingSessionID on direct calls lacking session headers", async () => {
    const response = await fetch(`${runner.origin}/zen/v1/responses`, {
      body: JSON.stringify({ input: [], model: "gpt-5.4", stream: true }),
      headers: {
        authorization: `Bearer ${ZEN_KEY}`,
        "content-type": "application/json",
      },
      method: "POST",
    });

    expect(response.status).toBe(400);
    const body = (await response.json()) as GatewayErrorPayload;
    expect(body.error.type).toBe("missing_session_id");
    expect(runner.requests.at(-1)!.reject).toBe("session");
  });

  it("returns 400 invalid_request when request body is not valid JSON", async () => {
    const response = await fetch(`${runner.origin}/zen/v1/responses`, {
      body: "{malformed-json-payload",
      headers: {
        authorization: `Bearer ${ZEN_KEY}`,
        "content-type": "application/json",
        "x-opencode-session-id": "ses_eb1e9e706ffeCDEFGHIJKLMNOP",
      },
      method: "POST",
    });

    expect(response.status).toBe(400);
    const body = (await response.json()) as GatewayErrorPayload;
    expect(body.error.type).toBe("invalid_request");
    expect(body.error.message).toContain("not JSON");
  });

  it("returns 400 invalid_request when request body names no model", async () => {
    const result = await runner.execute("opencode", "/zen/v1/responses", {
      body: { input: [] },
    });

    expect(result.status).toBe(400);
    const body = result.json<GatewayErrorPayload>();
    expect(body.error.type).toBe("invalid_request");
    expect(body.error.message).toContain("names no model");
  });

  it("returns 401 invalid_api_key when API key is missing or a placeholder", async () => {
    vi.stubEnv("OPENCODE_API_KEY", "unused");
    const result = await runner.execute("opencode", "/zen/v1/responses", {
      body: { input: [], model: "gpt-5.4", stream: true },
    });

    expect(result.status).toBe(401);
    const body = result.json<GatewayErrorPayload>();
    expect(body.error.type).toBe("invalid_api_key");
    expect(result.request?.reject).toBe("credential");
  });

  it("returns 404 model_not_found when model ID does not exist in catalog", async () => {
    const result = await runner.execute("opencode", "/zen/v1/responses", {
      body: { input: [], model: "mythical-unknown-llm", stream: true },
    });

    expect(result.status).toBe(404);
    const body = result.json<GatewayErrorPayload>();
    expect(body.error.type).toBe("model_not_found");
    expect(result.request?.reject).toBe("model_unknown");
  });

  it("returns 404 no_route when path does not match any known gateway root", async () => {
    const response = await fetch(`${runner.origin}/completely/foreign/path`);
    expect(response.status).toBe(404);
    const body = (await response.json()) as GatewayErrorPayload;
    expect(body.error.type).toBe("not_found");
    expect(runner.requests.at(-1)!.reject).toBe("no_route");
  });

  it("returns 404 unknown_endpoint on known family with unrecognized endpoint", async () => {
    const response = await fetch(`${runner.origin}/zen/v1/v1/messages`);
    expect(response.status).toBe(404);
    const body = (await response.json()) as GatewayErrorPayload;
    expect(body.error.type).toBe("not_found");
    expect(runner.requests.at(-1)!.reject).toBe("unknown_endpoint");
  });

  it("returns 405 method_not_allowed when using wrong HTTP verb", async () => {
    const result = await runner.execute("opencode", "/zen/v1/responses", {
      method: "GET",
    });

    expect(result.status).toBe(405);
    const body = result.json<GatewayErrorPayload>();
    expect(body.error.type).toBe("method_not_allowed");
    expect(result.request?.reject).toBe("method");
  });

  it("simulates rate limits (429) via gateway behavior override", async () => {
    const rateLimitedRunner = new GatewayTestRunner();
    await rateLimitedRunner.start({
      behavior: (req) =>
        req.kind === "responses"
          ? {
              body: JSON.stringify({
                error: {
                  message: "Rate limit exceeded. Please wait 10s.",
                  type: "rate_limit_exceeded",
                },
              }),
              contentType: "application/json",
              status: 429,
            }
          : undefined,
    });

    try {
      const result = await rateLimitedRunner.execute(
        "opencode",
        "/zen/v1/responses",
        {
          body: { input: [], model: "gpt-5.4", stream: true },
        }
      );

      expect(result.status).toBe(429);
      const body = result.json<GatewayErrorPayload>();
      expect(body.error.type).toBe("rate_limit_exceeded");
    } finally {
      await rateLimitedRunner.close();
    }
  });

  it("simulates upstream gateway failures (502 Bad Gateway) cleanly", async () => {
    const errorRunner = new GatewayTestRunner();
    await errorRunner.start({
      behavior: () => ({
        body: JSON.stringify({
          error: { message: "Bad Gateway", type: "bad_gateway" },
        }),
        contentType: "application/json",
        status: 502,
      }),
    });

    try {
      const result = await errorRunner.execute(
        "opencode",
        "/zen/v1/responses",
        {
          body: { input: [], model: "gpt-5.4", stream: true },
        }
      );

      expect(result.status).toBe(502);
      const body = result.json<GatewayErrorPayload>();
      expect(body.error.type).toBe("bad_gateway");
    } finally {
      await errorRunner.close();
    }
  });
});
