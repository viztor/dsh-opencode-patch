/**
 * The pure half of the channel switch (`scripts/channel-manifest.ts`): the
 * manifest a channel installs and the floor override, as functions of text.
 *
 * @module test/use-channel
 */
import { describe, expect, it } from "vitest";

import {
  channelManifest,
  pinFor,
  workspaceWithPi,
} from "../scripts/channel-manifest.ts";
import { CHANNELS } from "./support/host-versions.ts";

const MANIFEST = `${JSON.stringify(
  {
    name: "x",
    dependencies: { "@deepseek-ai/schemastery": "3.18.6-alpha.1" },
    devDependencies: {
      "@deepseek-ai/cordis": "4.0.6-alpha.1",
      "@deepseek-ai/cordis-plugin-loader": "1.0.7-alpha.1",
      "@deepseek-ai/dsh-llm-pi-ai": "0.2.2-alpha.2",
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
    const stray = MANIFEST.replace(
      '"semver"',
      '"@deepseek-ai/cosmokit": "1.8.7-alpha.1",\n    "semver"'
    );
    expect(() => channelManifest(stray, CHANNELS.rc)).toThrow(
      /@deepseek-ai\/cosmokit has no channel rule/u
    );
    expect(pinFor("@deepseek-ai/cosmokit", CHANNELS.rc)).toBeUndefined();
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
