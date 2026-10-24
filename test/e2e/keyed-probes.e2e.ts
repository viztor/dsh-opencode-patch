/**
 * The minimal keyed probes against the live gateway: one request per plane ×
 * protocol × URL shape, each with the plane's OWN key in the header its
 * protocol reads, and a body of a few output tokens.
 *
 * The keyless matrix (`keyless-matrix.e2e.ts`) can only say whether a path
 * exists: the gateway authenticates before it routes, so a paid model answers
 * 401 everywhere without a key. With the key the answer says whether the path
 * SERVES the protocol for that plane's account, which is what the default
 * family rests on.
 *
 * Each keyed cell carries `PROBE_IDENTITY` (`test/support/keyed-probes.ts`),
 * the identity headers the fetch patch puts on a turn (the turn's user agent
 * `OPENCODE_UA`, `x-opencode-client`, `x-opencode-project`, an in-band session
 * id under both session headers), so the request is the plugin's request: the
 * Go plane refuses a keyed request with no session header, and the gateway
 * reads the user agent as origin proof. `keyedCell` applies it, and the
 * offline suite holds that same constant to what the real fetch patch sends,
 * so this file has no identity of its own to drift. The one turn header it
 * leaves out is `x-opencode-request`, a per-request metric id.
 *
 * What it decides, per plane, from the cells the default family dispatches to
 * (`TODAY_DISPATCH`) alone (`planeOutcome`):
 *
 * - FAIL when one answers path-gone, wrong-protocol or auth-refused — the flip
 *   rule's evidence (`docs/redirect-planes.md` §13) — or an answer that
 *   measured nothing a turn could use: an unreadable status (`other`), a
 *   redirect, a refused session, no answer on either attempt
 *   (`transport-error`), or no model to send (`no-model`). Only the first
 *   three are flip evidence.
 * - SKIP when none of them was `served`: the account's answer (no funds, a
 *   model the account may not use), a rate limit (a 429, or a 429 and then no
 *   answer, the measured rate-limit hang), a busy upstream (a 503, a 529, or a
 *   5xx naming an overload — the gateway routed it), a retired model, or a
 *   parsed but refused body. Nothing showed the plugin's turns are served, so it is a
 *   skip, never a pass.
 * - PASS otherwise.
 *
 * Every other cell — the legacy cells `endpoint: legacy` dispatches to, which
 * P-R2 decided are recorded, not guarded, and the root shape nothing
 * dispatches to — is recorded only.
 *
 * Armed by the `probes` tier (`OPENCODE_E2E_KEYED`, unset meaning `full`):
 * CI runs it on pull requests that touch `src/host/**`, the modules that
 * decide the legacy URLs and protocols the probes send or the family the
 * plugin dispatches to, the CLI version in the user agent and the
 * `anthropic-version` the probes carry, or the probes' own inputs (the exact
 * list, and what it leaves out, is the tier step in `.github/workflows/ci.yml`);
 * nightly and on dispatch.
 * It skips without either key, and a plane without its key is reported
 * skipped. Every verdict goes into a dated table
 * (`test/support/endpoint-record.ts`), printed and, when
 * `OPENCODE_E2E_RECORD_DIR` is set, written there as `keyed.md` — rewritten
 * after every cell, so a job killed at its time limit still leaves what it
 * measured, the cells it did not reach reading `not sent`. A redirect is never
 * followed: it is recorded as `redirected`, with the path it pointed at, in
 * the console table and the dated record alike. No
 * header and no key is ever printed; a body is printed only through
 * `excerpt`, which redacts the key.
 *
 * Like the keyless matrix it measures only the vendor's own paths, so it skips
 * while a mirror base URL is set. The cells, the tier and the classifier are
 * unit-tested offline in `test/keyed-probes.test.ts`.
 *
 *   OPENCODE_E2E=1 OPENCODE_API_KEY=… OPENCODE_GO_API_KEY=… pnpm run test:e2e
 *
 * @module test/e2e/keyed-probes.e2e
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  type RecordedProbe,
  recordTable,
  runReference,
} from "../support/endpoint-record.ts";
import {
  armedKey,
  excerpt,
  isArmed,
  keyedCell,
  keyedTierOf,
  keyedVerdictOf,
  planeOutcome,
} from "../support/keyed-probes.ts";
import {
  cellKey,
  isTransientProbeAnswer,
  keylessMatrix,
  type MatrixCell,
  type ProbeAnswer,
  redirectPathOf,
} from "../support/keyless-matrix.ts";
import { MODELS_OPENCODE_URL, parseModelsDevCatalog } from "../support/src.ts";

const LIVE = process.env.OPENCODE_E2E === "1";
/** A mirror the rest of the suite is pointed at, which this file cannot follow. */
const MIRRORED = ["OPENCODE_ZEN_BASE_URL", "OPENCODE_GO_BASE_URL"].some(
  (name) => (process.env[name] ?? "").length > 0
);
const TIER = keyedTierOf(process.env.OPENCODE_E2E_KEYED);
const KEYS = {
  opencode: armedKey(TIER, "probes", process.env.OPENCODE_API_KEY),
  "opencode-go": armedKey(TIER, "probes", process.env.OPENCODE_GO_API_KEY),
} as const;

/** Per request: protocol-routing's measured budget, so a hung gateway cannot outlast the job. */
const PROBE_TIMEOUT_MS = 20_000;
/** The pause before the one retry of a transient answer. */
const RETRY_AFTER_MS = 2000;

/**
 * One keyed request: its status, body and redirect path, or `undefined` on a
 * transport error. A redirect is not followed: a moved path must not be
 * recorded as its target's answer, and a cross-origin hop would carry the
 * `x-api-key` / `x-goog-api-key` header with it.
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
  if (!isTransientProbeAnswer(answer?.status)) {
    return [answer];
  }
  await new Promise((resolve) => {
    setTimeout(resolve, RETRY_AFTER_MS);
  });
  return [answer, await send(cell)];
};

/** One probe's outcome, as the console table prints it: no header, no key. */
interface KeyedRow {
  readonly cell: string;
  readonly model: string | undefined;
  readonly status: number | undefined;
  readonly verdict: string;
  /** The redacted start of the body, kept for a verdict other than `served`. */
  readonly body?: string;
  /** The path a redirect pointed at. */
  readonly location?: string;
}

describe.skipIf(
  !LIVE ||
    MIRRORED ||
    !isArmed(TIER, "probes") ||
    (KEYS.opencode === undefined && KEYS["opencode-go"] === undefined)
)("live gateway · the keyed probes", () => {
  let cells: MatrixCell[] = [];
  const recorded: RecordedProbe[] = [];

  beforeAll(async () => {
    const listing = await fetch(MODELS_OPENCODE_URL, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    expect(listing.status).toBe(200);
    const parsed = parseModelsDevCatalog(await listing.json());
    cells = keylessMatrix({ go: parsed.go, zen: parsed.zen });
  }, PROBE_TIMEOUT_MS + 5000);

  /** Print and write the record: after every cell, so a killed job keeps what it measured. */
  const persist = async (print: boolean): Promise<void> => {
    const record = `${recordTable({
      date: new Date().toISOString().slice(0, 10),
      probes: recorded,
      run: runReference({
        repository: process.env.GITHUB_REPOSITORY,
        runId: process.env.GITHUB_RUN_ID,
        server: process.env.GITHUB_SERVER_URL,
      }),
      title: "Keyed",
    })}\n`;
    if (print) {
      console.info(record);
    }
    const dir = process.env.OPENCODE_E2E_RECORD_DIR ?? "";
    if (dir.length > 0) {
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "keyed.md"), record);
    }
  };

  afterAll(async () => {
    await persist(true);
  });

  it.for(["opencode", "opencode-go"] as const)(
    "%s: no cell the default sends to breaks with the plane's own key, and one is served; the other shapes are recorded",
    {
      timeout: 12 * 2 * (PROBE_TIMEOUT_MS + RETRY_AFTER_MS) + PROBE_TIMEOUT_MS,
    },
    async (plane, context) => {
      const planeCells = cells.filter((cell) => cell.plane === plane);
      expect(planeCells).toHaveLength(12);
      const key = KEYS[plane];
      if (key === undefined) {
        for (const cell of planeCells) {
          recorded.push({
            family: cell.family,
            model: cell.model,
            plane,
            protocol: cell.protocol,
            status: undefined,
            verdict: "no-key",
          });
        }
        await persist(false);
        context.skip(true, "no key for this plane");
        return;
      }
      const rows: KeyedRow[] = [];
      for (const cell of planeCells) {
        const name = cellKey(cell);
        if (cell.model === undefined) {
          rows.push({
            cell: name,
            model: undefined,
            status: undefined,
            verdict: "no-model",
          });
        } else {
          const attempts = await sendWithRetry(keyedCell(cell, key));
          const answer = attempts.at(-1);
          const verdict = keyedVerdictOf(attempts);
          rows.push({
            cell: name,
            model: cell.model,
            status: answer?.status,
            verdict,
            ...(verdict === "served" || answer === undefined
              ? {}
              : { body: excerpt(answer.bodyText, key) }),
            ...(answer?.location === undefined
              ? {}
              : { location: answer.location }),
          });
        }
        const row = rows.at(-1);
        recorded.push({
          family: cell.family,
          model: cell.model,
          plane,
          protocol: cell.protocol,
          status: row?.status,
          verdict: row?.verdict ?? "no-model",
          ...(row?.location === undefined ? {} : { location: row.location }),
        });
        await persist(false);
      }
      console.table(rows);
      const outcome = planeOutcome(rows);
      if (outcome.kind === "skip") {
        context.skip(true, outcome.reason);
        return;
      }
      expect(
        outcome,
        outcome.kind === "fail"
          ? `${outcome.reason}: ${JSON.stringify(outcome.broken)}`
          : undefined
      ).toEqual({ kind: "pass" });
    }
  );
});
