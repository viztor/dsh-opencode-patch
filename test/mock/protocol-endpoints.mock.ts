/**
 * Each endpoint family, through the plugin, over a socket.
 *
 * One request per protocol, streamed and unary, sent through `patchFetch` to
 * the mock gateway with the plugin's own configuration: what is asserted is
 * what the PLUGIN put on the wire — the protocol's own credential header and
 * nothing else, the session it derived — and that the gateway, which refuses
 * anything the vendor would refuse, answered it. The model of each case is the
 * catalog's own (`fixtureModel`), so no case names a vendor id a refresh can
 * retire.
 *
 * The gateway's own rules, asserted without the plugin, are not repeated
 * here: a raw `fetch` carrying the right headers would pass them as well, so
 * they test the mock rather than the plugin.
 *
 * @module test/mock/protocol-endpoints.mock
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

import {
  ANTHROPIC_VERSION,
  clearCapturedApiKeys,
  OPENCODE_ZEN_CATALOG,
  type PluginConfig,
  resolveConfig,
} from "../support/src.ts";
import { startMockGateway, type MockGateway } from "./gateway-server.ts";
import {
  fixtureModel,
  gatewayHarness,
  GO_KEY,
  kindForProtocol,
  lastRecorded,
  MOCK_SESSION,
  MOCK_TEXT,
  pathForProtocol,
  PROTOCOLS,
  queryForProtocol,
  sessionTurn,
  wireHeaderFor,
  wireValueFor,
  ZEN_KEY,
} from "./helpers.ts";

let gateway: MockGateway;

beforeAll(async () => {
  gateway = await startMockGateway();
});

afterAll(async () => {
  await gateway.close();
});

beforeEach(() => {
  gateway.requests.length = 0;
  clearCapturedApiKeys();
  vi.stubEnv("OPENCODE_API_KEY", ZEN_KEY);
  vi.stubEnv("OPENCODE_GO_API_KEY", GO_KEY);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const ZEN = "https://opencode.ai/zen/v1";

/** One turn's request through the plugin, inside a turn on `provider`. */
const send = (
  url: string,
  init: RequestInit,
  options: { config?: PluginConfig; model?: string; provider?: string } = {}
): Promise<Response> => {
  const harness = gatewayHarness(
    gateway.origin,
    resolveConfig(options.config ?? {})
  );
  return harness.als.run(
    sessionTurn({
      ...(options.model === undefined ? {} : { model: options.model }),
      provider: options.provider ?? "opencode",
    }),
    () => harness.fetch(url, init)
  );
};

const post = (body: unknown): RequestInit => ({
  body: JSON.stringify(body),
  headers: { "content-type": "application/json" },
  method: "POST",
});

const MESSAGES = [{ content: "hi", role: "user" }];

/** The body one protocol's SDK sends, streamed or not. */
const bodyFor = (protocol: string, model: string, stream: boolean): unknown => {
  switch (protocol) {
    case "anthropic-messages": {
      return { max_tokens: 64, messages: MESSAGES, model, stream };
    }
    case "google-generative-ai": {
      return { contents: [{ parts: [{ text: "hi" }], role: "user" }] };
    }
    case "openai-responses": {
      return { input: [], model, stream };
    }
    default: {
      return { messages: MESSAGES, model, stream };
    }
  }
};

describe("each protocol's endpoint, through the plugin", () => {
  it.for(PROTOCOLS)(
    "$protocol: streams and answers unary through the plugin with the protocol's own credential header",
    async ({ protocol }) => {
      // The mock serves the free tier on completions, where the core-tool
      // fallback makes a free body one it admits.
      const spec = fixtureModel(
        "opencode",
        protocol,
        protocol === "openai-completions" ? "free" : "paid"
      );
      const path = pathForProtocol(protocol, spec.id);

      const streamed = await send(
        `${ZEN}${path}${queryForProtocol(protocol)}`,
        post(bodyFor(protocol, spec.id, true)),
        { model: spec.id }
      );
      expect(streamed.status).toBe(200);
      expect(streamed.headers.get("content-type")).toContain(
        "text/event-stream"
      );
      const events = await streamed.text();
      expect(events.length).toBeGreaterThan(0);
      const recorded = lastRecorded(gateway);
      expect(recorded.kind).toBe(kindForProtocol(protocol));
      expect(recorded.protocol).toBe(protocol);
      expect(recorded.model).toBe(spec.id);
      expect(recorded.path).toBe(`/zen/v1${path}`);
      expect(recorded.headers[wireHeaderFor(protocol)]).toBe(
        wireValueFor(protocol, ZEN_KEY)
      );
      if (wireHeaderFor(protocol) !== "authorization") {
        // One credential, on the header the protocol reads: the official
        // client lets its SDK choose, and these SDKs send no Authorization.
        expect(recorded.headers.authorization).toBeUndefined();
      }
      if (protocol === "anthropic-messages") {
        // The case sends no version of its own: the one on the wire is the
        // plugin's fill, asserted here rather than read off the mock's 200.
        expect(recorded.headers["anthropic-version"]).toBe(ANTHROPIC_VERSION);
      }
      expect(recorded.headers["x-opencode-session-id"]).toBe(MOCK_SESSION);

      const unaryPath =
        protocol === "google-generative-ai"
          ? `/models/${spec.id}:generateContent`
          : path;
      const unary = await send(
        `${ZEN}${unaryPath}`,
        post(bodyFor(protocol, spec.id, false)),
        { model: spec.id }
      );
      expect(unary.status).toBe(200);
      expect(unary.headers.get("content-type")).toContain("application/json");
      expect(await unary.text()).toContain(MOCK_TEXT);
    }
  );

  it("a placeholder in OPENCODE_API_KEY is not a credential: nothing is sent and the gateway answers 401", async () => {
    vi.stubEnv("OPENCODE_API_KEY", "unused");
    vi.spyOn(console, "warn").mockImplementation(() => {
      // the missing-credential report is request-shapes' to assert
    });
    const spec = fixtureModel("opencode", "openai-responses", "paid");
    const response = await send(
      `${ZEN}/responses`,
      post(bodyFor("openai-responses", spec.id, true)),
      { model: spec.id }
    );
    expect(response.status).toBe(401);
    const payload = (await response.json()) as { error: { type: string } };
    expect(payload.error.type).toBe("invalid_api_key");
    const recorded = lastRecorded(gateway);
    expect(recorded.headers.authorization).toBeUndefined();
    expect(recorded.reject).toBe("credential");
  });

  it.each(["/zen/go/v1/usage", "/usage"])(
    "the Go plane's usage listing at %s carries the Go key",
    async (path) => {
      const response = await send(
        `https://opencode.ai${path}`,
        { method: "GET" },
        { provider: "opencode-go" }
      );
      expect(response.status).toBe(200);
      const recorded = lastRecorded(gateway);
      expect(recorded.kind).toBe("usage");
      expect(recorded.headers.authorization).toBe(`Bearer ${GO_KEY}`);
    }
  );
});

describe("the models listing, through the plugin", () => {
  interface Listing {
    data: { id: string; name?: string }[];
    object: string;
  }

  const listing = async (enrichModels: boolean): Promise<Listing> => {
    const response = await send(
      `${ZEN}/models`,
      { method: "GET" },
      { config: { enrichModels } }
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    const recorded = lastRecorded(gateway);
    expect(recorded.kind).toBe("models");
    expect(recorded.method).toBe("GET");
    expect(recorded.headers["x-opencode-session-id"]).toBe(MOCK_SESSION);
    return (await response.json()) as Listing;
  };

  it("enriches GET /zen/v1/models over the socket", async () => {
    const body = await listing(true);
    expect(body.object).toBe("list");
    // The catalog seeds the listing, each row described by its own entry.
    expect(body.data.length).toBeGreaterThanOrEqual(
      OPENCODE_ZEN_CATALOG.length
    );
    const [first] = OPENCODE_ZEN_CATALOG;
    expect(body.data.find((row) => row.id === first?.id)?.name).toBe(
      first?.name
    );
  });

  it("leaves the listing alone when enrichModels is false", async () => {
    const body = await listing(false);
    expect(body.object).toBe("list");
    // Exactly the two rows the gateway listed, undescribed.
    expect(body.data.map((row) => row.id)).toEqual([
      OPENCODE_ZEN_CATALOG[0]?.id,
      "mock-unknown-model",
    ]);
    expect(body.data.every((row) => row.name === undefined)).toBe(true);
  });
});

describe("the core-tool fallback, through the plugin", () => {
  it("a paid model gets no core tools", async () => {
    const spec = fixtureModel("opencode", "openai-responses", "paid");
    const response = await send(
      `${ZEN}/responses`,
      post(bodyFor("openai-responses", spec.id, true)),
      { config: { injectCoreTools: true }, model: spec.id }
    );
    expect(response.status).toBe(200);
    const body = lastRecorded(gateway).body as { tools?: unknown[] };
    expect(body.tools).toBeUndefined();
  });

  it("injectCoreTools: false injects nothing, and the gateway then refuses the free model with 403", async () => {
    // Turning the fallback off is honoured — nothing is injected — and the
    // consequence is visible rather than implied: a free-tier body with no
    // tools answers `403 FreeTierError` (measured against the live gateway, and
    // modelled by the mock). The configuration is the operator's choice; the
    // refusal is the gateway's.
    const spec = fixtureModel("opencode", "openai-completions", "free");
    const response = await send(
      `${ZEN}/chat/completions`,
      post(bodyFor("openai-completions", spec.id, true)),
      { config: { injectCoreTools: false }, model: spec.id }
    );
    expect(response.status).toBe(403);
    const body = lastRecorded(gateway).body as { tools?: unknown[] };
    expect(body.tools).toBeUndefined();
  });
});
