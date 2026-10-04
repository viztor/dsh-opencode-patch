/**
 * `responses-routes.ts` — the dispatch decision for the gateway's Responses
 * plane, derived from the vendor's per-model SDK rather than a list of ids.
 */

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  findModelSpec,
  parseModelsDevCatalog,
  RESPONSES_ROUTE,
  RESPONSES_SDK,
  responsesRouteFor,
} from "../src/index.ts";

const MUSE = "muse-spark-1.3-contributor-free";

describe("responses-routes: the SDK mapping", () => {
  it("redirects a model that names the OpenAI SDK", () => {
    // models.dev names `provider.npm` only as an OVERRIDE of the provider's
    // default, so its presence is the signal. 32 of the 116 opencode models
    // carry it; the hand-written list this replaced named one.
    expect(responsesRouteFor("opencode", "gpt-5", RESPONSES_SDK)).toBe(
      RESPONSES_ROUTE
    );
    expect(responsesRouteFor("opencode", MUSE, RESPONSES_SDK)).toBe(
      RESPONSES_ROUTE
    );
  });

  it("leaves a model naming no SDK on its own route", () => {
    // 53 models carry no override and speak the provider default. Omitting the
    // SDK is how the catalog expresses that — absent, never a placeholder.
    expect(responsesRouteFor("opencode", "space-bunny-free")).toBeUndefined();
  });

  it("leaves an SDK it has no protocol for on its own route", () => {
    // supportedProtocols() is openai-completions, openai-responses and
    // anthropic-messages. There is no google route to dispatch to, so guessing
    // one would be worse than the honest failure.
    expect(
      responsesRouteFor("opencode", "gemini-3-pro", "@ai-sdk/google")
    ).toBeUndefined();
  });

  it("does not redirect the redirected call again", () => {
    // The redirected call re-enters the same hook with the target route already
    // set. Redirecting that would recurse until the stack ran out.
    expect(
      responsesRouteFor(RESPONSES_ROUTE, MUSE, RESPONSES_SDK)
    ).toBeUndefined();
  });

  it("ignores malformed options", () => {
    expect(responsesRouteFor(null, MUSE, RESPONSES_SDK)).toBeUndefined();
    expect(responsesRouteFor("opencode", null, RESPONSES_SDK)).toBeUndefined();
    expect(responsesRouteFor("opencode", MUSE, 42)).toBeUndefined();
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
