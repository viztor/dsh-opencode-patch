/**
 * Deleted settings are gone everywhere, not just from the schema.
 *
 * A setting lives in five places: the schema (`Config`), the resolver
 * (`resolveConfig`), the settings registry (`CONFIG_ONLY_FIELDS`), the bundle
 * manifest's header (`cordis.patch.yml`) and the READMEs. Removing it from one
 * and not the others leaves a row the UI offers and the plugin ignores, or a
 * documented switch that does nothing. So each removal is pinned in every
 * place at once, and the source walk catches a code path still branching on
 * the name.
 *
 * `internalRoutes` was removed in 1.x (D2): the per-protocol routes always
 * mount. `resolveRoutedKey` (D4) was exported and never called from `src/`.
 * `modelOverrides`, `maxContextWindow` and `modelRoutes` went in P-R1 (D19):
 * the plugin serves each plane itself, so a catalog row and the user's own
 * model row say what they did. `hiddenModels` was documented and never read.
 * The hidden routes the plugin used to mount (`INTERNAL_ROUTES`,
 * `opencode-responses`, `opencode-anthropic`, `opencode-google` and their Go
 * twins) went with them (D13): the planes are the only routes it claims.
 *
 * @module test/deleted-settings.test
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { Config, CONFIG_ONLY_FIELDS, resolveConfig } from "./support/src.ts";
import { blankCommentLines } from "./support/strip-comments.ts";

const ROOT = join(import.meta.dirname, "..");

/** A deleted name, as a whole word. */
const DELETED =
  /\b(?:internalRoutes|resolveRoutedKey|RoutedKeyDetails|modelOverrides|maxContextWindow|modelRoutes|hiddenModels|INTERNAL_ROUTES)\b|\bopencode-(?:go-)?(?:responses|anthropic|google)\b/u;

/** The deleted settings, one by one, for the places that list settings. */
const DELETED_SETTINGS: readonly string[] = [
  "internalRoutes",
  "maxContextWindow",
  "modelOverrides",
  "modelRoutes",
];

/**
 * pi-ai's own provider-entry key of the same name. A plane entry is pi-ai's
 * shape, and `utils/plane-profile.ts` mirrors pi-ai's checks of it, so that
 * one module reads `modelOverrides` as pi-ai does; that is not the plugin's
 * deleted setting, and it is the only exemption.
 */
const PI_AI_KEY_READERS: ReadonlyMap<string, RegExp> = new Map([
  ["src/utils/plane-profile.ts", /\bmodelOverrides\b/gu],
]);

/** What a README may not name outside its "Changed in 1.x" section. */
const DELETED_IN_README =
  /\b(?:internalRoutes|modelOverrides|maxContextWindow|modelRoutes|hiddenModels|INTERNAL_ROUTES)\b|\bopencode-(?:go-)?(?:responses|anthropic|google)\b/u;

/** Every `.ts`/`.tsx` under `dir`, at any depth, relative to `ROOT`. */
const sourcesUnder = (dir: string): string[] =>
  readdirSync(join(ROOT, dir), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.tsx?$/u.test(entry.name))
    .map((entry) =>
      join(entry.parentPath, entry.name)
        .slice(ROOT.length + 1)
        .replaceAll("\\", "/")
    )
    .toSorted();

/**
 * Comments blanked out with their line breaks kept, so `file:line` is true;
 * line by line, so a `/*` in a string cannot hide the code after it.
 */
const blankComments = blankCommentLines;

const read = (file: string): string => readFileSync(join(ROOT, file), "utf8");

/** `text` without the `## ` section that starts at `heading`. */
const withoutSection = (text: string, heading: string): string => {
  const start = text.indexOf(`${heading}\n`);
  if (start === -1) {
    return text;
  }
  const next = text.indexOf("\n## ", start + heading.length);
  return text.slice(0, start) + (next === -1 ? "" : text.slice(next + 1));
};

describe("deleted settings", () => {
  it.each(DELETED_SETTINGS)(
    "%s is gone from the schema, the resolver, the registry and the manifest",
    (setting) => {
      const schemaKeys = Object.keys(Config.dict ?? {});
      // The dict read is real: a live key is there.
      expect(schemaKeys).toContain("endpoint");
      expect(schemaKeys).not.toContain(setting);
      expect(Object.keys(resolveConfig({}))).toContain("endpoint");
      expect(Object.keys(resolveConfig({}))).not.toContain(setting);
      const fields = CONFIG_ONLY_FIELDS.map((f) => f.field);
      expect(fields).toContain("providers");
      expect(fields).not.toContain(setting);
      const manifest = read("cordis.patch.yml");
      expect(manifest).toMatch(/\bproviders\b/u);
      expect(manifest).not.toMatch(new RegExp(`\\b${setting}\\b`, "u"));
    }
  );

  it("the shipped row claims exactly the two planes", () => {
    const manifest = read("cordis.patch.yml");
    const block = /providers:\s*\n((?:\s*-\s*\S+\n)+)/u.exec(manifest);
    expect(block?.[1]).toBeDefined();
    expect(
      [...(block?.[1] ?? "").matchAll(/-\s*(\S+)/gu)].map((m) => m[1])
    ).toEqual(["opencode", "opencode-go"]);
  });

  it("no source, door or README still names a deleted setting, export or hidden route", () => {
    const files = [...sourcesUnder("src"), "test/support/src.ts"];
    // Non-vacuous: the walk reaches nested modules.
    expect(files).toContain("src/config.ts");
    expect(files).toContain("src/utils/guards.ts");
    const offenders = files.flatMap((file) =>
      blankComments(read(file))
        .split("\n")
        .flatMap((line, index) =>
          DELETED.test(line.replace(PI_AI_KEY_READERS.get(file) ?? /(?!)/u, ""))
            ? [`${file}:${String(index + 1)}`]
            : []
        )
    );
    expect(offenders).toEqual([]);
    // The exemption is real, and narrow: the module does read pi-ai's key, and
    // the exemption removes nothing else.
    expect(read("src/utils/plane-profile.ts")).toMatch(/\bmodelOverrides\b/u);
    expect(
      DELETED.test(
        "maxContextWindow modelOverrides".replace(
          PI_AI_KEY_READERS.get("src/utils/plane-profile.ts") ?? /(?!)/u,
          ""
        )
      )
    ).toBe(true);
    // A README may name a removed setting only where it announces the removal.
    for (const [file, heading] of [
      ["README.md", "## Changed in 1.x"],
      ["README.zh-CN.md", "## 1.x 变更"],
    ] as const) {
      const text = read(file);
      expect(text).toContain(heading);
      // Non-vacuous: the section being exempted really names a removal.
      expect(text).toMatch(DELETED_IN_README);
      expect(withoutSection(text, heading)).not.toMatch(DELETED_IN_README);
    }
  });
});
