/**
 * The keyed half of the probe matrix: the same cells as the keyless one, each
 * sent with the plane's own key, and the tier that decides which live suites
 * may spend one.
 *
 * A keyed request goes past authentication, so its answer says whether the
 * gateway SERVES the protocol on that path with that plane's credential — what
 * a keyless 401 cannot. Each body carries the budget
 * `test/e2e/protocol-routing.e2e.ts` already sends with a key (1 to 16 output
 * tokens), so a probe spends a few output tokens at most. `test/e2e/keyed-probes.e2e.ts` sends the
 * cells and asserts only the ones the default family dispatches to
 * (`TODAY_DISPATCH`); every other verdict is recorded.
 *
 * A keyed cell also carries the identity the plugin sends on every turn
 * ({@link pluginIdentityHeaders}): its user agent, `x-opencode-client`,
 * `x-opencode-project` and an in-band session id under both session headers.
 * Without them the probe would not be the plugin's traffic — the Go plane
 * refuses a keyed request with no session header (`400 MissingSessionID`,
 * `docs/engineering-notes.md`), which would read as "the path parsed it" and
 * measure nothing.
 *
 * Pure: no environment read and no fetch — the tier takes the variable's
 * VALUE, and a key comes in as an argument. It reaches `src` only through the
 * test door (`./src.ts`), as `./keyless-matrix.ts` does, for the user agent a
 * turn carries, so the identity the live suite sends is defined here once
 * ({@link PROBE_IDENTITY}) and the offline case that holds it to the real
 * fetch patch checks that same value. The keyless module still has no code
 * path that can set a credential; {@link keyedCell} is the one place a key is
 * added to a cell.
 *
 * @module test/support/keyed-probes
 */
import {
  type AttemptVerdict,
  type MatrixCell,
  type MatrixProtocol,
  type ProbeAnswer,
  TODAY_DISPATCH,
  verdictOfAttempts,
} from "./keyless-matrix.ts";
import { OPENCODE_UA } from "./src.ts";

/** How much of the live suite may spend a key, from `OPENCODE_E2E_KEYED`. */
export const KEYED_TIERS = ["none", "probes", "full"] as const;
export type KeyedTier = (typeof KEYED_TIERS)[number];

const isKeyedTier = (value: string): value is KeyedTier =>
  (KEYED_TIERS as readonly string[]).includes(value);

/**
 * The tier `OPENCODE_E2E_KEYED` names. Unset or blank is `full`, so a local run
 * with keys arms everything, as it did before the tiers; a value it does not
 * know fails the run rather than silently arming or disarming a suite.
 *
 * @param value - the variable's value.
 * @returns the tier.
 */
export const keyedTierOf = (value: string | undefined): KeyedTier => {
  const trimmed = (value ?? "").trim();
  if (trimmed.length === 0) {
    return "full";
  }
  if (isKeyedTier(trimmed)) {
    return trimmed;
  }
  throw new Error(
    `OPENCODE_E2E_KEYED must be one of ${KEYED_TIERS.join(", ")}; got "${value}"`
  );
};

/**
 * Whether a tier arms a suite that needs `need`: `full` arms both, `probes`
 * only the minimal probes, `none` nothing.
 */
export const isArmed = (tier: KeyedTier, need: "full" | "probes"): boolean =>
  tier === "full" || (tier === "probes" && need === "probes");

/**
 * The key a suite may use: the key when its tier arms the suite and the key is
 * non-empty, else `undefined` — which every keyed suite reads as "skip".
 */
export const armedKey = (
  tier: KeyedTier,
  need: "full" | "probes",
  key?: string
): string | undefined =>
  isArmed(tier, need) && key !== undefined && key.length > 0 ? key : undefined;

/** The header a protocol reads its credential from, carrying `key`. */
export const credentialHeaders = (
  protocol: MatrixProtocol,
  key: string
): Record<string, string> => {
  if (protocol === "anthropic-messages") {
    return { "x-api-key": key };
  }
  if (protocol === "google-generative-ai") {
    return { "x-goog-api-key": key };
  }
  return { authorization: `Bearer ${key}` };
};

/**
 * The small body each endpoint is sent WITH a key: the shapes and budgets
 * `test/e2e/protocol-routing.e2e.ts` sends (`BODY_FOR`), with the model named
 * in the body for the three body-addressed protocols. A non-empty `messages`
 * and Google's `role` keep the gateway judging the path and the model rather
 * than refusing the JSON.
 */
export const keyedBody = (
  protocol: MatrixProtocol,
  model: string
): Readonly<Record<string, unknown>> => {
  if (protocol === "openai-completions") {
    return {
      max_tokens: 8,
      messages: [{ content: "hi", role: "user" }],
      model,
      stream: false,
    };
  }
  if (protocol === "openai-responses") {
    return { input: "hi", max_output_tokens: 16, model };
  }
  if (protocol === "anthropic-messages") {
    return {
      max_tokens: 1,
      messages: [{ content: "hi", role: "user" }],
      model,
    };
  }
  return {
    contents: [{ parts: [{ text: "hi" }], role: "user" }],
    generationConfig: { maxOutputTokens: 8 },
  };
};

/**
 * The session id a keyed probe sends: the client's shape
 * (`ses_<12 hex><14 base62>`) with its low twelve bits in the band the
 * gateway admits (`0xFC0..0xFFE`; the mock in `test/mock/opencode-gateway.ts`
 * enforces the same band), so a refusal cannot be the id's.
 */
export const PROBE_SESSION_ID = "ses_000000000ffeKeyedProbe0001";

/**
 * The identity headers the plugin's fetch patch sets on an OpenCode plane
 * (`src/fetch-patch.ts`): its user agent, the origin client, the project
 * (`global` outside a workspace), and the session id under both session
 * headers.
 *
 * One header a turn carries is left out on purpose: `x-opencode-request`, the
 * turn's message id. The gateway reads it only as a per-request metric
 * (`docs/engineering-notes.md`, §x-opencode-request), and its value is one
 * fresh id per request, so a constant here would match a turn no better than
 * its absence does. `test/keyed-probes.test.ts` names it as the one exclusion
 * when it compares this set with the wire.
 *
 * @param userAgent - the plugin's user agent.
 * @returns the headers, lower-cased.
 */
export const pluginIdentityHeaders = (
  userAgent: string
): Readonly<Record<string, string>> => ({
  "user-agent": userAgent,
  "x-opencode-client": "cli",
  "x-opencode-project": "global",
  "x-opencode-session": PROBE_SESSION_ID,
  "x-opencode-session-id": PROBE_SESSION_ID,
});

/**
 * The identity every keyed probe carries, defined once for the live suite and
 * the offline test alike: the user agent is `OPENCODE_UA`, the one the fetch
 * patch stamps on a turn — not `OPENCODE_PATCH_USER_AGENT`, which signs the
 * plugin's own requests (`/usage`). `test/keyed-probes.test.ts` sends a turn
 * through the real `patchFetch` and holds every header here to what it put on
 * the wire, so a change to this constant, or to the patch, fails offline.
 */
export const PROBE_IDENTITY: Readonly<Record<string, string>> =
  pluginIdentityHeaders(OPENCODE_UA);

/**
 * A keyless cell with the plugin's identity headers, the plane's key in the
 * header its protocol reads, and the keyed body. A model-less cell keeps no
 * body: it is never sent.
 *
 * @param cell - the keyless cell.
 * @param key - the plane's key.
 * @param identity - the identity headers: {@link PROBE_IDENTITY} unless a
 *   test needs another (the offline judge's session-less control passes `{}`).
 * @returns the keyed cell.
 */
export const keyedCell = (
  cell: MatrixCell,
  key: string,
  identity: Readonly<Record<string, string>> = PROBE_IDENTITY
): MatrixCell => ({
  ...cell,
  body:
    cell.model === undefined ? undefined : keyedBody(cell.protocol, cell.model),
  headers: {
    ...cell.headers,
    ...identity,
    ...credentialHeaders(cell.protocol, key),
  },
});

/** What a keyed probe answered. */
export type KeyedVerdict =
  | "account"
  | "auth-refused"
  | "model-gone"
  | "other"
  | "path-exists"
  | "path-gone"
  | "rate-limited"
  | "redirected"
  | "served"
  | "session-refused"
  | "upstream-busy"
  | "wrong-protocol";

/**
 * A 404 body that names a model rather than a path: the upstream shapes for
 * an unknown or retired model (Anthropic's `not_found_error` whose message is
 * `model: <id>`, OpenAI's `model_not_found`, Gemini's `models/<id> is not
 * found`). Keyless, the gateway refuses before it resolves a model, so a 404
 * is the path; keyed, it can forward the upstream's answer, so a 404 is read
 * by its body.
 *
 * Anthropic's bare `not_found_error` is NOT enough: it is the type of every
 * Anthropic 404, an unknown route included (`"message":"Not Found"`), so on
 * its own it would read a gone path as a retired model and lose the flip
 * evidence. Nor is the body compared with the id that was sent: the gateway
 * may forward a dated upstream id, and a genuinely retired model would then
 * read as a gone path.
 */
const MODEL_NOT_FOUND =
  /"message"\s*:\s*"model: |model_not_found|models\/[^\s"']+ is not found/iu;

/**
 * A 5xx that is the upstream provider being busy, not the gateway failing on
 * the path: a 503 or a 529 (Anthropic's `overloaded_error`), or any 5xx whose
 * body names an overload (`overloaded_error`, Gemini's `model is overloaded`
 * or `UNAVAILABLE`). A keyed request reaches the upstream, so this is routine
 * there and says the gateway routed the request. A 500, a 502 or an unnamed
 * 5xx stays `other`: protocol-routing reads a keyed 500 as "the shape does
 * not parse", and a gateway that crashes on a path must still fail.
 */
const isUpstreamBusy = (status: number, bodyText: string): boolean =>
  status === 503 ||
  status === 529 ||
  (status >= 500 &&
    /overloaded_error|model is overloaded|UNAVAILABLE/u.test(bodyText));

/**
 * Read one keyed answer.
 *
 * - `redirected` is a 3xx: the probe never follows one, so a moved path is
 *   not recorded as its target's answer.
 * - `path-gone` is a 404 whose body names no model; `model-gone` a 410, a 400
 *   "Model is unavailable", or a 404 whose body names a model
 *   (`MODEL_NOT_FOUND`).
 * - `rate-limited` is a 429, and `account` the account rather than the path:
 *   no funds, or a model the account may not use. Neither says anything about
 *   the shape.
 * - `session-refused` is the request's session refused (`MissingSessionID`, a
 *   `FreeTierError` on a paid model): the probe did not look like the plugin,
 *   so it measured nothing about the path.
 * - `auth-refused` is the plane's own key refused on that path, which on a
 *   default-family cell means the plugin's turns would be refused too — the
 *   probe carries the plugin's identity headers, so the two requests match.
 * - `wrong-protocol` is the path parsing the request and refusing the model's
 *   protocol there.
 * - `path-exists` is any other 400: the path parsed the request and refused
 *   its content.
 * - `upstream-busy` is the upstream provider overloaded (a 503, a 529, or a
 *   5xx naming an overload): the gateway routed the request, so like a rate
 *   limit it says nothing against the path. Any other 5xx is `other`.
 *
 * @param answer.status - the HTTP status.
 * @param answer.bodyText - the response body, as text.
 * @returns the verdict.
 */
export const classifyKeyedProbe = (answer: {
  readonly status: number;
  readonly bodyText: string;
}): KeyedVerdict => {
  const { bodyText, status } = answer;
  if (status >= 300 && status < 400) {
    return "redirected";
  }
  if (status === 404) {
    return MODEL_NOT_FOUND.test(bodyText) ? "model-gone" : "path-gone";
  }
  if (status === 410) {
    return "model-gone";
  }
  if (status === 429) {
    return "rate-limited";
  }
  if (
    status === 402 ||
    /Insufficient account funds|Model access is disabled/iu.test(bodyText)
  ) {
    return "account";
  }
  if (
    (status === 400 || status === 401 || status === 403) &&
    /MissingSessionID|missing x-opencode-session|FreeTierError/iu.test(bodyText)
  ) {
    return "session-refused";
  }
  if (status === 401 || status === 403) {
    return "auth-refused";
  }
  if (status === 400) {
    if (/ModelProtocolUnsupported/u.test(bodyText)) {
      return "wrong-protocol";
    }
    return /model is unavailable/iu.test(bodyText)
      ? "model-gone"
      : "path-exists";
  }
  if (status >= 200 && status < 300) {
    return "served";
  }
  return isUpstreamBusy(status, bodyText) ? "upstream-busy" : "other";
};

/**
 * One keyed probe's verdict from every attempt it made: the last answer read
 * by {@link classifyKeyedProbe}, except that a 429 followed by no answer —
 * the measured rate-limit hang — is `rate-limited`, not a transport error
 * (`verdictOfAttempts`).
 *
 * @param attempts - each attempt's answer, `undefined` for one that got none.
 * @returns the verdict.
 */
export const keyedVerdictOf = (
  attempts: readonly (ProbeAnswer | undefined)[]
): AttemptVerdict | KeyedVerdict =>
  verdictOfAttempts(attempts, classifyKeyedProbe);

/**
 * The verdicts that are the flip rule's evidence (`docs/redirect-planes.md`
 * §13): on a default-family cell, the path is gone, refuses the protocol, or
 * refuses the plane's own key. A red run on one of these is the evidence for
 * a later `fix:` that flips `AUTO_ENDPOINT_FAMILY`.
 */
export const FLIP_EVIDENCE: ReadonlySet<string> = new Set([
  "auth-refused",
  "path-gone",
  "wrong-protocol",
]);

/**
 * The verdicts that, on a cell the default family dispatches to, fail the
 * job: the flip evidence, and an answer that measured nothing a turn could
 * use — an unreadable status (`other`), a redirect, a refused session, no
 * answer on either attempt (`transport-error`), or no model to send
 * (`no-model`). Only {@link FLIP_EVIDENCE} is evidence for a flip.
 */
const BREAKS_DEFAULT: ReadonlySet<string> = new Set([
  ...FLIP_EVIDENCE,
  "no-model",
  "other",
  "redirected",
  "session-refused",
  "transport-error",
]);

/** Whether a verdict on a default-family cell fails the job. */
export const breaksDefault = (verdict: string): boolean =>
  BREAKS_DEFAULT.has(verdict);

/** What one plane's keyed probes decide. */
export type PlaneOutcome<R> =
  | {
      readonly kind: "fail";
      readonly broken: readonly R[];
      readonly reason: string;
    }
  | { readonly kind: "pass" }
  | { readonly kind: "skip"; readonly reason: string };

/**
 * What one plane's keyed probes decide, read from the cells the default
 * family dispatches to (`TODAY_DISPATCH`) and nothing else — the legacy and
 * root rows are recorded only, so they can neither fail nor pass a plane.
 *
 * - `fail` when a default cell's verdict {@link breaksDefault}; the reason
 *   says whether it is flip evidence.
 * - `skip` when no default cell was `served`: every answer was the account's,
 *   a rate limit, a busy upstream, a retired model or a parsed-but-refused
 *   body, so nothing
 *   showed that the plugin's turns are served. A skip, never a pass.
 * - `pass` otherwise: nothing broke, and at least one default cell served.
 *
 * @param rows - the plane's probes: each cell's key and verdict.
 * @returns the outcome.
 */
export const planeOutcome = <
  R extends { readonly cell: string; readonly verdict: string },
>(
  rows: readonly R[]
): PlaneOutcome<R> => {
  const defaults = rows.filter((row) => TODAY_DISPATCH.has(row.cell));
  if (defaults.length === 0) {
    return {
      broken: [],
      kind: "fail",
      reason: "no cell the default family dispatches to was probed",
    };
  }
  const broken = defaults.filter((row) => breaksDefault(row.verdict));
  if (broken.length > 0) {
    const evidence = broken.some((row) => FLIP_EVIDENCE.has(row.verdict));
    return {
      broken,
      kind: "fail",
      reason: evidence
        ? "a cell the default family dispatches to refused the plane's own key, the protocol or the path (flip evidence, docs/redirect-planes.md §13)"
        : "a cell the default family dispatches to gave no readable answer (not flip evidence)",
    };
  }
  if (!defaults.some((row) => row.verdict === "served")) {
    return {
      kind: "skip",
      reason: `no cell the default family dispatches to was served (${defaults
        .map((row) => row.verdict)
        .join(", ")}), so nothing about the paths was measured`,
    };
  }
  return { kind: "pass" };
};

/**
 * The start of a response body, safe to print: every occurrence of the key is
 * replaced before the slice, so an error that echoes it cannot leak it.
 */
export const excerpt = (bodyText: string, key: string): string =>
  (key.length === 0 ? bodyText : bodyText.split(key).join("<redacted>")).slice(
    0,
    200
  );
