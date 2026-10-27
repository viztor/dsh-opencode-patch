/**
 * Sending one raw request to the gateway, the way the live suites do.
 *
 * The live protocol-routing suite writes its probes by hand: a path, an auth
 * convention and a body per protocol, with the headers the plugin injects.
 * That is what makes a probe an exact oracle for the vendor, and it is also
 * what the live adapter blocks need to CONFIRM that the vendor withdrew a
 * model before they skip it: a turn through the plane adapter that answers
 * "Model is unavailable" says nothing on its own, because the gateway gives
 * the same answer for an id the plugin sent to the wrong place
 * (`docs/upstream-findings.md` §3.8). So the tables and the send live here,
 * shared by `test/e2e/protocol-routing.e2e.ts` and
 * `test/e2e/dispatch-levels.e2e.ts`.
 *
 * Network only when {@link sendProbe} is called; nothing here runs on import.
 *
 * @module test/support/live-probe
 */
import { OPENCODE_PATCH_USER_AGENT } from "./src.ts";

/**
 * The path each protocol uses against an OVERRIDDEN base, which is read as a
 * legacy-family base (`…/zen/v1`): one base for every protocol.
 */
export const PATH_FOR: Readonly<Record<string, string>> = {
  "anthropic-messages": "/messages",
  // The Gemini path carries the MODEL in the URL, not the body, so the probe
  // substitutes the `{model}` placeholder the same way the wire does.
  "google-generative-ai": "/models/{model}:streamGenerateContent?alt=sse",
  "openai-completions": "/chat/completions",
  "openai-responses": "/responses",
};

/**
 * The path each protocol appends to the base the plugin's model names: pi's
 * Anthropic client appends `/v1/messages` to a base without `/v1`, the others
 * append their own path to a base that carries its version.
 */
export const PLUGIN_PATH_FOR: Readonly<Record<string, string>> = {
  "anthropic-messages": "/v1/messages",
  "google-generative-ai": "/models/{model}:streamGenerateContent?alt=sse",
  "openai-completions": "/chat/completions",
  "openai-responses": "/responses",
};

/**
 * Each endpoint's OWN auth convention.
 *
 * `/messages` is the Anthropic Messages shape, which reads `x-api-key` and
 * ignores `Authorization`. Sending the Bearer form there answers
 * `401 Missing API key` — the header is simply not read — so a probe that used
 * one convention everywhere would conclude the model was unreachable.
 */
export const AUTH_FOR: Readonly<
  Record<string, (key: string) => Record<string, string>>
> = {
  "anthropic-messages": (key) => ({
    "anthropic-version": "2023-06-01",
    "x-api-key": key,
  }),
  "google-generative-ai": (key) => ({ "x-goog-api-key": key }),
  "openai-completions": (key) => ({ authorization: `Bearer ${key}` }),
  "openai-responses": (key) => ({ authorization: `Bearer ${key}` }),
};

/** A body shaped for the protocol, so the gateway judges the MODEL, not the JSON. */
export const BODY_FOR: Readonly<Record<string, Record<string, unknown>>> = {
  "anthropic-messages": {
    max_tokens: 1,
    messages: [{ content: "hi", role: "user" }],
  },
  // An empty `messages` array is itself a 400, which would make every
  // completions probe uninformative — the gateway would reject the body before
  // it ever looked at the model.
  "openai-completions": {
    max_tokens: 8,
    messages: [{ content: "hi", role: "user" }],
    stream: false,
  },
  "google-generative-ai": {
    // Measured: without `role` the upstream refuses with "Please use a valid
    // role: user, model" — the gateway forwards it, which is itself proof the
    // path and the x-goog-api-key convention are accepted.
    contents: [{ parts: [{ text: "hi" }], role: "user" }],
    generationConfig: { maxOutputTokens: 8 },
  },
  "openai-responses": { input: "hi", max_output_tokens: 16 },
};

/** Headers the plugin injects, so a probe looks like the traffic we actually send. */
export const PLUGIN_HEADERS: Readonly<Record<string, string>> = {
  "content-type": "application/json",
  "user-agent": OPENCODE_PATCH_USER_AGENT,
  "x-opencode-client": "cli",
  "x-opencode-project": "global",
  "x-opencode-session": "ses_e2e0000000000abcdefghij",
};

export interface Probe {
  readonly status: number;
  readonly summary: string;
}

/**
 * Send one protocol-shaped request to `url` and read the answer.
 *
 * The body is the protocol's own (`BODY_FOR`), with the model in the body
 * unless the protocol's path carries it; the credential header is the
 * protocol's own (`AUTH_FOR`), and no key sends none.
 *
 * @param input.url - the full URL, path included.
 * @param input.protocol - the protocol the body and the auth header follow.
 * @param input.model - the model id.
 * @param input.key - the credential, or `undefined` for a keyless probe.
 * @param input.timeoutMs - the request's own timeout.
 * @returns the status and a summary; status `0` when nothing answered.
 */
export const sendProbe = async (input: {
  readonly url: string;
  readonly protocol: string;
  readonly model: string;
  readonly key?: string | undefined;
  readonly timeoutMs: number;
}): Promise<Probe> => {
  const { key, model, protocol } = input;
  const template = PATH_FOR[protocol];
  if (template === undefined) {
    throw new Error(`no live path is known for protocol ${protocol}`);
  }
  // A protocol whose path carries the model does not also want it in the body:
  // the Gemini endpoints reject unknown fields rather than ignoring them.
  const payload = template.includes("{model}")
    ? BODY_FOR[protocol]
    : { ...BODY_FOR[protocol], model };
  const auth =
    key === undefined || key.length === 0
      ? {}
      : (AUTH_FOR[protocol]?.(key) ?? {});
  let response: Response;
  try {
    response = await fetch(input.url, {
      body: JSON.stringify(payload),
      headers: { ...PLUGIN_HEADERS, ...auth },
      method: "POST",
      signal: AbortSignal.timeout(input.timeoutMs),
    });
  } catch (error) {
    // Status 0 means "the gateway did not answer" — neither agreement nor
    // refusal. Measured while writing this: under rate limiting the gateway
    // answers 429 at first and then holds the connection open without a
    // response until the client gives up, so a timeout here is the gateway being
    // busy rather than this plugin being wrong. Reporting it as a status is what
    // lets the case SKIP instead of failing on an answer nobody received.
    return {
      status: 0,
      summary: `no answer: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
  const body = await response.text();
  return {
    status: response.status,
    summary: `${response.status} ${body.slice(0, 200)}`,
  };
};

/**
 * Whether the gateway answered that it no longer serves the MODEL at all.
 *
 * `400 Upstream request failed: Model is unavailable` and `410` are the gateway
 * speaking about the model rather than the route: the catalog can still list an
 * id the upstream has withdrawn (measured 2026-10-26 on `nemotron-3-ultra-free`,
 * answered identically on two runs a minute apart). Such a candidate is skipped
 * like any other the gateway left nothing to assert about, never asserted on.
 */
export const modelGone = (result: Probe): boolean =>
  result.status === 410 ||
  (result.status === 400 && result.summary.includes("Model is unavailable"));

/**
 * Whether the gateway's answer makes routing UNOBSERVABLE, so the case skips.
 *
 * Two shapes qualify, and both are the gateway speaking about the ACCOUNT
 * rather than about the route:
 *
 * - `403 Model access is disabled` — the account has no paid access, so every
 *   endpoint answers alike and nothing about routing can be seen.
 * - `429` — the account is rate limited. Measured while writing this: the
 *   gateway answers `429 Upstream request failed` on the first calls, and then
 *   HOLDS THE CONNECTION open without a response for a minute, which is what
 *   turned a routing case into a timeout rather than a skip. Every endpoint
 *   would answer alike here too, so the same reasoning applies.
 *
 * A skip is the honest answer in both: it says the routing was not verified,
 * which is not the same as saying it was verified and passed.
 */
export const accessDisabled = (result: Probe): boolean =>
  result.status === 402 ||
  result.summary.includes("Insufficient account funds") ||
  (result.status === 403 &&
    result.summary.includes("Model access is disabled")) ||
  result.status === 429 ||
  // No answer at all is the third shape of "cannot tell": the gateway is busy,
  // so nothing about the route was observed either way.
  result.status === 0;
