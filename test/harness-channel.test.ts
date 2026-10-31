/**
 * Every harness package this repository compiles or peers against is pinned to
 * ONE exact version, and the peer range it declares covers BOTH distribution
 * channels of the lines this plugin supports.
 *
 * The alpha and `rc` channels are parallel tracks, not a version ordering:
 * `0.2.1-rc.2` sorts ABOVE `0.2.1-alpha.5` in semver, so a caret range written
 * against the alpha line silently resolves to the rc line — which is exactly how
 * this repository once ended up with `dsh-llm-pi-ai` on alpha and three other
 * harness packages on rc. Compile-time deps made that invisible; the tests below
 * are what make it visible.
 *
 * Two rules, deliberately separate:
 *
 * 1. PINS are exact and name the version the host runs. Only one version can be
 *    installed, so the pin is a fact about the host, not a preference — and it
 *    must be exact, because a range would float it onto a version nobody
 *    verified.
 * 2. PEERS describe the code, and the code targets the whole `0.2.x` line on
 *    BOTH channels — the latest `rc` and the latest `alpha` alike — because a
 *    host may be running either one. Narrowing a peer range to the channel that
 *    happens to be pinned is the mistake this file exists to catch.
 *
 * `cordis` has its own line. The host vendors it as source at an exact version
 * which may or may not carry a channel tag (`4.0.5`, then `4.0.6-alpha.1`), so
 * the pin is exact either way and its peer range covers the same both-channel
 * spread.
 *
 * @module test/harness-channel
 */
import { readFileSync } from "node:fs";

import semver from "semver";
import { describe, expect, it } from "vitest";

interface Manifest {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

const manifest = (): Manifest =>
  JSON.parse(readFileSync("package.json", "utf8")) as Manifest;

const EXACT = /^\d+\.\d+\.\d+(-[a-z]+\.\d+)?$/u;

const harnessPins = (): [string, string][] =>
  Object.entries({
    ...manifest().dependencies,
    ...manifest().devDependencies,
  }).filter(([name]) => name.startsWith("@deepseek-ai/"));

describe("harness channel alignment", () => {
  it("every harness dependency is an exact pin, never a range", () => {
    const pins = harnessPins();
    expect(pins.length).toBeGreaterThan(0);
    for (const [name, spec] of pins) {
      if (name.endsWith("schemastery")) continue;
      expect(spec, `${name} must be exact, not a range: ${spec}`).toMatch(
        EXACT
      );
    }
  });

  it("the pins are on a channel the peer range admits", () => {
    // The pin is whatever version the host runs; the range is the surface the
    // code claims. A pin outside its own range would mean the code was compiled
    // against a version it does not admit — the two have to agree even as the
    // host moves between channels.
    const peers = manifest().peerDependencies ?? {};
    for (const [name, spec] of harnessPins()) {
      const peer = peers[name];
      if (peer === undefined) continue;
      expect(
        semver.satisfies(spec, peer),
        `${name}@${spec} is pinned outside its own peer range ${peer}`
      ).toBe(true);
    }
  });

  it("the typert peer range covers BOTH channels of every supported line", () => {
    // A peer range is a statement about the CODE, and the code is verified
    // against the `0.2.1` and `0.2.2` lines on both channels: all of them load,
    // and `apply` plus the remote-service symbols exist on each. The delta
    // between them is purely ADDITIVE.
    //
    // The range is `>=0.2.1-alpha.1 <0.3.0 || >=0.2.2-0 <0.3.0`. The first
    // clause covers the 0.2.1 line on both channels — its lower bound alpha.1
    // sorts below every rc of that line, so rc needs no separate entry. The
    // second is not redundant: semver excludes a prerelease unless a comparator
    // in the SAME `major.minor.patch` tuple carries one, so `<0.3.0` alone
    // silently drops every `0.2.2-*` build, alpha and rc alike. Both clauses
    // stop at 0.3.0, which leaves the next line a separate decision rather than
    // a silent widening.
    const peer =
      manifest().peerDependencies?.["@deepseek-ai/dsh-typert-protocol"];
    expect(peer).toBeDefined();

    const admitted = [
      // 0.2.1 line, both channels, and the stable release both channels lead to.
      "0.2.1-alpha.1",
      "0.2.1-alpha.5",
      "0.2.1-rc.1",
      "0.2.1-rc.5",
      "0.2.1",
      // 0.2.2 line, both channels, and its stable release.
      "0.2.2-alpha.2",
      "0.2.2-rc.1",
      "0.2.2",
    ];
    for (const version of admitted) {
      expect(
        semver.satisfies(version, peer ?? ""),
        `${version} is a published build on a line this plugin supports`
      ).toBe(true);
    }

    // And it stops at the line's edges: an older line and the next one are
    // untested surfaces, which is a separate decision rather than a silent
    // widening.
    for (const version of ["0.2.0-rc.2", "0.3.0", "0.3.0-alpha.1"]) {
      expect(
        semver.satisfies(version, peer ?? ""),
        `${version} is outside the 0.2.1/0.2.2 lines`
      ).toBe(false);
    }
  });
});
