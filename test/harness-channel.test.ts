/**
 * Every harness package this repository compiles or peers against is pinned to
 * ONE exact version, the peer range it declares covers BOTH distribution
 * channels of the lines this plugin supports, and each channel's committed
 * lockfile installs exactly that channel's record.
 *
 * The alpha and `rc` channels are parallel tracks, not a version ordering:
 * `0.2.1-rc.2` sorts ABOVE `0.2.1-alpha.5` in semver, so a caret range written
 * against the alpha line silently resolves to the rc line — which is exactly how
 * this repository once ended up with `dsh-llm-pi-ai` on alpha and three other
 * harness packages on rc. Compile-time deps made that invisible; the tests below
 * are what make it visible.
 *
 * Three rules, deliberately separate:
 *
 * 1. PINS are exact and name the version a channel's host runs. The root
 *    `package.json` and `pnpm-lock.yaml` install the alpha channel (the
 *    default); `channels/rc/pnpm-lock.yaml` installs rc through
 *    `scripts/use-channel.ts`. Both are records in
 *    `test/support/host-versions.ts` (D22''), and a range would float a pin
 *    onto a version nobody verified.
 * 2. PEERS describe the code, and the code targets the whole `0.2.x` line on
 *    BOTH channels — the latest `rc` and the latest `alpha` alike — because a
 *    host may be running either one. Narrowing a peer range to the channel that
 *    happens to be pinned is the mistake this file exists to catch.
 * 3. pi is the bridge's, at the version npm resolves, UNPATCHED (D14''). The
 *    plugin declares no pi range narrower than the union of the channels'
 *    ranges, and this repository carries no pi patch.
 *
 * `cordis` has its own line. The host vendors it as source at an exact version
 * which may or may not carry a channel tag (`4.0.5`, then `4.0.6-alpha.1`), so
 * the pin is exact either way and its peer range covers the same both-channel
 * spread.
 *
 * @module test/harness-channel
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";

import semver from "semver";
import { describe, expect, it } from "vitest";

import { channelManifest, pinFor } from "../scripts/channel-manifest.ts";
import {
  type Channel,
  CHANNELS,
  DEFAULT_CHANNEL,
  PI_UNION_RANGE,
} from "./support/host-versions.ts";

interface Manifest {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

const PI = "@earendil-works/pi-ai";

const manifestText = (): string => readFileSync("package.json", "utf8");
const manifest = (): Manifest => JSON.parse(manifestText()) as Manifest;

const EXACT = /^\d+\.\d+\.\d+(-[a-z]+\.\d+)?$/u;

const harnessPins = (): [string, string][] =>
  Object.entries({
    ...manifest().dependencies,
    ...manifest().devDependencies,
  }).filter(([name]) => name.startsWith("@deepseek-ai/"));

/**
 * What one committed lockfile resolved: the root importer's direct
 * `@deepseek-ai/*` and pi versions (peer suffix stripped), and every
 * `packages:` key, transitive entries included. Read from the LAST YAML
 * document, the project's (pnpm writes its own package-manager record first).
 */
const lockfile = (path: string) => {
  const text = readFileSync(path, "utf8");
  const project = text.split(/^---$/mu).at(-1) ?? "";
  const importer =
    project.split("\nimporters:\n")[1]?.split("\npackages:\n")[0] ?? "";
  const direct = new Map(
    [
      ...importer.matchAll(
        /^ {6}'?([^'\s]+?)'?:\n {8}specifier: .+\n {8}version: ([^(\n]+)/gmu
      ),
    ].map(([, name, version]) => [name ?? "", version ?? ""] as const)
  );
  const packages =
    project.split("\npackages:\n").at(-1)?.split("\nsnapshots:\n")[0] ?? "";
  const resolved = [
    ...packages.matchAll(/^ {2}'?(@?[^@'\s]+)@([^'(\s]+)'?:/gmu),
  ].map(([, name, version]) => [name ?? "", version ?? ""] as const);
  const versionsOf = (name: string): string[] =>
    resolved.filter(([key]) => key === name).map(([, version]) => version);
  const snapshots = project.split("\nsnapshots:\n").at(-1) ?? "";
  return { direct, project, resolved, snapshots, text, versionsOf };
};

describe("harness channel alignment · declarations", () => {
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

  it("the committed manifest is the default channel's, and every harness package has a channel rule", () => {
    // `channelManifest` is what `scripts/use-channel.ts` installs a channel
    // with; applied to the committed manifest with the default channel's
    // record, it must change nothing. A `@deepseek-ai/*` package with no rule
    // makes it throw, naming the file the rule goes in.
    expect(DEFAULT_CHANNEL).toBe("alpha");
    expect(channelManifest(manifestText(), CHANNELS[DEFAULT_CHANNEL])).toBe(
      manifestText()
    );
    for (const record of Object.values(CHANNELS)) {
      for (const [name] of harnessPins()) {
        expect(pinFor(name, record), name).toMatch(EXACT);
      }
    }
  });

  it("the pins, of both channels, are on a channel the peer range admits", () => {
    // The pin is whatever version the host runs; the range is the surface the
    // code claims. A pin outside its own range would mean the code was compiled
    // against a version it does not admit — the two have to agree for the
    // committed pins and for every channel's record.
    const peers = manifest().peerDependencies ?? {};
    for (const [name, spec] of harnessPins()) {
      const peer = peers[name];
      if (peer === undefined) continue;
      expect(
        semver.satisfies(spec, peer),
        `${name}@${spec} is pinned outside its own peer range ${peer}`
      ).toBe(true);
    }
    const peered = Object.keys(peers).filter((name) =>
      name.startsWith("@deepseek-ai/")
    );
    expect(peered.length).toBeGreaterThan(0);
    for (const [channel, record] of Object.entries(CHANNELS)) {
      for (const name of peered) {
        const pin = pinFor(name, record) ?? "";
        expect(
          semver.satisfies(pin, peers[name] ?? ""),
          `${channel}: ${name}@${pin} is outside the peer range ${peers[name]}`
        ).toBe(true);
      }
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

    // The published builds the code is verified on, plus both channels'
    // records by construction, so a host bump outside the range fails here.
    const admitted = [
      ...new Set([
        // 0.2.1 line, both channels, and the stable release both lead to.
        "0.2.1-alpha.1",
        "0.2.1-alpha.5",
        "0.2.1-rc.1",
        "0.2.1-rc.5",
        "0.2.1",
        // 0.2.2 line, both channels, and its stable release.
        "0.2.2-alpha.2",
        "0.2.2-rc.1",
        "0.2.2",
        ...Object.values(CHANNELS).map((record) => record.dsh),
      ]),
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

  it("declares no pi range narrower than the union of the channels' ranges, and pi at runtime not at all", () => {
    // The bridge brings pi; the plugin declares none at runtime (the Google
    // bridge loads the host's copy). The suite imports pi directly, so it is a
    // devDependency, at the union of both channels' ranges, which is what
    // lets each channel's lockfile pin the version that channel resolves.
    const declared = manifest();
    expect(declared.dependencies?.[PI]).toBeUndefined();
    expect(declared.peerDependencies?.[PI]).toBeUndefined();
    expect(declared.devDependencies?.[PI]).toBe(PI_UNION_RANGE);
    for (const [channel, record] of Object.entries(CHANNELS)) {
      expect(
        semver.subset(record.piRange, PI_UNION_RANGE),
        `${channel}'s ${record.piRange} lies inside ${PI_UNION_RANGE}`
      ).toBe(true);
      // The floor is the range's own floor, which is also the harness's pin.
      expect(semver.minVersion(record.piRange)?.version, channel).toBe(
        record.piFloor
      );
      expect(semver.satisfies(record.pi, record.piRange), channel).toBe(true);
    }
    // The union is the narrowest range that admits every channel's floor.
    expect(
      semver.minVersion(PI_UNION_RANGE)?.version,
      "the union's floor is the lowest channel floor"
    ).toBe(
      Object.values(CHANNELS)
        .map((record) => record.piFloor)
        .toSorted(semver.compare)[0]
    );
  });

  it("carries no pi patch: no patchedDependencies, no pi override, no patch file", () => {
    // D14'': an npm install runs pi unpatched, the harness's patch reaches
    // users only through the desktop app and touches nothing `src` reads
    // (`architecture.test.ts` holds that), and a pnpm patch is keyed to one
    // exact version, so carrying it would break every pi bump.
    const workspace = readFileSync("pnpm-workspace.yaml", "utf8");
    expect(workspace).toContain("overrides:");
    expect(workspace).not.toMatch(/^patchedDependencies:/mu);
    expect(workspace).not.toContain(`"${PI}":`);
    const patches = existsSync("patches") ? readdirSync("patches") : [];
    expect(patches.filter((file) => file.includes("pi-ai"))).toEqual([]);
  });
});

describe.each(Object.keys(CHANNELS) as Channel[])(
  "harness channel alignment · the %s lockfile",
  (channel) => {
    const record = CHANNELS[channel];

    it("exists, and pins every direct harness package to the channel's record", () => {
      const lock = lockfile(record.lockfile);
      // A check that read no entries would otherwise pass by finding nothing.
      const harness = [...lock.direct].filter(([name]) =>
        name.startsWith("@deepseek-ai/")
      );
      expect(harness.length).toBe(harnessPins().length);
      for (const [name, version] of harness) {
        expect(version, name).toBe(pinFor(name, record));
      }
    });

    it("resolves every dsh package in the tree, transitive ones included, to the channel's cluster", () => {
      // The declarations cannot see a transitive dependency: a cluster package
      // nobody here names (`dsh-brand`, `dsh-util-values`, …) pulled in at a
      // second version is exactly the split cluster this file is about.
      const lock = lockfile(record.lockfile);
      const dsh = lock.resolved.filter(([name]) =>
        name.startsWith("@deepseek-ai/dsh-")
      );
      expect(dsh.length).toBeGreaterThan(0);
      expect(
        dsh
          .filter(([, version]) => version !== record.dsh)
          .map(([name, version]) => `${name}@${version}`)
      ).toEqual([]);
      expect(lock.versionsOf("@deepseek-ai/cordis")).toEqual([record.cordis]);
      expect(lock.versionsOf("@deepseek-ai/cordis-plugin-loader")).toEqual([
        record.loader,
      ]);
      // The plugin's one runtime library the cluster also depends on resolves
      // to ONE copy, the channel's: a second copy would leave two of the
      // library the Config schema is built with. On rc that copy is the
      // HOST's line, not the plugin's published pin: `use-channel.ts` repins
      // the plugin's own dependency to the record's `3.18.5`, while the
      // published manifest pins the alpha line, which the rc bridge's `~` range
      // does not admit. So this cell checks the host's schemastery; an rc npm
      // install of the published plugin holds two copies until that pin admits
      // both lines (an open owner decision).
      expect(lock.versionsOf("@deepseek-ai/schemastery")).toEqual([
        record.schemastery,
      ]);
    });

    it("pins pi once, unpatched, at the newest version the bridge's range resolves", () => {
      const lock = lockfile(record.lockfile);
      expect(lock.direct.get(PI)).toBe(record.pi);
      expect(lock.versionsOf(PI)).toEqual([record.pi]);
      const snapshots = [
        ...lock.snapshots.matchAll(/^ {2}'@earendil-works\/pi-ai@([^']+)':/gmu),
      ].map((match) => match[1] ?? "");
      // A snapshot key carries the peer suffix, so a second copy under a
      // different peer context counts as a second copy.
      expect(snapshots).toHaveLength(1);
      expect(snapshots[0]?.startsWith(`${record.pi}(`), snapshots[0]).toBe(
        true
      );
      expect(lock.text).not.toContain("patch_hash");
      expect(lock.text).not.toMatch(/^patchedDependencies:/mu);
    });
  }
);
