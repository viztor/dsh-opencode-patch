/**
 * The hosts this plugin supports, named once: the latest release of BOTH
 * harness channels, as each one actually ships (D14'', D22'').
 *
 * - `rc` is the newest build on the rc line, which the harness publishes
 *   under `next` ahead of `latest` (today `dsh@next`); `alpha` is
 *   `@deepseek-ai/dsh@alpha`. Both run the host core cordis 4.0.6-alpha.2
 *   and 4.1.0 share.
 *   Each record names the `@deepseek-ai` cluster's tag and the cordis family
 *   the published host installs (`cordisFamily`: cordis, its loader, include,
 *   group and timer plugins, cosmokit and schemastery), each at the FLOOR of
 *   the `~` range the published cluster declares for it. That floor is the
 *   version the harness vendors at the channel's tag, the tree the desktop app
 *   ships, and what the `e2e-host` job's floor cell forces. `package.json`
 *   pins every member this repository's install resolves (all but the timer
 *   plugin, which nothing here depends on; `pinFor` moves each with the
 *   channel), so each committed lockfile holds them at that floor by
 *   construction, a relock included. A newer patch inside the same range is
 *   what an npm install resolves; only the e2e-host npm cell runs it, and it
 *   never moves the record: the family moves only with `dsh`, to the new
 *   tag's floors (`scripts/host-drift.ts` reads them off the registry).
 * - `piRange` is the range the bridge (`dsh-llm-pi-ai`) declares. Nothing in
 *   the published packages narrows it: no shrinkwrap, no bundled copy, no
 *   install script and no runtime version check, so an npm install runs pi
 *   UNPATCHED at the newest 1.x the range admits. That version is `pi`, and the
 *   channel's committed lockfile pins it (`lockfile`).
 * - `piFloor` is the range's floor, which is also the pi the harness's own
 *   workspace pins at the channel's tag (and patches; only the desktop app
 *   ships that copy). `scripts/use-channel.ts <channel> --floor` installs it,
 *   unpatched, for a local run; it is never committed.
 *
 * This repository carries no pi patch: the harness's patch touches only
 * streamed tool-call arguments and thought signatures, which no `src` module
 * reads (`test/architecture.test.ts` holds that), and a pnpm patch is keyed to
 * one exact version, so carrying it would break every pi bump.
 *
 * Which install is under test is `selectedHost()`: `DSH_CHANNEL` (and
 * `DSH_PI=floor`) when set, else the marker `scripts/use-channel.ts` leaves in
 * `node_modules` while the install it describes is still the one on disk, else
 * the root lockfile's channel, alpha. `test/host-versions.test.ts` checks the
 * installed tree against that record; `test/harness-channel.test.ts` checks
 * the declarations and holds each committed lockfile to its own record.
 *
 * @module test/support/host-versions
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** The two harness distribution channels, by their npm dist-tags' role. */
export type Channel = "alpha" | "rc";

/**
 * The dist-tags a record may name. The nightly bump proposal reads this list:
 * a channel whose newest build moved under any other tag is a reviewed change
 * (`range`), since writing the tag would fail this type.
 */
export const RECORD_TAGS = ["alpha", "latest", "next"] as const;

export interface ChannelRecord {
  /** `@deepseek-ai/cordis`, the floor of the bridge's `~` range. */
  readonly cordis: string;
  /** `@deepseek-ai/cosmokit`, the floor of the range `cordis` declares. */
  readonly cosmokit: string;
  /**
   * The npm dist-tag that carries the recorded `@deepseek-ai/dsh` today. The
   * rc line publishes its newest build under `next` ahead of `latest`, so the
   * drift report reads the newest build on the record's line under any tag
   * (`channelBuild` in `scripts/host-drift.ts`), this one included.
   */
  readonly distTag: (typeof RECORD_TAGS)[number];
  /** The `@deepseek-ai/dsh-*` cluster's version. */
  readonly dsh: string;
  /**
   * The dist-tag a stable release of this record's line is published under,
   * when it graduates: `latest` for rc, whose `0.2.2-rc.N` builds lead to
   * `0.2.2` there. Absent for alpha, whose `alpha` tag keeps carrying alpha
   * builds, so the drift report never reads a stable release against it.
   */
  readonly graduatesUnder?: "latest";
  /** `@deepseek-ai/cordis-plugin-group`, the floor of dsh-app-boot's range. */
  readonly group: string;
  /** `@deepseek-ai/cordis-plugin-include`, the floor of dsh's range. */
  readonly include: string;
  /** `@deepseek-ai/cordis-plugin-loader`, the floor of the bridge's range. */
  readonly loader: string;
  /** The committed lockfile that pins this channel, from the repo root. */
  readonly lockfile: string;
  /** The newest pi `piRange` resolves: what an npm install runs today. */
  readonly pi: string;
  /** `piRange`'s floor: the pi the harness's own workspace pins at the tag. */
  readonly piFloor: string;
  /** The pi range the bridge, `dsh-llm-pi-ai`, declares. */
  readonly piRange: string;
  /** `@deepseek-ai/schemastery`, the floor of the bridge's `~` range. */
  readonly schemastery: string;
  /**
   * `@deepseek-ai/cordis-plugin-timer`, the floor of `@deepseek-ai/dsh`'s
   * range. The only family member this repository's own install does not
   * resolve, so no lockfile holds it: the nightly drift report holds it to the
   * range the published dsh declares, and the binary e2e to the range the
   * installed dsh declares.
   */
  readonly timer: string;
}

export const CHANNELS: Readonly<Record<Channel, ChannelRecord>> = {
  alpha: {
    cordis: "4.0.6-alpha.2",
    cosmokit: "1.8.7-alpha.2",
    distTag: "alpha",
    dsh: "0.2.2-alpha.3",
    group: "1.0.6-alpha.2",
    include: "1.0.11-alpha.2",
    loader: "1.0.7-alpha.2",
    lockfile: "pnpm-lock.yaml",
    pi: "1.5.2",
    piFloor: "1.3.0",
    piRange: "^1.3.0",
    schemastery: "3.18.6-alpha.2",
    timer: "1.1.8-alpha.2",
  },
  rc: {
    cordis: "4.1.0",
    cosmokit: "1.9.0",
    distTag: "next",
    dsh: "0.2.2-rc.2",
    graduatesUnder: "latest",
    group: "1.1.0",
    include: "1.1.0",
    loader: "1.1.0",
    lockfile: "channels/rc/pnpm-lock.yaml",
    pi: "1.5.2",
    piFloor: "1.3.0",
    piRange: "^1.3.0",
    schemastery: "3.19.0",
    timer: "1.2.0",
  },
};

/**
 * The cordis family the published host installs, by package name, at the
 * record's versions (the declared ranges' floors): cordis, its loader,
 * include, group and timer plugins, cosmokit and schemastery. They are
 * released together and peer on one another by `~` ranges, so forcing one of
 * them alone (cordis, say) leaves a tree nobody ships.
 *
 * @param record - a channel's record.
 * @returns `{ "<package>": "<version>" }` for every family member.
 */
export const cordisFamily = (
  record: ChannelRecord
): Readonly<Record<string, string>> => ({
  "@deepseek-ai/cordis": record.cordis,
  "@deepseek-ai/cordis-plugin-group": record.group,
  "@deepseek-ai/cordis-plugin-include": record.include,
  "@deepseek-ai/cordis-plugin-loader": record.loader,
  "@deepseek-ai/cordis-plugin-timer": record.timer,
  "@deepseek-ai/cosmokit": record.cosmokit,
  "@deepseek-ai/schemastery": record.schemastery,
});

/**
 * The npm `overrides` the `e2e-host` job's floor cell installs the published
 * host with: the channel's cordis family at the record's versions (the
 * declared ranges' floors) and pi at the bridge range's floor, with the
 * telemetry package pi ships beside it at the same version, which is the tree
 * the desktop app ships (its pi patched there, not here). pi-ai `1.1.0`
 * declares its telemetry `^1.1.0` and would float it; from `1.3.0` pi pins
 * the pair exactly. The npm cell takes no override.
 *
 * @param record - a channel's record.
 * @returns the overrides, keyed by package name.
 */
export const floorOverrides = (
  record: ChannelRecord
): Readonly<Record<string, string>> => ({
  ...cordisFamily(record),
  "@earendil-works/pi-ai": record.piFloor,
  "@earendil-works/pi-telemetry": record.piFloor,
});

/** The channel the root `package.json` and `pnpm-lock.yaml` install. */
export const DEFAULT_CHANNEL: Channel = "alpha";

/** The pi range the plugin itself may declare: the union of both channels'. */
export const PI_UNION_RANGE = "^1.3.0";

/** Where `scripts/use-channel.ts` records what it installed. */
export const MARKER = join("node_modules", ".dsh-channel.json");

/** The copy of the lockfile pnpm keeps for what is actually installed. */
const INSTALLED_LOCK = join("node_modules", ".pnpm", "lock.yaml");

export interface SelectedHost extends ChannelRecord {
  readonly channel: Channel;
  /** Whether pi sits at the range's floor rather than its newest version. */
  readonly floor: boolean;
  /** The pi this install runs: `piFloor` on a floor install, else `pi`. */
  readonly piInstalled: string;
  /** Where the selection came from, for a failure message. */
  readonly source: "default" | "env" | "marker";
}

export interface Marker {
  readonly channel: Channel;
  readonly floor: boolean;
  /** sha256 of `node_modules/.pnpm/lock.yaml` right after the switch. */
  readonly installed: string;
}

export const isChannel = (value: unknown): value is Channel =>
  value === "alpha" || value === "rc";

/** sha256 of the installed-lockfile copy, or undefined when there is none. */
export const installedLockHash = (root: string): string | undefined => {
  try {
    return createHash("sha256")
      .update(readFileSync(join(root, INSTALLED_LOCK)))
      .digest("hex");
  } catch {
    return undefined;
  }
};

const readMarker = (root: string): Marker | undefined => {
  try {
    const marker = JSON.parse(
      readFileSync(join(root, MARKER), "utf8")
    ) as Partial<Marker>;
    if (
      isChannel(marker.channel) &&
      typeof marker.floor === "boolean" &&
      typeof marker.installed === "string"
    ) {
      return marker as Marker;
    }
  } catch {
    // No marker: the root install.
  }
  return undefined;
};

const select = (
  channel: Channel,
  floor: boolean,
  source: SelectedHost["source"]
): SelectedHost => {
  const record = CHANNELS[channel];
  return {
    ...record,
    channel,
    floor,
    piInstalled: floor ? record.piFloor : record.pi,
    source,
  };
};

/**
 * The host record the install under test is expected to match.
 *
 * A pure function of the environment and the tree it is handed, so a test can
 * drive every branch. A marker whose install hash no longer matches the tree
 * is ignored: a plain `pnpm install` since the switch put the root channel
 * back, and the marker would otherwise name a channel that is not installed.
 */
export const selectedHost = (
  env: Readonly<Record<string, string | undefined>> = process.env,
  root: string = process.cwd()
): SelectedHost => {
  const fromEnv = env.DSH_CHANNEL;
  if (fromEnv !== undefined && fromEnv !== "") {
    if (!isChannel(fromEnv)) {
      throw new Error(
        `DSH_CHANNEL=${fromEnv} names no channel; use one of ${Object.keys(CHANNELS).join(", ")}`
      );
    }
    return select(fromEnv, env.DSH_PI === "floor", "env");
  }
  const marker = readMarker(root);
  if (marker !== undefined && marker.installed === installedLockHash(root)) {
    return select(marker.channel, marker.floor, "marker");
  }
  return select(DEFAULT_CHANNEL, false, "default");
};

/**
 * The selected install's versions in the shape the suite reads them: `pi` is
 * the pi this install runs (`piInstalled`). Resolved once, when the module
 * loads, from the process's own environment and working directory.
 */
export const HOST_VERSIONS = ((): {
  readonly channel: Channel;
  readonly cordis: string;
  readonly dsh: string;
  readonly floor: boolean;
  readonly loader: string;
  readonly pi: string;
} => {
  const host = selectedHost();
  return {
    channel: host.channel,
    cordis: host.cordis,
    dsh: host.dsh,
    floor: host.floor,
    loader: host.loader,
    pi: host.piInstalled,
  };
})();
