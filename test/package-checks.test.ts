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
 * prove each one answers a case whose answer is known before the real-tree
 * cases trust it. The manifest checks `scripts/check.ts` used to run (peer
 * ranges npm can read, the bundle fields, the harness surfaces, locale parity)
 * live here too; the gate keeps only what needs a build or a registry: the
 * freshness of `lib/` (`libFreshness`), the consumer install and the size
 * tripwire.
 *
 * @module test/package-checks.test
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { runInNewContext } from "node:vm";

import { describe, expect, it } from "vitest";

import {
  clientBundleProblems,
  coveredByFiles,
  exportsOutsideFiles,
  exportTargets,
  libFreshness,
  localeKeyPaths,
  peerRangeProblems,
  publishListMismatch,
  releasePendingTargets,
} from "../scripts/package-checks.ts";
import * as packageChecks from "../scripts/package-checks.ts";
import { SCOPED_TARGETS } from "../scripts/scoped-targets.ts";
import { en as cardCopy } from "./support/src.ts";

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

/**
 * A script's code with its comment lines dropped, line by line: a
 * block-comment regex would eat code between a glob such as `src/*` and the
 * next `*\/`.
 */
const scriptCode = (file: string): string =>
  readFileSync(join(ROOT, "scripts", file), "utf8")
    .split("\n")
    .filter((line) => !/^\s*(?:\/\/|\/\*|\*)/u.test(line))
    .join("\n");

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

  it("the scoped publish list and release.yml's verify list agree, deprecated alias included", () => {
    // **The deprecated alias is published, so it is verified.** A compatibility
    // name that stops publishing breaks the installs still on it, which is the
    // one thing it must not do — and a name that publishes without being
    // verified is how a release reports success while one of its three packages
    // sits behind.
    const pkg = readPackage();
    const pending = releasePendingTargets(
      readFileSync(join(ROOT, ".github", "workflows", "release.yml"), "utf8")
    );
    expect(pending).toEqual([pkg.name, ...SCOPED_TARGETS]);
    expect(SCOPED_TARGETS).toEqual([
      "@viztor/dsh-opencode-patch",
      "@viztor/dsh-opencode",
    ]);
    expect(pending).toContain("@viztor/dsh-opencode");
  });

  it("the publish script reads the list rather than keeping its own", () => {
    // Structural, because running the script from the suite would copy the
    // package per target. The pure helpers are exercised above, and the
    // real-tree cases here are the whole check: the gate (scripts/check.ts)
    // no longer repeats them.
    const publish = scriptCode("publish-scoped.ts");
    expect(publish).toMatch(
      /import \{[^}]*\bSCOPED_TARGETS\b[^}]*\} from "\.\/scoped-targets\.ts";/u
    );
    expect(
      [...publish.matchAll(/for \(const \w+ of (\w+)\)/gu)].map((m) => m[1])
    ).toContain("SCOPED_TARGETS");
    // The wrapper branch names the deprecated alias on purpose: it is the one
    // target whose manifest is rewritten rather than copied.
    expect(publish).toContain('"@viztor/dsh-opencode"');
  });
});

describe("package checks · lib/ is current", () => {
  it("libFreshness: one rule for a missing, half-built or stale lib", () => {
    expect(
      libFreshness({
        artifacts: { "client.js": 10, "index.mjs": 10 },
        hasClientCjs: false,
        newestSource: 5,
      })
    ).toBeUndefined();
    // The rename step skipped: vp pack left lib/client.cjs, not the served
    // lib/client.js, and the message names the step that makes it.
    const halfBuilt = libFreshness({
      artifacts: { "client.js": undefined, "index.mjs": 10 },
      hasClientCjs: true,
      newestSource: 5,
    });
    expect(halfBuilt).toContain("client.js");
    expect(halfBuilt).toContain("name-client-bundle.ts");
    expect(
      libFreshness({
        artifacts: { "client.js": 10, "index.mjs": 12 },
        hasClientCjs: false,
        newestSource: 11,
      })
    ).toContain("OLDER than src/");
    expect(
      libFreshness({
        artifacts: { "client.js": undefined, "index.mjs": undefined },
        hasClientCjs: false,
        newestSource: 5,
      })
    ).toContain("pnpm run build");
  });

  it("check.ts asks the rule once, and keeps only freshness, the consumer install and the size tripwire", () => {
    // Structural, because running the gate from the suite would pack and
    // install the package. The pure rule is exercised above.
    const check = scriptCode("check.ts");
    expect([...check.matchAll(/\blibFreshness\(/gu)]).toHaveLength(1);
    // The workflow rules are unit tests now (test/ci-wiring.test.ts).
    expect(check).not.toContain(".github");
    // The only rules it reaches: freshness, imported, and the client half's
    // loader, imported into the consumer's child. A pure rule moved back
    // would need an import, and would fail here.
    const relative = [
      ...check.matchAll(/^import\s+(?:[^;]*?)\s+from\s+"(\.[^"]+)";/gmsu),
    ].map((match) => match[1]);
    expect(relative).toStrictEqual(["./package-checks.ts"]);
    expect(check).toMatch(
      /^import \{ libFreshness \} from "\.\/package-checks\.ts";$/mu
    );
    expect([...check.matchAll(/await import\(/gu)]).toHaveLength(2);
    expect(check).toMatch(
      /const \{ clientBundleProblems \} = await import\(\$\{JSON\.stringify\(pathToFileURL\(join\(ROOT, "scripts", "package-checks\.ts"\)\)\.href\)\}\);/u
    );
    const moved = Object.keys(packageChecks).filter(
      (name) => name !== "libFreshness" && name !== "clientBundleProblems"
    );
    // Known answer: the rules that moved to vitest are among the exports.
    for (const rule of ["peerRangeProblems", "localeKeyPaths", "secretsIn"]) {
      expect(moved, rule).toContain(rule);
    }
    for (const name of moved) {
      expect(check, name).not.toMatch(new RegExp(`\\b${name}\\b`, "u"));
    }
    for (const kept of [
      "CLIENT_BUDGET",
      '"pack", "--json"',
      '"install",',
      "/client",
      "clientBundleProblems(",
    ]) {
      expect(check, kept).toContain(kept);
    }
  });

  it("the client half's rule loads lib/client.js as the host does, and names a bundle that registers the wrong id or answers another NS", () => {
    const pkg = readPackage();
    const expected = {
      ids: [pkg.name, "@viztor/dsh-opencode-patch"],
      ns: pkg.name,
    };
    const built = clientBundleProblems(
      readFileSync(join(ROOT, "lib", "client.js"), "utf8"),
      expected,
      runInNewContext
    );
    expect(built.problems).toStrictEqual([]);
    // Known answer: the factory ran and asked the host for its modules.
    expect(built.asked.length).toBeGreaterThan(0);

    /** A bundle registering `ids`, whose factory answers `ns`. */
    const planted = (ids: readonly string[], ns: string): string =>
      ids
        .map(
          (id) =>
            `window.__ModuleLoader__.load({ id: ${JSON.stringify(id)}, factory: (require) => { require("react"); return { NS: ${JSON.stringify(ns)}, apply() {} }; } });`
        )
        .join("\n");
    expect(
      clientBundleProblems(
        planted(expected.ids, pkg.name),
        expected,
        runInNewContext
      ).problems
    ).toStrictEqual([]);
    expect(
      clientBundleProblems(
        planted([pkg.name, "@someone/else"], pkg.name),
        expected,
        runInNewContext
      ).problems
    ).toStrictEqual([
      `the client bundle did not register @viztor/dsh-opencode-patch (it registered ${pkg.name}, @someone/else)`,
    ]);
    expect(
      clientBundleProblems(
        planted(expected.ids, "other"),
        expected,
        runInNewContext
      ).problems
    ).toStrictEqual(["the client factory answered NS other"]);
    expect(
      clientBundleProblems("throw new Error('boom')", expected, runInNewContext)
        .problems
    ).toStrictEqual(["the client bundle threw while loading: boom"]);
  });
});

describe("package checks · the manifest (moved from check.ts)", () => {
  const manifest = JSON.parse(
    readFileSync(join(ROOT, "package.json"), "utf8")
  ) as {
    dsh?: { bundle?: { patch?: string } };
    main?: string;
    peerDependencies?: Record<string, string>;
    types?: string;
  };

  it("peerRangeProblems names a peer npm cannot read or a pin that orphans the plugin", () => {
    const problems = peerRangeProblems({ a: "workspace:*", b: "1.2.3", c: "" });
    expect(problems).toHaveLength(3);
    for (const [index, name] of ["a", "b", "c"].entries()) {
      expect(problems[index]).toContain(`peer ${name} `);
    }
    expect(
      peerRangeProblems({ d: "^1.0.0", e: ">=1 <2 || ~3.1.0" })
    ).toStrictEqual([]);
    // Non-vacuous on the real manifest: it declares peers to check.
    const peers = manifest.peerDependencies ?? {};
    expect(Object.keys(peers).length).toBeGreaterThanOrEqual(2);
    expect(peerRangeProblems(peers)).toStrictEqual([]);
  });

  it("is a DSH bundle with an entry and types", () => {
    const patch = manifest.dsh?.bundle?.patch;
    expect(patch).toBeDefined();
    expect(existsSync(join(ROOT, patch ?? "missing"))).toBe(true);
    expect(manifest.main).toBeTruthy();
    expect(manifest.types).toBeTruthy();
  });

  it("the harness surfaces this package depends on are still exported", () => {
    // Read from the INSTALLED declarations, as check.ts read them: the
    // contract the plugin compiles against, not a copy of it.
    const require = createRequire(join(ROOT, "package.json"));
    const dir = dirname(
      require.resolve("@deepseek-ai/dsh-typert-protocol/package.json")
    );
    const typesDir = join(dir, "lib", "types");
    const files = existsSync(typesDir)
      ? readdirSync(typesDir)
          .filter((file) => file.endsWith(".d.ts"))
          .map((file) => join(typesDir, file))
      : [join(dir, "lib", "index.d.ts")].filter((file) => existsSync(file));
    expect(files.length).toBeGreaterThan(0);
    const dts = files.map((file) => readFileSync(file, "utf8")).join("\n");
    expect(dts).toMatch(
      /(?:export declare class RemoteError|export \{[^}]*\bRemoteError\b)/u
    );
    expect(dts).toMatch(
      /export declare (?:abstract )?class TypertRemoteService/u
    );
    expect(dts).toMatch(/interface TypertRemoteContribution\b/u);
  });

  it("the locales hold the same keys, and the bundle shows one display name", () => {
    const [en, zh] = ["en", "zh"].map(
      (lang) =>
        JSON.parse(
          readFileSync(join(ROOT, "locale", `${lang}.json`), "utf8")
        ) as { meta?: { title?: unknown } }
    );
    // The reader bites: a nested key is a dotted path, a leaf is itself.
    expect(
      localeKeyPaths({ a: { b: 1, c: { d: "x" } }, e: [] }).toSorted()
    ).toStrictEqual(["a.b", "a.c.d", "e"]);
    const enKeys = localeKeyPaths(en).toSorted();
    expect(enKeys.length).toBeGreaterThan(0);
    expect(localeKeyPaths(zh).toSorted()).toStrictEqual(enKeys);
    expect(en?.meta?.title).toBe(cardCopy.title);
  });
});
