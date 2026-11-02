/**
 * The vendor's HTML page read as the markdown the limits parser expects.
 *
 * This is the half that broke: the docs moved under `/v2/docs/console/` and began
 * serving HTML, so the reader had to learn a new shape — and a conversion nobody
 * can exercise is a conversion nobody knows works. It is also the path a CI
 * freshness job depends on, where a quiet failure writes a table with every
 * allowance missing rather than failing.
 *
 * The last case is the one that matters most: it feeds the REAL parser, because
 * the converter and the parser are two halves of one path and either can be
 * wrong alone.
 *
 * @module test/go-limits-html.test
 */

import { describe, expect, it } from "vitest";

import { htmlToDoc, tableRows } from "../scripts/go-limits-html.ts";
import { parseGoLimitsDoc } from "../src/go-limits.ts";

/**
 * A monthly-limit table, as the page renders one.
 *
 * Six columns, measured on the real page: `Model | input | output | cached
 * read | cached write | Monthly limit`. The converter keeps only rows of six or
 * more cells, so a fixture with fewer would prove nothing about the real shape.
 */
const monthlyTable = (rows: readonly [string, string, string][]): string =>
  [
    "<table>",
    "<thead><tr><th>Model</th><th>Input</th><th>Output</th><th>Cached Read</th><th>Cached Write</th><th>Monthly limit</th></tr></thead>",
    "<tbody>",
    ...rows.map(
      ([model, input, limit]) =>
        `<tr><td>${model}</td><td>${input}</td><td>$1.00</td><td>$0.10</td><td>-</td><td>${limit}</td></tr>`
    ),
    "</tbody>",
    "</table>",
  ].join("");

/** A request-estimate table: model names, no dollar column. */
const estimateTable = (): string =>
  [
    "<table>",
    "<tr><th>Model</th><th>Requests / 5 hours</th></tr>",
    "<tr><td>MiMo-V2.6-Flash</td><td>1,200</td></tr>",
    "</table>",
  ].join("");

describe("reading a table's cells", () => {
  it("strips the tags and trims each cell", () => {
    expect(
      tableRows(
        "<tr><td><strong>MiMo</strong>-V2.6-Pro</td><td>\n $1.40\n</td></tr>"
      )
    ).toEqual([["MiMo-V2.6-Pro", "$1.40"]]);
  });

  it("reads th as a cell, so a header row is a row", () => {
    expect(tableRows("<tr><th>Model</th><th>Monthly limit</th></tr>")).toEqual([
      ["Model", "Monthly limit"],
    ]);
  });
});

describe("turning the page into the parser's markdown", () => {
  it("takes the two monthly-limit tables, in the page's order", () => {
    const html = [
      monthlyTable([
        ["MiMo-V2.6-Pro", "$0.50", "$60"],
        ["Grok 4.7", "$1.00", "$15"],
      ]),
      monthlyTable([
        ["MiMo-V2.6-Pro", "$0.50", "$120"],
        ["Grok 4.7", "$1.00", "$60"],
      ]),
    ].join("");
    const doc = htmlToDoc(html);
    // Two sections, in the order the page carries them: Go, then Go Plus.
    expect(doc.indexOf('<TabItem label="Go">')).toBeLessThan(
      doc.indexOf('<TabItem label="Go Plus">')
    );
    expect(doc).toContain(
      "| MiMo-V2.6-Pro | $0.50 | $1.00 | $0.10 | - | **$60** |"
    );
    expect(doc).toContain(
      "| MiMo-V2.6-Pro | $0.50 | $1.00 | $0.10 | - | **$120** |"
    );
  });

  it("leaves the request-estimate tables behind", () => {
    // Their names repeat the dollar tables' names with no allowance column. Read
    // as allowances, they would invent one out of a request count.
    const html =
      monthlyTable([["MiMo-V2.6-Pro", "$0.50", "$60"]]) +
      estimateTable() +
      monthlyTable([["MiMo-V2.6-Pro", "$0.50", "$120"]]);
    const doc = htmlToDoc(html);
    expect(doc).not.toContain("1,200");
    expect(doc.split("<TabItem").length - 1).toBe(2);
  });

  it("takes a table by its HEADER, not by its position or shape", () => {
    // The page carries more than two six-column tables, and only the two whose
    // last column says "Monthly limit" are allowances. Choosing by position
    // would read a request estimate as one — which is the failure that made this
    // converter need a test at all.
    const sameShapeOtherTable = [
      "<table>",
      "<tr><th>Model</th><th>Input</th><th>Output</th><th>Cached Read</th><th>Cached Write</th><th>Requests / 5h</th></tr>",
      "<tr><td>MiMo-V2.6-Flash</td><td>$0.1</td><td>$0.2</td><td>$0.01</td><td>-</td><td>1,200</td></tr>",
      "</table>",
    ].join("");
    const html =
      sameShapeOtherTable +
      monthlyTable([["MiMo-V2.6-Pro", "$0.50", "$60"]]) +
      sameShapeOtherTable +
      monthlyTable([["MiMo-V2.6-Pro", "$0.50", "$120"]]);
    const doc = htmlToDoc(html);
    expect(doc).not.toContain("1,200");
    expect(doc).toContain("**$60**");
    expect(doc).toContain("**$120**");
  });

  it("refuses a page with fewer than two monthly-limit tables", () => {
    // The failure mode a silent conversion would produce is worse than a throw:
    // the generated file would carry no allowances at all and still look valid.
    expect(() => htmlToDoc(monthlyTable([["a", "$1", "$60"]]))).toThrow(
      /carried 1 monthly-limit table/
    );
    expect(() => htmlToDoc("")).toThrow(/expected 2/u);
  });
});

describe("the converter and the parser agree", () => {
  it("round-trips a page into the allowances the meter reads", () => {
    // The coupling: the converter writes the markdown and `parseGoLimitsDoc`
    // reads it. Either half can be wrong alone, and only this case exercises both.
    const html = [
      monthlyTable([
        ["MiMo-V2.6-Pro", "$0.50", "$60"],
        ["Grok 4.7", "$1.00", "$15"],
      ]),
      monthlyTable([
        ["MiMo-V2.6-Pro", "$0.50", "$120"],
        ["Grok 4.7", "$1.00", "$60"],
      ]),
    ].join("");
    const { limits, unmapped } = parseGoLimitsDoc(htmlToDoc(html));
    expect(unmapped).toEqual([]);
    // Keyed by the NORMALIZED label — the id the gateway uses — with the
    // vendor's spelling kept for the display: the two planes' tables spell the
    // same model the same way, and one of them is what a reader sees.
    expect(limits.get("mimo-v2.6-pro")).toEqual({
      go: 60,
      goPlus: 120,
      name: "MiMo-V2.6-Pro",
    });
    expect(limits.get("grok-4.7")).toEqual({
      go: 15,
      goPlus: 60,
      name: "Grok 4.7",
    });
  });
});
