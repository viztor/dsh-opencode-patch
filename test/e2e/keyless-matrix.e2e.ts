/**
 * The keyless 401-vs-404 matrix against the live gateway.
 *
 * Sixteen POSTs, none carrying a key: two planes × four protocols × the
 * legacy (`/zen(/go)/v1`) and modern (`/inference(/go)/…`) endpoint families,
 * each with one PAID model from the live catalog slice (a free model answers
 * keyless with a real completion, so the matrix never picks one). The gateway
 * authenticates before it routes, so the answer says whether the PATH exists
 * without spending anything. It runs on every pull request, because it needs
 * no secret; it never reads `OPENCODE_API_KEY` or `OPENCODE_GO_API_KEY`.
 *
 * What it asserts:
 *
 * - every one of the sixteen cells has a model and was SENT, and every answer
 *   is one the matrix can read — an empty or reshaped catalog fails here
 *   rather than measuring nothing;
 * - no cell today's plugin dispatches to with the default endpoint (`auto`,
 *   an alias of `modern`; `TODAY_DISPATCH`: completions on the legacy family,
 *   the hidden routes' Responses, Messages and Google on the modern one)
 *   answers "path gone";
 * - nor do the modern completions cells (`NEXT_DISPATCH`), where P-R1 moves
 *   completions: a forward guard, labelled as such when it fails.
 *
 * The other legacy verdicts are recorded, not asserted: P-R2 decides the
 * family from them. They include the cells an `endpoint: legacy` user
 * dispatches to — Responses and Messages on both planes, and Zen's Google —
 * so this file does not guard that configuration; P-R2 decides whether it
 * should. Go's Google stays on `/inference/go/google/v1beta` under every
 * family (`GO_GOOGLE_BASE_URL`), the modern cell `TODAY_DISPATCH` asserts.
 * The cell table, both sets and the classifier are unit-tested offline in
 * `test/keyless-matrix.test.ts`.
 *
 * It always measures the vendor's own gateway: the cells are the vendor's
 * paths, which a mirror's `/zen(/go)/v1` base cannot name. So it SKIPS when
 * `OPENCODE_ZEN_BASE_URL` or `OPENCODE_GO_BASE_URL` points the rest of the
 * suite at a mirror.
 *
 * Opt-in: `OPENCODE_E2E=1 pnpm run test:e2e`.
 *
 * @module test/e2e/keyless-matrix.e2e
 */
import { describe, expect, it } from "vitest";

import {
  cellKey,
  classifyKeylessProbe,
  isTransientProbeAnswer,
  type KeylessVerdict,
  keylessMatrix,
  type MatrixCell,
  NEXT_DISPATCH,
  TODAY_DISPATCH,
} from "../support/keyless-matrix.ts";
import { MODELS_OPENCODE_URL, parseModelsDevCatalog } from "../support/src.ts";

const LIVE = process.env.OPENCODE_E2E === "1";
/** A mirror the rest of the suite is pointed at, which this file cannot follow. */
const MIRRORED = ["OPENCODE_ZEN_BASE_URL", "OPENCODE_GO_BASE_URL"].some(
  (name) => (process.env[name] ?? "").length > 0
);
if (LIVE && MIRRORED) {
  console.info(
    "[keyless-matrix] skipped: a mirror base URL is set, and the matrix measures only the vendor's own paths"
  );
}

const PROBE_TIMEOUT_MS = 30_000;
/** The pause before the one retry of a transient answer. */
const RETRY_AFTER_MS = 2000;

/** One probe's outcome, with no request or response header in it. */
interface ProbeRow {
  readonly cell: string;
  readonly model: string | undefined;
  readonly status: number | undefined;
  readonly verdict: KeylessVerdict | "transport-error";
  /** The start of the body, kept only for a verdict the matrix cannot read. */
  readonly body?: string;
}

/** One keyless request: its status and body, or `undefined` on a transport error. */
const send = async (
  cell: MatrixCell
): Promise<{ status: number; bodyText: string } | undefined> => {
  try {
    const response = await fetch(cell.url, {
      body: JSON.stringify(cell.body),
      headers: cell.headers,
      method: cell.method,
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    return { bodyText: await response.text(), status: response.status };
  } catch {
    return undefined;
  }
};

const probe = async (cell: MatrixCell): Promise<ProbeRow> => {
  const name = cellKey(cell);
  if (cell.body === undefined) {
    return {
      cell: name,
      model: undefined,
      status: undefined,
      verdict: "no-model",
    };
  }
  let answer = await send(cell);
  // A rate limit, a server error or a dropped connection is retried once
  // before it is read: one transient answer must not fail every pull request.
  if (isTransientProbeAnswer(answer?.status)) {
    await new Promise((resolve) => {
      setTimeout(resolve, RETRY_AFTER_MS);
    });
    answer = await send(cell);
  }
  if (answer === undefined) {
    return {
      cell: name,
      model: cell.model,
      status: undefined,
      verdict: "transport-error",
    };
  }
  const verdict = classifyKeylessProbe(answer);
  return {
    cell: name,
    model: cell.model,
    status: answer.status,
    verdict,
    ...(verdict === "other" ? { body: answer.bodyText.slice(0, 200) } : {}),
  };
};

describe.skipIf(!LIVE || MIRRORED)(
  "live gateway · the keyless path matrix",
  () => {
    it(
      "sends every cell, reads every answer, and no cell the plugin dispatches to (or P-R1 will) answers path-gone",
      async () => {
        const listing = await fetch(MODELS_OPENCODE_URL, {
          signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        });
        expect(listing.status).toBe(200);
        const parsed = parseModelsDevCatalog(await listing.json());
        // The parsed slices have already dropped their deprecated rows, so no
        // `isDeprecated` predicate is passed: it could never exclude an id here.
        const cells = keylessMatrix({ go: parsed.go, zen: parsed.zen });
        expect(cells).toHaveLength(16);
        const rows: ProbeRow[] = [];
        for (const cell of cells) {
          rows.push(await probe(cell));
        }
        console.table(rows);
        // A model-less cell sends nothing. On the bundled catalogs every cell
        // has one, so a live slice without one is a catalog change to triage —
        // a reshaped listing would otherwise pass after sending no probe at all.
        const unsent = rows.filter((row) => row.verdict === "no-model");
        expect(unsent, JSON.stringify(unsent)).toEqual([]);
        // A 200 stays unreadable on purpose: it means a free model slipped past
        // the matrix's filter and a completion was spent.
        const unread = rows.filter(
          (row) =>
            !["path-exists", "model-gone", "path-gone"].includes(row.verdict)
        );
        expect(unread, JSON.stringify(unread)).toEqual([]);
        const goneToday = rows.filter(
          (row) => TODAY_DISPATCH.has(row.cell) && row.verdict === "path-gone"
        );
        expect(
          goneToday,
          `a path today's plugin dispatches to is gone: ${JSON.stringify(goneToday)}`
        ).toEqual([]);
        const goneNext = rows.filter(
          (row) => NEXT_DISPATCH.has(row.cell) && row.verdict === "path-gone"
        );
        expect(
          goneNext,
          `forward guard: a path P-R1 moves completions to is gone: ${JSON.stringify(goneNext)}`
        ).toEqual([]);
      },
      16 * 2 * (PROBE_TIMEOUT_MS + RETRY_AFTER_MS) + PROBE_TIMEOUT_MS
    );
  }
);
