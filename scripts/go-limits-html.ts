/**
 * The vendor's Go-plan page, read as the markdown the limits parser expects.
 *
 * Extracted from `generate-go-limits.ts` so it can be tested without a network
 * call, and because this is the half that BROKE: the docs moved under
 * `/v2/docs/console/` and started serving HTML, so the reader had to learn a new
 * shape. A conversion nobody can exercise is a conversion nobody knows works.
 *
 * The page carries one `Model | Input | Output | Cached Read | Cached Write |
 * Monthly limit` table per plan — Go first, Go Plus second, measured — and the
 * request-estimate tables below them repeat model names with no dollar column at
 * all, which is exactly what the parser is written to stop before.
 *
 * It also decides which answer to read (`docFrom`) and walks the sources in turn
 * (`firstDoc`), because that half broke next: from 2026-11-07 the old `go.md`
 * URL answered 200 again with a body that had no tab sections, and a reader that
 * trusted the status handed it to the markdown parser. A 2xx answer is now read
 * by what its body carries; the status alone is never trusted. A body is taken
 * only in a shape the parser can read — both tabs, or exactly two allowance
 * tables each with a model row — so anything else falls through to the next
 * source rather than to the parser's error.
 *
 * @module scripts/go-limits-html
 */

import { GO_LIMITS_DOC_URL } from "../src/go-limits.ts";

/** Where the page lives, for the error message. */
export const GO_LIMITS_DOC_MOVED_TO = "https://opencode.ai/v2/docs/console/go/";

/** The heading of the table this reader takes, as the page spells it. */
const MONTHLY_LIMIT_HEADER = "monthly limit";

/**
 * Strip tags from a table's cells, row by row.
 *
 * @param html - one `<table>` element's inner HTML.
 * @returns one array of cell strings per `<tr>`.
 */
export const tableRows = (html: string): string[][] =>
  [...html.matchAll(/<tr[^>]*>(.*?)<\/tr>/gsu)].map((row) =>
    [...(row[1] ?? "").matchAll(/<t[dh][^>]*>(.*?)<\/t[dh]>/gsu)].map((cell) =>
      (cell[1] ?? "").replaceAll(/<[^>]+>/gu, "").trim()
    )
  );

/**
 * The page's allowance tables: those whose header ends in "Monthly limit".
 *
 * Chosen by header, never by position or shape, because the request-estimate
 * tables have the same column count and the same model names.
 *
 * @param html - a page's HTML.
 * @returns each allowance table's rows, header first, in the page's order.
 */
const monthlyLimitTables = (html: string): string[][][] =>
  [...html.matchAll(/<table[^>]*>(.*?)<\/table>/gsu)]
    .map((table) => tableRows(table[1] ?? ""))
    .filter((rows) =>
      (rows[0] ?? []).at(-1)?.toLowerCase().includes(MONTHLY_LIMIT_HEADER)
    );

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

/**
 * Turn the moved page's HTML into the markdown `parseGoLimitsDoc` reads.
 *
 * @param html - the page's HTML.
 * @returns markdown in the shape the parser expects, one `<TabItem>` per plan.
 * @throws {Error} unless the page carries exactly two allowance tables. Fewer
 * would silently read as "no models" rather than as a broken source, and the
 * generated file would then be written with every allowance missing; more would
 * leave which two are Go and Go Plus to their position, and a wrong pair reads
 * exactly like a right one.
 */
export const htmlToDoc = (html: string): string => {
  const dollarTables = monthlyLimitTables(html);
  if (dollarTables.length !== 2) {
    throw new Error(
      `go-limits: ${GO_LIMITS_DOC_MOVED_TO} carried ${dollarTables.length} monthly-limit table(s), expected exactly 2`
    );
  }
  const [go, goPlus] = dollarTables;
  const section = (label: string, rows: readonly string[][]): string =>
    [
      `<TabItem label="${label}">`,
      ...MARKDOWN_HEADER,
      ...modelRows(rows).map(
        (cells) =>
          `| ${cells[0] ?? ""} | ${cells.slice(1, -1).join(" | ")} | **${cells.at(-1) ?? ""}** |`
      ),
      "</TabItem>",
    ].join("\n");
  return [section("Go", go ?? []), section("Go Plus", goPlus ?? [])].join("\n");
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

/**
 * The markdown `parseGoLimitsDoc` reads, from whatever a source answered.
 *
 * A 2xx answer is read by what its body carries; the status alone is never
 * trusted, and an answer outside 2xx is not read at all. The tabbed markdown,
 * carrying both plans' tabs, is passed through; an HTML page carrying exactly
 * two allowance tables, each with a model row, is converted. Anything else
 * answers `undefined`, so the next source is tried and the parser never sees a
 * body it would throw on.
 *
 * @param answer - one source's answer.
 * @returns the parser's markdown, or `undefined` when this answer has none.
 */
export const docFrom = (answer: DocAnswer): string | undefined => {
  if (answer.status < 200 || answer.status > 299) {
    return undefined;
  }
  if (answer.body.includes(GO_TAB) && answer.body.includes(GO_PLUS_TAB)) {
    return answer.body;
  }
  const tables = monthlyLimitTables(answer.body);
  return tables.length === 2 &&
    tables.every((rows) => modelRows(rows).length > 0)
    ? htmlToDoc(answer.body)
    : undefined;
};

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
 * How many allowance tables a body carries, and how many of them have a model
 * row when that is fewer.
 *
 * @param body - one answer's body.
 * @returns the phrase the error line uses.
 */
const tablesCarried = (body: string): string => {
  const tables = monthlyLimitTables(body);
  const readable = tables.filter((rows) => modelRows(rows).length > 0).length;
  return readable === tables.length
    ? `${tables.length} monthly-limit table(s)`
    : `${tables.length} monthly-limit table(s), ${readable} with a model row`;
};

/**
 * The error for a run in which no source carried the tables.
 *
 * One line per source, with what tells the shapes apart: the status, a
 * redirect, the content type, the size, and which of the two shapes the body
 * carried. A layout change then names itself in the nightly log, rather than
 * surfacing as the parser's complaint about a body it should never have seen.
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
      return `  - ${answer.url} answered ${answer.status}${redirected}, ${answer.contentType || "no content type"}, ${answer.body.length} characters, ${tabsCarried(answer.body)}, ${tablesCarried(answer.body)}`;
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
}

/**
 * The first source whose answer carries the tables, asked one at a time.
 *
 * In turn, not all at once: a later source is asked only when every earlier one
 * carried neither shape, and the error then names what each one answered. The
 * reader is a parameter, so the walk runs without a network; a reader that
 * rejects rejects the walk, because a source that could not be asked is not one
 * that answered "nothing here".
 *
 * @param sources - the sources, in the order to ask them.
 * @param read - how a source is asked.
 * @param answers - what the sources before these answered.
 * @returns the markdown, the source it came from, and that source's answer.
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
  const doc = docFrom(answer);
  return doc === undefined
    ? firstDoc(rest, read, [...answers, answer])
    : { answer, doc, source };
};
