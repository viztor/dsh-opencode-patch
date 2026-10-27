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

import {
  CARD_FIELDS,
  Config,
  CONFIG_ONLY_FIELDS,
  DEFAULT_PROVIDERS,
  isRecord,
  name as PLUGIN_NAME,
  NS,
} from "./support/src.ts";

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
    // The constant the client bundle ships, not its spelling in the source.
    expect(NS).toBe("dsh-opencode-patch");
  });

  it("claims every route the layer mounts, in the shipped row", async () => {
    // The row's `providers` REPLACES the code default, so a route present in one
    // and absent from the other gets no session header, no origin headers and no
    // key injection — silently, and only on requests that reach it. This drifted
    // twice: `opencode-google` was missing from the code default while the row
    // claimed `opencode-mistral`, a route this layer does not mount at all
    // (Mistral is deliberately unserved).
    const patch = await readText("cordis.patch.yml");
    const block = /providers:\s*\n((?:\s*-\s*\S+\n)+)/.exec(patch);
    if (block?.[1] === undefined) {
      throw new Error("providers list not found in cordis.patch.yml");
    }
    const shipped = [...block[1].matchAll(/-\s*(\S+)/g)]
      .map((m) => m[1])
      .filter((id): id is string => id !== undefined)
      .toSorted();
    expect(shipped).toEqual([...DEFAULT_PROVIDERS].toSorted());
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

/**
 * The keys `cordis.patch.yml` documents in its header and sets in its row.
 *
 * The header lists one key per line as `#   key: type   description`, with
 * continuation lines indented deeper, so a key is exactly three spaces after
 * the `#`. The card list runs from the line naming `CARD_FIELDS` to the one
 * naming `CONFIG_ONLY_FIELDS`, the config-only list from there to the row. The
 * row's keys sit eight spaces in under `config:`; its list items sit ten in and
 * start with `-`, so they never read as keys.
 */
const manifestKeys = (
  text: string
): { card: string[]; configOnly: string[]; set: string[] } => {
  const lines = text.split("\n");
  const insert = lines.findIndex((line) => line.startsWith("- insert:"));
  const cardStart = lines.findIndex((line) => line.includes("CARD_FIELDS"));
  const configOnlyStart = lines.findIndex((line) =>
    line.includes("CONFIG_ONLY_FIELDS")
  );
  const configStart = lines.findIndex((line) => /^ +config:\s*$/u.test(line));
  if (
    insert === -1 ||
    cardStart === -1 ||
    configOnlyStart <= cardStart ||
    insert <= configOnlyStart ||
    configStart <= insert
  ) {
    throw new Error(
      "cordis.patch.yml no longer has the layout this test reads"
    );
  }
  const keysOf = (slice: string[], pattern: RegExp): string[] =>
    slice
      .map((line) => pattern.exec(line)?.[1])
      .filter((key): key is string => key !== undefined);
  const documented = /^# {3}([A-Za-z]\w*):/u;
  return {
    card: keysOf(lines.slice(cardStart, configOnlyStart), documented),
    configOnly: keysOf(lines.slice(configOnlyStart, insert), documented),
    set: keysOf(lines.slice(configStart + 1), /^ {8}([A-Za-z]\w*):/u),
  };
};

describe("cordis.patch.yml agrees with the schema and the field registry", () => {
  const root = path.dirname(import.meta.dirname);
  const read = async () =>
    manifestKeys(await readFile(path.join(root, "cordis.patch.yml"), "utf-8"));
  // `Config.dict` is the schema's own field table; `Config({})` would omit
  // every key with neither a default nor `.volatile()`.
  const schemaKeys = Object.keys(Config.dict ?? {});

  it("documents and sets only keys the schema has", async () => {
    const { card, configOnly, set } = await read();
    // Known answers, so a layout change fails loudly rather than vacuously.
    expect(schemaKeys).toContain("debugFile");
    expect(set).toContain("providers");
    expect(card).toContain("injectUserAgent");

    const unknown = [...card, ...configOnly, ...set].filter(
      (key) => !schemaKeys.includes(key)
    );
    expect(unknown).toEqual([]);
  });

  it("documents exactly the card fields and exactly the config-only fields", async () => {
    const { card, configOnly } = await read();
    expect(card).toContain("injectUserAgent");
    expect(configOnly).toContain("providers");

    expect(card.toSorted()).toEqual(
      CARD_FIELDS.map((entry) => entry.field).toSorted()
    );
    expect(configOnly.toSorted()).toEqual(
      CONFIG_ONLY_FIELDS.map((entry) => entry.field).toSorted()
    );
  });

  it("documents every schema key exactly once", async () => {
    const { card, configOnly } = await read();
    const documented = [...card, ...configOnly];
    expect(new Set(documented).size).toBe(documented.length);
    expect(documented.toSorted()).toEqual(schemaKeys.toSorted());
  });

  it("sets each row key at most once", async () => {
    const { set } = await read();
    expect(set).toContain("providers");
    expect(new Set(set).size).toBe(set.length);
  });
});
