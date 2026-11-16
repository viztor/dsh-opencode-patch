/**
 * The settings table's own rules: the ones its type cannot state.
 *
 * The derived schema, resolver and card are pinned literally in
 * `settings-snapshot.test.ts`; this file holds the table to the invariants a
 * new row has to keep for those derivations to stay right.
 *
 * @module test/settings-table.test
 */

import { describe, expect, it } from "vitest";

import {
  Config,
  PLANE_ROUTES,
  resolveConfig,
  SETTING_PROSE,
  SETTINGS,
} from "./support/src.ts";

const rows = Object.entries(SETTINGS);

describe("the settings table", () => {
  it("has one row per schema key, in the schema's order", () => {
    expect(rows).toHaveLength(19);
    expect(Object.keys(Config.dict ?? {})).toStrictEqual(Object.keys(SETTINGS));
  });

  it("gives a choice a default among its values", () => {
    const choices = rows.flatMap(([key, row]) =>
      row.kind === "choice" ? [[key, row] as const] : []
    );
    // Known answer: both choice fields are read.
    expect(choices.map(([key]) => key)).toStrictEqual([
      "endpoint",
      "keySource",
    ]);
    for (const [key, row] of choices) {
      expect(row.values, key).toContain(row.default);
    }
  });

  it("keeps each card group's rows adjacent, and every card row first", () => {
    const groups = rows.map(([, row]) =>
      "card" in row ? row.card : undefined
    );
    const firstConfigOnly = groups.indexOf(undefined);
    expect(firstConfigOnly).toBe(9);
    expect(
      groups.slice(firstConfigOnly).every((group) => group === undefined)
    ).toBe(true);
    const runs = groups
      .slice(0, firstConfigOnly)
      .filter((group, index, all) => index === 0 || all[index - 1] !== group);
    expect(runs).toStrictEqual(["access", "requests", "models", "quota"]);
  });

  it("gives a reason exactly to the rows the card does not show", () => {
    for (const [key, row] of rows) {
      // Read as the general shape: the type already says which rows carry a
      // reason, and this checks the object agrees.
      const prose: { description: string; reason?: string } =
        SETTING_PROSE[key as keyof typeof SETTINGS];
      expect(prose.description.trim(), key).not.toBe("");
      if ("card" in row) {
        expect(prose.reason, key).toBeUndefined();
      } else {
        expect(prose.reason?.trim(), key).toBeTruthy();
      }
    }
    expect(Object.keys(SETTING_PROSE).toSorted()).toStrictEqual(
      Object.keys(SETTINGS).toSorted()
    );
  });

  it("gives a `routes` row the planes as its default, the floor its reader adds to", () => {
    // The reader of a `routes` row builds on `PLANE_ROUTES` (D19), not on the
    // row's default, so the schema's `.default()` and the resolved set agree
    // only while the two lists do.
    const routes = rows.flatMap(([key, row]) =>
      row.kind === "routes" ? [[key, row] as const] : []
    );
    // Known answer: the one routes row is read.
    expect(routes.map(([key]) => key)).toStrictEqual(["providers"]);
    for (const [key, row] of routes) {
      expect([...row.default].toSorted(), key).toStrictEqual(
        [...PLANE_ROUTES].toSorted()
      );
      expect(Reflect.get(resolveConfig({}), key), key).toStrictEqual(
        new Set(row.default)
      );
    }
  });

  it("keeps a card control only on a boolean or a choice", () => {
    const cardKinds = new Set(
      rows.flatMap(([, row]) => ("card" in row ? [row.kind] : []))
    );
    expect([...cardKinds].toSorted()).toStrictEqual(["boolean", "choice"]);
  });
});
