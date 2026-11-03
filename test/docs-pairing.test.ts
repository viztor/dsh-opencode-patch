/**
 * The language pairs: one document each, two languages.
 *
 * `README`, `docs/quota-meter` and `docs/detail` are the documents this
 * repository publishes twice. Every count and every table in them is already
 * held to the code — but nothing held the two LANGUAGES to each other, and that
 * is the drift that actually happens: a row added to one language and not the
 * other.
 *
 * It had, when this check was first run, in both directions:
 *
 * - the Chinese README's settings table carried a control that no longer exists
 *   (its own prose said nine while the table listed ten);
 * - the Chinese README's configuration table was missing `credentialOrg`.
 *
 * The check is deliberately about STRUCTURE, not prose. A translator may
 * rephrase, and the two languages are allowed their own idiom — but a section, a
 * code block, a table row or an image is a FACT, and a fact present in one
 * language and absent from the other is invisible to whoever reads only one.
 *
 * No axis has a minimum. The page documents are ONE image line each, by design,
 * and a floor of "at least one heading" was a rule about long pages dressed up
 * as a rule about pairing.
 *
 * @module test/docs-pairing.test
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/** Every document published in two languages, by its base name. */
const PAIRS = ["README", "docs/quota-meter", "docs/detail"] as const;

/** Read one document of the repository. */
const read = (base: string, suffix: string): string =>
  readFileSync(join(process.cwd(), `${base}${suffix}.md`), "utf8");

/** The heading levels, in order — the document's skeleton. */
const headings = (text: string): number[] =>
  [...text.matchAll(/^(#{1,6}) /gmu)].map((match) => match[1]?.length ?? 0);

/** How many fenced blocks a document carries. */
const fences = (text: string): number =>
  (text.match(/^```/gmu) ?? []).length / 2;

/**
 * The row count of each table, in order.
 *
 * The header and the separator are the table's SHAPE; the body rows are its
 * facts. A fact is one row in one language and one row in the other — unlike a
 * prose sentence, which may be one clause or three.
 */
const tableRows = (text: string): number[] => {
  const counts: number[] = [];
  let rows = 0;
  /** Whether the previous line belonged to the same table. */
  let inTable = false;
  for (const line of text.split("\n")) {
    const isRow = /^\s*\|/u.test(line);
    const isSeparator = /^\s*\|[\s:|-]+\|\s*$/u.test(line);
    if (!isRow) {
      if (inTable) {
        counts.push(rows);
        rows = 0;
        inTable = false;
      }
      continue;
    }
    if (!inTable) {
      // The first line of a table is its header: shape, not a fact.
      inTable = true;
      continue;
    }
    if (!isSeparator) {
      rows += 1;
    }
  }
  if (inTable) {
    counts.push(rows);
  }
  return counts;
};

/** How many top-level list items a document carries. */
const listItems = (text: string): number =>
  (text.match(/^(?:\d+\.|[-*]) /gmu) ?? []).length;

/** Every image a document embeds, in order, as written. */
const images = (text: string): string[] =>
  [...text.matchAll(/!\[[^\]]*\]\(([^)]+)\)/gu)].map((match) => match[1] ?? "");

describe("the documents published in two languages", () => {
  for (const base of PAIRS) {
    it(`${base}: the two languages carry the same sections`, () => {
      // A section added to one language is the drift a reader cannot see: they
      // read one language and never learn the other says more.
      expect(headings(read(base, ".zh-CN")), `${base}.zh-CN`).toEqual(
        headings(read(base, ""))
      );
    });

    it(`${base}: the two languages carry the same code blocks`, () => {
      // A command that exists in one language only is worse than a typo: the
      // reader following that language cannot run it.
      expect(fences(read(base, ".zh-CN")), `${base}.zh-CN`).toBe(
        fences(read(base, ""))
      );
    });

    it(`${base}: every table has the same rows in both languages`, () => {
      // Row for row: a row may be rephrased, not removed. This is what found
      // the stale settings row and the missing `credentialOrg` row.
      expect(tableRows(read(base, ".zh-CN")), `${base}.zh-CN`).toEqual(
        tableRows(read(base, ""))
      );
    });

    it(`${base}: the two languages carry the same list items`, () => {
      // The other fact form. Counted rather than compared, because a list item
      // is prose with a marker and the prose is the translator's.
      expect(listItems(read(base, ".zh-CN")), `${base}.zh-CN`).toBe(
        listItems(read(base, ""))
      );
    });

    it(`${base}: the two languages show the same pictures`, () => {
      // The detail pages are a single image each, and their two images are
      // different FILES (a Chinese preview and an English one) — so what is
      // compared is the count, and each file has to exist.
      const en = images(read(base, ""));
      const zh = images(read(base, ".zh-CN"));
      expect(zh.length, `${base}.zh-CN`).toBe(en.length);
      for (const image of [...en, ...zh]) {
        if (/^[a-z]+:/iu.test(image)) {
          continue;
        }
        expect(() =>
          readFileSync(join(process.cwd(), base, "..", image))
        ).not.toThrow();
      }
    });
  }

  it("finds the pairs it claims to check", () => {
    // A loop over an empty list passes silently, which is how a gate stops being
    // one. Each pair is read, and each read has to produce SOMETHING — a
    // heading, a table, a list item or a picture — because a document with none
    // of those is not a document a pairing check can say anything about.
    for (const base of PAIRS) {
      for (const suffix of ["", ".zh-CN"]) {
        const text = read(base, suffix);
        const markers =
          headings(text).length +
          tableRows(text).length +
          listItems(text) +
          images(text).length;
        expect(markers, `${base}${suffix}.md`).toBeGreaterThan(0);
      }
    }
  });
});
