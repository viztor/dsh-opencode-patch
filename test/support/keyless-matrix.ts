/**
 * The keyless 401-vs-404 probe matrix: which gateway paths still exist.
 *
 * Two planes × four protocols × three URL shapes — legacy `/zen(/go)/v1`, the
 * root `/inference(/go)/v1`, and the modern per-protocol
 * `/inference(/go)/{openai,anthropic,google}/…` — one representative PAID
 * model per plane and protocol, every request sent WITHOUT a key. The gateway
 * authenticates before it routes a model, so a keyless request tells the paths
 * apart without spending anything: a 404 means the path is gone, a 401/403
 * that it exists, a 410 or a 400 "Model is unavailable" that the model is.
 * Beside the matrix, one keyless FREE-model probe on the default completions
 * path ({@link freeProbeCells}) asks whether the gateway parses a free model
 * there at all. `test/e2e/keyless-matrix.e2e.ts` sends both; P-R2 measures
 * them in CI (`docs/redirect-planes.md` §13, pending the first run) and keeps
 * the default family (`AUTO_ENDPOINT_FAMILY`).
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
  protocolForSdk,
} from "./src.ts";

export type MatrixPlane = "opencode" | "opencode-go";

/**
 * The three URL shapes, in the order cells are produced: the legacy family,
 * the root, and the modern family.
 */
export const MATRIX_FAMILIES = ["legacy", "root", "modern"] as const;
export type MatrixFamily = (typeof MATRIX_FAMILIES)[number];

/**
 * The root shape: one base per plane with every protocol under it, as legacy
 * is. It is the provider-level base `models.opencode.ai` declared until the
 * 2026-10-16 catalog regeneration (`docs/engineering-notes.md`, "The endpoint
 * chain"); the catalog now declares the modern completions base
 * (`OPENCODE_PLANE_API`). Nothing the plugin sends goes there — a route-level
 * `baseURL` on it selects the modern family — so it is measured only.
 */
export const INFERENCE_ROOT: Readonly<Record<MatrixPlane, string>> = {
  opencode: "https://opencode.ai/inference/v1",
  "opencode-go": "https://opencode.ai/inference/go/v1",
};

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
 * The cells the plugin sends turns to with the default endpoint (`auto`, an
 * alias of `modern`), on both planes: since P-R1 every protocol, completions
 * included, on the MODERN family (`/inference(/go)/…`). A path-gone verdict on
 * one of these breaks a shipped model in the default configuration, so the
 * live matrix asserts them. `test/keyless-matrix.test.ts` derives the same set
 * from the URLs `S0_TODAY` measured (with the default endpoint), so the two
 * cannot drift.
 *
 * Not covered: a user who sets `endpoint: legacy` dispatches to the cells in
 * {@link LEGACY_DISPATCH}. P-R2 decided that configuration is recorded, not
 * guarded, on the live gateway: its mapping is pinned offline
 * (`test/endpoint-family.test.ts`), and its verdicts are the record.
 */
export const TODAY_DISPATCH: ReadonlySet<string> = new Set(
  (["opencode", "opencode-go"] as const).flatMap((plane) =>
    MATRIX_PROTOCOLS.map((protocol) =>
      cellKey({ family: "modern", plane, protocol })
    )
  )
);

/**
 * The cells the plugin sends turns to with `endpoint: legacy`: the legacy cell
 * of every plane and protocol, except Go's Google, which stays on
 * `/inference/go/google/v1beta` under every family (`GO_GOOGLE_BASE_URL` in
 * `src/utils/protocols.ts`) — the modern cell {@link TODAY_DISPATCH} holds.
 *
 * Recorded, not guarded: P-R2 decided the live matrix and the keyed probes
 * print these cells' verdicts (marked `†` in the record). The keyless matrix
 * requires each one to answer readably, like every legacy cell
 * ({@link unreadRows}), but no live assertion reads a `†` cell's path-gone —
 * except Go's Google, which is also a default cell ({@link TODAY_DISPATCH})
 * and is guarded as one. What guards the configuration is the offline pin of
 * its mapping.
 */
export const LEGACY_DISPATCH: ReadonlySet<string> = new Set(
  (["opencode", "opencode-go"] as const).flatMap((plane) =>
    MATRIX_PROTOCOLS.map((protocol) =>
      cellKey({
        family:
          plane === "opencode-go" && protocol === "google-generative-ai"
            ? "modern"
            : "legacy",
        plane,
        protocol,
      })
    )
  )
);

/** What a probe answered, as the matrix reads it. */
export type KeylessVerdict =
  | "model-gone"
  | "no-model"
  | "other"
  | "path-exists"
  | "path-gone"
  | "redirected";

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
  if (family === "root") {
    // The root shape: like legacy, one base per plane, `?alt=sse` kept.
    return `${INFERENCE_ROOT[plane]}${suffixFor(protocol, model)}`;
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
      protocolForSdk(spec.provider_npm) === protocol &&
      !isFreeSpec(spec) &&
      !isDeprecated(spec.id)
  )?.id;

/**
 * Build the twenty-four cells.
 *
 * @param catalogs.zen - the Zen plane's catalog slice.
 * @param catalogs.go - the Go plane's catalog slice.
 * @param catalogs.isDeprecated - which ids the catalog retired (default: none).
 *   A slice from `parseModelsDevCatalog` has already dropped its deprecated
 *   rows, so the live matrix passes none; this guards an unparsed slice.
 * @returns the cells, plane by plane, protocol by protocol, then legacy, root
 *   and modern.
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
      for (const family of MATRIX_FAMILIES) {
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
 * matrix sends twenty-four requests on every pull request, and one 429 must not
 * turn the job red.
 *
 * @param status - the HTTP status, or `undefined` for a transport error.
 * @returns `true` to retry once.
 */
export const isTransientProbeAnswer = (status: number | undefined): boolean =>
  status === undefined || status === 429 || status >= 500;

/** One answer a probe received: its status, its body, and where a 3xx pointed. */
export interface ProbeAnswer {
  readonly status: number;
  readonly bodyText: string;
  /** The path a 3xx's `Location` names (never its host or query), if any. */
  readonly location?: string;
}

/**
 * The verdicts every live probe can end in whatever it classifies with: a
 * rate limit the one retry did not outlast, or no answer at all.
 */
export type AttemptVerdict = "rate-limited" | "transport-error";

/**
 * Read the attempts one probe made — one, or two after a transient answer
 * ({@link isTransientProbeAnswer}) — as one verdict.
 *
 * The last answer decides, with two exceptions that are the gateway's state
 * rather than the path's: a final 429 is `rate-limited`, and so is NO answer
 * after a 429 — measured, a rate-limited gateway answers 429 and then holds
 * the next connection open until the client gives up
 * (`test/e2e/protocol-routing.e2e.ts`). Any other last attempt with no answer
 * is `transport-error` — after no answer, a 5xx, or a busy upstream (a 503 or
 * a 529) alike: only the 429 hang is a measured gateway pattern.
 *
 * @param attempts - each attempt's answer, `undefined` for one that got none.
 * @param classify - how the suite reads an answer.
 * @returns the verdict.
 */
export const verdictOfAttempts = <V extends string>(
  attempts: readonly (ProbeAnswer | undefined)[],
  classify: (answer: ProbeAnswer) => V
): V | AttemptVerdict => {
  const last = attempts.at(-1);
  if (last === undefined) {
    return attempts.some((answer) => answer?.status === 429)
      ? "rate-limited"
      : "transport-error";
  }
  return last.status === 429 ? "rate-limited" : classify(last);
};

/**
 * The path a redirect points at, resolved against the URL that was sent: no
 * host and no query, so a redirect that carried a token in its query cannot
 * leak it into a record.
 *
 * @param location - the `Location` header, or `null`.
 * @param url - the URL the probe sent.
 * @returns the path, or `undefined` when there is none or it cannot be read.
 */
export const redirectPathOf = (
  location: string | null,
  url: string
): string | undefined => {
  if (location === null || location.length === 0) {
    return undefined;
  }
  try {
    return new URL(location, url).pathname;
  } catch {
    return undefined;
  }
};

/**
 * A 5xx that is the upstream provider being busy, not the gateway failing on
 * the path: a 503 or a 529 (Anthropic's `overloaded_error`), or any 5xx whose
 * body names an overload (`overloaded_error`, Gemini's `model is overloaded`
 * or `UNAVAILABLE`). A request that reaches the upstream — a keyed probe, or
 * the keyless free probe — sees this routinely. The gateway may have routed
 * the request, or its front may have answered before reading it, so like a
 * rate limit it says nothing about the path or the key — which is why the
 * keyed probes never read it as a shape accepting the request. A 500, a 502
 * or an unnamed 5xx is not busy:
 * protocol-routing reads a keyed 500 as "the shape does not parse", and a
 * gateway that crashes on a path must still fail.
 *
 * @param status - the HTTP status.
 * @param bodyText - the response body, as text.
 * @returns whether the upstream was busy.
 */
export const isUpstreamBusy = (status: number, bodyText: string): boolean =>
  status === 503 ||
  status === 529 ||
  (status >= 500 &&
    /overloaded_error|model is overloaded|UNAVAILABLE/u.test(bodyText));

/** Whether a status is a redirect, which a probe sends with `redirect: "manual"` and never follows. */
const isRedirect = (status: number): boolean => status >= 300 && status < 400;

/**
 * Whether a live turn's failure message says the gateway withdrew the model.
 *
 * The same two answers {@link classifyKeylessProbe} reads as `model-gone` — a
 * `410`, or a `400` saying "Model is unavailable" — as they reach a turn's
 * failure message rather than a raw response. It is a PRE-FILTER, not a
 * verdict: the gateway answers "Model is unavailable" for an id sent where it
 * is not served too (`docs/upstream-findings.md` §3.8), so the live adapter
 * blocks move past such a model only once a raw probe of the same id
 * (`modelGone` in `test/support/live-probe.ts`) confirms the vendor withdrew
 * it, and fail the turn otherwise.
 *
 * @param message - the turn's failure message.
 * @returns whether the message names a withdrawn model.
 */
export const isModelGoneMessage = (message: string): boolean =>
  /\b410\b|model is unavailable/iu.test(message);

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
  if (isRedirect(answer.status)) {
    return "redirected";
  }
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

/** The keyless verdicts the matrix can read: the path exists, is gone, or the model is. */
const READABLE: ReadonlySet<string> = new Set([
  "model-gone",
  "path-exists",
  "path-gone",
]);

/**
 * The matrix rows whose answer cannot be read: every legacy and modern cell
 * whose verdict is not one of path-exists, path-gone or model-gone — an
 * unreadable status, a redirect, a rate limit, no answer, or a model-less
 * cell. A root row is never one: nothing dispatches there, so whatever it
 * answers is recorded and cannot fail a pull request. A legacy row IS read:
 * `endpoint: legacy`'s path-gone is recorded, not asserted, but an answer the
 * matrix cannot read at all is a matrix that measured nothing.
 *
 * @param rows - each probed cell's family and verdict.
 * @returns the unreadable rows, in order.
 */
export const unreadRows = <
  R extends { readonly family: MatrixFamily; readonly verdict: string },
>(
  rows: readonly R[]
): R[] =>
  rows.filter((row) => row.family !== "root" && !READABLE.has(row.verdict));

/**
 * The matrix rows that break the default: a cell the default dispatches to
 * (`TODAY_DISPATCH`) whose path is gone.
 *
 * @param rows - each probed cell's key and verdict.
 * @returns the broken rows, in order.
 */
export const goneDefaultRows = <
  R extends { readonly cell: string; readonly verdict: string },
>(
  rows: readonly R[]
): R[] =>
  rows.filter(
    (row) => TODAY_DISPATCH.has(row.cell) && row.verdict === "path-gone"
  );

/**
 * The keyless free-model probe's cells: every free model the slice serves on
 * completions, in catalog order, each addressed to the default completions
 * path (`/inference/openai/v1/chat/completions`) with the matrix's smallest
 * body and no credential. A free model is the one class the gateway parses
 * without a key, so this is the one keyless request that tells whether the
 * default completions path still SERVES rather than only exists.
 *
 * @param specs - the Zen plane's catalog slice.
 * @returns the cells; the live suite sends the first few.
 */
export const freeProbeCells = (
  specs: readonly CatalogModelSpec[]
): MatrixCell[] =>
  specs
    .filter(
      (spec) =>
        isFreeSpec(spec) &&
        protocolForSdk(spec.provider_npm) === "openai-completions"
    )
    .map((spec) => ({
      body: matrixBody("openai-completions", spec.id),
      family: "modern",
      headers: headersFor("openai-completions"),
      method: "POST",
      model: spec.id,
      plane: "opencode",
      protocol: "openai-completions",
      url: matrixUrl("opencode", "openai-completions", "modern", spec.id),
    }));

/** What the free probe answered. */
export type FreeVerdict =
  | "auth-required"
  | "free-tier-gated"
  | "model-gone"
  | "other"
  | "path-gone"
  | "redirected"
  | "served"
  | "upstream-busy"
  | "wrong-format";

/**
 * Read one free-probe answer. A `FreeTierError` is the free tier refusing a
 * request it parsed (a missing session or tool schema), so it passes; a
 * "not supported for format" is the model sent to an endpoint that cannot
 * speak its wire format; any other 401 or 403 means the gateway wanted a key
 * for a model it used to serve without one. A free model is the one keyless
 * request that reaches the upstream, so a busy upstream
 * ({@link isUpstreamBusy}) is `upstream-busy`, as the keyed probes read it;
 * any other 5xx is `other`.
 *
 * @param answer.status - the HTTP status.
 * @param answer.bodyText - the response body, as text.
 * @returns the verdict.
 */
export const classifyFreeProbe = (answer: {
  readonly status: number;
  readonly bodyText: string;
}): FreeVerdict => {
  if (isRedirect(answer.status)) {
    return "redirected";
  }
  if (answer.status === 404) {
    return "path-gone";
  }
  if (
    answer.status === 410 ||
    (answer.status === 400 && /model is unavailable/iu.test(answer.bodyText))
  ) {
    return "model-gone";
  }
  if (answer.status >= 200 && answer.status < 300) {
    return "served";
  }
  if (answer.status === 403 && /FreeTierError/u.test(answer.bodyText)) {
    return "free-tier-gated";
  }
  if (
    answer.status === 401 &&
    /not supported for format/iu.test(answer.bodyText)
  ) {
    return "wrong-format";
  }
  if (answer.status === 401 || answer.status === 403) {
    return "auth-required";
  }
  return isUpstreamBusy(answer.status, answer.bodyText)
    ? "upstream-busy"
    : "other";
};

/**
 * The free-probe verdicts that move on to the next free candidate: a retired
 * model, or a busy upstream — neither says anything about the path.
 */
const FREE_MOVES_ON: ReadonlySet<string> = new Set([
  "model-gone",
  "upstream-busy",
]);

/** Whether the free probe tries the next candidate after this verdict. */
export const freeProbeMovesOn = (verdict: string): boolean =>
  FREE_MOVES_ON.has(verdict);

/**
 * Which candidate decides the free probe, from every candidate's verdict in
 * the order sent: the last one, which is the first that did not move on
 * ({@link freeProbeMovesOn}); when every candidate moved on, the first busy
 * one if any was busy — the run measured a busy upstream, not three retired
 * models — else the last. `-1` when no candidate was sent.
 *
 * @param verdicts - each candidate's verdict, in the order sent.
 * @returns the deciding candidate's index.
 */
const decidingIndex = (
  verdicts: readonly (FreeVerdict | AttemptVerdict)[]
): number => {
  const last = verdicts.length - 1;
  if (last >= 0 && freeProbeMovesOn(verdicts[last] ?? "")) {
    const busy = verdicts.indexOf("upstream-busy");
    return busy === -1 ? last : busy;
  }
  return last;
};

/**
 * The free probe's verdict from every candidate it sent, in order: the
 * deciding candidate's ({@link decidingIndex}), or `transport-error` when no
 * candidate was sent.
 *
 * @param verdicts - each candidate's verdict, in the order sent.
 * @returns the verdict the probe decides on.
 */
export const freeProbeVerdictOf = (
  verdicts: readonly (FreeVerdict | AttemptVerdict)[]
): FreeVerdict | AttemptVerdict =>
  verdicts[decidingIndex(verdicts)] ?? "transport-error";

/** One free candidate as the probe read it: what the record names. */
export interface FreeCandidate {
  readonly model: string | undefined;
  /** The last attempt's status, `undefined` when it got no answer. */
  readonly status: number | undefined;
  /** The last attempt's body, `""` when it got no answer. */
  readonly bodyText: string;
  readonly verdict: FreeVerdict | AttemptVerdict;
}

/**
 * Walk the free candidates: send each in order ({@link freeProbeCells}), read
 * its attempts ({@link verdictOfAttempts}), and stop at the first that does
 * not move on ({@link freeProbeMovesOn}). The candidate that decides
 * ({@link freeProbeVerdictOf}) is returned with its OWN model, status and
 * body, so a busy upstream decided by an earlier candidate is never recorded
 * under a later one's model and status.
 *
 * Pure but for the injected sender, which is the live suite's retried fetch.
 *
 * @param cells - the candidates, in the order to send them.
 * @param send - sends one cell; every attempt's answer, `undefined` for none.
 * @returns every candidate sent, and the one that decides.
 */
export const runFreeProbe = async (
  cells: readonly MatrixCell[],
  send: (cell: MatrixCell) => Promise<readonly (ProbeAnswer | undefined)[]>
): Promise<{
  readonly candidates: readonly FreeCandidate[];
  readonly decided: FreeCandidate;
}> => {
  const candidates: FreeCandidate[] = [];
  for (const cell of cells) {
    // oxlint-disable-next-line no-await-in-loop -- sequential by design: the next candidate is sent only when this one moved on
    const attempts = await send(cell);
    const answer = attempts.at(-1);
    const verdict = verdictOfAttempts(attempts, classifyFreeProbe);
    candidates.push({
      bodyText: answer?.bodyText ?? "",
      model: cell.model,
      status: answer?.status,
      verdict,
    });
    if (!freeProbeMovesOn(verdict)) {
      break;
    }
  }
  return {
    candidates,
    decided: candidates[
      decidingIndex(candidates.map((candidate) => candidate.verdict))
    ] ?? {
      bodyText: "",
      model: undefined,
      status: undefined,
      verdict: "transport-error",
    },
  };
};

/** The free-probe verdicts that mean the default completions path parses a free model. */
const FREE_PROBE_PASSES: ReadonlySet<string> = new Set([
  "served",
  "free-tier-gated",
]);

/**
 * What the free probe's verdict decides: `pass` when the default
 * completions path parsed the free model (served, or gated by the free tier);
 * `skip` when the gateway was rate-limiting (`rate-limited`) or the upstream
 * busy (`upstream-busy`), which say nothing about the path — free models are
 * the class it limits, and `test/e2e/protocol-routing.e2e.ts`'s free cases
 * skip on a rate limit too; `fail` on everything else: a gone path, a key
 * demanded, the wrong wire format, a redirect, an unreadable status, no
 * answer, or three retired free models.
 *
 * @param verdict - the probe's verdict ({@link freeProbeVerdictOf}).
 * @returns the outcome.
 */
export const freeProbeOutcome = (
  verdict: FreeVerdict | AttemptVerdict
): "fail" | "pass" | "skip" => {
  if (FREE_PROBE_PASSES.has(verdict)) {
    return "pass";
  }
  return verdict === "rate-limited" || verdict === "upstream-busy"
    ? "skip"
    : "fail";
};
