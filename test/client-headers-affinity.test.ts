/**
 * Test: Client Headers, Session Affinity, and Lineage Contracts.
 *
 * Validates:
 * - 1.19.5 generation contracts: x-opencode-session-id and x-opencode-session, no affinity on OpenCode planes
 * - Relay providers: sends x-session-affinity and x-session-id pair
 * - Subagent parent session lineage: x-opencode-parent-session-id and x-parent-session-id
 * - Session header recovery: patchFetch automatically derives a valid ses_<...> ID when missing
 * - User-Agent customization and injectUserAgent toggle
 * - Origin headers: x-opencode-client, x-opencode-project, and the turn's
 *   x-opencode-request message id
 *
 * @module test/client-headers-affinity.test
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

import { clearCapturedApiKeys } from "../src/key-capture.ts";
import {
  PARENT_SESSION_ALT_HEADER,
  PARENT_SESSION_HEADER,
  SESSION_AFFINITY_HEADER,
  SESSION_HEADER,
} from "../src/session.ts";
import {
  ClientSimulator,
  GatewayTestRunner,
  MOCK_SESSION,
  ZEN_KEY,
} from "./mock/testing-kit.ts";

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

describe("Client Headers, Session Affinity & Lineage", () => {
  it("injects 1.19.5 generation headers on OpenCode planes without affinity headers", async () => {
    const client = new ClientSimulator({
      generation: "1.19.5",
      project: "dsh-affinity-test",
      sessionId: "ses_eb1e9e706ffeCDEFGHIJKLMNOP",
    });

    const result = await runner.execute("opencode", "/zen/v1/responses", {
      body: { input: [], model: "gpt-5.4", stream: true },
      clientSimulator: client,
    });

    expect(result.status).toBe(200);
    const req = result.request!;
    expect(req.headers["x-opencode-session-id"]).toBe(client.sessionId);
    expect(req.headers[SESSION_HEADER]).toBe(client.sessionId);
    expect(req.headers[SESSION_AFFINITY_HEADER]).toBeUndefined();
    expect(req.headers["x-session-id"]).toBeUndefined();
  });

  it("injects affinity pair for relay / non-OpenCode providers", async () => {
    const client = new ClientSimulator({
      generation: "1.19.5",
      sessionId: "ses_eb1e9e706fferalay0000000000",
    });

    const result = await runner.execute("opencode", "/zen/v1/responses", {
      body: { input: [], model: "gpt-5.4", stream: true },
      turnState: client.asTurnState({ provider: "relay-deepseek" }),
    });

    expect(result.status).toBe(200);
    const req = result.request!;
    expect(req.headers[SESSION_AFFINITY_HEADER]).toBe(client.sessionId);
    expect(req.headers["x-session-id"]).toBe(client.sessionId);
  });

  it("propagates parent lineage headers for subagents and child sessions", async () => {
    const parentId = "ses_eb1e9e706ffeparent12345678";
    const client = new ClientSimulator({
      parentSessionId: parentId,
      sessionId: "ses_eb1e9e706ffchild0123456789",
    });

    const result = await runner.execute("opencode", "/zen/v1/responses", {
      body: { input: [], model: "gpt-5.4", stream: true },
      clientSimulator: client,
    });

    expect(result.status).toBe(200);
    const req = result.request!;
    expect(req.headers[PARENT_SESSION_HEADER]).toBe(parentId);
    expect(req.headers[PARENT_SESSION_ALT_HEADER]).toBe(parentId);
  });

  it("recovers missing session header automatically when request goes through patchFetch", async () => {
    const client = new ClientSimulator({ sessionId: "" });
    const result = await runner.execute("opencode", "/zen/v1/responses", {
      body: { input: [], model: "gpt-5.4", stream: true },
      clientSimulator: client,
      turnState: null,
    });

    expect(result.status).toBe(200);
    expect(result.request?.headers["x-opencode-session-id"]).toMatch(/^ses_/);
  });

  it("respects custom User-Agent and preserves existing User-Agent when disabled", async () => {
    // When injectUserAgent is false, existing User-Agent is preserved
    const preservedUa = await runner.execute("opencode", "/zen/v1/responses", {
      authHeaders: { "user-agent": "upstream-caller/1.0" },
      body: { input: [], model: "gpt-5.4", stream: true },
      config: { injectUserAgent: false },
    });
    expect(preservedUa.request?.headers["user-agent"]).toBe(
      "upstream-caller/1.0"
    );

    // Custom user-agent override
    const customUa = await runner.execute("opencode", "/zen/v1/responses", {
      body: { input: [], model: "gpt-5.4", stream: true },
      config: { userAgent: "CustomOpenCodeIDE/4.0.0" },
    });
    expect(customUa.request?.headers["user-agent"]).toBe(
      "CustomOpenCodeIDE/4.0.0"
    );
  });

  it("configures origin headers and project dynamically", async () => {
    const result = await runner.execute("opencode", "/zen/v1/responses", {
      body: { input: [], model: "gpt-5.4", stream: true },
      config: {
        injectOriginHeaders: true,
        injectProject: true,
        originClient: "web",
      },
      turnState: {
        model: "gpt-5.4",
        project: "my-project-repo",
        provider: "opencode",
        requestValue: "msg_0123456789abCDEFGHIJKLMNOP",
        value: MOCK_SESSION,
      },
    });

    expect(result.status).toBe(200);
    const req = result.request!;
    expect(req.headers["x-opencode-client"]).toBe("web");
    expect(req.headers["x-opencode-project"]).toBe("my-project-repo");
    // The turn's message id travels with the origin headers, as in 1.19.5's
    // `request.ts`, where `x-opencode-request` sits in the same branch as the
    // client and project headers.
    expect(req.headers["x-opencode-request"]).toBe(
      "msg_0123456789abCDEFGHIJKLMNOP"
    );
  });

  it("omits origin headers when injectOriginHeaders is false", async () => {
    const result = await runner.execute("opencode", "/zen/v1/responses", {
      body: { input: [], model: "gpt-5.4", stream: true },
      config: { injectOriginHeaders: false },
      turnState: {
        model: "gpt-5.4",
        provider: "opencode",
        requestValue: "msg_0123456789abCDEFGHIJKLMNOP",
        value: MOCK_SESSION,
      },
    });

    expect(result.status).toBe(200);
    const req = result.request!;
    expect(req.headers["x-opencode-client"]).toBeUndefined();
    expect(req.headers["x-opencode-project"]).toBeUndefined();
    // The message id belongs to the same switch, and the turn HAS one here —
    // the absence below is the switch, not a missing value.
    expect(req.headers["x-opencode-request"]).toBeUndefined();
  });

  it("omits x-opencode-request when the turn carries no message id", async () => {
    // Outside any tracked turn — the usage and discovery calls — there is no
    // message to name, and an absent header is correct. An empty
    // `x-opencode-request:` is a value the client cannot send.
    const result = await runner.execute("opencode", "/zen/v1/responses", {
      body: { input: [], model: "gpt-5.4", stream: true },
      turnState: {
        model: "gpt-5.4",
        provider: "opencode",
        value: MOCK_SESSION,
      },
    });

    expect(result.status).toBe(200);
    expect(result.request?.headers["x-opencode-request"]).toBeUndefined();
  });
});
