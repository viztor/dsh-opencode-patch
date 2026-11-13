/**
 * Shared fixtures and the fetch seam for the mock suite.
 *
 * Two things live here. The **spec tables** are what the tests assert against:
 * where each plane's requests should land per endpoint family, which path and
 * query each protocol's SDK appends, and which wire header carries the
 * credential. They are written from the vendor facts in
 * `docs/redirect-planes.md`, not read from the module under test — a test that
 * asks the implementation what it does can only ever agree with it.
 *
 * The **harness** is the full request path pointed at the mock: `patchFetch`
 * outermost, so it claims and shapes every request exactly as it does in
 * production, over an inner fetch that rewrites the gateway origin to the
 * mock's ephemeral address and delegates to the real transport. A URL that is
 * not a gateway URL is a test bug, so the inner fetch throws instead of
 * letting it escape to the public internet.
 *
 * @module dsh-opencode-patch/mock-helpers
 */

import { AsyncLocalStorage } from "node:async_hooks";

import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { googleGenerativeAIApi } from "@earendil-works/pi-ai/api/google-generative-ai.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";

import {
  type ActiveTurnState,
  type FetchPatchHooks,
  OPENCODE_GO_CATALOG,
  OPENCODE_PLANE_API,
  OPENCODE_ZEN_CATALOG,
  type ResolvedPluginConfig,
  patchFetch,
} from "../support/src.ts";
import type { GatewayKind } from "./opencode-gateway.ts";

export { MOCK_TEXT } from "./opencode-gateway.ts";

/** The Zen key every test stubs; the mock accepts it as a real credential. */
export const ZEN_KEY = "sk-mock-zen";

/** The Go key every test stubs. */
export const GO_KEY = "sk-mock-go";

/**
 * A session id the gateway ACCEPTS: `ses_` + 12 hex + 14 base62, with the low
 * twelve bits in the band `0xFC0..0xFFE`.
 *
 * The 12 hex digits are `~((ms << 12) + counter)` for a descending id, so a real
 * one always lands in that band; `0xFFE` is what `counter = 1` produces. A
 * syntactically valid id outside the band is refused with `403 FreeTierError` —
 * measured — which is exactly what this fixture used to be.
 */
export const MOCK_SESSION = "ses_eb1e9e706ffeCDEFGHIJKLMNOP";

/** The key a plane's requests should carry, per the stubs above. */
export const keyFor = (plane: TestPlane): string =>
  plane === "opencode" ? ZEN_KEY : GO_KEY;

export type TestPlane = "opencode" | "opencode-go";

export type TestFamily = "auto" | "legacy";

export type CatalogSpec = (typeof OPENCODE_ZEN_CATALOG)[number];

/**
 * Where each plane's requests should land, per endpoint family.
 *
 * The legacy roots are the measured constants. The catalog family is read from
 * the generated shim because following the vendor's own address is what `auto`
 * MEANS — a move there is a shim regeneration, not a bug this suite should
 * report.
 */
export const FAMILY_ROOTS: Readonly<
  Record<TestFamily, Record<TestPlane, string>>
> = {
  auto: {
    opencode: new URL(OPENCODE_PLANE_API.zen).pathname,
    "opencode-go": new URL(OPENCODE_PLANE_API.go).pathname,
  },
  legacy: {
    opencode: "/zen/v1",
    "opencode-go": "/zen/go/v1",
  },
};

/**
 * The root one (family, plane, protocol) lands on.
 *
 * **The inference family is not one root per plane.** Its anthropic and google
 * protocols live at their own paths, declared per model by the vendor's
 * `GET /console/api/config`; deriving them from the openai root is what sent
 * those models to the wrong endpoint. The legacy family genuinely is one root,
 * apart from Go's Google protocol, which only the inference family serves.
 *
 * @param family - the endpoint family under test.
 * @param plane - the gateway plane.
 * @param protocol - the wire protocol.
 * @returns the path root the request should carry.
 */
export const rootForProtocol = (
  family: TestFamily,
  plane: TestPlane,
  protocol: string
): string => {
  const go = plane === "opencode-go";
  if (family === "legacy") {
    // Go's Google protocol has no endpoint on the legacy family, so its one
    // base serves both families (`GO_GOOGLE_BASE_URL`).
    return go && protocol === "google-generative-ai"
      ? "/inference/go/google/v1beta"
      : FAMILY_ROOTS.legacy[plane];
  }
  if (protocol === "anthropic-messages") {
    return go ? "/inference/go/anthropic/v1" : "/inference/anthropic/v1";
  }
  if (protocol === "google-generative-ai") {
    return go ? "/inference/go/google/v1beta" : "/inference/google/v1beta";
  }
  return FAMILY_ROOTS.auto[plane];
};

/** The path suffix each protocol's SDK appends to its base. */
const PATH_FOR_PROTOCOL: Readonly<Record<string, string>> = {
  "anthropic-messages": "/messages",
  "google-generative-ai": "/models/{model}:streamGenerateContent",
  "openai-completions": "/chat/completions",
  "openai-responses": "/responses",
};

/** The query each protocol's SDK adds, if any. */
const QUERY_FOR_PROTOCOL: Readonly<Record<string, string>> = {
  "anthropic-messages": "?beta=true",
  "google-generative-ai": "?alt=sse",
  "openai-completions": "",
  "openai-responses": "",
};

/** The wire header each protocol's credential travels in. */
const WIRE_HEADER_FOR_PROTOCOL: Readonly<Record<string, string>> = {
  "anthropic-messages": "x-api-key",
  "google-generative-ai": "x-goog-api-key",
  "openai-completions": "authorization",
  "openai-responses": "authorization",
};

const KIND_FOR_PROTOCOL: Readonly<Record<string, GatewayKind>> = {
  "anthropic-messages": "messages",
  "google-generative-ai": "google",
  "openai-completions": "completions",
  "openai-responses": "responses",
};

const lookup = (
  table: Readonly<Record<string, string>>,
  key: string
): string => {
  const value = table[key];
  if (value === undefined) {
    throw new Error(`the mock suite has no entry for ${key}`);
  }
  return value;
};

/** The path one protocol's request to `model` should carry, after the root. */
export const pathForProtocol = (protocol: string, model: string): string =>
  lookup(PATH_FOR_PROTOCOL, protocol).replace("{model}", model);

/** The query one protocol's request should carry. */
export const queryForProtocol = (protocol: string): string =>
  lookup(QUERY_FOR_PROTOCOL, protocol);

/** The endpoint family one protocol's request should reach. */
export const kindForProtocol = (protocol: string): GatewayKind => {
  const kind = KIND_FOR_PROTOCOL[protocol];
  if (kind === undefined) {
    throw new Error(`the mock suite has no kind for ${protocol}`);
  }
  return kind;
};

/** The wire header one protocol's credential travels in. */
export const wireHeaderFor = (protocol: string): string =>
  lookup(WIRE_HEADER_FOR_PROTOCOL, protocol);

/** The wire value for a credential: `Bearer <key>` on authorization, else bare. */
export const wireValueFor = (protocol: string, key: string): string =>
  wireHeaderFor(protocol) === "authorization" ? `Bearer ${key}` : key;

/** The catalog one plane serves. */
export const catalogFor = (plane: TestPlane): readonly CatalogSpec[] =>
  plane === "opencode" ? OPENCODE_ZEN_CATALOG : OPENCODE_GO_CATALOG;

/** The first model of a plane that declares `sdk`; undefined = no SDK named. */
export const firstSpecFor = (
  plane: TestPlane,
  sdk: string | undefined
): CatalogSpec | undefined =>
  catalogFor(plane).find((spec) =>
    sdk === undefined
      ? spec.provider_npm === undefined
      : spec.provider_npm === sdk
  );

/** The turn state every request is made under, unless a case overrides it. */
export const sessionTurn = (
  overrides: Partial<ActiveTurnState> = {}
): ActiveTurnState => ({
  model: "gpt-5.4",
  provider: "opencode",
  value: MOCK_SESSION,
  ...overrides,
});

/** The origin the plugin builds its gateway URLs against. */
const GATEWAY_ORIGIN = "https://opencode.ai";

export interface GatewayHarness {
  als: AsyncLocalStorage<ActiveTurnState>;
  fetch: typeof fetch;
}

/**
 * The full request path, pointed at the mock.
 *
 * pi hands its requests over as `(url, init)` — measured — so a `Request`
 * object reaching the inner fetch means that changed, and the harness says so
 * rather than dropping the request's fields on the floor.
 */
export const gatewayHarness = (
  origin: string,
  config: ResolvedPluginConfig,
  hooks: FetchPatchHooks = {}
): GatewayHarness => {
  const als = new AsyncLocalStorage<ActiveTurnState>();
  const realFetch = globalThis.fetch;
  const redirecting = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (input instanceof Request) {
      throw new TypeError(
        "the mock harness expects (url, init); the fetch call shape changed"
      );
    }
    const url = typeof input === "string" ? input : input.href;
    if (!url.startsWith(GATEWAY_ORIGIN)) {
      throw new Error(`the mock suite reached a non-gateway URL: ${url}`);
    }
    return realFetch(url.replace(GATEWAY_ORIGIN, origin), init);
  }) as typeof fetch;
  return { als, fetch: patchFetch(redirecting, als, config, hooks) };
};

/** The subset of pi's event union the suite reads. */
export interface AssistantEventLike {
  delta?: string;
  type: string;
}

type ProviderStreams = ReturnType<typeof openAIResponsesApi>;

/**
 * pi types `stream()` against its own `Model<Api>` union and
 * `TranscriptContext`, while the plugin builds both objects from catalog data
 * and hands them to the host's mount the same way. One cast here, at the seam,
 * rather than one per case.
 */
interface LooseStreams {
  stream: (
    model: object,
    context: { messages: { content: string; role: string }[] },
    options: { apiKey: string }
  ) => AsyncIterable<AssistantEventLike>;
}

/** Open one protocol stream through pi's own implementation. */
export const openStream = (
  api: ProviderStreams,
  model: object,
  apiKey: string
): AsyncIterable<AssistantEventLike> =>
  (api as unknown as LooseStreams).stream(
    model,
    { messages: [{ content: "hello", role: "user" }] },
    { apiKey }
  );

/** Drain a stream, collecting the text and failing on an error event. */
export const collectText = async (
  stream: AsyncIterable<AssistantEventLike>
): Promise<string> => {
  let text = "";
  for await (const event of stream) {
    if (event.type === "text_delta") {
      text += event.delta ?? "";
    }
    if (event.type === "error") {
      throw new Error(`pi reported an error event: ${JSON.stringify(event)}`);
    }
  }
  return text;
};

/** The four protocol implementations the plugin serves through pi. */
export const PROTOCOLS: readonly {
  api: ProviderStreams;
  protocol: string;
  sdk: string | undefined;
}[] = [
  {
    api: anthropicMessagesApi(),
    protocol: "anthropic-messages",
    sdk: "@ai-sdk/anthropic",
  },
  {
    api: googleGenerativeAIApi(),
    protocol: "google-generative-ai",
    sdk: "@ai-sdk/google",
  },
  {
    api: openAICompletionsApi(),
    protocol: "openai-completions",
    sdk: undefined,
  },
  {
    api: openAIResponsesApi(),
    protocol: "openai-responses",
    sdk: "@ai-sdk/openai",
  },
];
