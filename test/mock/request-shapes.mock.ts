/**
 * The request shape per configuration, over a socket.
 *
 * Each case states a configuration a user can actually write, sends one
 * request through `patchFetch` to the mock gateway, and asserts the *shape*
 * that request must carry: which session headers, which origin headers, which
 * credential on which wire header, and what the body must contain. The mock
 * refuses anything the vendor would refuse, so a 200 here means the request
 * also satisfies the endpoint's contract — the two halves are asserted
 * together on purpose.
 *
 * @module test/mock/request-shapes.mock
 */

import { AsyncLocalStorage } from "node:async_hooks";

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
  type ActiveTurnState,
  type FetchPatchHooks,
  OPENCODE_UA,
  PARENT_SESSION_ALT_HEADER,
  PARENT_SESSION_HEADER,
  type ResolvedPluginConfig,
  SESSION_AFFINITY_HEADER,
  SESSION_HEADER,
  clearCapturedApiKeys,
  isOpenCodeSessionId,
  newOpenCodeMessageId,
  openCodeSessionIdFor,
  patchFetch,
  resolveConfig,
} from "../support/src.ts";
import { startMockGateway, type MockGateway } from "./gateway-server.ts";
import {
  firstSpecFor,
  fixtureModel,
  gatewayHarness,
  GO_KEY,
  keyFor,
  lastRecorded,
  MOCK_SESSION,
  sessionTurn,
  ZEN_KEY,
} from "./helpers.ts";
import type { GatewayRequest, MockReply } from "./opencode-gateway.ts";

const PARENT_VALUE = openCodeSessionIdFor("mock-parent");

/** A paid Responses model and a free completions one, from the catalog. */
const PAID = fixtureModel("opencode", "openai-responses", "paid").id;
const FREE = fixtureModel("opencode", "openai-completions", "free").id;

const als = new AsyncLocalStorage<ActiveTurnState>();

let forced: MockReply | undefined;
let gateway: MockGateway;

beforeAll(async () => {
  gateway = await startMockGateway({ behavior: () => forced });
});

afterAll(async () => {
  await gateway.close();
});

beforeEach(() => {
  gateway.requests.length = 0;
  forced = undefined;
  clearCapturedApiKeys();
  vi.stubEnv("OPENCODE_API_KEY", ZEN_KEY);
  vi.stubEnv("OPENCODE_GO_API_KEY", GO_KEY);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const patchedWith = (
  config: ResolvedPluginConfig,
  hooks?: FetchPatchHooks
): typeof fetch => patchFetch(fetch, als, config, hooks);

const responsesBody = (model: string): Record<string, unknown> => ({
  input: [],
  model,
  stream: true,
});

const post = (
  patched: typeof fetch,
  url: string,
  body: unknown,
  extraHeaders: Record<string, string> = {}
): Promise<Response> =>
  patched(url, {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", ...extraHeaders },
    method: "POST",
  });

const recorded = (): GatewayRequest => lastRecorded(gateway);

const responsesUrl = (): string => `${gateway.origin}/zen/v1/responses`;

describe("the request shape per configuration", () => {
  it("sends the session, origin, project, UA and Zen key under the defaults", async () => {
    const requestValue = newOpenCodeMessageId();
    const response = await als.run(
      sessionTurn({ project: "mock-project", requestValue }),
      () =>
        post(patchedWith(resolveConfig()), responsesUrl(), responsesBody(PAID))
    );
    expect(response.status).toBe(200);
    const request = recorded();
    expect(request.path).toBe("/zen/v1/responses");
    expect(request.plane).toBe("opencode");
    expect(request.headers[SESSION_HEADER]).toBe(MOCK_SESSION);
    expect(request.headers["x-opencode-session-id"]).toBe(MOCK_SESSION);
    expect(request.headers["x-opencode-client"]).toBe("cli");
    expect(request.headers["x-opencode-project"]).toBe("mock-project");
    // The turn's message id, for the gateway's per-request metrics.
    expect(request.headers["x-opencode-request"]).toBe(requestValue);
    expect(request.headers["user-agent"]).toBe(OPENCODE_UA);
    expect(request.headers.authorization).toBe(`Bearer ${ZEN_KEY}`);
    expect(request.headers["x-opencode-org-id"]).toBeUndefined();
    expect(request.headers[SESSION_AFFINITY_HEADER]).toBeUndefined();
    expect(request.headers["x-session-id"]).toBeUndefined();
  });

  it("falls the project back to global when the turn carries none", async () => {
    // Nor a message id: an absent header is correct then, and an empty
    // `x-opencode-request:` is a value the client cannot send.
    await als.run(sessionTurn(), () =>
      post(patchedWith(resolveConfig()), responsesUrl(), responsesBody(PAID))
    );
    expect(recorded().headers["x-opencode-project"]).toBe("global");
    expect(recorded().headers["x-opencode-request"]).toBeUndefined();
  });

  it("outside a turn, the patch derives a session id the gateway admits", async () => {
    // The usage and discovery calls run outside any tracked turn, and the
    // gateway refuses a request with no session or one outside its band. With
    // no turn to claim it, the request is claimed by its gateway URL, so it goes
    // to the vendor's origin through the harness that points it at the mock.
    const harness = gatewayHarness(gateway.origin, resolveConfig());
    const response = await post(
      harness.fetch,
      "https://opencode.ai/zen/v1/responses",
      responsesBody(PAID)
    );
    expect(response.status).toBe(200);
    expect(
      isOpenCodeSessionId(recorded().headers["x-opencode-session-id"])
    ).toBe(true);
  });

  it("carries both parent-lineage headers when the turn has a parent", async () => {
    await als.run(sessionTurn({ parentValue: PARENT_VALUE }), () =>
      post(patchedWith(resolveConfig()), responsesUrl(), responsesBody(PAID))
    );
    const request = recorded();
    expect(request.headers[PARENT_SESSION_HEADER]).toBe(PARENT_VALUE);
    expect(request.headers[PARENT_SESSION_ALT_HEADER]).toBe(PARENT_VALUE);
  });

  it("adds the affinity pair for a relay provider and keeps the session", async () => {
    const config = resolveConfig({ gatewayUrls: [gateway.origin] });
    await als.run(sessionTurn({ provider: "mock-relay" }), () =>
      post(patchedWith(config), responsesUrl(), responsesBody(PAID))
    );
    const request = recorded();
    expect(request.headers[SESSION_HEADER]).toBe(MOCK_SESSION);
    expect(request.headers[SESSION_AFFINITY_HEADER]).toBe(MOCK_SESSION);
    expect(request.headers["x-session-id"]).toBe(MOCK_SESSION);
    expect(request.headers.authorization).toBe(`Bearer ${ZEN_KEY}`);
  });

  it("omits the origin headers when injectOriginHeaders is off", async () => {
    await als.run(sessionTurn({ requestValue: newOpenCodeMessageId() }), () =>
      post(
        patchedWith(resolveConfig({ injectOriginHeaders: false })),
        responsesUrl(),
        responsesBody(PAID)
      )
    );
    const request = recorded();
    expect(request.headers["x-opencode-client"]).toBeUndefined();
    expect(request.headers["x-opencode-project"]).toBeUndefined();
    // The message id belongs to the same switch, and the turn HAS one here:
    // the absence is the switch, not a missing value.
    expect(request.headers["x-opencode-request"]).toBeUndefined();
    expect(request.headers[SESSION_HEADER]).toBe(MOCK_SESSION);
    expect(request.headers["user-agent"]).toBe(OPENCODE_UA);
  });

  it("keeps the client header and drops the project when injectProject is off", async () => {
    await als.run(sessionTurn(), () =>
      post(
        patchedWith(resolveConfig({ injectProject: false })),
        responsesUrl(),
        responsesBody(PAID)
      )
    );
    const request = recorded();
    expect(request.headers["x-opencode-client"]).toBe("cli");
    expect(request.headers["x-opencode-project"]).toBeUndefined();
  });

  it("sends a configured originClient verbatim", async () => {
    await als.run(sessionTurn(), () =>
      post(
        patchedWith(resolveConfig({ originClient: "dsh-mock/1.0" })),
        responsesUrl(),
        responsesBody(PAID)
      )
    );
    expect(recorded().headers["x-opencode-client"]).toBe("dsh-mock/1.0");
  });

  it("sends a configured userAgent verbatim", async () => {
    await als.run(sessionTurn(), () =>
      post(
        patchedWith(resolveConfig({ userAgent: "mock-agent/9.9" })),
        responsesUrl(),
        responsesBody(PAID)
      )
    );
    expect(recorded().headers["user-agent"]).toBe("mock-agent/9.9");
  });

  it("leaves the UA alone when injectUserAgent is off", async () => {
    await als.run(sessionTurn(), () =>
      post(
        patchedWith(resolveConfig({ injectUserAgent: false })),
        responsesUrl(),
        responsesBody(PAID)
      )
    );
    expect(recorded().headers["user-agent"]).not.toBe(OPENCODE_UA);
  });

  it("carries a configured credentialOrg on the org header", async () => {
    await als.run(sessionTurn(), () =>
      post(
        patchedWith(resolveConfig({ credentialOrg: "wrk_mock" })),
        responsesUrl(),
        responsesBody(PAID)
      )
    );
    expect(recorded().headers["x-opencode-org-id"]).toBe("wrk_mock");
  });

  it("adds the core-tool schemas for a free-tier completions model", async () => {
    // The vendor's per-model protocol table no longer lists any free model on
    // /responses (the last one was deprecated upstream), so the free fixture
    // goes to /chat/completions — the endpoint the free tier is actually
    // served on, and one the injector covers too.
    const response = await als.run(sessionTurn(), () =>
      post(
        patchedWith(resolveConfig()),
        `${gateway.origin}/zen/v1/chat/completions`,
        {
          messages: [{ content: "hi", role: "user" }],
          model: FREE,
        }
      )
    );
    expect(response.status).toBe(200);
    const body = recorded().body as {
      tools?: { name?: string; function?: { name?: string } }[];
    };
    const names = (body.tools ?? []).map(
      (tool) => tool.function?.name ?? tool.name
    );
    expect(names).toContain("read");
    expect(names).toContain("bash");
  });

  it("sends no credential and warns when none resolves", async () => {
    vi.stubEnv("OPENCODE_API_KEY", "");
    const warnings: unknown[][] = [];
    vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
      warnings.push(args);
    });
    const response = await als.run(sessionTurn(), () =>
      post(patchedWith(resolveConfig()), responsesUrl(), responsesBody(PAID))
    );
    expect(response.status).toBe(401);
    expect(recorded().headers.authorization).toBeUndefined();
    expect(warnings.length).toBeGreaterThan(0);
    // The report names the plane, so a reader can tell which credential is
    // missing rather than only that something is.
    expect(String(warnings[0]?.[0])).toContain(
      "no credential resolved for opencode"
    );

    // The Go plane the same way: no Go key, nothing sent, and the gateway's 401.
    vi.stubEnv("OPENCODE_GO_API_KEY", "");
    const goModel = fixtureModel("opencode-go", "openai-responses", "paid").id;
    const go = await als.run(
      sessionTurn({ model: goModel, provider: "opencode-go" }),
      () =>
        post(
          patchedWith(resolveConfig()),
          `${gateway.origin}/inference/go/openai/v1/responses`,
          responsesBody(goModel)
        )
    );
    expect(go.status).toBe(401);
    expect(recorded().plane).toBe("opencode-go");
    expect(recorded().headers.authorization).toBeUndefined();
    expect(recorded().reject).toBe("credential");
  });

  /**
   * **A refusal passes through untouched, with the gateway's own status and
   * words.** The status belongs to the gateway. `Model access is disabled` is
   * an entitlement answer, and rewriting it to 400 — to steer DSH's classifier
   * away from its AUTH label — changed a status this plugin does not own. The
   * classifier's label is its reading; the message underneath is accurate.
   */
  it.each([
    [
      403,
      "server_error",
      "Upstream request failed: Model access is disabled",
      "/zen/v1/responses",
    ],
    [401, "invalid_api_key", "Invalid API key", "/zen/v1/responses"],
    [
      429,
      "rate_limit_exceeded",
      "Rate limit exceeded. Please wait 10s.",
      "/zen/v1/responses",
    ],
    [502, "bad_gateway", "Bad Gateway", "/zen/v1/responses"],
    [
      403,
      "entitlement_error",
      "EntitlementError: subscription required",
      "/zen/go/v1/usage",
    ],
  ] as const)(
    "passes a %i %s through with the gateway's status and message",
    async (status, type, message, path) => {
      forced = { body: JSON.stringify({ error: { message, type } }), status };
      const isUsage = path.endsWith("/usage");
      const response = await als.run(
        sessionTurn(isUsage ? { provider: "opencode-go" } : {}),
        () =>
          isUsage
            ? patchedWith(resolveConfig())(`${gateway.origin}${path}`)
            : post(
                patchedWith(resolveConfig()),
                `${gateway.origin}${path}`,
                responsesBody(PAID)
              )
      );
      expect(response.status).toBe(status);
      const payload = (await response.json()) as {
        error: { message: string; type: string };
      };
      expect(payload.error.type).toBe(type);
      expect(payload.error.message).toBe(message);
    }
  );

  it("uses the Go key for the Go plane", async () => {
    const spec = firstSpecFor("opencode-go", "@ai-sdk/openai");
    if (spec === undefined) {
      throw new Error("the go catalog serves no responses model");
    }
    const response = await als.run(
      sessionTurn({ model: spec.id, provider: "opencode-go" }),
      () =>
        post(
          patchedWith(resolveConfig()),
          `${gateway.origin}/inference/go/openai/v1/responses`,
          responsesBody(spec.id)
        )
    );
    expect(response.status).toBe(200);
    const request = recorded();
    expect(request.plane).toBe("opencode-go");
    expect(request.headers.authorization).toBe(
      `Bearer ${keyFor("opencode-go")}`
    );
  });
});

describe("keyless: free models still answer", () => {
  it("serves a free model when no credential exists anywhere", async () => {
    // The deployment the plugin has to survive: an `apiKeyEnv` that is declared
    // but empty (or absent), which is what "the user has not filled it in" looks
    // like from here. The gateway admits a free model anonymously — measured —
    // so the request must go out with no credential and still succeed.
    vi.stubEnv("OPENCODE_API_KEY", "");
    vi.stubEnv("OPENCODE_GO_API_KEY", "");
    clearCapturedApiKeys();

    const response = await als.run(sessionTurn(), () =>
      post(
        patchedWith(resolveConfig()),
        `${gateway.origin}/zen/v1/chat/completions`,
        {
          messages: [{ content: "hi", role: "user" }],
          model: FREE,
          stream: true,
          tools: [
            {
              function: { name: "read", parameters: { type: "object" } },
              type: "function",
            },
          ],
        }
      )
    );

    expect(response.status).toBe(200);
    const request = recorded();
    // No credential on the wire at all: not a placeholder, not `public`.
    expect(request.headers.authorization).toBeUndefined();
    expect(request.headers["x-api-key"]).toBeUndefined();
  });
});
