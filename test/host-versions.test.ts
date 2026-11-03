/**
 * The install under test is one of the hosts the plugin supports: the
 * channel's `@deepseek-ai` cluster, with pi unpatched at the version an npm
 * install of that channel resolves, or at the range's floor on a floor install
 * (`test/support/host-versions.ts`, `scripts/use-channel.ts`).
 *
 * The cases check the INSTALLED tree against the SELECTED record rather than
 * the declarations alone: a pin that `package.json` states but a stray range
 * defeats would leave a second pi in `node_modules`, and the suite would
 * quietly test that one. What each reads:
 *
 * - the installed tree — the pi `loadHostPi` resolves and its identity with the
 *   root import, and the `package.json` versions under `node_modules`;
 * - the published ranges — this plugin's `peerDependencies` and the installed
 *   wrapper's own pi range, each checked against the versions installed.
 *
 * Each committed lockfile is held to its own record in
 * `test/harness-channel.test.ts`, whichever channel is installed.
 *
 * @module test/host-versions
 */
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import semver from "semver";
import { afterAll, describe, expect, it } from "vitest";

import {
  CHANNELS,
  DEFAULT_CHANNEL,
  installedLockHash,
  MARKER,
  selectedHost,
} from "./support/host-versions.ts";
import { loadHostPi } from "./support/src.ts";

const ROOT = join(import.meta.dirname, "..");
const HOST = selectedHost(process.env, ROOT);
/** How a failure names the install it expected, so it says what to switch. */
const EXPECTED = `${HOST.channel}${HOST.floor ? " --floor" : ""} (from ${HOST.source}; switch with scripts/use-channel.ts)`;

const versionOf = (dir: string): string => {
  const manifest = JSON.parse(
    readFileSync(join(dir, "package.json"), "utf8")
  ) as { version?: string };
  return manifest.version ?? "";
};

const installed = (name: string): string =>
  versionOf(join(ROOT, "node_modules", name));

/** The installed pi's package root, through the root symlink. */
const piRoot = (): string =>
  realpathSync(join(ROOT, "node_modules", "@earendil-works", "pi-ai"));

interface Manifest {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

describe(`host install · ${EXPECTED}`, () => {
  it("the pi the bridge loads at runtime is the channel's", async () => {
    // `loadHostPi` resolves the wrapper and walks up from its real location to
    // the first pi it finds — the copy the wrapper itself would load.
    const pi = await loadHostPi();
    expect(pi).toBeDefined();
    expect(pi?.version, EXPECTED).toBe(HOST.piInstalled);
  });

  it("the root pi the tests import is that same copy", async () => {
    // `loadHostPi` hands pi's function through untouched, so identity proves
    // one module instance — the tests and the bridge read one file.
    const pi = await loadHostPi();
    expect(pi?.getBuiltinModels).toBe(getBuiltinModels);
    expect(versionOf(piRoot()), EXPECTED).toBe(HOST.piInstalled);
    // The link the wrapper's own lookup reaches (the walk `installedPiRoot`
    // takes from its real location) is the root's copy too.
    const wrapper = realpathSync(
      join(ROOT, "node_modules", "@deepseek-ai", "dsh-llm-pi-ai")
    );
    expect(
      realpathSync(join(wrapper, "..", "..", "@earendil-works", "pi-ai"))
    ).toBe(piRoot());
  });

  it("the installed cluster is the channel's, inside this plugin's peer ranges", () => {
    // Every `@deepseek-ai/dsh-*` this repo declares, read from the manifest so
    // a new cluster package is covered without editing this list.
    const manifest = JSON.parse(
      readFileSync(join(ROOT, "package.json"), "utf8")
    ) as Manifest;
    const cluster = Object.keys({
      ...manifest.dependencies,
      ...manifest.devDependencies,
    }).filter((name) => name.startsWith("@deepseek-ai/dsh-"));
    expect(cluster.length).toBeGreaterThan(0);
    for (const name of cluster) {
      expect(installed(name), `${name}, ${EXPECTED}`).toBe(HOST.dsh);
    }
    expect(installed("@deepseek-ai/cordis"), EXPECTED).toBe(HOST.cordis);
    expect(installed("@deepseek-ai/cordis-plugin-loader"), EXPECTED).toBe(
      HOST.loader
    );
    expect(installed("@deepseek-ai/schemastery"), EXPECTED).toBe(
      HOST.schemastery
    );
    // The ranges this plugin publishes admit the host it is tested on: a bump
    // that moves the install outside a peer range would otherwise ship as an
    // install error on exactly the host users run.
    const peers = Object.entries(manifest.peerDependencies ?? {});
    expect(peers.length).toBeGreaterThan(0);
    for (const [name, range] of peers) {
      const version = installed(name);
      expect(
        semver.satisfies(version, range),
        `${name}@${version} vs ${range}`
      ).toBe(true);
    }
  });

  it("the installed bridge declares the channel's pi range, and the installed pi is a legal resolution of it", () => {
    const wrapper = JSON.parse(
      readFileSync(
        join(ROOT, "node_modules/@deepseek-ai/dsh-llm-pi-ai/package.json"),
        "utf8"
      )
    ) as Manifest;
    // Either declaration kind, and one must exist: semver reads an empty range
    // as `*`, so a missing declaration would otherwise pass without a check.
    const range = {
      ...wrapper.peerDependencies,
      ...wrapper.dependencies,
    }["@earendil-works/pi-ai"];
    expect(
      range,
      "dsh-llm-pi-ai no longer declares @earendil-works/pi-ai (dependencies or peerDependencies)"
    ).toBeTruthy();
    expect(range, EXPECTED).toBe(HOST.piRange);
    expect(semver.satisfies(HOST.piInstalled, range ?? ""), range).toBe(true);
  });
});

describe("host install · which record is selected", () => {
  // Driven on a scratch tree, so every branch of the selection is exercised
  // rather than only the one this machine's install takes.
  const scratch = mkdtempSync(join(tmpdir(), "host-select-"));
  afterAll(() => {
    rmSync(scratch, { force: true, recursive: true });
  });
  mkdirSync(join(scratch, "node_modules", ".pnpm"), { recursive: true });
  writeFileSync(join(scratch, "node_modules", ".pnpm", "lock.yaml"), "rc\n");
  const hash = installedLockHash(scratch) ?? "";

  it("defaults to the root lockfile's channel with no marker and no environment", () => {
    rmSync(join(scratch, MARKER), { force: true });
    const host = selectedHost({}, scratch);
    expect([host.channel, host.floor, host.source]).toEqual([
      DEFAULT_CHANNEL,
      false,
      "default",
    ]);
    expect(host.piInstalled).toBe(CHANNELS[DEFAULT_CHANNEL].pi);
  });

  it("follows the marker while the install it describes is still on disk", () => {
    writeFileSync(
      join(scratch, MARKER),
      JSON.stringify({ channel: "rc", floor: true, installed: hash })
    );
    const host = selectedHost({}, scratch);
    expect([host.channel, host.floor, host.source]).toEqual([
      "rc",
      true,
      "marker",
    ]);
    expect(host.piInstalled).toBe(CHANNELS.rc.piFloor);
  });

  it("ignores a marker a later install has outdated", () => {
    writeFileSync(
      join(scratch, MARKER),
      JSON.stringify({ channel: "rc", floor: false, installed: "0".repeat(64) })
    );
    expect(selectedHost({}, scratch).source).toBe("default");
  });

  it("lets DSH_CHANNEL and DSH_PI override the marker, and refuses an unknown channel", () => {
    writeFileSync(
      join(scratch, MARKER),
      JSON.stringify({ channel: "rc", floor: true, installed: hash })
    );
    const host = selectedHost({ DSH_CHANNEL: "alpha" }, scratch);
    expect([host.channel, host.floor, host.source]).toEqual([
      "alpha",
      false,
      "env",
    ]);
    expect(
      selectedHost({ DSH_CHANNEL: "alpha", DSH_PI: "floor" }, scratch)
        .piInstalled
    ).toBe(CHANNELS.alpha.piFloor);
    expect(() => selectedHost({ DSH_CHANNEL: "beta" }, scratch)).toThrow(
      /DSH_CHANNEL=beta names no channel/u
    );
  });
});
