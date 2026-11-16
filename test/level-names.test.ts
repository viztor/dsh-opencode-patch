/**
 * The level names' one table, inside its own file.
 *
 * `test/model-metadata.test.ts` pins that no OTHER file holds the level list
 * or its capitalisation; a per-file scan cannot see a second copy inside
 * `utils/model-metadata.ts` itself, which is where the one this phase removed
 * (`reasoningFor`'s `name: "Off"`) lived. This counts the literals in that
 * file's code: one capitalised level-name literal (`"Off"`) and one
 * capitalisation, both inside `effortName`.
 *
 * @module test/level-names.test
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { blankCommentLines } from "./support/strip-comments.ts";

const FILE = join(
  import.meta.dirname,
  "..",
  "src",
  "utils",
  "model-metadata.ts"
);

/** A capitalised level name written as a literal; `"On"` is not a level. */
const LEVEL_NAME = /"(?:Off|Minimal|Low|Medium|High|Xhigh|XHigh|Max)"/u;

/** The lines of `source` that hold `pattern`, as 0-based line numbers. */
const linesHolding = (source: string, pattern: RegExp): number[] =>
  source
    .split("\n")
    .flatMap((line, index) => (pattern.test(line) ? [index] : []));

/** The lines `effortName`'s definition spans, from its export to its `;`. */
const effortNameSpan = (source: string): readonly [number, number] => {
  const lines = source.split("\n");
  const start = lines.findIndex((line) =>
    line.startsWith("export const effortName")
  );
  const end = lines.findIndex(
    (line, index) => index >= start && line.trimEnd().endsWith(";")
  );
  return [start, end];
};

/** Every level-name literal outside `effortName`, as `pattern@line`. */
const strays = (source: string): string[] => {
  const [start, end] = effortNameSpan(source);
  return [LEVEL_NAME, /charAt\(0\)\.toUpperCase\(\)/u].flatMap((pattern) =>
    linesHolding(source, pattern)
      .filter((line) => line < start || line > end)
      .map((line) => `${pattern.source}@${line + 1}`)
  );
};

describe("level names · one table in model-metadata.ts", () => {
  it("holds one `Off` and one capitalisation, both inside effortName", () => {
    const source = blankCommentLines(readFileSync(FILE, "utf8"));
    // The scan read the file: effortName is found, and holds both.
    const [start, end] = effortNameSpan(source);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThanOrEqual(start);
    expect([...source.matchAll(new RegExp(LEVEL_NAME, "gu"))]).toHaveLength(1);
    expect([...source.matchAll(/"Off"/gu)]).toHaveLength(1);
    expect([...source.matchAll(/charAt\(0\)\.toUpperCase\(\)/gu)]).toHaveLength(
      1
    );
    expect(strays(source)).toEqual([]);
    // A second copy planted in the same file is seen, as `"Off"` and as any
    // other capitalised level.
    const planted = `${source}\nconst OFF = [{ id: "off", name: "Off" }];\n`;
    expect(strays(planted)).toEqual([
      `${LEVEL_NAME.source}@${planted.split("\n").length - 1}`,
    ]);
    const high = `${source}\nconst NAMES = [{ id: "high", name: "High" }];\n`;
    expect(strays(high)).toEqual([
      `${LEVEL_NAME.source}@${high.split("\n").length - 1}`,
    ]);
  });
});
