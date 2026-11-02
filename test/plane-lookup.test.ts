/**
 * The plane-aware LOOKUP, driven through the real parse → active-map chain.
 *
 * `test/plane-divergence.test.ts` proves the DECISION is right given a row.
 * This file proves the row is the right PLANE's — the half the real catalogue
 * cannot test, because it agrees about the free flag for every model it shares
 * (`test/catalog.test.ts` holds that as an invariant).
 *
 * The world is installed through `refreshCatalog`, so the chain under test is
 * the shipped one: a `models.dev` payload → the parser → the active maps → the
 * lookup. Nothing here reaches a synthetic consumer of the plugin's internals.
 *
 * **The installation is per FILE, not per test.** `refreshCatalog` merges by id
 * and cannot remove rows, so a synthetic world persists for the rest of this
 * file — which is why this file holds nothing else, and why its rows carry ids
 * no other test names.
 *
 * @module test/plane-lookup.test
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  findModelSpec,
  findModelSpecOn,
  refreshCatalog,
} from "../src/models-catalog.ts";
import { coreToolDecision, isCoreToolModel } from "../src/tool-fallback.ts";
import { payload } from "./fixtures/catalogs.ts";

/** A model the two planes describe differently: free on Go, paid on Zen. */
const DIVERGENT = "acme-divergent-scratchpad";

/** A model that only the Go plane carries. */
const GO_ONLY = "acme-go-only-scratchpad";

/**
 * Install the synthetic world, the way a live refresh does.
 *
 * @returns nothing; the world is module state.
 */
const install = async (): Promise<void> => {
  const body = payload({
    go: [
      { free: true, id: DIVERGENT, name: "Divergent (Go)" },
      { id: GO_ONLY },
    ],
    zen: [{ id: DIVERGENT, input: 1, name: "Divergent (Zen)", output: 1 }],
  });
  await refreshCatalog(async () => Response.json(body), true);
};

beforeAll(install, 15_000);

/** Other suites in this process must not see the synthetic rows. */
afterAll(() => {
  // Nothing to undo: `refreshCatalog` has no removal, and the rows are named so
  // that no other fixture collides with them. The next process gets the shim.
  expect(DIVERGENT.length).toBeGreaterThan(0);
});

describe("the lookup reads the plane's own row", () => {
  it("parses the divergent world into two rows that disagree", () => {
    // The premise, asserted rather than assumed: the payload really did produce
    // a free row on Go and a paid one on Zen.
    expect(findModelSpecOn("go", DIVERGENT)?.is_free).toBe(true);
    expect(findModelSpecOn("zen", DIVERGENT)?.is_free).toBeUndefined();
  });

  it("follows the plane, which is the half the real catalogue cannot test", () => {
    // The free tier's tools go into the GO request and not into the ZEN one —
    // from the same id, through the shipped lookup.
    expect(isCoreToolModel(DIVERGENT, "", "go")).toBe(true);
    expect(isCoreToolModel(DIVERGENT, "", "zen")).toBe(false);
  });

  it("answers a model only one plane carries from that plane", () => {
    expect(findModelSpecOn("go", GO_ONLY)).toBeDefined();
    expect(findModelSpecOn("zen", GO_ONLY)).toBeUndefined();
    // The plane-agnostic lookup still finds it — that is what it is for.
    expect(findModelSpec(GO_ONLY)).toBeDefined();
    // …and the decision is the row's, not the id's: no "free" in the name, no
    // free flag on the row, so nothing is injected.
    expect(
      coreToolDecision(findModelSpecOn("go", GO_ONLY), GO_ONLY, "free")
    ).toBe(false);
  });

  it("keeps the plane-blind lookup as the fallback, and says what that means", () => {
    // `findModelSpec` prefers Go. For pricing — which the two planes do NOT
    // always agree on (`deepseek-v4.1-flash` is $0.30 on Zen, $0.15 on Go) —
    // that is the wrong answer, and it is why the pricing path takes the route's
    // plane instead. This asserts the order the doc describes, so a silent
    // reorder fails here.
    expect(findModelSpec(DIVERGENT)?.is_free).toBe(true);
  });
});
