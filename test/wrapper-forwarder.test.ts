/**
 * The retired alias's forwarder, linked against the REAL built barrel.
 *
 * The alias is a published package, and the thing it exists for — letting an
 * existing install keep resolving — is what it broke: its forwarder re-exported
 * a `default` the canonical package does not have, so every load was a link
 * error before the plugin ran at all.
 *
 * **The check is a real Node process, not vite-node.** A bundler turns a
 * missing export into `undefined` and stays green, which is how a package that
 * cannot be imported ships with a passing suite. So the test writes the
 * forwarder next to a copy of the BUILT `lib/index.mjs` and lets Node link it.
 *
 * @module test/wrapper-forwarder.test
 */

import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { wrapperForwarder } from "../scripts/wrapper-forwarder.ts";

/** The built barrel, which is what the wrapper forwards to. */
const BUILT = join(import.meta.dirname, "..", "lib", "index.mjs");

describe("the retired alias's forwarder", () => {
  it("links against the built barrel in a real Node process", () => {
    // The built barrel is what ships; if it is missing, the bundle gate
    // failed and there is nothing to link against.
    expect(
      existsSync(BUILT),
      "lib/index.mjs is missing — run `pnpm run build` first"
    ).toBe(true);

    const root = mkdtempSync(join(tmpdir(), "dsh-wrapper-"));
    try {
      // A package tree the wrapper can resolve: the canonical package under
      // its name, with the barrel that was actually built.
      const canonical = join(root, "node_modules", "dsh-opencode-patch");
      mkdirSync(join(canonical, "lib"), { recursive: true });
      cpSync(BUILT, join(canonical, "lib", "index.mjs"));
      // The barrel's own imports have to resolve from the temp tree, or Node
      // fails on the DEPENDENCY and never reaches the export check.
      for (const dependency of [
        "@deepseek-ai/schemastery",
        "@deepseek-ai/dsh-typert-protocol",
      ]) {
        const from = join(
          import.meta.dirname,
          "..",
          "node_modules",
          dependency
        );
        if (!existsSync(from)) {
          continue;
        }
        const to = join(root, "node_modules", dependency);
        mkdirSync(join(to, ".."), { recursive: true });
        symlinkSync(from, to, "dir");
      }
      writeFileSync(
        join(canonical, "package.json"),
        JSON.stringify({
          exports: { ".": "./lib/index.mjs" },
          name: "dsh-opencode-patch",
          type: "module",
          version: "0.0.0-test",
        })
      );

      const wrapper = join(root, "wrapper");
      mkdirSync(join(wrapper, "lib"), { recursive: true });
      writeFileSync(
        join(wrapper, "lib", "index.mjs"),
        `${wrapperForwarder()}\n`
      );
      writeFileSync(
        join(wrapper, "package.json"),
        JSON.stringify({
          name: "dsh-opencode-patch-wrapper",
          type: "module",
        })
      );

      // Node links it. A `default` the barrel does not have is a SyntaxError
      // here — and nothing else in the suite would ever see it.
      const probe = join(root, "probe.mjs");
      writeFileSync(
        probe,
        `import * as ns from "${join(wrapper, "lib", "index.mjs")}";\n` +
          `console.log(Object.keys(ns).length);\n`
      );
      const out = execFileSync(process.execPath, [probe], {
        encoding: "utf8",
      });
      expect(Number(out.trim())).toBeGreaterThan(0);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("names only what the canonical package has", () => {
    // The forwarder is a star re-export and nothing else: a named re-export
    // can name something the target does not have, and that is a link error.
    expect(wrapperForwarder()).toBe('export * from "dsh-opencode-patch";');
    expect(wrapperForwarder()).not.toContain("default");
  });
});
