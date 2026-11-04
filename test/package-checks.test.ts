/**
 * The package's publish shape, checked against the files that define it.
 *
 * Two promises live in two files each, and nothing held them together:
 *
 * - `exports` names what a consumer may resolve, and `files` names what the
 *   tarball carries. An export whose target is not packed resolves in this
 *   repository and fails with ENOENT in every install (`./src/*` did exactly
 *   that: `src/` was never in `files`).
 * - `scripts/publish-scoped.ts` publishes a list of aliases, and the release
 *   workflow's verify step polls its own list. A name in one and not the other
 *   is either a publish nobody checks or a check that can never pass.
 *
 * The functions are pure (`scripts/package-checks.ts`), so the fixtures below
 * prove each one answers a case whose answer is known, and the real-tree cases
 * run the same functions `scripts/check.ts` runs.
 *
 * @module test/package-checks.test
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  coveredByFiles,
  exportsOutsideFiles,
  exportTargets,
  publishListMismatch,
  releasePendingTargets,
} from "../scripts/package-checks.ts";
import { SCOPED_TARGETS } from "../scripts/scoped-targets.ts";

const ROOT = join(import.meta.dirname, "..");

const readPackage = (): {
  name: string;
  exports?: unknown;
  files?: readonly string[];
} =>
  JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
    name: string;
    exports?: unknown;
    files?: readonly string[];
  };

describe("package checks · exports inside files", () => {
  it("flattens an exports map to its targets, conditions included", () => {
    expect(
      exportTargets({
        ".": { default: "./lib/index.mjs", types: "./lib/index.d.mts" },
        "./x": "./src/x.ts",
      })
    ).toEqual(["./lib/index.mjs", "./lib/index.d.mts", "./src/x.ts"]);
    expect(exportTargets("./lib/index.mjs")).toEqual(["./lib/index.mjs"]);
    expect(exportTargets(null)).toEqual([]);
  });

  it("knows what a files entry covers", () => {
    expect(coveredByFiles("./lib/index.mjs", ["lib"])).toBe(true);
    expect(coveredByFiles("./library.js", ["lib"])).toBe(false);
    expect(coveredByFiles("./package.json", [])).toBe(true);
    expect(coveredByFiles("./locale/en.json", ["locale/*.json"])).toBe(true);
    expect(coveredByFiles("./locale/*.json", ["locale/*.json"])).toBe(true);
    expect(coveredByFiles("./locale/nested/en.json", ["locale/*.json"])).toBe(
      false
    );
    expect(coveredByFiles("./src/*", ["lib"])).toBe(false);
  });

  it("exportsOutsideFiles names a target the files allowlist does not cover (fixture)", () => {
    expect(
      exportsOutsideFiles({
        exports: {
          ".": { import: "./lib/index.mjs", types: "./lib/index.d.mts" },
          "./x": "./src/x.ts",
        },
        files: ["lib"],
      })
    ).toEqual(["./src/x.ts"]);
    expect(
      exportsOutsideFiles({
        exports: {
          "./client": { default: "./lib/client.js" },
          "./cordis.patch.yml": "./cordis.patch.yml",
          "./locale/*.json": "./locale/*.json",
          "./locale/en.json": "./locale/en.json",
          "./package.json": "./package.json",
        },
        files: ["lib", "locale/*.json", "cordis.patch.yml"],
      })
    ).toEqual([]);
    expect(
      exportsOutsideFiles({ exports: { "./src/*": "./src/*" }, files: ["lib"] })
    ).toEqual(["./src/*"]);
  });

  it("every exports target of this package is inside files (real package.json)", () => {
    const pkg = readPackage();
    // Non-vacuous: the real map has targets to check.
    expect(exportTargets(pkg.exports).length).toBeGreaterThan(3);
    expect(exportsOutsideFiles(pkg)).toEqual([]);
  });
});

describe("package checks · the publish list and the verify list agree", () => {
  it("releasePendingTargets reads the verify line and reports its absence (fixture)", () => {
    expect(
      releasePendingTargets('          pending="a@$VER b@$VER"\n')
    ).toEqual(["a", "b"]);
    expect(releasePendingTargets("jobs:\n  verify:\n")).toBeUndefined();
    // Two lists are ambiguous: reading either one would leave the other
    // unchecked, so the reader refuses rather than picking the first.
    expect(
      releasePendingTargets(
        '          pending="x@$VER"\n          pending="a@$VER b@$VER"\n'
      )
    ).toBeUndefined();
    // The later unquoted reassignment in the real workflow is not a list.
    expect(
      releasePendingTargets(
        '          pending="a@$VER"\n          pending=$(echo "$still" | xargs)\n'
      )
    ).toEqual(["a"]);
    const mismatch = publishListMismatch(["p", "a"], ["p", "a", "b"]);
    expect(mismatch).toHaveLength(1);
    expect(mismatch[0]).toContain("b");
    expect(publishListMismatch(["p", "a", "c"], ["p", "a"])[0]).toContain("c");
    expect(publishListMismatch(["p", "a"], ["p", "a"])).toEqual([]);
  });

  it("the scoped publish list and release.yml's verify list agree, and neither names the retired wrapper", () => {
    const pkg = readPackage();
    const pending = releasePendingTargets(
      readFileSync(join(ROOT, ".github", "workflows", "release.yml"), "utf8")
    );
    expect(pending).toEqual([pkg.name, ...SCOPED_TARGETS]);
    expect(SCOPED_TARGETS).toEqual(["@viztor/dsh-opencode-patch"]);
    expect(pending).not.toContain("@viztor/dsh-opencode");
  });

  it("the gate and the publish script read those lists rather than keeping their own", () => {
    // Structural, because running either script from the suite would copy the
    // package per target (publish-scoped) or install it (check). The pure
    // helpers are exercised above; this pins that the scripts still use them.
    // Comment lines dropped line by line: a block-comment regex would eat
    // code between a glob such as `src/*` and the next `*/`.
    const code = (file: string): string =>
      readFileSync(join(ROOT, "scripts", file), "utf8")
        .split("\n")
        .filter((line) => !/^\s*(?:\/\/|\/\*|\*)/u.test(line))
        .join("\n");
    const publish = code("publish-scoped.ts");
    expect(publish).toMatch(
      /import \{[^}]*\bSCOPED_TARGETS\b[^}]*\} from "\.\/scoped-targets\.ts";/u
    );
    expect(
      [...publish.matchAll(/for \(const \w+ of (\w+)\)/gu)].map((m) => m[1])
    ).toContain("SCOPED_TARGETS");
    expect(publish).not.toContain('"@viztor/dsh-opencode"');
    const check = code("check.ts");
    expect(check).toMatch(/\bexportsOutsideFiles\(/u);
    expect(check).toMatch(/\bpublishListMismatch\(/u);
    expect(check).toMatch(/\breleasePendingTargets\(/u);
  });
});
