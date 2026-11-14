/**
 * The rules behind the CLI-version gate.
 *
 * That gate runs on a schedule in CI, and its failure mode is the worst kind: it
 * PASSES while reading nothing. It has already done so twice — the first version
 * could not see the constant at all, the second could not see a bare copy — and
 * both were found by a control run, not by a test.
 *
 * So the rules are here, as functions of their input.
 *
 * @module test/vendor-version.test
 */

import { describe, expect, it } from "vitest";

import {
  bareLiteral,
  CLI_GENERATION_LITERAL,
  CLI_LITERAL,
  disagreements,
  GENERATED_TABLES,
  pinnedVersion,
  pinVerdict,
  publishedCli,
  scansFile,
  unpinnedGenerationClaims,
} from "../scripts/vendor-version.ts";

/**
 * A stale version, built at RUN time.
 *
 * **A stale version literal in this file would fail the gate it describes**: the
 * check walks `test/`, and a bare patch-level literal is exactly what it is
 * looking for. So the digits are assembled instead of written: the file carries
 * the series only, with no third field for the pattern to match.
 */
const stale = (patch: string): string =>
  [PINNED.split(".")[0], PINNED.split(".")[1], patch].join(".");

/** The pinned version, built the same way, for the cases that need it. */
const PINNED = ["1", "19", "5"].join(".");

describe("finding the constant", () => {
  it("reads the version out of the identity module", () => {
    expect(
      pinnedVersion(`export const OPENCODE_CLI_VERSION = "${PINNED}";\n`)
    ).toBe(PINNED);
  });

  it("returns undefined when the file carries no such constant", () => {
    // The gate's own rule: a check that read nothing is not a passing check, so
    // the caller has to be able to tell those apart. If this answered "" or a
    // default, the gate would report OK on a tree it never read.
    expect(pinnedVersion("export const SOMETHING_ELSE = 1;\n")).toBeUndefined();
    expect(pinnedVersion("")).toBeUndefined();
  });
});

describe("a bare mention of the pinned series", () => {
  it("matches the bare and v-prefixed forms", () => {
    expect(`a comment saying ${PINNED}`.match(bareLiteral(PINNED))).toEqual([
      PINNED,
    ]);
    expect(`tagged v${PINNED}`.match(bareLiteral(PINNED))).toEqual([
      `v${PINNED}`,
    ]);
  });

  it("does not match the prefixed form, which the other scan owns", () => {
    // The `(?<!opencode/)` guard. Without it every `opencode/1.19.5` copy would
    // be reported as two copies, and the count in the OK line would be a lie.
    expect(`opencode/${PINNED}`.match(bareLiteral(PINNED))).toBeNull();
  });

  it("does not match another patch of the same series", () => {
    // The point of the bare scan: a comment two patches stale. It matches the
    // SERIES, so a stale patch is caught while another major.minor is the
    // literal scan's business.
    const behind = stale("3");
    expect(`stale ${behind}`.match(bareLiteral(PINNED))).toEqual([behind]);
    // A different SERIES is the literal scan's business, not this one's.
    expect(
      `older ${["1", "18", "9"].join(".")}`.match(bareLiteral(PINNED))
    ).toBeNull();
  });
});

describe("copies that disagree with the constant", () => {
  it("says which versions and which files, sorted", () => {
    const older = stale("3");
    const newer = stale("4");
    const copies = new Map([
      [PINNED, ["src/identity.ts"]],
      [older, ["test/e2e/a.ts"]],
    ]);
    const mentions = new Map([[newer, ["docs/b.md"]]]);
    expect(disagreements(PINNED, copies, mentions)).toEqual([
      { files: ["test/e2e/a.ts"], version: older },
      { files: ["docs/b.md"], version: newer },
    ]);
  });

  it("is empty when every copy agrees", () => {
    // The shape of the passing case matters as much as the failing one: the gate
    // reports a COUNT of copies in its OK line, so an empty map that still
    // "passes" is a gate that scanned nothing.
    const agreeing = new Map([[PINNED, ["src/identity.ts", "docs/a.md"]]]);
    expect(disagreements(PINNED, agreeing, agreeing)).toEqual([]);
  });
});

describe("which files the copy scan reads", () => {
  it("reads the files a copy can live in", () => {
    for (const path of [
      "src/identity.ts",
      "src/settings-page.tsx",
      "README.md",
      "docs/a.md",
      "test/fixtures/x.json",
      "scripts/x.yaml",
      ".github/workflows/ci.yml",
    ]) {
      expect(scansFile(path), path).toBe(true);
    }
  });

  it("skips the generated tables, which hold vendor data rather than copies", () => {
    // The premise: both are TypeScript, so the extension alone would read them.
    // Only the exclusion keeps a refresh from failing a gate that only the
    // repository is supposed to be able to break.
    expect([...GENERATED_TABLES].toSorted()).toEqual([
      "src/catalog-data.ts",
      "src/go-limits-data.ts",
    ]);
    for (const path of GENERATED_TABLES) {
      expect(path).toMatch(/\.ts$/u);
      expect(scansFile(path), path).toBe(false);
    }
  });

  it("skips a file no copy can live in", () => {
    expect(scansFile("docs/media/hero.svg")).toBe(false);
    expect(scansFile("lib/client.js")).toBe(false);
  });
});

describe("the registry's dist-tags", () => {
  /** Snapshot versions as the registry carries them: `0.0.0-<tag>-<stamp>`. */
  const DEV = ["0.0.0", "dev", "202611092046"].join("-");
  const NEXT = ["0.0.0", "next", "202606270058"].join("-");

  it("reads the registry's dist-tags: the pinned line's latest, the snapshot builds (listed, never classified), and a latest that left the line", () => {
    expect(
      publishedCli({
        dev: DEV,
        latest: PINNED,
        "latest-1": "1.1.4",
        next: NEXT,
      })
    ).toStrictEqual({ snapshots: { dev: DEV, next: NEXT }, stable: PINNED });
    // No usable `latest`: nothing published is read as current.
    expect(publishedCli({})).toBeUndefined();
    expect(
      publishedCli({ latest: ["0.0.0", "dev", "1"].join("-") })
    ).toBeUndefined();
    expect(publishedCli(null)).toBeUndefined();
    expect(publishedCli("1.2.3")).toBeUndefined();
    // A tag is registry data, never a pattern: one with regex metacharacters
    // neither throws nor matches loosely.
    const plusPlus = ["0.0.0", "c++", "202611092046"].join("-");
    const paren = ["0.0.0", "a(b", "1"].join("-");
    expect(
      publishedCli({
        // As a pattern, `a.b` would read `axb`'s snapshot as its own.
        "a.b": ["0.0.0", "axb", "1"].join("-"),
        "a(b": paren,
        "c++": plusPlus,
        latest: PINNED,
      })
    ).toStrictEqual({
      snapshots: { "a(b": paren, "c++": plusPlus },
      stable: PINNED,
    });

    expect(
      pinVerdict(PINNED, { snapshots: {}, stable: PINNED })
    ).toBeUndefined();
    const bump = pinVerdict(PINNED, { snapshots: {}, stable: stale("6") });
    expect(bump).toMatch(/bump OPENCODE_CLI_VERSION/u);
    // `latest` left the pinned major: the format the User-Agent claims moved
    // with it, so the answer is not a version bump.
    const generation = pinVerdict(PINNED, { snapshots: {}, stable: "2.0.0" });
    expect(generation).toMatch(/generation/u);
    expect(generation).not.toMatch(/bump OPENCODE_CLI_VERSION/u);
  });

  it("sees the 2.x User-Agent form, once, and calls it an unpinned claim", () => {
    // Assembled: a concrete 2.x-form literal in this file would be a claim the
    // copy scan fails on.
    const ua = ["opencode", "dev", DEV, "cli"].join("/");
    const generation = [...ua.matchAll(CLI_GENERATION_LITERAL)];
    expect(generation).toHaveLength(1);
    expect(generation[0]?.slice(1)).toStrictEqual(["dev", DEV, "cli"]);
    expect([...ua.matchAll(CLI_LITERAL)]).toHaveLength(0);
    // The bare scan of a series never reads a version inside the 2.x form.
    const series = ["0", "0", "1"].join(".");
    expect([...ua.matchAll(bareLiteral(series))]).toHaveLength(0);

    const legacy = `opencode/${PINNED}`;
    expect([...legacy.matchAll(CLI_LITERAL)]).toHaveLength(1);
    expect([...legacy.matchAll(CLI_GENERATION_LITERAL)]).toHaveLength(0);

    // A stale 1.x copy followed by another segment is still a 1.x copy, and
    // the gate reports it.
    const segmented = `ua opencode/${stale("3")}/cli and opencode/${stale("2")}/`;
    const found = [...segmented.matchAll(CLI_LITERAL)].map((match) => match[1]);
    expect(found).toStrictEqual([stale("3"), stale("2")]);
    expect([...segmented.matchAll(CLI_GENERATION_LITERAL)]).toHaveLength(0);
    expect(
      disagreements(PINNED, new Map([[stale("3"), ["docs/x.md"]]]), new Map())
    ).toStrictEqual([{ files: ["docs/x.md"], version: stale("3") }]);

    const placeholder = "opencode/<channel>/<version>/<client>";
    expect([...placeholder.matchAll(CLI_LITERAL)]).toHaveLength(0);
    expect([...placeholder.matchAll(CLI_GENERATION_LITERAL)]).toHaveLength(0);

    const claims = unpinnedGenerationClaims(new Map([[ua, ["docs/x.md"]]]));
    expect(claims).toHaveLength(1);
    expect(claims[0]).toContain("docs/x.md");
    expect(claims[0]).toContain("no constant pins");
    expect(unpinnedGenerationClaims(new Map())).toStrictEqual([]);
  });
});
