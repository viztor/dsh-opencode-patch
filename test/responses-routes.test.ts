/**
 * `responses-routes.ts` — the dispatch table for the gateway's Responses plane,
 * and the seam that keeps it agreeing with the route the plugin layer declares.
 */

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  RESPONSES_FORMAT_MODELS,
  RESPONSES_ROUTE,
  responsesRouteFor,
} from "../src/responses-routes.ts";

describe("responses-routes: dispatch table", () => {
  it("redirects a responses-format model off the completions route", () => {
    expect(
      responsesRouteFor("opencode", "muse-spark-1.3-contributor-free")
    ).toBe(RESPONSES_ROUTE);
  });

  it("does not redirect the redirected call again", () => {
    // The redirected call re-enters the same hook with the target route already
    // set. Redirecting that would recurse until the stack ran out.
    expect(
      responsesRouteFor(RESPONSES_ROUTE, "muse-spark-1.3-contributor-free")
    ).toBeUndefined();
  });

  it("leaves every other model on its own route", () => {
    expect(
      responsesRouteFor("opencode", "mimo-v2.6-flash-free")
    ).toBeUndefined();
    expect(responsesRouteFor("opencode", "space-bunny-free")).toBeUndefined();
    expect(responsesRouteFor("opencode-go", "kimi-k3")).toBeUndefined();
  });

  it("ignores malformed options", () => {
    expect(
      responsesRouteFor(null, "muse-spark-1.3-contributor-free")
    ).toBeUndefined();
    expect(responsesRouteFor("opencode", null)).toBeUndefined();
    expect(responsesRouteFor("opencode", 42)).toBeUndefined();
  });
});

describe("responses-routes: the claim seam", () => {
  it("redirects only to a route the plugin layer claims", () => {
    // The layer no longer DECLARES the route — a second `llm-pi-ai` row cannot
    // mount, because a second instance re-registers an authorization flow per
    // installed catalog provider id and `authorization.registerFlow` throws
    // DUPLICATE_FLOW. The route therefore lives on the row the user already
    // owns. What the layer must still do is CLAIM it: an unclaimed route gets
    // no session header, no origin headers and no key injection, so the
    // redirected call would 403 and look like a model problem.
    const layer = readFileSync(
      new URL("../cordis.patch.yml", import.meta.url),
      "utf8"
    );
    expect(layer).toContain(`- ${RESPONSES_ROUTE}`);
    for (const model of RESPONSES_FORMAT_MODELS) {
      expect(responsesRouteFor("opencode", model)).toBe(RESPONSES_ROUTE);
    }
    // The route's own model list lives in the user's profile and cannot be
    // checked from here. Keep it equal to RESPONSES_FORMAT_MODELS by hand:
    // a model the table redirects but the route does not list fails as an
    // opaque "model not found" a long way from this file.
  });
});
