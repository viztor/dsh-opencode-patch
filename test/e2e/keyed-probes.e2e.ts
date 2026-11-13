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
 * (`TODAY_DISPATCH`), each read beside the legacy and root cells of the same
 * protocol, which carry the same model and key (`planeOutcome`):
 *
 * - FAIL when one answers path-gone, wrong-protocol or auth-refused, or a
 *   retired model (`model-gone`) that another shape accepted, or an answer
 *   that measured nothing a turn could use: an unreadable status (`other`), a
 *   redirect, a refused session, no answer on the last attempt that did not
 *   follow a 429 (`transport-error`), or no model to send (`no-model`). The
 *   flip rule's evidence (`docs/redirect-planes.md` §13) is a wrong-protocol,
 *   a path-gone, an auth-refused or a model-gone that the cell a flip would
 *   send the same protocol to (`LEGACY_DISPATCH`'s, when it is not the
 *   default cell itself, so never Go's Google) accepted. A refusal only the
 *   root or Go Google's `/zen/go` cell accepted fails but is not evidence, as
 *   no flip reaches them; nor is a key refused on every shape that read it
 *   (the CI secret), a key no other shape read, or a protocol or a path the
 *   flip's cell refused too or measured nothing about (a re-run). Each other
 *   shape counts only for what it measured: the account's answer shows a key
 *   read and a path that exists, never a protocol or a model served.
 * - SKIP when none of them was `served`: the account's answer (no funds, a
 *   model the account may not use), a rate limit (a 429, or a 429 and then no
 *   answer, the measured rate-limit hang), a busy upstream (a 503, a 529, or a
 *   5xx naming an overload — never read as a shape accepting the request,
 *   since the gateway's front may answer it), a retired model, or a
 *   parsed but refused body. Nothing showed the plugin's turns are served, so
 *   it is a skip, never a pass.
 * - PASS otherwise.
 *
 * Every other cell — the legacy cells `endpoint: legacy` dispatches to, which
 * P-R2 decided are recorded, not guarded, and the root shape nothing
 * dispatches to — never fails or passes a plane on its own: it is recorded,
 * and read only beside a default cell of the same protocol.
 *
 * A second case per plane sends the keyed VARIANTS of the default
 * completions cell (`keyedVariantCells`, lessons L4, L5 and L10): the probe
 * identity beside a minted `x-opencode-request`, `x-opencode-project` as a
 * folder name and as a 40-hex digest, and a paid completions model that
 * reasons, with no `reasoning_effort` and with `"none"`. Every 429 either case
 * meets has its `Retry-After` noted (lesson L9). All of it is recorded —
 * the variants table and the `Retry-After` line follow the keyed table in
 * `keyed.md` — and none of it is asserted: P6 and P-R3 act on what it shows.
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
 * followed (`redirect: "manual"`, which `test/keyed-probes.test.ts` holds
 * every probe `fetch` to): it is recorded as `redirected`, with the path it
 * pointed at, in the console table and the dated record alike. No
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

import { e2e } from "../support/e2e-env.ts";
import {
  type RecordedProbe,
  type RecordedVariant,
  recordTable,
  retryAfterLine,
  runReference,
  variantTable,
} from "../support/endpoint-record.ts";
import {
  excerpt,
  isArmed,
  KEYED_VARIANTS,
  keyedCell,
  keyedVariantCells,
  keyedVerdictOf,
  planeOutcome,
  reasoningCompletionsModel,
  retryAfterOf,
} from "../support/keyed-probes.ts";
import {
  cellKey,
  isTransientProbeAnswer,
  keylessMatrix,
  type MatrixCell,
  type ProbeAnswer,
  redirectPathOf,
} from "../support/keyless-matrix.ts";
import {
  type CatalogModelSpec,
  MODELS_OPENCODE_URL,
  parseModelsDevCatalog,
} from "../support/src.ts";

/** The process's own live-suite environment, read once at import. */
const E2E = e2e();

const LIVE = E2E.live;
/** A mirror the rest of the suite is pointed at, which this file cannot follow. */
const MIRRORED = E2E.mirrored;
const TIER = E2E.tier;
const KEYS = {
  opencode: E2E.keyFor("opencode", "probes"),
  "opencode-go": E2E.keyFor("opencode-go", "probes"),
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
    const retryAfter = response.headers.get("retry-after");
    return {
      bodyText: await response.text(),
      status: response.status,
      ...(location === undefined ? {} : { location }),
      ...(retryAfter === null ? {} : { retryAfter }),
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
  if (!isTransientProbeAnswer(answer?.status, answer?.bodyText)) {
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
  let slices: Readonly<
    Record<"opencode" | "opencode-go", readonly CatalogModelSpec[]>
  > = {
    opencode: [],
    "opencode-go": [],
  };
  const recorded: RecordedProbe[] = [];
  const variants: RecordedVariant[] = [];
  /** Every keyed 429 and its `Retry-After` (lesson L9), matrix and variants alike. */
  const retryAfters: { cell: string; value: string | null }[] = [];

  /** {@link sendWithRetry}, noting the `Retry-After` of every 429 it met. */
  const sendNoting = async (
    cell: MatrixCell,
    name: string
  ): Promise<(ProbeAnswer | undefined)[]> => {
    const attempts = await sendWithRetry(cell);
    retryAfters.push(
      ...retryAfterOf(attempts).map((value) => ({ cell: name, value }))
    );
    return attempts;
  };

  beforeAll(async () => {
    const listing = await fetch(MODELS_OPENCODE_URL, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    expect(listing.status).toBe(200);
    const parsed = parseModelsDevCatalog(await listing.json());
    cells = keylessMatrix({ go: parsed.go, zen: parsed.zen });
    slices = { opencode: parsed.zen, "opencode-go": parsed.go };
  }, PROBE_TIMEOUT_MS + 5000);

  /** Print and write the record: after every cell, so a killed job keeps what it measured. */
  const persist = async (print: boolean): Promise<void> => {
    const date = new Date().toISOString().slice(0, 10);
    const run = runReference(E2E.run);
    const record = [
      recordTable({ date, probes: recorded, run, title: "Keyed" }),
      "",
      variantTable({ date, probes: variants, run }),
      "",
      retryAfterLine(retryAfters),
      "",
    ].join("\n");
    if (print) {
      console.info(record);
    }
    const dir = E2E.recordDir;
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
        recorded.push(
          ...planeCells.map((cell) => ({
            family: cell.family,
            model: cell.model,
            plane,
            protocol: cell.protocol,
            status: undefined,
            verdict: "no-key",
          }))
        );
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
          const attempts = await sendNoting(keyedCell(cell, key), name);
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

  it.for(["opencode", "opencode-go"] as const)(
    "%s: records the header and reasoning variants on the default completions cell (L4, L5, L10)",
    {
      timeout:
        KEYED_VARIANTS.length * 2 * (PROBE_TIMEOUT_MS + RETRY_AFTER_MS) +
        PROBE_TIMEOUT_MS,
    },
    async (plane, context) => {
      const key = KEYS[plane];
      if (key === undefined) {
        context.skip(true, "no key for this plane");
        return;
      }
      const representative = cells.find(
        (cell) =>
          cell.plane === plane &&
          cell.protocol === "openai-completions" &&
          cell.family === "modern"
      )?.model;
      const variantCells = keyedVariantCells(
        plane,
        { reasoning: reasoningCompletionsModel(slices[plane]), representative },
        key
      );
      // Recorded, never asserted: the variants measure what P6 and P-R3
      // decide, and no answer here says anything about the default family.
      const rows: KeyedRow[] = [];
      for (const cell of variantCells) {
        const name = `${plane} ${cell.variant.id}`;
        let row: KeyedRow = {
          cell: name,
          model: undefined,
          status: undefined,
          verdict: "no-model",
        };
        if (cell.body !== undefined) {
          const attempts = await sendNoting(cell, name);
          const answer = attempts.at(-1);
          const verdict = keyedVerdictOf(attempts);
          row = {
            cell: name,
            model: cell.model,
            status: answer?.status,
            verdict,
            ...(verdict === "served" || answer === undefined
              ? {}
              : { body: excerpt(answer.bodyText, key) }),
          };
        }
        rows.push(row);
        variants.push({
          model: row.model,
          plane,
          status: row.status,
          variant: cell.variant.id,
          verdict: row.verdict,
        });
        await persist(false);
      }
      console.table(rows);
      expect(rows).toHaveLength(KEYED_VARIANTS.length);
    }
  );
});
