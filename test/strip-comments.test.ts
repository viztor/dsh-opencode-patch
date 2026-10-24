/**
 * Known answers for the comment blanker the source-reading gates share.
 *
 * @module test/strip-comments.test
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { blankCommentLines } from "./support/strip-comments.ts";

describe("blankCommentLines", () => {
  it("blanks line comments and line-opening blocks, keeping the line count", () => {
    const source = [
      "/**",
      " * doc",
      " */",
      "const a = 1;",
      "  // note",
      "/* one */ const b = 2;",
      "const c = 3; // trailing stays",
    ].join("\n");
    expect(blankCommentLines(source).split("\n")).toEqual([
      "",
      "",
      "",
      "const a = 1;",
      "",
      " const b = 2;",
      "const c = 3; // trailing stays",
    ]);
  });

  it("opens no block at a `/*` inside a string, so the code after it stays", () => {
    const source = 'x("a/*b");\nimport "../src/x.ts";\n// c */\n';
    expect(blankCommentLines(source)).toBe(
      'x("a/*b");\nimport "../src/x.ts";\n\n'
    );
  });

  it("sees a widening between a `//` comment holding `/*` and a later block", () => {
    const source =
      '// internals live in src/* and stay there\nexport type * from "./config.ts";\n/** The host entry. */\n';
    expect(blankCommentLines(source)).toBe(
      '\nexport type * from "./config.ts";\n\n'
    );
  });

  it("carries a block reopened on a closing line on to the lines it spans", () => {
    expect(blankCommentLines("/* a */ /* b\nc\n*/\nd")).toBe("\n\n\nd");
    expect(blankCommentLines("/* a */ /*\n * process.env\n */\ncode();")).toBe(
      "\n\n\ncode();"
    );
  });

  it("reads a closing line's tail as code, a line comment, or a closed block", () => {
    expect(blankCommentLines("/* a */ // b\ncode();")).toBe("\ncode();");
    expect(blankCommentLines("/* a */ /* b */ code();")).toBe(" code();");
  });

  it("throws on a block that never closes, naming the line it opened on", () => {
    // A template-literal line that begins with `/*` and is never closed would
    // otherwise blank every line after it, the real import included.
    const source =
      'const s = `\n/* glob\nimport "../src/x.ts";\n`;\nimport "../src/y.ts";\n';
    expect(() => blankCommentLines(source)).toThrow(/line 2/u);
  });

  it("hides no code line of the test file that once lost seventy", () => {
    // test/package-checks.test.ts holds `"locale/*.json"` long before a `*/`
    // in a comment; the old whole-file regex blanked the code between them.
    const raw = readFileSync(
      join(import.meta.dirname, "package-checks.test.ts"),
      "utf8"
    );
    expect(raw).toContain("locale/*.json");
    const blanked = blankCommentLines(raw).split("\n");
    const hidden = raw
      .split("\n")
      .filter(
        (line, index) =>
          blanked[index] === "" &&
          line.trim() !== "" &&
          !/^\s*(?:\/\/|\/\*|\*)/u.test(line)
      );
    expect(hidden).toEqual([]);
  });
});
