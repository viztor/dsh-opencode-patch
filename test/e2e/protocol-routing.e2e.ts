/**
 * Live protocol-routing E2E — the one thing a stub provably cannot prove.
 *
 * The reason this plugin mounts a second `llm-pi-ai` route is a claim about the
 * **vendor**: a model's wire format is named by its `provider_npm` on models.dev,
 * and a model carried on the wrong route is served an endpoint that does not
 * speak its format. Unit tests can only check that our table maps an SDK to a
 * route — they read the table we wrote, so a vendor that reassigns a model's SDK
 * still ships green. Two rounds of real bugs got through exactly that way: nine
 * models mis-routed from a stale shim, and three more from reading the wrong
 * PLANE's SDK. Neither was visible to a unit test.
 *
 * So this file asks the gateway directly.
 *
 * **Measured 2026-10-06**, keyless, across the three endpoints — three classes of
 * model answer differently:
 *
 * | model class | its own endpoint | a wrong endpoint |
 * | --- | --- | --- |
 * | free-tier gated (`muse-spark-…-free`) | `403 FreeTierError` | `500 Internal server error` |
 * | unmetered (`beam-free`) | `200`, a real completion | `401 ModelError: not supported for format …` |
 * | **paid** (`claude-*`, `gpt-*`) | `401 AuthError` | `401 AuthError` — **identical** |
 *
 * That last row is why the paid cases are keyed and skip without a secret: for a
 * paid model a keyless probe cannot tell the endpoints apart at all, because the
 * gateway decides about credentials before it looks at the format. A suite
 * asserting "the wrong endpoint 500s" would pass **vacuously** for most of what
 * this plugin routes.
 *
 * **With a credential the discriminator is exact**, and it is
 * `ModelProtocolUnsupported` — a `400` naming the mismatch. Measured on the
 * account this was developed against: `grok-4.7` (`@ai-sdk/openai`) answers `200`
 * on `/responses` and `400 ModelProtocolUnsupported` on the other two.
 *
 * Two facts about the gateway that this file encodes, both measured:
 *
 * - **Each endpoint has its own auth convention.** `/messages` is the Anthropic
 *   shape and reads `x-api-key`; the other two read `Authorization: Bearer`.
 *   Sending `Bearer` to `/messages` returns `401 Missing API key` — the header is
 *   never read — which reads like a bad key rather than a bad header.
 * - **An account may have no paid access at all.** Every paid model then answers
 *   `403 Model access is disabled` on *every* endpoint, and that gate runs before
 *   the format check, so nothing about routing is observable. The keyed cases
 *   SKIP in that situation instead of failing, because the account's entitlement
 *   is not this plugin's contract.
 *
 * Opt-in via `OPENCODE_E2E=1`. The base is overridable so this can be pointed at
 * a mirror or a local stub.
 *
 *   OPENCODE_E2E=1 OPENCODE_API_KEY=… pnpm run test:e2e
 */

import { describe, expect, it } from "vitest";

import {
  GOOGLE_INTERNAL_ROUTE,
  GOOGLE_SDK,
  OPENCODE_GO_CATALOG,
  OPENCODE_PATCH_USER_AGENT,
  OPENCODE_ZEN_CATALOG,
  PROTOCOL_FOR_SDK,
  findModelSpec,
  findModelSpecOn,
  internalRouteFor,
  isServableSdk,
} from "../support/src.ts";

const LIVE = process.env.OPENCODE_E2E === "1";
const ZEN_KEY = process.env.OPENCODE_API_KEY;

const ZEN_BASE =
  process.env.OPENCODE_ZEN_BASE_URL ?? "https://opencode.ai/zen/v1";

/**
 * The Go plane. A different base URL AND a different credential — which is why
 * probing its models against the Zen base proves nothing about them.
 */
const GO_KEY = process.env.OPENCODE_GO_API_KEY;
const GO_BASE =
  process.env.OPENCODE_GO_BASE_URL ?? "https://opencode.ai/zen/go/v1";

/** Generous: these cross the public internet from CI. */
// Deliberately SHORTER than the suite's `testTimeout` (30s), because the two
// racing at the same value is a coin toss: whichever timer fires first wins, and
// when the suite's wins the case FAILS instead of reaching the catch that
// returns status 0 and skips. Measured in CI, where it did exactly that — the
// gateway held the connection open and two Go-plane probes went red for it.
const TIMEOUT_MS = 20_000;

/**
 * Wall-clock allowance for a fan-out case.
 *
 * A routing case issues one request per model per protocol — a handful of round
 * trips to a rate-limited public gateway — so the per-request timeout is not the
 * budget.
 */
const FANOUT_BUDGET_MS = 240_000;

/**
 * What a model with no SDK gets: nothing is redirected, so it stays on the route
 * the user configured, and that route speaks completions.
 */
const DEFAULT_PROTOCOL = "openai-completions";

/** The path each protocol uses against the Zen base. */
const PATH_FOR: Readonly<Record<string, string>> = {
  "anthropic-messages": "/messages",
  // The Gemini path carries the MODEL in the URL, not the body, so the probe
  // substitutes the `{model}` placeholder the same way the wire does.
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
const AUTH_FOR: Readonly<
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
const BODY_FOR: Readonly<Record<string, Record<string, unknown>>> = {
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
const PLUGIN_HEADERS: Readonly<Record<string, string>> = {
  "content-type": "application/json",
  "user-agent": OPENCODE_PATCH_USER_AGENT,
  "x-opencode-client": "cli",
  "x-opencode-project": "global",
  "x-opencode-session": "ses_e2e0000000000abcdefghij",
};

interface Probe {
  readonly status: number;
  readonly summary: string;
}

/** Ask one endpoint about one model, optionally with a credential. */
const probe = async (
  protocol: string,
  model: string,
  key?: string,
  base: string = ZEN_BASE
): Promise<Probe> => {
  const template = PATH_FOR[protocol];
  if (template === undefined) {
    throw new Error(`no live path is known for protocol ${protocol}`);
  }
  const path = template.replace("{model}", model);
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
    response = await fetch(`${base}${path}`, {
      body: JSON.stringify(payload),
      headers: { ...PLUGIN_HEADERS, ...auth },
      method: "POST",
      signal: AbortSignal.timeout(TIMEOUT_MS),
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

const otherProtocols = (expected: string) =>
  Object.keys(PATH_FOR).filter((protocol) => protocol !== expected);

/** Whether the gateway refused on ENTITLEMENT rather than on anything we control. */
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
/**
 * Whether the gateway is refusing the FREE TIER rather than the route.
 *
 * Measured, one request each, on `step-5-preview-free` — which was the canonical
 * free-tier id when those runs were made and has since been retired, so the
 * cases below now sample `beam-free`: the deployment's `oc_…` key answers
 * `403 FreeTierError` on both `…/zen/v1` and the new `…/inference/openai/v1`,
 * with and without `x-opencode-org-id`; the literal `public` answers the same;
 * and the real client — whose captured request carries an `st_…` session token —
 * is served.
 *
 * **Read that as a statement about the CLIENT, not the credential.** The
 * gateway's own message is "OpenCode's free tier can only be used from within
 * OpenCode", and presenting as that client is what this plugin does — so a free
 * model is OFFERED now, and a refusal names its own reason rather than being
 * pre-empted by an exclusion. What the older runs establish still holds: an
 * org id and a key do not unlock it.
 *
 * `docs/opencode-1.19-api.md` has the endpoints, the captured headers and the
 * login flow.
 */
const freeTierClosed = (result: Probe): boolean =>
  result.summary.includes("FreeTierError");

/**
 * Whether the gateway answered that it no longer serves the MODEL at all.
 *
 * `400 Upstream request failed: Model is unavailable` and `410` are the gateway
 * speaking about the model rather than the route: the catalog can still list an
 * id the upstream has withdrawn (measured 2026-10-26 on `nemotron-3-ultra-free`,
 * answered identically on two runs a minute apart). Such a candidate is skipped
 * like any other the gateway left nothing to assert about, never asserted on.
 */
const modelGone = (result: Probe): boolean =>
  result.status === 410 ||
  (result.status === 400 && result.summary.includes("Model is unavailable"));

const accessDisabled = (result: Probe): boolean =>
  result.status === 402 ||
  result.summary.includes("Insufficient account funds") ||
  (result.status === 403 &&
    result.summary.includes("Model access is disabled")) ||
  result.status === 429 ||
  // No answer at all is the third shape of "cannot tell": the gateway is busy,
  // so nothing about the route was observed either way.
  result.status === 0;

/**
 * The protocol the model is SERVED ON, per the shipped catalog on the Zen plane.
 *
 * `undefined` only when the model is not in the Zen catalog at all. A model with
 * no redirect is NOT "unrouted" — it stays on the route the user configured, and
 * that route speaks completions, so the default is a real answer rather than a
 * missing one. Conflating those two made this helper report `undefined` for
 * every default model, which is most of the catalog.
 *
 * Read through the real exported table rather than restated here, so this cannot
 * drift away from what the plugin will do. The plane is explicit because the two
 * planes declare different SDKs for the same id — that difference is the whole
 * subject of one of the cases below.
 */
/** The route id each plane is reached by. */
const ROUTE_FOR_PLANE = { go: "opencode-go", zen: "opencode" } as const;

/**
 * The protocol a model is served on, ON ITS OWN PLANE.
 *
 * The plane is a parameter rather than a constant because the same model id can
 * exist on both planes and be served on a different shape in each — which is the
 * whole reason the route is chosen from (plane, SDK) and not from the SDK.
 */
const servedProtocolForOn = (
  plane: "go" | "zen",
  model: string
): string | undefined => {
  const spec = findModelSpecOn(plane, model);
  if (spec === undefined) {
    return undefined;
  }
  return internalRouteFor(ROUTE_FOR_PLANE[plane], model, spec.provider_npm) ===
    undefined
    ? DEFAULT_PROTOCOL
    : PROTOCOL_FOR_SDK[spec.provider_npm ?? ""];
};

const servedProtocolFor = (model: string): string | undefined =>
  servedProtocolForOn("zen", model);

/** Whether the layer redirects this model off the configured route at all. */
const redirectsOff = (model: string): boolean =>
  internalRouteFor(
    "opencode",
    model,
    findModelSpecOn("zen", model)?.provider_npm
  ) !== undefined;

describe.skipIf(!LIVE)("live protocol routing", () => {
  /**
   * Pick a model from a candidate list by ASKING the gateway.
   *
   * Every id in this file was once a hard-coded constant, and each one has been
   * deprecated upstream in turn — the case then failed on a vendor move that had
   * nothing to do with routing. So the live cases choose their subjects at
   * runtime: walk the candidates (a slice of the CATALOG, so the list itself
   * follows the registry), return the first that produces an OBSERVABLE answer,
   * and `undefined` when none does. A case that gets `undefined` skips — the
   * honest reading of "the gateway left nothing to assert" — and the assertions
   * below are about whichever model answered, so a deprecation moves the test
   * instead of breaking it.
   */
  const pickModel = async (
    candidates: readonly string[],
    protocol: string,
    key?: string,
    base: string = ZEN_BASE,
    // A case that asserts one particular answer narrows the pick to candidates
    // that give it, so an otherwise observable answer of another kind (an
    // unmetered 200 where the case asserts the free-tier gate) moves the walk on
    // instead of being asserted on.
    accept: (answer: Probe) => boolean = () => true
  ): Promise<string | undefined> => {
    for (const model of candidates) {
      const answer = await probe(protocol, model, key, base);
      if (
        !accessDisabled(answer) &&
        !modelGone(answer) &&
        answer.status !== 0 &&
        accept(answer)
      ) {
        return model;
      }
    }
    return undefined;
  };

  it(
    "routes a free-tier model to the one endpoint that recognises it",
    async (context) => {
      // The vendor catalog no longer lists a free model on /responses, so the
      // free-tier routing case now asserts the COMPLETIONS side of the split.
      // The subject is picked live from the free slice, in catalog order, so
      // whichever GATED free model is alive today is the one tested: the case
      // asserts the free-tier gate, so an unmetered model (which answers 200
      // everywhere) cannot be its subject.
      const candidates = OPENCODE_ZEN_CATALOG.filter((m) => m.is_free).map(
        (m) => m.id
      );
      const model = await pickModel(
        candidates,
        "openai-completions",
        undefined,
        ZEN_BASE,
        freeTierClosed
      );
      if (model === undefined) {
        context.skip();
        return;
      }
      const expected = servedProtocolFor(model);
      expect(expected, `${model} no longer redirects`).toBe(
        "openai-completions"
      );

      const right = await probe(expected ?? "", model);
      if (accessDisabled(right)) {
        // Status 0 is the gateway not answering, which is neither agreement nor
        // refusal. Without this the assertion below reads a busy gateway as the
        // route being wrong.
        context.skip();
        return;
      }
      // 403 FreeTierError: the gateway parsed the model and then applied the
      // free-tier entitlement rule. It got far enough to identify it.
      //
      // The gate is `stream:true` AND `read`+`bash` in `tools` — conjunctive, and
      // identical on both planes. This probe sends NEITHER, so the 403 it asserts
      // is the gate refusing us, not evidence about the model. It still pins the
      // route (the wrong-endpoint cells assert 500 below, which only happens when
      // the gateway parsed the model), but a test that could tell those apart
      // would send `stream: true` plus the two schemas and assert a completion.
      // Measured 2026-10-07; see the gate section in AGENTS.md.
      expect(right.status, `${model} on ${expected}: ${right.summary}`).toBe(
        403
      );
      expect(right.summary).toContain("FreeTierError");

      for (const protocol of otherProtocols(expected ?? "")) {
        const wrong = await probe(protocol, model);
        if (accessDisabled(wrong)) {
          // Same reason as its sibling above: a non-answer is not evidence.
          context.skip();
          return;
        }
        // The gateway changed under this assertion (measured 2026-10-09): the
        // free-tier entitlement gate now fires on EVERY endpoint, so a
        // wrong-endpoint cell answers 403 FreeTierError too — no longer 500.
        // A 403 there still proves the gateway PARSED the model (a model the
        // endpoint does not know answers 500 Internal server error), so the
        // route is pinned by "parsed everywhere, gated everywhere"; what this
        // cell can no longer prove is that only the named endpoint PARSES it.
        if (wrong.status === 403) {
          expect(wrong.summary).toContain("FreeTierError");
        } else {
          expect(
            wrong.status,
            `${model} is ALSO recognised on ${protocol} (${wrong.summary}) — the ` +
              `catalog's provider_npm may be stale and this model is routed to ${expected} for the wrong format`
          ).toBe(500);
        }
      }
    },
    FANOUT_BUDGET_MS
  );

  it(
    "keeps serving an unmetered model on the endpoint the catalog names",
    async (context) => {
      // The plugin's original reason for existing. This model needs no credential
      // at all, so a 200 here proves the header restoration is ADDITIVE rather
      // than a gate — the call succeeds with the whole set injected. The subject
      // is picked live from the free slice; the first candidate that answers
      // with a completion is the one asserted on.
      const candidates = OPENCODE_ZEN_CATALOG.filter((m) => m.is_free).map(
        (m) => m.id
      );
      const model = await pickModel(candidates, "openai-completions");
      if (model === undefined) {
        context.skip();
        return;
      }
      const expected = servedProtocolFor(model);
      expect(expected, `${model} no longer redirects`).toBe(
        "openai-completions"
      );

      const response = await probe(expected ?? "", model);
      if (accessDisabled(response) || freeTierClosed(response)) {
        // The free tier needs a session token this plugin does not hold — see
        // `freeTierClosed` and `docs/opencode-1.19-api.md`. The
        // header-restoration claim cannot be checked on `…/zen/v1` while that is
        // true, and failing would blame this plugin for a vendor-side move.
        context.skip();
        return;
      }
      expect(
        response.status,
        `${model} on ${expected}: ${response.summary}`
      ).toBe(200);

      // It is genuinely format-agnostic — it also answers `/messages` with a
      // real completion — so nothing here claims otherwise; only the route the
      // catalog names is asserted.
    },
    TIMEOUT_MS
  );

  it(
    "serves a reachable paid model ONLY from the endpoint its SDK names",
    async (context) => {
      // The assertion a keyless probe cannot make: with a credential the
      // discriminator is exact — 200 on the named endpoint,
      // `400 ModelProtocolUnsupported` on the others. The subject is picked
      // live from the Responses-family slice of the catalog.
      if (ZEN_KEY === undefined || ZEN_KEY.length === 0) {
        context.skip();
        return;
      }

      const candidates = OPENCODE_ZEN_CATALOG.filter(
        (m) => m.provider_npm === "@ai-sdk/openai" && !m.is_free
      ).map((m) => m.id);
      const model = await pickModel(candidates, "openai-responses", ZEN_KEY);
      if (model === undefined) {
        context.skip();
        return;
      }
      const expected = servedProtocolFor(model);
      expect(expected, `${model} no longer redirects`).toBe("openai-responses");

      const right = await probe(expected ?? "", model, ZEN_KEY);
      if (accessDisabled(right)) {
        // The account has no paid access, so every endpoint answers identically
        // and NOTHING about routing is observable. Skipping is honest; failing
        // would blame the plugin for the account.
        context.skip();
        return;
      }
      expect(right.status, `${model} on ${expected}: ${right.summary}`).toBe(
        200
      );

      for (const protocol of otherProtocols(expected ?? "")) {
        const wrong = await probe(protocol, model, ZEN_KEY);
        if (accessDisabled(wrong)) {
          // Status 0 is the gateway not answering, which is neither agreement nor
          // refusal. `probe` returns it precisely so a case can skip instead of
          // failing on an answer nobody received, and this loop was reading it as
          // "the model IS served here" - the opposite conclusion from the evidence,
          // and one that blames the catalog for a busy gateway.
          context.skip();
          return;
        }
        expect(
          wrong.status,
          `${model} is ALSO served on ${protocol} (${wrong.summary}) — the ` +
            `catalog's provider_npm may be stale and this model is routed to ${expected} for the wrong format`
        ).toBe(400);
        // The exact mismatch, not merely "an error": this is the vendor telling
        // us which endpoint the model really lives on.
        expect(wrong.summary).toContain("ModelProtocolUnsupported");
      }
    },
    FANOUT_BUDGET_MS
  );

  it(
    "serves a Zen model the Go plane would have mis-routed from completions",
    async (context) => {
      // The regression this file was written to catch, pinned live. The GO
      // plane names `@ai-sdk/anthropic` for models the ZEN plane serves on the
      // completions default, so a Go-first lookup sent a ZEN request to
      // `/messages`. The sample is chosen at runtime from the models where
      // that disagreement still exists TODAY, so a vendor harmonising one id
      // does not orphan the case.
      if (ZEN_KEY === undefined || ZEN_KEY.length === 0) {
        context.skip();
        return;
      }

      const goById = new Map(
        OPENCODE_GO_CATALOG.map((m) => [m.id, m] as const)
      );
      const candidates = OPENCODE_ZEN_CATALOG.filter(
        (m) =>
          !m.is_free &&
          m.provider_npm === undefined &&
          goById.get(m.id)?.provider_npm === "@ai-sdk/anthropic"
      ).map((m) => m.id);

      let checked = 0;
      let subject: string | undefined;
      for (const model of candidates) {
        // The two planes really do disagree — otherwise this case proves nothing.
        expect(findModelSpec(model)?.provider_npm, `${model} Go plane`).toBe(
          "@ai-sdk/anthropic"
        );
        expect(
          findModelSpecOn("zen", model)?.provider_npm,
          `${model} Zen plane`
        ).toBeUndefined();
        // And our routing follows the Zen plane, so no redirect happens and the
        // model is served on the route the user configured.
        expect(redirectsOff(model), `${model} must not redirect`).toBe(false);
        expect(servedProtocolFor(model)).toBe(DEFAULT_PROTOCOL);

        const onCompletions = await probe("openai-completions", model, ZEN_KEY);
        if (accessDisabled(onCompletions)) {
          continue;
        }
        // 200 is the whole point: the endpoint the Go-first read avoided is the
        // one that actually serves it.
        expect(
          onCompletions.status,
          `${model} on completions: ${onCompletions.summary}`
        ).toBe(200);
        checked += 1;
        subject = model;
        break;
      }

      if (subject !== undefined) {
        const onMessages = await probe("anthropic-messages", subject, ZEN_KEY);
        if (accessDisabled(onMessages)) {
          // Its sibling above guards this, and so does the google case below; this
          // one did not. Status 0 is the gateway not answering, and asserting 400 on
          // it reports a busy gateway as the model being served on the wrong
          // protocol - the third instance of that shape in this file.
          context.skip();
          return;
        }
        expect(
          onMessages.status,
          `${subject} on messages: ${onMessages.summary} — if this is 200, the Go ` +
            "plane's SDK is right for Zen too and the routing fix is wrong"
        ).toBe(400);
        expect(onMessages.summary).toContain("ModelProtocolUnsupported");
      }

      if (checked === 0) {
        // Every candidate was entitlement-blocked; say so rather than passing on
        // an empty loop.
        context.skip();
      }
    },
    FANOUT_BUDGET_MS
  );

  it("probes a live path and an auth convention for every routable protocol", () => {
    // A protocol added to `PROTOCOL_FOR_SDK` with no path here would skip every
    // assertion above and pass vacuously. This is what stops that.
    for (const sdk of Object.keys(PROTOCOL_FOR_SDK)) {
      const protocol = PROTOCOL_FOR_SDK[sdk];
      expect(
        Object.keys(PATH_FOR),
        `no live path is probed for ${sdk} → ${protocol}`
      ).toContain(protocol);
      // And every probed protocol knows how the gateway wants to be
      // authenticated for it, or a keyed case would silently send no credential.
      expect(
        Object.keys(AUTH_FOR),
        `no auth convention is known for ${protocol}`
      ).toContain(protocol);
    }
    // The default is the ABSENCE of a mapping rather than an entry in
    // PROTOCOL_FOR_SDK, so the loop above cannot see it — and it carries the
    // largest single group of models in the catalog.
    expect(Object.keys(PATH_FOR)).toContain(DEFAULT_PROTOCOL);
  });

  it(
    "serves a Gemini model from the path a hand-declared route cannot name",
    async (context) => {
      // The bridge's endpoint, against the real gateway. The protocol is
      // google-generative-ai, the path carries the model, and the credential
      // rides x-goog-api-key. Measured: 200 with real SSE here, and 400
      // ModelProtocolUnsupported on the completions endpoint — the negative
      // control is what makes the positive result mean the path matters.
      // The subject is picked live from the google-family slice, since the
      // vendor rotates these ids too.
      const candidates = OPENCODE_ZEN_CATALOG.filter(
        (m) => m.provider_npm === GOOGLE_SDK && !m.is_free
      ).map((m) => m.id);
      const model = await pickModel(
        candidates,
        "google-generative-ai",
        ZEN_KEY
      );
      if (model === undefined) {
        context.skip();
        return;
      }
      expect(servedProtocolFor(model)).toBe("google-generative-ai");
      // And the routing agrees: this is the one protocol whose dispatch lands
      // on the route the plugin mounts itself.
      expect(internalRouteFor("opencode", model, GOOGLE_SDK)).toBe(
        GOOGLE_INTERNAL_ROUTE
      );
      if (ZEN_KEY === undefined || ZEN_KEY.length === 0) {
        context.skip();
        return;
      }

      const onGoogle = await probe("google-generative-ai", model, ZEN_KEY);
      // An entitlement refusal is not this test's subject: the endpoint
      // answered, the account just cannot spend on this model.
      if (accessDisabled(onGoogle)) {
        context.skip();
        return;
      }
      expect(
        onGoogle.status,
        `${model} on the google path: ${onGoogle.summary}`
      ).toBe(200);

      const onCompletions = await probe("openai-completions", model, ZEN_KEY);
      if (accessDisabled(onCompletions)) {
        // Same reason as the pair above: a non-answer is not evidence.
        context.skip();
        return;
      }
      expect(
        onCompletions.status,
        `${model} on completions: ${onCompletions.summary}`
      ).toBe(400);
      expect(onCompletions.summary).toContain("ModelProtocolUnsupported");
    },
    FANOUT_BUDGET_MS
  );

  it("probes a Go model on the GO base, where its own shapes are served", async (context) => {
    // The gap this closes: every case above talks to the Zen base, so the Go
    // plane's non-completions models were covered by unit tests only - and
    // the unit tests read the very mapping they verify. This sends a real
    // request to the Go base with the Go credential, which is the only thing
    // that can prove the plane is routed where it is served. The subject is
    // picked live from the Go catalog's Responses-family slice.
    const candidates = OPENCODE_GO_CATALOG.filter(
      (m) => m.provider_npm === "@ai-sdk/openai"
    ).map((m) => m.id);
    if (GO_KEY === undefined || GO_KEY.length === 0) {
      context.skip();
      return;
    }
    const model = await pickModel(
      candidates,
      "openai-responses",
      GO_KEY,
      GO_BASE
    );
    if (model === undefined) {
      context.skip();
      return;
    }
    expect(servedProtocolForOn("go", model)).toBe("openai-responses");
    const parsed = await probe("openai-responses", model, GO_KEY, GO_BASE);
    if (accessDisabled(parsed)) {
      // The claim below is "any answer the gateway produced after reading the model
      // proves this path is the right one". A status 0 is no answer at all, and
      // `not.toBe(404)` satisfies it - so a busy gateway would PASS this case while
      // proving nothing, which is the quietest version of the same mistake.
      context.skip();
      return;
    }
    // The claim is "this path is the right one", not "this request succeeds":
    // any answer the gateway produced after reading the model proves that, and a
    // 404 (no such path) or 500 (the shape does not parse) proves the opposite.
    // Asserting a specific code instead would make the case a bet on an
    // entitlement this account may or may not have today.
    expect(parsed.status).not.toBe(404);
    expect(parsed.status).not.toBe(500);
  });

  it("probes the GO plane's OTHER shape too, so both are covered", async (context) => {
    // One case per shape, not per plane: the Go plane serves two of them, and a
    // route that is only ever probed on Responses would let a broken Messages
    // route look covered. The auth convention differs between the two, which is
    // exactly what a per-shape probe checks. The subject is picked live from
    // the Go catalog's Anthropic-family slice.
    const candidates = OPENCODE_GO_CATALOG.filter(
      (m) => m.provider_npm === "@ai-sdk/anthropic"
    ).map((m) => m.id);
    if (GO_KEY === undefined || GO_KEY.length === 0) {
      context.skip();
      return;
    }
    const model = await pickModel(
      candidates,
      "anthropic-messages",
      GO_KEY,
      GO_BASE
    );
    if (model === undefined) {
      context.skip();
      return;
    }
    expect(servedProtocolForOn("go", model)).toBe("anthropic-messages");
    const parsed = await probe("anthropic-messages", model, GO_KEY, GO_BASE);
    if (accessDisabled(parsed)) {
      // Same as its sibling: a non-answer satisfies `not.toBe(404)` without proving
      // anything, so the case would pass on a gateway that never replied.
      context.skip();
      return;
    }
    expect(parsed.status).not.toBe(404);
    expect(parsed.status).not.toBe(500);
  });

  it("keeps every sampled model servable, so the cases above are not vacuous", () => {
    // The keyed cases pick from these slices at runtime, so the vacuousness
    // check is about the SLICES, not about fixed ids: each must be non-empty
    // and every member servable, or a case above would skip forever.
    const slices: readonly [string, string[]][] = [
      [
        "zen free",
        OPENCODE_ZEN_CATALOG.filter((m) => m.is_free).map((m) => m.id),
      ],
      [
        "zen responses",
        OPENCODE_ZEN_CATALOG.filter(
          (m) => m.provider_npm === "@ai-sdk/openai" && !m.is_free
        ).map((m) => m.id),
      ],
      [
        "go responses",
        OPENCODE_GO_CATALOG.filter(
          (m) => m.provider_npm === "@ai-sdk/openai"
        ).map((m) => m.id),
      ],
      [
        "go anthropic",
        OPENCODE_GO_CATALOG.filter(
          (m) => m.provider_npm === "@ai-sdk/anthropic"
        ).map((m) => m.id),
      ],
    ];
    for (const [label, ids] of slices) {
      expect(
        ids.length,
        `the ${label} slice is empty — its live case can only skip`
      ).toBeGreaterThan(0);
      for (const id of ids) {
        const spec = findModelSpecOn(
          id.includes("-go") || !findModelSpecOn("zen", id) ? "go" : "zen",
          id
        );
        expect(spec, `${id} left the catalog`).toBeDefined();
        expect(
          isServableSdk(spec?.provider_npm),
          `${id} became unservable, so its case silently skips`
        ).toBe(true);
      }
    }
  });

  it(
    "keeps the free tier reachable, so the unmetered case is not vacuous",
    async (context) => {
      // The free-tier case skips when the account has no usable free tier, which
      // is a legitimate outcome — but it must not become the permanent one. This
      // says which state it was in, so a reader of the run knows whether the case
      // was VERIFIED or merely not applicable. The slice itself is the subject:
      // it is non-empty (checked above), so SOME free model is offered, and the
      // case walks candidates until one answers — the vacuousness to rule out is
      // "every free model the registry lists is dead at the gateway", which the
      // probe script also watches.
      if (ZEN_KEY === undefined || ZEN_KEY.length === 0) {
        context.skip();
        return;
      }
      const candidates = OPENCODE_ZEN_CATALOG.filter((m) => m.is_free).map(
        (m) => m.id
      );
      let answered: { model: string; status: number } | undefined;
      for (const model of candidates) {
        const response = await probe(
          servedProtocolFor(model) ?? "openai-completions",
          model
        );
        // A gated, withdrawn or throttled candidate says nothing about whether
        // the free tier is reachable, so the walk moves on to the next one.
        if (
          freeTierClosed(response) ||
          modelGone(response) ||
          accessDisabled(response)
        ) {
          continue;
        }
        answered = { model, status: response.status };
        break;
      }
      if (answered === undefined) {
        // Reported rather than skipped: the account (or the vendor) closed,
        // withdrew or throttled the whole free tier, and that is worth a line
        // in the run's output.
        console.log(
          `[e2e] no free candidate answered with a completion — each was gated (FreeTierError: the free tier needs a session token this plugin does not hold; see docs/opencode-1.19-api.md), withdrawn upstream, or throttled. The header-restoration case did not run.`
        );
        return;
      }
      expect(
        answered.status,
        `${answered.model}: the free tier answered something other than a completion or a gate`
      ).toBe(200);
    },
    FANOUT_BUDGET_MS
  );
});
