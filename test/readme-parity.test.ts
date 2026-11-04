/**
 * The two READMEs are one document in two languages, and the credential copy
 * says what the meter does.
 *
 * P-R1 corrected the English README twice (the Go plane's key, D20; the D1
 * `none` Off) and the Chinese one not at all, so a Chinese reader was still
 * told that a Zen key never reaches the Go quota endpoint, the claim the
 * tier-A meter case in `test/host-planes.test.ts` shows to be false for a Go
 * entry that names no reference. `docs/engineering-notes.md` records an
 * earlier drift of the same kind. This pins the parts that drifted: the
 * number of "Changed in 1.x" bullets, the retracted isolation claim, the Go
 * `apiKeyEnv` instruction, the install snippet's version range (which had
 * drifted to two different 0.x ranges, neither reaching a 1.x release), and
 * the `keySource` hint's order, which is
 * `KEY_SOURCE_ORDER.auto` in `src/go-discovery.ts` (literal, captured,
 * configured).
 *
 * @module test/readme-parity.test
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { en as enCopy, zh as zhCopy } from "./support/src.ts";

const ROOT = join(import.meta.dirname, "..");
const read = (file: string): string => readFileSync(join(ROOT, file), "utf8");

const READMES = [
  ["README.md", "## Changed in 1.x"],
  ["README.zh-CN.md", "## 1.x 变更"],
] as const;

/** The top-level bullets under `heading`, up to the next `## ` heading. */
const bulletsUnder = (text: string, heading: string): string[] => {
  const lines = text.split("\n");
  const start = lines.indexOf(heading);
  if (start === -1) throw new Error(`no ${heading}`);
  const out: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith("## ")) break;
    if (line.startsWith("- ")) out.push(line);
  }
  return out;
};

describe("README parity", () => {
  it("both READMEs announce the same number of 1.x changes", () => {
    const [enCount, zhCount] = READMES.map(
      ([file, heading]) => bulletsUnder(read(file), heading).length
    );
    // Non-vacuous: the section really is read.
    expect(enCount).toBeGreaterThan(5);
    expect(zhCount).toBe(enCount);
  });

  it("neither README claims a Zen key never reaches the Go quota endpoint", () => {
    const en = read("README.md");
    const zh = read("README.zh-CN.md");
    expect(en).not.toMatch(/strict credential isolation/iu);
    expect(zh).not.toContain("严格凭据隔离");
    // Both tell the reader to name the Go key on the Go entry: in step 3 and
    // in the breaking change.
    for (const [file, heading] of READMES) {
      const text = read(file);
      expect(
        text
          .split("\n")
          .filter((l) => l.includes("apiKeyEnv: OPENCODE_GO_API_KEY")).length,
        file
      ).toBeGreaterThanOrEqual(3);
      expect(
        bulletsUnder(text, heading).some(
          (b) => b.includes("OPENCODE_API_KEY") && b.includes("apiKeyEnv")
        ),
        file
      ).toBe(true);
    }
  });

  it("both install snippets pin one range, on package.json's major", () => {
    const ranges = READMES.map(([file]) => {
      const found = [
        ...read(file).matchAll(/"dsh-opencode-patch": "\^\d+\.\d+\.\d+"/gu),
      ];
      // Non-vacuous: each README carries exactly one snippet range.
      expect(found, file).toHaveLength(1);
      return found[0]?.[0];
    });
    expect(ranges[1]).toBe(ranges[0]);
    const pkg = JSON.parse(read("package.json")) as { version: string };
    const [major] = pkg.version.split(".");
    expect(ranges[0]).toContain(`"^${major}.`);
  });

  it("the keySource hint names auto's order: literal, captured, then declared", () => {
    const order = (hint: string, marks: readonly string[]): number[] =>
      marks.map((m) => {
        const at = hint.indexOf(m);
        expect(at, m).toBeGreaterThanOrEqual(0);
        return at;
      });
    const enAt = order(enCopy.keySourceHint, [
      "literal",
      "captured",
      "declared reference",
    ]);
    expect(enAt.toSorted((a, b) => a - b)).toEqual(enAt);
    const zhAt = order(zhCopy.keySourceHint, [
      "字面密钥",
      "捕获的密钥",
      "声明的引用",
    ]);
    expect(zhAt.toSorted((a, b) => a - b)).toEqual(zhAt);
  });
});
