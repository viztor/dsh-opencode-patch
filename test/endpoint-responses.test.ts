/**
 * Test: OpenAI v2 Responses API Endpoint (/responses).
 *
 * Validates the OpenAI v2 Responses wire protocol:
 * - Endpoint: /responses (or /zen/v1/responses)
 * - Protocol: openai-responses (v2)
 * - Streaming SSE response delivery with typed events:
 *   (response.created, response.output_text.delta, response.completed)
 * - Unary JSON response generation when stream is false
 * - Automatic core tool injection (read, bash) for free-tier models (e.g. beam-free)
 * - Tool omission for paid models (e.g. gpt-5.4)
 * - Configurable injectCoreTools toggle
 * - Wire header validation and session header compliance
 *
 * Note: Stream wire format is parsed and understood by the host's `pi-ai` adapter,
 * not hand-decoded here.
 *
 * @module test/endpoint-responses.test
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

import type { V2ResponsesUnaryPayload } from "./mock/protocols/index.ts";
import {
  GatewayTestRunner,
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
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("OpenAI v2 Responses Endpoint (/responses)", () => {
  it("delivers full streaming SSE response with deltas and completion events", async () => {
    const result = await runner.execute("opencode", "/zen/v1/responses", {
      body: { input: [], model: "gpt-5.4", stream: true },
    });

    expect(result.status).toBe(200);
    expect(result.headers.get("content-type")).toContain("text/event-stream");
    expect(result.text).toContain("response.created");
    expect(result.text).toContain("response.output_text.delta");
    expect(result.text).toContain("Hello from ");
    expect(result.text).toContain("the mock gateway.");
    expect(result.text).toContain("response.completed");

    const req = result.request!;
    expect(req.kind).toBe("responses");
    expect(req.protocol).toBe("openai-responses");
    expect(req.model).toBe("gpt-5.4");
    expect(req.headers["x-opencode-session-id"]).toBe(MOCK_SESSION);
  });

  it("delivers unary application/json response when stream is false", async () => {
    const result = await runner.execute("opencode", "/zen/v1/responses", {
      body: { input: [], model: "gpt-5.4", stream: false },
    });

    expect(result.status).toBe(200);
    expect(result.headers.get("content-type")).toContain("application/json");

    const body = result.json<V2ResponsesUnaryPayload>();
    expect(body.id).toBe("resp_mock");
    expect(body.object).toBe("response");
    expect(body.model).toBe("gpt-5.4");
    expect(body.status).toBe("completed");
    expect(body.output[0]!.content[0]!.text).toBe(MOCK_TEXT);
    expect(body.usage.total_tokens).toBeGreaterThan(0);
  });

  it("injects read and bash core tools for free-tier completions models", async () => {
    // `beam-free` is the active free fixture, and the free tier is served on
    // /chat/completions — the vendor's own per-model protocol table has no
    // free model on /responses any more (the last one,
    // muse-spark-1.2-contributor-free, was deprecated upstream).
    const result = await runner.execute(
      "opencode",
      "/zen/v1/chat/completions",
      {
        body: {
          messages: [{ content: "hi", role: "user" }],
          model: "beam-free",
          stream: true,
        },
        config: { injectCoreTools: true },
      }
    );

    expect(result.status).toBe(200);
    const recorded = result.request!;
    expect(recorded.body).toBeDefined();

    const body = recorded.body as {
      tools?: { name?: string; function?: { name?: string } }[];
    };
    expect(body.tools).toBeDefined();
    const toolNames = body.tools!.map((t) => t.function?.name ?? t.name);
    expect(toolNames).toContain("read");
    expect(toolNames).toContain("bash");
  });

  it("omits core tool injection for paid models", async () => {
    const result = await runner.execute("opencode", "/zen/v1/responses", {
      body: { input: [], model: "gpt-5.4", stream: true },
      config: { injectCoreTools: true },
    });

    expect(result.status).toBe(200);
    const recorded = result.request!;
    const body = recorded.body as { tools?: unknown[] };
    expect(body.tools).toBeUndefined();
  });

  it("respects injectCoreTools: false, and the gateway then refuses a free model", async () => {
    // Turning the fallback off is honoured — nothing is injected — and the
    // consequence is now visible rather than implied: a free-tier body with no
    // tools answers `403 FreeTierError` (measured against the live gateway, and
    // modelled by the mock). The configuration is the operator's choice; the
    // refusal is the gateway's.
    const result = await runner.execute(
      "opencode",
      "/zen/v1/chat/completions",
      {
        body: {
          messages: [{ content: "hi", role: "user" }],
          model: "beam-free",
          stream: true,
        },
        config: { injectCoreTools: false },
      }
    );

    expect(result.status).toBe(403);
    const recorded = result.request!;
    const body = recorded.body as { tools?: unknown[] };
    expect(body.tools).toBeUndefined();
  });
});
