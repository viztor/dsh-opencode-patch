/**
 * The keyless 401-vs-404 probe matrix: which gateway paths still exist.
 *
 * Two planes × four protocols × two endpoint families, one representative
 * PAID model per plane and protocol, every request sent WITHOUT a key. The gateway
 * authenticates before it routes a model, so a keyless request tells the paths
 * apart without spending anything: a 404 means the path is gone, a 401/403
 * that it exists, a 410 or a 400 "Model is unavailable" that the model is.
 * `test/e2e/keyless-matrix.e2e.ts` sends the cells; P-R2 decides the default
 * family from what they answer.
 *
 * Pure: every function here is a function of its arguments — no fetch, no
 * environment, no module state — so the cell table and the classifier are
 * unit-tested offline (`test/keyless-matrix.test.ts`). There is no code path
 * here that can set `authorization`, `x-api-key` or `x-goog-api-key`.
 *
 * @module test/support/keyless-matrix
 */
import {
  ANTHROPIC_VERSION,
  type CatalogModelSpec,
  LEGACY_PLANE_API,
  OPENCODE_FAMILY_API,
  protocolFor,
} from "./src.ts";

export type MatrixPlane = "opencode" | "opencode-go";
export type MatrixFamily = "legacy" | "modern";

/** The four protocols, in the order cells are produced. */
export const MATRIX_PROTOCOLS = [
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
  "google-generative-ai",
] as const;
export type MatrixProtocol = (typeof MATRIX_PROTOCOLS)[number];

/** One probe: what to send, and to where. */
export interface MatrixCell {
  readonly plane: MatrixPlane;
  readonly protocol: MatrixProtocol;
  readonly family: MatrixFamily;
  /** `undefined` when the plane's catalog has no model for the protocol. */
  readonly model: string | undefined;
  readonly url: string;
  readonly method: "POST";
  readonly headers: Readonly<Record<string, string>>;
  /** `undefined` exactly when `model` is. */
  readonly body: Readonly<Record<string, unknown>> | undefined;
}

/** A cell's name: `<plane> <protocol> <family>`, as the live table prints it. */
export const cellKey = (
  cell: Pick<MatrixCell, "family" | "plane" | "protocol">
): string => `${cell.plane} ${cell.protocol} ${cell.family}`;

/**
 * The cells TODAY's plugin sends turns to with the default endpoint (`auto`,
 * an alias of `modern`), on both planes: completions on pi 1.1.0's LEGACY
 * bases (`/zen(/go)/v1/chat/completions`, pi-ai's own plane route) and the
 * three hidden routes' MODERN paths (Responses, Messages, Google). A path-gone
 * verdict on one of these breaks a shipped model in the default
 * configuration, so the live matrix asserts them. `test/keyless-matrix.test.ts`
 * derives the same set from the URLs `S0_TODAY` measured (with the default
 * endpoint), so the two cannot drift.
 *
 * Not covered: a user who sets `endpoint: legacy` dispatches Responses and
 * Messages on both planes, and Zen's Google, to the LEGACY cells, which the
 * matrix records for P-R2 and does not assert; P-R2 decides whether that
 * configuration is guarded. Go's Google is the exception: it stays on
 * `/inference/go/google/v1beta` under every family (`GO_GOOGLE_BASE_URL` in
 * `src/google-bridge.ts`), which is the modern cell this set already holds.
 */
export const TODAY_DISPATCH: ReadonlySet<string> = new Set(
  (["opencode", "opencode-go"] as const).flatMap((plane) => [
    cellKey({ family: "legacy", plane, protocol: "openai-completions" }),
    cellKey({ family: "modern", plane, protocol: "openai-responses" }),
    cellKey({ family: "modern", plane, protocol: "anthropic-messages" }),
    cellKey({ family: "modern", plane, protocol: "google-generative-ai" }),
  ])
);

/**
 * The cells P-R1 moves traffic to that nothing dispatches to yet: completions
 * on the modern family (`/inference(/go)/openai/v1`). The live matrix asserts
 * them too, as P-R1's forward guard, and labels them so in its failure.
 */
export const NEXT_DISPATCH: ReadonlySet<string> = new Set(
  (["opencode", "opencode-go"] as const).map((plane) =>
    cellKey({ family: "modern", plane, protocol: "openai-completions" })
  )
);

/** What a probe answered, as the matrix reads it. */
export type KeylessVerdict =
  | "model-gone"
  | "no-model"
  | "other"
  | "path-exists"
  | "path-gone";

/** The catalog SDK each protocol is served for, for the modern family table. */
const SDK_FOR: Readonly<Record<MatrixProtocol, string>> = {
  "anthropic-messages": "@ai-sdk/anthropic",
  "google-generative-ai": "@ai-sdk/google",
  "openai-completions": "",
  "openai-responses": "@ai-sdk/openai",
};

/** The path each body-addressed protocol appends to its base. */
const BODY_PATH: Readonly<
  Record<Exclude<MatrixProtocol, "google-generative-ai">, string>
> = {
  "anthropic-messages": "/messages",
  "openai-completions": "/chat/completions",
  "openai-responses": "/responses",
};

/**
 * The path a protocol appends to its base. Google names the model in the path
 * and streams; the three others name it in the body.
 */
const suffixFor = (
  protocol: MatrixProtocol,
  model: string | undefined
): string =>
  protocol === "google-generative-ai"
    ? `/models/${model ?? "<none>"}:streamGenerateContent?alt=sse`
    : BODY_PATH[protocol];

/**
 * The URL a cell probes.
 *
 * The Go plane's legacy Google cell has no `?alt=sse`: pi 1.1.0 ships no Go
 * Google provider, so that path is the bare one the plan names
 * (`/zen/go/v1/models/<id>:streamGenerateContent`), not a request pi makes.
 */
export const matrixUrl = (
  plane: MatrixPlane,
  protocol: MatrixProtocol,
  family: MatrixFamily,
  model: string | undefined
): string => {
  if (family === "legacy") {
    // The legacy family: one base per plane, every protocol under its `/v1`.
    const url = `${LEGACY_PLANE_API[plane]}${suffixFor(protocol, model)}`;
    return plane === "opencode-go" && protocol === "google-generative-ai"
      ? url.replace("?alt=sse", "")
      : url;
  }
  const table = OPENCODE_FAMILY_API[plane === "opencode-go" ? "go" : "zen"];
  return `${table[SDK_FOR[protocol]] ?? ""}${suffixFor(protocol, model)}`;
};

/** The smallest valid request body for a protocol, carrying the model. */
export const matrixBody = (
  protocol: MatrixProtocol,
  model: string
): Readonly<Record<string, unknown>> => {
  if (protocol === "openai-responses") {
    return { input: "hi", max_output_tokens: 1, model };
  }
  if (protocol === "google-generative-ai") {
    return {
      contents: [{ parts: [{ text: "hi" }], role: "user" }],
      generationConfig: { maxOutputTokens: 1 },
    };
  }
  // Chat completions and Messages share the minimal shape.
  return {
    max_tokens: 1,
    messages: [{ content: "hi", role: "user" }],
    model,
  };
};

/** The only headers a cell carries: never a credential. */
const headersFor = (protocol: MatrixProtocol): Record<string, string> =>
  protocol === "anthropic-messages"
    ? {
        "anthropic-version": ANTHROPIC_VERSION,
        "content-type": "application/json",
      }
    : { "content-type": "application/json" };

/**
 * Whether a catalog row is a free model. A keyless probe must never pick one:
 * the gateway serves an unmetered model WITHOUT a key (measured: `beam-free`
 * answers `200` with a real completion), so its cell would spend a completion
 * and read as "other" instead of telling the path apart, and a free-tier
 * model answers a wrong endpoint with a 500. The id test is defence in depth
 * for a slice whose `is_free` was not derived (`parseModelsDevCatalog` sets it
 * from the id or a zero cost).
 */
export const isFreeSpec = (spec: CatalogModelSpec): boolean =>
  spec.is_free === true || /free/iu.test(spec.id);

/**
 * The representative model for a protocol: the first catalog row that speaks
 * it, is not free, and is not deprecated. A paid model is the class the
 * gateway answers with 401 before it routes, which is what the matrix reads.
 */
const representative = (
  specs: readonly CatalogModelSpec[],
  protocol: MatrixProtocol,
  isDeprecated: (id: string) => boolean
): string | undefined =>
  specs.find(
    (spec) =>
      protocolFor(spec) === protocol &&
      !isFreeSpec(spec) &&
      !isDeprecated(spec.id)
  )?.id;

/**
 * Build the sixteen cells.
 *
 * @param catalogs.zen - the Zen plane's catalog slice.
 * @param catalogs.go - the Go plane's catalog slice.
 * @param catalogs.isDeprecated - which ids the catalog retired (default: none).
 *   A slice from `parseModelsDevCatalog` has already dropped its deprecated
 *   rows, so the live matrix passes none; this guards an unparsed slice.
 * @returns the cells, plane by plane, protocol by protocol, legacy first.
 */
export const keylessMatrix = (catalogs: {
  readonly zen: readonly CatalogModelSpec[];
  readonly go: readonly CatalogModelSpec[];
  readonly isDeprecated?: (plane: MatrixPlane, id: string) => boolean;
}): MatrixCell[] => {
  const cells: MatrixCell[] = [];
  for (const plane of ["opencode", "opencode-go"] as const) {
    const specs = plane === "opencode" ? catalogs.zen : catalogs.go;
    for (const protocol of MATRIX_PROTOCOLS) {
      const model = representative(
        specs,
        protocol,
        (id) => catalogs.isDeprecated?.(plane, id) ?? false
      );
      for (const family of ["legacy", "modern"] as const) {
        cells.push({
          body: model === undefined ? undefined : matrixBody(protocol, model),
          family,
          headers: headersFor(protocol),
          method: "POST",
          model,
          plane,
          protocol,
          url: matrixUrl(plane, protocol, family, model),
        });
      }
    }
  }
  return cells;
};

/**
 * Whether a probe's answer is transient and worth one retry before it is
 * classified: a rate limit, a server error, or no answer at all. The live
 * matrix sends sixteen requests on every pull request, and one 429 must not
 * turn the job red.
 *
 * @param status - the HTTP status, or `undefined` for a transport error.
 * @returns `true` to retry once.
 */
export const isTransientProbeAnswer = (status: number | undefined): boolean =>
  status === undefined || status === 429 || status >= 500;

/**
 * Read one keyless answer.
 *
 * @param answer.status - the HTTP status.
 * @param answer.bodyText - the response body, as text.
 * @returns the verdict.
 */
export const classifyKeylessProbe = (answer: {
  readonly status: number;
  readonly bodyText: string;
}): Exclude<KeylessVerdict, "no-model"> => {
  if (answer.status === 404) {
    return "path-gone";
  }
  if (answer.status === 410) {
    return "model-gone";
  }
  if (answer.status === 400) {
    return /model is unavailable/iu.test(answer.bodyText)
      ? "model-gone"
      : "path-exists";
  }
  if (answer.status === 401 || answer.status === 403) {
    return "path-exists";
  }
  return "other";
};
