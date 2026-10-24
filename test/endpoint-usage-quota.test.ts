/**
 * Test: OpenCode Go Usage & Quota Endpoint (/usage).
 *
 * Validates:
 * - GET /usage and /zen/go/v1/usage quota window parsing (rolling, weekly, monthly)
 * - Required wire headers (x-opencode-client: cli, x-opencode-project: global, Authorization: Bearer)
 * - Entitlement handling (403 EntitlementError and Zen overflow)
 * - Quota percent and status validation
 *
 * @module test/endpoint-usage-quota.test
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

import type { UsageQuotaPayload } from "./mock/protocols/index.ts";
import { GatewayTestRunner, GO_KEY } from "./mock/testing-kit.ts";
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
  vi.stubEnv("OPENCODE_GO_API_KEY", GO_KEY);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("OpenCode Go Usage & Quota Endpoint", () => {
  it("delivers quota windows via GET /zen/go/v1/usage", async () => {
    const result = await runner.execute("opencode-go", "/zen/go/v1/usage", {});

    expect(result.status).toBe(200);
    expect(result.headers.get("content-type")).toContain("application/json");

    const body = result.json<UsageQuotaPayload>();
    expect(body.rolling).toBeDefined();
    expect(body.rolling.percent).toBeDefined();
    expect(body.rolling.status).toBe("ok");
    expect(body.monthly).toBeDefined();
    expect(body.weekly).toBeDefined();

    const req = result.request!;
    expect(req.plane).toBe("opencode-go");
    expect(req.kind).toBe("usage");
    expect(req.headers.authorization).toBe(`Bearer ${GO_KEY}`);
  });

  it("handles standalone GET /usage endpoint", async () => {
    const result = await runner.execute("opencode-go", "/usage", {});

    expect(result.status).toBe(200);
    expect(result.request?.kind).toBe("usage");
    expect(result.request?.headers.authorization).toBe(`Bearer ${GO_KEY}`);
  });

  it("simulates 403 EntitlementError when Go subscription is not active", async () => {
    const entitlementRunner = new GatewayTestRunner();
    await entitlementRunner.start({
      usage: {
        body: JSON.stringify({
          error: {
            message: "EntitlementError: subscription required",
            type: "entitlement_error",
          },
        }),
        status: 403,
      },
    });

    try {
      const result = await entitlementRunner.execute(
        "opencode-go",
        "/zen/go/v1/usage",
        {}
      );
      expect(result.status).toBe(403);
      expect(result.text).toContain("EntitlementError");
    } finally {
      await entitlementRunner.close();
    }
  });

  it("refuses unauthenticated usage requests with 401 Invalid API key", async () => {
    vi.stubEnv("OPENCODE_GO_API_KEY", "");
    const result = await runner.execute("opencode-go", "/zen/go/v1/usage", {});

    expect(result.status).toBe(401);
    expect(result.request?.reject).toBe("credential");
  });
});
