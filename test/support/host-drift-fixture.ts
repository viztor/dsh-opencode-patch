/**
 * Registry views for the host-drift rules (`scripts/host-drift.ts`), with
 * known answers: the registry as the channel records describe it, a newer
 * patch inside every recorded range, and the next alpha cut, each read off
 * the records. Shared by the rules' unit file (`test/host-drift.test.ts`) and
 * the CLI's loopback run (`test/mock/host-drift-cli.mock.ts`).
 *
 * @module test/support/host-drift-fixture
 */
import semver from "semver";

import {
  type DriftRecord,
  type Packument,
  REGISTRY_PACKAGES,
  type RegistryView,
} from "../../scripts/host-drift.ts";
import { CHANNELS } from "./host-versions.ts";

export const versions = (...list: string[]): Packument => ({
  versions: Object.fromEntries(list.map((version) => [version, {}])),
});

/**
 * The ranges a channel's published cluster declares for the cordis family:
 * each member's `~` range opens at the record's version, as the harness's own
 * workspace versions do at the tag.
 */
export const declaredBy = (
  record: DriftRecord
): Record<"appBoot" | "bridge" | "cordis" | "dsh", Packument["versions"]> => ({
  appBoot: {
    [record.dsh]: {
      peerDependencies: {
        "@deepseek-ai/cordis-plugin-group": `~${record.group}`,
      },
    },
  },
  bridge: {
    [record.dsh]: {
      dependencies: {
        [REGISTRY_PACKAGES.pi]: record.piRange,
        "@deepseek-ai/schemastery": `~${record.schemastery}`,
      },
      peerDependencies: {
        [REGISTRY_PACKAGES.cordis]: `~${record.cordis}`,
        "@deepseek-ai/cordis-plugin-loader": `~${record.loader}`,
      },
    },
  },
  cordis: {
    [record.cordis]: {
      dependencies: { "@deepseek-ai/cosmokit": `~${record.cosmokit}` },
    },
  },
  dsh: {
    [record.dsh]: {
      dependencies: {
        "@deepseek-ai/cordis-plugin-include": `~${record.include}`,
        "@deepseek-ai/cordis-plugin-timer": `~${record.timer}`,
      },
    },
  },
});

/**
 * The registry exactly as the records describe it: each channel's dsh under
 * its dist-tag, its cluster at that version declaring the record's ranges,
 * cordis at the record's version declaring cosmokit's, and every recorded pi
 * published.
 */
export const registryOf = (
  records: Readonly<Record<string, DriftRecord>>
): RegistryView => {
  const all = Object.values(records);
  const merged = (role: keyof ReturnType<typeof declaredBy>): Packument => ({
    versions: Object.assign(
      {},
      ...all.map((record) => declaredBy(record)[role])
    ),
  });
  return {
    appBoot: merged("appBoot"),
    bridge: merged("bridge"),
    cordis: merged("cordis"),
    dsh: {
      "dist-tags": Object.fromEntries(
        all.map((record) => [record.distTag, record.dsh])
      ),
      ...merged("dsh"),
    },
    pi: versions(
      ...all.flatMap((record) => [record.pi, record.piFloor]),
      // Never the newest 1.x: a prerelease and the next major.
      "1.99.0-beta.1",
      "2.0.0"
    ),
  };
};

/**
 * The next prerelease of a recorded version (`4.0.6-alpha.2` to
 * `4.0.6-alpha.3`), read off the record so the fixtures below keep their
 * meaning across a channel bump instead of going stale with it.
 */
export const nextPrerelease = (version: string): string => {
  const next = semver.inc(version, "prerelease");
  if (next === null) {
    throw new Error(`no next prerelease for ${version}`);
  }
  return next;
};

/** The alpha channel's next cut: dsh and every cordis-family floor moved. */
export const NEXT_ALPHA: DriftRecord = {
  ...CHANNELS.alpha,
  cordis: nextPrerelease(CHANNELS.alpha.cordis),
  cosmokit: nextPrerelease(CHANNELS.alpha.cosmokit),
  dsh: nextPrerelease(CHANNELS.alpha.dsh),
  group: nextPrerelease(CHANNELS.alpha.group),
  include: nextPrerelease(CHANNELS.alpha.include),
  loader: nextPrerelease(CHANNELS.alpha.loader),
  schemastery: nextPrerelease(CHANNELS.alpha.schemastery),
  timer: nextPrerelease(CHANNELS.alpha.timer),
};

/**
 * `view` with the cluster published at `version` too, declaring exactly the
 * ranges `record`'s cluster does: dsh, the app boot and the bridge.
 */
export const withCut = (
  view: RegistryView,
  record: DriftRecord,
  version: string
): RegistryView => {
  const same = declaredBy({ ...record, dsh: version });
  return {
    ...view,
    appBoot: { versions: { ...view.appBoot.versions, ...same.appBoot } },
    bridge: { versions: { ...view.bridge.versions, ...same.bridge } },
    dsh: { ...view.dsh, versions: { ...view.dsh.versions, ...same.dsh } },
  };
};

/**
 * The registry with a newer patch inside every `~` range the recorded
 * clusters declare (each family member at the next prerelease, and cordis's
 * next patch declaring the next cosmokit), while the clusters themselves
 * still declare the recorded floors.
 */
export const PATCHED: RegistryView = (() => {
  const base = registryOf(CHANNELS);
  return {
    ...base,
    cordis: {
      versions: {
        ...base.cordis.versions,
        ...declaredBy(NEXT_ALPHA).cordis,
      },
    },
  };
})();

/** The next alpha cut: dsh moved, and its cluster's ranges open one later. */
export const ALPHA_NEXT: RegistryView = (() => {
  const declared = declaredBy(NEXT_ALPHA);
  return {
    ...PATCHED,
    appBoot: {
      versions: { ...PATCHED.appBoot.versions, ...declared.appBoot },
    },
    bridge: { versions: { ...PATCHED.bridge.versions, ...declared.bridge } },
    dsh: {
      "dist-tags": {
        alpha: NEXT_ALPHA.dsh,
        [CHANNELS.rc.distTag]: CHANNELS.rc.dsh,
      },
      versions: { ...PATCHED.dsh.versions, ...declared.dsh },
    },
  };
})();
