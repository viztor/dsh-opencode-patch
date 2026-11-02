/**
 * What the plugin page shows about this package.
 *
 * The page renders ONE document inline: the Markdown that `meta.detail` in
 * `locale/<language>.json` names, or — when nothing declares one — the whole
 * `README.md`. This package shipped no `meta.detail`, so its page rendered 461
 * lines of engineering notes above the settings card, and the featured image it
 * could have had was nothing more than an icon.
 *
 * The host's rules, from `@deepseek-ai/dsh-plugin-detail`:
 *
 * - `meta.detail` is a `/`-separated Markdown path relative to the package root,
 *   and a path that does not exist is an `invalid` failure — a blank page, not a
 *   fallback;
 * - an image the document writes is served from the package, so a path it names
 *   has to be shipped;
 * - the document is rendered INLINE, which is why its length is part of the
 *   contract rather than a taste question.
 *
 * @module test/plugin-detail.test
 */

import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = process.cwd();

/** Read a text file of the package, failing loudly when it is absent. */
const read = (relative: string): string =>
  readFileSync(join(ROOT, relative), "utf8");

interface LocaleMeta {
  detail?: string;
  title?: string;
}

/** The `meta` block of one locale file. */
const metaOf = (locale: string): LocaleMeta => {
  const parsed = JSON.parse(read(`locale/${locale}.json`)) as {
    meta?: LocaleMeta;
  };
  return parsed.meta ?? {};
};

/** The paths `package.json` tells npm to ship. */
const shippedFiles = (): string[] =>
  (JSON.parse(read("package.json")) as { files?: string[] }).files ?? [];

/** The locales this package ships, by file name. */
const LOCALES = ["en", "zh"] as const;

describe("the document the plugin page renders", () => {
  it("is declared by every locale, so no language falls back to the README", () => {
    // The fallback is the whole README. A language that declares nothing gets
    // that, which is the state this package was in: every page, every language.
    for (const locale of LOCALES) {
      const { detail } = metaOf(locale);
      expect(detail, `locale/${locale}.json meta.detail`).toBeTruthy();
      expect(detail).toMatch(/\.(?:md|markdown)$/u);
      // Relative, `/`-separated, and inside the package: the host refuses
      // anything else as `invalid`, which renders nothing rather than the README.
      expect(detail?.startsWith("/")).toBe(false);
      expect(detail).not.toContain("\\");
      expect(detail?.split("/")).not.toContain("..");
    }
  });

  it("names a file that really exists, and that npm really ships", () => {
    // Two independent ways to be broken: the file is absent (the host answers
    // `invalid`), or the file is present in the repo and missing from the
    // tarball (the page works here and not for a user).
    const shipped = new Set(shippedFiles());
    for (const locale of LOCALES) {
      const detail = metaOf(locale).detail ?? "";
      expect(statSync(join(ROOT, detail)).size, detail).toBeGreaterThan(0);
      expect(
        shipped.has(detail),
        `${detail} must be in package.json files`
      ).toBe(true);
    }
  });

  it("opens with the featured image, and ships it", () => {
    // The page's whole header is this document, so the image has to be the first
    // thing in it — and the detail-image route serves package-relative paths, so
    // the file has to be there.
    const shipped = new Set(shippedFiles());
    for (const locale of LOCALES) {
      const detail = metaOf(locale).detail ?? "";
      const [first] = read(detail).split("\n");
      const image = /^!\[[^\]]*\]\(([^)]+)\)$/u.exec(first ?? "")?.[1];
      expect(image, `${detail} must open with an image`).toBeTruthy();
      const relative = image?.replace(/^\.\//u, "") ?? "";
      const resolved = join(detail, "..", relative);
      expect(
        statSync(resolved).size,
        `${resolved} must exist beside the document`
      ).toBeGreaterThan(0);
      expect(
        shipped.has(join(detail, "..", relative)),
        `${resolved} must be in package.json files`
      ).toBe(true);
    }
  });

  it("stays short enough to read above the settings card", () => {
    // Not a style rule: the document is rendered inline, and the card is below
    // it. The state this replaced was a 461-line README, and the report was
    // "why do I have such a big readme here".
    for (const locale of LOCALES) {
      const detail = metaOf(locale).detail ?? "";
      const lines = read(detail).split("\n").length;
      expect(lines, `${detail} is ${lines} lines`).toBeLessThanOrEqual(40);
    }
  });

  it("names the pages a reader needs next", () => {
    // A short page has to hand off, or it is just a shorter dead end: the full
    // reference, the meter's numbers, and the endpoints behind them.
    const en = read(metaOf("en").detail ?? "");
    for (const target of [
      "github.com/viztor/dsh-opencode-patch",
      "docs/quota-meter.md",
      "docs/redirect-planes.md",
    ]) {
      expect(en, `the English detail document must link ${target}`).toContain(
        target
      );
    }
  });
});
