/**
 * Free-tier contract: the gate needs read+bash, every route, every source.
 *
 * The gateway 403s a free-tier body that lacks `read` and `bash` in `tools`.
 * DSH sends inference as `fetch(new Request(url, { body }))`, so `init.body`
 * is undefined and the old `init?.body !== undefined` guard skipped injection
 * on exactly that path. This test pins all four body sources against every
 * catalog free model on both JSON routes: string init, Request input, absent
 * body (untouched), and non-JSON (untouched).
 *
 * @module test/free-tier-contract.test
 */

import { describe, expect, it } from "vitest";

import { maybeInjectCoreTools, OPENCODE_ZEN_CATALOG } from "./support/src.ts";
import { parseJsonBody, toolNamesOf } from "./test-helpers.ts";

const ROUTES = [
  "https://opencode.ai/zen/v1/chat/completions",
  "https://opencode.ai/zen/v1/responses",
];

const freeModelIds = (): string[] => {
  const ids = new Set<string>();
  for (const spec of OPENCODE_ZEN_CATALOG) {
    if (spec.is_free === true && typeof spec.id === "string") {
      ids.add(spec.id);
    }
  }
  return [...ids];
};

const headers = (): Headers =>
  new Headers({ "content-type": "application/json" });

const bodyFor = (model: string): string =>
  JSON.stringify({
    model,
    messages: [{ role: "user", content: "ping" }],
    stream: true,
  });

describe("free-tier contract", () => {
  const models = freeModelIds();
  it("covers at least one catalog free model", () => {
    expect(models.length).toBeGreaterThan(0);
  });
  for (const route of ROUTES) {
    for (const model of models) {
      it(`${route} :: ${model} :: string init gains read+bash`, () => {
        const out = maybeInjectCoreTools(route, bodyFor(model), headers(), {
          enabled: true,
          modelMarker: "free",
        });
        const names = toolNamesOf(parseJsonBody(out));
        expect(names).toContain("read");
        expect(names).toContain("bash");
      });
      it(`${route} :: ${model} :: Request-clone text gains read+bash`, async () => {
        const req = new Request(route, {
          method: "POST",
          body: bodyFor(model),
        });
        const text = await req.clone().text();
        const out = maybeInjectCoreTools(route, text, headers(), {
          enabled: true,
          modelMarker: "free",
        });
        const names = toolNamesOf(parseJsonBody(out));
        expect(names).toContain("read");
        expect(names).toContain("bash");
      });
      it(`${route} :: ${model} :: absent body untouched`, () => {
        expect(
          maybeInjectCoreTools(route, undefined, headers(), {
            enabled: true,
            modelMarker: "free",
          })
        ).toBeUndefined();
      });
      it(`${route} :: ${model} :: non-JSON untouched`, () => {
        expect(
          maybeInjectCoreTools(route, "not-json{{{", headers(), {
            enabled: true,
            modelMarker: "free",
          })
        ).toBe("not-json{{{");
      });
    }
  }
});
