import { describe, expect, it } from "vitest";

import {
  GO_MODEL_LIMITS,
  GO_PLAN_TIERS,
  WINDOW_SHARE,
  allowanceFor,
} from "./support/src.ts";

describe("go-limits: the allowance lookup", () => {
  it("looks a model up regardless of case or padding", () => {
    const limits = new Map([
      ["mimo-v2.6-flash", { go: 60, goPlus: 120, name: "x" }],
    ]);
    expect(allowanceFor(limits, " MiMo-V2.6-Flash ")?.go).toBe(60);
    expect(allowanceFor(limits, "grok-4.7")).toBeUndefined();
  });

  it("states the window shares the docs give, rather than inventing them", () => {
    expect(WINDOW_SHARE).toEqual({ monthly: 1, rolling: 0.2, weekly: 0.5 });
  });

  it("offers both tiers, and they differ", () => {
    // A table where the two tiers are equal would mean one of them was never read.
    expect(GO_PLAN_TIERS).toEqual(["go", "goPlus"]);
  });
});

describe("go-limits: the generated table", () => {
  it("covers the models the bundled Go catalog serves", () => {
    const catalogIds = [
      "mimo-v2.6-flash",
      "mimo-v2.6-pro",
      "grok-4.7",
      "deepseek-v4.1-flash",
      "kimi-k3",
    ];
    for (const id of catalogIds) {
      expect(GO_MODEL_LIMITS[id], `missing ${id}`).toBeDefined();
    }
  });

  it("has a positive allowance in both tiers for every model", () => {
    // A zero means one tier was read and not the other — which is how a plan
    // figure could read as $0 without anything looking wrong.
    // `NaN` is the third state and not a fourth kind of zero: it is a row the
    // source does not price, which the meter renders as no allowance rather
    // than as a figure. Asserting positivity for those would make the reader
    // invent one.
    let priced = 0;
    for (const [id, row] of Object.entries(GO_MODEL_LIMITS)) {
      const published = !Number.isNaN(row.go);
      expect(published, `${id} states one tier and not the other`).toBe(
        !Number.isNaN(row.goPlus)
      );
      if (published) {
        priced += 1;
        expect(row.go, `${id} go`).toBeGreaterThan(0);
        expect(row.goPlus, `${id} goPlus`).toBeGreaterThan(0);
      }
      expect(row.name.length, `${id} name`).toBeGreaterThan(0);
    }
    expect(priced, "nothing is priced at all").toBeGreaterThan(0);
  });

  it("is sorted, so a regeneration produces a minimal diff", () => {
    const keys = Object.keys(GO_MODEL_LIMITS);
    expect(keys).toEqual([...keys].toSorted());
  });
});
