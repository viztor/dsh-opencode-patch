/**
 * The Go plan's per-model monthly allowance, read from the gateway's own models
 * endpoint.
 *
 * The vendor used to publish the allowance table on its docs page. Since
 * 2026-11-18 that page carries no allowance figures at all; the figures live in
 * `go.monthly_usage` on `GET /inference/go/v1/models` (the `/zen/go/v1/models`
 * mirror answers the same body): one entry per model and plan tier — `go`,
 * `go-plus`, `go-teams` — in whole US dollars. This module is the pure half
 * that maps that payload to the rows `scripts/go-limits-render.ts` emits, so
 * the mapping is held by a unit test instead of by a nightly run.
 *
 * The reader refuses what it cannot read — an entry whose `monthly_usage` is
 * present but not two numbers, a duplicate id, a payload that is not the
 * endpoint's list — because a dollar figure attached to the wrong model is the
 * one failure this table must not have. A model WITHOUT the field is a free
 * model: reported as skipped, never priced as $0.
 *
 * @module scripts/go-limits-endpoint
 */
import type { ModelAllowance } from "../src/go-limits.ts";

/**
 * Where the allowance metadata is served.
 *
 * Measured 2026-11-18: the plain inference path and the zen mirror answer the
 * same 42 KB body; the plain one is the family the current docs send clients to.
 */
export const GO_LIMITS_MODELS_URL =
  "https://opencode.ai/inference/go/v1/models";

/** How long the generator waits for the endpoint. */
export const GO_LIMITS_FETCH_TIMEOUT_MS = 20_000;

/** The endpoint's per-tier keys, and the table field each fills. */
const PLAN_FIELDS: Readonly<Record<"go" | "goPlus", string>> = {
  go: "go",
  goPlus: "go-plus",
};

/** What one read of the payload carries. */
export interface GoAllowanceRead {
  /** id → allowance, for every model that publishes one. */
  readonly limits: Map<string, ModelAllowance>;
  /** Models the endpoint lists without a monthly allowance: the free ones. */
  readonly skipped: readonly string[];
  /** Entries the reader refused, each with its reason. */
  readonly unmapped: readonly string[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isFigure = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

/**
 * Read one `go`/`go-plus` pair out of a model's `monthly_usage`.
 *
 * @param usage - the model's `go.monthly_usage`.
 * @returns the two figures, or the reason it cannot be read.
 */
const figuresOf = (
  usage: Record<string, unknown>
): { go: number; goPlus: number } | string => {
  const go = usage[PLAN_FIELDS.go];
  const goPlus = usage[PLAN_FIELDS.goPlus];
  if (!isFigure(go)) {
    return "monthly_usage.go is not a number";
  }
  if (!isFigure(goPlus)) {
    return 'monthly_usage["go-plus"] is not a number';
  }
  return { go, goPlus };
};

/**
 * Turn the models payload into allowance rows.
 *
 * @param payload - the parsed body of `GO_LIMITS_MODELS_URL`.
 * @returns the rows, the free models skipped, and the refused entries.
 * @throws {Error} when the payload is not the endpoint's list shape at all: a wrong
 * source must fail the generator rather than emit an empty table.
 */
export const readGoAllowances = (payload: unknown): GoAllowanceRead => {
  if (!isRecord(payload) || !Array.isArray(payload.data)) {
    throw new Error("go-limits: the payload is not the models endpoint's list");
  }
  const limits = new Map<string, ModelAllowance>();
  const skipped: string[] = [];
  const unmapped: string[] = [];
  for (const [index, entry] of payload.data.entries()) {
    const where = `entry ${index + 1}`;
    if (!isRecord(entry)) {
      unmapped.push(`${where} is not an object`);
      continue;
    }
    const { id } = entry;
    if (typeof id !== "string" || id.trim().length === 0) {
      unmapped.push(`${where} has no id`);
      continue;
    }
    if (limits.has(id)) {
      unmapped.push(`${id} appears twice`);
      continue;
    }
    const { go } = entry;
    if (!isRecord(go) || !isRecord(go.monthly_usage)) {
      // No `go` block, or no usage in it: the free models publish no allowance.
      skipped.push(id);
      continue;
    }
    const figures = figuresOf(go.monthly_usage);
    if (typeof figures === "string") {
      unmapped.push(`${id}: ${figures}`);
      continue;
    }
    const name =
      typeof entry.name === "string" && entry.name.trim().length > 0
        ? entry.name.trim()
        : id;
    limits.set(id, { ...figures, name });
  }
  return { limits, skipped, unmapped };
};
