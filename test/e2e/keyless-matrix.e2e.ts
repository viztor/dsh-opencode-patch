/**
 * The keyless 401-vs-404 matrix against the live gateway, and the keyless
 * free-model probe.
 *
 * Twenty-four POSTs, none carrying a key: two planes × four protocols × three
 * URL shapes — legacy (`/zen(/go)/v1`), the provider-level root
 * (`/inference(/go)/v1`) and modern (`/inference(/go)/{openai,anthropic,google}/…`)
 * — each with one PAID model from the live catalog slice (a free model answers
 * keyless with a real completion, so the matrix never picks one). The gateway
 * authenticates before it routes, so the answer says whether the PATH exists
 * without spending anything. It runs on every pull request, because it needs
 * no secret; it never reads `OPENCODE_API_KEY` or `OPENCODE_GO_API_KEY`.
 *
 * What it asserts:
 *
 * - every one of the twenty-four cells has a model and was SENT, and every
 *   legacy and modern answer is one the matrix can read (`unreadRows`) — an
 *   empty or reshaped catalog, a redirect, a rate limit the retry did not
 *   outlast, or no answer fails here rather than measuring nothing. A root
 *   answer is recorded whatever it is: nothing dispatches there;
 * - no cell the plugin dispatches to with the default endpoint (`auto`, an
 *   alias of `modern`; `TODAY_DISPATCH`: all four protocols on the modern
 *   family, on both planes) answers "path gone" (`goneDefaultRows`);
 * - a FREE completions model, sent keyless to the default completions path
 *   (`/inference/openai/v1/chat/completions`), is parsed there: served, or
 *   gated by the free tier (`freeProbeOutcome`). A retired free model moves
 *   on to the next, three at most; a rate limit (a 429, or a 429 and then no
 *   answer) SKIPS the case, as `protocol-routing.e2e.ts`'s free cases do.
 *
 * `endpoint: legacy` is recorded, not guarded (P-R2): its cells
 * (`LEGACY_DISPATCH`) must answer readably, like every legacy cell, but their
 * path-gone is printed and asserted nowhere live; the offline pin in
 * `test/endpoint-family.test.ts` guards its mapping. Every verdict goes into a
 * dated table (`test/support/endpoint-record.ts`), printed and, when
 * `OPENCODE_E2E_RECORD_DIR` is set, written there as `keyless.md` for the CI
 * job to publish — rewritten after every cell, so a job killed at its time
 * limit still leaves what it measured. A redirect is never followed: it is
 * recorded as `redirected`, with the path it pointed at, in the console table
 * and the dated record alike. The cell table, the
 * sets, the classifiers and every decision above are unit-tested offline in
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
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  freeProbeLine,
  type RecordedProbe,
  recordTable,
  runReference,
} from "../support/endpoint-record.ts";
import {
  type AttemptVerdict,
  cellKey,
  classifyFreeProbe,
  classifyKeylessProbe,
  type FreeVerdict,
  freeProbeCells,
  freeProbeOutcome,
  goneDefaultRows,
  isTransientProbeAnswer,
  type KeylessVerdict,
  keylessMatrix,
  MATRIX_FAMILIES,
  MATRIX_PROTOCOLS,
  type MatrixCell,
  type MatrixFamily,
  type ProbeAnswer,
  redirectPathOf,
  unreadRows,
  verdictOfAttempts,
} from "../support/keyless-matrix.ts";
import {
  type CatalogModelSpec,
  MODELS_OPENCODE_URL,
  parseModelsDevCatalog,
} from "../support/src.ts";

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

/** Per request: protocol-routing's measured budget, so a hung gateway cannot outlast the job. */
const PROBE_TIMEOUT_MS = 20_000;
/** The pause before the one retry of a transient answer. */
const RETRY_AFTER_MS = 2000;
/** How many free models the free probe tries before it gives up. */
const FREE_CANDIDATES = 3;

/** One probe's outcome, with no request or response header in it. */
interface ProbeRow {
  readonly cell: string;
  readonly family: MatrixFamily;
  readonly model: string | undefined;
  readonly status: number | undefined;
  readonly verdict: AttemptVerdict | KeylessVerdict;
  /** The start of the body, kept only for a verdict the matrix cannot read. */
  readonly body?: string;
  /** The path a redirect pointed at. */
  readonly location?: string;
}

/**
 * One keyless request: its status, body and redirect path, or `undefined` on
 * a transport error. A redirect is not followed, so a moved path is not
 * recorded as its target's answer.
 */
const send = async (cell: MatrixCell): Promise<ProbeAnswer | undefined> => {
  try {
    const response = await fetch(cell.url, {
      body: JSON.stringify(cell.body),
      headers: cell.headers,
      method: cell.method,
      redirect: "manual",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    const location = redirectPathOf(response.headers.get("location"), cell.url);
    return {
      bodyText: await response.text(),
      status: response.status,
      ...(location === undefined ? {} : { location }),
    };
  } catch {
    return undefined;
  }
};

/** {@link send}, retried once on a rate limit, a server error or a dropped connection: every attempt's answer. */
const sendWithRetry = async (
  cell: MatrixCell
): Promise<(ProbeAnswer | undefined)[]> => {
  const answer = await send(cell);
  // One transient answer must not fail every pull request.
  if (!isTransientProbeAnswer(answer?.status)) {
    return [answer];
  }
  await new Promise((resolve) => {
    setTimeout(resolve, RETRY_AFTER_MS);
  });
  return [answer, await send(cell)];
};

const probe = async (cell: MatrixCell): Promise<ProbeRow> => {
  const name = cellKey(cell);
  if (cell.body === undefined) {
    return {
      cell: name,
      family: cell.family,
      model: undefined,
      status: undefined,
      verdict: "no-model",
    };
  }
  const attempts = await sendWithRetry(cell);
  const answer = attempts.at(-1);
  const verdict = verdictOfAttempts(attempts, classifyKeylessProbe);
  return {
    cell: name,
    family: cell.family,
    model: cell.model,
    status: answer?.status,
    verdict,
    ...(verdict === "other" && answer !== undefined
      ? { body: answer.bodyText.slice(0, 200) }
      : {}),
    ...(answer?.location === undefined ? {} : { location: answer.location }),
  };
};

describe.skipIf(!LIVE || MIRRORED)(
  "live gateway · the keyless path matrix",
  () => {
    let zen: readonly CatalogModelSpec[] = [];
    let go: readonly CatalogModelSpec[] = [];
    const recorded: RecordedProbe[] = [];
    let free: {
      model: string | undefined;
      status: number | undefined;
      verdict: string;
    } = { model: undefined, status: undefined, verdict: "not run" };

    beforeAll(async () => {
      const listing = await fetch(MODELS_OPENCODE_URL, {
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
      expect(listing.status).toBe(200);
      // The parsed slices have already dropped their deprecated rows, so no
      // `isDeprecated` predicate is passed: it could never exclude an id here.
      ({ go, zen } = parseModelsDevCatalog(await listing.json()));
    }, PROBE_TIMEOUT_MS + 5000);

    /** Print and write the record: after every cell, so a killed job keeps what it measured. */
    const persist = async (print: boolean): Promise<void> => {
      const record = [
        recordTable({
          date: new Date().toISOString().slice(0, 10),
          probes: recorded,
          run: runReference({
            repository: process.env.GITHUB_REPOSITORY,
            runId: process.env.GITHUB_RUN_ID,
            server: process.env.GITHUB_SERVER_URL,
          }),
          title: "Keyless",
        }),
        "",
        freeProbeLine(free),
        "",
      ].join("\n");
      if (print) {
        console.info(record);
      }
      const dir = process.env.OPENCODE_E2E_RECORD_DIR ?? "";
      if (dir.length > 0) {
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, "keyless.md"), record);
      }
    };

    afterAll(async () => {
      await persist(true);
    });

    it(
      "sends every cell, reads every answer the plugin can dispatch to, and no cell the default dispatches to answers path-gone",
      async () => {
        const cells = keylessMatrix({ go, zen });
        expect(cells).toHaveLength(
          2 * MATRIX_PROTOCOLS.length * MATRIX_FAMILIES.length
        );
        const rows: ProbeRow[] = [];
        for (const cell of cells) {
          const row = await probe(cell);
          rows.push(row);
          recorded.push({
            family: cell.family,
            model: row.model,
            plane: cell.plane,
            protocol: cell.protocol,
            status: row.status,
            verdict: row.verdict,
            ...(row.location === undefined ? {} : { location: row.location }),
          });
          await persist(false);
        }
        console.table(rows);
        // A model-less cell sends nothing. On the bundled catalogs every cell
        // has one, so a live slice without one is a catalog change to triage —
        // a reshaped listing would otherwise pass after sending no probe at all.
        const unsent = rows.filter((row) => row.verdict === "no-model");
        expect(unsent, JSON.stringify(unsent)).toEqual([]);
        // A 200 stays unreadable on purpose: it means a free model slipped past
        // the matrix's filter and a completion was spent. The root shape is
        // recorded, not read: nothing dispatches there, so whatever it answers
        // cannot fail a pull request.
        const unread = unreadRows(rows);
        expect(unread, JSON.stringify(unread)).toEqual([]);
        const goneToday = goneDefaultRows(rows);
        expect(
          goneToday,
          `a path today's plugin dispatches to is gone: ${JSON.stringify(goneToday)}`
        ).toEqual([]);
      },
      24 * 2 * (PROBE_TIMEOUT_MS + RETRY_AFTER_MS) + PROBE_TIMEOUT_MS
    );

    it(
      "a free model on the default completions path is parsed there, without a key",
      async (context) => {
        const cells = freeProbeCells(zen).slice(0, FREE_CANDIDATES);
        expect(
          cells.length,
          "the live Zen slice has no free completions model"
        ).toBeGreaterThan(0);
        let verdict: AttemptVerdict | FreeVerdict = "transport-error";
        let status: number | undefined;
        let bodyText = "";
        let model: string | undefined;
        for (const cell of cells) {
          ({ model } = cell);
          const attempts = await sendWithRetry(cell);
          const answer = attempts.at(-1);
          status = answer?.status;
          bodyText = answer?.bodyText ?? "";
          verdict = verdictOfAttempts(attempts, classifyFreeProbe);
          // A retired free model says nothing about the path: try the next.
          if (verdict !== "model-gone") {
            break;
          }
        }
        free = { model, status, verdict };
        await persist(false);
        const outcome = freeProbeOutcome(verdict);
        const detail = `free model ${model ?? "<none>"} on the default completions path: ${verdict} (${status ?? "no answer"}) ${bodyText.slice(0, 200)}`;
        if (outcome === "skip") {
          context.skip(true, `the gateway was rate-limiting: ${detail}`);
          return;
        }
        expect(outcome, detail).toBe("pass");
      },
      FREE_CANDIDATES * 2 * (PROBE_TIMEOUT_MS + RETRY_AFTER_MS) +
        PROBE_TIMEOUT_MS
    );
  }
);
