/**
 * When a raw probe confirms the gateway withdrew a model.
 *
 * The live adapter blocks walk past a candidate only once {@link modelGone}
 * says so, so a shape it misses turns the vendor retiring a model into a red
 * live run (it did, for `ModelDeprecated`, on 2026-11-02).
 *
 * @module test/live-probe.test
 */
import { describe, expect, it } from "vitest";

import { modelGone } from "./support/live-probe.ts";

describe("a raw probe that says the model is gone", () => {
  it.each([
    [410, "410 ", true],
    [400, "400 Upstream request failed: Model is unavailable", true],
    [
      400,
      '400 {"type":"error","error":{"type":"ModelDeprecated","message":"Model gemini-3-flash has been deprecated."}}',
      true,
    ],
    [404, '404 {"error":{"type":"ModelDeprecated"}}', true],
    [400, "400 Invalid request: messages is required", false],
    [404, "404 Not Found", false],
    [401, "401 Invalid API key", false],
    [200, "200 ok", false],
  ] as const)("%i %j → %s", (status, summary, gone) => {
    expect(modelGone({ status, summary })).toBe(gone);
  });
});
