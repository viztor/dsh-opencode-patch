/**
 * The workflows under `.github/`, read as data: parsed, never matched as text.
 *
 * GitHub Actions cannot run here, so what a workflow DOES is decided by
 * reading it the way the runner does: the YAML parsed, a step's `if:`
 * evaluated for an event and a matrix cell, and a `run:` reduced to the
 * commands it actually invokes. A step whose shell holds logic is run, with
 * the commands it calls stood in for by shell functions (`execute`). Shared by
 * `test/ci-wiring.test.ts`, `test/freshness-scope.test.ts`,
 * `test/node-engine.test.ts` and `test/host-drift.test.ts`, so one reading of
 * a workflow serves every rule that is about one.
 *
 * @module test/support/workflows
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";

import { parse } from "yaml";

const ROOT = join(import.meta.dirname, "..", "..");

/** One step of a job or of a composite action, as parsed. */
export interface Step {
  readonly env?: Readonly<Record<string, unknown>>;
  readonly id?: string;
  readonly if?: string;
  readonly name?: string;
  readonly run?: string;
  readonly shell?: string;
  readonly uses?: string;
  readonly with?: Readonly<Record<string, unknown>>;
}

/** One job, as parsed. */
export interface Job {
  readonly env?: Readonly<Record<string, unknown>>;
  readonly if?: string;
  readonly name?: string;
  readonly permissions?: Readonly<Record<string, string>>;
  readonly steps?: readonly Step[];
  readonly strategy?: {
    readonly matrix?: Readonly<Record<string, unknown>>;
  };
  readonly "timeout-minutes"?: number;
}

/** One workflow, as parsed. */
export interface Workflow {
  readonly concurrency?: Readonly<Record<string, unknown>>;
  readonly env?: Readonly<Record<string, unknown>>;
  readonly jobs: Readonly<Record<string, Job>>;
  readonly on?: Readonly<Record<string, unknown>>;
}

/**
 * A YAML file under the repository root, parsed. Throws on a syntax error,
 * which is the local stand-in for the runner refusing the workflow.
 *
 * @param relativePath - the file, from the repository root.
 * @returns the parsed document.
 */
export const loadYaml = (relativePath: string): unknown =>
  parse(readFileSync(join(ROOT, relativePath), "utf8"));

/** A workflow under `.github/workflows/`, parsed. */
export const loadWorkflow = (name: string): Workflow =>
  loadYaml(join(".github", "workflows", name)) as Workflow;

/**
 * The environment a step runs with, as the runner composes it: the
 * workflow's `env`, then the job's, then the step's own, each later layer
 * winning. One expression, so a rule about a step's environment and that
 * rule's known answer read the same layers.
 *
 * @param workflow - the workflow, for its `env`.
 * @param job - the job, for its `env`.
 * @param step - the step, for its `env`.
 * @returns the composed variables.
 */
export const stepEnv = (
  workflow: Pick<Workflow, "env">,
  job: Pick<Job, "env">,
  step: Pick<Step, "env"> | undefined
): Readonly<Record<string, unknown>> => ({
  ...workflow.env,
  ...job.env,
  ...step?.env,
});

/**
 * Every YAML file under `.github/`, from the repository root, sorted: the
 * workflows, the composite actions and Dependabot's configuration.
 *
 * @returns the relative paths.
 */
export const workflowFiles = (): string[] => {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (/\.ya?ml$/u.test(entry.name)) {
        found.push(relative(ROOT, full));
      }
    }
  };
  walk(join(ROOT, ".github"));
  return found.toSorted();
};

/**
 * A GitHub Actions `if:` expression, evaluated over the few names the job
 * uses: `==`, `!=`, `&&`, `||`, `!`, parentheses, quoted strings and the
 * names given. Anything else throws, so an expression this cannot read is
 * never answered by a guess.
 *
 * @param expression - the condition, without `${{ }}`.
 * @param names - the value of each name it reads.
 * @returns whether the step (or job) runs.
 */
export const evaluateIf = (
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

/**
 * Whether a step runs, given the names its `if:` reads. `always()` is the
 * one status function a step here uses; it reads as a name that is set.
 *
 * @param step - the step.
 * @param names - the event, matrix and step outputs the condition reads.
 * @returns `true` when the step has no condition or its condition holds.
 */
export const stepRuns = (
  step: Step,
  names: Readonly<Record<string, string>>
): boolean =>
  step.if === undefined
    ? true
    : evaluateIf(step.if.replaceAll("always()", "always"), {
        always: "true",
        ...names,
      }) === true;

/**
 * The commands a step's `run:` invokes, one per line, in order.
 *
 * A step that fails prints the very command it ran, so a command NAMED in a
 * workflow is not a command RUN by it: comment lines and `echo` lines are
 * dropped, and a command counts only as the first thing on its line (an
 * `echo "… run 'pnpm run X'"` line never qualifies).
 *
 * @param step - the step; one with no `run:` invokes nothing.
 * @returns the trimmed command lines.
 */
export const runCommands = (step: Pick<Step, "run">): string[] =>
  (step.run ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(
      (line) => line !== "" && !line.startsWith("#") && !/^echo\b/u.test(line)
    );

/**
 * Whether a command line invokes `command`: the line is the command, or the
 * command followed by its arguments. `pnpm run test` is therefore not run by
 * `pnpm run test:coverage`, and `pnpm run test:e2e` not by
 * `pnpm run test:e2e:host`. A pattern is tested against the line instead.
 */
export const invokes = (line: string, command: RegExp | string): boolean =>
  typeof command === "string"
    ? line === command ||
      (line.startsWith(command) && /^[\s;|&]/u.test(line.slice(command.length)))
    : command.test(line);

/**
 * The steps of a job that run `command`, by index.
 *
 * @param job - the job.
 * @param command - a command (matched as {@link invokes} does) or a pattern.
 * @returns each running step with its index in the job.
 */
export const stepsRunning = (
  job: Pick<Job, "steps">,
  command: RegExp | string
): { readonly index: number; readonly step: Step }[] =>
  (job.steps ?? []).flatMap((step, index) =>
    runCommands(step).some((line) => invokes(line, command))
      ? [{ index, step }]
      : []
  );

/** One cell of the `test` job's matrix, with the names its steps' `if:` read. */
export interface MatrixCell {
  readonly channel: string;
  readonly names: Readonly<Record<string, string>>;
  readonly pi: string;
}

/**
 * The `test` job's matrix for one event: every channel crossed with the pi
 * cells the event's expression selects. The `pi` axis is
 * `fromJSON((<condition>) && '<array>' || '<array>')`; the condition is
 * evaluated, never assumed.
 *
 * @param event - `github.event_name`.
 * @param workflow - the parsed `ci.yml` (read from disk when omitted).
 * @returns the cells, channel-major.
 */
export const matrixCells = (
  event: string,
  workflow: Workflow = loadWorkflow("ci.yml")
): MatrixCell[] => {
  const matrix = workflow.jobs.test?.strategy?.matrix ?? {};
  const channels = matrix.channel as readonly string[] | undefined;
  const piExpression = typeof matrix.pi === "string" ? matrix.pi : "";
  const shape =
    /^\$\{\{\s*fromJSON\(\((.+)\) && '(\[[^']*\])' \|\| '(\[[^']*\])'\)\s*\}\}$/u.exec(
      piExpression
    );
  if (channels === undefined || shape === null) {
    throw new Error(`the test job's matrix is not readable: ${piExpression}`);
  }
  const [, condition = "", chosen = "[]", otherwise = "[]"] = shape;
  const pis = JSON.parse(
    evaluateIf(condition, { "github.event_name": event }) === true
      ? chosen
      : otherwise
  ) as string[];
  return channels.flatMap((channel) =>
    pis.map((pi) => ({
      channel,
      names: {
        "github.event_name": event,
        "matrix.channel": channel,
        "matrix.pi": pi,
      },
      pi,
    }))
  );
};

/**
 * The test process's environment without any `GIT_*` variable. A git hook,
 * or `git rebase --exec` in a linked worktree, exports an absolute `GIT_DIR`
 * and `GIT_INDEX_FILE`, which git honours before the working directory: a
 * child that inherited them would commit, branch and configure the
 * repository they name instead of the one it runs in. `GIT_CONFIG_PARAMETERS`
 * goes too, since it carries `-c` settings such as signing.
 */
export const inheritedWithoutGit = (): NodeJS.ProcessEnv =>
  Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))
  );

/**
 * One step's `run` text, executed the way the runner executes it (`bash -e`,
 * GitHub's default shell, which has no pipefail), in the repository, with a
 * shell function named in `prelude` standing in for a command the step calls.
 * It runs in the repository unless `cwd` names another directory, and
 * inherits no `GIT_*` variable (`inheritedWithoutGit`).
 */
export const execute = (
  run: string,
  prelude: string,
  env: Readonly<Record<string, string>> = {},
  cwd: string = ROOT
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
      cwd,
      encoding: "utf8",
      env: {
        ...inheritedWithoutGit(),
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
