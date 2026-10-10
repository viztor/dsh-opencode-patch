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
 * | unmetered (`space-bunny-free`) | `200`, a real completion | `401 ModelError: not supported for format …` |
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
  OPENCODE_PATCH_USER_AGENT,
  PROTOCOL_FOR_SDK,
  findModelSpec,
  findModelSpecOn,
  internalRouteFor,
  isServableSdk,
} from "../../src/index.ts";

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
const TIMEOUT_MS = 30_000;

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
  const response = await fetch(`${base}${path}`, {
    body: JSON.stringify(payload),
    headers: { ...PLUGIN_HEADERS, ...auth },
    method: "POST",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const body = await response.text();
  return {
    status: response.status,
    summary: `${response.status} ${body.slice(0, 200)}`,
  };
};

const otherProtocols = (expected: string) =>
  Object.keys(PATH_FOR).filter((protocol) => protocol !== expected);

/** Whether the gateway refused on ENTITLEMENT rather than on anything we control. */
const accessDisabled = (result: Probe): boolean =>
  result.status === 403 && result.summary.includes("Model access is disabled");

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
  it(
    "routes a free-tier model to the one endpoint that recognises it",
    async () => {
      const model = "muse-spark-1.3-contributor-free";
      const expected = servedProtocolFor(model);
      expect(expected, `${model} no longer redirects`).toBe("openai-responses");

      const right = await probe(expected ?? "", model);
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
    async () => {
      // The plugin's original reason for existing. This model needs no credential
      // at all, so a 200 here proves the header restoration is ADDITIVE rather
      // than a gate — the call succeeds with the whole set injected.
      const model = "space-bunny-free";
      const expected = servedProtocolFor(model);
      expect(expected, `${model} no longer redirects`).toBe(
        "openai-completions"
      );

      const response = await probe(expected ?? "", model);
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
      // The assertion a keyless probe cannot make. `grok-4.7` names
      // `@ai-sdk/openai`, so it belongs on `/responses` — and the gateway agrees
      // in both directions, which is what makes this a routing test rather than
      // a reachability test.
      if (ZEN_KEY === undefined || ZEN_KEY.length === 0) {
        context.skip();
        return;
      }

      const model = "grok-4.7";
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
      // The regression this file was written to catch, pinned live. models.dev's
      // `opencode-go` names `@ai-sdk/anthropic` for these while its `opencode`
      // names the completions default, so a Go-first lookup sent a ZEN request to
      // `/messages`. Measured: the gateway serves them on `/chat/completions` and
      // answers `400 ModelProtocolUnsupported` on `/messages`.
      if (ZEN_KEY === undefined || ZEN_KEY.length === 0) {
        context.skip();
        return;
      }

      let checked = 0;
      for (const model of ["qwen3.8-max", "minimax-m3"]) {
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

        const onMessages = await probe("anthropic-messages", model, ZEN_KEY);
        expect(
          onMessages.status,
          `${model} on messages: ${onMessages.summary} — if this is 200, the Go ` +
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
      const model = "gemini-3.8-flash";
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
    // plane's 13 non-completions models were covered by unit tests only - and
    // the unit tests read the very mapping they verify. This sends a real
    // request to the Go base with the Go credential, which is the only thing
    // that can prove the plane is routed where it is served.
    const model = "grok-4.7";
    expect(servedProtocolForOn("go", model)).toBe("openai-responses");
    if (GO_KEY === undefined || GO_KEY.length === 0) {
      context.skip();
      return;
    }
    const parsed = await probe("openai-responses", model, GO_KEY, GO_BASE);
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
    // exactly what a per-shape probe checks.
    const model = "minimax-m3";
    expect(servedProtocolForOn("go", model)).toBe("anthropic-messages");
    if (GO_KEY === undefined || GO_KEY.length === 0) {
      context.skip();
      return;
    }
    const parsed = await probe("anthropic-messages", model, GO_KEY, GO_BASE);
    expect(parsed.status).not.toBe(404);
    expect(parsed.status).not.toBe(500);
  });

  it("keeps every sampled model servable, so the cases above are not vacuous", () => {
    for (const model of [
      "grok-4.7",
      "qwen3.8-max",
      "muse-spark-1.3-contributor-free",
    ]) {
      const spec = findModelSpecOn("zen", model);
      expect(spec, `${model} left the Zen catalog`).toBeDefined();
      expect(
        isServableSdk(spec?.provider_npm),
        `${model} became unservable, so its case silently skips`
      ).toBe(true);
    }
  });
});
