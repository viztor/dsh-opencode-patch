/**
 * What the endpoint knob says it does, on every surface that says it.
 *
 * The schema description, the card's two locales and both READMEs described
 * `modern` as `/inference/v1` — a base the code never sends. `modern` (and
 * `auto`, which is the same table today) sends each protocol to its own
 * inference path: `/inference/{openai,anthropic,google}/…`, under
 * `/inference/go/…` on the Go plane. `legacy` is the older single base per
 * plane. Copy is the only place a user learns that, so it is pinned.
 *
 * @module test/endpoint-copy.test
 */
import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { Config } from "../src/config.ts";
import { en, zh } from "../src/settings-copy.ts";

/** The first line of a file that contains `marker`, or fail loudly. */
const lineOf = async (file: string, marker: string): Promise<string> => {
  const text = await readFile(new URL(file, import.meta.url), "utf8");
  const line = text.split("\n").find((l) => l.includes(marker));
  if (line === undefined) {
    throw new Error(`${file} has no line containing ${marker}`);
  }
  return line;
};

describe("endpoint copy", () => {
  it("the endpoint copy names the per-protocol inference family and calls auto an alias of modern", async () => {
    const schema = (
      Config as unknown as {
        dict: { endpoint: { meta: { description: unknown } } };
      }
    ).dict.endpoint.meta.description;
    expect(typeof schema).toBe("string");
    const d = String(schema);
    expect(d).not.toContain("inference/v1");
    expect(d).toContain("inference/{openai,anthropic,google}");
    expect(d).toContain("inference/go/{openai,anthropic,google}");
    expect(d).toMatch(/auto: an alias of modern/u);

    for (const copy of [en, zh]) {
      const card = copy.endpointModern + copy.endpointAuto + copy.endpointHint;
      expect(card).not.toContain("inference/v1");
      expect(card).toContain("inference/openai");
      // Legacy is one base per plane, and the Go plane's is not zen/v1.
      expect(copy.endpointHint).toContain("zen/go/v1");
    }
    expect(en.endpointAuto).toContain("same as Modern");
    expect(zh.endpointAuto).toContain("同新端点");

    const row = await lineOf("../README.md", "API Endpoint");
    expect(row).not.toContain("inference/v1");
    expect(row).toContain("inference/{openai,anthropic,google}");
    expect(row).toContain("same as Modern");
    const zhRow = await lineOf("../README.zh-CN.md", "API 端点");
    expect(zhRow).not.toContain("inference/v1");
    expect(zhRow).toContain("inference/{openai,anthropic,google}");
    expect(zhRow).toContain("同新端点");

    for (const [file, marker] of [
      ["../README.md", "**Which endpoint family.**"],
      ["../README.zh-CN.md", "**发往哪个端点家族。**"],
    ] as const) {
      const paragraph = await lineOf(file, marker);
      expect(paragraph, file).not.toContain("inference/v1");
      expect(paragraph, file).toContain("/inference/openai/v1");
    }
  });
});
