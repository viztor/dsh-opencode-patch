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
 * The rule is not "the newest channel": it is "the host users run". That host
 * is a registry install of `@deepseek-ai/dsh`, which resolves the cluster at
 * `0.2.1-rc.2` (D22, `HOST_VERSIONS`). The alpha pin this file used to assert
 * came from the host a previous session happened to run, not from that.
 *
 * @module test/harness-channel
 */
import { readFileSync } from "node:fs";

import semver from "semver";
import { describe, expect, it } from "vitest";

import { HOST_VERSIONS } from "./support/host-versions.ts";

interface Manifest {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

const manifest = (): Manifest =>
  JSON.parse(readFileSync("package.json", "utf8")) as Manifest;

describe("harness channel alignment", () => {
  /**
   * The exact version a harness package is pinned to: cordis and its loader at
   * what the published host resolves, on their own untagged lines; every
   * `dsh-*` on the cluster's tag (`HOST_VERSIONS.dsh`). For the two
   * client-bundle packages, `dsh-client-store` and `dsh-client-ui-primitives`,
   * that tag is grounded in the host's build manifest rather than an installed
   * copy: the published host does not install them, they are devDependencies
   * its frontend bundle was built against at exactly this tag
   * (`dsh-web-frontend/package.json`).
   */
  const expectedFor = (name: string): string | undefined => {
    if (name === "@deepseek-ai/cordis") {
      return HOST_VERSIONS.cordis;
    }
    if (name === "@deepseek-ai/cordis-plugin-loader") {
      return HOST_VERSIONS.loader;
    }
    return name.startsWith("@deepseek-ai/dsh-") ? HOST_VERSIONS.dsh : undefined;
  };

  /** Every `@deepseek-ai/*` dependency whose release moves with the host. */
  const harnessDeps = (): [string, string][] =>
    Object.entries({
      ...manifest().dependencies,
      ...manifest().devDependencies,
    }).filter(
      // `schemastery` is a plain library rather than a harness surface: it
      // follows the cluster's `~3.18.x` dependency range rather than the
      // cluster's tag, so it is checked against that range (in the lockfile
      // case below), not against HOST_VERSIONS.
      ([name]) =>
        name.startsWith("@deepseek-ai/") && name !== "@deepseek-ai/schemastery"
    );

  it("every harness dependency is pinned exactly to the published host's cluster versions", () => {
    // Exact, not a range: rc sorts above alpha, so a caret range written
    // against one channel silently floats onto another. The previous form of
    // this check required every spec to be `-alpha.N`, which encoded the host
    // a previous session ran; the published host resolves rc.2, and cordis
    // 4.0.5 and the loader's 1.0.6 carry no channel at all.
    const harness = harnessDeps();
    expect(harness.length).toBeGreaterThan(0);
    for (const [name, spec] of harness) {
      // Fail closed on a harness package with no rule, and say where the rule
      // goes, rather than reporting a spurious "expected … to be undefined".
      const expected = expectedFor(name);
      expect(
        expected,
        `${name} is a @deepseek-ai dependency with no rule in expectedFor / HOST_VERSIONS (test/support/host-versions.ts); add one or exclude it deliberately`
      ).toBeDefined();
      expect(spec, name).toBe(expected);
    }
  });

  it("every dsh package in the resolved tree is on the published host's version", () => {
    // The declarations above cannot see a transitive dependency: a cluster
    // package nobody here names (`dsh-brand`, `dsh-util-values`, …) pulled in
    // at a second version is exactly the split cluster this file is about. The
    // lockfile's `packages:` section is what pnpm resolved, transitive entries
    // included, so every `@deepseek-ai/dsh-*` key there must carry the pin.
    const lock = readFileSync("pnpm-lock.yaml", "utf8");
    const sections = lock.split("\npackages:\n");
    const packages = (sections.at(-1) ?? "").split("\nsnapshots:\n")[0] ?? "";
    const resolved = [
      ...packages.matchAll(
        /^ {2}'(@deepseek-ai\/dsh-[a-z0-9-]+)@([^'(]+)':/gmu
      ),
    ].map(([, name, version]) => [name ?? "", version ?? ""] as const);
    // A check that read no entries would otherwise pass by finding nothing.
    expect(resolved.length).toBeGreaterThan(0);
    const off = resolved
      .filter(([, version]) => version !== HOST_VERSIONS.dsh)
      .map(([name, version]) => `${name}@${version}`);
    expect(off).toEqual([]);

    // The plugin's one runtime library the cluster also depends on resolves to
    // ONE copy: the version this plugin declares, inside the range the
    // installed wrapper declares. A host bump onto another schemastery line
    // would otherwise leave two copies of the library the Config schema is
    // built with, and nothing else here would notice.
    const schemastery = [
      ...packages.matchAll(/^ {2}'@deepseek-ai\/schemastery@([^'(]+)':/gmu),
    ].map(([, version]) => version ?? "");
    expect(schemastery).toHaveLength(1);
    expect(schemastery[0]).toBe(
      manifest().dependencies?.["@deepseek-ai/schemastery"]
    );
    const wrapper = JSON.parse(
      readFileSync(
        "node_modules/@deepseek-ai/dsh-llm-pi-ai/package.json",
        "utf8"
      )
    ) as Manifest;
    // Read from both declaration kinds (dsh-settings already declares
    // schemastery as a peer), and require that one was found: semver reads an
    // empty range as `*`, so a missing declaration would otherwise pass here
    // without checking anything.
    const range = {
      ...wrapper.peerDependencies,
      ...wrapper.dependencies,
    }["@deepseek-ai/schemastery"];
    expect(
      range,
      "dsh-llm-pi-ai no longer declares @deepseek-ai/schemastery (dependencies or peerDependencies)"
    ).toBeTruthy();
    expect(semver.satisfies(schemastery[0] ?? "", range ?? ""), range).toBe(
      true
    );
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

    // The published builds the code is verified on, plus the pinned host by
    // construction, so a host bump outside the range fails here.
    const admitted = [
      ...new Set([
        "0.2.1-alpha.1",
        "0.2.1-alpha.5",
        "0.2.1-rc.1",
        "0.2.1-rc.2",
        HOST_VERSIONS.dsh,
      ]),
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
