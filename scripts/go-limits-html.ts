/**
 * The vendor's Go-plan page, read as the markdown the limits parser expects.
 *
 * Extracted from `generate-go-limits.ts` so it can be tested without a network
 * call, and because this is the half that BROKE: the docs moved under
 * `/v2/docs/console/` and started serving HTML, so the reader had to learn a new
 * shape. A conversion nobody can exercise is a conversion nobody knows works.
 *
 * The page carries a `Model | Input | Output | Cached Read | Cached Write |
 * Monthly limit` table per plan, and the request-estimate tables below them
 * repeat model names with no dollar column at all, which is exactly what the
 * parser is written to stop before. Until 2026-11-07 it carried two, Go first
 * and Go Plus second, measured; on 2026-11-12 it carried THREE, and which of
 * them are Go and Go Plus is not something a position or a count can say.
 *
 * So each allowance table is chosen by the plan label the page attaches to it
 * (`monthlyLimitTables`, `chooseTables`): the tab its panel names, else the
 * panel's own label, else the nearest heading before it. Go is the one table
 * labelled "Go" and Go Plus the one labelled "Go Plus"; any other labelled
 * table is ignored, and a missing or repeated plan label is refused. Exactly
 * two tables with no plan label and no tab label keep the measured order,
 * because that is the shape the shipped table was generated from; any other
 * unlabelled count is refused.
 *
 * **The tab markup is ASSUMED, not measured.** The page's markdown source used
 * Starlight's `<Tabs>`/`<TabItem label="…">`, so the HTML is read as Starlight
 * renders them: `Tabs.astro` writes a `role="tablist"` of `<a role="tab"
 * id="tab-N" href="#tab-panel-N">Label</a>`, and its `rehype-tabs` step turns
 * each `<starlight-tab-item data-label="…">` into `<div role="tabpanel"
 * id="tab-panel-N" aria-labelledby="tab-N">`. Nobody has seen the vendor's HTML
 * from here, so every log line names what each table was labelled by and its
 * first row (`describeTable`), and the next live run measures the real
 * structure whether this guess is right or not.
 *
 * It also decides which answer to read (`docFrom`) and walks the sources in turn
 * (`firstDoc`), because that half broke next: from 2026-11-07 the old `go.md`
 * URL answered 200 again with a body that had no tab sections, and a reader that
 * trusted the status handed it to the markdown parser. A 2xx answer is now read
 * by what its body carries; the status alone is never trusted. A body is taken
 * only when the parser itself reads it: as the tabbed markdown when it carries
 * both tabs, else as the HTML page when its allowance tables can be chosen, and
 * in either shape only if `parseGoLimitsDoc` reads it without an error. The
 * parser is the test, not a proxy for it, so anything it would throw on falls
 * through to the next source rather than to the parser's error, and the error
 * when no source is left names every table each answer carried and why none
 * was read.
 *
 * @module scripts/go-limits-html
 */

import { GO_LIMITS_DOC_URL, parseGoLimitsDoc } from "../src/go-limits.ts";

/**
 * Where the page lives. Measured 2026-11-12: `/v2/docs/console/go/` and the
 * old `go.md` both redirect here, so this is the canonical URL.
 */
export const GO_LIMITS_DOC_MOVED_TO = "https://opencode.ai/docs/console/go/";

/** The heading of the table this reader takes, as the page spells it. */
const MONTHLY_LIMIT_HEADER = "monthly limit";

/** The named references a cell's text can carry, and the characters they stand for. */
const NAMED_REFERENCES: ReadonlyMap<string, string> = new Map([
  ["amp", "&"],
  ["apos", "'"],
  ["ge", "≥"],
  ["gt", ">"],
  ["le", "≤"],
  ["lt", "<"],
  ["nbsp", "\u00A0"],
  ["quot", '"'],
]);

/**
 * Decode a cell's character references into the text a browser shows.
 *
 * One pass, so `&amp;lt;` is the text `&lt;` and never `<`. A name outside
 * `NAMED_REFERENCES`, and a number that names no character, is left as written:
 * guessing a character would put one in the table the page never showed.
 *
 * @param text - a cell's text, its tags already stripped.
 * @returns the text with each reference it knows decoded.
 */
const decodeReferences = (text: string): string =>
  text.replaceAll(
    /&(?:#(\d+)|#[xX]([\da-fA-F]+)|([A-Za-z]+));/gu,
    (reference, decimal?: string, hex?: string, name?: string) => {
      if (name !== undefined) {
        return NAMED_REFERENCES.get(name) ?? reference;
      }
      const code =
        decimal === undefined
          ? Number.parseInt(hex ?? "", 16)
          : Number(decimal);
      const names =
        code > 0 && code <= 0x10_ff_ff && (code < 0xd8_00 || code > 0xdf_ff);
      return names ? String.fromCodePoint(code) : reference;
    }
  );

/**
 * An element's content as the text a browser shows.
 *
 * A `<br>` reads as a space, the tags come off, the character references are
 * decoded (after the tags, so an encoded `&lt;b&gt;` is text the page shows,
 * not markup to strip), and any run of whitespace, newlines and no-break
 * spaces included, reads as one space.
 *
 * @param html - the element's inner HTML.
 * @returns its text, trimmed.
 */
const textOf = (html: string): string =>
  decodeReferences(
    html.replaceAll(/<br\s*\/?>/giu, " ").replaceAll(/<[^>]+>/gu, "")
  )
    .replaceAll(/\s+/gu, " ")
    .trim();

/**
 * A table's cells, row by row, as the text a browser shows (`textOf`).
 *
 * Each cell becomes one line. The converter writes one markdown row per line,
 * and a newline kept inside a cell would split the row in two halves the parser
 * skips without naming either. A reference kept verbatim is no better: `&#36;15`
 * is no dollar amount to the parser, and `Grok&nbsp;4.7` slugs to an id no
 * catalog carries.
 *
 * @param html - one `<table>` element's inner HTML.
 * @returns one array of cell strings per `<tr>`.
 */
export const tableRows = (html: string): string[][] =>
  [...html.matchAll(/<tr[^>]*>(.*?)<\/tr>/gsu)].map((row) =>
    [...(row[1] ?? "").matchAll(/<t[dh][^>]*>(.*?)<\/t[dh]>/gsu)].map((cell) =>
      textOf(cell[1] ?? "")
    )
  );

/** One start or end tag, as `tagsOf` reads it. */
interface Tag {
  /** Where the tag starts and ends in the page. */
  readonly start: number;
  readonly end: number;
  /** The element's name, lower-cased. */
  readonly name: string;
  readonly closing: boolean;
  /** Each attribute's lower-cased name and decoded value (`""` when bare). */
  readonly attributes: ReadonlyMap<string, string>;
}

/**
 * A start or end tag: attributes in any order, quoted either way or not at
 * all, so a `>` inside a quoted value does not end the tag.
 */
const TAG =
  /<(\/?)([A-Za-z][\w:-]*)((?:\s+[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*\/?>/gu;

/** One attribute inside a tag. */
const ATTRIBUTE =
  /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/gu;

/**
 * A page with its comments and its scripts' and styles' contents blanked out,
 * same length, so a `</div>` in a script or a comment is not the page's
 * structure and every position still points at the same place.
 *
 * @param html - a page's HTML.
 * @returns the page, positions kept.
 */
const blankInert = (html: string): string =>
  html.replaceAll(
    /<!--.*?-->|<(script|style)\b[^>]*>.*?<\/\1\s*>/gisu,
    (inert) => " ".repeat(inert.length)
  );

/**
 * Every tag in a page, in order.
 *
 * @param html - a page's HTML, inert parts blanked.
 * @returns the tags.
 */
const tagsOf = (html: string): Tag[] =>
  [...html.matchAll(TAG)].map((tag) => ({
    attributes: new Map(
      [...(tag[3] ?? "").matchAll(ATTRIBUTE)].map((attribute) => [
        (attribute[1] ?? "").toLowerCase(),
        decodeReferences(attribute[2] ?? attribute[3] ?? attribute[4] ?? ""),
      ])
    ),
    closing: tag[1] === "/",
    end: tag.index + tag[0].length,
    name: (tag[2] ?? "").toLowerCase(),
    start: tag.index,
  }));

/**
 * The end tag that closes the element a start tag opens, counting the same
 * element nested inside it.
 *
 * @param tags - the page's tags.
 * @param open - the index of the start tag.
 * @returns the end tag, or `undefined` when the page never closes it.
 */
const closeOf = (tags: readonly Tag[], open: number): Tag | undefined => {
  const name = tags[open]?.name;
  let depth = 0;
  for (const tag of tags.slice(open + 1)) {
    if (tag.name !== name) {
      continue;
    }
    if (!tag.closing) {
      depth += 1;
    } else if (depth === 0) {
      return tag;
    } else {
      depth -= 1;
    }
  }
  return undefined;
};

/** Where a table's label came from, and its text. */
export interface TableLabel {
  /**
   * `tab`: the element the panel's `aria-labelledby` names; `panel`: the
   * panel's own `data-label` or `aria-label`; `heading`: the nearest `h2`-`h4`
   * before the table.
   */
  readonly source: "heading" | "panel" | "tab";
  /** The text a browser shows for it. */
  readonly text: string;
}

/** One allowance table, with what the page labelled it. */
export interface AllowanceTable {
  /** Its place among the page's allowance tables, from 1. */
  readonly number: number;
  /** Its rows, header first. */
  readonly rows: readonly string[][];
  /** Its label, or `undefined` when the page attaches none. */
  readonly label: TableLabel | undefined;
}

/**
 * Whether a start tag opens a tab panel: a `role="tabpanel"`, or a Starlight
 * `<starlight-tab-item>` its rehype step has not yet turned into one.
 *
 * @param tag - one tag.
 * @returns whether it opens a panel.
 */
const opensPanel = (tag: Tag): boolean =>
  !tag.closing &&
  (tag.name === "starlight-tab-item" ||
    (tag.attributes.get("role") ?? "")
      .toLowerCase()
      .split(/\s+/u)
      .includes("tabpanel"));

/**
 * The text of the elements an `aria-labelledby` names, joined.
 *
 * Only an `id` attribute is the element: an `href="#tab-0"` or a
 * `data-ref="tab-0"` names the id without being it.
 *
 * @param html - the page, inert parts blanked.
 * @param tags - its tags.
 * @param ids - the attribute's value, ids separated by whitespace.
 * @returns the text, `""` when no named element has any.
 */
const labelledBy = (html: string, tags: readonly Tag[], ids: string): string =>
  ids
    .split(/\s+/u)
    .filter((id) => id.length > 0)
    .map((id) => {
      const open = tags.findIndex(
        (tag) => !tag.closing && tag.attributes.get("id") === id
      );
      const close = open === -1 ? undefined : closeOf(tags, open);
      return close === undefined
        ? ""
        : textOf(html.slice(tags[open]?.end, close.start));
    })
    .filter((text) => text.length > 0)
    .join(" ");

/**
 * The label the page attaches to whatever starts at `at`.
 *
 * In order: the innermost tab panel around it whose `aria-labelledby` names an
 * element with text, or whose own `data-label`/`aria-label` has text; else the
 * nearest `h2`-`h4` that starts before it; else none.
 *
 * @param html - the page, inert parts blanked.
 * @param tags - its tags.
 * @param at - where the table starts.
 * @returns the label, or `undefined`.
 */
const labelAt = (
  html: string,
  tags: readonly Tag[],
  at: number
): TableLabel | undefined => {
  const panels = tags
    .map((tag, index) => ({ index, tag }))
    .filter(
      ({ index, tag }) =>
        opensPanel(tag) &&
        tag.end <= at &&
        at < (closeOf(tags, index)?.start ?? html.length)
    )
    .toReversed();
  for (const { tag } of panels) {
    const tab = labelledBy(
      html,
      tags,
      tag.attributes.get("aria-labelledby") ?? ""
    );
    if (tab.length > 0) {
      return { source: "tab", text: tab };
    }
    const own = textOf(
      tag.attributes.get("data-label") ?? tag.attributes.get("aria-label") ?? ""
    );
    if (own.length > 0) {
      return { source: "panel", text: own };
    }
  }
  const heading = tags.findLastIndex(
    (tag) => !tag.closing && /^h[2-4]$/u.test(tag.name) && tag.end <= at
  );
  const close = heading === -1 ? undefined : closeOf(tags, heading);
  const text =
    close === undefined
      ? ""
      : textOf(html.slice(tags[heading]?.end, close.start));
  return text.length > 0 ? { source: "heading", text } : undefined;
};

/**
 * The page's allowance tables, those whose header ends in "Monthly limit",
 * each with the label the page attaches to it (`labelAt`).
 *
 * Chosen by header, never by position or shape, because the request-estimate
 * tables have the same column count and the same model names.
 *
 * @param page - a page's HTML.
 * @returns each allowance table, in the page's order.
 */
export const monthlyLimitTables = (page: string): AllowanceTable[] => {
  const html = blankInert(page);
  const found = [...html.matchAll(/<table(?=[\s>])[^>]*>(.*?)<\/table>/gsu)]
    .map((table) => ({ at: table.index, rows: tableRows(table[1] ?? "") }))
    .filter(({ rows }) =>
      (rows[0] ?? []).at(-1)?.toLowerCase().includes(MONTHLY_LIMIT_HEADER)
    );
  const tags = found.length === 0 ? [] : tagsOf(html);
  return found.map(({ at, rows }, index) => ({
    label: labelAt(html, tags, at),
    number: index + 1,
    rows,
  }));
};

/** The markdown header the parser reads, repeated for each plan's section. */
const MARKDOWN_HEADER = [
  "| Model | Input | Output | Cached Read | Cached Write | Monthly limit |",
  "| --- | --- | --- | --- | --- | --- |",
];

/**
 * A table's model rows: those under the header with the six cells the
 * allowance table has. A shorter row is not one the parser reads.
 *
 * @param rows - one table's rows, header first.
 * @returns the rows the converter writes out.
 */
const modelRows = (rows: readonly string[][]): string[][] =>
  rows.slice(1).filter((cells) => cells.length >= 6);

/** Which plan a label names, if it names one: `Go` or `Go Plus`, any case. */
const planOf = (table: AllowanceTable): "go" | "goPlus" | undefined => {
  const text = table.label?.text.trim().toLowerCase();
  if (text === "go") {
    return "go";
  }
  return text === "go plus" ? "goPlus" : undefined;
};

/** The tables chosen as Go and Go Plus, or why none were. */
export type TableChoice =
  | {
      /** `label` when each plan's table carries its label, `order` otherwise. */
      readonly by: "label" | "order";
      readonly go: AllowanceTable;
      readonly goPlus: AllowanceTable;
      /** The allowance tables read as neither plan. */
      readonly ignored: readonly AllowanceTable[];
    }
  | { readonly refused: string };

/**
 * Choose Go and Go Plus among the page's allowance tables, by their labels.
 *
 * When any table carries a plan label, or any carries a tab's label, the
 * labels decide: Go is the one table labelled "Go", Go Plus the one labelled
 * "Go Plus", and every other table is ignored; a plan with no table, or with
 * more than one, is refused. When none does, exactly two tables keep the
 * measured order, Go first, and any other count is refused. A heading that
 * names no plan is no label to choose by, so two tables under one "Usage
 * limits" heading are the measured shape; a tab that names no plan is, so two
 * tabs named anything else are refused rather than read in order.
 *
 * @param tables - the page's allowance tables.
 * @returns the choice, or the reason there is none.
 */
export const chooseTables = (
  tables: readonly AllowanceTable[]
): TableChoice => {
  const labelled = tables.some(
    (table) =>
      planOf(table) !== undefined ||
      (table.label !== undefined && table.label.source !== "heading")
  );
  if (!labelled) {
    const [go, goPlus] = tables;
    if (tables.length === 2 && go !== undefined && goPlus !== undefined) {
      return { by: "order", go, goPlus, ignored: [] };
    }
    return {
      refused:
        tables.length === 0
          ? "no monthly-limit table"
          : `none labelled Go or Go Plus, and ${tables.length} monthly-limit table(s), where only exactly 2 are read in the page's order`,
    };
  }
  const go = tables.filter((table) => planOf(table) === "go");
  const goPlus = tables.filter((table) => planOf(table) === "goPlus");
  const problems = (
    [
      ["Go", go],
      ["Go Plus", goPlus],
    ] as const
  ).flatMap(([plan, found]) => {
    if (found.length === 0) {
      return [`no table labelled "${plan}"`];
    }
    return found.length > 1
      ? [`${found.length} tables labelled "${plan}"`]
      : [];
  });
  const [goTable] = go;
  const [goPlusTable] = goPlus;
  if (
    problems.length > 0 ||
    goTable === undefined ||
    goPlusTable === undefined
  ) {
    return { refused: problems.join(" and ") };
  }
  return {
    by: "label",
    go: goTable,
    goPlus: goPlusTable,
    ignored: tables.filter((table) => planOf(table) === undefined),
  };
};

/**
 * One allowance table, as a log line names it: its place, its label and where
 * the label came from, its model rows, and the first row's name and allowance.
 *
 * @param table - one allowance table.
 * @returns e.g. `table 2 (tab "Go", 14 model row(s), first "Grok 4.7" → "$15")`.
 */
export const describeTable = (table: AllowanceTable): string => {
  const label =
    table.label === undefined
      ? "unlabelled"
      : `${table.label.source} "${table.label.text}"`;
  const rows = modelRows(table.rows);
  const [first] = rows;
  const firstRow =
    first === undefined
      ? ""
      : `, first "${first[0] ?? ""}" → "${first.at(-1) ?? ""}"`;
  return `table ${table.number} (${label}, ${rows.length} model row(s)${firstRow})`;
};

/**
 * What a choice read, for the generator's `source:` line.
 *
 * @param choice - a choice that was not refused.
 * @returns which table was read as each plan, and which were ignored.
 */
const describeChoice = (
  choice: Exclude<TableChoice, { readonly refused: string }>
): string =>
  [
    choice.by === "label"
      ? "read by label: "
      : "read in the page's order, no table carrying a plan label: ",
    `Go from ${describeTable(choice.go)}; Go Plus from ${describeTable(choice.goPlus)}`,
    ...choice.ignored.map((table) => `; ignored ${describeTable(table)}`),
  ].join("");

/**
 * The parser's markdown for the tables a choice read: one `<TabItem>` per
 * plan, as the markdown source wrote them.
 *
 * @param choice - a choice that was not refused.
 * @returns the markdown.
 */
const docOf = (
  choice: Exclude<TableChoice, { readonly refused: string }>
): string => {
  const section = (label: string, table: AllowanceTable): string =>
    [
      `<TabItem label="${label}">`,
      ...MARKDOWN_HEADER,
      ...modelRows(table.rows).map(
        (cells) =>
          `| ${cells[0] ?? ""} | ${cells.slice(1, -1).join(" | ")} | **${cells.at(-1) ?? ""}** |`
      ),
      "</TabItem>",
    ].join("\n");
  return [section("Go", choice.go), section("Go Plus", choice.goPlus)].join(
    "\n"
  );
};

/**
 * Turn the moved page's HTML into the markdown `parseGoLimitsDoc` reads.
 *
 * @param html - the page's HTML.
 * @returns markdown in the shape the parser expects, one `<TabItem>` per plan.
 * @throws {Error} unless `chooseTables` chooses Go and Go Plus. A page with no
 * table would silently read as "no models", and the generated file would be
 * written with every allowance missing; a page whose tables cannot be told
 * apart by their labels would leave which two are Go and Go Plus to a guess,
 * and a wrong pair reads exactly like a right one.
 */
export const htmlToDoc = (html: string): string => {
  const choice = chooseTables(monthlyLimitTables(html));
  if ("refused" in choice) {
    throw new Error(
      `go-limits: the page's allowance tables were not chosen: ${choice.refused}`
    );
  }
  return docOf(choice);
};

/** The sections the markdown source opens each plan's table with. */
const GO_TAB = '<TabItem label="Go">';
const GO_PLUS_TAB = '<TabItem label="Go Plus">';

/**
 * The sources, in the order they are asked: the page the docs live on, then
 * the old markdown URL, in case it is ever the one that carries the tables
 * again.
 */
export const GO_LIMITS_SOURCES: readonly string[] = [
  GO_LIMITS_DOC_MOVED_TO,
  GO_LIMITS_DOC_URL,
];

/** What one source answered, as the generator records it. */
export interface DocAnswer {
  /** The URL asked for. */
  readonly url: string;
  /** Where the answer came from after redirects (`Response.url`). */
  readonly finalUrl: string;
  readonly status: number;
  /** The `content-type` header, or `""` when there was none. */
  readonly contentType: string;
  /** The body, read only for a 2xx answer; `""` otherwise. */
  readonly body: string;
}

/** What a body yields: the parser's markdown, what it read, and why each shape tried before it was not. */
interface Reading {
  /** The first shape the parser read without an error, or `undefined`. */
  readonly doc: string | undefined;
  /** What that shape read, for the `source:` line; `""` without a doc. */
  readonly read: string;
  /** One phrase per shape not taken, in the order they were tried. */
  readonly rejected: readonly string[];
}

/**
 * The parser's complaint about a markdown body, if it has one.
 *
 * @param doc - the markdown.
 * @returns the reason, without the `go-limits:` prefix, or `undefined`.
 */
const parserReason = (doc: string): string | undefined => {
  try {
    parseGoLimitsDoc(doc);
    return undefined;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return reason.replace(/^go-limits: /u, "");
  }
};

/**
 * Read a body in each of its shapes until the parser reads one: the tabbed
 * markdown as it is, when it carries both plans' tabs, then the HTML page's
 * allowance tables, when it carries any, as `chooseTables` chooses them.
 *
 * The verdict is the parser's own: a shape is taken only when
 * `parseGoLimitsDoc` reads it without throwing, so a body that merely looks
 * right (both tabs and no rows, six-cell rows with no dollar amount) is not
 * taken. Rows the parser reads but cannot map are not a rejection: they come
 * back in its `unmapped`, which the generator reports and fails on.
 *
 * @param body - one answer's body.
 * @returns the markdown and what it read, or `undefined` with the reason per shape.
 */
const readBody = (body: string): Reading => {
  const rejected: string[] = [];
  if (body.includes(GO_TAB) && body.includes(GO_PLUS_TAB)) {
    const reason = parserReason(body);
    if (reason === undefined) {
      return { doc: body, read: "read the tabbed markdown", rejected };
    }
    rejected.push(`the parser rejected the tabbed markdown: ${reason}`);
  }
  const tables = monthlyLimitTables(body);
  if (tables.length === 0) {
    return { doc: undefined, read: "", rejected };
  }
  const choice = chooseTables(tables);
  if ("refused" in choice) {
    rejected.push(`the allowance tables were not chosen: ${choice.refused}`);
    return { doc: undefined, read: "", rejected };
  }
  const doc = docOf(choice);
  const reason = parserReason(doc);
  if (reason === undefined) {
    return { doc, read: describeChoice(choice), rejected };
  }
  rejected.push(`the parser rejected the allowance tables: ${reason}`);
  return { doc: undefined, read: "", rejected };
};

/**
 * What one answer yields: nothing outside 2xx, its body's reading otherwise.
 *
 * @param answer - one source's answer.
 * @returns the reading.
 */
const readAnswer = (answer: DocAnswer): Reading =>
  answer.status < 200 || answer.status > 299
    ? { doc: undefined, read: "", rejected: [] }
    : readBody(answer.body);

/**
 * The markdown `parseGoLimitsDoc` reads, from whatever a source answered.
 *
 * A 2xx answer is read by what its body carries; the status alone is never
 * trusted, and an answer outside 2xx is not read at all. The tabbed markdown,
 * carrying both plans' tabs, is passed through; an HTML page whose Go and Go
 * Plus tables `chooseTables` can choose is converted; and either is taken only
 * when the parser reads it without an error. Anything else answers
 * `undefined`, so the next source is tried and the parser never sees a body it
 * would throw on.
 *
 * @param answer - one source's answer.
 * @returns the parser's markdown, or `undefined` when this answer has none.
 */
export const docFrom = (answer: DocAnswer): string | undefined =>
  readAnswer(answer).doc;

/**
 * Which of the markdown tabs a body carries, for the error.
 *
 * @param body - one answer's body.
 * @returns the phrase the error line uses.
 */
const tabsCarried = (body: string): string => {
  if (!body.includes(GO_TAB)) {
    return "no Go tab";
  }
  return body.includes(GO_PLUS_TAB)
    ? "the Go and Go Plus tabs"
    : "the Go tab but no Go Plus tab";
};

/**
 * How many allowance tables a body carries, how many of them have a model row
 * when that is fewer, and each one as `describeTable` names it.
 *
 * @param body - one answer's body.
 * @returns the phrase the error line uses.
 */
const tablesCarried = (body: string): string => {
  const tables = monthlyLimitTables(body);
  const readable = tables.filter(
    (table) => modelRows(table.rows).length > 0
  ).length;
  const count =
    readable === tables.length
      ? `${tables.length} monthly-limit table(s)`
      : `${tables.length} monthly-limit table(s), ${readable} with a model row`;
  return tables.length === 0
    ? count
    : `${count}: ${tables.map((table) => describeTable(table)).join("; ")}`;
};

/**
 * The error for a run in which no source carried the tables.
 *
 * One line per source, with what tells the shapes apart: the status, a
 * redirect, the content type, the size, which of the two shapes the body
 * carried, every allowance table with its label, its model rows and its first
 * row, and, for each shape not taken, why: the tables could not be chosen, or
 * the parser's reason for rejecting what it was handed. A layout change then
 * names itself in the nightly log, and a body that only looked readable says
 * what could not be read in it.
 *
 * @param answers - every source's answer, in the order they were asked.
 * @returns the message.
 */
export const noDocMessage = (answers: readonly DocAnswer[]): string =>
  [
    "go-limits: no source carried the allowance tables",
    ...answers.map((answer) => {
      const redirected =
        answer.finalUrl === answer.url
          ? ""
          : ` (redirected to ${answer.finalUrl})`;
      const rejected = readBody(answer.body).rejected.map(
        (reason) => `, ${reason}`
      );
      return `  - ${answer.url} answered ${answer.status}${redirected}, ${answer.contentType || "no content type"}, ${answer.body.length} characters, ${tabsCarried(answer.body)}, ${tablesCarried(answer.body)}${rejected.join("")}`;
    }),
  ].join("\n");

/** The source a walk read, and what it answered. */
export interface FoundDoc {
  /** The parser's markdown. */
  readonly doc: string;
  /** The source that carried it. */
  readonly source: string;
  /** What that source answered. */
  readonly answer: DocAnswer;
  /**
   * What the doc was read from: the tabbed markdown, or which allowance table
   * was read as Go and as Go Plus and which were ignored (`describeTable`).
   */
  readonly read: string;
}

/**
 * The first source whose answer carries the tables, asked one at a time.
 *
 * In turn, not all at once: a later source is asked only when every earlier one
 * answered nothing the parser reads (a status outside 2xx, neither shape, tables
 * that could not be chosen, or a shape the parser rejected), and the error then
 * names what each one answered. The
 * reader is a parameter, so the walk runs without a network; a reader that
 * rejects rejects the walk, because a source that could not be asked is not one
 * that answered "nothing here".
 *
 * @param sources - the sources, in the order to ask them.
 * @param read - how a source is asked.
 * @param answers - what the sources before these answered.
 * @returns the markdown, the source it came from, that source's answer, and
 * what the markdown was read from.
 * @throws {Error} `noDocMessage` of every answer, when none carried the tables.
 */
export const firstDoc = async (
  sources: readonly string[],
  read: (source: string) => Promise<DocAnswer>,
  answers: readonly DocAnswer[] = []
): Promise<FoundDoc> => {
  const [source, ...rest] = sources;
  if (source === undefined) {
    throw new Error(noDocMessage(answers));
  }
  const answer = await read(source);
  const reading = readAnswer(answer);
  return reading.doc === undefined
    ? firstDoc(rest, read, [...answers, answer])
    : { answer, doc: reading.doc, read: reading.read, source };
};
