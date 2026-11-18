import { describe, expect, it } from "vitest";

import { readGoAllowances } from "../scripts/go-limits-endpoint.ts";

/** One model entry, as the endpoint carries it. */
const model = (
  id: string,
  usage?: Readonly<Record<string, number | string>>,
  name = id
): Record<string, unknown> => ({
  go: usage === undefined ? { training: false } : { monthly_usage: usage },
  id,
  name,
  object: "model",
});

/** The endpoint's list shape around the given entries. */
const payload = (...data: readonly unknown[]): unknown => ({
  data,
  object: "list",
});

describe("go-limits: the models endpoint", () => {
  it("reads both tiers off `monthly_usage`, and the endpoint's name", () => {
    const read = readGoAllowances(
      payload(
        model("grok-4.7", { go: 15, "go-plus": 60, "go-teams": 20 }, "Grok 4.7")
      )
    );
    expect(read.limits.get("grok-4.7")).toEqual({
      go: 15,
      goPlus: 60,
      name: "Grok 4.7",
    });
    expect(read.skipped).toEqual([]);
    expect(read.unmapped).toEqual([]);
  });

  it("skips a model with no monthly allowance — the free tier — and says so", () => {
    const read = readGoAllowances(
      payload(model("beam-free"), model("grok-4.7", { go: 15, "go-plus": 60 }))
    );
    expect([...read.limits.keys()]).toEqual(["grok-4.7"]);
    expect(read.skipped).toEqual(["beam-free"]);
    expect(read.unmapped).toEqual([]);
  });

  it("refuses a payload that is not the endpoint's list", () => {
    for (const wrong of [null, {}, { data: {} }, [], "nope"]) {
      expect(() => readGoAllowances(wrong), JSON.stringify(wrong)).toThrow(
        /models endpoint's list/u
      );
    }
  });

  it("refuses an entry it cannot read, with the model named", () => {
    const read = readGoAllowances(
      payload(
        "junk",
        { id: 7 },
        { name: "no id" },
        model("ok", { go: 1, "go-plus": 2 }),
        model("fixed-go", { "go-plus": 2 }),
        model("fixed-plus", { go: 1 }),
        model("textual", { go: "15", "go-plus": 60 })
      )
    );
    expect([...read.limits.keys()]).toEqual(["ok"]);
    expect(read.unmapped).toEqual([
      "entry 1 is not an object",
      "entry 2 has no id",
      "entry 3 has no id",
      "fixed-go: monthly_usage.go is not a number",
      'fixed-plus: monthly_usage["go-plus"] is not a number',
      "textual: monthly_usage.go is not a number",
    ]);
  });

  it("refuses a duplicate id rather than let a later row overwrite the first", () => {
    const read = readGoAllowances(
      payload(
        model("grok-4.7", { go: 15, "go-plus": 60 }),
        model("grok-4.7", { go: 1, "go-plus": 2 })
      )
    );
    expect(read.limits.get("grok-4.7")?.go).toBe(15);
    expect(read.unmapped).toEqual(["grok-4.7 appears twice"]);
  });

  it("falls back to the id when the endpoint carries no name", () => {
    const read = readGoAllowances(
      payload({ go: { monthly_usage: { go: 1, "go-plus": 2 } }, id: "x" })
    );
    expect(read.limits.get("x")?.name).toBe("x");
  });

  it("reads an empty list as no models, not as a failure", () => {
    const read = readGoAllowances(payload());
    expect(read.limits.size).toBe(0);
    expect(read.unmapped).toEqual([]);
  });
});
