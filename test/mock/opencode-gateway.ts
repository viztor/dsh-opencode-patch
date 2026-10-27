/**
 * The OpenCode gateway, mocked — the vendor's endpoints as a Vite plugin.
 *
 * Divided cleanly by wire protocols (responses, completions, messages, google,
 * catalog, usage-quota) under `test/mock/protocols/`.
 *
 * @module dsh-opencode-patch/mock-gateway
 */

import type { IncomingHttpHeaders, IncomingMessage } from "node:http";

import type { Plugin } from "vite-plus";

import {
  OPENCODE_GO_CATALOG,
  OPENCODE_PLANE_API,
  OPENCODE_ZEN_CATALOG,
  isRecord,
} from "../support/src.ts";
import {
  anthropicStream,
  anthropicUnary,
  completionsStream,
  completionsUnary,
  extractGoogleModel,
  googleStream,
  googleUnary,
  MOCK_TEXT,
  modelsListing,
  responsesStream,
  responsesUnary,
  usageResponse,
  type MockUsageOptions,
  type WireReply as ShapeReply,
} from "./protocols/index.ts";

export { MOCK_TEXT };
export type { MockUsageOptions };

/** The plane a request's base URL belongs to. */
export type GatewayPlane = "opencode" | "opencode-go";

/** The endpoint family a path names, by the last segment it carries. */
export type GatewayKind =
  | "completions"
  | "google"
  | "messages"
  | "models"
  | "responses"
  | "usage";

/** One request the gateway saw, in the shape the tests assert on. */
export interface GatewayRequest {
  body: unknown;
  bodyText: string;
  headers: Record<string, string>;
  kind: GatewayKind | null;
  method: string;
  model: string | null;
  path: string;
  plane: GatewayPlane | null;
  protocol: string | null;
  query: string;
  reject: string | null;
  status: number;
}

export type MockReply = ShapeReply;

export type GatewayBehavior = (
  request: GatewayRequest
) => MockReply | undefined;

export interface OpenCodeGatewayOptions {
  behavior?: GatewayBehavior;
  onRequest?: (request: GatewayRequest) => void;
  usage?: MockUsageOptions;
}

export interface GatewayExchange {
  bodyText: string;
  headers: IncomingHttpHeaders;
  method: string;
  url: string;
}

export interface GatewayDecision {
  record: GatewayRequest;
  reply: MockReply;
}

const JSON_CONTENT_TYPE = "application/json";
const SSE_CONTENT_TYPE = "text/event-stream";

const FAMILY_ROOTS: readonly { plane: GatewayPlane; root: string }[] = [
  { plane: "opencode-go", root: "/zen/go/v1" },
  { plane: "opencode", root: "/zen/v1" },
  { plane: "opencode-go", root: new URL(OPENCODE_PLANE_API.go).pathname },
  { plane: "opencode", root: new URL(OPENCODE_PLANE_API.zen).pathname },
  // **The inference family is not one root per plane.** Its anthropic and google
  // protocols live at their own paths, which the vendor's `GET /console/api/config`
  // declares per model. Measured there; hard-coded here because this file MOCKS
  // the gateway and a mock that derives its routes from the code under test
  // cannot catch a wrong route.
  { plane: "opencode-go", root: "/inference/go/anthropic/v1" },
  { plane: "opencode-go", root: "/inference/go/google/v1beta" },
  { plane: "opencode", root: "/inference/anthropic/v1" },
  { plane: "opencode", root: "/inference/google/v1beta" },
];

const ENDPOINTS: readonly {
  kind: GatewayKind;
  pattern: RegExp;
  protocol: string | null;
}[] = [
  {
    kind: "responses",
    pattern: /^\/responses$/u,
    protocol: "openai-responses",
  },
  {
    kind: "completions",
    pattern: /^\/chat\/completions$/u,
    protocol: "openai-completions",
  },
  {
    kind: "messages",
    pattern: /^\/messages$/u,
    protocol: "anthropic-messages",
  },
  {
    kind: "google",
    pattern: /^\/models\/([^/]+):(?:streamGenerateContent|generateContent)$/u,
    protocol: "google-generative-ai",
  },
  { kind: "models", pattern: /^\/models$/u, protocol: null },
  { kind: "usage", pattern: /^\/usage$/u, protocol: "usage" },
];

const WIRE_HEADER: Readonly<Record<GatewayKind, string>> = {
  completions: "authorization",
  google: "x-goog-api-key",
  messages: "x-api-key",
  models: "authorization",
  responses: "authorization",
  usage: "authorization",
};

const CONSOLE_ROUTES: readonly {
  kind: GatewayKind;
  method: string;
  pattern: RegExp;
  plane: GatewayPlane;
  protocol: string | null;
}[] = [
  {
    kind: "usage",
    method: "GET",
    pattern: /^\/usage$/u,
    plane: "opencode-go",
    protocol: "usage",
  },
];

const PLACEHOLDER_KEYS: ReadonlySet<string> = new Set([
  "none",
  "null",
  "undefined",
  "unused",
]);

const SDK_PROTOCOL: Readonly<Record<string, string>> = {
  "@ai-sdk/anthropic": "anthropic-messages",
  "@ai-sdk/google": "google-generative-ai",
  "@ai-sdk/openai": "openai-responses",
  "@ai-sdk/openai-compatible": "openai-completions",
};

type CatalogSpec = (typeof OPENCODE_ZEN_CATALOG)[number];

const catalogFor = (plane: GatewayPlane): readonly CatalogSpec[] =>
  plane === "opencode" ? OPENCODE_ZEN_CATALOG : OPENCODE_GO_CATALOG;

const protocolForModel = (
  plane: GatewayPlane,
  id: string
): string | undefined => {
  const spec = catalogFor(plane).find((entry) => entry.id === id);
  if (spec === undefined) {
    return undefined;
  }
  if (spec.provider_npm === undefined) {
    return "openai-completions";
  }
  return SDK_PROTOCOL[spec.provider_npm] ?? "unsupported";
};

type LlmGatewayKind = "completions" | "google" | "messages" | "responses";

const STREAM_FOR_KIND: Readonly<
  Record<LlmGatewayKind, (model: string) => string>
> = {
  completions: completionsStream,
  google: googleStream,
  messages: anthropicStream,
  responses: responsesStream,
};

const UNARY_FOR_KIND: Readonly<
  Record<LlmGatewayKind, (model: string) => string>
> = {
  completions: completionsUnary,
  google: googleUnary,
  messages: anthropicUnary,
  responses: responsesUnary,
};

const isStreamingRequest = (
  kind: LlmGatewayKind,
  path: string,
  body: unknown
): boolean => {
  if (kind === "google") {
    return path.includes(":streamGenerateContent");
  }
  if (isRecord(body) && typeof body.stream === "boolean") {
    return body.stream;
  }
  return true;
};

const fixtureReply = (
  kind: LlmGatewayKind,
  model: string,
  streaming: boolean
): MockReply => ({
  body: streaming ? STREAM_FOR_KIND[kind](model) : UNARY_FOR_KIND[kind](model),
  contentType: streaming ? SSE_CONTENT_TYPE : JSON_CONTENT_TYPE,
  status: 200,
});

const errorReply = (
  status: number,
  message: string,
  type: string
): MockReply => ({
  body: JSON.stringify({ error: { message, type } }),
  contentType: JSON_CONTENT_TYPE,
  status,
});

const flattenHeaders = (
  headers: IncomingHttpHeaders
): Record<string, string> => {
  const flat: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) {
      continue;
    }
    flat[name.toLowerCase()] = Array.isArray(value) ? value.join(", ") : value;
  }
  return flat;
};

const parseBody = (bodyText: string): { ok: boolean; parsed: unknown } => {
  if (bodyText.length === 0) {
    return { ok: false, parsed: undefined };
  }
  try {
    return { ok: true, parsed: JSON.parse(bodyText) };
  } catch {
    return { ok: false, parsed: undefined };
  }
};

const modelFromBody = (body: unknown): string | null => {
  if (!isRecord(body)) {
    return null;
  }
  const { model } = body;
  return typeof model === "string" && model.length > 0 ? model : null;
};

const isCredential = (value: string | undefined): boolean => {
  if (value === undefined) {
    return false;
  }
  const bare = value
    .replace(/^Bearer\s+/iu, "")
    .trim()
    .toLowerCase();
  return bare.length > 0 && !PLACEHOLDER_KEYS.has(bare);
};

interface RouteMatch {
  endpoint:
    | {
        kind: GatewayKind;
        pattern?: RegExp;
        protocol: string | null;
      }
    | undefined;
  match: RegExpExecArray | null;
  plane: GatewayPlane;
}

const matchRoute = (path: string): RouteMatch | undefined => {
  for (const family of FAMILY_ROOTS) {
    if (!path.startsWith(`${family.root}/`)) {
      continue;
    }
    const remainder = path.slice(family.root.length);
    for (const endpoint of ENDPOINTS) {
      const match = endpoint.pattern.exec(remainder);
      if (match !== null) {
        return { endpoint, match, plane: family.plane };
      }
    }
    return { endpoint: undefined, match: null, plane: family.plane };
  }

  for (const route of CONSOLE_ROUTES) {
    const match = route.pattern.exec(path);
    if (match !== null) {
      return {
        endpoint: { kind: route.kind, protocol: route.protocol },
        match,
        plane: route.plane,
      };
    }
  }

  return undefined;
};

/**
 * What the live gateway actually enforces, measured against it and replayed
 * through a non-Bun client so the transport was not the variable:
 *
 * - a session id whose low twelve bits fall OUTSIDE `0xFC0..0xFFE` is refused with
 *   `403 FreeTierError`; ascending `0xFFE`/`0xFC0` pass, ascending `0x001` fails,
 *   descending ids land in the band because `0xFFF - counter` is how the vendor's
 *   own construction works;
 * - a free-tier model called with NO `tools` in the body is refused the same way
 *   (`src/tool-fallback.ts` exists for exactly that reason).
 *
 * Both are enforced here so the suite FAILS if the plugin regresses to an id the
 * gateway would refuse or drops the tool fallback — neither is visible otherwise.
 */
const SESSION_BAND_MIN = 0xfc0;
const SESSION_BAND_MAX = 0xffe;

const FREE_TIER_MESSAGE =
  "OpenCode's free tier can only be used from within OpenCode. Download it at https://opencode.ai and keep building.";

/** The low twelve bits of a session id, or `undefined` when it is not one. */
const sessionLow12 = (id: string): number | undefined => {
  const hex = id.slice(4, 16);
  if (!/^[0-9a-f]{12}$/u.test(hex)) {
    return undefined;
  }
  return Number.parseInt(hex, 16) % 0x1000;
};

export const handleGatewayRequest = (
  exchange: GatewayExchange,
  options: OpenCodeGatewayOptions = {}
): GatewayDecision => {
  const url = new URL(exchange.url, "http://mock.invalid");
  const headers = flattenHeaders(exchange.headers);
  const record: GatewayRequest = {
    body: undefined,
    bodyText: exchange.bodyText,
    headers,
    kind: null,
    method: exchange.method.toUpperCase(),
    model: null,
    path: url.pathname,
    plane: null,
    protocol: null,
    query: url.search,
    reject: null,
    status: 0,
  };

  const refuse = (
    status: number,
    message: string,
    type: string,
    reject: string
  ): GatewayDecision => {
    record.reject = reject;
    record.status = status;
    options.onRequest?.(record);
    return { record, reply: errorReply(status, message, type) };
  };

  const accept = (reply: MockReply): GatewayDecision => {
    record.status = reply.status;
    options.onRequest?.(record);
    return { record, reply };
  };

  const matched = matchRoute(url.pathname);
  if (matched === undefined) {
    return refuse(404, `no route for ${url.pathname}`, "not_found", "no_route");
  }
  const { endpoint, plane } = matched;
  record.plane = plane;
  if (endpoint === undefined) {
    return refuse(
      404,
      `unknown endpoint ${url.pathname} on ${plane}`,
      "not_found",
      "unknown_endpoint"
    );
  }
  record.kind = endpoint.kind;
  record.protocol = endpoint.protocol;

  const expectedMethod =
    endpoint.kind === "models" || endpoint.kind === "usage" ? "GET" : "POST";
  if (record.method !== expectedMethod) {
    return refuse(
      405,
      `${endpoint.kind} answers ${expectedMethod}`,
      "method_not_allowed",
      "method"
    );
  }

  const wireHeader = WIRE_HEADER[endpoint.kind];
  // Endpoints that carry no model are judged on the credential alone. A model
  // endpoint is judged per model, after the model is known: a free one is admitted
  // with no credential at all.
  const perModelCredential =
    endpoint.kind === "completions" ||
    endpoint.kind === "responses" ||
    endpoint.kind === "messages" ||
    endpoint.kind === "google";
  if (!perModelCredential && !isCredential(headers[wireHeader])) {
    return refuse(401, "Invalid API key", "invalid_api_key", "credential");
  }

  const requiresSession =
    endpoint.kind === "completions" ||
    endpoint.kind === "google" ||
    endpoint.kind === "messages" ||
    endpoint.kind === "models" ||
    endpoint.kind === "responses";
  if (requiresSession) {
    const session = headers["x-opencode-session-id"];
    if (session === undefined || session.length === 0) {
      return refuse(400, "MissingSessionID", "missing_session_id", "session");
    }
    const low12 = sessionLow12(session);
    if (
      low12 === undefined ||
      low12 < SESSION_BAND_MIN ||
      low12 > SESSION_BAND_MAX
    ) {
      return refuse(403, FREE_TIER_MESSAGE, "FreeTierError", "session_band");
    }
  }

  if (endpoint.kind === "models") {
    const listing = options.behavior?.(record);
    return accept(
      listing ?? {
        body: modelsListing(plane),
        contentType: JSON_CONTENT_TYPE,
        status: 200,
      }
    );
  }

  if (endpoint.kind === "usage") {
    const usageReply = options.behavior?.(record);
    return accept(usageReply ?? usageResponse(options.usage));
  }

  const { ok, parsed } = parseBody(exchange.bodyText);
  if (!ok) {
    return refuse(
      400,
      "the request body is not JSON",
      "invalid_request",
      "body"
    );
  }
  record.body = parsed;

  const model =
    endpoint.kind === "google"
      ? extractGoogleModel(url.pathname)
      : modelFromBody(record.body);
  record.model = model;
  if (model === null) {
    return refuse(
      400,
      "the request names no model",
      "invalid_request",
      "model"
    );
  }
  const expected = protocolForModel(plane, model);
  if (expected === undefined) {
    return refuse(
      404,
      `unknown model: ${model}`,
      "model_not_found",
      "model_unknown"
    );
  }

  // **The credential, judged per model.** The gateway admits a free model with NO
  // credential at all or with the literal `public` (`allowAnonymous` on the model
  // entry — measured: a keyless free-tier request answers 200), and requires a
  // real one everywhere else. A placeholder that is neither absent nor `public`
  // is still refused, on any model.
  const presented = headers[wireHeader];
  const bare = presented
    ?.replace(/^Bearer\s+/iu, "")
    .trim()
    .toLowerCase();
  const admitted =
    isCredential(presented) ||
    (model.includes("free") &&
      (bare === undefined || bare.length === 0 || bare === "public"));
  if (!admitted) {
    return refuse(401, "Invalid API key", "invalid_api_key", "credential");
  }

  // **Each protocol has its own contract, and the mock enforces it.** The auth
  // headers are already required above (`x-api-key` for Messages, `x-goog-api-key`
  // for Google); these are the rest of each wire format:
  //
  // - Anthropic identifies itself by version on every call — the official client's
  //   `@ai-sdk/anthropic` sends `anthropic-version: 2023-06-01`, and the vendor's
  //   own API answers a request without it as a client error;
  // - Anthropic bodies carry `max_tokens` and `messages` (the system prompt is a
  //   separate field, not a message role);
  // - Gemini bodies are `contents[].parts[]`, not `messages`.
  const requestBody = isRecord(record.body) ? record.body : {};
  if (endpoint.kind === "messages") {
    const version = headers["anthropic-version"];
    if (typeof version !== "string" || version.length === 0) {
      return refuse(
        400,
        "anthropic-version: header is required",
        "invalid_request",
        "anthropic_version"
      );
    }
    if (
      !Array.isArray(requestBody.messages) ||
      typeof requestBody.max_tokens !== "number"
    ) {
      return refuse(
        400,
        "max_tokens and messages are required",
        "invalid_request",
        "messages_body"
      );
    }
  }
  if (endpoint.kind === "google" && !Array.isArray(requestBody.contents)) {
    return refuse(
      400,
      "contents: field is required",
      "invalid_request",
      "contents"
    );
  }

  // **A free-tier call must carry tools.** Measured: the same body with and
  // without a `tools` array answers 200 and 403 FreeTierError respectively. It is
  // why `src/tool-fallback.ts` injects read/bash for free ids, and asserting it
  // here is what stops that injection being dropped without a visible failure.
  if (model.includes("free")) {
    const { tools } = isRecord(record.body) ? record.body : {};
    if (!Array.isArray(tools) || tools.length === 0) {
      return refuse(403, FREE_TIER_MESSAGE, "FreeTierError", "tools");
    }
  }
  if (expected !== endpoint.protocol) {
    return refuse(
      400,
      `ModelProtocolUnsupported: ${model} is not served on this endpoint`,
      "model_protocol_unsupported",
      "protocol"
    );
  }

  const streaming = isStreamingRequest(
    endpoint.kind,
    url.pathname,
    record.body
  );
  const override = options.behavior?.(record);
  return accept(override ?? fixtureReply(endpoint.kind, model, streaming));
};

const readBody = (request: IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });
    request.on("end", () => {
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    request.on("error", reject);
  });

export const openCodeGateway = (
  options: OpenCodeGatewayOptions = {}
): Plugin => ({
  configureServer(server) {
    server.middlewares.use((request, response, next) => {
      void (async () => {
        try {
          const bodyText = await readBody(request);
          const { reply } = handleGatewayRequest(
            {
              bodyText,
              headers: request.headers,
              method: request.method ?? "GET",
              url: request.url ?? "/",
            },
            options
          );
          response.writeHead(reply.status, {
            "cache-control": "no-store",
            "content-type": reply.contentType ?? JSON_CONTENT_TYPE,
          });
          response.end(reply.body);
        } catch (error) {
          next(error);
        }
      })();
    });
  },
  name: "dsh-opencode-mock-gateway",
});
