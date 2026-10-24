/**
 * The deprecated wrapper's entry, linked the way a host links it.
 *
 * `@viztor/dsh-opencode` is a forwarder: its `lib/index.mjs` re-exports the
 * canonical package. A re-export of a name the barrel does not have is not a
 * missing value but a LINK error, raised before a line of either module runs —
 * so the only honest test is a real Node process importing the real built
 * barrel. An in-process `import()` would go through vite-node's transform,
 * which turns a missing named re-export into `undefined` and stays green.
 *
 * The entries are written by `writeWrapperEntries`, the function
 * `publish-scoped.ts` calls, so the bytes linked here are the bytes it ships.
 * A second case links the forwarder that shipped broken, so every run shows the
 * probe is sensitive to the defect rather than trusting that it would be.
 *
 * Reads `lib/index.mjs`, so `pnpm run build` must have run.
 *
 * @module test/wrapper-forwarder.test
 */
import { spawnSync } from "node:child_process";
import type { SpawnSyncReturns } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  WRAPPER_FORWARDER,
  writeWrapperEntries,
} from "../scripts/wrapper-forwarder.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

if (!existsSync(join(ROOT, "lib/index.mjs"))) {
  throw new Error(
    "lib/index.mjs is missing — run `pnpm run build` before the tests"
  );
}

/** Import both modules and report their surfaces, as one line of JSON. */
const PROBE = [
  'import * as w from "./lib/index.mjs";',
  'import * as b from "dsh-opencode-patch";',
  "console.log(JSON.stringify({",
  "  wrapper: Object.keys(w).sort(),",
  "  barrel: Object.keys(b).sort(),",
  '  hasDefault: Object.hasOwn(w, "default"),',
  "}));",
].join("\n");

/** The forwarder every release up to this fix published. */
const SHIPPED_BROKEN = [
  'export * from "dsh-opencode-patch";',
  'export { default } from "dsh-opencode-patch";',
  "",
].join("\n");

interface ProbeAnswer {
  readonly barrel: string[];
  readonly hasDefault: boolean;
  readonly wrapper: string[];
}

/**
 * Lay out a scratch install of the wrapper and run the probe in it.
 *
 * The scratch directory stands in for an install of the wrapper: its dependency
 * resolves to this checkout, whose `exports` name the built barrel.
 *
 * @param write - writes the wrapper's entries into the scratch `lib/`.
 * @returns the probe's process result and the bytes of the typings entry.
 */
const probeWith = (
  write: (libDir: string) => void
): { run: SpawnSyncReturns<string>; typings: string | undefined } => {
  const scratch = mkdtempSync(join(tmpdir(), "dsh-opencode-wrapper-"));
  const link = join(scratch, "node_modules", "dsh-opencode-patch");
  try {
    mkdirSync(join(scratch, "node_modules"));
    mkdirSync(join(scratch, "lib"));
    symlinkSync(ROOT, link, "dir");
    write(join(scratch, "lib"));
    const typingsPath = join(scratch, "lib", "index.d.mts");
    const typings = existsSync(typingsPath)
      ? readFileSync(typingsPath, "utf8")
      : undefined;
    const run = spawnSync(
      process.execPath,
      ["--input-type=module", "-e", PROBE],
      { cwd: scratch, encoding: "utf8", timeout: 60_000 }
    );
    return { run, typings };
  } finally {
    if (existsSync(link)) {
      unlinkSync(link);
    }
    rmSync(scratch, { force: true, recursive: true });
  }
};

describe("the deprecated wrapper's forwarder", () => {
  it("the deprecated wrapper's entry links against the built barrel and re-exports exactly its surface", () => {
    const { run, typings } = probeWith(writeWrapperEntries);

    expect(run.stderr).not.toContain("does not provide an export named");
    expect(run.status, run.stderr).toBe(0);
    const answer = JSON.parse(run.stdout) as ProbeAnswer;
    expect(answer.barrel).toContain("apply");
    expect(answer.barrel).toContain("Config");
    // `export *` never forwards `default`: if the barrel ever gained one, the
    // wrapper would silently drop it, and this is where that shows.
    expect(answer.wrapper).toEqual(answer.barrel);
    expect(answer.hasDefault).toBe(false);
    expect(typings).toBe(WRAPPER_FORWARDER);
  }, 60_000);

  it("the probe fails on the forwarder that shipped broken", () => {
    const { run } = probeWith((libDir) => {
      writeFileSync(join(libDir, "index.mjs"), SHIPPED_BROKEN);
    });

    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain("does not provide an export named 'default'");
  }, 60_000);
});
