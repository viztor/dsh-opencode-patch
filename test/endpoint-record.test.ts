/**
 * The dated record the live suites write, and the doc section that holds it.
 *
 * `test/e2e/keyless-matrix.e2e.ts` and `test/e2e/keyed-probes.e2e.ts` print
 * one markdown table each into the CI run summary and the `endpoint-families`
 * artifact; a run's tables are pasted into `docs/redirect-planes.md` §13 with
 * their date. This file pins the formatter line by line, and holds the doc's
 * tables to the formatter's columns and row order, so a pasted run and the
 * placeholder it replaces have the same shape. It compares trimmed cells, so a
 * formatter re-padding the tables cannot break it, and it never asserts what a
 * cell SAYS, so pasting real results keeps it green.
 *
 * @module test/endpoint-record.test
 */
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  freeProbeLine,
  RECORD_HEADER,
  RECORD_ROWS,
  RECORD_RULE,
  type RecordedProbe,
  recordCell,
  recordTable,
  runReference,
} from "./support/endpoint-record.ts";
import { MATRIX_FAMILIES, MATRIX_PROTOCOLS } from "./support/keyless-matrix.ts";

/** One probe per cell but one: root answers 404, the rest 401, Go's Google has no model. */
const PROBES: RecordedProbe[] = (["opencode", "opencode-go"] as const)
  .flatMap((plane) =>
    MATRIX_PROTOCOLS.flatMap((protocol) =>
      MATRIX_FAMILIES.map((family): RecordedProbe => {
        if (plane === "opencode-go" && protocol === "google-generative-ai") {
          return {
            family,
            model: undefined,
            plane,
            protocol,
            status: undefined,
            verdict: "no-model",
          };
        }
        return {
          family,
          model: `m-${protocol}`,
          plane,
          protocol,
          status: family === "root" ? 404 : 401,
          verdict: family === "root" ? "path-gone" : "path-exists",
        };
      })
    )
  )
  .filter(
    (probe) =>
      !(
        probe.plane === "opencode" &&
        probe.protocol === "openai-completions" &&
        probe.family === "root"
      )
  );

const cellsOf = (line: string): string[] =>
  line
    .split("|")
    .slice(1, -1)
    .map((cell) => cell.trim());

describe("endpoint record · the table", () => {
  it("prints one dated row per plane × protocol, a cell per shape with verdict, status and dispatch marks", () => {
    expect(PROBES).toHaveLength(23);
    expect(
      recordTable({
        date: "2026-10-24",
        probes: PROBES,
        run: "a local run",
        title: "Keyless",
      }).split("\n")
    ).toEqual([
      "### Keyless · measured 2026-10-24 (UTC) · a local run",
      "",
      RECORD_HEADER,
      RECORD_RULE,
      "| `opencode` | `openai-completions` | `m-openai-completions` | path-exists (401) † | not sent | path-exists (401) * |",
      "| `opencode` | `openai-responses` | `m-openai-responses` | path-exists (401) † | path-gone (404) | path-exists (401) * |",
      "| `opencode` | `anthropic-messages` | `m-anthropic-messages` | path-exists (401) † | path-gone (404) | path-exists (401) * |",
      "| `opencode` | `google-generative-ai` | `m-google-generative-ai` | path-exists (401) † | path-gone (404) | path-exists (401) * |",
      "| `opencode-go` | `openai-completions` | `m-openai-completions` | path-exists (401) † | path-gone (404) | path-exists (401) * |",
      "| `opencode-go` | `openai-responses` | `m-openai-responses` | path-exists (401) † | path-gone (404) | path-exists (401) * |",
      "| `opencode-go` | `anthropic-messages` | `m-anthropic-messages` | path-exists (401) † | path-gone (404) | path-exists (401) * |",
      "| `opencode-go` | `google-generative-ai` | — | no-model | no-model | no-model * † |",
    ]);
    expect(RECORD_HEADER).toBe(
      "| Plane | Protocol | Model | `/zen(/go)/v1` (legacy) | `/inference(/go)/v1` (root) | `/inference(/go)/{openai,anthropic,google}/…` (modern) |"
    );
    expect(RECORD_RULE).toBe("| :-- | :-- | :-- | :-- | :-- | :-- |");
  });

  it("names each cell, its status and its marks", () => {
    expect(recordCell("opencode openai-completions root")).toBe("not sent");
    expect(
      recordCell("opencode openai-completions modern", {
        family: "modern",
        model: "m",
        plane: "opencode",
        protocol: "openai-completions",
        status: 200,
        verdict: "served",
      })
    ).toBe("served (200) *");
    expect(
      recordCell("opencode-go openai-responses legacy", {
        family: "legacy",
        model: "m",
        plane: "opencode-go",
        protocol: "openai-responses",
        status: undefined,
        verdict: "transport-error",
      })
    ).toBe("transport-error †");
  });

  it("names the path a redirect pointed at, with a `|` encoded so the row stays six cells", () => {
    const redirected = (location: string): RecordedProbe => ({
      family: "legacy",
      location,
      model: "m",
      plane: "opencode",
      protocol: "openai-completions",
      status: 308,
      verdict: "redirected",
    });
    expect(
      recordCell(
        "opencode openai-completions legacy",
        redirected("/inference/openai/v1/chat/completions")
      )
    ).toBe("redirected (308 → /inference/openai/v1/chat/completions) †");
    const piped = recordCell(
      "opencode openai-completions legacy",
      redirected("/a|b")
    );
    expect(piped).toBe("redirected (308 → /a%7Cb) †");
    const table = recordTable({
      date: "2026-10-24",
      probes: [redirected("/a|b")],
      run: "a local run",
      title: "Keyed",
    }).split("\n");
    expect(cellsOf(table[4] ?? "")).toHaveLength(6);
    expect(table[4]).toContain("redirected (308 → /a%7Cb) †");
    // A redirect with no status kept still names its target.
    expect(
      recordCell("opencode openai-completions root", {
        ...redirected("/x"),
        family: "root",
        status: undefined,
      })
    ).toBe("redirected → /x");
  });

  it("orders the rows plane by plane, in the matrix's protocol order", () => {
    expect(RECORD_ROWS).toEqual([
      ...MATRIX_PROTOCOLS.map((protocol) => ["opencode", protocol]),
      ...MATRIX_PROTOCOLS.map((protocol) => ["opencode-go", protocol]),
    ]);
    expect(RECORD_ROWS).toHaveLength(8);
  });

  it("links the run that measured it, or says it was local", () => {
    expect(
      runReference({
        repository: "o/r",
        runId: "42",
        server: "https://github.com",
      })
    ).toBe("[run 42](https://github.com/o/r/actions/runs/42)");
    for (const parts of [
      { repository: undefined, runId: "42", server: "https://github.com" },
      { repository: "", runId: "42", server: "https://github.com" },
      { repository: "o/r", runId: undefined, server: "https://github.com" },
      { repository: "o/r", runId: "", server: "https://github.com" },
      { repository: "o/r", runId: "42", server: undefined },
      { repository: "o/r", runId: "42", server: "" },
    ]) {
      expect(runReference(parts)).toBe("a local run");
    }
  });

  it("prints the free probe on one line", () => {
    expect(
      freeProbeLine({ model: "beam-free", status: 200, verdict: "served" })
    ).toBe(
      "Free model on `/inference/openai/v1/chat/completions`: `beam-free` → served (200)."
    );
    expect(
      freeProbeLine({
        model: undefined,
        status: undefined,
        verdict: "no-model",
      })
    ).toBe(
      "Free model on `/inference/openai/v1/chat/completions`: no model → no-model."
    );
  });
});

describe("endpoint record · docs/redirect-planes.md §13", () => {
  it("docs/redirect-planes.md §13 holds the keyless and keyed tables in the formatter's columns and row order, and the free-probe line", () => {
    const doc = readFileSync(
      new URL("../docs/redirect-planes.md", import.meta.url),
      "utf8"
    );
    const start = doc.indexOf("\n## 13. ");
    expect(start).toBeGreaterThan(-1);
    const section = doc.slice(start);
    const lines = section.split("\n");
    const header = cellsOf(RECORD_HEADER);
    const headerAt = lines.flatMap((line, index) =>
      line.startsWith("|") &&
      JSON.stringify(cellsOf(line)) === JSON.stringify(header)
        ? [index]
        : []
    );
    expect(headerAt).toHaveLength(2);
    for (const at of headerAt) {
      expect(lines[at + 1]).toMatch(/^\|(\s*:?-+:?\s*\|){6}$/u);
      const rows = lines.slice(at + 2, at + 10);
      expect(rows.map((row) => cellsOf(row).slice(0, 2))).toEqual(
        RECORD_ROWS.map(([plane, protocol]) => [
          `\`${plane}\``,
          `\`${protocol}\``,
        ])
      );
      for (const row of rows) {
        expect(cellsOf(row), row).toHaveLength(6);
      }
    }
    const headings = lines.filter((line) => line.startsWith("### "));
    expect(headings).toHaveLength(2);
    expect(headings[0]).toMatch(
      /^### Keyless · (pending the first CI run|measured \d{4}-\d{2}-\d{2} \(UTC\) · .+)$/u
    );
    expect(headings[1]).toMatch(
      /^### Keyed · (pending the first CI run|measured \d{4}-\d{2}-\d{2} \(UTC\) · .+)$/u
    );
    expect(section).toMatch(
      /^Free model on `\/inference\/openai\/v1\/chat\/completions`: .+$/mu
    );
  });
});
