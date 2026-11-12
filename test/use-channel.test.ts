/**
 * The pure half of the channel switch (`scripts/channel-manifest.ts`): the
 * manifest a channel installs, the floor override and the lockfile a
 * `--relock` starts from, as functions of text.
 *
 * @module test/use-channel
 */
import { describe, expect, it } from "vitest";
import { parseAllDocuments } from "yaml";

import {
  channelManifest,
  pinFor,
  withoutHostPackages,
  workspaceWithPi,
} from "../scripts/channel-manifest.ts";
import { CHANNELS } from "./support/host-versions.ts";

// The default channel's manifest, read off its record rather than dated
// literals, so the identity case below stays a property of `channelManifest`
// across a channel bump instead of a pin that every bump has to re-date.
const MANIFEST = `${JSON.stringify(
  {
    name: "x",
    dependencies: { "@deepseek-ai/schemastery": CHANNELS.alpha.schemastery },
    devDependencies: {
      "@deepseek-ai/cordis": CHANNELS.alpha.cordis,
      "@deepseek-ai/cordis-plugin-loader": CHANNELS.alpha.loader,
      "@deepseek-ai/dsh-llm-pi-ai": CHANNELS.alpha.dsh,
      "@earendil-works/pi-ai": "^1.1.0",
      semver: "^7.8.0",
    },
  },
  null,
  2
)}\n`;

describe("channel switch · the manifest a channel installs", () => {
  it("moves every @deepseek-ai package to the rc record and leaves the rest alone", () => {
    const rc = JSON.parse(channelManifest(MANIFEST, CHANNELS.rc)) as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
      name: string;
    };
    expect(rc.name).toBe("x");
    expect(rc.dependencies).toEqual({
      "@deepseek-ai/schemastery": CHANNELS.rc.schemastery,
    });
    expect(rc.devDependencies).toEqual({
      "@deepseek-ai/cordis": CHANNELS.rc.cordis,
      "@deepseek-ai/cordis-plugin-loader": CHANNELS.rc.loader,
      "@deepseek-ai/dsh-llm-pi-ai": CHANNELS.rc.dsh,
      "@earendil-works/pi-ai": "^1.1.0",
      semver: "^7.8.0",
    });
  });

  it("is the identity for the channel the manifest already pins, formatting included", () => {
    expect(channelManifest(MANIFEST, CHANNELS.alpha)).toBe(MANIFEST);
  });

  it("refuses a harness package no rule covers instead of guessing its pin", () => {
    // The timer plugin is the one family member nothing here resolves, so
    // the manifest never pins it and no rule covers it.
    const stray = MANIFEST.replace(
      '"semver"',
      '"@deepseek-ai/cordis-plugin-timer": "1.1.8-alpha.1",\n    "semver"'
    );
    expect(() => channelManifest(stray, CHANNELS.rc)).toThrow(
      /@deepseek-ai\/cordis-plugin-timer has no channel rule/u
    );
    expect(
      pinFor("@deepseek-ai/cordis-plugin-timer", CHANNELS.rc)
    ).toBeUndefined();
  });

  it("moves the family members pinned only to hold their floors with the channel", () => {
    // include, group and cosmokit arrive transitively; the manifest pins them
    // so a relock cannot take a newer patch inside their `~` ranges.
    for (const record of [CHANNELS.alpha, CHANNELS.rc]) {
      expect(pinFor("@deepseek-ai/cordis-plugin-include", record)).toBe(
        record.include
      );
      expect(pinFor("@deepseek-ai/cordis-plugin-group", record)).toBe(
        record.group
      );
      expect(pinFor("@deepseek-ai/cosmokit", record)).toBe(record.cosmokit);
    }
    // Known answer: the two records differ, so the rule reads the record.
    expect(CHANNELS.rc.cosmokit).not.toBe(CHANNELS.alpha.cosmokit);
  });
});

describe("channel switch · the floor override", () => {
  const WORKSPACE =
    'catalog:\n  vite-plus: 1.4.0\noverrides:\n  vite@*: "catalog:"\n';

  it("holds every pi in the tree to one version with one override line", () => {
    expect(workspaceWithPi(WORKSPACE, "1.1.0")).toBe(
      'catalog:\n  vite-plus: 1.4.0\noverrides:\n  "@earendil-works/pi-ai": "1.1.0"\n  vite@*: "catalog:"\n'
    );
  });

  it("refuses a workspace that already overrides pi, or has no single overrides key", () => {
    expect(() =>
      workspaceWithPi(workspaceWithPi(WORKSPACE, "1.1.0"), "1.3.0")
    ).toThrow(/already overrides/u);
    expect(() => workspaceWithPi("catalog: {}\n", "1.1.0")).toThrow(/found 0/u);
  });
});

describe("channel switch · the lockfile a relock starts from", () => {
  // pnpm's real shape: its own package-manager record first, then the
  // project document. Host keys come quoted (the scope's `@` forces it), one
  // snapshot key carries a peer suffix, and a non-host package names a host
  // peer inside its own sub-map, which is not a key the strip may touch.
  const PNPM_DOCUMENT = `---
lockfileVersion: '9.0'

importers:

  .:
    packageManagerDependencies:
      pnpm:
        specifier: 12.16.1
        version: 12.16.1

packages:

  '@pnpm/exe@12.16.1':
    resolution: {integrity: sha512-pnpm}

`;
  const LOCK = `${PNPM_DOCUMENT}---
lockfileVersion: '9.0'

importers:

  .:
    dependencies:
      '@deepseek-ai/schemastery':
        specifier: 3.18.6-alpha.1
        version: 3.18.6-alpha.1
      yaml:
        specifier: 2.9.1
        version: 2.9.1
    devDependencies:
      '@deepseek-ai/cordis':
        specifier: 4.0.6-alpha.1
        version: 4.0.6-alpha.1
      '@earendil-works/pi-ai':
        specifier: ^1.1.0
        version: 1.5.0
    optionalDependencies:
      '@deepseek-ai/cordis-plugin-include':
        specifier: 1.0.11-alpha.1
        version: 1.0.11-alpha.1

packages:

  '@deepseek-ai/cordis@4.0.6-alpha.1':
    resolution: {integrity: sha512-cordis}

  '@earendil-works/pi-ai@1.5.0':
    resolution: {integrity: sha512-pi}

  yaml@2.9.1:
    resolution: {integrity: sha512-yaml}

snapshots:

  '@deepseek-ai/cordis@4.0.6-alpha.1(@deepseek-ai/cordis-plugin-loader@1.0.7-alpha.1)':
    dependencies:
      '@deepseek-ai/cosmokit': 1.8.7-alpha.1

  '@earendil-works/pi-ai@1.5.0':
    dependencies:
      yaml: 2.9.1

  node-addon-require-builtin@0.1.9:
    peerDependencies:
      '@deepseek-ai/cordis': 4.0.6-alpha.1

  yaml@2.9.1: {}
`;
  const SECTIONS = [
    ["importers", ".", "dependencies"],
    ["importers", ".", "devDependencies"],
    ["importers", ".", "optionalDependencies"],
    ["packages"],
    ["snapshots"],
  ] as const;

  const documents = (text: string) =>
    parseAllDocuments(text).map((doc) => {
      expect(doc.errors).toEqual([]);
      return doc.toJS() as Record<string, unknown>;
    });

  const keysOf = (doc: Record<string, unknown>, path: readonly string[]) => {
    let node: unknown = doc;
    for (const step of path) {
      node = (node as Record<string, unknown> | undefined)?.[step];
    }
    return Object.keys((node as Record<string, unknown> | undefined) ?? {});
  };

  it("removes every host key from the five sections and keeps everything else", () => {
    const input = documents(LOCK);
    const output = documents(withoutHostPackages(LOCK));
    expect(output).toHaveLength(2);
    // The package-manager record is not the project's and is left alone.
    expect(output[0]).toEqual(input[0]);
    const project = output[1] ?? {};
    // A strip that read nothing would pass the next assertion: the input
    // has a host key in every one of the five sections.
    for (const section of SECTIONS) {
      expect(
        keysOf(input[1] ?? {}, section).some((key) =>
          key.startsWith("@deepseek-ai/")
        ),
        section.join(".")
      ).toBe(true);
      expect(
        keysOf(project, section).filter((key) =>
          key.startsWith("@deepseek-ai/")
        ),
        section.join(".")
      ).toEqual([]);
    }
    expect(keysOf(project, SECTIONS[0])).toEqual(["yaml"]);
    expect(keysOf(project, SECTIONS[1])).toEqual(["@earendil-works/pi-ai"]);
    expect(keysOf(project, ["packages"])).toEqual([
      "@earendil-works/pi-ai@1.5.0",
      "yaml@2.9.1",
    ]);
    // The non-host entries survive with their sub-maps, a host peer included.
    const snapshots = (project.snapshots ?? {}) as Record<string, unknown>;
    const before = ((input[1] ?? {}).snapshots ?? {}) as Record<
      string,
      unknown
    >;
    expect(Object.keys(snapshots)).toEqual([
      "@earendil-works/pi-ai@1.5.0",
      "node-addon-require-builtin@0.1.9",
      "yaml@2.9.1",
    ]);
    for (const key of Object.keys(snapshots)) {
      expect(snapshots[key], key).toEqual(before[key]);
    }
    expect(project.lockfileVersion).toBe("9.0");
  });

  it("is idempotent: a lockfile with no host key keeps its content", () => {
    const once = withoutHostPackages(LOCK);
    expect(documents(withoutHostPackages(once))).toEqual(documents(once));
  });
});
