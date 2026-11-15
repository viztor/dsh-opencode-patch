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
 * The last block is the converse, and the one place this file fetches without
 * the plugin: every base and every dispatched request the PLUGIN can produce,
 * read off its own constants and endpoint-setting cells, must reach an
 * endpoint of the mock. Its subject is the plugin's reach, not a gateway rule:
 * a base the plugin can send to and the mock cannot serve answers `no_route`,
 * which a case that checks headers rather than the status would pass.
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
  cellKey,
  keylessMatrix,
  LEGACY_DISPATCH,
  TODAY_DISPATCH,
} from "../support/keyless-matrix.ts";
import {
  ANTHROPIC_VERSION,
  clearCapturedApiKeys,
  DEFAULT_USAGE_BASE_URL,
  LEGACY_PLANE_API,
  OPENCODE_FAMILY_API,
  OPENCODE_GO_CATALOG,
  OPENCODE_PLANE_API,
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
import type { GatewayRequest } from "./opencode-gateway.ts";

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

describe("the mock serves every request the plugin can produce", () => {
  it("serves every base URL the plugin can produce", async () => {
    // **The coverage invariant behind every other suite.** The request-shape
    // and plugin cases assert what a request LOOKS like; if the plugin starts
    // sending to a base this server does not serve, the answer is
    // `404 no_route` — and a case that checks the headers rather than the
    // status passes anyway. So a base the plugin knows and the mock does not is
    // a hole in the whole suite, and it is silent.
    //
    // The bases come from the plugin's own constants, so a vendor move that
    // adds a family fails here rather than in a case that happens not to look.
    const bases = new Set<string>([
      ...Object.values(OPENCODE_PLANE_API),
      ...Object.values(LEGACY_PLANE_API),
      ...Object.values(OPENCODE_FAMILY_API.go),
      ...Object.values(OPENCODE_FAMILY_API.zen),
      DEFAULT_USAGE_BASE_URL,
    ]);
    expect(bases.size).toBeGreaterThan(4);

    const unserved: string[] = [];
    for (const base of bases) {
      // **The mock's origin, the plugin's PATH.** The constants are absolute
      // URLs on `opencode.ai`; fetching them here would leave the machine and
      // pass this suite while proving nothing about the mock — which is what
      // the first version of this test did.
      const path = new URL(base).pathname;
      await fetch(`${gateway.origin}${path}/models`, {
        headers: {
          authorization: `Bearer ${ZEN_KEY}`,
          "x-opencode-session-id": MOCK_SESSION,
        },
      });
      const request = gateway.requests.at(-1) as
        | { reject?: string | null }
        | undefined;
      // `no_route` is the server saying it has no such path at all. Any other
      // answer — a listing, an unknown-endpoint refusal, an auth refusal — is
      // the server having a route and deciding about it.
      if (request?.reject === "no_route") {
        unserved.push(base);
      }
    }
    expect(
      unserved,
      "bases the plugin can send to and the mock cannot serve"
    ).toEqual([]);
  });

  it("serves the request of every cell either endpoint setting dispatches to, and no root cell", async () => {
    // The same invariant per REQUEST rather than per base: each cell the
    // plugin sends a turn to under `auto`/`modern` (`TODAY_DISPATCH`) or
    // `endpoint: legacy` (`LEGACY_DISPATCH`), with the protocol's own path
    // and the bundled catalog's model, must reach the endpoint of its OWN
    // protocol on its own plane. Reaching a route is not enough: a family
    // root the mock serves answers `unknown_endpoint` for a protocol path it
    // lacks, and a path could land on another protocol's endpoint — both are
    // the per-protocol hole this case exists to catch (the per-base case
    // above probes `<base>/models` and cannot see it). The record's protocol
    // is set before the credential check, so a cell the mock then refuses
    // for its key still names the endpoint it reached; a method refusal does
    // not count as served. The root shape is the converse: nothing
    // dispatches there, so a mock that served it could hide a turn sent to
    // the wrong family — it must answer `no_route`.
    const dispatched = new Set([...TODAY_DISPATCH, ...LEGACY_DISPATCH]);
    const cells = keylessMatrix({
      go: OPENCODE_GO_CATALOG,
      zen: OPENCODE_ZEN_CATALOG,
    });
    expect(cells.filter((cell) => dispatched.has(cellKey(cell)))).toHaveLength(
      dispatched.size
    );
    const unserved: string[] = [];
    const servedRoot: string[] = [];
    for (const cell of cells) {
      const name = cellKey(cell);
      if (!dispatched.has(name) && cell.family !== "root") {
        continue;
      }
      const url = new URL(cell.url);
      await fetch(`${gateway.origin}${url.pathname}${url.search}`, {
        body: JSON.stringify(cell.body),
        headers: { ...cell.headers, "x-opencode-session-id": MOCK_SESSION },
        method: cell.method,
      });
      const record = gateway.requests.at(-1) as GatewayRequest | undefined;
      if (cell.family === "root" && record?.reject !== "no_route") {
        servedRoot.push(name);
      }
      if (
        dispatched.has(name) &&
        (record?.protocol !== cell.protocol ||
          record.plane !== cell.plane ||
          record.reject === "method")
      ) {
        unserved.push(`${name} → ${record?.reject ?? record?.protocol}`);
      }
    }
    expect(
      unserved,
      "dispatched cells the mock does not serve on their own endpoint"
    ).toEqual([]);
    expect(servedRoot, "root cells the mock routes").toEqual([]);
  });
});
