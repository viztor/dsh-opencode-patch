/**
 * The purge codec: a whitelist at the seam.
 *
 * The client renders what the host sends, so the parser must reject anything
 * that is not a purge result rather than passing a half-shape through — the same
 * rule every other codec on this seam follows.
 *
 * @module test/purge-contract.test
 */
import { describe, expect, it } from "vitest";

import { parsePurgeResult } from "./support/src.ts";

describe("purge contract · the result codec", () => {
  it("accepts a result and keeps only the fields the card renders", () => {
    expect(
      parsePurgeResult({
        catalogRead: true,
        removed: [{ extra: "dropped", id: "a", provider: "opencode" }],
      })
    ).toEqual({
      catalogRead: true,
      removed: [{ id: "a", provider: "opencode" }],
    });
  });

  it("accepts an empty result", () => {
    expect(parsePurgeResult({ catalogRead: false, removed: [] })).toEqual({
      catalogRead: false,
      removed: [],
    });
  });

  it("rejects anything that is not a purge result", () => {
    for (const value of [
      undefined,
      null,
      "a string",
      42,
      {},
      { removed: [] },
      { catalogRead: true },
      { catalogRead: "yes", removed: [] },
      { catalogRead: true, removed: "nope" },
      { catalogRead: true, removed: [null] },
      { catalogRead: true, removed: [{ id: "a" }] },
      { catalogRead: true, removed: [{ provider: "opencode" }] },
      { catalogRead: true, removed: [{ id: 1, provider: "opencode" }] },
    ]) {
      expect(parsePurgeResult(value), JSON.stringify(value)).toBeUndefined();
    }
  });
});
