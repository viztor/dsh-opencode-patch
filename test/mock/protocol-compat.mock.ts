/**
 * Plane × protocol × family, driven through pi's own implementations.
 *
 * This is the compatibility matrix the plugin exists for: every served plane
 * (Zen, Go) crossed with every protocol it speaks (Responses, Completions,
 * Messages, Google) crossed with both endpoint families (`auto`, the
 * catalog's address; `legacy`, the older one still entitled separately). The
 * request is built exactly as production builds it — `planeModelFor` for the
 * model, pi's own per-protocol API factory for the stream — and travels the
 * full path: `patchFetch` claims it, shapes it, and the mock gateway either
 * accepts it and streams back, or refuses with the reason.
 *
 * The assertions are on the recorded request: the family root the SDK landed
 * on, the path and query its protocol appends, the model, the wire header its
 * protocol authenticates with, and the session/origin headers every gateway
 * request carries. The text assertion is the other half — the mock's stream
 * has to come back through pi's parser as the text it sent, or the shape was
 * only superficially right.
 *
 * @module test/mock/protocol-compat.mock
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
  OPENCODE_UA,
  SESSION_HEADER,
  clearCapturedApiKeys,
  OPENCODE_FAMILY_API,
  planeModelFor,
  resolveConfig,
} from "../support/src.ts";
import { startMockGateway, type MockGateway } from "./gateway-server.ts";
import {
  collectText,
  rootForProtocol,
  firstSpecFor,
  gatewayHarness,
  keyFor,
  kindForProtocol,
  MOCK_SESSION,
  MOCK_TEXT,
  openStream,
  pathForProtocol,
  PROTOCOLS,
  queryForProtocol,
  sessionTurn,
  wireHeaderFor,
  wireValueFor,
  type TestFamily,
  type TestPlane,
} from "./helpers.ts";
import type { GatewayRequest } from "./opencode-gateway.ts";

const PLANES: readonly TestPlane[] = ["opencode", "opencode-go"];

const FAMILIES: readonly TestFamily[] = ["auto", "legacy"];

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
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const recorded = (): GatewayRequest => {
  const last = gateway.requests.at(-1);
  if (last === undefined) {
    throw new Error("the mock gateway saw no request");
  }
  return last;
};

/**
 * The full matrix, one row per case, so the loop that builds it never creates
 * a function of its own — `it.each` does.
 */
const CASES = PLANES.flatMap((plane) =>
  PROTOCOLS.flatMap(({ api, protocol, sdk }) =>
    FAMILIES.map((family) => ({ api, family, plane, protocol, sdk }))
  )
);

describe("plane × protocol × family", () => {
  it.each(CASES)(
    "$plane · $protocol · $family",
    async ({ api, family, plane, protocol, sdk }) => {
      const spec = firstSpecFor(plane, sdk);
      if (spec === undefined) {
        throw new Error(`${plane} serves no ${protocol} model`);
      }
      const harness = gatewayHarness(gateway.origin, resolveConfig());
      vi.stubGlobal("fetch", harness.fetch);
      const text = await harness.als.run(
        sessionTurn({ model: spec.id, provider: plane }),
        async () => {
          const { model, error } = planeModelFor({
            defaults: {
              contextWindow: 262_144,
              input: ["text"],
              maxTokens: 32_768,
            },
            endpoint: family,
            entry: { id: spec.id },
            familyApi:
              plane === "opencode"
                ? OPENCODE_FAMILY_API.zen
                : OPENCODE_FAMILY_API.go,
            route: plane,
            spec,
          });
          if (model === undefined) {
            throw new Error(`${plane}/${spec.id}: ${error}`);
          }
          expect(model.api).toBe(protocol);
          return collectText(openStream(api, model, keyFor(plane)));
        }
      );
      expect(text).toBe(MOCK_TEXT);

      const request = recorded();
      expect(request.status).toBe(200);
      expect(request.plane).toBe(plane);
      expect(request.kind).toBe(kindForProtocol(protocol));
      expect(request.model).toBe(spec.id);
      expect(request.path).toBe(
        `${rootForProtocol(family, plane, protocol)}${pathForProtocol(protocol, spec.id)}`
      );
      expect(request.query).toBe(queryForProtocol(protocol));
      expect(request.headers[wireHeaderFor(protocol)]).toBe(
        wireValueFor(protocol, keyFor(plane))
      );
      expect(request.headers[SESSION_HEADER]).toBe(MOCK_SESSION);
      expect(request.headers["x-opencode-session-id"]).toBe(MOCK_SESSION);
      expect(request.headers["x-opencode-client"]).toBe("cli");
      expect(request.headers["x-opencode-project"]).toBe("global");
      expect(request.headers["user-agent"]).toBe(OPENCODE_UA);
      expect(request.headers["x-opencode-org-id"]).toBeUndefined();
    }
  );
});
