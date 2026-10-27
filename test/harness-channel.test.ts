/**
 * Every harness package this repository compiles or peers against stays on ONE
 * distribution channel.
 *
 * The alpha and `next`/rc channels are parallel tracks, not a version ordering:
 * `0.2.1-rc.2` sorts ABOVE `0.2.1-alpha.5` in semver, so a caret range written
 * against the alpha line silently resolves to the rc line — which is exactly how
 * this repository ended up with `dsh-llm-pi-ai` on alpha and three other harness
 * packages on rc. Compile-time deps made that invisible; the test below is what
 * makes it visible.
 *
 * The rule is not "the newest channel": it is "the channel the host runs". The
 * host publishes the harness on the rc track (`0.2.1-rc.4`), so the tools follow
 * rc.
 *
 * `cordis` is the one harness surface with no prerelease channel to track: the
 * host vendors it as source at a stable release (`4.0.5`), so it is pinned
 * exactly and to a stable version — an exact pin is still required, because a
 * range would float it.
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

/** The channel of a version string, or `undefined` for an untagged release. */
const channelOf = (spec: string): string | undefined => {
  const match = /-([a-z]+)\./u.exec(spec);
  return match?.[1];
};

describe("harness channel alignment", () => {
  const HOST_CHANNEL = "rc";

  // The packages that move together on the harness's `0.2.x` line. `cordis`
  // has its own line (see below) and `schemastery` is a plain library with an
  // independent version, so neither is one of these.
  const HARNESS_LINE_PREFIX = "@deepseek-ai/dsh-";

  it("every harness dependency is pinned on the host's channel", () => {
    const deps = {
      ...manifest().dependencies,
      ...manifest().devDependencies,
    };
    const harness = Object.entries(deps).filter(([name]) =>
      name.startsWith(HARNESS_LINE_PREFIX)
    );
    expect(harness.length).toBeGreaterThan(0);
    for (const [name, spec] of harness) {
      const channel = channelOf(spec);
      expect(channel, `${name} is pinned with no channel: ${spec}`).toBe(
        HOST_CHANNEL
      );
    }
  });

  it("no pinned spec can float onto another channel", () => {
    // A caret range written against the host's channel resolves to the other
    // one, because rc sorts above alpha. Every spec whose channel matters is
    // therefore EXACT.
    const deps = {
      ...manifest().dependencies,
      ...manifest().devDependencies,
    };
    for (const [name, spec] of Object.entries(deps)) {
      if (!name.startsWith("@deepseek-ai/") || name.endsWith("schemastery")) {
        continue;
      }
      if (name.startsWith(HARNESS_LINE_PREFIX)) {
        expect(spec, `${name} must be exact, not a range: ${spec}`).toMatch(
          new RegExp(`^\\d+\\.\\d+\\.\\d+-${HOST_CHANNEL}\\.\\d+$`, "u")
        );
        continue;
      }
      // `cordis`: the host vendors a stable release, so the pin is exact and
      // stable — a prerelease of a future line would not be the host's.
      expect(spec, `${name} must be exact, not a range: ${spec}`).toMatch(
        /^\d+\.\d+\.\d+$/u
      );
    }
  });

  it("the typert peer range covers the 0.2.1 line on BOTH channels", () => {
    // A peer range is a statement about the CODE, and the code is verified
    // against every published 0.2.x build: all nine load, and `apply` plus the
    // remote-service symbols exist on each. The delta between them is purely
    // ADDITIVE (alpha.5 adds `createTypertRemoteInfo`, `isTypertRemoteMethod`,
    // `principalOf`; nothing the remote services import is removed or changed).
    //
    // Both channels' latest is 0.2.1, so the target is that LINE, not a
    // channel. One range says so exactly: `>=0.2.1-alpha.1 <0.2.2`. Its lower
    // bound is alpha.1, which sorts below every rc of the same line, so rc is
    // admitted without enumerating it - and a plain `<0.2.2` alone would NOT
    // work, because semver excludes prereleases unless a comparator in the same
    // `major.minor.patch` tuple carries one. (That is why the old
    // `>=0.2.0-rc.1 <0.3.0` silently excluded the entire alpha channel.)
    const peer =
      manifest().peerDependencies?.["@deepseek-ai/dsh-typert-protocol"];
    expect(peer).toBeDefined();

    const admitted = [
      "0.2.1-alpha.1",
      "0.2.1-alpha.5",
      "0.2.1-rc.1",
      "0.2.1-rc.2",
    ];
    for (const version of admitted) {
      expect(
        semver.satisfies(version, peer ?? ""),
        `${version} is a published 0.2.1 build the code runs on`
      ).toBe(true);
    }
    // And it stops at the line's edges: an older line and a newer patch are
    // untested surfaces, which is a separate decision rather than a silent
    // widening.
    for (const version of ["0.2.0-rc.2", "0.2.2", "0.3.0"]) {
      expect(
        semver.satisfies(version, peer ?? ""),
        `${version} is outside the 0.2.1 line`
      ).toBe(false);
    }
  });
});
