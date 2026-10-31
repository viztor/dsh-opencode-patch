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
 * @module scripts/go-limits-html
 */

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

/** The markdown header the parser reads, repeated for each plan's section. */
const MARKDOWN_HEADER = [
  "| Model | Input | Output | Cached Read | Cached Write | Monthly limit |",
  "| --- | --- | --- | --- | --- | --- |",
];

/**
 * Turn the moved page's HTML into the markdown `parseGoLimitsDoc` reads.
 *
 * @param html - the page's HTML.
 * @returns markdown in the shape the parser expects, one `<TabItem>` per plan.
 * @throws {Error} when the two dollar tables are not both present, because an
 * empty document would silently read as "no models" rather than as a broken
 * source — and the generated file would then be written with every allowance
 * missing.
 */
export const htmlToDoc = (html: string): string => {
  const dollarTables = [...html.matchAll(/<table[^>]*>(.*?)<\/table>/gsu)]
    .map((table) => tableRows(table[1] ?? ""))
    .filter((rows) =>
      (rows[0] ?? []).at(-1)?.toLowerCase().includes(MONTHLY_LIMIT_HEADER)
    );
  if (dollarTables.length < 2) {
    throw new Error(
      `go-limits: ${GO_LIMITS_DOC_MOVED_TO} carried ${dollarTables.length} monthly-limit table(s), expected 2`
    );
  }
  const [go, goPlus] = dollarTables;
  const section = (label: string, rows: readonly string[][]): string =>
    [
      `<TabItem label="${label}">`,
      ...MARKDOWN_HEADER,
      ...rows
        .slice(1)
        .filter((cells) => cells.length >= 6 && cells[0] !== undefined)
        .map(
          (cells) =>
            `| ${cells[0]} | ${cells.slice(1, -1).join(" | ")} | **${cells.at(-1) ?? ""}** |`
        ),
      "</TabItem>",
    ].join("\n");
  return [section("Go", go ?? []), section("Go Plus", goPlus ?? [])].join("\n");
};
