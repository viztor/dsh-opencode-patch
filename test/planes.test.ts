/**
 * The plane table (`src/utils/planes.ts`) and its URL reader, and the guard
 * against a second copy of the rule in the spellings it scans.
 *
 * `test/plane-table.test.ts` pins every caller's answer through names that
 * existed before the table; this file tests the table's own names, and scans
 * `src` for a route compared against a plane route's literal, or paired with a
 * plane's name in a quoted table row (either order, any key name), anywhere
 * but the table and the route list it is keyed by. A source scan is a
 * tripwire for the spellings it names, not a proof: what still passes it
 * includes, for example, an unquoted key (`opencode: "zen"`), a record with
 * another key between the route and the plane, and a route built from parts;
 * the second scan plants each of those as a non-offender, so the list is
 * checked rather than only written down.
 *
 * @module test/planes.test
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  PLANE_OF_ROUTE,
  PLANE_ROUTES,
  planeForRoute,
  planeForUrl,
  planeOfPlaneRoute,
} from "./support/src.ts";
import { blankCommentLines } from "./support/strip-comments.ts";

describe("planes · one table", () => {
  it("files each owned route under its plane, keyed in the route list's order", () => {
    expect(PLANE_OF_ROUTE).toEqual({ opencode: "zen", "opencode-go": "go" });
    expect(Object.keys(PLANE_OF_ROUTE)).toEqual([...PLANE_ROUTES]);
  });

  it("planeOfPlaneRoute answers the two owned routes and nothing else", () => {
    expect(planeOfPlaneRoute("opencode")).toBe("zen");
    expect(planeOfPlaneRoute("opencode-go")).toBe("go");
    for (const value of [
      "opencode-go-relay",
      "OpenCode-Go",
      "constructor",
      "__proto__",
      "",
      5,
      undefined,
    ]) {
      expect(planeOfPlaneRoute(value), String(value)).toBeUndefined();
    }
  });

  it("planeForRoute: Go for the Go route and its relays, Zen for everything else", () => {
    const table: readonly (readonly [unknown, "go" | "zen"])[] = [
      ["opencode", "zen"],
      ["opencode-go", "go"],
      ["opencode-go-relay", "go"],
      ["opencode-google", "zen"],
      // Case-sensitive, as the catalog's rule always was.
      ["OpenCode-Go", "zen"],
      ["my-relay", "zen"],
      ["", "zen"],
      [undefined, "zen"],
      [5, "zen"],
    ];
    for (const [route, plane] of table) {
      expect(planeForRoute(route), String(route)).toBe(plane);
    }
  });

  it("planeForUrl reads the path, in both endpoint families and a relay's", () => {
    expect(planeForUrl("https://opencode.ai/inference/go/openai/v1")).toBe(
      "go"
    );
    expect(planeForUrl("https://opencode.ai/zen/go/v1/chat/completions")).toBe(
      "go"
    );
    expect(planeForUrl("https://opencode.ai/inference/google/v1beta")).toBe(
      "zen"
    );
    expect(planeForUrl("https://opencode.ai/zen/v1/messages")).toBe("zen");
    expect(
      planeForUrl("https://relay.example.com/go/v1/chat/completions")
    ).toBe("go");
  });
});

describe("planes · no second copy of the rule in src", () => {
  const SRC = join(import.meta.dirname, "..", "src");

  /**
   * Files that may hold a comparison, and exactly how many: the table (its
   * exact `=== "opencode-go"` and its relay half, `startsWith("opencode-go-")`),
   * the route list's own guard (`isPlaneRoute`'s pair), and `go-discovery.ts`,
   * whose reads of a provider row by name stay until the module moves in
   * P10a. A count, not a whole-file pass, so a second copy added inside an
   * allowed file is still seen; and an EXACT count, not a ceiling, so a copy
   * that goes (P10a's move) forces its allowance down rather than leaving
   * room for a new one. Generated files hold the vendor's data, not a copy of
   * a rule.
   */
  const ALLOWED: ReadonlyMap<string, number> = new Map([
    ["utils/planes.ts", 2],
    ["utils/protocols.ts", 2],
    ["go-discovery.ts", 2],
  ]);

  /**
   * Files that may hold a quoted route paired with a plane's name, and exactly
   * how many: `PLANE_OF_ROUTE`'s quoted row (`"opencode-go": "go"`; its
   * `opencode` key is unquoted), and `go-discovery.ts`'s capture-store read
   * `get("opencode", "zen")`, until P10a moves it.
   */
  const PAIRS_ALLOWED: ReadonlyMap<string, number> = new Map([
    ["utils/planes.ts", 1],
    ["go-discovery.ts", 1],
  ]);
  const GENERATED = new Set(["catalog-data.ts", "go-limits-data.ts"]);

  /**
   * The rule's spellings: a comparison against `"opencode"` or `"opencode-go"`
   * on either side, the relay half (`startsWith("opencode-go…")`), and a
   * `case` label. The relay predicate `startsWith("opencode")` (is this route
   * a relay at all) is a different question and is not matched.
   */
  const COMPARISON =
    /[!=]==\s*"opencode(?:-go)?"|"opencode(?:-go)?"\s*[!=]==|startsWith\(\s*"opencode-go|case\s+"opencode(?:-go)?"\s*:/gu;

  /**
   * The table form: a quoted route beside a plane's name, in either order, as
   * an object row (`"opencode-go": "go"`, `"go": "opencode-go"`), a tuple or
   * argument pair (`["opencode", "zen"]`, `["zen", "opencode"]`), or a record
   * row under any key name (`{ route: "opencode", plane: "zen" }`, the form of
   * the purge action's table this phase folded, and `{ plane: "zen", route:
   * "opencode" }`, the key order its replacement builds). The second literal
   * of a pair must not itself be a key (`(?!\s*:)`), so two neighbouring rows
   * of one object (`opencode: "zen", "opencode-go": "go"`) are not read as a
   * plane-first pair that would hide the real row behind it.
   */
  const PAIR =
    /"opencode(?:-go)?"\s*[:,]\s*(?:\w+\s*:\s*)?"(?:go|zen)"(?!\s*:)|"(?:go|zen)"\s*[:,]\s*(?:\w+\s*:\s*)?"opencode(?:-go)?"(?!\s*:)/gu;

  const count = (source: string, pattern: RegExp = COMPARISON): number =>
    [...source.matchAll(pattern)].length;

  /** Every file whose count of `pattern` is not exactly its allowance. */
  const offenders = (
    files: ReadonlyMap<string, string>,
    pattern: RegExp = COMPARISON,
    allowed: ReadonlyMap<string, number> = ALLOWED
  ): string[] =>
    [...files]
      .filter(
        ([file, source]) => count(source, pattern) !== (allowed.get(file) ?? 0)
      )
      .map(([file]) => file)
      .toSorted();

  const sources = (): ReadonlyMap<string, string> =>
    new Map(
      readdirSync(SRC, { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile() && /\.tsx?$/u.test(entry.name))
        .map((entry) =>
          join(entry.parentPath, entry.name).slice(SRC.length + 1)
        )
        .filter((file) => !GENERATED.has(file))
        .map((file) => [
          file,
          blankCommentLines(readFileSync(join(SRC, file), "utf8")),
        ])
    );

  it("compares a route against a plane route's literal only in the table", () => {
    const files = sources();
    // The scan reads the tree: the table, and a file that held a copy.
    expect(files.has("utils/planes.ts")).toBe(true);
    expect(files.has("key-capture.ts")).toBe(true);
    expect(count(files.get("utils/planes.ts") ?? "")).toBe(2);
    expect(offenders(files)).toEqual([]);
    // A planted copy is seen, on either side of the operator, as the relay
    // half and as a `case` label, and inside an allowed file; a longer route
    // name, and the relay predicate, are not mistaken for one.
    const planted = new Map([
      ...files,
      ["planted.ts", 'const go = route === "opencode-go";\n'],
      ["planted-left.ts", 'if ("opencode" !== provider) {}\n'],
      [
        "planted-relay-half.ts",
        'const go = route.startsWith("opencode-go-");\n',
      ],
      ["planted-case.ts", 'switch (route) { case "opencode-go": break; }\n'],
      [
        "utils/planes.ts",
        `${files.get("utils/planes.ts") ?? ""}\nconst again = route === "opencode";\n`,
      ],
      ["relay.ts", 'const r = route === "opencode-go-relay";\n'],
      ["relay-predicate.ts", 'const relay = !route.startsWith("opencode");\n'],
    ]);
    expect(offenders(planted)).toEqual([
      "planted-case.ts",
      "planted-left.ts",
      "planted-relay-half.ts",
      "planted.ts",
      "utils/planes.ts",
    ]);
    // A removed copy is seen too: the allowance is exact, not a ceiling.
    const removed = new Map([...files, ["go-discovery.ts", ""]]);
    expect(offenders(removed)).toEqual(["go-discovery.ts"]);
  });

  it("pairs a route with a plane's name in a table only in the table", () => {
    const files = sources();
    expect(files.has("go-discovery.ts")).toBe(true);
    // The table's one quoted row is the match, not a plane-first reading of
    // its two neighbouring rows.
    expect(
      [...(files.get("utils/planes.ts") ?? "").matchAll(PAIR)].map(
        (match) => match[0]
      )
    ).toEqual(['"opencode-go": "go"']);
    expect(offenders(files, PAIR, PAIRS_ALLOWED)).toEqual([]);
    // The purge action's old table row, the same record in the key order its
    // replacement builds, a record under another key name, an object row
    // either way round, a Map's tuples either way round, and a second row
    // inside an allowed file are each seen.
    const planted = new Map([
      ...files,
      [
        "planted-record.ts",
        'const PLANES = [{ route: "opencode", plane: "zen" }];\n',
      ],
      [
        "planted-record-plane-first.ts",
        'const PLANES = [\n  { plane: "zen", route: "opencode" },\n  { plane: "go", route: "opencode-go" },\n];\n',
      ],
      [
        "planted-record-tier.ts",
        'const T = [{ route: "opencode", tier: "zen" }];\n',
      ],
      ["planted-object.ts", 'const P = { "opencode": "zen" };\n'],
      ["planted-object-reversed.ts", 'const P = { "go": "opencode-go" };\n'],
      ["planted-map.ts", 'const P = new Map([["opencode-go", "go"]]);\n'],
      [
        "planted-map-reversed.ts",
        'const P = new Map([["zen", "opencode"]]);\n',
      ],
      [
        "utils/planes.ts",
        `${files.get("utils/planes.ts") ?? ""}\nconst again = { "opencode": "zen" };\n`,
      ],
      // Not seen: a relay route, a pair whose other literal is no plane's
      // name, a neighbouring row that is a key, and the spellings the scan
      // does not name (an unquoted key, another key between the pair, a
      // route built from parts).
      ["relay.ts", 'const r = { "opencode-go-relay": "go" };\n'],
      ["other.ts", 'const k = get("opencode", "anthropic");\n'],
      ["neighbour.ts", 'const n = { a: "zen", "opencode": 1 };\n'],
      ["unquoted.ts", 'const u = { opencode: "zen" };\n'],
      [
        "between.ts",
        'const b = [{ route: "opencode", label: "x", plane: "zen" }];\n',
      ],
      ["parts.ts", 'const p = { ["opencode" + "-go"]: "go" };\n'],
    ]);
    expect(offenders(planted, PAIR, PAIRS_ALLOWED)).toEqual([
      "planted-map-reversed.ts",
      "planted-map.ts",
      "planted-object-reversed.ts",
      "planted-object.ts",
      "planted-record-plane-first.ts",
      "planted-record-tier.ts",
      "planted-record.ts",
      "utils/planes.ts",
    ]);
    // Exact here as well: a pair that goes forces its allowance down.
    const removed = new Map([...files, ["go-discovery.ts", ""]]);
    expect(offenders(removed, PAIR, PAIRS_ALLOWED)).toEqual([
      "go-discovery.ts",
    ]);
  });
});
