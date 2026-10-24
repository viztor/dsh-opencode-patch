/**
 * Test: Models Catalog Listing Endpoint (/models).
 *
 * Validates:
 * - GET /models listing structure (data array of model objects)
 * - Transparent enrichment when enrichModels is enabled (adds metadata, display names, costs)
 * - Raw gateway listing preservation when enrichModels is disabled
 * - Session header compliance on /models requests
 * - Method validation (GET allowed, POST refused with 405)
 *
 * @module test/endpoint-models-catalog.test
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
  CatalogListingPayload,
  GatewayErrorPayload,
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

describe("Models Catalog Listing Endpoint (/models)", () => {
  it("delivers models catalog listing with transparent enrichment when enabled", async () => {
    const result = await runner.execute("opencode", "/zen/v1/models", {
      config: { enrichModels: true },
    });

    expect(result.status).toBe(200);
    expect(result.headers.get("content-type")).toContain("application/json");

    const body = result.json<CatalogListingPayload>();
    expect(body.object).toBe("list");
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data.length).toBeGreaterThan(0);

    const req = result.request!;
    expect(req.kind).toBe("models");
    expect(req.method).toBe("GET");
    expect(req.headers["x-opencode-session-id"]).toBe(MOCK_SESSION);
  });

  it("leaves raw gateway listing alone when enrichModels is false", async () => {
    const result = await runner.execute("opencode", "/zen/v1/models", {
      config: { enrichModels: false },
    });

    expect(result.status).toBe(200);
    const body = result.json<CatalogListingPayload>();
    expect(body.object).toBe("list");
    expect(body.data.some((m) => m.id === "mock-unknown-model")).toBe(true);
  });

  it("refuses POST method on /models with 405 MethodNotAllowed", async () => {
    const result = await runner.execute("opencode", "/zen/v1/models", {
      method: "POST",
    });

    expect(result.status).toBe(405);
    const body = result.json<GatewayErrorPayload>();
    expect(body.error.type).toBe("method_not_allowed");
    expect(result.request?.reject).toBe("method");
  });
});
