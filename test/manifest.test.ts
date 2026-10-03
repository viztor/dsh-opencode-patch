/**
 * bundle manifest consistency.
 *
 * Split out of the former monolithic `plugin.test.ts`.
 *
 * @module test/manifest.test
 */

import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { name as PLUGIN_NAME } from "../src/index.ts";
import { isRecord } from "./test-helpers.ts";

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.OPENCODE_SESSION_ID;
});

describe("bundle manifest consistency", () => {
  const root = path.dirname(import.meta.dirname);

  const readText = (rel: string): Promise<string> =>
    readFile(path.join(root, rel), "utf-8");

  it("ships a cordis row whose name equals the npm package name", async () => {
    const pkgRaw: unknown = JSON.parse(await readText("package.json"));
    if (!isRecord(pkgRaw) || typeof pkgRaw.name !== "string") {
      throw new Error("package.json has no string name");
    }
    const patch = await readText("cordis.patch.yml");
    const row =
      /^\s*-\s*id:\s*dsh-opencode-patch\s*\n\s*name:\s*["']?([^"'\s]+)/m.exec(
        patch
      );
    if (row === null || row[1] === undefined) {
      throw new Error("dsh-opencode-patch row not found in cordis.patch.yml");
    }
    // The host resolves row names to node_modules paths.
    expect(row[1]).toBe(pkgRaw.name);
  });

  it("keeps the settings namespace equal to the cordis row id", async () => {
    const patch = await readText("cordis.patch.yml");
    expect(patch).toContain("id: dsh-opencode-patch");
    // Read the NS constant textually: importing settings-page.tsx would
    // drag the React + ui-primitives runtime chain (whose own deps are
    // incomplete for node) into a hermetic suite.
    const page = await readText("src/settings-page.tsx");
    const ns = /^export const NS = "([^"]+)";/m.exec(page);
    if (ns === null || ns[1] === undefined) {
      throw new Error("NS constant not found in src/settings-page.tsx");
    }
    expect(ns[1]).toBe("dsh-opencode-patch");
  });

  it("keeps the component name aligned with the default row id", () => {
    // Package (dsh-opencode-patch) == row id (dsh-opencode-patch) == row name.
    expect(PLUGIN_NAME).toBe("dsh-opencode-patch");
  });

  it("ships a manifest icon the host can display", async () => {
    const pkgRaw: unknown = JSON.parse(await readText("package.json"));
    if (!isRecord(pkgRaw) || typeof pkgRaw.icon !== "string") {
      throw new Error("package.json has no string icon field");
    }
    // Relative to the manifest directory, within the 256 KiB host limit.
    expect(pkgRaw.icon.startsWith("./")).toBe(true);
    const iconStat = await stat(path.join(root, pkgRaw.icon));
    expect(iconStat.size).toBeGreaterThan(0);
    expect(iconStat.size).toBeLessThanOrEqual(256 * 1024);
  });

  it("registers the client bundle under the npm package name", async () => {
    const pkgRaw: unknown = JSON.parse(await readText("package.json"));
    if (!isRecord(pkgRaw) || typeof pkgRaw.name !== "string") {
      throw new Error("package.json has no string name");
    }
    // The web loader drops bundles whose __ModuleLoader__.load id differs
    // from the npm package name ("loaded without registering ...").
    const config = await readText("vite.config.ts");
    const banner = /id:\s*"([^"]+)"/.exec(config);
    if (banner === null || banner[1] === undefined) {
      throw new Error("client banner id not found in vite.config.ts");
    }
    expect(banner[1]).toBe(pkgRaw.name);
  });
});
