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

import { parsePurgeResult, parsePurgeReview } from "./support/src.ts";

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

  it("keeps a row's site when it is a string, and drops one that is not", () => {
    const result = parsePurgeResult({
      catalogRead: true,
      removed: [
        { id: "a", provider: "opencode", site: "summarizer" },
        { id: "b", provider: "opencode-go", site: 7 },
        { id: "c", provider: "opencode", site: "elsewhere" },
      ],
    });
    // The codec does not narrow `site` to the `PurgedSite` union today: a
    // string outside it is kept, as it was before the cast went.
    expect(result).toEqual({
      catalogRead: true,
      removed: [
        { id: "a", provider: "opencode", site: "summarizer" },
        { id: "b", provider: "opencode-go" },
        { id: "c", provider: "opencode", site: "elsewhere" },
      ],
    });
    expect(Object.hasOwn(result?.removed[1] ?? {}, "site")).toBe(false);
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

describe("purge contract · the review codec", () => {
  it("keeps only what the card renders", () => {
    expect(
      parsePurgeReview({
        catalogError: "e",
        more: 1,
        piRead: true,
        unserved: [{ extra: 1, id: "a", provider: "opencode", site: "x" }],
      })
    ).toEqual({
      catalogError: "e",
      piRead: true,
      unserved: [{ id: "a", provider: "opencode" }],
    });
    expect(
      parsePurgeReview({
        catalogError: "x".repeat(500),
        piRead: false,
        unserved: [],
      })?.catalogError
    ).toHaveLength(200);
    expect(
      parsePurgeReview({ catalogError: 7, piRead: false, unserved: [] })
    ).toEqual({ piRead: false, unserved: [] });
  });

  it("rejects anything that is not a review", () => {
    for (const value of [
      undefined,
      null,
      "review",
      { unserved: [] },
      { piRead: "yes", unserved: [] },
      { piRead: true, unserved: "nope" },
      { piRead: true, unserved: [{ provider: "opencode" }] },
      { piRead: true, unserved: [{ id: 1, provider: "opencode" }] },
    ]) {
      expect(parsePurgeReview(value), JSON.stringify(value)).toBeUndefined();
    }
  });
});
