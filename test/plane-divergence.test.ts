/**
 * The decisions that read a model's row, proved against the rows the vendor has
 * not produced yet.
 *
 * Every case here is a divergence between the two planes — a model free on one
 * and paid on the other, priced differently, served by a different SDK. The
 * real catalogue disagrees about the PRICES today (two models), and agrees
 * about everything else, so a test built on the real catalogue cannot tell a
 * plane-aware lookup from a plane-blind one: both pass. That is the gap this
 * file closes, using `test/fixtures/catalogs.ts` to build the row.
 *
 * @module test/plane-divergence.test
 */

import { describe, expect, it } from "vitest";

import { calculateTurnCost, recordTurnUsage } from "../src/session-cost.ts";
import { coreToolDecision } from "../src/tool-fallback.ts";
import { divergent, spec } from "./fixtures/catalogs.ts";

describe("the free flag is the plane's row", () => {
  it("injects the free tier's tools on the plane that says free, and not on the other", () => {
    // One id, two rows: free on Go, paid on Zen. The decision follows the row
    // it is handed — which is the whole reason `coreToolDecision` takes the row
    // rather than doing the lookup itself.
    const rows = divergent("acme-pro", { go: { free: true }, zen: {} });
    expect(coreToolDecision(rows.go, "acme-pro", "free")).toBe(true);
    expect(coreToolDecision(rows.zen, "acme-pro", "free")).toBe(false);
  });

  it("keeps the marker's substring tests, which the flag does not replace", () => {
    // A deployment can mark models the catalogue knows nothing about. The flag
    // is the authority where it speaks, and the marker still answers where it
    // does not.
    const row = spec({ id: "acme-preview-1" });
    expect(coreToolDecision(row, "acme-preview-1", "preview")).toBe(true);
    expect(coreToolDecision(row, "acme-preview-1", "free")).toBe(false);
    expect(coreToolDecision(undefined, "acme-free", "free")).toBe(true);
    expect(coreToolDecision(undefined, "acme-paid", "free")).toBe(false);
  });
});

describe("a turn is priced from the plane's own rate", () => {
  it("prices the same id differently when the planes' rates differ", () => {
    // The shape `deepseek-v4.1-flash` has in the real catalogue: $0.30 output
    // on Zen, $0.15 on Go. The cost is per MILLION tokens, so one million
    // input tokens is the rate itself.
    const rows = divergent("acme-flash", {
      go: { input: 0.15, output: 0.6 },
      zen: { input: 0.3, output: 1.2 },
    });
    const tokens = { inputTokens: 1_000_000, outputTokens: 0 };
    expect(calculateTurnCost(tokens, rows.zen.cost)).toBeCloseTo(0.3, 6);
    expect(calculateTurnCost(tokens, rows.go.cost)).toBeCloseTo(0.15, 6);
  });

  it("records each plane's spend on its own side of the split", () => {
    // The accumulator carries both planes' totals; a reading projects the plane
    // it answers for. Two turns at the same token count, different rates, land
    // on different planes — and neither number moves the other.
    const rows = divergent("acme-flash", {
      go: { input: 1, output: 1 },
      zen: { input: 2, output: 2 },
    });
    const tokens = { inputTokens: 1_000_000, outputTokens: 0 };

    const zen = recordTurnUsage(
      "s-divergence-zen",
      tokens,
      rows.zen.cost,
      "acme-flash",
      false,
      "zen"
    );
    const go = recordTurnUsage(
      "s-divergence-go",
      tokens,
      rows.go.cost,
      "acme-flash",
      false,
      "go"
    );
    expect(zen.costByPlane.zen).toBeCloseTo(2, 6);
    expect(zen.costByPlane.go).toBe(0);
    expect(go.costByPlane.go).toBeCloseTo(1, 6);
    expect(go.costByPlane.zen).toBe(0);
  });

  it("charges nothing for a free row, whatever its price field says", () => {
    // The flag outranks the price: a free model whose row still carries rates
    // (the vendor does list them) must not bill the session.
    const row = spec({ id: "acme-free", free: true, input: 5, output: 10 });
    expect(
      calculateTurnCost(
        { inputTokens: 1_000_000, outputTokens: 1_000_000 },
        row.cost,
        row.is_free === true
      )
    ).toBe(0);
  });
});
