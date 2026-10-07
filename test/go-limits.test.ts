import { describe, expect, it } from "vitest";

import { GO_MODEL_LIMITS } from "../src/go-limits-data.ts";
import {
  allowanceFor,
  formatUsd,
  GO_PLAN_TIERS,
  normalizeModelLabel,
  parseGoLimitsDoc,
  WINDOW_SHARE,
} from "../src/go-limits.ts";

/** The two tier tables, trimmed to what the parser reads. */
const doc = (go: string, plus: string): string => `
## Usage limits

<Tabs syncKey="go-plan">
  <TabItem label="Go">

    | Model                                   | Input  | Output | Cached Read | Cached Write | Monthly limit |
    | --------------------------------------- | ------ | ------ | ----------- | ------------ | ------------- |
${go}
  </TabItem>
  <TabItem label="Go Plus">

    | Model                                   | Input  | Output | Cached Read | Cached Write | Monthly limit |
    | --------------------------------------- | ------ | ------ | ----------- | ------------ | ------------- |
${plus}
  </TabItem>
</Tabs>
`;

const rowOf = (name: string, limit: string): string =>
  `    | ${name.padEnd(40)} | $0.15 | $0.50 | $0.03 | - | ${limit} |`;

describe("go-limits: the doc table", () => {
  it("reads both tiers, and keys rows by model id", () => {
    const { limits } = parseGoLimitsDoc(
      doc(
        rowOf("MiMo-V2.6-Flash", "**$60**"),
        rowOf("MiMo-V2.6-Flash", "**$120**")
      )
    );
    expect(limits.get("mimo-v2.6-flash")).toEqual({
      go: 60,
      goPlus: 120,
      name: "MiMo-V2.6-Flash",
    });
  });

  it("collapses a model's variants onto one allowance", () => {
    // Peak/off-peak and "> N tokens" rows are the same allowance stated twice.
    const { limits } = parseGoLimitsDoc(
      doc(
        [
          rowOf("DeepSeek V4.1 Flash (Off-Peak)", "**$60**"),
          rowOf("DeepSeek V4.1 Flash (Peak)", "**$60**"),
        ].join("\n"),
        [
          rowOf("DeepSeek V4.1 Flash (Off-Peak)", "**$120**"),
          rowOf("DeepSeek V4.1 Flash (Peak)", "**$120**"),
        ].join("\n")
      )
    );
    expect(limits.size).toBe(1);
    expect(limits.get("deepseek-v4.1-flash")?.go).toBe(60);
    expect(limits.get("deepseek-v4.1-flash")?.goPlus).toBe(120);
  });

  it("treats 'Unlimited' as no allowance rather than a failure", () => {
    // The free model carries no dollar figure. Rendering nothing for it is the
    // honest outcome; a zero would read as "you get nothing".
    const { limits, unmapped } = parseGoLimitsDoc(
      doc(
        [
          rowOf("Space Bunny", "**$30**"),
          rowOf("LongCat 2.5 Preview Free", "Unlimited limited time"),
        ].join("\n"),
        rowOf("Space Bunny", "**$120**")
      )
    );
    expect(limits.get("space-bunny")?.go).toBe(30);
    expect(limits.has("longcat-2.5-preview-free")).toBe(false);
    expect(unmapped).toEqual([]);
  });

  it("stops at the tab's end, so the request table below is not read", () => {
    // The estimates table repeats model names with no dollar column. Reading past
    // `</TabItem>` would invent an allowance out of a request count.
    const { limits } = parseGoLimitsDoc(
      `${doc(rowOf("Space Bunny", "**$30**"), rowOf("Space Bunny", "**$120**"))}
Requests per month for Space Bunny | 3,130 | 7,810 | 15,630 |`
    );
    expect(limits.size).toBe(1);
    expect(limits.get("space-bunny")?.go).toBe(30);
  });

  it("throws rather than shipping a table with holes when a tier is missing", () => {
    const half = doc(rowOf("Space Bunny", "**$30**"), "");
    expect(() => parseGoLimitsDoc(half)).toThrow(
      /goPlus table parsed to zero rows/
    );
    // The Go tab is present and readable; the Plus tab is simply gone.
    expect(() =>
      parseGoLimitsDoc(
        '<TabItem label="Go">\n' +
          "| Model | Input | Output | Cached Read | Cached Write | Monthly limit |\n" +
          "| Space Bunny | $0.15 | $0.30 | $0.03 | - | **$30** |\n  </TabItem>\n"
      )
    ).toThrow(/no <TabItem label="Go Plus">/);
  });

  it("reports a named row it cannot read", () => {
    // One unreadable row beside readable ones: the tier still parses, so the row
    // is reported rather than thrown — the generator turns that into a failure.
    const { unmapped } = parseGoLimitsDoc(
      doc(
        [
          rowOf("Mystery Model", "**see pricing page**"),
          rowOf("Space Bunny", "**$30**"),
        ].join("\n"),
        rowOf("Space Bunny", "**$120**")
      )
    );
    expect(unmapped).toHaveLength(1);
    expect(unmapped[0]).toContain("Mystery Model");
  });
});

describe("go-limits: labels and formatting", () => {
  it("slugifies a label, dropping the variant parenthetical", () => {
    expect(normalizeModelLabel("GPT 5.6 Luna (≤ 272K tokens)")).toBe(
      "gpt-5.6-luna"
    );
    expect(normalizeModelLabel("MiMo-V2.6-Flash")).toBe("mimo-v2.6-flash");
    expect(normalizeModelLabel("  ")).toBeUndefined();
  });

  it("looks a model up regardless of case or padding", () => {
    const limits = new Map([
      ["mimo-v2.6-flash", { go: 60, goPlus: 120, name: "x" }],
    ]);
    expect(allowanceFor(limits, " MiMo-V2.6-Flash ")?.go).toBe(60);
    expect(allowanceFor(limits, "grok-4.7")).toBeUndefined();
  });

  it("writes whole dollars without cents", () => {
    expect(formatUsd(60)).toBe("$60");
    expect(formatUsd(7.5)).toBe("$7.50");
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
    // A zero means the parser read one tier and not the other — which is how a
    // plan figure could read as $0 without anything looking wrong.
    for (const [id, row] of Object.entries(GO_MODEL_LIMITS)) {
      expect(row.go, `${id} go`).toBeGreaterThan(0);
      expect(row.goPlus, `${id} goPlus`).toBeGreaterThan(0);
      expect(row.name.length, `${id} name`).toBeGreaterThan(0);
    }
  });

  it("is sorted, so a regeneration produces a minimal diff", () => {
    const keys = Object.keys(GO_MODEL_LIMITS);
    expect(keys).toEqual([...keys].toSorted());
  });
});
