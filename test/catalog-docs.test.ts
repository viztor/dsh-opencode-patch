/**
 * OpenCode Model Catalog: the README's routing table, against the catalog.
 *
 * @module test/catalog-docs.test
 */
import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { OPENCODE_GO_CATALOG, OPENCODE_ZEN_CATALOG } from "./support/src.ts";

/**
 * The README's routing table, asserted against the catalog it describes.
 *
 * A count written into prose does not regenerate with the data it counts, and
 * this file's history is the evidence: the table said 28 models named no SDK and
 * had no row for mistral at all, a regeneration after it was written. Nothing
 * failed, because nothing was checking - and a user reading the table would have
 * been told the wrong thing about the catalog they were choosing from.
 *
 * So the table is parsed and compared. When the catalog is regenerated with
 * different counts, this goes red and says which numbers to update, instead of
 * the prose drifting quietly out of date.
 */
describe("catalog · the README's routing table", () => {
  const readme = () =>
    readFile(new URL("../README.md", import.meta.url), "utf8");

  /** `| \`@ai-sdk/x\` | 12 | ... |` and `| _(absent)_ | 12 | ... |`, in order. */
  const documentedCounts = (text: string): Map<string, number> => {
    const counts = new Map<string, number>();
    for (const line of text.split("\n")) {
      const match = /^\|\s*(?:`([^`]+)`|_\(absent\)_)\s*\|\s*(\d+)\s*\|/u.exec(
        line
      );
      if (match !== null) {
        counts.set(match[1] ?? "(absent)", Number(match[2]));
      }
    }
    return counts;
  };

  it("matches the catalog it counts", async () => {
    const measured = new Map<string, number>();
    for (const model of Object.values(OPENCODE_ZEN_CATALOG)) {
      const sdk = model.provider_npm ?? "(absent)";
      measured.set(sdk, (measured.get(sdk) ?? 0) + 1);
    }

    // The table has to describe every SDK the catalog names - a row that is
    // missing is the failure the mistral row was.
    expect(documentedCounts(await readme())).toEqual(measured);
  });

  it("holds the protocol doc's table to the same catalog", async () => {
    // The same class of claim in a second document: "28 of 84" is a count
    // written into prose, and it drifts exactly the way the README's did. The
    // numbers are parsed rather than trusted, and the total has to match too.
    const text = await readFile(
      new URL("../docs/protocol-routing-and-merge.md", import.meta.url),
      "utf8"
    );
    const pairs = [...text.matchAll(/(\d+) of (\d+)/gu)].map((m) => [
      Number(m[1] ?? 0),
      Number(m[2] ?? 0),
    ]);
    const total = Object.keys(OPENCODE_ZEN_CATALOG).length;
    const measured = new Map<string, number>();
    for (const model of Object.values(OPENCODE_ZEN_CATALOG)) {
      const sdk = model.provider_npm ?? "(absent)";
      measured.set(sdk, (measured.get(sdk) ?? 0) + 1);
    }

    expect(pairs.length).toBeGreaterThan(0);
    for (const [count, of] of pairs) {
      expect(of, "a row states a total the catalog does not have").toBe(total);
      expect(
        [...measured.values()],
        `${count} of ${of} matches no SDK count`
      ).toContain(count);
    }
    // And the rows add up, so the table cannot disagree with itself.
    expect(pairs.reduce((sum, pair) => sum + (pair[0] ?? 0), 0)).toBe(total);
  });

  it("holds the prose totals to the catalog, in both languages", async () => {
    // The tables above are parsed; the totals in the sentences beside them were
    // not, and every count this repository has had to correct lived there - the
    // README said 84 for a catalog of 85, the plane table said 120 served where
    // 85 are, and the Chinese README carried both. A number in a sentence is the
    // easiest kind to forget and the one a reader trusts most, so it is parsed
    // too. The regex allows the emphasis markers the number is wrapped in.
    const zen = Object.keys(OPENCODE_ZEN_CATALOG).length;
    const go = Object.keys(OPENCODE_GO_CATALOG).length;
    for (const file of ["../README.md", "../README.zh-CN.md"]) {
      const text = await readFile(new URL(file, import.meta.url), "utf8");
      const stated = [
        ...text.matchAll(
          /(\d+)\*{0,2}\s*(?:active[^.]*models|个\*\*在用\*\*模型)/gu
        ),
      ].map((m) => Number(m[1] ?? 0));
      expect(
        stated.length,
        `${file} states the catalog total nowhere`
      ).toBeGreaterThan(0);
      for (const n of stated) {
        expect(n, `${file} states a Zen total the catalog does not have`).toBe(
          zen
        );
      }
    }
    // "85 served / 120 listed" and "32 served / 36 listed": the served half is
    // ours to assert, the listed half comes from models.dev and is not.
    const planes = await readFile(
      new URL("../docs/redirect-planes.md", import.meta.url),
      "utf8"
    );
    const served = [...planes.matchAll(/(\d+)\s*served\s*\//gu)].map((m) =>
      Number(m[1] ?? 0)
    );
    expect(served).toEqual([zen, go]);
  });

  it("holds the plane-by-plane table to both catalogs", async () => {
    // The third document with counts, and the one whose table is per plane:
    // every cell is a count, and every cell was stale when this was written.
    const text = await readFile(
      new URL("../docs/redirect-planes.md", import.meta.url),
      "utf8"
    );
    const counted = (catalog: readonly { provider_npm?: string }[]) => {
      const bySdk = new Map<string, number>();
      for (const model of Object.values(catalog)) {
        const sdk = model.provider_npm ?? "(none)";
        bySdk.set(sdk, (bySdk.get(sdk) ?? 0) + 1);
      }
      return bySdk;
    };
    const zen = counted(OPENCODE_ZEN_CATALOG);
    const go = counted(OPENCODE_GO_CATALOG);

    const rows: { go: number; sdk: string; zen: number }[] = [];
    for (const line of text.split("\n")) {
      const cells = line.split("|").map((cell) => cell.trim());
      // `| SDK | protocol | Zen | Go |` — five cells once split on the pipes.
      if (cells.length !== 6 || cells[1] === "" || cells[1] === ":--") {
        continue;
      }
      const sdk =
        cells[1] === "_(none)_"
          ? "(none)"
          : /^`([^`]+)`$/u.exec(cells[1] ?? "")?.[1];
      const zenCount = Number(cells[3]?.replaceAll("*", ""));
      const rawGo = cells[4]?.replaceAll("*", "") ?? "";
      const goCount = rawGo === "—" || rawGo === "-" ? 0 : Number(rawGo);
      if (
        sdk === undefined ||
        !Number.isFinite(zenCount) ||
        !Number.isFinite(goCount)
      ) {
        continue;
      }
      rows.push({ go: goCount, sdk, zen: zenCount });
    }

    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.zen, `${row.sdk} on Zen`).toBe(zen.get(row.sdk) ?? 0);
      expect(row.go, `${row.sdk} on Go`).toBe(go.get(row.sdk) ?? 0);
    }
    // Every SDK either plane names has a row, so a new one cannot be missed.
    expect(rows.map((row) => row.sdk).toSorted()).toEqual(
      [...new Set([...zen.keys(), ...go.keys()])].toSorted()
    );
  });

  it("states the same total it lists", async () => {
    const text = await readme();
    const total = /Counts are the \*\*(\d+)\*\*/u.exec(text);
    expect(total, "the README no longer states a total").not.toBeNull();
    expect(Number(total?.[1])).toBe(Object.keys(OPENCODE_ZEN_CATALOG).length);
    // And the rows add up to it, so the table cannot disagree with its own
    // sentence the way it did before this test existed.
    const sum = [...documentedCounts(text).values()].reduce((a, b) => a + b, 0);
    expect(sum).toBe(Number(total?.[1]));
  });
});
