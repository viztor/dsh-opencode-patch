/**
 * The toolchain is Vite+, and its lint config is the one that runs.
 *
 * Moved from `scripts/check.ts`, where it ran once per gate: a lint block that
 * is never loaded lists every rule and enforces none, and a script that calls
 * a tool past `vp` skips the config `vp` reads. Both look healthy from the
 * outside, so each is asserted on what the toolchain actually answers, with a
 * fixture whose answer is known first.
 *
 * @module test/toolchain.test
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  scriptsBypassingVp,
  TOOLCHAIN_SCRIPTS,
} from "../scripts/package-checks.ts";

const ROOT = join(import.meta.dirname, "..");

const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
  devDependencies?: Record<string, string>;
  scripts: Record<string, string>;
};

describe("toolchain · Vite+", () => {
  it("the lint config is live: the vite.config.ts block is loaded, type-aware, with this package's own gates", () => {
    // `vp` itself, through the Node running the suite: no shell, no PATH.
    const run = spawnSync(
      process.execPath,
      [
        join(ROOT, "node_modules", "vite-plus", "bin", "vp"),
        "lint",
        "--print-config",
      ],
      { cwd: ROOT, encoding: "utf8" }
    );
    expect(run.status, run.stderr).toBe(0);
    const effective = JSON.parse(run.stdout.slice(run.stdout.indexOf("{"))) as {
      options?: { typeAware?: unknown; typeCheck?: unknown };
      rules?: Record<string, unknown>;
    };
    expect(Object.keys(effective.rules ?? {}).length).toBeGreaterThanOrEqual(
      300
    );
    expect(effective.options?.typeAware).toBe(true);
    // CI type-checks through `pnpm run check` (`vp check`), which runs the
    // type check only while this is on: off, no test file is type-checked in
    // CI, whatever tsconfig includes.
    expect(effective.options?.typeCheck).toBe(true);
    expect(effective.rules?.["typescript/no-floating-promises"]).toBeDefined();
  });

  it("every toolchain script goes through vp", () => {
    expect(pkg.devDependencies?.["vite-plus"]).toBeDefined();
    // The rule bites: a script that calls oxlint directly is named, and so is
    // one that is missing.
    expect(scriptsBypassingVp({ lint: "oxlint ." }, ["lint"])).toStrictEqual([
      "the lint script does not go through vp: oxlint .",
    ]);
    expect(
      scriptsBypassingVp({ test: "vp test && vitest run" }, ["test"])
    ).toHaveLength(1);
    expect(scriptsBypassingVp({}, ["build"])).toStrictEqual([
      "no build script",
    ]);
    // `tsc` is the one tool vp does not wrap, so a vp script may name it.
    expect(
      scriptsBypassingVp({ check: "vp check && tsc --noEmit" }, ["check"])
    ).toStrictEqual([]);
    expect(TOOLCHAIN_SCRIPTS).toStrictEqual([
      "build",
      "check",
      "format",
      "lint",
      "test",
    ]);
    expect(scriptsBypassingVp(pkg.scripts)).toStrictEqual([]);
  });
});
