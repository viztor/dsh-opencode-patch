/**
 * The vendor's HTML page read as the markdown the limits parser expects.
 *
 * This is the half that broke: the docs moved under `/v2/docs/console/` (now
 * `/docs/console/go/`) and began serving HTML, so the reader had to learn a new
 * shape — and a conversion nobody
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

import {
  type DocAnswer,
  docFrom,
  firstDoc,
  GO_LIMITS_DOC_MOVED_TO,
  GO_LIMITS_SOURCES,
  htmlToDoc,
  monthlyLimitTables,
  noDocMessage,
  tableRows,
} from "../scripts/go-limits-html.ts";
import { parseGoLimitsDoc } from "./support/src.ts";

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

  it("collapses a cell's interior whitespace and line breaks to one space", () => {
    // A cell is one markdown cell once converted, and a markdown row is one
    // line: a newline kept inside a cell splits the row in two, and the parser
    // reads neither half.
    expect(
      tableRows(
        "<tr><td>Grok 4.7<br>\n(peak)</td><td>$1 input\n  $2 long</td><td>a<br/>b</td></tr>"
      )
    ).toEqual([["Grok 4.7 (peak)", "$1 input $2 long", "a b"]]);
  });

  it("decodes the character references a page can carry, as a browser shows them", () => {
    expect(
      tableRows(
        "<tr><td>Q&amp;A 2</td><td>(&gt; 200K &lt; 1M)</td><td>&le; 272K &ge;</td><td>&#8804; &#x2264; &#X2265;</td><td>&quot;a&quot; &#39;b&#39; &apos;c&apos;</td><td>&#36;15 &#x24;60</td></tr>"
      )
    ).toEqual([
      ["Q&A 2", "(> 200K < 1M)", "≤ 272K ≥", "≤ ≤ ≥", `"a" 'b' 'c'`, "$15 $60"],
    ]);
  });

  it("reads a no-break space as whitespace, collapsed and trimmed like any other", () => {
    expect(
      tableRows(
        "<tr><td>Grok&nbsp;4.7</td><td>$15&nbsp;</td><td>a&nbsp;&nbsp; b</td></tr>"
      )
    ).toEqual([["Grok 4.7", "$15", "a b"]]);
  });

  it("decodes in one pass, after the tags are gone", () => {
    // `&amp;lt;` is the text `&lt;`, not `<`; and an encoded tag is text the
    // page shows, not markup to strip.
    expect(
      tableRows(
        "<tr><td>&amp;lt; &amp;amp;</td><td>&lt;b&gt;x&lt;/b&gt;</td></tr>"
      )
    ).toEqual([["&lt; &amp;", "<b>x</b>"]]);
  });

  it("leaves a reference it does not know, or one that names no character, as written", () => {
    expect(
      tableRows(
        "<tr><td>&copy2 &unknown; &constructor; &#xFFFFFFF; &#xD800; &#0; AT&T</td></tr>"
      )
    ).toEqual([
      ["&copy2 &unknown; &constructor; &#xFFFFFFF; &#xD800; &#0; AT&T"],
    ]);
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

  it("refuses a page without exactly two unlabelled monthly-limit tables", () => {
    // The failure mode a silent conversion would produce is worse than a throw:
    // the generated file would carry no allowances at all and still look valid.
    expect(() => htmlToDoc(monthlyTable([["a", "$1", "$60"]]))).toThrow(
      /none labelled Go or Go Plus, and 1 monthly-limit table\(s\), where only exactly 2 are read in the page's order/u
    );
    expect(() => htmlToDoc("")).toThrow(
      /^go-limits: the page's allowance tables were not chosen: no monthly-limit table$/u
    );
  });

  it("refuses a page with a third monthly-limit table", () => {
    // Taking the first two by position would read a third plan's page as Go and
    // Go Plus in whatever order it came - $5, $60 and $120 read as go 5 and
    // goPlus 60, and the run would still exit 0. Which two are the plans is not
    // something the page says, so it is not guessed.
    const html = [
      monthlyTable([["MiMo-V2.6-Pro", "$0.50", "$5"]]),
      monthlyTable([["MiMo-V2.6-Pro", "$0.50", "$60"]]),
      monthlyTable([["MiMo-V2.6-Pro", "$0.50", "$120"]]),
    ].join("");
    expect(() => htmlToDoc(html)).toThrow(
      /none labelled Go or Go Plus, and 3 monthly-limit table\(s\)/u
    );
  });
});

describe("the converter and the parser agree", () => {
  it("keeps a model whose cells span lines, rather than dropping it unreported", () => {
    // A pretty-printed page breaks a cell over lines. Kept as it was, the
    // emitted row split in two, the parser skipped both halves without naming
    // them, and the model was missing from a table that still exited 0.
    const html = [
      monthlyTable([
        ["MiMo", "$1", "$60"],
        ["Grok 4.7", "$1 input\n$2 long", "$15"],
        ["Grok 4.8<br>\n(peak)", "$1", "$20"],
      ]),
      monthlyTable([
        ["MiMo", "$1", "$120"],
        ["Grok 4.7", "$1 input\n$2 long", "$60"],
        ["Grok 4.8<br>\n(peak)", "$1", "$80"],
      ]),
    ].join("");
    const doc = docFrom(answer({ body: html }));
    expect(doc).toBeDefined();
    const { limits, unmapped } = parseGoLimitsDoc(doc ?? "");
    expect(unmapped).toEqual([]);
    expect([...limits.keys()]).toEqual(["mimo", "grok-4.7", "grok-4.8"]);
    expect(limits.get("grok-4.7")).toEqual({
      go: 15,
      goPlus: 60,
      name: "Grok 4.7",
    });
    expect(limits.get("grok-4.8")).toEqual({
      go: 20,
      goPlus: 80,
      name: "Grok 4.8 (peak)",
    });
  });

  it("reads an amount whose dollar sign or padding is a character reference", () => {
    // A browser shows `&#36;15` as $15; read verbatim it was no amount, and
    // `$15&nbsp;` became NaN - an allowance that silently read as "no
    // published figure" in a run that exited 0.
    const html = [
      monthlyTable([
        ["MiMo-V2.6-Pro", "$0.50", "&#36;15"],
        ["Grok 4.7", "$1.00", "$15&nbsp;"],
      ]),
      monthlyTable([
        ["MiMo-V2.6-Pro", "$0.50", "&#x24;60"],
        ["Grok 4.7", "$1.00", "&#36;60"],
      ]),
    ].join("");
    const doc = docFrom(answer({ body: html }));
    expect(doc).toBeDefined();
    const { limits, unmapped } = parseGoLimitsDoc(doc ?? "");
    expect(unmapped).toEqual([]);
    expect(limits.get("mimo-v2.6-pro")).toEqual({
      go: 15,
      goPlus: 60,
      name: "MiMo-V2.6-Pro",
    });
    expect(limits.get("grok-4.7")).toEqual({
      go: 15,
      goPlus: 60,
      name: "Grok 4.7",
    });
  });

  it("keys a label carrying character references by the id a browser's text gives, and names it in that text", () => {
    // Verbatim, `Grok&nbsp;4.7` slugged to `grok-nbsp-4.7` and `Q&amp;A 2` to
    // `q-amp-a-2`: ids no catalog carries, written with exit 0; and the names
    // shipped with a literal `&gt;`.
    const html = [
      monthlyTable([
        ["Grok&nbsp;4.7 (&gt; 200K tokens)", "$1.00", "$15"],
        ["Q&amp;A 2 (&le; 8K)", "$1.00", "$5"],
      ]),
      monthlyTable([
        ["Grok&nbsp;4.7 (&gt; 200K tokens)", "$1.00", "$60"],
        ["Q&amp;A 2 (&le; 8K)", "$1.00", "$20"],
      ]),
    ].join("");
    const doc = docFrom(answer({ body: html }));
    expect(doc).toBeDefined();
    const { limits, unmapped } = parseGoLimitsDoc(doc ?? "");
    expect(unmapped).toEqual([]);
    expect([...limits.keys()]).toEqual(["grok-4.7", "q-a-2"]);
    expect(limits.get("grok-4.7")).toEqual({
      go: 15,
      goPlus: 60,
      name: "Grok 4.7 (> 200K tokens)",
    });
    expect(limits.get("q-a-2")).toEqual({
      go: 5,
      goPlus: 20,
      name: "Q&A 2 (≤ 8K)",
    });
  });

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

/**
 * What a source answered, as the generator records it.
 *
 * @param overrides - the fields this case changes.
 * @returns a 200 from the moved page, carrying `body`.
 */
const answer = (overrides: Partial<DocAnswer>): DocAnswer => ({
  body: "",
  contentType: "text/html; charset=utf-8",
  finalUrl: "https://opencode.ai/docs/console/go/",
  status: 200,
  url: "https://opencode.ai/docs/console/go/",
  ...overrides,
});

/** The page's two allowance tables, as one HTML body. */
const page = (): string =>
  [
    "<html><body><h2>Usage limits</h2>",
    monthlyTable([
      ["MiMo-V2.6-Pro", "$0.50", "$60"],
      ["Grok 4.7", "$1.00", "$15"],
    ]),
    monthlyTable([
      ["MiMo-V2.6-Pro", "$0.50", "$120"],
      ["Grok 4.7", "$1.00", "$60"],
    ]),
    "</body></html>",
  ].join("");

describe("reading a 2xx answer by what it carries", () => {
  it("passes the tabbed markdown through as it is", () => {
    const markdown = htmlToDoc(page());
    expect(
      docFrom(
        answer({
          body: markdown,
          contentType: "text/plain",
          finalUrl: "https://opencode.ai/docs/go.md",
          url: "https://opencode.ai/docs/go.md",
        })
      )
    ).toBe(markdown);
  });

  it("converts a 200 that is the HTML page, wherever it was asked for", () => {
    // Measured by the nightly run from 2026-11-07: `go.md` answers 200 again,
    // and what it carries has no tab sections. The generator handed that body
    // to the markdown parser because the status was ok, and every refresh since
    // failed on "no <TabItem label="Go"> section". A body is read by its shape.
    const doc = docFrom(
      answer({
        body: page(),
        url: "https://opencode.ai/docs/go.md",
      })
    );
    expect(doc).toBeDefined();
    const { limits, unmapped } = parseGoLimitsDoc(doc ?? "");
    expect(unmapped).toEqual([]);
    expect(limits.get("grok-4.7")).toEqual({
      go: 15,
      goPlus: 60,
      name: "Grok 4.7",
    });
  });

  it("answers nothing for a body that carries neither shape", () => {
    // Markdown without the tab sections, and an HTML page with one allowance
    // table or none: the next source is tried, and the parser never sees them.
    expect(
      docFrom(answer({ body: "# Go\n\n| Model | Limit |\n| --- | --- |" }))
    ).toBeUndefined();
    expect(
      docFrom(answer({ body: monthlyTable([["a", "$1", "$60"]]) }))
    ).toBeUndefined();
    expect(docFrom(answer({ body: estimateTable() }))).toBeUndefined();
  });

  it("answers nothing for markdown with the Go tab and no Go Plus tab", () => {
    // The parser reads both tabs and throws on a missing one; a body it would
    // throw on is not a body this source carries.
    const markdown = [
      '<TabItem label="Go">',
      "| Model | Input | Output | Cached Read | Cached Write | Monthly limit |",
      "| --- | --- | --- | --- | --- | --- |",
      "| Grok 4.7 | $1.00 | $1.00 | $0.10 | - | **$15** |",
      "</TabItem>",
    ].join("\n");
    expect(() => parseGoLimitsDoc(markdown)).toThrow(/Go Plus/u);
    expect(docFrom(answer({ body: markdown }))).toBeUndefined();
  });

  it("answers nothing for two monthly-limit tables with no model row", () => {
    // The header matches, and nothing under it is a row the parser reads: an
    // empty body, or rows short of the six cells the table has.
    const emptyTable = monthlyTable([]);
    const shortRows = [
      "<table>",
      "<tr><th>Model</th><th>Input</th><th>Output</th><th>Cached Read</th><th>Cached Write</th><th>Monthly limit</th></tr>",
      "<tr><td>Grok 4.7</td><td>$15</td></tr>",
      "</table>",
    ].join("");
    const readable = monthlyTable([["Grok 4.7", "$1.00", "$60"]]);
    for (const body of [
      emptyTable + emptyTable,
      shortRows + shortRows,
      readable + emptyTable,
      shortRows + readable,
    ]) {
      expect(() => parseGoLimitsDoc(htmlToDoc(body))).toThrow(
        /parsed to zero rows/u
      );
      expect(docFrom(answer({ body }))).toBeUndefined();
    }
  });

  it("answers nothing for both tabs the parser reads no row from", () => {
    // Both tabs present is the markdown's shape, not its content: no rows, or
    // a table one cell short of the allowance table, parses to zero rows.
    const fiveCells = [
      "| Model | Input | Output | Cached Read | Monthly limit |",
      "| --- | --- | --- | --- | --- |",
      "| Grok 4.7 | $1.00 | $1.00 | $0.10 | **$15** |",
    ];
    for (const rows of [[], fiveCells]) {
      const body = [
        '<TabItem label="Go">',
        ...rows,
        "</TabItem>",
        '<TabItem label="Go Plus">',
        ...rows,
        "</TabItem>",
      ].join("\n");
      expect(() => parseGoLimitsDoc(body)).toThrow(/parsed to zero rows/u);
      expect(docFrom(answer({ body }))).toBeUndefined();
    }
  });

  it("answers nothing for two allowance tables whose six-cell rows carry no dollar amount", () => {
    // Six cells is the table's shape; the parser also wants the last one to be
    // a dollar amount. `Unlimited` and a seventh, empty, trailing cell each
    // leave it with zero rows. (An entity-encoded `$` is a dollar amount: a
    // browser shows `&#36;15` as $15, and so does the reader.)
    const sevenCells = [
      "<table>",
      "<tr><th>Model</th><th>Input</th><th>Output</th><th>Cached Read</th><th>Cached Write</th><th>Monthly limit</th></tr>",
      "<tr><td>Grok 4.7</td><td>$1</td><td>$1</td><td>$0.1</td><td>-</td><td>$15</td><td></td></tr>",
      "</table>",
    ].join("");
    for (const table of [
      monthlyTable([["Big Pickle", "Free", "Unlimited"]]),
      sevenCells,
    ]) {
      const body = table + table;
      expect(() => parseGoLimitsDoc(htmlToDoc(body))).toThrow(
        /parsed to zero rows/u
      );
      expect(docFrom(answer({ body }))).toBeUndefined();
    }
  });

  it("reads an HTML page's tables when the page also quotes both tab strings", () => {
    // The literal tab strings in a page's prose, or a code sample, do not make
    // it the markdown: what the parser cannot read as tabs it reads as tables.
    const quoted =
      '<p><code>&lt;TabItem label="Go"&gt;</code></p>' +
      '<pre><TabItem label="Go"></TabItem><TabItem label="Go Plus"></TabItem></pre>';
    const doc = docFrom(answer({ body: quoted + page() }));
    expect(doc).toBeDefined();
    expect(parseGoLimitsDoc(doc ?? "").limits.get("grok-4.7")).toEqual({
      go: 15,
      goPlus: 60,
      name: "Grok 4.7",
    });
  });

  it("answers nothing for a page with three monthly-limit tables", () => {
    const body = [
      monthlyTable([["MiMo-V2.6-Pro", "$0.50", "$5"]]),
      monthlyTable([["MiMo-V2.6-Pro", "$0.50", "$60"]]),
      monthlyTable([["MiMo-V2.6-Pro", "$0.50", "$120"]]),
    ].join("");
    expect(docFrom(answer({ body }))).toBeUndefined();
  });

  it("answers nothing for a status outside 2xx, whatever the body", () => {
    expect(docFrom(answer({ body: page(), status: 404 }))).toBeUndefined();
    expect(docFrom(answer({ body: page(), status: 301 }))).toBeUndefined();
  });

  it("names what every source answered when none carried the tables", () => {
    const message = noDocMessage([
      answer({ status: 404 }),
      answer({
        body: "# Go\n",
        contentType: "text/markdown",
        finalUrl: "https://opencode.ai/docs/go/",
        url: "https://opencode.ai/docs/go.md",
      }),
    ]);
    expect(message).toMatch(
      /^go-limits: no source carried the allowance tables/u
    );
    expect(message).toContain(
      "https://opencode.ai/docs/console/go/ answered 404"
    );
    // The redirect, the type and the size are what tell a reader which of the
    // shapes changed, without a second run.
    expect(message).toContain(
      "https://opencode.ai/docs/go.md answered 200 (redirected to https://opencode.ai/docs/go/), text/markdown, 5 characters, no markdown Go <TabItem>, 0 monthly-limit table(s)"
    );
    // The answer that was not redirected says nothing about a redirect.
    const [, notFound] = message.split("\n");
    expect(notFound).toBe(
      "  - https://opencode.ai/docs/console/go/ answered 404, text/html; charset=utf-8, 0 characters, no markdown Go <TabItem>, 0 monthly-limit table(s)"
    );
    expect(notFound).not.toContain("(redirected");
  });

  it("names a missing content type, and what an HTML body did carry", () => {
    const empty = monthlyTable([]);
    const message = noDocMessage([
      answer({ body: "# Go\n", contentType: "" }),
      answer({ body: empty + empty }),
      answer({ body: page() + monthlyTable([["a", "$1", "$5"]]) }),
    ]);
    const [, untyped, unreadable, tooMany] = message.split("\n");
    expect(untyped).toContain(", no content type, 5 characters,");
    // The parser's own reason, for a body in a shape it was handed.
    expect(unreadable).toMatch(
      /, no markdown Go <TabItem>, 2 monthly-limit table\(s\), 0 with a model row: table 1 \(unlabelled, 0 model row\(s\)\); table 2 \(unlabelled, 0 model row\(s\)\), the parser rejected the allowance tables: the go table parsed to zero rows$/u
    );
    expect(tooMany).toMatch(
      /, no markdown Go <TabItem>, 3 monthly-limit table\(s\): .*; table 3 \(heading "Usage limits", 1 model row\(s\), first "a" → "\$5"\), the allowance tables were not chosen: none labelled Go or Go Plus, and 3 monthly-limit table\(s\), where only exactly 2 are read in the page's order$/u
    );
  });

  it("names the parser's reason for every shape a body was read in", () => {
    const unlimited = monthlyTable([["Big Pickle", "Free", "Unlimited"]]);
    const message = noDocMessage([
      answer({
        body: `<TabItem label="Go">\n</TabItem>\n<TabItem label="Go Plus">\n</TabItem>${unlimited}${unlimited}`,
      }),
    ]);
    expect(message.split("\n")[1]).toMatch(
      /, the markdown Go and Go Plus <TabItem>s, 2 monthly-limit table\(s\): table 1 \(unlabelled, 1 model row\(s\), first "Big Pickle" → "Unlimited"\); table 2 \(unlabelled, 1 model row\(s\), first "Big Pickle" → "Unlimited"\), the parser rejected the tabbed markdown: the go table parsed to zero rows, the parser rejected the allowance tables: the go table parsed to zero rows$/u
    );
  });

  it("names a markdown Go tab without its Go Plus tab", () => {
    const message = noDocMessage([
      answer({ body: '<TabItem label="Go">\n</TabItem>' }),
    ]);
    expect(message).toMatch(
      /, the markdown Go <TabItem> but no Go Plus <TabItem>, 0 monthly-limit table\(s\)$/u
    );
  });
});

/** The sources' answers, by URL, for a walk that asks nothing over the network. */
const fakeRead = (
  answers: Readonly<Record<string, DocAnswer>>
): {
  asked: string[];
  read: (source: string) => Promise<DocAnswer>;
} => {
  const asked: string[] = [];
  return {
    asked,
    read: async (source) => {
      asked.push(source);
      const found = answers[source];
      if (found === undefined) {
        throw new Error(`no answer for ${source}`);
      }
      return found;
    },
  };
};

/** The two sources, spelled out, so the order below is checked, not copied. */
const MOVED_PAGE = "https://opencode.ai/docs/console/go/";
const GO_MD = "https://opencode.ai/docs/go.md";

/** The answer `go.md` gave from 2026-11-07: a 200 with no tab sections. */
const tablessGoMd = (): DocAnswer =>
  answer({
    body: "# Go\n\nOpenCode Go is a subscription.\n",
    contentType: "text/markdown",
    finalUrl: GO_MD,
    url: GO_MD,
  });

describe("asking the sources in turn", () => {
  it("asks the page the docs live on first, then the old markdown URL", () => {
    expect(GO_LIMITS_SOURCES).toEqual([MOVED_PAGE, GO_MD]);
    // Both old URLs redirect to the canonical page, measured 2026-11-12, and
    // the exported constant names that page, not the `/v2/` URL before it.
    expect(GO_LIMITS_DOC_MOVED_TO).toBe(MOVED_PAGE);
  });

  it("stops at the first source that carries the tables", async () => {
    const { asked, read } = fakeRead({
      [GO_MD]: tablessGoMd(),
      [MOVED_PAGE]: answer({ body: page() }),
    });
    const found = await firstDoc(GO_LIMITS_SOURCES, read);
    // The second source is never asked once the first one carried the tables.
    expect(asked).toEqual([MOVED_PAGE]);
    expect(found.source).toBe(MOVED_PAGE);
    expect(found.answer.body).toBe(page());
    expect(parseGoLimitsDoc(found.doc).limits.get("grok-4.7")).toEqual({
      go: 15,
      goPlus: 60,
      name: "Grok 4.7",
    });
  });

  it("reads the second source when the first carries neither shape", async () => {
    const markdown = htmlToDoc(page());
    const { asked, read } = fakeRead({
      [GO_MD]: answer({
        body: markdown,
        contentType: "text/plain",
        finalUrl: GO_MD,
        url: GO_MD,
      }),
      [MOVED_PAGE]: answer({ body: estimateTable() }),
    });
    const found = await firstDoc(GO_LIMITS_SOURCES, read);
    expect(asked).toEqual([MOVED_PAGE, GO_MD]);
    expect(found.source).toBe(GO_MD);
    expect(found.doc).toBe(markdown);
  });

  it("reads the second source when the first has the tables' shape and no row the parser reads", async () => {
    // The moved page with both allowance tables whose rows say `Unlimited`:
    // taken on its shape, the walk stopped there and the run died on the
    // parser's complaint, and the valid second source was never asked.
    const unlimited = monthlyTable([["Big Pickle", "Free", "Unlimited"]]);
    const markdown = htmlToDoc(page());
    const { asked, read } = fakeRead({
      [GO_MD]: answer({
        body: markdown,
        contentType: "text/plain",
        finalUrl: GO_MD,
        url: GO_MD,
      }),
      [MOVED_PAGE]: answer({ body: unlimited + unlimited }),
    });
    const found = await firstDoc(GO_LIMITS_SOURCES, read);
    expect(asked).toEqual([MOVED_PAGE, GO_MD]);
    expect(found.source).toBe(GO_MD);
    expect(found.doc).toBe(markdown);
  });

  it("rejects naming every source, in order, when none carries the tables", async () => {
    // The 2026-11-07 shape as the second source: `go.md` answers 200 as
    // markdown, without the tab sections, after the moved page did not answer.
    const { asked, read } = fakeRead({
      [GO_MD]: tablessGoMd(),
      [MOVED_PAGE]: answer({ status: 404 }),
    });
    // An Error instance compares the whole message: both lines, in this order.
    await expect(firstDoc(GO_LIMITS_SOURCES, read)).rejects.toThrow(
      new Error(
        [
          "go-limits: no source carried the allowance tables",
          `  - ${MOVED_PAGE} answered 404, text/html; charset=utf-8, 0 characters, no markdown Go <TabItem>, 0 monthly-limit table(s)`,
          `  - ${GO_MD} answered 200, text/markdown, ${tablessGoMd().body.length} characters, no markdown Go <TabItem>, 0 monthly-limit table(s)`,
        ].join("\n")
      )
    );
    expect(asked).toEqual([MOVED_PAGE, GO_MD]);
  });

  it("rejects with the empty message when there is no source at all", async () => {
    const { asked, read } = fakeRead({});
    await expect(firstDoc([], read)).rejects.toThrow(
      /^go-limits: no source carried the allowance tables$/u
    );
    expect(asked).toEqual([]);
  });
});

/**
 * A Starlight `<Tabs>` group, as its build renders one: a `role="tablist"` of
 * `<a role="tab" id="tab-N" href="#tab-panel-N">` labels, then one
 * `<div role="tabpanel" id="tab-panel-N" aria-labelledby="tab-N">` per tab,
 * each wrapping its content in nested elements. ASSUMED from Starlight's
 * `Tabs.astro` and `rehype-tabs`, not measured on the vendor's page.
 *
 * @param tabs - each tab's label and content, in the page's order.
 * @param first - the number the group's ids start from.
 * @returns the group's HTML.
 */
const starlightTabs = (
  tabs: readonly (readonly [string, string])[],
  first = 0
): string =>
  [
    "<starlight-tabs>",
    '<div class="tablist-wrapper not-content"><ul role="tablist">',
    ...tabs.map(
      ([label], index) =>
        `<li role="presentation" class="tab"><a role="tab" href="#tab-panel-${first + index}" id="tab-${first + index}" aria-selected="${index === 0}" tabindex="${index === 0 ? 0 : -1}"><svg aria-hidden="true" class="icon"><path d="M0 0"/></svg>\n  ${label}\n</a></li>`
    ),
    "</ul></div>",
    ...tabs.map(
      ([, content], index) =>
        `<div id="tab-panel-${first + index}" aria-labelledby="tab-${first + index}" role="tabpanel"${index === 0 ? "" : " hidden"}><div class="sl-markdown-content"><div><p>Limits</p></div>${content}<p>Usage beyond the limit is paused.</p></div></div>`
    ),
    "</starlight-tabs>",
  ].join("\n");

/** The three plans' tables, a third plan first and Go last. */
const THREE_PLANS: readonly (readonly [string, string])[] = [
  [
    "Go Max",
    monthlyTable([
      ["MiMo-V2.6-Pro", "$0.50", "$500"],
      ["Grok 4.7", "$1.00", "$300"],
    ]),
  ],
  [
    "Go Plus",
    monthlyTable([
      ["MiMo-V2.6-Pro", "$0.50", "$120"],
      ["Grok 4.7", "$1.00", "$60"],
    ]),
  ],
  [
    "Go",
    monthlyTable([
      ["MiMo-V2.6-Pro", "$0.50", "$60"],
      ["Grok 4.7", "$1.00", "$15"],
    ]),
  ],
];

/** The allowances `THREE_PLANS` carries for Go and Go Plus. */
const THREE_PLANS_LIMITS = [
  ["mimo-v2.6-pro", { go: 60, goPlus: 120, name: "MiMo-V2.6-Pro" }],
  ["grok-4.7", { go: 15, goPlus: 60, name: "Grok 4.7" }],
];

describe("choosing the Go and Go Plus tables by their plan label", () => {
  it("reads each plan from its own tab, whatever order the tabs come in, and ignores a third plan", () => {
    // The 2026-11-12 run measured three monthly-limit tables. Taken by
    // position, a third plan's tab read first would be Go.
    const body = `<h2>Usage limits</h2>${starlightTabs(THREE_PLANS)}${estimateTable()}`;
    const doc = docFrom(answer({ body }));
    expect(doc).toBeDefined();
    const { limits, unmapped } = parseGoLimitsDoc(doc ?? "");
    expect(unmapped).toEqual([]);
    expect([...limits]).toEqual(THREE_PLANS_LIMITS);
  });

  it("labels each table from the tab its panel names, with the text a browser shows", () => {
    const tables = monthlyLimitTables(
      starlightTabs([
        ["Go&nbsp;<em>Plus</em>", monthlyTable([["a", "$1", "$2"]])],
        ["Go", monthlyTable([["a", "$1", "$1"]])],
      ])
    );
    expect(tables.map((table) => table.label)).toEqual([
      { source: "tab", text: "Go Plus" },
      { source: "tab", text: "Go" },
    ]);
  });

  it("reads the tabs with their attributes in any order, single-quoted, and the ids reused elsewhere", () => {
    // `href="#tab-4"` and `data-ref="tab-4"` name the tab's id without being
    // it: only an `id` attribute is the element `aria-labelledby` points at.
    // A `>` inside a quoted value does not end the tag.
    const panel = (id: number, table: string): string =>
      `<div data-note='a > b' hidden aria-labelledby='tab-${id}' class="x" role='tabpanel' id='tab-panel-${id}'>\n<div><div>${table}</div></div>\n</div>`;
    const tab = (id: number, label: string): string =>
      `<li><a tabindex='-1' class='tab' aria-selected='false' id='tab-${id}' href='#tab-panel-${id}' role='tab'>${label}</a></li>`;
    // Each decoy names a tab's id with another plan's text: read as the tab,
    // Go Plus would be labelled Go and Go labelled Go Plus.
    const decoys =
      '<a href="#tab-4" data-ref="tab-4">Go</a><span data-ref=\'tab-5\'>Go Plus</span>';
    const [max, plus, go] = THREE_PLANS.map(([, table]) => table);
    const body = [
      decoys,
      "<ul role='tablist'>",
      tab(4, "Go Plus"),
      tab(3, "Go Max"),
      tab(5, "Go"),
      "</ul>",
      panel(3, max ?? ""),
      panel(4, plus ?? ""),
      panel(5, go ?? ""),
    ].join("\n");
    const doc = docFrom(answer({ body }));
    expect(doc).toBeDefined();
    expect([...parseGoLimitsDoc(doc ?? "").limits]).toEqual(THREE_PLANS_LIMITS);
  });

  it("labels a table by its innermost panel, and by the panel's own label when its tab names nothing", () => {
    // An unprocessed `<starlight-tab-item data-label>` is what Starlight's
    // `TabItem` renders before its rehype step gives the panel an id.
    const tables = monthlyLimitTables(
      [
        '<div role="tabpanel" aria-labelledby="outer">',
        '<div role="tabpanel" aria-labelledby="missing" aria-label="Go Plus">',
        monthlyTable([["a", "$1", "$2"]]),
        "</div>",
        '<starlight-tab-item data-label="Go">',
        monthlyTable([["a", "$1", "$1"]]),
        "</starlight-tab-item>",
        "</div>",
        '<span id="outer">Outer</span>',
      ].join("")
    );
    expect(tables.map((table) => table.label)).toEqual([
      { source: "panel", text: "Go Plus" },
      { source: "panel", text: "Go" },
    ]);
  });

  it("does not read a tag inside a script or a comment as the page's structure", () => {
    const tables = monthlyLimitTables(
      [
        '<div role="tabpanel" aria-labelledby="t">',
        "<script>const s = '</div>';</script>",
        "<!-- </div> -->",
        monthlyTable([["a", "$1", "$1"]]),
        "</div>",
        '<a id="t" role="tab">Go</a>',
      ].join("")
    );
    expect(tables.map((table) => table.label)).toEqual([
      { source: "tab", text: "Go" },
    ]);
  });

  it("labels a table outside any tab by the nearest heading before it", () => {
    // Go Plus first: by position, Go would read Go Plus's allowances.
    const body = [
      "<h2>Usage limits</h2>",
      '<h3 id="go-plus">Go <code>Plus</code></h3>',
      monthlyTable([
        ["MiMo-V2.6-Pro", "$0.50", "$120"],
        ["Grok 4.7", "$1.00", "$60"],
      ]),
      "<h4>Go</h4><p>The $10 plan.</p>",
      monthlyTable([
        ["MiMo-V2.6-Pro", "$0.50", "$60"],
        ["Grok 4.7", "$1.00", "$15"],
      ]),
      "<h3>Go Max</h3>",
      monthlyTable([["MiMo-V2.6-Pro", "$0.50", "$500"]]),
    ].join("");
    expect(monthlyLimitTables(body).map((table) => table.label?.text)).toEqual([
      "Go Plus",
      "Go",
      "Go Max",
    ]);
    const doc = docFrom(answer({ body }));
    expect(doc).toBeDefined();
    expect([...parseGoLimitsDoc(doc ?? "").limits]).toEqual(THREE_PLANS_LIMITS);
  });

  it("does not label a table outside the tabs by a heading inside a tab panel", () => {
    // Each panel opens with a heading naming its own plan, and a third plan's
    // table follows the group. The nearest heading before that table by
    // position is the last panel's, hidden in a panel that does not hold it:
    // read that way, the third table is labelled "Go Plus" and the page is
    // refused for two Go Plus tables, though both tabs are unambiguous.
    const body = [
      "<h2>Usage limits</h2>",
      starlightTabs([
        [
          "Go",
          `<h3>Go</h3><h3>Go Plus</h3><p>Upgrade for more.</p>${monthlyTable([
            ["MiMo-V2.6-Pro", "$0.50", "$60"],
            ["Grok 4.7", "$1.00", "$15"],
          ])}`,
        ],
        [
          "Go Plus",
          `<h3>Go Plus</h3>${monthlyTable([
            ["MiMo-V2.6-Pro", "$0.50", "$120"],
            ["Grok 4.7", "$1.00", "$60"],
          ])}`,
        ],
      ]),
      "<p>Teams on the enterprise plan:</p>",
      monthlyTable([["MiMo-V2.6-Pro", "$0.50", "$500"]]),
    ].join("");
    expect(monthlyLimitTables(body).map((table) => table.label)).toEqual([
      { source: "tab", text: "Go" },
      { source: "tab", text: "Go Plus" },
      { source: "heading", text: "Usage limits" },
    ]);
    const doc = docFrom(answer({ body }));
    expect(doc).toBeDefined();
    expect([...parseGoLimitsDoc(doc ?? "").limits]).toEqual(THREE_PLANS_LIMITS);
  });

  it("does not read a table outside the tabs as the plan a hidden panel's heading names", () => {
    // The second tab is "Plus", and only its panel's heading says "Go Plus".
    // Read by position, the $500 table after the group is Go Plus, and the
    // page is accepted with the wrong allowances.
    const body = [
      starlightTabs([
        ["Go", monthlyTable([["Grok 4.7", "$1.00", "$15"]])],
        [
          "Plus",
          `<h3>Go Plus</h3>${monthlyTable([["Grok 4.7", "$1.00", "$60"]])}`,
        ],
      ]),
      monthlyTable([["Grok 4.7", "$1.00", "$500"]]),
    ].join("");
    expect(monthlyLimitTables(body).map((table) => table.label)).toEqual([
      { source: "tab", text: "Go" },
      { source: "tab", text: "Plus" },
      undefined,
    ]);
    expect(docFrom(answer({ body }))).toBeUndefined();
    expect(() => htmlToDoc(body)).toThrow(
      /were not chosen: no table labelled "Go Plus"$/u
    );
  });

  it("still labels a table inside a panel by a heading earlier in that panel", () => {
    const tables = monthlyLimitTables(
      [
        '<div role="tabpanel">',
        "<h3>Go</h3>",
        monthlyTable([["a", "$1", "$1"]]),
        "</div>",
      ].join("")
    );
    expect(tables.map((table) => table.label)).toEqual([
      { source: "heading", text: "Go" },
    ]);
  });

  it("keeps the measured order for exactly two tables that carry no plan label", () => {
    // The shape the shipped table was generated from: Go first, Go Plus second.
    // A heading that names no plan is not a label to choose by.
    const body = page();
    const found = monthlyLimitTables(body);
    expect(found.map((table) => table.label)).toEqual([
      { source: "heading", text: "Usage limits" },
      { source: "heading", text: "Usage limits" },
    ]);
    const doc = docFrom(answer({ body }));
    expect(doc).toBeDefined();
    expect(parseGoLimitsDoc(doc ?? "").limits.get("grok-4.7")).toEqual({
      go: 15,
      goPlus: 60,
      name: "Grok 4.7",
    });
  });

  it("refuses three tables with no label, naming each one and its first row", () => {
    const body = [
      monthlyTable([
        ["MiMo-V2.6-Pro", "$0.50", "$5"],
        ["Grok 4.7", "$1.00", "$1"],
      ]),
      monthlyTable([["Kimi K3", "$0.50", "$60"]]),
      monthlyTable([]),
    ].join("");
    expect(docFrom(answer({ body }))).toBeUndefined();
    expect(() => htmlToDoc(body)).toThrow(/none labelled Go or Go Plus/u);
    expect(noDocMessage([answer({ body })]).split("\n")[1]).toBe(
      `  - ${MOVED_PAGE} answered 200, text/html; charset=utf-8, ${body.length} characters, no markdown Go <TabItem>, 3 monthly-limit table(s), 2 with a model row: table 1 (unlabelled, 2 model row(s), first "MiMo-V2.6-Pro" → "$5"); table 2 (unlabelled, 1 model row(s), first "Kimi K3" → "$60"); table 3 (unlabelled, 0 model row(s)), the allowance tables were not chosen: none labelled Go or Go Plus, and 3 monthly-limit table(s), where only exactly 2 are read in the page's order`
    );
  });

  it("refuses a page with two tables labelled Go, naming both", () => {
    // By position this page read as Go and Go Plus, and exited 0.
    const body = starlightTabs([
      ["Go", monthlyTable([["Grok 4.7", "$1.00", "$15"]])],
      ["Go", monthlyTable([["Grok 4.7", "$1.00", "$60"]])],
    ]);
    expect(docFrom(answer({ body }))).toBeUndefined();
    // The markdown phrase names the markdown shape, so it cannot read as
    // contradicting the HTML tab labels on the same line.
    expect(noDocMessage([answer({ body })])).toContain(
      ', no markdown Go <TabItem>, 2 monthly-limit table(s): table 1 (tab "Go",'
    );
    expect(noDocMessage([answer({ body })])).toMatch(
      /: table 1 \(tab "Go", 1 model row\(s\), first "Grok 4.7" → "\$15"\); table 2 \(tab "Go", 1 model row\(s\), first "Grok 4.7" → "\$60"\), the allowance tables were not chosen: 2 tables labelled "Go" and no table labelled "Go Plus"$/u
    );
  });

  it("refuses two tables whose tabs name no plan, rather than reading them in order", () => {
    const body = starlightTabs([
      ["Monthly", monthlyTable([["Grok 4.7", "$1.00", "$15"]])],
      ["Annual", monthlyTable([["Grok 4.7", "$1.00", "$60"]])],
    ]);
    expect(docFrom(answer({ body }))).toBeUndefined();
    expect(() => htmlToDoc(body)).toThrow(
      /no table labelled "Go" and no table labelled "Go Plus"/u
    );
  });

  it("refuses a labelled Go table with no model row, through the parser's own rule", () => {
    const body = starlightTabs([
      ["Go Plus", monthlyTable([["Grok 4.7", "$1.00", "$60"]])],
      ["Go", monthlyTable([])],
      ["Go Max", monthlyTable([["Grok 4.7", "$1.00", "$300"]])],
    ]);
    expect(docFrom(answer({ body }))).toBeUndefined();
    expect(noDocMessage([answer({ body })])).toMatch(
      /table 2 \(tab "Go", 0 model row\(s\)\); table 3 .*, the parser rejected the allowance tables: the go table parsed to zero rows$/u
    );
  });

  it("names the tables the walk read as Go and Go Plus, and the one it ignored", async () => {
    const { read } = fakeRead({
      [MOVED_PAGE]: answer({ body: starlightTabs(THREE_PLANS) }),
    });
    const found = await firstDoc([MOVED_PAGE], read);
    expect(found.read).toBe(
      'read by label: Go from table 3 (tab "Go", 2 model row(s), first "MiMo-V2.6-Pro" → "$60"); Go Plus from table 2 (tab "Go Plus", 2 model row(s), first "MiMo-V2.6-Pro" → "$120"); ignored table 1 (tab "Go Max", 2 model row(s), first "MiMo-V2.6-Pro" → "$500")'
    );
  });

  it("names a pair read in the page's order, and the tabbed markdown, as what they are", async () => {
    const { read } = fakeRead({
      [GO_MD]: answer({ body: htmlToDoc(page()), url: GO_MD }),
      [MOVED_PAGE]: answer({ body: page() }),
    });
    const byOrder = await firstDoc([MOVED_PAGE], read);
    const tabbed = await firstDoc([GO_MD], read);
    expect(byOrder.read).toBe(
      'read in the page\'s order, no table carrying a plan label: Go from table 1 (heading "Usage limits", 2 model row(s), first "MiMo-V2.6-Pro" → "$60"); Go Plus from table 2 (heading "Usage limits", 2 model row(s), first "MiMo-V2.6-Pro" → "$120")'
    );
    expect(tabbed.read).toBe("read the tabbed markdown");
  });
});
