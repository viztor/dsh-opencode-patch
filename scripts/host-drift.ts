/**
 * The pure half of `scripts/report-host-drift.ts`: what the registry says each
 * harness channel installs today, against the channel records in
 * `test/support/host-versions.ts` (D22'').
 *
 * A record names what an npm install of the channel resolves, so drift is
 * read the way npm resolves it, never off a package's own dist-tags:
 *
 * - `dsh` is `@deepseek-ai/dsh` at the record's `distTag`;
 * - the bridge (`@deepseek-ai/dsh-llm-pi-ai`, one version with the cluster)
 *   declares the pi range and the cordis, loader and schemastery ranges, and
 *   each of those is the newest published version the range admits (a
 *   prerelease only where the range names one on the same tuple, as npm
 *   does);
 * - `piFloor` is the pi range's own floor.
 *
 * Every function here is a function of its arguments - the registry's answers
 * are data handed in - so `test/host-drift.test.ts` holds every rule with known
 * answers. The CLI fetches the packuments and prints one warning per line.
 *
 * @module scripts/host-drift
 */
import semver from "semver";

/** The record fields the comparison reads (a subset of `ChannelRecord`). */
export interface DriftRecord {
  readonly cordis: string;
  readonly distTag: string;
  readonly dsh: string;
  readonly loader: string;
  readonly pi: string;
  readonly piFloor: string;
  readonly piRange: string;
  readonly schemastery: string;
}

/** The slice of an npm packument (abbreviated or full) the comparison reads. */
export interface Packument {
  readonly "dist-tags"?: Readonly<Record<string, string>>;
  readonly versions?: Readonly<
    Record<
      string,
      {
        readonly dependencies?: Readonly<Record<string, string>>;
        readonly peerDependencies?: Readonly<Record<string, string>>;
      }
    >
  >;
}

/** The packages the CLI fetches, by the role each plays in a record. */
export const REGISTRY_PACKAGES = {
  bridge: "@deepseek-ai/dsh-llm-pi-ai",
  cordis: "@deepseek-ai/cordis",
  dsh: "@deepseek-ai/dsh",
  loader: "@deepseek-ai/cordis-plugin-loader",
  pi: "@earendil-works/pi-ai",
  schemastery: "@deepseek-ai/schemastery",
} as const;

export type RegistryRole = keyof typeof REGISTRY_PACKAGES;

/** One packument per role: what the registry answered. */
export type RegistryView = Readonly<Record<RegistryRole, Packument>>;

/** The roles whose version follows a range the bridge declares. */
const RESOLVED: readonly ("cordis" | "loader" | "schemastery")[] = [
  "cordis",
  "loader",
  "schemastery",
];

/** The newest published version `range` admits, as npm resolves it. */
export const newestIn = (
  packument: Packument,
  range: string
): string | undefined =>
  semver.maxSatisfying(Object.keys(packument.versions ?? {}), range) ??
  undefined;

/** A range's floor: the lowest version it could ever admit. */
export const floorOf = (range: string): string | undefined =>
  semver.validRange(range) === null
    ? undefined
    : (semver.minVersion(range)?.version ?? undefined);

/**
 * One line per field where the registry and a channel's record disagree, each
 * naming the channel, the field, the record's value and the registry's. An
 * empty list means every record is current. A registry answer that cannot be
 * read (no dist-tag, no bridge at that version, no declared range, nothing in
 * the range) is a line too: "read nothing" must never look like "current".
 */
export const hostDrift = (
  records: Readonly<Record<string, DriftRecord>>,
  registry: RegistryView
): string[] => {
  const lines: string[] = [];
  for (const [channel, record] of Object.entries(records)) {
    const say = (field: string, recorded: string, found: string): void => {
      lines.push(
        `${channel}: ${field} is ${found} on the registry; the record says ${recorded}`
      );
    };
    const tagged = registry.dsh["dist-tags"]?.[record.distTag];
    if (tagged === undefined) {
      lines.push(
        `${channel}: ${REGISTRY_PACKAGES.dsh} has no '${record.distTag}' dist-tag; nothing compared`
      );
      continue;
    }
    if (tagged !== record.dsh) {
      say(`${REGISTRY_PACKAGES.dsh}@${record.distTag}`, record.dsh, tagged);
    }
    const bridge = registry.bridge.versions?.[tagged];
    if (bridge === undefined) {
      lines.push(
        `${channel}: ${REGISTRY_PACKAGES.bridge}@${tagged} is not published; the ranges were not compared`
      );
      continue;
    }
    const declared = {
      ...bridge.peerDependencies,
      ...bridge.dependencies,
    } as Readonly<Record<string, string | undefined>>;

    const piRange = declared[REGISTRY_PACKAGES.pi];
    if (piRange === undefined) {
      lines.push(
        `${channel}: ${REGISTRY_PACKAGES.bridge}@${tagged} declares no ${REGISTRY_PACKAGES.pi}`
      );
    } else {
      if (piRange !== record.piRange) {
        say("the bridge's pi range", record.piRange, piRange);
      }
      const floor = floorOf(piRange);
      if (floor !== undefined && floor !== record.piFloor) {
        say("the pi range's floor", record.piFloor, floor);
      }
      const pi = newestIn(registry.pi, piRange);
      if (pi === undefined) {
        lines.push(
          `${channel}: no published ${REGISTRY_PACKAGES.pi} satisfies ${piRange}`
        );
      } else if (pi !== record.pi) {
        say(`the newest pi ${piRange} resolves`, record.pi, pi);
      }
    }

    for (const role of RESOLVED) {
      const name = REGISTRY_PACKAGES[role];
      const range = declared[name];
      if (range === undefined) {
        lines.push(
          `${channel}: ${REGISTRY_PACKAGES.bridge}@${tagged} declares no ${name}`
        );
        continue;
      }
      const found = newestIn(registry[role], range);
      if (found === undefined) {
        lines.push(`${channel}: no published ${name} satisfies ${range}`);
      } else if (found !== record[role]) {
        say(`${name} (${range})`, record[role], found);
      }
    }
  }
  return lines;
};
