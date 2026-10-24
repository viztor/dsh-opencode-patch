/**
 * `responses-routes.ts` — the dispatch decision for the gateway's Responses
 * plane, derived from the vendor's per-model SDK rather than a list of ids.
 */

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  ANTHROPIC_ROUTE,
  ANTHROPIC_SDK,
  GOOGLE_INTERNAL_ROUTE,
  GOOGLE_SDK,
  GO_RESPONSES_ROUTE,
  MISTRAL_SDK,
  OPENCODE_GO_CATALOG,
  OPENCODE_ZEN_CATALOG,
  RESPONSES_ROUTE,
  RESPONSES_SDK,
  ROUTE_FOR_PLANE_PROTOCOL,
  catalogPlaneForRoute,
  findModelSpec,
  findModelSpecOn,
  internalRouteFor,
  isServableModel,
  isServableSdk,
  parseModelsDevCatalog,
} from "./support/src.ts";

const MUSE = "muse-spark-1.2";

describe("responses-routes: the SDK mapping", () => {
  it("redirects a model that names the OpenAI SDK", () => {
    // models.dev names `provider.npm` only as an OVERRIDE of the provider's
    // default, so its presence is the signal. 32 of the 116 opencode models
    // carry it; the hand-written list this replaced named one.
    expect(internalRouteFor("opencode", "gpt-5", RESPONSES_SDK)).toBe(
      RESPONSES_ROUTE
    );
    expect(internalRouteFor("opencode", MUSE, RESPONSES_SDK)).toBe(
      RESPONSES_ROUTE
    );
  });

  it("routes a hand-listed model by the family its id names", () => {
    // A model the catalog has never heard of carries no SDK, and `undefined`
    // reads as the completions default - right for a model that omits its SDK,
    // wrong for one nobody has described, and indistinguishable here. Measured
    // against the live gateway: gemini-3.8-flash and claude-sonnet-4-6 both answer
    // 400 on the completions endpoint and 200 on their own.
    expect(internalRouteFor("opencode", "gemini-3.1-pro")).toBe(
      GOOGLE_INTERNAL_ROUTE
    );
    expect(internalRouteFor("opencode", "claude-opus-4-7")).toBe(
      ANTHROPIC_ROUTE
    );
    // A family the rule does not name keeps the route it was given: a wrong route
    // is worse than the one the deployment asked for.
    expect(internalRouteFor("opencode", "kimi-k2.5")).toBeUndefined();
    // And a catalog SDK still wins, because it is the better answer.
    expect(internalRouteFor("opencode", "claude-opus-4-7", RESPONSES_SDK)).toBe(
      RESPONSES_ROUTE
    );
    // muse-* and gpt-* models automatically route to Responses API even when no SDK is passed
    expect(internalRouteFor("opencode", "gpt-5.4")).toBe(RESPONSES_ROUTE);
    expect(internalRouteFor("opencode", "muse-spark-1.2")).toBe(
      RESPONSES_ROUTE
    );
    // A Go-only model (e.g. muse-spark-1.3-contributor) routes to the Go Responses route
    expect(internalRouteFor("opencode", "muse-spark-1.3-contributor")).toBe(
      GO_RESPONSES_ROUTE
    );
    expect(internalRouteFor("opencode-go", "muse-spark-1.3-contributor")).toBe(
      GO_RESPONSES_ROUTE
    );
  });

  it("redirects a model that names the Anthropic SDK too", () => {
    // 23 of the 116 opencode models name @ai-sdk/anthropic, and llm-pi-ai
    // implements anthropic-messages — so the same mechanism covers them. A
    // Responses-only table would have left all 23 on the completions route.
    expect(
      internalRouteFor("opencode", "claude-sonnet-4-5", ANTHROPIC_SDK)
    ).toBe(ANTHROPIC_ROUTE);
  });

  it("knows which SDKs it cannot serve", () => {
    // @ai-sdk/google names google-generative-ai: the wrapper's hand-declared
    // table refuses that protocol, so the plugin serves it through its own
    // adapter instead. Servable, because the bridge route exists.
    expect(isServableSdk()).toBe(true);
    expect(isServableSdk(RESPONSES_SDK)).toBe(true);
    expect(isServableSdk(ANTHROPIC_SDK)).toBe(true);
    expect(isServableSdk(GOOGLE_SDK)).toBe(true);
    // @ai-sdk/mistral is the decision, not the gap: the bridge pattern that
    // would serve it is built and measured for Google, but this dialect at
    // the gateway is unmeasured and no entitled key exists to measure it.
    expect(isServableSdk(MISTRAL_SDK)).toBe(false);
  });

  it("leaves a model naming no SDK on its own route", () => {
    // 53 models carry no override and speak the provider default. Omitting the
    // SDK is how the catalog expresses that — absent, never a placeholder.
    expect(internalRouteFor("opencode", "beam-free")).toBeUndefined();
  });

  it("redirects a Google model to the route the plugin mounts itself", () => {
    // The wrapper's table refuses google-generative-ai, so this dispatch
    // lands on the bridge route — the one route this plugin registers
    // through its own adapter rather than the wrapper's mount.
    expect(internalRouteFor("opencode", "gemini-3-pro", GOOGLE_SDK)).toBe(
      GOOGLE_INTERNAL_ROUTE
    );
    expect(
      internalRouteFor("opencode-go", "gemini-4-argon-contributor", GOOGLE_SDK)
    ).toBe("opencode-go-google");
  });

  it("leaves an SDK with no protocol anywhere on its own route", () => {
    // @ai-sdk/mistral names a protocol pi implements but this build does not
    // serve, so it is in neither PROTOCOL_FOR_SDK nor a route: the dispatch
    // declines rather than sending the model somewhere invented.
    expect(
      internalRouteFor("opencode", "mistral-large-4", MISTRAL_SDK)
    ).toBeUndefined();
  });

  it("does not redirect the redirected call again", () => {
    // The redirected call re-enters the same hook with the target route already
    // set. Redirecting that would recurse until the stack ran out.
    expect(
      internalRouteFor(RESPONSES_ROUTE, MUSE, RESPONSES_SDK)
    ).toBeUndefined();
  });

  it("ignores malformed options", () => {
    expect(internalRouteFor(null, MUSE, RESPONSES_SDK)).toBeUndefined();
    expect(internalRouteFor("opencode", null, RESPONSES_SDK)).toBeUndefined();
    expect(internalRouteFor("opencode", MUSE, 42)).toBeUndefined();
  });
});

describe("responses-routes: the catalog seam", () => {
  it("reads the SDK out of the live parse", () => {
    const parsed = parseModelsDevCatalog({
      opencode: {
        models: {
          overridden: { name: "A", provider: { npm: RESPONSES_SDK } },
          defaulted: { name: "B" },
        },
      },
    });
    const byId = new Map(parsed.zen.map((spec) => [spec.id, spec]));
    expect(byId.get("overridden")?.provider_npm).toBe(RESPONSES_SDK);
    // Absent must stay absent: undefined means "the route's own api".
    expect(byId.get("defaulted")?.provider_npm).toBeUndefined();
  });

  it("carries the SDK on the bundled shim, so a cold start still redirects", () => {
    // The shim answers before the first live refresh. If it lost this field, a
    // cold start would dispatch muse to the completions route and fail, with
    // nothing pointing at the cause.
    expect(findModelSpec(MUSE)?.provider_npm).toBe(RESPONSES_SDK);
  });

  it("redirects only to a route the plugin layer claims", () => {
    // An unclaimed route gets no session header, no origin headers and no key
    // injection, so the redirected call would 403 and look like a model problem.
    const layer = readFileSync(
      new URL("../cordis.patch.yml", import.meta.url),
      "utf8"
    );
    expect(layer).toContain(`- ${RESPONSES_ROUTE}`);
  });
});

describe("responses-routes: the SDK is read from the plane the request is on", () => {
  /**
   * The two planes declare DIFFERENT SDKs for the same model id, and reading the
   * wrong one is a mis-route rather than a detail.
   *
   * models.dev's `opencode-go` names `@ai-sdk/anthropic` for `qwen3.8-max`,
   * `minimax-m2.7` and `minimax-m3`; its `opencode` names nothing, i.e. the
   * completions default. A Go-first lookup answered a ZEN question with GO data
   * and sent all three to `/messages`. Measured 2026-10-06 against the live Zen
   * gateway: `qwen3.8-max` and `minimax-m3` answer `200` on
   * `/chat/completions` and `400 ModelProtocolUnsupported` on `/messages`.
   *
   * Nothing else in the suite could see this: every other routing case reads the
   * same table the code reads, so a wrong PLANE looks exactly like a right one.
   */
  // Derived, not listed. The ids this used to name were hard-coded, and the
  // vendor deprecated `minimax-m2.7` on the Go plane - which made the case below
  // fail on a model that was no longer there rather than on the property it was
  // written to check. A computed set cannot go stale the same way: it is the
  // models both planes currently carry, whose SDK the two planes disagree about.
  const go = new Map(OPENCODE_GO_CATALOG.map((s) => [s.id, s.provider_npm]));
  const zen = new Map(OPENCODE_ZEN_CATALOG.map((s) => [s.id, s.provider_npm]));
  const DIVERGENT = [...go.keys()].filter(
    (id) =>
      zen.has(id) && go.get(id) !== undefined && go.get(id) !== zen.get(id)
  );
  // And the anti-vacuity guard it was always meant to be: if the planes ever stop
  // disagreeing, the routing cases below stop proving anything.
  expect(
    DIVERGENT.length,
    "no model's SDK differs between the planes any more"
  ).toBeGreaterThan(0);

  it("has models whose SDK genuinely differs between the planes", () => {
    // If this ever stops being true the cases below stop proving anything, and
    // a silent skip would be worse than a failure.
    for (const id of DIVERGENT) {
      expect(go.get(id), `${id} is no longer on the Go plane`).toBe(
        ANTHROPIC_SDK
      );
      expect(zen.get(id), `${id} gained a Zen SDK`).toBeUndefined();
    }
  });

  it("routes each divergent model by the ZEN plane, not the Go one", () => {
    for (const id of DIVERGENT) {
      // The Go-first lookup — the bug — would have said "anthropic".
      expect(findModelSpec(id)?.provider_npm, "Go plane").toBe(ANTHROPIC_SDK);
      expect(
        findModelSpecOn("zen", id)?.provider_npm,
        "Zen plane"
      ).toBeUndefined();
      // And the routing decision follows the plane, so a Zen request stays on
      // the completions route where the gateway actually serves it.
      expect(
        internalRouteFor(
          "opencode",
          id,
          findModelSpecOn(catalogPlaneForRoute("opencode"), id)?.provider_npm
        )
      ).toBeUndefined();
    }
  });

  it("leaves a model the Zen plane really does split alone", () => {
    // The fix must not flatten the split it exists to respect: these name their
    // SDK on BOTH planes, and must still be redirected.
    for (const [id, route] of [
      ["grok-4.7", RESPONSES_ROUTE],
      ["claude-sonnet-4-5", ANTHROPIC_ROUTE],
    ] as const) {
      expect(findModelSpecOn("zen", id)?.provider_npm).toBeDefined();
      expect(
        internalRouteFor(
          "opencode",
          id,
          findModelSpecOn(catalogPlaneForRoute("opencode"), id)?.provider_npm
        )
      ).toBe(route);
    }
  });

  it("names the plane of each route the plugin knows", () => {
    expect(catalogPlaneForRoute("opencode-go")).toBe("go");
    expect(catalogPlaneForRoute("opencode")).toBe("zen");
    // The internal routes are derived from the Zen one, so they are Zen too.
    expect(catalogPlaneForRoute(RESPONSES_ROUTE)).toBe("zen");
    expect(catalogPlaneForRoute(ANTHROPIC_ROUTE)).toBe("zen");
    // An unknown route — and the absent case — is not silently treated as Go:
    // Go is the exception, so it has to be named to be meant.
    const absent: unknown = undefined;
    expect(catalogPlaneForRoute("my-relay")).toBe("zen");
    expect(catalogPlaneForRoute(absent)).toBe("zen");
  });
});

describe("responses-routes: every model the picker offers is dispatchable", () => {
  it("resolves each servable catalog model to a route the plugin mounts", () => {
    // The picker now publishes the whole catalog on the parent route (see
    // `models-discovery` and the join), which is the first time the Responses,
    // Messages and Google models have been visible there. Visibility without a
    // route would be worse than absence: the user picks a model and gets
    // "no adapter for provider".
    //
    // So: every model `isServableModel` admits must either stay on its own route
    // (`undefined`) or name a route this plugin actually mounts. The mount set is
    // the plane table plus the two plane roots — `opencode-google` is mounted by
    // the Google bridge rather than the wrapper, and is in the table for exactly
    // that reason.
    const mounted = new Set<string>(["opencode", "opencode-go"]);
    for (const plane of Object.values(ROUTE_FOR_PLANE_PROTOCOL)) {
      for (const route of Object.values(plane.routes)) {
        mounted.add(route);
      }
    }

    const unroutable: string[] = [];
    for (const [route, catalog] of [
      ["opencode", OPENCODE_ZEN_CATALOG],
      ["opencode-go", OPENCODE_GO_CATALOG],
    ] as const) {
      for (const model of catalog) {
        if (!isServableModel(model.id, route)) {
          continue;
        }
        const target = internalRouteFor(route, model.id, model.provider_npm);
        if (target !== undefined && !mounted.has(target)) {
          unroutable.push(`${route}/${model.id} -> ${target}`);
        }
      }
    }
    expect(unroutable).toEqual([]);
  });
});
