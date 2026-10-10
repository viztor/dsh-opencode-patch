/**
 * Live OpenCode gateway E2E.
 *
 * Everything else in this suite runs against captured or stubbed responses; this
 * file is the only place the plugin meets the real API. It exists to catch the
 * failure a stub cannot: **the vendor changing the payload**. The meter parses
 * `/zen/go/v1/usage` and the picker consumes an enriched `/models` listing, so
 * both shapes are asserted against the live service rather than our idea of it.
 *
 * Opt-in via `OPENCODE_E2E=1`, and each credentialed block skips when its key is
 * absent — so forks and key-less runs stay green instead of failing on a 401.
 *
 *   OPENCODE_E2E=1 OPENCODE_API_KEY=… OPENCODE_GO_API_KEY=… pnpm run test:e2e
 *
 * The unkeyed cases are deliberately part of the suite: they prove the paths
 * still exist (a 404 would mean the endpoint moved) and that a request carrying
 * our header set is *authenticated-rejected* rather than *malformed-rejected*.
 */

import { describe, expect, it } from "vitest";

import {
  enrichModelsResponse,
  OPENCODE_ZEN_CATALOG,
  openCodeSessionIdFor,
  parseGoUsage,
  RETIRED_ZEN_MODEL_IDS,
  SESSION_HEADER,
  type GoUsage,
} from "../../src/index.ts";

const LIVE = process.env.OPENCODE_E2E === "1";

/** Bases are overridable so the suite can be pointed at a mirror or a local stub. */
const ZEN_BASE =
  process.env.OPENCODE_ZEN_BASE_URL ?? "https://opencode.ai/zen/v1";
const GO_BASE =
  process.env.OPENCODE_GO_BASE_URL ?? "https://opencode.ai/zen/go/v1";

const ZEN_KEY = process.env.OPENCODE_API_KEY;
const GO_KEY = process.env.OPENCODE_GO_API_KEY;

/** Generous: these cross the public internet from CI. */
const TIMEOUT_MS = 30_000;

/** A key that is well-formed but certainly not ours. */
const BOGUS_KEY = "sk-e2e-not-a-real-key";

const WINDOW_KEYS = ["rolling", "weekly", "monthly"] as const;

describe.skipIf(!LIVE)("live OpenCode gateway", () => {
  it(
    "answers the Zen /models path, so the endpoint has not moved",
    async () => {
      const response = await fetch(`${ZEN_BASE}/models`);
      // 404 is the failure that matters: it means the path moved.
      expect([200, 401, 403]).toContain(response.status);
      const body: unknown = await response.json();
      expect(typeof body).toBe("object");
      expect(body).not.toBeNull();

      // Observed live: `/models` answers 200 even for a bogus key, so the
      // listing shape is asserted whenever it is served.
      if (response.status === 200) {
        const listing = body as { data?: unknown; object?: unknown };
        expect(listing.object).toBe("list");
        expect(Array.isArray(listing.data)).toBe(true);
      }
    },
    TIMEOUT_MS
  );

  it(
    "adds nothing to the gateway's verdict on a request",
    async () => {
      // The invariant that matters: our header set must not change whether the
      // gateway accepts the request. Compared against the same call without
      // them, rather than hardcoding a status the vendor may tighten.
      const plain = await fetch(`${ZEN_BASE}/models`, {
        headers: { Authorization: `Bearer ${BOGUS_KEY}` },
      });
      const ours = await fetch(`${ZEN_BASE}/models`, {
        headers: {
          Authorization: `Bearer ${BOGUS_KEY}`,
          "x-opencode-client": "cli",
          [SESSION_HEADER]: openCodeSessionIdFor("e2e-session"),
        },
      });
      expect(ours.status).toBe(plain.status);
    },
    TIMEOUT_MS
  );

  it(
    "answers the Go /usage path, which the meter depends on",
    async () => {
      const response = await fetch(`${GO_BASE}/usage`, {
        headers: { Authorization: `Bearer ${BOGUS_KEY}` },
      });
      // Again: never a 404. A rejection here is an auth answer, and it must
      // still be the API's JSON error shape rather than an HTML error page.
      expect([200, 401, 403]).toContain(response.status);
      if (response.status !== 200) {
        const body: unknown = await response.json();
        expect(typeof body).toBe("object");
      }
    },
    TIMEOUT_MS
  );
});

// `!key`, never `key === undefined`: an unset GitHub Actions secret expands to
// the EMPTY STRING, not to nothing, so the equality check this replaced let the
// keyed suites run with an empty bearer token — and fail as a 401 that looks
// like the endpoint breaking rather than the secret being missing.
describe.skipIf(!LIVE || !ZEN_KEY)(
  "live Zen model listing (OPENCODE_API_KEY)",
  () => {
    it(
      "enriches the real listing into the rows the picker consumes",
      async () => {
        const url = `${ZEN_BASE}/models`;
        const response = await fetch(url, {
          headers: { Authorization: `Bearer ${ZEN_KEY}` },
        });
        expect(response.ok).toBe(true);

        const enrichedResponse = await enrichModelsResponse(url, response);
        const enriched: unknown = await enrichedResponse.json();
        expect(enriched).toBeTruthy();
        const rows = (enriched as { data?: unknown }).data;
        expect(Array.isArray(rows)).toBe(true);

        const ids = new Set<string>();
        for (const row of rows as unknown[]) {
          expect(row).toBeTruthy();
          const model = row as Record<string, unknown>;
          // Every row the picker sees must be fully described, which is the
          // whole point of the enrichment.
          expect(typeof model.id).toBe("string");
          expect(typeof model.name).toBe("string");
          expect(typeof model.context_window).toBe("number");
          expect(typeof model.max_output_tokens).toBe("number");
          ids.add(String(model.id));
        }

        // The canonical free-tier rows are what a Zen user actually selects.
        expect(ids.has("mimo-v2.6-flash-free")).toBe(true);
        expect(ids.has("muse-spark-1.3-contributor-free")).toBe(true);

        // And nothing the provider retired is resurrected by the enrichment.
        for (const retired of RETIRED_ZEN_MODEL_IDS) {
          expect(ids.has(retired)).toBe(false);
        }

        // The listing covers the bundled catalog, so a failed refresh can only
        // ever be additive relative to the shim.
        for (const spec of OPENCODE_ZEN_CATALOG) {
          expect(ids.has(spec.id)).toBe(true);
        }
      },
      TIMEOUT_MS
    );
  }
);

describe.skipIf(!LIVE || !GO_KEY)("live Go usage (OPENCODE_GO_API_KEY)", () => {
  it(
    "parses the real /usage payload the meter renders",
    async (context) => {
      const response = await fetch(`${GO_BASE}/usage`, {
        headers: { Authorization: `Bearer ${GO_KEY}` },
      });
      // An account fact is not a code fact. A lapsed plan, a rotated key or an
      // exhausted quota all answer a refusal, and none of them says whether the
      // plugin parses a payload correctly - so skip, and put the status in the
      // message. The assertion this replaces said only "expected false to be
      // true", which is not a diagnosis, and it turned the whole run red for a
      // reason no one could act on from here.
      if (!response.ok) {
        const body = await response.text();
        const refusal = [401, 402, 403, 429].includes(response.status);
        const detail = `HTTP ${response.status} ${body.slice(0, 400)}`;
        if (refusal) {
          // `context.skip()` records the reason but vitest does not print it, so
          // the log would show a skip with no explanation. Write it out as well:
          // the status is the whole diagnosis, and CI is the only place this case
          // ever runs.
          process.stderr.write(`\n[go-usage] refused: ${detail}\n`);
          context.skip(`the gateway refused the credential: ${detail}`);
          return;
        }
        throw new Error(`GET /usage answered ${detail}`);
      }

      const usage: GoUsage = parseGoUsage(await response.json());
      for (const key of WINDOW_KEYS) {
        const window = usage[key];
        expect(typeof window.percent).toBe("number");
        expect(Number.isFinite(window.percent)).toBe(true);
        expect(window.percent).toBeGreaterThanOrEqual(0);
        expect(window.percent).toBeLessThanOrEqual(100);
        expect(["ok", "rate-limited"]).toContain(window.status);
        // The meter renders a countdown from this, so it must be a real date.
        expect(Number.isNaN(Date.parse(window.resetsAt))).toBe(false);
      }
    },
    TIMEOUT_MS
  );
});
