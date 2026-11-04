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
const DELETED = /\b(?:internalRoutes|resolveRoutedKey|RoutedKeyDetails)\b/u;

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
  it("internalRoutes is gone from the schema, the resolver, the registry and the manifest", () => {
    const schemaKeys = Object.keys(Config.dict ?? {});
    // The dict read is real: a live key is there.
    expect(schemaKeys).toContain("endpoint");
    expect(schemaKeys).not.toContain("internalRoutes");
    expect(Object.keys(resolveConfig({}))).not.toContain("internalRoutes");
    expect(CONFIG_ONLY_FIELDS.map((f) => f.field)).not.toContain(
      "internalRoutes"
    );
    expect(read("cordis.patch.yml")).not.toMatch(/\binternalRoutes\b/u);
  });

  it("no source, door or README still names internalRoutes or resolveRoutedKey", () => {
    const files = [...sourcesUnder("src"), "test/support/src.ts"];
    // Non-vacuous: the walk reaches nested modules.
    expect(files).toContain("src/config.ts");
    expect(files).toContain("src/utils/guards.ts");
    const offenders = files.flatMap((file) =>
      blankComments(read(file))
        .split("\n")
        .flatMap((line, index) =>
          DELETED.test(line) ? [`${file}:${String(index + 1)}`] : []
        )
    );
    expect(offenders).toEqual([]);
    // A README may name a removed setting only where it announces the removal.
    for (const [file, heading] of [
      ["README.md", "## Changed in 1.x"],
      ["README.zh-CN.md", "## 1.x 变更"],
    ] as const) {
      const text = read(file);
      expect(text).toContain(heading);
      expect(withoutSection(text, heading)).not.toMatch(/\binternalRoutes\b/u);
    }
  });
});
