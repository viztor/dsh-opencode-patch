/**
 * Which freshness checks a pull request is gated on (`scripts/freshness-scope.ts`),
 * and the CI wiring that acts on the answer.
 *
 * Three layers, each performed rather than asserted as a constant: the decision
 * for each check on the three kinds of diff that matter (a generator change, a
 * refresh, an unrelated change); the import walk over the REAL generator
 * sources, read from disk, with a case whose answer is already known; and the
 * workflow, parsed as data, with every step condition EVALUATED for each event
 * and each scope rather than matched as text.
 *
 * @module test/freshness-scope.test
 */
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

import {
  FRESHNESS_CHECKS,
  type FreshnessCheck,
  GENERATED_OUTPUTS,
  handEditedOutputs,
  handEditWarning,
  importSpecifiers,
  inputsOf,
  isFreshnessCheck,
  parseChangedFiles,
  resolveLocalImport,
  scopeFor,
  type SourceReader,
} from "../scripts/freshness-scope.ts";

const ROOT = join(import.meta.dirname, "..");

/** Every path the disk reader was asked for, so a case can prove it read. */
const diskReader = (): { read: SourceReader; asked: string[] } => {
  const asked: string[] = [];
  const read: SourceReader = (path: string): string | undefined => {
    asked.push(path);
    try {
      return readFileSync(join(ROOT, path), "utf8");
    } catch {
      return undefined;
    }
  };
  return { asked, read };
};

/** A reader over an in-memory tree, so a case can move a generator's imports. */
const treeReader =
  (tree: Readonly<Record<string, string>>): SourceReader =>
  (path) =>
    tree[path];

const CHECKS = Object.keys(FRESHNESS_CHECKS).filter(isFreshnessCheck);

/**
 * The files commit 2ebaffc changed: a refresh of both generated files, plus the
 * tests and docs that follow the vendor's rename. It is the case that turned
 * every open pull request red, so it is the case that must now report.
 */
const REFRESH_ONLY = [
  "README.md",
  "README.zh-CN.md",
  "docs/redirect-planes.md",
  "src/catalog-data.ts",
  "src/go-limits-data.ts",
  "test/attachment-services.test.ts",
  "test/catalog.test.ts",
  "test/go-google-prepare.test.ts",
  "test/go-google.test.ts",
  "test/models-discovery.test.ts",
  "test/responses-routes.test.ts",
  "test/usage-panel.test.tsx",
];

const UNRELATED = ["src/usage-pill.tsx", "test/usage-pill-mount.test.tsx"];

describe("freshness scope · the walk reads the real generators", () => {
  it("finds the catalog parser behind the catalog generator, and proves it read the entry", () => {
    const { asked, read } = diskReader();
    const inputs = inputsOf("catalog:shim", read);
    // Known answers: the generator itself, the parser it calls, and what the
    // parser imports in turn - one level down is what makes it transitive.
    expect(inputs).toContain("scripts/regenerate-catalog-shim.ts");
    expect(inputs).toContain("src/models-catalog.ts");
    expect(inputs).toContain("src/utils/guards.ts");
    // `src/config.ts` is loaded (`DEFAULT_GATEWAY_URLS`), so a settings change
    // gates this check; `src/session-cost.ts` is reached only through
    // `import type`, which loads nothing, so it does not.
    expect(inputs).toContain("src/config.ts");
    expect(importSpecifiers(read("src/models-catalog.ts") ?? "")).not.toContain(
      "./session-cost.ts"
    );
    expect(read("src/models-catalog.ts")).toMatch(
      /^import type \{[^}]*\} from "\.\/session-cost\.ts";$/mu
    );
    expect(inputs).not.toContain("src/session-cost.ts");
    expect(asked).toContain("scripts/regenerate-catalog-shim.ts");
    expect(asked).toContain("src/models-catalog.ts");
  });

  it("finds the limits parser behind the limits generator", () => {
    const { read } = diskReader();
    const inputs = inputsOf("limits:shim", read);
    expect(inputs).toContain("scripts/generate-go-limits.ts");
    expect(inputs).toContain("src/go-limits.ts");
    // The generator's source holds `import type … from "./go-limits.ts"`, but
    // as template text: the line it writes into the file it emits, not an
    // import of the generator. The premise is checked first, so the second
    // assertion has something to miss. (The line is also type-only; the
    // known-tree case below separates template text from that on its own.)
    const source = read("scripts/generate-go-limits.ts") ?? "";
    expect(source).toMatch(
      /^import type \{[^}]*\} from "\.\/go-limits\.ts";$/mu
    );
    expect(importSpecifiers(source)).not.toContain("./go-limits.ts");
  });

  it("counts the pinned version's file as a CLI-version input, though nothing imports it", () => {
    const { read } = diskReader();
    expect(inputsOf("cli:version", read)).toStrictEqual([
      "scripts/check-vendor-version.ts",
      "src/identity.ts",
    ]);
  });

  it("never counts a generated file as an input, though both generators import one", () => {
    const { read } = diskReader();
    // The premise, checked on disk: each generator really does import a
    // generated file, so the exclusion below is doing work.
    expect(
      importSpecifiers(read("scripts/regenerate-catalog-shim.ts") ?? "")
    ).toContain("../src/catalog-data.ts");
    expect(
      importSpecifiers(read("scripts/generate-go-limits.ts") ?? "")
    ).toContain("../src/catalog-data.ts");
    for (const check of CHECKS) {
      const inputs = inputsOf(check, read);
      for (const output of GENERATED_OUTPUTS) {
        expect(inputs, `${check} counts ${output}`).not.toContain(output);
      }
    }
  });

  it("moves the inputs when a generator gains an import", () => {
    const { read } = diskReader();
    const entry = "scripts/generate-go-limits.ts";
    const before = inputsOf("limits:shim", read);
    expect(before).not.toContain("src/utils/guards.ts");
    const grown: SourceReader = (path) =>
      path === entry
        ? `import { isRecord } from "../src/utils/guards.ts";\n${read(path) ?? ""}`
        : read(path);
    expect(inputsOf("limits:shim", grown)).toStrictEqual(
      [...before, "src/utils/guards.ts"].toSorted()
    );
  });

  it("agrees, on every real input, with an independent line-anchored reading of what Node keeps", () => {
    // The walk reads edges with a lexer over Node's own stripped source. The
    // oracle here is a different technique over the same stripped source: a
    // module specifier on a line that STARTS an import or export statement (or
    // closes a multi-line one). Where the two disagree on a local file, one of
    // them is wrong - in either direction: an edge the walk dropped turns a
    // gate into a report, and an edge it invented gates for nothing.
    const { asked, read } = diskReader();
    const inputs = [
      ...new Set(CHECKS.flatMap((check) => inputsOf(check, read))),
    ];
    expect(inputs.length).toBeGreaterThan(5);
    expect(asked).toContain("src/models-catalog.ts");
    const entries = new Set(
      CHECKS.flatMap((check) => FRESHNESS_CHECKS[check].dataInputs)
    );
    const local = (importer: string, specifiers: string[]): string[] =>
      [
        ...new Set(
          specifiers.flatMap((specifier) => {
            const target = resolveLocalImport(importer, specifier, read);
            return target === undefined ? [] : [target];
          })
        ),
      ].toSorted();
    for (const file of inputs.filter((input) => !entries.has(input))) {
      const source = read(file) ?? "";
      const lineAnchored = [
        ...stripTypeScriptTypes(source).matchAll(
          /^\s*(?:(?:import|export)\b|\})[^\n]*?\bfrom\s*["']([^"']+)["']|^\s*import\s*["']([^"']+)["']/gmu
        ),
      ].map((match) => match[1] ?? match[2] ?? "");
      expect(
        local(file, importSpecifiers(source)),
        `${file}: the walk's local edges against the line-anchored reading`
      ).toStrictEqual(local(file, lineAnchored));
    }
  });

  it("refuses a walk that could not read its entry", () => {
    expect(() => inputsOf("catalog:shim", treeReader({}))).toThrow(
      /cannot read scripts\/regenerate-catalog-shim\.ts/u
    );
  });
});

describe("freshness scope · the import walk on a known tree", () => {
  const tree = {
    "scripts/regenerate-catalog-shim.ts": [
      '// import { notReal } from "../src/commented.ts";',
      '/* import "../src/also-commented.ts"; */',
      'import { readFileSync } from "node:fs";',
      'import { a } from "../src/a.ts";',
      'import type { B } from "../src/b";',
      'export type { T } from "../src/types-only.ts";',
      'import { type K } from "../src/kept.ts";',
      'import "../src/side-effect.ts";',
      'const lazy = await import("./lazy.ts");',
      'import { OPENCODE_GO_CATALOG } from "../src/catalog-data.ts";',
      // A string and a regex that each hold `/*`: a comment-stripping pattern
      // took them for a comment's start and swallowed every edge up to the
      // next `*/`. A lexer reads them as what they are.
      'const GLOB = "catalog/*";',
      'export { e } from "../src/after-glob.ts";',
      String.raw`const trim = (url: string): string => url.replace(/\/*$/u, "");`,
      'export { f } from "../src/after-regex.ts";',
      "/** the doc block whose close ended the fake comment */",
      // An import written into a template is text the script emits, not an
      // edge of the script itself.
      'const emitted = `\nimport { g } from "../src/in-template.ts";\n`;',
    ].join("\n"),
    "scripts/lazy.ts": "",
    "src/a.ts": 'export { c } from "./nested/index.ts";\nimport z from "pkg";',
    "src/b.ts": 'import { a } from "./a.ts";',
    "src/catalog-data.ts": 'import { hidden } from "./only-via-output.ts";',
    "src/nested/index.ts": 'import { d } from "../d.tsx";',
    "src/d.tsx": "",
    "src/kept.ts": "",
    "src/types-only.ts": "",
    "src/only-via-output.ts": "",
    "src/side-effect.ts": "",
    "src/after-glob.ts": "",
    "src/after-regex.ts": "",
    "src/in-template.ts": "",
  };

  it("follows every loading import form, transitively, from each importer's own directory", () => {
    // `src/b.ts` and `src/types-only.ts` are reached only by a whole-statement
    // `import type` / `export type`, which loads nothing; `src/kept.ts` is
    // reached by `import { type K }`, which strips to `import {}` and still
    // loads the module. `src/after-glob.ts` and `src/after-regex.ts` follow a
    // `/*` inside a string and a regex; `src/in-template.ts` is named only
    // inside a template, so it is no input. `scripts/lazy.ts` is reached by a
    // dynamic `import()`, which loads it as surely as a static one.
    expect(inputsOf("catalog:shim", treeReader(tree))).toStrictEqual([
      "scripts/lazy.ts",
      "scripts/regenerate-catalog-shim.ts",
      "src/a.ts",
      "src/after-glob.ts",
      "src/after-regex.ts",
      "src/d.tsx",
      "src/kept.ts",
      "src/nested/index.ts",
      "src/side-effect.ts",
    ]);
  });

  it("tells a type-only statement from a type alias and an inline type", () => {
    expect(
      importSpecifiers(
        [
          'import type { A } from "./a.ts";',
          'import type * as N from "./n.ts";',
          'import type D from "./d.ts";',
          'export type * from "./s.ts";',
          // A default import NAMED `type` is a real one.
          'import type from "./t.ts";',
          'import { type K, v } from "./k.ts";',
          // An alias without its semicolon must not swallow the next import.
          "export type Alias = { a: string }",
          'import { c } from "./c.ts";',
        ].join("\n")
      ).toSorted()
    ).toStrictEqual(["./c.ts", "./k.ts", "./t.ts"]);
  });

  it("neither counts a generated file nor walks into it", () => {
    const inputs = inputsOf("catalog:shim", treeReader(tree));
    expect(inputs).not.toContain("src/catalog-data.ts");
    expect(inputs).not.toContain("src/only-via-output.ts");
  });

  it("counts a JSON a generator imports as a leaf input, and does not lex it", () => {
    // Node loads this import under the generators' own flag, so the walk must
    // follow it - and must not hand JSON to the TypeScript stripper, which
    // would throw. `{ "a": "./not-an-edge.ts" }` would be an edge if lexed.
    const jsonTree = {
      "package.json": '{ "version": "1.0.0", "a": "./not-an-edge.ts" }',
      "not-an-edge.ts": "",
      "scripts/check-vendor-version.ts":
        'import pkg from "../package.json" with { type: "json" };',
      "src/identity.ts": "",
    };
    expect(inputsOf("cli:version", treeReader(jsonTree))).toStrictEqual([
      "package.json",
      "scripts/check-vendor-version.ts",
      "src/identity.ts",
    ]);
  });

  it("names the file when a reached module cannot be stripped", () => {
    // An `enum` is what Node's strip mode refuses; the walk fails closed, and
    // the message says where to look.
    const enumTree = {
      "scripts/regenerate-catalog-shim.ts": 'import { E } from "../src/e.ts";',
      "src/e.ts": "export enum E { A }",
    };
    expect(() => inputsOf("catalog:shim", treeReader(enumTree))).toThrow(
      /^src\/e\.ts: /u
    );
  });

  it("resolves only local specifiers that name a file", () => {
    const read = treeReader(tree);
    expect(resolveLocalImport("src/a.ts", "pkg", read)).toBeUndefined();
    expect(resolveLocalImport("src/a.ts", "node:fs", read)).toBeUndefined();
    expect(
      resolveLocalImport("src/a.ts", "./missing.ts", read)
    ).toBeUndefined();
    expect(resolveLocalImport("src/a.ts", "./nested", read)).toBe(
      "src/nested/index.ts"
    );
    expect(resolveLocalImport("src/nested/index.ts", "../d", read)).toBe(
      "src/d.tsx"
    );
  });
});

describe("freshness scope · the decision", () => {
  const { read } = diskReader();
  const inputs = Object.fromEntries(
    CHECKS.map((check) => [check, inputsOf(check, read)])
  ) as Record<FreshnessCheck, string[]>;

  const GENERATOR_CHANGE: Record<FreshnessCheck, string[]> = {
    "catalog:shim": ["src/models-catalog.ts", "src/catalog-data.ts"],
    "cli:version": ["src/identity.ts", "README.md"],
    "limits:shim": ["scripts/generate-go-limits.ts", "src/go-limits-data.ts"],
  };

  for (const check of CHECKS) {
    it(`${check}: a pull request touching its inputs gates`, () => {
      expect(scopeFor(GENERATOR_CHANGE[check], inputs[check])).toBe("gate");
      // The entry alone is enough.
      expect(scopeFor([FRESHNESS_CHECKS[check].entry], inputs[check])).toBe(
        "gate"
      );
    });

    it(`${check}: a pull request carrying only a refresh reports`, () => {
      expect(scopeFor(REFRESH_ONLY, inputs[check])).toBe("report");
    });

    it(`${check}: an unrelated pull request reports, and so does an empty diff`, () => {
      expect(scopeFor(UNRELATED, inputs[check])).toBe("report");
      expect(scopeFor([], inputs[check])).toBe("report");
    });
  }

  it("cli:version: a docs-only diff reports - its copies are gated by the separate offline step", () => {
    // The registry half of cli:version follows the vendor; a stale COPY in a
    // doc is the repository's own, and `cli:version -- --copies` gates every
    // pull request on it (the wiring and the script cases below).
    expect(scopeFor(["docs/deep-dive.md"], inputs["cli:version"])).toBe(
      "report"
    );
  });

  it("gates one check without gating the others", () => {
    const changed = ["src/go-limits.ts"];
    expect(scopeFor(changed, inputs["limits:shim"])).toBe("gate");
    expect(scopeFor(changed, inputs["catalog:shim"])).toBe("report");
    expect(scopeFor(changed, inputs["cli:version"])).toBe("report");
  });

  it("names a generated file changed without its generator, and only then", () => {
    expect(
      handEditedOutputs("catalog:shim", REFRESH_ONLY, inputs["catalog:shim"])
    ).toStrictEqual(["src/catalog-data.ts"]);
    expect(
      handEditedOutputs("limits:shim", REFRESH_ONLY, inputs["limits:shim"])
    ).toStrictEqual(["src/go-limits-data.ts"]);
    // A generator change is expected to carry its output: no warning.
    expect(
      handEditedOutputs(
        "catalog:shim",
        GENERATOR_CHANGE["catalog:shim"],
        inputs["catalog:shim"]
      )
    ).toStrictEqual([]);
    expect(
      handEditedOutputs("cli:version", REFRESH_ONLY, inputs["cli:version"])
    ).toStrictEqual([]);
    expect(
      handEditedOutputs("catalog:shim", UNRELATED, inputs["catalog:shim"])
    ).toStrictEqual([]);
  });

  it("writes the warning as an annotation on the file it names", () => {
    expect(handEditWarning("catalog:shim", "src/catalog-data.ts")).toMatch(
      /^::warning file=src\/catalog-data\.ts::src\/catalog-data\.ts changed.*pnpm run catalog:shim -- --write/u
    );
  });

  it("reads git's changed-file list, one path per line", () => {
    expect(parseChangedFiles("a.ts\r\nb.ts\n\n  c.ts \n")).toStrictEqual([
      "a.ts",
      "b.ts",
      "c.ts",
    ]);
  });
});

/** A GitHub Actions `if:` expression, evaluated over the few names the job uses. */
const evaluate = (
  expression: string,
  names: Readonly<Record<string, string>>
): boolean | string => {
  const tokens =
    expression.match(/'[^']*'|==|!=|&&|\|\||[()!]|[A-Za-z_][\w.-]*/gu) ?? [];
  const consumed = tokens.join("");
  if (consumed !== expression.replaceAll(/\s+/gu, "")) {
    throw new Error(`unparsed text in: ${expression}`);
  }
  let at = 0;
  const truthy = (value: boolean | string): boolean =>
    typeof value === "boolean" ? value : value !== "";
  const primary = (): boolean | string => {
    const token = tokens[at];
    at += 1;
    if (token === "(") {
      const value = or();
      const closing = tokens[at];
      at += 1;
      if (closing !== ")") throw new Error(`unbalanced: ${expression}`);
      return value;
    }
    if (token === "!") return !truthy(primary());
    if (token?.startsWith("'")) return token.slice(1, -1);
    if (token !== undefined && Object.hasOwn(names, token)) {
      return names[token] ?? "";
    }
    throw new Error(`unknown name ${token} in: ${expression}`);
  };
  const comparison = (): boolean | string => {
    const left = primary();
    const op = tokens[at];
    if (op === "==" || op === "!=") {
      at += 1;
      const right = primary();
      return op === "==" ? left === right : left !== right;
    }
    return left;
  };
  const and = (): boolean | string => {
    let value = comparison();
    while (tokens[at] === "&&") {
      at += 1;
      const right = comparison();
      value = truthy(value) && truthy(right);
    }
    return value;
  };
  const or = (): boolean | string => {
    let value = and();
    while (tokens[at] === "||") {
      at += 1;
      const right = and();
      value = truthy(value) || truthy(right);
    }
    return value;
  };
  const result = or();
  if (at !== tokens.length) throw new Error(`trailing tokens: ${expression}`);
  return truthy(result);
};

describe("freshness scope · the CI wiring, parsed", () => {
  interface Step {
    readonly id?: string;
    readonly if?: string;
    readonly name?: string;
    readonly run?: string;
    readonly uses?: string;
    readonly with?: Record<string, unknown>;
  }
  const workflow = parse(
    readFileSync(join(ROOT, ".github", "workflows", "ci.yml"), "utf8")
  ) as { jobs: Record<string, { steps: Step[] }> };
  const steps = workflow.jobs.catalog?.steps ?? [];

  const scopeStep = steps.find((step) => step.id === "scope");
  /** `decide <output key> <check>` lines in the scope step: key -> check. */
  const keys = Object.fromEntries(
    [...(scopeStep?.run ?? "").matchAll(/^\s*decide (\w+) (\S+)\s*$/gmu)].map(
      (match) => [match[2], match[1]]
    )
  ) as Record<string, string | undefined>;

  /**
   * Every step that runs one check in full: minus the nightly `--write`
   * refresh, and minus the CLI version's offline `--copies` gate, which is
   * pinned on its own below.
   */
  const runsOf = (check: FreshnessCheck): Step[] =>
    steps.filter(
      (step) =>
        step.run !== undefined &&
        new RegExp(`pnpm run ${check}(?! -- --(?:write|copies))\\b`, "u").test(
          step.run
        )
    );

  const runs = (
    step: Step,
    event: string,
    outputs: Readonly<Record<string, string>>
  ): boolean =>
    step.if === undefined
      ? true
      : evaluate(step.if, {
          "github.event_name": event,
          ...Object.fromEntries(
            ["catalog", "limits", "cli"].map((key) => [
              `steps.scope.outputs.${key}`,
              outputs[key] ?? "",
            ])
          ),
        }) === true;

  it("read the job: the checkout reaches the base, and the scope step decides each check", () => {
    expect(steps.length).toBeGreaterThan(5);
    const checkout = steps.find((step) =>
      step.uses?.startsWith("actions/checkout@")
    );
    expect(checkout?.with?.["fetch-depth"]).toBe(2);
    expect(scopeStep?.if).toBe("github.event_name == 'pull_request'");
    expect(scopeStep?.run).toContain("git diff --name-only HEAD^1 HEAD");
    expect(scopeStep?.run).toContain("scripts/freshness-scope.ts");
    expect(Object.keys(keys).toSorted()).toStrictEqual([...CHECKS].toSorted());
  });

  /**
   * One step's `run` text, executed the way the runner executes it (`bash -e`,
   * GitHub's default shell, which has no pipefail), in the repository, with a
   * shell function named in `prelude` standing in for a command the step calls.
   */
  const execute = (
    run: string,
    prelude: string,
    env: Readonly<Record<string, string>> = {}
  ): {
    status: number | null;
    stdout: string;
    stderr: string;
    output: string;
    calls: string;
  } => {
    const temp = mkdtempSync(join(tmpdir(), "ci-step-"));
    try {
      const result = spawnSync("bash", ["-e", "-c", `${prelude}\n${run}`], {
        cwd: ROOT,
        encoding: "utf8",
        env: {
          ...process.env,
          ...env,
          CALLS: join(temp, "calls"),
          GITHUB_OUTPUT: join(temp, "github-output"),
          PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ""}`,
          RUNNER_TEMP: temp,
        },
      });
      const readOr = (path: string): string => {
        try {
          return readFileSync(path, "utf8");
        } catch {
          return "";
        }
      };
      return {
        calls: readOr(join(temp, "calls")),
        output: readOr(join(temp, "github-output")),
        status: result.status,
        stderr: result.stderr,
        stdout: result.stdout,
      };
    } finally {
      rmSync(temp, { force: true, recursive: true });
    }
  };

  /** `pnpm` as a function that records its arguments and fails, naming a cause. */
  const FAILING_PNPM =
    'pnpm() { echo "$*" >> "$CALLS"; echo "error: boom" >&2; return 1; }';
  const PASSING_PNPM = 'pnpm() { echo "$*" >> "$CALLS"; return 0; }';

  /** Gate or report, by what the step DOES when the check fails. */
  const classify = (step: Step): "gate" | "report" => {
    const failing = execute(step.run ?? "", FAILING_PNPM);
    if (failing.status !== 0) {
      return "gate";
    }
    expect(failing.stdout, step.name).toMatch(/^::warning::/mu);
    return "report";
  };

  it("runs the scope step's own shell and the CLI it calls: a generator change gates, a refresh reports", () => {
    expect(scopeStep?.run).toBeDefined();
    // `git` as a function: it records what the step asked for and answers the
    // diff from a file, so the real CLI reads a known change list.
    const scopeOf = (changed: readonly string[]) => {
      const diff = join(
        mkdtempSync(join(tmpdir(), "ci-diff-")),
        "changed-files"
      );
      writeFileSync(diff, changed.map((file) => `${file}\n`).join(""));
      try {
        return execute(
          scopeStep?.run ?? "",
          'git() { echo "$*" >> "$CALLS"; cat "$FIXTURE_DIFF"; }',
          { FIXTURE_DIFF: diff }
        );
      } finally {
        rmSync(dirname(diff), { force: true, recursive: true });
      }
    };

    const generator = scopeOf(["scripts/regenerate-catalog-shim.ts"]);
    expect(generator.stderr).toBe("");
    expect(generator.status).toBe(0);
    expect(generator.calls).toBe("diff --name-only HEAD^1 HEAD\n");
    expect(generator.output).toBe("catalog=gate\nlimits=report\ncli=report\n");
    // The output keys are the ones the `decide` lines name, in their order -
    // and those are the keys the `if:` conditions read (the cases below).
    expect(
      [...generator.output.matchAll(/^(\w+)=/gmu)].map((match) => match[1])
    ).toStrictEqual(Object.values(keys));

    const refresh = scopeOf(["src/catalog-data.ts", "src/go-limits-data.ts"]);
    expect(refresh.status).toBe(0);
    expect(refresh.output).toBe("catalog=report\nlimits=report\ncli=report\n");
    expect(refresh.stdout).toContain(
      "::warning file=src/catalog-data.ts::src/catalog-data.ts changed"
    );
    expect(refresh.stdout).toContain(
      "::warning file=src/go-limits-data.ts::src/go-limits-data.ts changed"
    );
    // The CLI's warnings are its own: Node's experimental notice is silenced.
    expect(refresh.stdout).not.toContain("ExperimentalWarning");

    const pin = scopeOf(["src/identity.ts"]);
    expect(pin.output).toBe("catalog=report\nlimits=report\ncli=gate\n");
  });

  it("the CLI refuses an unknown check with a usage line and exit 2", () => {
    const run = spawnSync(
      process.execPath,
      [
        "--experimental-strip-types",
        "--disable-warning=ExperimentalWarning",
        join(ROOT, "scripts", "freshness-scope.ts"),
        "catalog",
      ],
      { cwd: ROOT, encoding: "utf8", input: "src/catalog-data.ts\n" }
    );
    expect(run.status).toBe(2);
    expect(run.stdout).toBe("");
    expect(run.stderr).toMatch(/^usage: freshness-scope\.ts </u);
  });

  it("the CLI answers when invoked by an absolute path through a symlink", () => {
    // Node realpaths the main module's URL but only resolves `argv[1]`; a
    // run-as-script guard comparing the two printed nothing and exited 0.
    const temp = mkdtempSync(join(tmpdir(), "freshness-link-"));
    try {
      const link = join(temp, "scripts");
      symlinkSync(join(ROOT, "scripts"), link, "dir");
      const run = spawnSync(
        process.execPath,
        [
          "--experimental-strip-types",
          "--disable-warning=ExperimentalWarning",
          join(link, "freshness-scope.ts"),
          "catalog:shim",
        ],
        {
          cwd: ROOT,
          encoding: "utf8",
          input: "scripts/regenerate-catalog-shim.ts\n",
        }
      );
      expect(run.stderr).toBe("");
      expect(run.stdout).toBe("gate\n");
      expect(run.status).toBe(0);
    } finally {
      rmSync(temp, { force: true, recursive: true });
    }
  });

  it("the scope step runs before every step that reads its outputs", () => {
    const at = steps.findIndex((step) => step.id === "scope");
    expect(at).toBeGreaterThan(-1);
    const readers = steps
      .map((step, index) => ({ index, step }))
      .filter(({ step }) => step.if?.includes("steps.scope.outputs.") === true);
    expect(readers.length).toBeGreaterThanOrEqual(6);
    for (const { index, step } of readers) {
      expect(index, step.name).toBeGreaterThan(at);
    }
  });

  for (const check of CHECKS) {
    it(`${check}: a pull request runs exactly one of its gate and its report, gating unless the answer is "report"`, () => {
      const key = keys[check] ?? "";
      const candidates = runsOf(check);
      expect(candidates).toHaveLength(2);
      // Performed: each step run with a failing check, and with a passing one.
      const gates = candidates.filter((step) => classify(step) === "gate");
      const reports = candidates.filter((step) => classify(step) === "report");
      expect(gates, `${check} gate steps`).toHaveLength(1);
      expect(reports, `${check} report steps`).toHaveLength(1);
      const [gate] = gates;
      const [report] = reports;
      for (const step of [gate, report]) {
        const passing = execute(step?.run ?? "", PASSING_PNPM);
        expect(passing.status, step?.name).toBe(0);
        expect(passing.stdout, step?.name).not.toMatch(
          /::(?:warning|error)::/u
        );
        expect(passing.calls.split("\n")[0], step?.name).toBe(`run ${check}`);
      }

      // Fail closed: '' is a lost answer (a renamed output, a moved step).
      const other = { catalog: "report", cli: "report", limits: "report" };
      for (const scope of ["", "gate", "report"]) {
        const outputs = { ...other, [key]: scope };
        expect(runs(gate!, "pull_request", outputs), `gate on '${scope}'`).toBe(
          scope !== "report"
        );
        expect(
          runs(report!, "pull_request", outputs),
          `report on '${scope}'`
        ).toBe(scope === "report");
      }
      // The scope step does not run on a push: its outputs are empty there.
      expect(runs(gate!, "push", {})).toBe(false);
      expect(runs(report!, "push", {})).toBe(true);
      // The nightly is unchanged: never gated; it reports the CLI version and
      // regenerates the shims in its own step.
      expect(runs(gate!, "schedule", {})).toBe(false);
      expect(runs(report!, "schedule", {})).toBe(check === "cli:version");
      // A manual dispatch, as the job's comment says: no gate, and only the
      // CLI version reports.
      expect(runs(gate!, "workflow_dispatch", {})).toBe(false);
      expect(runs(report!, "workflow_dispatch", {})).toBe(
        check === "cli:version"
      );
    });
  }

  it("cli:version's offline copy scan gates every pull request, whatever the scope", () => {
    const copies = steps.filter((step) =>
      /pnpm run cli:version -- --copies\b/u.test(step.run ?? "")
    );
    expect(copies).toHaveLength(1);
    const [step] = copies;
    // A gate: its failure fails the step.
    expect(classify(step!)).toBe("gate");
    for (const scope of ["", "gate", "report"]) {
      expect(runs(step!, "pull_request", { cli: scope }), scope).toBe(true);
    }
    // Elsewhere the full check's report step runs the scan too.
    expect(runs(step!, "push", {})).toBe(false);
  });

  it("the CLI report step quotes the script's own cause, and needs its pipefail to", () => {
    const report = runsOf("cli:version").find(
      (step) => classify(step) === "report"
    );
    const run = report?.run ?? "";
    const warned = execute(run, FAILING_PNPM);
    expect(warned.status).toBe(0);
    expect(warned.stdout).toMatch(/^::warning::error: boom$/mu);
    // The control: the same step without its pipefail never warns, because
    // `tee` answers for the pipeline.
    const withoutPipefail = run.replace(/^\s*set -o pipefail\s*$/mu, "");
    expect(withoutPipefail).not.toBe(run);
    const silent = execute(withoutPipefail, FAILING_PNPM);
    expect(silent.status).toBe(0);
    expect(silent.stdout).not.toContain("::warning::");
  });

  it("each check's entry is the script package.json runs for it", () => {
    const { scripts } = JSON.parse(
      readFileSync(join(ROOT, "package.json"), "utf8")
    ) as { scripts: Record<string, string | undefined> };
    for (const check of CHECKS) {
      expect(scripts[check]?.split(/\s+/u), check).toContain(
        FRESHNESS_CHECKS[check].entry
      );
    }
  });

  it("the evaluator answers the cases it is trusted with", () => {
    expect(
      evaluate("a == 'x' && (b == 'y' || !c)", { a: "x", b: "z", c: "" })
    ).toBe(true);
    expect(evaluate("a != 'x'", { a: "x" })).toBe(false);
    expect(() => evaluate("steps.scop.outputs.catalog == 'gate'", {})).toThrow(
      /unknown name/u
    );
  });
});

describe("cli:version · the offline copy scan (`--copies`)", () => {
  const SCRIPT = join(ROOT, "scripts", "check-vendor-version.ts");
  /**
   * Where the pin lives, as freshness-scope counts it: the fixture writes it
   * THERE, so a passing run proves the script reads the very file the scope
   * treats as this check's data input, and moving one without the other fails.
   */
  const PIN_FILE = FRESHNESS_CHECKS["cli:version"].dataInputs[0] ?? "";
  /**
   * A version only the vendor's data says. Built from parts: the real copy
   * scan reads this test file, so a spelled-out CLI literal here would fail
   * the very gate it is testing.
   */
  const VENDOR_ONLY = [9, 9, 9].join(".");

  /**
   * A throwaway tree with a pin, one doc copy, and each generated table
   * carrying a version that disagrees with the pin - vendor data, which the
   * scan must skip - and the script run in it.
   */
  const runIn = (
    pin: string,
    copy: string,
    args: readonly string[]
  ): { status: number | null; stdout: string; stderr: string } => {
    const root = mkdtempSync(join(tmpdir(), "cli-version-"));
    try {
      for (const [path, text] of Object.entries({
        "README.md": "# fixture\n",
        "docs/x.md": `User-Agent: opencode/${copy}\n`,
        [PIN_FILE]: `export const OPENCODE_CLI_VERSION = "${pin}";\n`,
        ...Object.fromEntries(
          GENERATED_OUTPUTS.map((output) => [
            output,
            // Assembled, never spelled: this file is in the real scan's path.
            `export const ROW = { ua: "${["opencode", VENDOR_ONLY].join("/")}", seen: "v${pin.split(".").slice(0, 2).join(".")}.99" };\n`,
          ])
        ),
      })) {
        mkdirSync(dirname(join(root, path)), { recursive: true });
        writeFileSync(join(root, path), text);
      }
      const run = spawnSync(
        process.execPath,
        ["--experimental-strip-types", SCRIPT, ...args],
        { cwd: root, encoding: "utf8" }
      );
      return { status: run.status, stderr: run.stderr, stdout: run.stdout };
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  };

  it("passes on this repository itself, as CI's pull-request gate will run it", () => {
    // Offline, and the same scan CI gates every pull request on: a stale copy
    // anywhere in the tree - this file included - fails here first.
    const run = spawnSync(
      process.execPath,
      ["--experimental-strip-types", SCRIPT, "--copies"],
      { cwd: ROOT, encoding: "utf8" }
    );
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    // A known answer: the tree carries copies, so the scan read something.
    expect(run.stdout).toMatch(/^ok {3}[1-9]\d* copy\/copies /u);
  });

  it("fails on a copy that disagrees with the pin, naming the cause on its first line", () => {
    const run = runIn("0.0.1", "0.0.0", ["--copies"]);
    expect(run.status).toBe(1);
    expect(run.stderr.split("\n")[0]).toBe(
      `error: these copies do not say 0.0.1, which is what ${PIN_FILE} declares:`
    );
    expect(run.stderr).toContain("0.0.0 in docs/x.md");
    // The generated tables' disagreeing versions are not reported as copies.
    for (const output of GENERATED_OUTPUTS) {
      expect(run.stderr).not.toContain(output);
    }
  });

  it("passes when the copies agree, without asking the registry, and skips the generated tables", () => {
    // 0.0.1 was never published, so a registry comparison would fail: the
    // pass proves the scan stopped before it. Both generated tables say a
    // disagreeing CLI literal and a bare `v0.0.99`: the pass proves the scan
    // skipped them, because a vendor move cannot be a stale copy.
    expect(PIN_FILE).not.toBe("");
    const run = runIn("0.0.1", "0.0.1", ["--copies"]);
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    expect(run.stdout).toMatch(
      /^ok {3}1 copy\/copies .*say 0\.0\.1.*registry not asked/u
    );
  });
});
