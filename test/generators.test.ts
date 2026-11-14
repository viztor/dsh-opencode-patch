/**
 * The generator scripts and the `verify-*` scripts, held to one staleness rule
 * and to exit codes that mean something.
 *
 * - **One rule.** Both generators and `verify-catalog.ts` decide "stale" with
 *   `stale` from `scripts/generator-kit.ts`: canonical DATA differs. Key order
 *   and formatting never count, and every export a generator writes counts.
 *   The catalog generator used to compare only its two arrays, so a moved
 *   plane or family endpoint read as current; the limits generator compared
 *   bytes; `verify-catalog` compared id sets.
 * - **Exit codes.** A `verify-*` script that cannot fail is decoration:
 *   `verify-session-band` printed "CONFIRMED" unconditionally, and
 *   `verify-catalog` answered an unreachable registry with a skip and exit 0.
 *   `verify-catalog` is spawned and made to fail; `verify-session-band`'s
 *   verdict is its pure half's (`bandVerdict`), made to fail on a planted
 *   derivation, and the script is spawned in its passing state.
 * - **The generators run.** Each is spawned on a local source (`--from`,
 *   without `--write`): a source that disagrees with the shipped data exits
 *   1, and the limits generator's known answer (a doc made from the shipped
 *   table) exits 0. The limits generator's `--write` runs too, from a scratch
 *   copy of `scripts/` and `src/` (its target is the `src/go-limits-data.ts`
 *   beside its own folder): it rewrites current data in text that is not
 *   the renderer's, and writes a moved figure. The limits renderer's text is held to the committed file
 *   by the same render-and-format round trip the catalog renderer has.
 *
 * Every spawned script is offline: each reads `--from` or runs `--offline`,
 * since the suite's offline guard does not reach a child process.
 *
 * @module test/generators.test
 */
import { spawnSync } from "node:child_process";
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  render,
  shimData,
  type ShimData,
  shimStale,
  splice,
  spliceObject,
  renderFamilyApi,
  renderPlaneApi,
} from "../scripts/catalog-shim.ts";
import {
  canonical,
  generatorArgs,
  outcome,
  stale,
} from "../scripts/generator-kit.ts";
import { renderGoLimits } from "../scripts/go-limits-render.ts";
import {
  bandFacts,
  bandMismatches,
  bandVerdict,
  inBand,
  low12,
} from "../scripts/session-band.ts";
import { payload } from "./support/catalogs.ts";
import {
  GO_MODEL_LIMITS,
  OPENCODE_FAMILY_API,
  OPENCODE_GO_CATALOG,
  OPENCODE_PLANE_API,
  OPENCODE_ZEN_CATALOG,
  openCodeSessionIdFor,
} from "./support/src.ts";

const ROOT = join(import.meta.dirname, "..");

/** What the shim ships, in the shape the rule compares. */
const SHIPPED: ShimData = {
  familyApi: OPENCODE_FAMILY_API,
  go: OPENCODE_GO_CATALOG,
  planeApi: OPENCODE_PLANE_API,
  zen: OPENCODE_ZEN_CATALOG,
};

/** A script under `scripts/`, run to completion by the Node running the suite. */
const runScript = (
  file: string,
  args: readonly string[]
): { status: number | null; stderr: string; stdout: string } => {
  const run = spawnSync(
    process.execPath,
    [
      "--experimental-strip-types",
      "--disable-warning=ExperimentalWarning",
      join(ROOT, "scripts", file),
      ...args,
    ],
    { cwd: ROOT, encoding: "utf8", timeout: 60_000 }
  );
  return { status: run.status, stderr: run.stderr, stdout: run.stdout };
};

/**
 * `text` as the nightly's formatter leaves it: written to a scratch file
 * named `name`, `vp fmt --write` run on it, and read back.
 */
const formatted = (name: string, text: string): string => {
  const temp = mkdtempSync(join(tmpdir(), "generated-"));
  try {
    const file = join(temp, name);
    writeFileSync(file, text);
    const fmt = spawnSync(
      process.execPath,
      [
        join(ROOT, "node_modules", "vite-plus", "bin", "vp"),
        "fmt",
        "--write",
        file,
      ],
      { cwd: ROOT, encoding: "utf8" }
    );
    expect(fmt.status, fmt.stderr).toBe(0);
    return readFileSync(file, "utf8");
  } finally {
    rmSync(temp, { force: true, recursive: true });
  }
};

/**
 * The vendor's Go page, as the doc parser reads it, made from `rows`: one
 * table per tier, each row's label the model's name and its last cell the
 * tier's allowance (`$NaN` for a model with no figure, which parses back to
 * `NaN`).
 */
const goLimitsDoc = (
  rows: Readonly<Record<string, { go: number; goPlus: number; name: string }>>
): string =>
  (
    [
      ["go", "Go"],
      ["goPlus", "Go Plus"],
    ] as const
  )
    .map(([tier, label]) =>
      [
        `<TabItem label="${label}">`,
        "",
        "| Model | Input | Output | Cached | Write | Monthly limit |",
        "| --- | --- | --- | --- | --- | --- |",
        ...Object.values(rows).map(
          (row) =>
            `| ${row.name} | $1 | $2 | $0.1 | - | $${String(row[tier])} |`
        ),
        "",
        "</TabItem>",
      ].join("\n")
    )
    .join("\n\n");

/** The shipped table's first model, by id, and its row. */
const firstLimit = (): [
  string,
  { go: number; goPlus: number; name: string },
] => {
  const [entry] = Object.entries(GO_MODEL_LIMITS);
  expect(entry).toBeDefined();
  return entry ?? ["", { go: 0, goPlus: 0, name: "" }];
};

describe("generators · one staleness rule", () => {
  it("one staleness rule: data, not order or bytes, and every generated export counts", () => {
    expect(stale({ a: 1, b: [1, 2] }, { a: 1, b: [1, 2] })).toBe(false);
    expect(stale({ a: 1, b: [1, 2] }, { b: [1, 2], a: 1 })).toBe(false);
    expect(stale({ a: 1 }, { a: 2 })).toBe(true);
    // A model the vendor's page gives no figure is NaN in the limits table.
    expect(stale({ x: Number.NaN }, { x: Number.NaN })).toBe(false);
    expect(canonical({ b: 1, a: { d: 2, c: 3 } })).toBe(
      '{"a":{"c":3,"d":2},"b":1}'
    );

    expect(shimStale(SHIPPED, SHIPPED)).toBe(false);
    // The two cases the old rule (go and zen arrays only) called current.
    expect(
      shimStale(SHIPPED, {
        ...SHIPPED,
        planeApi: { ...SHIPPED.planeApi, go: "https://example.invalid/go/v1" },
      })
    ).toBe(true);
    const [family] = Object.keys(SHIPPED.familyApi.zen);
    expect(family).toBeDefined();
    expect(
      shimStale(SHIPPED, {
        ...SHIPPED,
        familyApi: {
          ...SHIPPED.familyApi,
          zen: {
            ...SHIPPED.familyApi.zen,
            [family ?? ""]: "https://example.invalid/v1",
          },
        },
      })
    ).toBe(true);
    // The renderer's order is not data.
    expect(SHIPPED.go.length).toBeGreaterThan(1);
    expect(
      shimStale(SHIPPED, { ...SHIPPED, go: SHIPPED.go.toReversed() })
    ).toBe(false);
  });

  it("decides the exit and the action from staleness and --write, and refuses a --from with no path", () => {
    expect(outcome({ stale: true, write: false })).toStrictEqual({
      action: "report-stale",
      exit: 1,
    });
    expect(outcome({ stale: false, write: true })).toStrictEqual({
      action: "current",
      exit: 0,
    });
    expect(outcome({ stale: false, write: false })).toStrictEqual({
      action: "current",
      exit: 0,
    });
    expect(outcome({ stale: true, write: true })).toStrictEqual({
      action: "write",
      exit: 0,
    });
    // A whole-file renderer's text: stale × write × text, every combination.
    // Only current data, `--write` and text that is not the renderer's
    // rewrites; staleness still decides everything else, whatever the text.
    for (const isStale of [false, true]) {
      for (const write of [false, true]) {
        for (const textCurrent of [false, true]) {
          const label = `stale=${String(isStale)} write=${String(write)} text=${String(textCurrent)}`;
          const expected =
            !isStale && write && !textCurrent
              ? { action: "rewrite", exit: 0 }
              : outcome({ stale: isStale, write });
          expect(
            outcome({ stale: isStale, textCurrent, write }),
            label
          ).toStrictEqual(expected);
        }
      }
    }
    expect(
      outcome({ stale: false, textCurrent: false, write: false })
    ).toStrictEqual({ action: "current", exit: 0 });
    expect(
      outcome({ stale: false, textCurrent: false, write: true })
    ).toStrictEqual({ action: "rewrite", exit: 0 });
    expect(
      outcome({ stale: true, textCurrent: false, write: true })
    ).toStrictEqual({ action: "write", exit: 0 });
    expect(generatorArgs([])).toStrictEqual({ write: false });
    expect(generatorArgs(["--write", "--from", "x.json"])).toStrictEqual({
      from: "x.json",
      write: true,
    });
    expect(() => generatorArgs(["--from"])).toThrow(/--from/u);
    expect(() => generatorArgs(["--from", "--write"])).toThrow(/--from/u);
  });

  it("the catalog renderer reproduces the shipped shim from its own data, as the nightly formats it", () => {
    // `--write` on the shipped data, then the formatter the nightly runs:
    // byte-identical, so a current shim proposes no refresh.
    const source = readFileSync(join(ROOT, "src", "catalog-data.ts"), "utf8");
    const data = shimData({
      api: OPENCODE_PLANE_API,
      familyApi: OPENCODE_FAMILY_API,
      go: OPENCODE_GO_CATALOG,
      zen: OPENCODE_ZEN_CATALOG,
    });
    let rewritten = splice(source, "OPENCODE_GO_CATALOG", render(data.go));
    rewritten = splice(rewritten, "OPENCODE_ZEN_CATALOG", render(data.zen));
    rewritten = spliceObject(
      rewritten,
      "OPENCODE_PLANE_API",
      renderPlaneApi(data.planeApi)
    );
    rewritten = spliceObject(
      rewritten,
      "OPENCODE_FAMILY_API",
      renderFamilyApi(data.familyApi)
    );
    // Known answer: the renderer's own text is not the formatted file, so the
    // formatter below has work to do and the comparison is not vacuous.
    expect(rewritten).not.toBe(source);
    expect(formatted("catalog-data.ts", rewritten)).toBe(source);
    expect(() => splice(source, "NO_SUCH_EXPORT", "[]")).toThrow(
      /NO_SUCH_EXPORT/u
    );
  });

  it("the limits renderer reproduces the shipped table from its own data, and the formatter changes nothing", () => {
    const source = readFileSync(join(ROOT, "src", "go-limits-data.ts"), "utf8");
    const rendered = renderGoLimits(GO_MODEL_LIMITS);
    // Byte for byte BEFORE the formatter too: that is what lets `--write`
    // compare the rendered text with the file to apply a template change.
    expect(rendered).toBe(source);
    expect(formatted("go-limits-data.ts", rendered)).toBe(source);
    // Known answer: the text is rendered from the rows, so a moved figure shows.
    const [first, row] = firstLimit();
    const moved = renderGoLimits({
      ...GO_MODEL_LIMITS,
      [first]: { ...row, go: 12_345 },
    });
    expect(moved).not.toBe(source);
    expect(moved).toContain("go: 12345,");
  });
});

describe("generators · the generators, spawned", () => {
  it("the limits generator answers current on a doc made from the shipped table, and stale when one figure moved", () => {
    const temp = mkdtempSync(join(tmpdir(), "go-limits-"));
    try {
      const same = join(temp, "same.md");
      writeFileSync(same, goLimitsDoc(GO_MODEL_LIMITS));
      const current = runScript("generate-go-limits.ts", ["--from", same]);
      expect(current.status, current.stderr).toBe(0);
      expect(current.stdout).toContain("go-limits-data.ts is up to date");

      const [first, row] = firstLimit();
      const changed = join(temp, "changed.md");
      writeFileSync(
        changed,
        goLimitsDoc({ ...GO_MODEL_LIMITS, [first]: { ...row, go: 12_345 } })
      );
      const behind = runScript("generate-go-limits.ts", ["--from", changed]);
      expect(behind.status, behind.stdout).toBe(1);
      expect(behind.stderr).toContain("STALE");
    } finally {
      rmSync(temp, { force: true, recursive: true });
    }
  });

  it("the limits generator's --write rewrites a template change on current data and writes a moved figure, on a scratch copy", () => {
    const temp = mkdtempSync(join(tmpdir(), "go-limits-write-"));
    try {
      // The generator's target is `../src/go-limits-data.ts` from its own
      // file, so a copy of both folders keeps the shipped file untouched.
      for (const folder of ["scripts", "src"]) {
        cpSync(join(ROOT, folder), join(temp, folder), { recursive: true });
      }
      symlinkSync(join(ROOT, "node_modules"), join(temp, "node_modules"));
      const target = join(temp, "src", "go-limits-data.ts");
      const rendered = renderGoLimits(GO_MODEL_LIMITS);
      const spawn = (args: readonly string[]) => {
        const run = spawnSync(
          process.execPath,
          [
            "--experimental-strip-types",
            "--disable-warning=ExperimentalWarning",
            join(temp, "scripts", "generate-go-limits.ts"),
            ...args,
          ],
          { cwd: temp, encoding: "utf8", timeout: 60_000 }
        );
        return { status: run.status, stderr: run.stderr, stdout: run.stdout };
      };
      const same = join(temp, "same.md");
      writeFileSync(same, goLimitsDoc(GO_MODEL_LIMITS));
      // Whether a spawn wrote the target at all, bytes aside: its mtime is
      // set to a fixed past first. A byte-identical rewrite is not harmless,
      // since the lib freshness check in `scripts/check.ts` reads src/ mtimes.
      const PAST = new Date(Date.UTC(2020, 0, 1));
      const writes = (args: readonly string[]) => {
        utimesSync(target, PAST, PAST);
        const run = spawn(args);
        return { ...run, touched: statSync(target).mtimeMs !== PAST.getTime() };
      };

      // Current data in text that is not the renderer's (a template change):
      // left alone without --write, rewritten with it.
      const reflowed = `${rendered}\n// a line the renderer does not make\n`;
      writeFileSync(target, reflowed);
      const report = writes(["--from", same]);
      expect(report.status, report.stderr).toBe(0);
      expect(report.stdout).toContain("go-limits-data.ts is up to date");
      expect(readFileSync(target, "utf8")).toBe(reflowed);
      expect(report.touched).toBe(false);
      const rewrite = writes(["--write", "--from", same]);
      expect(rewrite.status, rewrite.stderr).toBe(0);
      expect(rewrite.stdout).toContain("rewrote src/go-limits-data.ts");
      expect(readFileSync(target, "utf8")).toBe(rendered);
      expect(rewrite.touched).toBe(true);
      // Current in data and text: never rewritten, not even to the same bytes.
      const current = writes(["--write", "--from", same]);
      expect(current.status, current.stderr).toBe(0);
      expect(current.stdout).toContain("go-limits-data.ts is up to date");
      expect(readFileSync(target, "utf8")).toBe(rendered);
      expect(current.touched).toBe(false);

      // A moved figure: written, with the renderer's text.
      const [first, row] = firstLimit();
      const moved = { ...GO_MODEL_LIMITS, [first]: { ...row, go: 12_345 } };
      const changed = join(temp, "changed.md");
      writeFileSync(changed, goLimitsDoc(moved));
      const write = writes(["--write", "--from", changed]);
      expect(write.status, write.stderr).toBe(0);
      expect(write.touched).toBe(true);
      expect(write.stdout).toContain("wrote ");
      expect(write.stdout).not.toContain("rewrote");
      expect(readFileSync(target, "utf8")).toBe(renderGoLimits(moved));
      expect(readFileSync(target, "utf8")).toContain("go: 12345,");
    } finally {
      rmSync(temp, { force: true, recursive: true });
    }
    // The shipped table is the renderer's text of its own data still.
    expect(readFileSync(join(ROOT, "src", "go-limits-data.ts"), "utf8")).toBe(
      renderGoLimits(GO_MODEL_LIMITS)
    );
  });

  it("the catalog generator answers stale on a payload the shipped shim does not hold, and fails on one it could not read", () => {
    const temp = mkdtempSync(join(tmpdir(), "catalog-shim-"));
    try {
      const file = join(temp, "api.json");
      writeFileSync(
        file,
        JSON.stringify(
          payload({ go: [{ id: "made-up-go" }], zen: [{ id: "made-up-zen" }] })
        )
      );
      const behind = runScript("regenerate-catalog-shim.ts", ["--from", file]);
      expect(behind.status, behind.stderr).toBe(1);
      expect(behind.stdout).toContain("shim is STALE");
      expect(behind.stdout).toContain("+ 1: made-up-go");

      const unread = runScript("regenerate-catalog-shim.ts", [
        "--from",
        join(temp, "missing.json"),
      ]);
      expect(unread.status).not.toBe(0);
      expect(unread.stdout).not.toContain("shim is current");
    } finally {
      rmSync(temp, { force: true, recursive: true });
    }
  });
});

describe("generators · verify-catalog fails closed", () => {
  it("verify-catalog exits non-zero on a stale shim and on a source it could not read, and passes offline on this tree", () => {
    const temp = mkdtempSync(join(tmpdir(), "verify-catalog-"));
    try {
      const file = join(temp, "api.json");
      writeFileSync(
        file,
        JSON.stringify(
          payload({ go: [{ id: "made-up-go" }], zen: [{ id: "made-up-zen" }] })
        )
      );
      const behind = runScript("verify-catalog.ts", ["--from", file]);
      expect(behind.status, behind.stderr).toBe(1);
      expect(behind.stdout).toContain("shim is stale");
      expect(behind.stdout).toContain("FAILED:");

      const unread = runScript("verify-catalog.ts", [
        "--from",
        join(temp, "missing.json"),
      ]);
      expect(unread.status, unread.stderr).toBe(1);
      expect(unread.stdout).toContain("not read");
      expect(unread.stdout).toContain("FAILED:");
    } finally {
      rmSync(temp, { force: true, recursive: true });
    }

    const offline = runScript("verify-catalog.ts", ["--offline"]);
    expect(offline.status, offline.stderr).toBe(0);
    expect(offline.stdout).toMatch(
      /^ {2}skip {2}registry not asked \(--offline\)/mu
    );
    expect(offline.stdout).toMatch(/^ {2}ok {4}opencode: exactly the/mu);
    expect(offline.stdout).toMatch(/^ {2}ok {4}opencode-go: exactly the/mu);
    expect(offline.stdout).toMatch(/^ {2}ok {4}every catalog model \(\d+\)/mu);
    expect(offline.stdout).toMatch(/^ {2}ok {4}every free model gets/mu);
    expect(offline.stdout).toContain("PASS:");
  });
});

describe("generators · verify-session-band fails when it should", () => {
  it("verify-session-band's verdict fails when the derivation leaves the band, and the script prints it", () => {
    expect(low12("ses_000000000ffe")).toBe(0xffe);
    expect(inBand(0xffe)).toBe(true);
    expect(inBand(0xfbf)).toBe(false);

    const facts = bandFacts({ derive: openCodeSessionIdFor, samples: 5000 });
    expect(facts.ascending.inBand).toBe(0);
    expect(facts.descending).toMatchObject({ inBand: 5000, total: 5000 });
    expect(facts.withinOneMs).toMatchObject({ inBand: 63, total: 80 });
    expect(facts.ours).toMatchObject({ inBand: 5000, total: 5000 });
    expect(bandMismatches(facts)).toStrictEqual([]);

    // A derivation that leaves the band is named, and nothing else is.
    const planted = bandFacts({
      derive: () => `ses_000000000001${"0".repeat(14)}`,
      samples: 5000,
    });
    const mismatches = bandMismatches(planted);
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0]).toContain("this plugin's derivation");

    // The verdict the script prints: a mismatch fails it, and never
    // confirms alongside.
    const failed = bandVerdict(planted);
    expect(failed.exit).toBe(1);
    expect(failed.lines).toStrictEqual([`MISMATCH: ${mismatches[0] ?? ""}`]);
    expect(failed.lines.join("\n")).not.toContain("CONFIRMED");
    const confirmed = bandVerdict(facts);
    expect(confirmed.exit).toBe(0);
    expect(confirmed.lines[0]).toMatch(/^CONFIRMED\./u);
    expect(confirmed.lines.join("\n")).not.toContain("MISMATCH");

    // The script prints that verdict and exits with it.
    const run = runScript("verify-session-band.ts", []);
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toContain(confirmed.lines.join("\n"));
    expect(run.stdout).not.toContain("MISMATCH");
  });
});
