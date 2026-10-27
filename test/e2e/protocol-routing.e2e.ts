/**
 * Live protocol-routing E2E — the one thing a stub provably cannot prove.
 *
 * The reason the plane adapter dispatches each model on its catalog protocol
 * (D16) is a claim about the **vendor**: a model's wire format is named by its
 * `provider_npm` on models.dev, and a model sent on the wrong protocol is
 * served an endpoint that does not speak its format. Unit tests can only check
 * that our table maps an SDK to a protocol — they read the table we wrote, so
 * a vendor that reassigns a model's SDK still ships green. Two rounds of real
 * bugs got through exactly that way: nine models mis-routed from a stale shim,
 * and three more from reading the wrong PLANE's SDK. Neither was visible to a
 * unit test.
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
 * **Every probe goes where the plugin sends.** The URL is the base the plane
 * adapter's own model object names (`planeModelFor`, D16) for the served
 * protocol, and the plane's base for the same protocol on the default family
 * for a negative control — the modern `/inference/…` family since P-R1, Go's
 * Google included. So a model that the gateway serves on the legacy `/zen`
 * family but refuses on the one the plugin dispatches to turns a case red.
 * Probing the legacy family per protocol is P-R2's record.
 *
 * **The last block sends through the plugin's own provider.** The probes above
 * write their bodies and headers by hand, which is what makes them an exact
 * oracle for the vendor; they are not the request a user's turn sends. So one
 * paid model per protocol per plane — Go's Gemini on `/inference/go/google/v1beta`
 * included — goes through the plane adapter on a tier-A host
 * (`test/support/host.ts`): pi's own protocol implementation, its credential
 * header, the session header and the fetch patch, against the live gateway.
 * Each protocol walks up to three paid candidates in catalog order and stops
 * at the first turn that says something about the wire: a turn refused on
 * entitlement moves on, and so does one answered that the vendor withdrew the
 * model (`410`, or `400` "Model is unavailable") once a raw probe of the same
 * id at the URL the plugin should use confirms it. If the raw probe does not,
 * the turn fails, because the gateway gives that answer for a misrouted id
 * too. Any other error finish fails; a protocol no candidate reached makes
 * the case skip with that protocol named, never pass on the others.
 *
 * Opt-in via `OPENCODE_E2E=1`. The base is overridable so this can be pointed at
 * a mirror or a local stub: an override is used for every protocol with the
 * legacy family's paths, as before.
 *
 *   OPENCODE_E2E=1 OPENCODE_API_KEY=… pnpm run test:e2e
 */

import { usesGoogleThinkingLevel } from "@earendil-works/pi-ai/api/google-shared";
import { describe, expect, it } from "vitest";

import {
  drainStream,
  fakeCredentials,
  mountTierA,
  waitForPlaneOwner,
} from "../support/host.ts";
import { isModelGoneMessage } from "../support/keyless-matrix.ts";
import {
  accessDisabled,
  AUTH_FOR,
  modelGone,
  PATH_FOR,
  PLUGIN_PATH_FOR,
  type Probe,
  sendProbe,
} from "../support/live-probe.ts";
import {
  candidatesByProtocol,
  type TurnVerdict,
  walkPerProtocol,
} from "../support/live-walk.ts";
import {
  baseUrlFor,
  GO_GOOGLE_BASE_URL,
  GOOGLE_SDK,
  OPENCODE_FAMILY_API,
  OPENCODE_GO_CATALOG,
  OPENCODE_ZEN_CATALOG,
  PROTOCOL_FOR_SDK,
  findModelSpec,
  findModelSpecOn,
  isServableSdk,
  planeModelFor,
  usesCatalogThinkingLevels,
} from "../support/src.ts";

const LIVE = process.env.OPENCODE_E2E === "1";
const ZEN_KEY = process.env.OPENCODE_API_KEY;

/**
 * The Go plane. A different base URL AND a different credential — which is why
 * probing its models against the Zen base proves nothing about them.
 */
const GO_KEY = process.env.OPENCODE_GO_API_KEY;

/** A base to probe instead of the plugin's own, per plane (a mirror or a stub). */
const BASE_OVERRIDE: Readonly<Record<"go" | "zen", string | undefined>> = {
  go: process.env.OPENCODE_GO_BASE_URL,
  zen: process.env.OPENCODE_ZEN_BASE_URL,
};

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

/** What a model with no SDK of its own is served on (D16). */
const DEFAULT_PROTOCOL = "openai-completions";

/**
 * The URL the plugin sends `protocol` for `model` to on `plane`: the base the
 * served model names when `protocol` is the one it is served on, else the
 * plane's base for `protocol` on the default family — or the override.
 */
const urlFor = (
  plane: "go" | "zen",
  protocol: string,
  model: string
): string => {
  const override = BASE_OVERRIDE[plane];
  const template =
    override === undefined ? PLUGIN_PATH_FOR[protocol] : PATH_FOR[protocol];
  if (template === undefined) {
    throw new Error(`no live path is known for protocol ${protocol}`);
  }
  const path = template.replace("{model}", model);
  if (override !== undefined) {
    return `${override}${path}`;
  }
  const served = servedOn(plane, model);
  const base =
    served?.api === protocol
      ? served.baseUrl
      : baseUrlFor(
          PLANE_ROUTE[plane].route,
          protocol as never,
          undefined,
          "modern",
          PLANE_ROUTE[plane].family
        );
  return `${base}${path}`;
};

/** Ask one endpoint about one model, optionally with a credential. */
const probe = async (
  protocol: string,
  model: string,
  key?: string,
  plane: "go" | "zen" = "zen"
): Promise<Probe> =>
  sendProbe({
    key,
    model,
    protocol,
    timeoutMs: TIMEOUT_MS,
    url: urlFor(plane, protocol, model),
  });

const otherProtocols = (expected: string) =>
  Object.keys(PATH_FOR).filter((protocol) => protocol !== expected);

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

/** The route id each plane is reached by, and its family map. */
const PLANE_ROUTE = {
  go: { family: OPENCODE_FAMILY_API.go, route: "opencode-go" },
  zen: { family: OPENCODE_FAMILY_API.zen, route: "opencode" },
} as const;

/**
 * The protocol and base a model is SERVED ON, ON ITS OWN PLANE: the model
 * object the plane adapter builds (`planeModelFor`, D16), read rather than
 * restated here, so this cannot drift away from what the plugin will do.
 *
 * `undefined` only when the model is not in that plane's catalog at all. A
 * model with no SDK of its own is served on completions, which is a real
 * answer rather than a missing one. The plane is a parameter because the same
 * id can exist on both planes and be served on a different shape in each.
 */
const servedOn = (
  plane: "go" | "zen",
  model: string
): { api: string; baseUrl: string } | undefined => {
  const spec = findModelSpecOn(plane, model);
  if (spec === undefined) {
    return undefined;
  }
  return planeModelFor({
    defaults: { contextWindow: 262_144, input: ["text"], maxTokens: 32_768 },
    endpoint: "modern",
    entry: { id: model },
    familyApi: PLANE_ROUTE[plane].family,
    route: PLANE_ROUTE[plane].route,
    spec,
  }).model;
};

const servedProtocolForOn = (
  plane: "go" | "zen",
  model: string
): string | undefined => servedOn(plane, model)?.api;

const servedProtocolFor = (model: string): string | undefined =>
  servedProtocolForOn("zen", model);

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
    plane: "go" | "zen" = "zen",
    // A case that asserts one particular answer narrows the pick to candidates
    // that give it, so an otherwise observable answer of another kind (an
    // unmetered 200 where the case asserts the free-tier gate) moves the walk on
    // instead of being asserted on.
    accept: (answer: Probe) => boolean = () => true
  ): Promise<string | undefined> => {
    for (const model of candidates) {
      const answer = await probe(protocol, model, key, plane);
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
        "zen",
        freeTierClosed
      );
      if (model === undefined) {
        context.skip();
        return;
      }
      const expected = servedProtocolFor(model);
      expect(
        expected,
        `${model} is no longer served on the expected protocol`
      ).toBe("openai-completions");

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
      expect(
        expected,
        `${model} is no longer served on the expected protocol`
      ).toBe("openai-completions");

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
      expect(
        expected,
        `${model} is no longer served on the expected protocol`
      ).toBe("openai-responses");

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
        // And our routing follows the Zen plane, so the model is served as
        // completions there, whatever Go's row says.
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
      // The URL probed below is the one the plane adapter sends to, Zen's own
      // Google base on the default family (D13); this pins it, so a family
      // change is a visible edit here rather than a silent retarget.
      expect(urlFor("zen", "google-generative-ai", model)).toBe(
        `https://opencode.ai/inference/google/v1beta/models/${model}:streamGenerateContent?alt=sse`
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
    // The gap this closes: every case above talks to the Zen plane, so the Go
    // plane's non-completions models were covered by unit tests only - and
    // the unit tests read the very mapping they verify. This sends a real
    // request to the URL the plane adapter uses for it
    // (`/inference/go/openai/v1/responses`) with the Go credential, which is
    // the only thing that can prove the plane is routed where it is served.
    // The subject is picked live from the Go catalog's Responses-family slice.
    const candidates = OPENCODE_GO_CATALOG.filter(
      (m) => m.provider_npm === "@ai-sdk/openai"
    ).map((m) => m.id);
    if (GO_KEY === undefined || GO_KEY.length === 0) {
      context.skip();
      return;
    }
    const model = await pickModel(candidates, "openai-responses", GO_KEY, "go");
    if (model === undefined) {
      context.skip();
      return;
    }
    expect(servedProtocolForOn("go", model)).toBe("openai-responses");
    expect(urlFor("go", "openai-responses", model)).toBe(
      "https://opencode.ai/inference/go/openai/v1/responses"
    );
    const parsed = await probe("openai-responses", model, GO_KEY, "go");
    if (accessDisabled(parsed)) {
      // The claim below is "any answer the gateway produced after reading the model
      // proves this path is the right one". A status 0 is no answer at all, and
      // `not.toBe(404)` satisfies it - so a busy gateway would PASS this case while
      // proving nothing, which is the quietest version of the same mistake.
      context.skip();
      return;
    }
    // The claim is "the plugin's path for this model is a right one", not
    // "this request succeeds": any answer the gateway produced after reading
    // the model proves that, and a 404 (no such path), a 500 (the shape does
    // not parse) or a 400 ModelProtocolUnsupported (served, but not in this
    // format) proves the opposite.
    // Asserting a specific code instead would make the case a bet on an
    // entitlement this account may or may not have today.
    expect(parsed.status).not.toBe(404);
    expect(parsed.status).not.toBe(500);
    expect(parsed.summary).not.toContain("ModelProtocolUnsupported");
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
      "go"
    );
    if (model === undefined) {
      context.skip();
      return;
    }
    expect(servedProtocolForOn("go", model)).toBe("anthropic-messages");
    expect(urlFor("go", "anthropic-messages", model)).toBe(
      "https://opencode.ai/inference/go/anthropic/v1/messages"
    );
    const parsed = await probe("anthropic-messages", model, GO_KEY, "go");
    if (accessDisabled(parsed)) {
      // Same as its sibling: a non-answer satisfies `not.toBe(404)` without proving
      // anything, so the case would pass on a gateway that never replied.
      context.skip();
      return;
    }
    expect(parsed.status).not.toBe(404);
    expect(parsed.status).not.toBe(500);
    expect(parsed.summary).not.toContain("ModelProtocolUnsupported");
  });

  it("probes a Go Gemini model on the Go Google base the plane adapter sends it to", async (context) => {
    // pi 1.1.0's own Go provider wires no Google protocol (F10); the plane
    // adapter does, on `/inference/go/google/v1beta` under every family. This
    // is the keyed half of that claim: the gateway reads the model there.
    const candidates = OPENCODE_GO_CATALOG.filter(
      (m) => m.provider_npm === GOOGLE_SDK
    ).map((m) => m.id);
    if (GO_KEY === undefined || GO_KEY.length === 0) {
      context.skip();
      return;
    }
    const model = await pickModel(
      candidates,
      "google-generative-ai",
      GO_KEY,
      "go"
    );
    if (model === undefined) {
      context.skip();
      return;
    }
    expect(servedProtocolForOn("go", model)).toBe("google-generative-ai");
    expect(servedOn("go", model)?.baseUrl).toBe(GO_GOOGLE_BASE_URL);
    const parsed = await probe("google-generative-ai", model, GO_KEY, "go");
    if (accessDisabled(parsed)) {
      context.skip();
      return;
    }
    expect(parsed.status).not.toBe(404);
    expect(parsed.status).not.toBe(500);
    expect(parsed.summary).not.toContain("ModelProtocolUnsupported");
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
      [
        "go google",
        OPENCODE_GO_CATALOG.filter((m) => m.provider_npm === GOOGLE_SDK).map(
          (m) => m.id
        ),
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

/** An answer about the account, not the wire: no paid access, no funds, rate limited. */
const ADAPTER_ENTITLEMENT =
  /\b40[23]\b|\b429\b|access is disabled|Insufficient account funds|FreeTierError/iu;

/** The plane routes the adapter block sends on, with the catalog and key each reads. */
const ADAPTER_PLANES = [
  {
    catalog: OPENCODE_ZEN_CATALOG,
    key: ZEN_KEY,
    ref: "OPENCODE_API_KEY",
    route: "opencode",
  },
  {
    catalog: OPENCODE_GO_CATALOG,
    key: GO_KEY,
    ref: "OPENCODE_GO_API_KEY",
    route: "opencode-go",
  },
] as const;

/**
 * The most paid candidates any one protocol declares in the adapter block.
 * Bounded so a plane of withdrawn models costs a few turns, not the catalog.
 */
const ADAPTER_CANDIDATES = 3;

/**
 * Wall-clock allowance for the adapter block: up to {@link ADAPTER_CANDIDATES}
 * turns per protocol, each possibly followed by a raw probe that confirms a
 * withdrawal, at {@link TIMEOUT_MS} apiece.
 */
const ADAPTER_BUDGET_MS = 4 * ADAPTER_CANDIDATES * 2 * TIMEOUT_MS + 60_000;

/** A paid row's protocol on its plane, or `undefined` for a row it cannot serve. */
const paidProtocolOf = (
  spec: (typeof OPENCODE_ZEN_CATALOG)[number]
): string | undefined => {
  if (spec.is_free === true || !isServableSdk(spec.provider_npm)) {
    return undefined;
  }
  return spec.provider_npm === undefined
    ? DEFAULT_PROTOCOL
    : (PROTOCOL_FOR_SDK[spec.provider_npm] ?? DEFAULT_PROTOCOL);
};

/** One adapter plane, as {@link ADAPTER_PLANES} lists it. */
type AdapterPlane = (typeof ADAPTER_PLANES)[number];

/**
 * One turn through the plane adapter, read the way the walk reads it: a
 * completion, an answer about the account, a confirmed withdrawal, or a
 * refusal that fails the case (a 400 INVALID_ARGUMENT thinking refusal among
 * them, the live D16 failure).
 */
const adapterVerdict = async (
  tier: Awaited<ReturnType<typeof mountTierA>>,
  plane: AdapterPlane,
  protocol: string,
  id: string,
  extra: Readonly<Record<string, unknown>> = {}
): Promise<TurnVerdict> => {
  const drained = await drainStream(tier.llm, plane.route, id, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
    ...extra,
  });
  if (
    drained.error === undefined &&
    drained.finish?.kind !== undefined &&
    drained.finish.kind !== "error"
  ) {
    return { kind: "ok" };
  }
  const message = drained.failureMessage ?? drained.error ?? "";
  if (ADAPTER_ENTITLEMENT.test(message)) {
    return { kind: "entitlement" };
  }
  if (isModelGoneMessage(message)) {
    // The gateway answers "Model is unavailable" for an id sent where it is
    // not served, too (upstream-findings §3.8). Ask the endpoint the plugin
    // should use, by hand, before reading it as the vendor's state.
    const planeName = plane.route === "opencode" ? "zen" : "go";
    const raw = await probe(protocol, id, plane.key, planeName);
    if (modelGone(raw)) {
      return { kind: "gone" };
    }
    if (accessDisabled(raw)) {
      return { kind: "entitlement" };
    }
    return {
      detail: `the turn says the model is gone (${message}), a raw probe of the same id answered ${raw.summary}`,
      kind: "refused",
    };
  }
  return { detail: message, kind: "refused" };
};

/** Google's discrete thinking levels, lowest first. */
const GOOGLE_LEVELS = ["minimal", "low", "medium", "high"] as const;

/** The highest level a catalog spec's first effort list offers. */
const highestLevelOf = (
  spec: (typeof OPENCODE_ZEN_CATALOG)[number]
): string | undefined => {
  const values =
    spec.reasoning_options?.find(
      (option) => option.type === "effort" && (option.values?.length ?? 0) > 0
    )?.values ?? [];
  return GOOGLE_LEVELS.findLast((level) => values.includes(level));
};

describe.skipIf(!LIVE)(
  "live protocol routing · through the plugin's plane adapter",
  () => {
    it.for(ADAPTER_PLANES)(
      "$route: one paid model per protocol completes a turn through the plane adapter",
      { timeout: ADAPTER_BUDGET_MS },
      async (plane, context) => {
        context.skip(
          plane.key === undefined || plane.key.length === 0,
          "no key for this plane"
        );
        // An override names somewhere the plugin does not send.
        context.skip(
          BASE_OVERRIDE[plane.route === "opencode" ? "zen" : "go"] !==
            undefined,
          "a base override is set: the adapter sends where the plugin sends"
        );
        const groups = new Map(
          [
            ...candidatesByProtocol(
              plane.catalog,
              paidProtocolOf,
              ADAPTER_CANDIDATES
            ),
          ].map(([protocol, specs]) => [protocol, specs.map((s) => s.id)])
        );
        // Anti-vacuity: each plane carries completions, Responses, Messages
        // and Google models.
        expect([...groups.keys()].toSorted()).toEqual([
          "anthropic-messages",
          "google-generative-ai",
          "openai-completions",
          "openai-responses",
        ]);
        const tier = await mountTierA({
          credentials: fakeCredentials({
            refs: { [plane.ref]: plane.key ?? "" },
          }),
          plugin: {},
          providers: {
            [plane.route]: {
              apiKeyEnv: plane.ref,
              models: [...groups.values()].flat().map((id) => ({ id })),
            },
          },
        });
        try {
          await waitForPlaneOwner(tier.llm, [plane.route]);
          const walk = await walkPerProtocol(groups, (protocol, id) =>
            adapterVerdict(tier, plane, protocol, id)
          );
          expect(walk.refused).toEqual([]);
          // A protocol no candidate reached was not tested: a skip that names
          // it, never a pass on the others.
          context.skip(
            walk.unreached.length > 0,
            `unreached (every candidate refused on entitlement or withdrawn): ${walk.unreached.join(", ")}`
          );
        } finally {
          await tier.dispose();
        }
      }
    );

    it.for(ADAPTER_PLANES)(
      "$route: a Google model the catalog describes by level completes a turn at its highest offered level (D16)",
      { timeout: ADAPTER_BUDGET_MS },
      async (plane, context) => {
        context.skip(
          plane.key === undefined || plane.key.length === 0,
          "no key for this plane"
        );
        context.skip(
          BASE_OVERRIDE[plane.route === "opencode" ? "zen" : "go"] !==
            undefined,
          "a base override is set: the adapter sends where the plugin sends"
        );
        // A level model pi's own pattern misses, so the turn exercises the
        // plugin's Google wrapper; once pi learns every such id the case
        // names that and skips, rather than re-testing pi's own path.
        const candidates = plane.catalog
          .filter(
            (spec) =>
              paidProtocolOf(spec) === "google-generative-ai" &&
              usesCatalogThinkingLevels(spec) &&
              !usesGoogleThinkingLevel({ id: spec.id } as never)
          )
          .slice(0, ADAPTER_CANDIDATES);
        context.skip(
          candidates.length === 0,
          "no paid Google model the catalog describes by level that pi's own pattern misses"
        );
        const tier = await mountTierA({
          credentials: fakeCredentials({
            refs: { [plane.ref]: plane.key ?? "" },
          }),
          plugin: {},
          providers: {
            [plane.route]: {
              apiKeyEnv: plane.ref,
              models: candidates.map((spec) => ({ id: spec.id })),
            },
          },
        });
        try {
          await waitForPlaneOwner(tier.llm, [plane.route]);
          const levelOf = new Map(
            candidates.map((spec) => [spec.id, highestLevelOf(spec)])
          );
          const walk = await walkPerProtocol(
            new Map([
              ["google-generative-ai", candidates.map((spec) => spec.id)],
            ]),
            (protocol, id) =>
              adapterVerdict(tier, plane, protocol, id, {
                reasoningEffort: levelOf.get(id),
              })
          );
          expect(walk.refused).toEqual([]);
          context.skip(
            walk.unreached.length > 0,
            `unreached (every candidate refused on entitlement or withdrawn): ${walk.unreached.join(", ")}`
          );
        } finally {
          await tier.dispose();
        }
      }
    );
  }
);
