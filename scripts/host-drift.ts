/**
 * The pure half of `scripts/report-host-drift.ts`: what the registry says each
 * harness channel installs today, against the channel records in
 * `test/support/host-versions.ts` (D22'').
 *
 * Drift is read the way the record's fields are defined, never off a
 * package's own dist-tags:
 *
 * - `dsh` is `@deepseek-ai/dsh` at the record's `distTag`;
 * - the bridge (`@deepseek-ai/dsh-llm-pi-ai`, one version with the cluster)
 *   declares the pi range; `pi` is the newest published version it admits,
 *   as npm resolves it (a prerelease only where the range names one on the
 *   same tuple), and `piFloor` is its floor;
 * - each member of the cordis family is the FLOOR of the `~` range the
 *   published cluster declares for it (`FAMILY_DECLARERS`): the version the
 *   harness vendors at the tag and the desktop app ships. `package.json` pins
 *   every member this repository's install resolves (all but the timer plugin,
 *   which nothing here depends on), so each lockfile holds them at that floor
 *   by construction. A newer patch inside the same range is what the
 *   `e2e-host` job's npm cell runs and logs, never a record bump, so the
 *   family moves only when `dsh` does.
 *
 * Every function here is a function of its arguments - the registry's answers
 * are data handed in - so `test/host-drift.test.ts` holds every rule with known
 * answers. The CLI fetches the packuments and prints one warning per line.
 *
 * @module scripts/host-drift
 */
import semver from "semver";

/** The cordis family's record fields (`cordisFamily` in host-versions.ts). */
export type FamilyField =
  | "cordis"
  | "cosmokit"
  | "group"
  | "include"
  | "loader"
  | "schemastery"
  | "timer";

/** The record fields the comparison reads (a subset of `ChannelRecord`). */
export interface DriftRecord extends Readonly<Record<FamilyField, string>> {
  readonly distTag: string;
  readonly dsh: string;
  readonly pi: string;
  readonly piFloor: string;
  readonly piRange: string;
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
  appBoot: "@deepseek-ai/dsh-app-boot",
  bridge: "@deepseek-ai/dsh-llm-pi-ai",
  cordis: "@deepseek-ai/cordis",
  dsh: "@deepseek-ai/dsh",
  pi: "@earendil-works/pi-ai",
} as const;

export type RegistryRole = keyof typeof REGISTRY_PACKAGES;

/** One packument per role: what the registry answered. */
export type RegistryView = Readonly<Record<RegistryRole, Packument>>;

/**
 * Which published package declares each family member's range. The drift
 * report reads each cluster declarer at the `dsh` the channel's dist-tag names
 * today (not the record's, so a new cut's floors are reported before the
 * record moves), and cosmokit's declarer, cordis, at the cordis floor it read
 * just before: cordis comes first, so its floor is known by the time cosmokit
 * is read. The binary e2e reads the same table off the installed host, which
 * is the record's `dsh`.
 */
export const FAMILY_DECLARERS: readonly {
  readonly declarer: "appBoot" | "bridge" | "cordis" | "dsh";
  readonly field: FamilyField;
  readonly name: string;
}[] = [
  { declarer: "bridge", field: "cordis", name: "@deepseek-ai/cordis" },
  {
    declarer: "bridge",
    field: "loader",
    name: "@deepseek-ai/cordis-plugin-loader",
  },
  {
    declarer: "bridge",
    field: "schemastery",
    name: "@deepseek-ai/schemastery",
  },
  {
    declarer: "dsh",
    field: "include",
    name: "@deepseek-ai/cordis-plugin-include",
  },
  { declarer: "dsh", field: "timer", name: "@deepseek-ai/cordis-plugin-timer" },
  {
    declarer: "appBoot",
    field: "group",
    name: "@deepseek-ai/cordis-plugin-group",
  },
  { declarer: "cordis", field: "cosmokit", name: "@deepseek-ai/cosmokit" },
];

/** A manifest's declared ranges, peers and dependencies together. */
export const declaredRanges = (manifest: {
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly peerDependencies?: Readonly<Record<string, string>>;
}): Readonly<Record<string, string | undefined>> => ({
  ...manifest.peerDependencies,
  ...manifest.dependencies,
});

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
 * read (no dist-tag, no declaring package at that version, no declared range,
 * nothing in the pi range) is a line too: "read nothing" must never look like "current".
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
    const declared = declaredRanges(bridge);

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

    const floors: Partial<Record<FamilyField, string>> = {};
    for (const { declarer, field, name } of FAMILY_DECLARERS) {
      const at = declarer === "cordis" ? floors.cordis : tagged;
      const declarerName = REGISTRY_PACKAGES[declarer];
      if (at === undefined) {
        lines.push(
          `${channel}: no ${declarerName} floor was read; ${name} was not compared`
        );
        continue;
      }
      const manifest = registry[declarer].versions?.[at];
      if (manifest === undefined) {
        lines.push(
          `${channel}: ${declarerName}@${at} is not published; ${name} was not compared`
        );
        continue;
      }
      const range = declaredRanges(manifest)[name];
      if (range === undefined) {
        lines.push(`${channel}: ${declarerName}@${at} declares no ${name}`);
        continue;
      }
      const floor = floorOf(range);
      if (floor === undefined) {
        lines.push(
          `${channel}: ${declarerName}@${at} declares ${name} ${range}, which has no floor`
        );
        continue;
      }
      floors[field] = floor;
      if (floor !== record[field]) {
        say(`the floor of ${name} ${range}`, record[field], floor);
      }
    }
  }
  return lines;
};
