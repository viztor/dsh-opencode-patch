/**
 * The pure half of `scripts/use-channel.ts`: the manifest and workspace text a
 * channel's install reads, as functions of the committed text and the
 * channel's record (`test/support/host-versions.ts`). No I/O, so every rule is
 * a unit test (`test/use-channel.test.ts`).
 *
 * @module scripts/channel-manifest
 */
import { parseAllDocuments } from "yaml";

/** The fields of a channel record the manifest rewrite reads. */
export interface ChannelPins {
  readonly cordis: string;
  readonly cosmokit: string;
  readonly dsh: string;
  readonly group: string;
  readonly include: string;
  readonly loader: string;
  readonly schemastery: string;
}

/**
 * The cordis-family members the manifest pins only so a fresh resolve holds
 * them at the record's floors: include and group arrive as peers pnpm
 * installs itself and cosmokit as a dependency of cordis, so without a direct
 * pin a relock takes the newest patch each `~` range admits. pnpm resolves
 * those peers from the root's direct dependencies and dedupes the dependency
 * onto the direct pin.
 */
const FAMILY_PINS: Readonly<Record<string, "cosmokit" | "group" | "include">> =
  {
    "@deepseek-ai/cordis-plugin-group": "group",
    "@deepseek-ai/cordis-plugin-include": "include",
    "@deepseek-ai/cosmokit": "cosmokit",
  };

const PI = "@earendil-works/pi-ai";

/**
 * The version a channel pins one `@deepseek-ai/*` package to, or undefined for
 * a package no rule covers (the caller refuses it rather than guessing).
 */
export const pinFor = (name: string, pins: ChannelPins): string | undefined => {
  // The plugin's own runtime pin moves with the channel too, so a channel's
  // lockfile holds one coherent cluster. On rc that means the install runs the
  // host's schemastery line, not the one the published manifest pins.
  if (name === "@deepseek-ai/schemastery") {
    return pins.schemastery;
  }
  if (name === "@deepseek-ai/cordis") {
    return pins.cordis;
  }
  if (name === "@deepseek-ai/cordis-plugin-loader") {
    return pins.loader;
  }
  const member = FAMILY_PINS[name];
  if (member !== undefined) {
    return pins[member];
  }
  return name.startsWith("@deepseek-ai/dsh-") ? pins.dsh : undefined;
};

interface Manifest {
  [key: string]: unknown;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

const repin = (
  section: Record<string, string> | undefined,
  pins: ChannelPins
): Record<string, string> | undefined => {
  if (section === undefined) {
    return undefined;
  }
  return Object.fromEntries(
    Object.entries(section).map(([name, spec]) => {
      if (!name.startsWith("@deepseek-ai/")) {
        return [name, spec];
      }
      const pin = pinFor(name, pins);
      if (pin === undefined) {
        throw new Error(
          `${name} has no channel rule in scripts/channel-manifest.ts pinFor; add one`
        );
      }
      return [name, pin];
    })
  );
};

/**
 * `package.json` as the channel installs it: every `@deepseek-ai/*`
 * dependency on the channel's pin, everything else (pi's range included)
 * untouched. Key order and the trailing newline are kept, so the alpha
 * record applied to the committed manifest is the committed manifest.
 */
export const channelManifest = (text: string, pins: ChannelPins): string => {
  const manifest = JSON.parse(text) as Manifest;
  const next: Manifest = { ...manifest };
  const dependencies = repin(manifest.dependencies, pins);
  const devDependencies = repin(manifest.devDependencies, pins);
  if (dependencies !== undefined) {
    next.dependencies = dependencies;
  }
  if (devDependencies !== undefined) {
    next.devDependencies = devDependencies;
  }
  return `${JSON.stringify(next, null, 2)}\n`;
};

/**
 * `pnpm-workspace.yaml` with every pi in the tree held to `version`: one
 * override line under the existing `overrides:` key. Refuses a workspace that
 * already overrides pi (the floor would be ambiguous) or has no single
 * `overrides:` key to extend.
 */
export const workspaceWithPi = (text: string, version: string): string => {
  if (text.includes(`"${PI}":`)) {
    throw new Error(`pnpm-workspace.yaml already overrides ${PI}`);
  }
  const key = /^overrides:\n/gmu;
  const found = text.match(key) ?? [];
  if (found.length !== 1) {
    throw new Error(
      `pnpm-workspace.yaml needs exactly one top-level overrides: key, found ${found.length}`
    );
  }
  return text.replaceAll(key, `overrides:\n  "${PI}": "${version}"\n`);
};

const HOST_SCOPE = "@deepseek-ai/";

/** A lockfile key or importer name that belongs to the harness cluster. */
const isHostKey = (key: unknown): boolean =>
  typeof key === "string" &&
  (key.startsWith(HOST_SCOPE) || key.startsWith(`'${HOST_SCOPE}`));

/**
 * The lockfile a `--relock` starts from: the given one with every
 * `@deepseek-ai/*` entry removed (the root importer's, and every `packages:`
 * and `snapshots:` key), so pnpm resolves the whole cluster afresh for the
 * channel's pins, peers included, while every other package keeps the
 * version it already has. Starting from the alpha lockfile as it stands would
 * keep alpha's optional peers (`cordis-plugin-include`, `-group`) and their
 * dependencies where a fresh rc install resolves the stable lines.
 */
export const withoutHostPackages = (text: string): string =>
  parseAllDocuments(text)
    .map((doc) => {
      const sections: (readonly string[])[] = [
        ["importers", ".", "dependencies"],
        ["importers", ".", "devDependencies"],
        ["importers", ".", "optionalDependencies"],
        ["packages"],
        ["snapshots"],
      ];
      for (const section of sections) {
        const map = doc.getIn(section) as
          | { items?: { key: { value?: unknown } }[] }
          | undefined;
        // Collected first: deleting from the map while walking it skips items.
        const doomed = (map?.items ?? [])
          .map((item) => item.key.value)
          .filter((key) => isHostKey(key));
        for (const key of doomed) {
          doc.deleteIn([...section, key]);
        }
      }
      return doc.toString({ lineWidth: 0 });
    })
    .join("");
