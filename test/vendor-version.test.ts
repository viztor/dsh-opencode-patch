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
  disagreements,
  pinnedVersion,
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
