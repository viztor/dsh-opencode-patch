/**
 * Pure readers of a request's SHAPE — everything the fetch patch decides about a
 * request before it touches it.
 *
 * Extracted because these were private inside `fetch-patch.ts`: seven
 * predicates and resolvers, all pure, none reachable from a test. The exported
 * ones (`hasSessionHeader`, `isOpenCodeRequest`) had tests; the private ones did
 * not, which is the difference between "covered" and "testable" — a rule that
 * lives in a closure cannot be exercised on its own, so its branches survive
 * until some integration path happens to take them.
 *
 * Everything here is a function of its arguments: no context, no globals, no
 * I/O. That is what makes each branch testable by calling it.
 *
 * @module dsh-opencode-patch/request-shape
 */

import { isRecord } from "./guards.ts";

/**
 * The PATH of a gateway URL, whether it is absolute or a bare path.
 *
 * A relative path is still a path — `"/zen/go/v1/models"` is what a caller with
 * no origin passes, and the plane is a property of the path. Anything else that
 * does not parse answers `""`, because guessing from a malformed string is how a
 * rotation lands on the wrong credential.
 */
const pathOf = (url: string): string => {
  try {
    return new URL(url).pathname;
  } catch {
    return url.startsWith("/") ? (url.split("?")[0] ?? "") : "";
  }
};

/**
 * The Go plane's paths, in both endpoint families.
 *
 * The vendor serves the Go plane under `/zen/go` on the older family and under
 * `/inference/go` on the newer one, and a relay may use its own `/go/v1`.
 *
 * **The segment boundary is load-bearing.** `/inference/go` is a PREFIX of
 * `/inference/google`, which is the ZEN google family — a plain `includes`
 * reads it as the Go plane, and a captured key then belongs to the wrong
 * account. So the segment must END there: `/inference/go` followed by a
 * separator or the end of the path, never by more letters.
 */
const GO_PLANE_PATH =
  /\/zen\/go(?:\/|$)|\/inference\/go(?:\/|$)|\/go\/v1(?:\/|$)/u;

/** The Zen plane's paths, in both endpoint families. */
const ZEN_PLANE_PATH = /\/zen(?:\/|$)|\/inference(?:\/|$)/u;

/**
 * Whether a URL is on the GO plane.
 *
 * **One answer for every caller.** Three places ask this question — the model
 * listing's plane, a discovery request's plane, and the tier a captured key
 * belongs to — and they had three answers, because the newer `inference`
 * family was added to each of them separately and each addition was partial:
 *
 * | path | the old substring checks said |
 * | :-- | :-- |
 * | `/inference/go/openai/v1` | zen (the Go path was unknown to two of them) |
 * | `/inference/google/v1beta` | **go** (`/inference/go` is a prefix of it) |
 * | `/inference/openai/v1` | unknown (`/inference/v1` is not in it) |
 *
 * The middle row is a credential filed under the wrong account; the third is a
 * credential filed under no account at all, which is the "my key is invalid"
 * report. Both are the same mistake: a plane is a property of the PATH, and
 * the path has to be read as a path.
 *
 * @param url - a request URL or a bare path.
 * @returns whether this URL belongs to the Go plane.
 */
export const isGoPlaneUrl = (url: string): boolean =>
  GO_PLANE_PATH.test(pathOf(url));

/**
 * Which gateway plane a URL belongs to.
 *
 * From the URL alone, because the observer is called with nothing else and a
 * mis-attributed rotation would move the wrong plane's credential. The Go plane
 * lives under `/zen/go` and the Zen plane under `/zen`, so the longer path is
 * matched first — and an unrecognised URL answers `""` rather than guessing,
 * because a rotation is a side effect.
 *
 * @param url - a request URL (any absolute or relative string a `URL` accepts).
 * @returns `opencode-go`, `opencode`, or `""` when the URL is not a gateway URL.
 */
export const gatewayPlaneFor = (url: string): string => {
  const path = pathOf(url);
  if (path === "") {
    return "";
  }
  // Both endpoint families, because a credential's format decides which one a
  // request belongs on and the plane is the same either way.
  if (GO_PLANE_PATH.test(path)) {
    return "opencode-go";
  }
  if (ZEN_PLANE_PATH.test(path)) {
    return "opencode";
  }
  return "";
};

/**
 * The credential header the request's protocol actually reads.
 *
 * `/messages` is the Anthropic shape (`x-api-key`) and the Gemini path carries
 * its key in `x-goog-api-key`; everything else reads `Authorization`.
 *
 * @param url - the request URL.
 * @returns the header name, defaulting to `authorization`.
 */
export const authHeaderFor = (url: string): string => {
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    return "authorization";
  }
  if (path.endsWith("/messages")) {
    return "x-api-key";
  }
  if (
    /\/models\/[^/]+(?::streamGenerateContent|:generateContent)$/u.test(path)
  ) {
    return "x-goog-api-key";
  }
  return "authorization";
};

/**
 * The URL of a `fetch` input, or `""` when it has none.
 *
 * `fetch` accepts a string, a `URL`, or a `Request`, and the patch has to read
 * every form because it wraps whatever the caller passed.
 *
 * @param input - the first `fetch` argument.
 * @returns the URL string, or `""`.
 */
export const requestUrlOf = (input: RequestInfo | URL): string => {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.toString();
  }
  if (typeof input === "object" && input !== null && "url" in input) {
    const url: unknown = (input as { url?: unknown }).url;
    if (typeof url === "string") {
      return url;
    }
    if (url instanceof URL) {
      return url.toString();
    }
  }
  return "";
};

/**
 * Where a request's headers come from: `init` when given, else the `Request`.
 *
 * @param input - the first `fetch` argument.
 * @param init - the second, when the caller passed one.
 * @returns the header source, or `undefined` when the input carries none.
 */
export const headerSourceOf = (
  input: RequestInfo | URL,
  init?: RequestInit
): HeadersInit | undefined => {
  if (init?.headers !== undefined) {
    return init.headers;
  }
  if (typeof Request !== "undefined" && input instanceof Request) {
    return input.headers;
  }
  return undefined;
};

/**
 * The model id a JSON request body names, or `undefined`.
 *
 * Both JSON routes carry it under `model`, the Responses API included. A body
 * that is not a string, not JSON, or names no model answers `undefined` rather
 * than throwing: these readers run on every gateway request.
 *
 * @param body - the request body, when there is one to read.
 * @returns the model id.
 */
export const modelIdOf = (body: RequestInit["body"]): string | undefined => {
  if (typeof body !== "string" || body.length === 0) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(body);
    if (!isRecord(parsed)) {
      return undefined;
    }
    const { model } = parsed;
    return typeof model === "string" && model.length > 0 ? model : undefined;
  } catch {
    return undefined;
  }
};

/**
 * The tool names a JSON request body carries, comma-joined.
 *
 * Both wire shapes are read — `{name}` and `{type:"function",function:{name}}` —
 * because the fallback injects into either. A malformed body answers `""`.
 *
 * @param body - the request body, when there is one to read.
 * @returns the names, comma-joined, or `""`.
 */
export const toolNamesOf = (body: RequestInit["body"]): string => {
  if (typeof body !== "string" || body.length === 0) {
    return "";
  }
  try {
    const parsed: unknown = JSON.parse(body);
    if (!isRecord(parsed)) {
      return "";
    }
    const { tools } = parsed;
    if (!Array.isArray(tools)) {
      return "";
    }
    const names: string[] = [];
    for (const tool of tools) {
      if (!isRecord(tool)) {
        continue;
      }
      if (typeof tool.name === "string") {
        names.push(tool.name);
        continue;
      }
      const fn = tool.function;
      if (isRecord(fn) && typeof fn.name === "string") {
        names.push(fn.name);
      }
    }
    return names.join(",");
  } catch {
    return "";
  }
};

/**
 * The Anthropic protocol version the gateway requires on every Messages call.
 *
 * The official client sends it on every call and the vendor's API answers a
 * request without it as a client error.
 */
export const ANTHROPIC_VERSION = "2023-06-01";

/**
 * Whether a provider route is OpenCode Zen rather than Go.
 *
 * Both routes share the `opencode` prefix, so the distinguishing signal is
 * **the route's own suffix**, not the letters "go" anywhere in it.
 *
 * That distinction is not pedantry: `opencode-google` is the ZEN google route,
 * and the "go" inside "google" is not the Go plane. A substring test read it as
 * Go — a Zen route answered with the Go plane's rules, which is how the meter
 * drew the Go gauge for a Zen model and a 401 on it was filed as a missing Go
 * credential instead of a Zen one.
 *
 * The rule the rest of the plugin already uses: Go is `opencode-go` or
 * `opencode-go-*`, and everything else that names OpenCode is Zen.
 */
export const isZenProvider = (provider?: string): boolean => {
  if (typeof provider !== "string") {
    return false;
  }
  const lower = provider.toLowerCase();
  if (!lower.includes("opencode")) {
    return false;
  }
  return !(lower === "opencode-go" || lower.startsWith("opencode-go-"));
};
