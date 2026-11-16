/**
 * The measured context-window table (`src/utils/context-windows.ts`, L11):
 * every row carries its evidence, and the reader answers own rows only.
 *
 * The table ships empty, so the row check is paired with a seeded table it
 * must accept and a malformed one it must refuse: an empty loop proves
 * nothing on its own.
 *
 * @module test/context-windows.test
 */
import { describe, expect, it } from "vitest";

import {
  type CatalogModelSpec,
  MEASURED_CONTEXT_WINDOWS,
  type MeasuredWindows,
  measuredWindowFor,
  OPENCODE_GO_CATALOG,
  OPENCODE_ZEN_CATALOG,
  type Plane,
} from "./support/src.ts";

const SHIPPED: Readonly<Record<Plane, readonly CatalogModelSpec[]>> = {
  go: OPENCODE_GO_CATALOG,
  zen: OPENCODE_ZEN_CATALOG,
};

/** Every reason a table's rows fail the evidence rule, as `plane/id: why`. */
const problemsOf = (table: MeasuredWindows): string[] =>
  (["go", "zen"] as const).flatMap((plane) =>
    Object.entries(table[plane]).flatMap(([id, row]) => {
      const at = `${plane}/${id}`;
      const spec = SHIPPED[plane].find((model) => model.id === id);
      return [
        ...(Number.isInteger(row.window) && row.window > 0
          ? []
          : [`${at}: window is not a positive whole number`]),
        ...(/^\d{4}-\d{2}-\d{2}$/u.test(row.measured) &&
        !Number.isNaN(Date.parse(row.measured))
          ? []
          : [`${at}: measured is not an ISO date`]),
        ...(row.evidence.trim().length > 0 ? [] : [`${at}: no evidence`]),
        ...(spec === undefined
          ? [`${at}: the plane's catalog has no such model`]
          : []),
        ...(spec !== undefined && spec.context_window === row.window
          ? [`${at}: the catalog already says ${String(row.window)}`]
          : []),
      ];
    })
  );

/** A model the shipped Zen catalog carries, and a window it does not say. */
const zenModel = (): CatalogModelSpec => {
  const [spec] = OPENCODE_ZEN_CATALOG;
  if (spec === undefined) {
    throw new Error("the shipped Zen catalog is empty");
  }
  return spec;
};

describe("context windows · every row carries its evidence", () => {
  it("the shipped table passes, and the checker sees a row it is given", () => {
    expect(problemsOf(MEASURED_CONTEXT_WINDOWS)).toEqual([]);
    const spec = zenModel();
    const seeded: MeasuredWindows = {
      go: {},
      zen: {
        [spec.id]: {
          evidence: "a probe record",
          measured: "2026-11-16",
          window: spec.context_window + 1,
        },
      },
    };
    expect(problemsOf(seeded)).toEqual([]);
    const malformed: MeasuredWindows = {
      go: {
        "no-such-model": { evidence: " ", measured: "yesterday", window: 0.5 },
      },
      zen: {
        [spec.id]: {
          evidence: "x",
          measured: "2026-11-16",
          window: spec.context_window,
        },
      },
    };
    expect(problemsOf(malformed)).toEqual([
      "go/no-such-model: window is not a positive whole number",
      "go/no-such-model: measured is not an ISO date",
      "go/no-such-model: no evidence",
      "go/no-such-model: the plane's catalog has no such model",
      `zen/${spec.id}: the catalog already says ${String(spec.context_window)}`,
    ]);
  });
});

describe("context windows · measuredWindowFor", () => {
  const table: MeasuredWindows = {
    go: { probe: { evidence: "e", measured: "2026-11-16", window: 4096 } },
    zen: {},
  };

  it("answers a seeded row on its own plane only", () => {
    expect(measuredWindowFor("go", "probe", table)).toBe(4096);
    expect(measuredWindowFor("zen", "probe", table)).toBeUndefined();
  });

  it("answers undefined for a miss and for a key every object inherits", () => {
    expect(measuredWindowFor("go", "missing", table)).toBeUndefined();
    expect(measuredWindowFor("go", "toString", table)).toBeUndefined();
    expect(measuredWindowFor("go", "__proto__", table)).toBeUndefined();
  });

  it("reads the shipped table by default, which has no rows", () => {
    const spec = zenModel();
    expect(measuredWindowFor("zen", spec.id)).toBeUndefined();
    expect(MEASURED_CONTEXT_WINDOWS).toEqual({ go: {}, zen: {} });
  });
});
