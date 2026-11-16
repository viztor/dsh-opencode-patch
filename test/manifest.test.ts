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
  ENDPOINT_FAMILIES,
  isRecord,
  KEY_SOURCE_POLICIES,
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

  it("ships the default providers, the two planes whose turns the plugin decorates", async () => {
    // `providers` names only the routes whose turns the plugin decorates, and
    // both planes are always included (src/config.ts), so the shipped row
    // matching DEFAULT_PROVIDERS keeps the file honest about what it claims.
    // This drifted twice, before the plugin mounted no route of its own: the
    // code default once lacked `opencode-google`, and the row once claimed
    // `opencode-mistral`, which was never mounted.
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

/** One documented key: the type label after `key:`, and its whole entry. */
interface DocumentedKey {
  /** The key's line and its deeper-indented continuation lines, joined. */
  block: string;
  label: string;
}

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
): {
  card: string[];
  configOnly: string[];
  documented: Map<string, DocumentedKey>;
  row: Map<string, string>;
  set: string[];
} => {
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
  const entries = new Map<string, DocumentedKey>();
  for (const [index, line] of lines.slice(0, insert).entries()) {
    const head = /^# {3}([A-Za-z]\w*):\s+(\S+)/u.exec(line);
    if (head?.[1] === undefined || head[2] === undefined) {
      continue;
    }
    const continuation = lines
      .slice(index + 1)
      .findIndex((next) => !/^# {4,}\S/u.test(next));
    const end = continuation === -1 ? insert : index + 1 + continuation;
    entries.set(head[1], {
      block: lines.slice(index, end).join("\n"),
      label: head[2],
    });
  }
  const row = new Map(
    lines
      .slice(configStart + 1)
      .map((line) => /^ {8}([A-Za-z]\w*):\s*(.*)$/u.exec(line))
      .filter((match) => match?.[1] !== undefined)
      .map((match) => [match?.[1] ?? "", match?.[2] ?? ""])
  );
  return {
    card: keysOf(lines.slice(cardStart, configOnlyStart), documented),
    configOnly: keysOf(lines.slice(configOnlyStart, insert), documented),
    documented: entries,
    row,
    set: keysOf(lines.slice(configStart + 1), /^ {8}([A-Za-z]\w*):/u),
  };
};

/** How the header and the row spell a default: a string bare, else as JSON. */
const literalOf = (value: unknown): string =>
  typeof value === "string" ? value : JSON.stringify(value);

/**
 * The list a header block states after "default": the quoted items when the
 * phrase quotes them (`default both families: ['a', 'b']`), else its
 * comma-separated words (`default: a, b`), up to the first `;` or `)`.
 * Continuation lines are joined first, so a list may wrap.
 */
const statedList = (block: string): string[] | undefined => {
  const joined = block.replaceAll(/\n#\s+/gu, " ");
  const phrase = /default:?\s+([^;)]*)/u.exec(joined)?.[1];
  if (phrase === undefined) {
    return undefined;
  }
  const quoted = [...phrase.matchAll(/'([^']*)'|"([^"]*)"/gu)].map(
    (match) => match[1] ?? match[2] ?? ""
  );
  if (quoted.length > 0) {
    return quoted;
  }
  return phrase
    .split(",")
    .map((word) => word.trim())
    .filter((word) => word !== "");
};

/**
 * Whether a header block states `fallback` as its default. A scalar must be
 * the phrase right after "default" (`(default 'auto'`, `(default false)`,
 * `inherits the default 'free'`), because a block may name every choice or
 * spell a type label that contains the value; an opening quote must close, and
 * the value must end there, so a longer value is not read as a shorter one. A
 * list must be stated whole, as the same set of whole items.
 */
const statesDefault = (block: string, fallback: unknown): boolean => {
  if (Array.isArray(fallback)) {
    const stated = statedList(block);
    const expected = fallback.map(literalOf);
    return (
      stated !== undefined &&
      stated.length === new Set(stated).size &&
      stated.toSorted().join("\n") === expected.toSorted().join("\n")
    );
  }
  const literal = literalOf(fallback).replaceAll(
    /[.*+?^${}()|[\]\\]/gu,
    "\\$&"
  );
  return new RegExp(
    String.raw`default:?\s+(['"]?)${literal}\1(?![\w./:-])`,
    "u"
  ).test(block);
};

/** The type labels the header may give a key, by the schema node's `type`. */
const LABELS_BY_TYPE: Record<string, readonly string[]> = {
  array: ["[string]"],
  boolean: ["boolean", "bool", "true|false"],
  string: ["string", "path"],
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

  it("labels each key with its schema type and names every choice value", async () => {
    const { documented } = await read();
    // Known answers: the reader found both kinds of label.
    expect(documented.get("providers")?.label).toBe("[string]");
    expect(documented.get("debugFile")?.label).toBe("path");
    expect([...documented.keys()].toSorted()).toEqual(schemaKeys.toSorted());

    const mislabelled = [...documented].flatMap(([key, entry]) => {
      const type = Config.dict?.[key]?.type ?? "missing";
      return (LABELS_BY_TYPE[type] ?? []).includes(entry.label)
        ? []
        : [`${key}: ${entry.label} (schema ${type})`];
    });
    expect(mislabelled).toEqual([]);

    for (const value of KEY_SOURCE_POLICIES) {
      expect(documented.get("keySource")?.block).toContain(value);
    }
    for (const value of ENDPOINT_FAMILIES) {
      expect(documented.get("endpoint")?.block).toContain(value);
    }
  });

  it("sets only defaults in the shipped row", async () => {
    const { row } = await read();
    // Known answers, so an empty read cannot pass.
    expect(row.get("debug")).toBe("false");
    expect(row.get("userAgent")).toBe('""');

    const drifted = [...row].flatMap(([key, text]) => {
      const fallback: unknown = Config.dict?.[key]?.meta.default;
      if (text === "") {
        // A list follows on the next lines; the providers case reads it.
        return Array.isArray(fallback) ? [] : [`${key}: no value`];
      }
      if (text === '""') {
        // A blank string is unset: only a key without a default may carry it.
        return fallback === undefined ? [] : [`${key}: blank over a default`];
      }
      return text === literalOf(fallback) ? [] : [`${key}: ${text}`];
    });
    expect(drifted).toEqual([]);
  });

  it("documents the card fields and the config-only fields in the table's order", async () => {
    const { card, configOnly } = await read();
    expect(card).toStrictEqual(CARD_FIELDS.map((entry) => entry.field));
    expect(configOnly).toStrictEqual(
      CONFIG_ONLY_FIELDS.map((entry) => entry.field)
    );
  });

  it("states every default the schema has", async () => {
    const { documented } = await read();
    const unstated = [...documented].flatMap(([key, entry]) => {
      const fallback: unknown = Config.dict?.[key]?.meta.default;
      if (fallback === undefined) {
        return [];
      }
      return statesDefault(entry.block, fallback) ? [] : [key];
    });
    // Known answer: the reader saw a block with a default in it.
    expect(documented.get("usageBaseURL")?.block).toContain(
      "https://opencode.ai/zen/go/v1"
    );
    expect(unstated).toEqual([]);
  });

  it("reads the stated default, not any mention of its value (planted controls)", () => {
    // Each block names the drifted value elsewhere, the way the real header
    // lists every choice or spells a type label; only the phrase after
    // "default" counts.
    const cases: [string, unknown, boolean][] = [
      [
        "#   endpoint: string   auto | modern | legacy (default 'auto', an alias)",
        "auto",
        true,
      ],
      [
        "#   endpoint: string   auto | modern | legacy (default 'legacy')",
        "auto",
        false,
      ],
      [
        "#   debug: true|false   log calls\n#      (default false).",
        false,
        true,
      ],
      [
        "#   debug: true|false   log calls\n#      (default false).",
        true,
        false,
      ],
      [
        "#   originClient: string   x-opencode-client value (default 'x').",
        "cli",
        false,
      ],
      [
        "#   originClient: string   x-opencode-client value (default 'cli').",
        "cli",
        true,
      ],
      [
        "#   freeModelMarker: string   ('*' = all; inherits the default 'free')",
        "*",
        false,
      ],
      [
        "#   freeModelMarker: string   ('*' = all; inherits the default 'free')",
        "free",
        true,
      ],
      [
        "#   providers: [string]   ids (default: opencode,\n#      opencode-go)",
        ["opencode", "opencode-go"],
        true,
      ],
      [
        "#   providers: [string]   ids (default: opencode)",
        ["opencode", "opencode-go"],
        false,
      ],
      // A list states as many items as the default holds: one stated item
      // against two expected fails on the count.
      [
        "#   providers: [string]   ids (default: opencode-go)",
        ["opencode", "opencode-go"],
        false,
      ],
      // A list item is a whole item, not a substring of a longer one: the
      // count agrees here, so only whole-item equality decides it.
      [
        "#   providers: [string]   ids (default: opencode-zen, opencode-go)",
        ["opencode", "opencode-go"],
        false,
      ],
      // A list states the default whole: an item the default dropped fails.
      [
        "#   gatewayUrls: [string]   substrings (default both\n#      families: ['opencode.ai/zen', 'opencode.ai/inference']).",
        ["opencode.ai/zen"],
        false,
      ],
      [
        "#   gatewayUrls: [string]   substrings (default both\n#      families: ['opencode.ai/zen', 'opencode.ai/inference']).",
        ["opencode.ai/zen", "opencode.ai/inference"],
        true,
      ],
      // A quoted scalar must close on the value: a quoted URL that extends it
      // fails at the closing quote.
      [
        "#   usageBaseURL: string   base (default 'https://opencode.ai/zen/go/v1').",
        "https://opencode.ai/zen/go",
        false,
      ],
      // An unquoted scalar is the whole value: no closing quote to miss, so
      // only the end-of-value check decides that a longer URL fails.
      [
        "#   usageBaseURL: string   base (default https://opencode.ai/zen/go/v1).",
        "https://opencode.ai/zen/go",
        false,
      ],
      [
        "#   usageBaseURL: string   base (default 'https://opencode.ai/zen/go/v1').",
        "https://opencode.ai/zen/go/v1",
        true,
      ],
      // An opening quote must close on the value.
      ["#   originClient: string   value (default 'cli-x').", "cli", false],
    ];
    for (const [block, fallback, expected] of cases) {
      expect(statesDefault(block, fallback), block).toBe(expected);
    }
  });
});
