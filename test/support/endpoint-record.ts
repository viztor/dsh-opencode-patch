/**
 * The dated record the live probe suites write: one markdown table per suite,
 * a row per plane × protocol and a cell per URL shape.
 *
 * `test/e2e/keyless-matrix.e2e.ts` and `test/e2e/keyed-probes.e2e.ts` print
 * their tables through here, and the CI `e2e` job publishes them to the run
 * summary and the `endpoint-families` artifact. `docs/redirect-planes.md` §13
 * holds the tables of a run, pasted with its date — never hand-written — and
 * `test/endpoint-record.test.ts` holds that section to these columns and this
 * row order.
 *
 * A cell is the verdict and the HTTP status, and for a redirect the path it
 * pointed at; ` *` marks a cell the default
 * family dispatches to (`TODAY_DISPATCH`), and ` †` one `endpoint: legacy`
 * dispatches to (`LEGACY_DISPATCH`).
 *
 * Pure: every function is a function of its arguments.
 *
 * @module test/support/endpoint-record
 */
import {
  cellKey,
  LEGACY_DISPATCH,
  MATRIX_FAMILIES,
  MATRIX_PROTOCOLS,
  type MatrixFamily,
  type MatrixPlane,
  type MatrixProtocol,
  TODAY_DISPATCH,
} from "./keyless-matrix.ts";

/** One probe as the record keeps it: no header, no body. */
export interface RecordedProbe {
  readonly plane: MatrixPlane;
  readonly protocol: MatrixProtocol;
  readonly family: MatrixFamily;
  readonly model: string | undefined;
  /** `undefined` for a probe that was not answered or not sent. */
  readonly status: number | undefined;
  readonly verdict: string;
  /** The path a redirect pointed at: the probe never follows one. */
  readonly location?: string;
}

/**
 * A redirect target as a table cell can carry it: WHATWG keeps a `|` in a
 * pathname as it is, and a raw one would split the markdown row, so it is
 * percent-encoded as the URL would allow.
 */
const cellPath = (path: string): string => path.replaceAll("|", "%7C");

/** The record's header: plane, protocol, model, then the three shapes. */
export const RECORD_HEADER =
  "| Plane | Protocol | Model | `/zen(/go)/v1` (legacy) | `/inference(/go)/v1` (root) | `/inference(/go)/{openai,anthropic,google}/…` (modern) |";

/** The record's alignment row. */
export const RECORD_RULE = "| :-- | :-- | :-- | :-- | :-- | :-- |";

/** The record's rows, in order: Zen then Go, each in the matrix's protocol order. */
export const RECORD_ROWS: readonly (readonly [MatrixPlane, MatrixProtocol])[] =
  (["opencode", "opencode-go"] as const).flatMap((plane) =>
    MATRIX_PROTOCOLS.map((protocol) => [plane, protocol] as const)
  );

/**
 * One cell of the record.
 *
 * @param key - the cell's {@link cellKey}.
 * @param probe - what it answered, or `undefined` when it was not sent.
 * @returns the verdict, its status, a redirect's target path, and the
 *   dispatch marks.
 */
export const recordCell = (key: string, probe?: RecordedProbe): string => {
  let text = "not sent";
  if (probe !== undefined) {
    const target =
      probe.location === undefined ? "" : ` → ${cellPath(probe.location)}`;
    text =
      probe.status === undefined
        ? `${probe.verdict}${target}`
        : `${probe.verdict} (${probe.status}${target})`;
  }
  if (TODAY_DISPATCH.has(key)) {
    text += " *";
  }
  if (LEGACY_DISPATCH.has(key)) {
    text += " †";
  }
  return text;
};

/**
 * One suite's dated table.
 *
 * @param record.title - which suite measured it.
 * @param record.date - the UTC date of the run, `YYYY-MM-DD`.
 * @param record.run - the run's {@link runReference}.
 * @param record.probes - what each cell answered.
 * @returns the heading, a blank line and the table, joined by newlines.
 */
export const recordTable = (record: {
  readonly title: "Keyed" | "Keyless";
  readonly date: string;
  readonly run: string;
  readonly probes: readonly RecordedProbe[];
}): string => {
  const byKey = new Map(record.probes.map((probe) => [cellKey(probe), probe]));
  const rows = RECORD_ROWS.map(([plane, protocol]) => {
    const keys = MATRIX_FAMILIES.map((family) =>
      cellKey({ family, plane, protocol })
    );
    const model = keys
      .map((key) => byKey.get(key)?.model)
      .find((id) => id !== undefined);
    const cells = keys.map((key) => recordCell(key, byKey.get(key)));
    return `| \`${plane}\` | \`${protocol}\` | ${model === undefined ? "—" : `\`${model}\``} | ${cells.join(" | ")} |`;
  });
  return [
    `### ${record.title} · measured ${record.date} (UTC) · ${record.run}`,
    "",
    RECORD_HEADER,
    RECORD_RULE,
    ...rows,
  ].join("\n");
};

/** The free probe's one line. */
export const freeProbeLine = (probe: {
  readonly model: string | undefined;
  readonly status: number | undefined;
  readonly verdict: string;
}): string =>
  `Free model on \`/inference/openai/v1/chat/completions\`: ${
    probe.model === undefined ? "no model" : `\`${probe.model}\``
  } → ${probe.verdict}${probe.status === undefined ? "" : ` (${probe.status})`}.`;

/**
 * The run a record came from: a link to the CI run, or "a local run" when any
 * part of it is missing.
 */
export const runReference = (run: {
  readonly server: string | undefined;
  readonly repository: string | undefined;
  readonly runId: string | undefined;
}): string => {
  const { repository, runId, server } = run;
  if (
    server === undefined ||
    server.length === 0 ||
    repository === undefined ||
    repository.length === 0 ||
    runId === undefined ||
    runId.length === 0
  ) {
    return "a local run";
  }
  return `[run ${runId}](${server}/${repository}/actions/runs/${runId})`;
};
