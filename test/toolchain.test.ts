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
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  scriptsBypassingVp,
  scriptsToleratingWarnings,
  soleLintingArgs,
  TOOLCHAIN_SCRIPTS,
  WARNING_GATED_SCRIPTS,
  warningGatedScripts,
} from "../scripts/package-checks.ts";

const ROOT = join(import.meta.dirname, "..");

/**
 * `vp` itself, through the Node running the suite (no shell, no PATH), from
 * the repository root so it loads `vite.config.ts`. A synchronous spawn blocks
 * vitest's own timer, so each one carries its own limit: a hung `vp` is killed
 * and fails an assertion that shows its status, rather than stalling the
 * worker.
 */
const vp = (...args: string[]) =>
  spawnSync(
    process.execPath,
    [join(ROOT, "node_modules", "vite-plus", "bin", "vp"), ...args],
    { cwd: ROOT, encoding: "utf8", timeout: 60_000 }
  );

const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
  devDependencies?: Record<string, string>;
  scripts: Record<string, string>;
};

describe("toolchain · Vite+", () => {
  it("the lint config is live: the vite.config.ts block is loaded, type-aware, with this package's own gates", () => {
    const run = vp("lint", "--print-config");
    expect(run.status, run.stderr).toBe(0);
    const effective = JSON.parse(run.stdout.slice(run.stdout.indexOf("{"))) as {
      options?: {
        denyWarnings?: unknown;
        typeAware?: unknown;
        typeCheck?: unknown;
      };
      rules?: Record<string, unknown>;
    };
    expect(Object.keys(effective.rules ?? {}).length).toBeGreaterThanOrEqual(
      300
    );
    expect(effective.options?.typeAware).toBe(true);
    // CI type-checks through `pnpm run check` (`vp check --deny-warnings`),
    // which runs the type check only while this is on: off, no test file is
    // type-checked in CI, whatever tsconfig includes.
    expect(effective.options?.typeCheck).toBe(true);
    // The warning gate in the config, so a bare `vp check` / `vp lint` holds
    // it too (the next case performs it).
    expect(effective.options?.denyWarnings).toBe(true);
    expect(effective.rules?.["typescript/no-floating-promises"]).toBeDefined();
  });

  // Five `vp` spawns, about 3.5 s alone on four cores and more beside the
  // rest of the suite: past vitest's 5 s default under load, so the house
  // budget for a spawning case.
  it(
    "a lint warning fails `vp check` and `vp lint`, bare and through the scripts",
    {
      timeout: 30_000,
    },
    () => {
      // Fixtures outside the tree, linted under this tree's config: one clean,
      // one that trips a `warn`-tier rule (`require-await`) and nothing else.
      const dir = mkdtempSync(join(tmpdir(), "toolchain-warn-"));
      try {
        const clean = join(dir, "clean.ts");
        const warned = join(dir, "warned.ts");
        writeFileSync(clean, "export const planted = 1;\n");
        writeFileSync(
          warned,
          "export const planted = async (): Promise<number> => 1;\n"
        );
        // The known answer first: the clean fixture passes the full check
        // (format, lint and types), so a failure below is the lint's.
        const passing = vp("check", clean);
        expect(passing.status, passing.stdout + passing.stderr).toBe(0);
        // Bare `vp lint`, in the unix format: the one finding is a warning, not
        // an error, and the config's `denyWarnings` still fails the command.
        const linted = vp("lint", "--format", "unix", warned);
        expect(linted.stdout).toContain("[Warning/eslint(require-await)]");
        expect(linted.stdout).not.toContain("[Error/");
        expect(linted.status, "bare vp lint").not.toBe(0);
        // Bare `vp check` fails on the same warning.
        const checked = vp("check", warned);
        expect(checked.status, "bare vp check").not.toBe(0);
        expect(checked.stdout).toContain("require-await");
        // And with each gated script's own arguments: a script that is anything
        // but one `vp check` / `vp lint` followed by flags is named here rather
        // than having its other words passed to `vp`, which drops a stray word
        // when a path follows it and would pass a script that gates nothing.
        for (const name of WARNING_GATED_SCRIPTS) {
          const args = soleLintingArgs(pkg.scripts[name] ?? "");
          expect(
            args,
            `the ${name} script: ${pkg.scripts[name]}`
          ).toBeDefined();
          const scripted = vp(...(args ?? []), warned);
          expect(scripted.status, `the ${name} script`).not.toBe(0);
          expect(scripted.stdout, `the ${name} script`).toContain(
            "require-await"
          );
        }
      } finally {
        rmSync(dir, { force: true, recursive: true });
      }
    }
  );

  it("a gated script's own arguments are read only off a single `vp check` / `vp lint`", () => {
    expect(soleLintingArgs("vp check --deny-warnings")).toStrictEqual([
      "check",
      "--deny-warnings",
    ]);
    expect(soleLintingArgs(" vp lint --deny-warnings ")).toStrictEqual([
      "lint",
      "--deny-warnings",
    ]);
    // A compound script, a backgrounded one, a second line, a pipe, a
    // redirect, a positional argument, another vp command and another tool
    // are not one linting invocation. `vp` drops a stray word when a path
    // follows it, so each of these would otherwise reach the fixture run and
    // pass there.
    for (const script of [
      "vp check --deny-warnings && tsc --noEmit",
      "vp check --deny-warnings || true",
      "vp lint --deny-warnings; exit 0",
      "vp check --deny-warnings &",
      "vp check --deny-warnings\nexit 0",
      "vp lint --deny-warnings | tee lint.log",
      "vp lint --deny-warnings > lint.log",
      "vp lint --deny-warnings < /dev/null",
      "vp check --deny-warnings $(true)",
      "vp lint --deny-warnings src",
      "vp run check",
      "oxlint --deny-warnings",
      "",
    ]) {
      expect(soleLintingArgs(script), script).toBeUndefined();
    }
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

  it("every gated script passes --deny-warnings", () => {
    // The rule bites: a script without the flag is named, one ungated
    // invocation beside a gated one is still named, a missing script is
    // named, and so is a required script that no longer lints at all.
    expect(
      scriptsToleratingWarnings({ check: "vp check" }, ["check"])
    ).toStrictEqual(["the check script lets a lint warning pass: vp check"]);
    expect(
      scriptsToleratingWarnings(
        { check: "vp check --deny-warnings && vp lint" },
        ["check"]
      )
    ).toHaveLength(1);
    expect(scriptsToleratingWarnings({}, ["lint"])).toStrictEqual([
      "no lint script",
    ]);
    expect(
      scriptsToleratingWarnings({ check: "vp fmt --check && tsc --noEmit" }, [
        "check",
      ])
    ).toHaveLength(1);
    expect(
      scriptsToleratingWarnings(
        { check: "vp check --deny-warnings && tsc --noEmit" },
        ["check"]
      )
    ).toStrictEqual([]);
    // By default every script that lints is held, not only the two named
    // ones: a `release:gate` that calls `vp check` itself is named, one that
    // goes through `vp run check` is not, and `--fix` edits rather than gates.
    const manifest = {
      check: "vp check --deny-warnings",
      lint: "vp lint --deny-warnings",
      "lint:fix": "vp lint --fix",
      "release:gate": "vp run build && vp check",
    };
    expect(warningGatedScripts(manifest)).toStrictEqual([
      "check",
      "lint",
      "release:gate",
    ]);
    expect(scriptsToleratingWarnings(manifest)).toStrictEqual([
      "the release:gate script lets a lint warning pass: vp run build && vp check",
    ]);
    expect(
      scriptsToleratingWarnings({
        ...manifest,
        "release:gate": "vp run build && vp run check",
      })
    ).toStrictEqual([]);
    expect(WARNING_GATED_SCRIPTS).toStrictEqual(["check", "lint"]);
    expect(scriptsToleratingWarnings(pkg.scripts)).toStrictEqual([]);
    // The release reaches the gate through the `check` script.
    expect(pkg.scripts["release:gate"]).toMatch(/\bvp run check\b/u);
  });
});
