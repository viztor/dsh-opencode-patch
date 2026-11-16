/**
 * The hard rule, as a test rather than as a habit.
 *
 * An absolute path from a development machine must never appear anywhere a third
 * party can read, and the rule says the check belongs BEFORE the commit — because
 * once it ships, removing it means rewriting content and history, force-pushing
 * over every tag and invalidating published provenance.
 *
 * So this reads the tree and the built artifacts, and it accepts exactly the
 * placeholders the rule prescribes: `/home/you/…`, `/Users/you/…`,
 * `C:/Users/you/…` and `C:\Users\<name>` in the rule's own prose. Everything else
 * that names a real home directory is a failure that names the file.
 *
 * @module dsh-opencode-patch/no-local-paths.test
 */

import { readFile, readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

import { secretsIn } from "../scripts/package-checks.ts";
import { CARD_FIELDS } from "./support/src.ts";

const ROOT = new URL("..", import.meta.url).pathname;

/**
 * Directories a third party can read: the tree, the workflows that run on a
 * public runner and print their own text into a public log, plus the build
 * output.
 */
const SCANNED = [
  "src",
  "test",
  "docs",
  "scripts",
  "lib",
  "channels",
  "locale",
  ".github",
];
const SCANNED_FILES = [
  "AGENTS.md",
  "CONTRIBUTING.md",
  "README.md",
  "package.json",
  "cordis.patch.yml",
  "pnpm-workspace.yaml",
];

/** A home prefix followed by a name that is not the rule's placeholder. */
const LOCAL_PATH =
  /(?:\/Users\/|\/home\/|C:\\Users\\|C:\/Users\/)(?!you(?:\/|\\|["'`\s]|$)|<name>)[A-Za-z0-9._-]+/gu;

/**
 * A directory that exists on one kind of machine only: Homebrew's prefixes.
 * Not a home directory, so it leaks no name, but a script that puts one on
 * PATH works on the machine it was written on and nowhere else, and says
 * which machine that was.
 */
const MACHINE_PATH = /\/opt\/homebrew\b|\/usr\/local\/Cellar\b/gu;

const walk = async (dir: string): Promise<string[]> => {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    // `lib/` is build output and may not exist yet; its absence is not a failure.
    return [];
  }
  const found: string[] = [];
  for (const entry of entries) {
    if (entry === "node_modules" || entry.startsWith(".")) {
      continue;
    }
    const full = join(dir, entry);
    const info = await stat(full);
    if (info.isDirectory()) {
      found.push(...(await walk(full)));
    } else if (/\.(?:ts|tsx|js|mjs|md|json|ya?ml|sh)$/u.test(entry)) {
      found.push(full);
    }
  }
  return found;
};

/** Every file the scans read: the named root files and each walked directory. */
const scannedFiles = async (): Promise<string[]> => {
  const files = SCANNED_FILES.map((name) => join(ROOT, name));
  for (const dir of SCANNED) {
    files.push(...(await walk(join(ROOT, dir))));
  }
  return files;
};

describe("the hard rule: no local path leaves the machine", () => {
  it("finds no home directory or machine path in the tree, .github and shell scripts included", async () => {
    const files = await scannedFiles();
    // Known answers: the walk reaches the workflows and the shell scripts,
    // so a scan that skipped either could not pass by reading nothing.
    const walked = files.map((file) => relative(ROOT, file));
    expect(walked).toContain(".github/workflows/ci.yml");
    expect(walked).toContain("scripts/capture-ui.sh");

    const offenders: string[] = [];
    for (const file of files) {
      // This file is the one exception, and it has to be: proving the check can
      // tell a placeholder from a real home directory means writing one of each
      // down. Every other file is scanned.
      if (file.endsWith("no-local-paths.test.ts")) {
        continue;
      }
      let text: string;
      try {
        text = await readFile(file, "utf8");
      } catch {
        continue;
      }
      for (const pattern of [LOCAL_PATH, MACHINE_PATH]) {
        for (const match of text.matchAll(pattern)) {
          offenders.push(`${relative(ROOT, file)}: ${match[0]}`);
        }
      }
    }

    // The message names the file and the path, because the whole point is that a
    // violation must be found before it is committed rather than after.
    expect(offenders).toEqual([]);
  });

  it("accepts the placeholders the rule prescribes", () => {
    // The check has to be able to tell the two apart, so it is asserted directly
    // rather than inferred from a tree that happens to be clean.
    const allowed = [
      "/home/you/projects/my-app",
      "/Users/you/dev/my-app",
      "C:/Users/you/projects/my-app",
      "/Users/<name>/…",
    ];
    for (const sample of allowed) {
      expect(sample.match(LOCAL_PATH), sample).toBeNull();
    }
    const forbidden = [
      "/Users/someone/projects/app",
      "/home/someone/app",
      "C:\\Users\\someone\\app",
    ];
    for (const sample of forbidden) {
      expect(sample.match(LOCAL_PATH), sample).not.toBeNull();
    }
    // Built from parts: this file is scanned for the machine paths too.
    expect(
      ["", "opt", "homebrew", "bin"].join("/").match(MACHINE_PATH)
    ).not.toBeNull();
    expect("/usr/local/bin".match(MACHINE_PATH)).toBeNull();
  });
});

describe("no credential in the tree (moved from check.ts)", () => {
  it("names each key shape and nothing that only resembles one", () => {
    // Assembled at run time: a whole canary in this file would be a credential
    // the scan below has to find.
    const parts = {
      a: "sk-ant-",
      g: "ghp_",
      m: "monid_live_",
      t: "sk-tinyfish-",
    };
    const found = [
      `${parts.m}AbCdEf1234567890`,
      `${parts.t}Pm-QkiaUloPEyNN`,
      `${parts.g}abcdefghijklmnopqrstuvwxyz0123456789`,
      `${parts.a}api03-AbCdEf1234567890`,
    ];
    for (const sample of found) {
      expect(secretsIn(sample), sample.slice(0, 6)).toHaveLength(1);
    }
    for (const sample of [
      parts.m,
      parts.t,
      "$OPENCODE_GO_API_KEY",
      "Authorization: Bearer <key>",
    ]) {
      expect(secretsIn(sample), sample).toStrictEqual([]);
    }
  });

  it("finds none in the tree, the root files included", async () => {
    const files = await scannedFiles();
    for (const entry of await readdir(ROOT)) {
      const full = join(ROOT, entry);
      const info = await stat(full);
      if (
        info.isFile() &&
        /\.(?:ts|js|mjs|md|json|ya?ml)$/u.test(entry) &&
        !files.includes(full)
      ) {
        files.push(full);
      }
    }
    // Non-vacuous: the walk read the tree, not an empty directory.
    expect(files.length).toBeGreaterThan(100);
    const hits: string[] = [];
    for (const file of files) {
      const text = await readFile(file, "utf8");
      for (const what of secretsIn(text)) {
        hits.push(`${relative(ROOT, file)}: ${what}`);
      }
    }
    expect(hits).toStrictEqual([]);
  });
});

describe("AGENTS.md · the repo map", () => {
  // Two modules were added this year and not named in the map - org-cache.ts and
  // login-credential.ts - and both were found by listing the modules the map
  // omits rather than by reading it. A map is read for what it says, so an
  // omission is invisible in it; this is the check that makes it visible.
  //
  // The `settings-*` files are exempt because the map covers them by a phrase
  // rather than by name ("the settings-* card and its controls"), which is a
  // decision rather than an omission.
  it("names every module that is not a settings-* file", async () => {
    const map = await readFile(
      new URL("../AGENTS.md", import.meta.url),
      "utf8"
    );
    const dir = new URL("../src/", import.meta.url);
    const entries = await readdir(dir);
    const files = entries.filter((f) => /\.tsx?$/u.test(f));
    expect(files.length).toBeGreaterThan(0);
    const unnamed = files.filter(
      (f) => !f.startsWith("settings-") && !map.includes(f)
    );
    expect(unnamed, "modules the repo map does not name").toEqual([]);
  });

  it("names no module the tree does not have", async () => {
    // **The other direction, and it is the one that rotted.** The check above
    // catches an omission; this one catches a map that describes a tree it is
    // not in. Nine `src/login-*.ts` entries stayed in the map after the login
    // stack moved to the `v2` bookmark — a reader following them found nothing,
    // and nothing in the suite said so, because a map is read for what it says.
    const map = await readFile(
      new URL("../AGENTS.md", import.meta.url),
      "utf8"
    );
    const dir = new URL("../src/", import.meta.url);
    const present = new Set(await readdir(dir));

    const named = new Set(
      [...map.matchAll(/\bsrc\/([A-Za-z0-9_.-]+\.tsx?)\b/gu)].map(
        (match) => match[1] ?? ""
      )
    );
    expect(named.size).toBeGreaterThan(0);
    const missing = [...named].filter((file) => !present.has(file)).toSorted();
    expect(missing, "modules the repo map names but the tree lacks").toEqual(
      []
    );
  });
});

describe("the READMEs · the settings control count", () => {
  // The English README said "Seven controls" while CARD_FIELDS held eight and the
  // Chinese README already said 八个 - the two documents drifted in opposite
  // directions on one fact, and only one of them was right. Neither language is
  // the source of truth, so both are held to the module that defines them.
  const WORDS: Record<string, number> = {
    Eight: 8,
    Nine: 9,
    Seven: 7,
    Ten: 10,
    七: 7,
    八: 8,
    九: 9,
    十: 10,
  };

  it("states the count CARD_FIELDS has, in both languages", async () => {
    const expected = CARD_FIELDS.length;
    expect(expected).toBeGreaterThan(0);
    for (const file of ["../README.md", "../README.zh-CN.md"]) {
      const text = await readFile(new URL(file, import.meta.url), "utf8");
      const stated = [
        ...text.matchAll(/\b(Seven|Eight|Nine|Ten)\s+controls/gu),
        ...text.matchAll(/([七八九十])\s*个控件/gu),
      ].map((m) => WORDS[m[1] ?? ""] ?? -1);
      expect(
        stated.length,
        `${file} states the control count nowhere`
      ).toBeGreaterThan(0);
      for (const n of stated) {
        expect(
          n,
          `${file} states a control count CARD_FIELDS does not have`
        ).toBe(expected);
      }
    }
  });
});
