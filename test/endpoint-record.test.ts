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
  retryAfterLine,
  runReference,
  systemOneLine,
  VARIANT_HEADER,
  VARIANT_ROWS,
  VARIANT_RULE,
  variantTable,
} from "./support/endpoint-record.ts";
import { KEYED_VARIANTS } from "./support/keyed-probes.ts";
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

describe("endpoint record · the records beside the tables (L4, L5, L9, L10, L13, OC6, OC8, OC9)", () => {
  it("prints the System One family on one line, a shape it did not reach as not sent", () => {
    expect(
      systemOneLine([
        { family: "legacy", status: 401, verdict: "path-exists" },
        { family: "modern", status: 404, verdict: "path-gone" },
      ])
    ).toBe(
      "System One on the Zen plane, keyless (nothing dispatches there): `/zen/v1/systemone` (legacy) → path-exists (401); `/inference/v1/systemone` (root) → not sent; `/inference/systemone/v1/systemone` (modern) → path-gone (404)."
    );
    expect(
      systemOneLine([
        { family: "root", status: undefined, verdict: "transport-error" },
      ])
    ).toContain("`/inference/v1/systemone` (root) → transport-error;");
  });

  it("prints one dated variants row per plane and variant, in order, a variant not sent as such", () => {
    const lines = variantTable({
      date: "2026-11-04",
      probes: [
        {
          model: "m-chat",
          plane: "opencode",
          status: 200,
          variant: "baseline",
          verdict: "served",
        },
        {
          model: "m-chat",
          plane: "opencode",
          status: 400,
          variant: "request-id",
          verdict: "path-exists",
        },
        {
          model: undefined,
          plane: "opencode-go",
          status: undefined,
          variant: "reasoning-none",
          verdict: "no-model",
        },
      ],
      run: "a local run",
    }).split("\n");
    expect(lines.slice(0, 4)).toEqual([
      "### Keyed variants · measured 2026-11-04 (UTC) · a local run",
      "",
      VARIANT_HEADER,
      VARIANT_RULE,
    ]);
    expect(lines).toHaveLength(4 + 2 * KEYED_VARIANTS.length);
    expect(lines[4]).toBe(
      "| `opencode` | the probe identity: no `x-opencode-request`, `x-opencode-project: global` | L4, L5 | `m-chat` | served (200) |"
    );
    expect(lines[5]).toBe(
      "| `opencode` | `x-opencode-request: msg_…` | L4 | `m-chat` | path-exists (400) |"
    );
    expect(lines[6]).toBe(
      "| `opencode` | `x-opencode-project: <folder name>` | L5 | — | not sent |"
    );
    // `reasoning-none` is no longer the last variant: the console study's
    // rows follow it.
    expect(
      lines.find((line) =>
        line.startsWith('| `opencode-go` | `reasoning_effort: "none"` |')
      )
    ).toBe(
      '| `opencode-go` | `reasoning_effort: "none"` | L10 | — | no-model |'
    );
    // A keyless row says so in its label.
    expect(
      lines.find((line) => line.startsWith("| `opencode` | a free model"))
    ).toContain("no key");
    expect(
      VARIANT_ROWS.map(([plane, variant]) => `${plane} ${variant.id}`)
    ).toEqual(
      (["opencode", "opencode-go"] as const).flatMap((plane) =>
        KEYED_VARIANTS.map((variant) => `${plane} ${variant.id}`)
      )
    );
  });

  it("prints every keyed 429's Retry-After, absent included, with nothing that could break the line", () => {
    expect(retryAfterLine([])).toBe(
      "`Retry-After` on a keyed 429: no keyed 429 was answered."
    );
    expect(
      retryAfterLine([
        { cell: "opencode-go openai-completions modern", value: "30" },
        { cell: "opencode baseline", value: null },
        {
          cell: "opencode-go request-id",
          value: "Wed, 21 Oct 2026 07:28:00 GMT",
        },
        { cell: "opencode root", value: "1`|<b>\n2" },
      ])
    ).toBe(
      "`Retry-After` on a keyed 429: opencode-go openai-completions modern → `30`; opencode baseline → absent; opencode-go request-id → `Wed, 21 Oct 2026 07:28:00 GMT`; opencode root → `1b2`."
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
    expect(headings).toHaveLength(3);
    expect(headings[0]).toMatch(
      /^### Keyless · (pending the first CI run|measured \d{4}-\d{2}-\d{2} \(UTC\) · .+)$/u
    );
    expect(headings[1]).toMatch(
      /^### Keyed · (pending the first CI run|measured \d{4}-\d{2}-\d{2} \(UTC\) · .+)$/u
    );
    expect(section).toMatch(
      /^Free model on `\/inference\/openai\/v1\/chat\/completions`: .+$/mu
    );
    expect(section).toMatch(
      /^System One on the Zen plane, keyless \(nothing dispatches there\): .+$/mu
    );
    expect(section).toMatch(/^`Retry-After` on a keyed 429: .+$/mu);
  });

  it("holds the keyed variants table in the formatter's columns, labels and row order", () => {
    const doc = readFileSync(
      new URL("../docs/redirect-planes.md", import.meta.url),
      "utf8"
    );
    const lines = doc.slice(doc.indexOf("\n## 13. ")).split("\n");
    const heading = lines.findIndex((line) =>
      line.startsWith("### Keyed variants · ")
    );
    expect(lines[heading]).toMatch(
      /^### Keyed variants · (pending the first CI run|measured \d{4}-\d{2}-\d{2} \(UTC\) · .+)$/u
    );
    expect(cellsOf(lines[heading + 2] ?? "")).toEqual(cellsOf(VARIANT_HEADER));
    expect(lines[heading + 3]).toMatch(/^\|(\s*:?-+:?\s*\|){5}$/u);
    const rows = lines.slice(heading + 4, heading + 4 + VARIANT_ROWS.length);
    expect(rows.map((row) => cellsOf(row).slice(0, 3))).toEqual(
      VARIANT_ROWS.map(([plane, variant]) => [
        `\`${plane}\``,
        variant.label,
        variant.lesson,
      ])
    );
    for (const row of rows) {
      expect(cellsOf(row), row).toHaveLength(5);
    }
  });
});
