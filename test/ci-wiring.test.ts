/**
 * The CI and release workflows, held to the rules a run depends on.
 *
 * Actions cannot run here, so every rule reads the workflows PARSED
 * (`test/support/workflows.ts`): a step's `if:` is evaluated for the event and
 * the matrix cell, and a `run:` counts only the commands it invokes. Most
 * rules are functions shown to bite on an inline fixture whose answer is
 * known before they are trusted with the real files: one install path for
 * every job, a build before anything that reads `lib/`, a pnpm version no
 * comment contradicts, Dependabot over every action directory, the catalog
 * job's fork rule and every job bounded. The setup action's Node choice is
 * executed. The rest are pins on the real files, with no fixture: one unit
 * run per install (evaluated for every event the workflow runs on), the
 * type-check (the check job's command, and the tsx tests in the program
 * `tsc` reads), and the release and nightly wiring `scripts/check.ts` used to
 * hold.
 *
 * @module test/ci-wiring.test
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  execute,
  type Job,
  loadWorkflow,
  loadYaml,
  matrixCells,
  runCommands,
  type Step,
  stepRuns,
  stepsRunning,
  type Workflow,
  workflowFiles,
} from "./support/workflows.ts";

const ROOT = join(import.meta.dirname, "..");
const SETUP = "./.github/actions/setup";

const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
  devDependencies: Record<string, string | undefined>;
  packageManager: string;
  scripts: Record<string, string | undefined>;
};

const ci = loadWorkflow("ci.yml");
const release = loadWorkflow("release.yml");
const WORKFLOWS = { "ci.yml": ci, "release.yml": release } as const;

/** Every job of the given workflows, labelled `<file>: <job>`. */
const jobsOf = (
  workflows: Readonly<Record<string, Workflow>>
): [string, Job][] =>
  Object.entries(workflows).flatMap(([file, workflow]) =>
    Object.entries(workflow.jobs).map(
      ([name, job]) => [`${file}: ${name}`, job] as [string, Job]
    )
  );

/** A step that runs the repository's toolchain: it needs the install. */
const needsInstall = (step: Step): boolean =>
  runCommands(step).some(
    (line) =>
      line.startsWith("pnpm ") ||
      line.startsWith("node --experimental-strip-types")
  );

/**
 * Where a job installs by hand, or runs the toolchain without the one setup
 * action after its own checkout. One message per finding.
 */
const installProblems = (
  workflows: Readonly<Record<string, Workflow>>
): string[] =>
  jobsOf(workflows).flatMap(([label, job]) => {
    const steps = job.steps ?? [];
    const problems: string[] = [];
    for (const step of steps) {
      if (
        step.uses?.startsWith("pnpm/action-setup@") === true ||
        step.uses?.startsWith("actions/setup-node@") === true
      ) {
        problems.push(`${label} sets up ${step.uses.split("@")[0]} itself`);
      }
      if (runCommands(step).some((line) => line.includes("pnpm install"))) {
        problems.push(`${label} runs pnpm install itself`);
      }
    }
    const first = steps.findIndex(needsInstall);
    if (first === -1) {
      return problems;
    }
    const checkout = steps.findIndex(
      (step) => step.uses?.startsWith("actions/checkout@") === true
    );
    const setup = steps.findIndex((step) => step.uses === SETUP);
    if (setup === -1) {
      problems.push(`${label} runs the toolchain without ${SETUP}`);
    } else if (checkout === -1 || setup < checkout) {
      problems.push(`${label} uses ${SETUP} before its own checkout`);
    } else if (setup > first) {
      problems.push(`${label} runs the toolchain before ${SETUP}`);
    }
    return problems;
  });

/** The jobs that run the toolchain, labelled as {@link jobsOf} does. */
const installingJobs = (
  workflows: Readonly<Record<string, Workflow>>
): string[] =>
  jobsOf(workflows)
    .filter(([, job]) => (job.steps ?? []).some(needsInstall))
    .map(([label]) => label);

/** The commands that read `lib/`: the unit suite, the binary e2e, the gate. */
const LIB_READERS: readonly (RegExp | string)[] = [
  "pnpm run test",
  "pnpm run test:coverage",
  "pnpm run test:shuffle",
  "pnpm run test:e2e:host",
  /\bscripts\/check\.ts\b/u,
];

/** Each step that reads `lib/` with no `pnpm run build` before it in its job. */
const unbuiltReaders = (
  workflows: Readonly<Record<string, Workflow>>
): string[] =>
  jobsOf(workflows).flatMap(([label, job]) => {
    const builds = stepsRunning(job, "pnpm run build").map(
      ({ index }) => index
    );
    const built = builds.length === 0 ? Infinity : Math.min(...builds);
    return LIB_READERS.flatMap((command) =>
      stepsRunning(job, command)
        .filter(({ index }) => index < built)
        .map(({ step }) => `${label}: ${runCommands(step).join("; ")}`)
    );
  });

/** Every job without `timeout-minutes`, which would burn GitHub's six hours. */
const unboundedJobs = (
  workflows: Readonly<Record<string, Workflow>>
): string[] =>
  jobsOf(workflows)
    .filter(([, job]) => typeof job["timeout-minutes"] !== "number")
    .map(([label]) => label);

/** A pnpm version a `#` comment line names that `packageManager` does not pin. */
const stalePnpmComments = (
  files: Readonly<Record<string, string>>,
  pinned: string
): string[] =>
  Object.entries(files).flatMap(([file, text]) =>
    text
      .split("\n")
      .map((line) => line.trim())
      .filter(
        (line) => line.startsWith("#") && /pnpm|packageManager/u.test(line)
      )
      .flatMap((line) =>
        [...line.matchAll(/\b\d+\.\d+\.\d+\b/gu)]
          .map((match) => match[0])
          .filter((version) => version !== pinned)
          .map((version) => `${file}: ${version} in "${line}"`)
      )
  );

describe("ci wiring · every file parses", () => {
  it("every YAML file under .github parses, and the setup action is a composite whose run steps name a shell", () => {
    const files = workflowFiles();
    // Known answers: the two workflows this file is about are among them.
    expect(files).toContain(".github/workflows/ci.yml");
    expect(files).toContain(".github/workflows/release.yml");
    for (const file of files) {
      expect(() => loadYaml(file), file).not.toThrow();
    }
    const action = loadYaml(".github/actions/setup/action.yml") as {
      runs: { steps: Step[]; using: string };
    };
    expect(action.runs.using).toBe("composite");
    const { steps } = action.runs;
    for (const step of steps.filter((s) => s.run !== undefined)) {
      expect(step.shell, step.name ?? step.run).toBe("bash");
    }
    const uses = (prefix: string): number =>
      steps.filter((step) => step.uses?.startsWith(prefix) === true).length;
    expect(uses("pnpm/action-setup@")).toBe(1);
    expect(uses("actions/setup-node@")).toBe(1);
    expect(
      steps
        .flatMap((step) => runCommands(step))
        .filter((line) => line === "pnpm install --frozen-lockfile")
    ).toHaveLength(1);
    // A local action is read from the workspace the job checked out, so it
    // cannot bring the checkout itself.
    expect(uses("actions/checkout@")).toBe(0);

    // In order: `cache: pnpm` needs pnpm on the PATH before setup-node runs,
    // and setup-node takes the version the `node` step chose.
    const at = (match: (step: Step) => boolean): number =>
      steps.findIndex(match);
    const order = [
      at((step) => step.uses?.startsWith("pnpm/action-setup@") === true),
      at((step) => step.id === "node"),
      at((step) => step.uses?.startsWith("actions/setup-node@") === true),
      at((step) =>
        runCommands(step).includes("pnpm install --frozen-lockfile")
      ),
    ];
    expect(order.every((index) => index !== -1)).toBe(true);
    expect(order).toStrictEqual(order.toSorted((a, b) => a - b));
    const setupNode = steps.find(
      (step) => step.uses?.startsWith("actions/setup-node@") === true
    );
    expect(setupNode?.with?.["node-version"]).toBe(
      ["$", "{{ steps.node.outputs.version }}"].join("")
    );
    expect(setupNode?.with?.cache).toBe("pnpm");
  });

  it("the setup action's node step picks .node-version, or the input when one is given", () => {
    const action = loadYaml(".github/actions/setup/action.yml") as {
      runs: { steps: Step[] };
    };
    const node = action.runs.steps.find((step) => step.id === "node");
    expect(node?.env?.NODE_VERSION_INPUT).toBe(
      ["$", "{{ inputs.node-version }}"].join("")
    );
    const pinned = readFileSync(join(ROOT, ".node-version"), "utf8").trim();
    // Known answer: the file names a version, and it is not the override.
    expect(pinned).toMatch(/^\d+/u);
    expect(pinned).not.toBe("24");
    for (const [input, expected] of [
      ["", pinned],
      ["24", "24"],
    ] as const) {
      const ran = execute(node?.run ?? "", "", { NODE_VERSION_INPUT: input });
      expect(ran.status, ran.stderr).toBe(0);
      expect(ran.output, input).toBe(`version=${expected}\n`);
    }
  });
});

describe("ci wiring · one setup", () => {
  it("every job that installs does it through the one setup action, after its own checkout", () => {
    // The rule bites: a job that sets Node up itself is named.
    const fixture: Workflow = {
      jobs: {
        bad: {
          steps: [
            { uses: "actions/checkout@0" },
            { uses: "actions/setup-node@0" },
            { run: "pnpm install --frozen-lockfile" },
            { run: "pnpm run test" },
          ],
        },
        good: {
          steps: [
            { uses: "actions/checkout@0" },
            { uses: SETUP },
            { run: "pnpm run test" },
          ],
        },
        early: {
          steps: [
            { uses: SETUP },
            { uses: "actions/checkout@0" },
            { run: "pnpm run test" },
          ],
        },
      },
    };
    expect(installProblems({ "x.yml": fixture })).toStrictEqual([
      "x.yml: bad sets up actions/setup-node itself",
      "x.yml: bad runs pnpm install itself",
      `x.yml: bad runs the toolchain without ${SETUP}`,
      `x.yml: early uses ${SETUP} before its own checkout`,
    ]);

    expect(installProblems(WORKFLOWS)).toStrictEqual([]);
    expect(installingJobs(WORKFLOWS)).toStrictEqual([
      "ci.yml: check",
      "ci.yml: test",
      "ci.yml: host-drift",
      "ci.yml: engine-floor",
      "ci.yml: catalog",
      "ci.yml: e2e",
      "ci.yml: e2e-host",
      "release.yml: verify",
      "release.yml: publish",
    ]);
  });
});

describe("ci wiring · one unit run per install", () => {
  /** The steps of the `test` job that run in one cell. */
  const running = (names: Readonly<Record<string, string>>): Step[] =>
    (ci.jobs.test?.steps ?? []).filter((step) => stepRuns(step, names));
  const count = (steps: readonly Step[], command: string): number =>
    stepsRunning({ steps }, command).length;

  it("each install runs the unit suite once: the default install in the required check job with the coverage ratchet, every other cell in the matrix", () => {
    const events = Object.keys(ci.on ?? {});
    // Known answer: the four events the workflow runs on.
    expect(events.toSorted()).toStrictEqual([
      "pull_request",
      "push",
      "schedule",
      "workflow_dispatch",
    ]);
    const check = ci.jobs.check ?? {};
    // A job-level `if:` would skip the run as a success on some event.
    expect(check.if).toBeUndefined();
    // The default install's run: the check job, which sets no DSH_CHANNEL and
    // switches nothing, so host-versions holds the root (alpha) install.
    expect(check.env?.DSH_CHANNEL).toBeUndefined();
    expect(stepsRunning(check, /\bscripts\/use-channel\.ts\b/u)).toStrictEqual(
      []
    );
    expect(stepsRunning(check, "pnpm run test:coverage")).toHaveLength(1);
    expect(stepsRunning(check, "pnpm run test")).toStrictEqual([]);
    expect(
      (check.steps ?? []).filter((step) => step.with?.name === "coverage")
    ).toHaveLength(1);
    for (const event of events) {
      const cells = matrixCells(event);
      // Known answers: both channels on every event, the floor cells nightly
      // and on dispatch.
      const floors = event === "schedule" || event === "workflow_dispatch";
      expect(cells.length, event).toBe(floors ? 4 : 2);
      for (const cell of cells) {
        const label = `${event} ${cell.channel}·${cell.pi}`;
        const steps = running(cell.names);
        const isDefault = cell.channel === "alpha" && cell.pi === "newest";
        expect(count(steps, "pnpm run test:coverage"), label).toBe(0);
        expect(count(steps, "pnpm run test"), label).toBe(isDefault ? 0 : 1);
        expect(count(steps, "pnpm run test:mock"), label).toBe(1);
        expect(
          steps.filter((step) => step.with?.name === "coverage").length,
          label
        ).toBe(0);
      }
    }
    for (const [name, job] of Object.entries(ci.jobs)) {
      if (name === "test" || name === "check") continue;
      expect(stepsRunning(job, "pnpm run test"), name).toStrictEqual([]);
      expect(stepsRunning(job, "pnpm run test:coverage"), name).toStrictEqual(
        []
      );
    }
  });
});

describe("ci wiring · the build before lib/", () => {
  it("a step that reads lib/ comes after an explicit build in its own job", () => {
    const fixture: Workflow = {
      jobs: {
        late: {
          steps: [{ run: "pnpm run test" }, { run: "pnpm run build" }],
        },
        none: {
          steps: [{ run: "node --experimental-strip-types scripts/check.ts" }],
        },
        ok: {
          steps: [{ run: "pnpm run build" }, { run: "pnpm run test:shuffle" }],
        },
      },
    };
    expect(unbuiltReaders({ "x.yml": fixture })).toStrictEqual([
      "x.yml: late: pnpm run test",
      "x.yml: none: node --experimental-strip-types scripts/check.ts",
    ]);
    expect(unbuiltReaders(WORKFLOWS)).toStrictEqual([]);
  });
});

describe("ci wiring · the type-check", () => {
  it("CI type-checks through the check job's `pnpm run check`, over a program that holds the tsx tests", () => {
    // CI runs no `typecheck` script: `vp check` type-checks, while the lint
    // config's `typeCheck` is on (test/toolchain.test.ts holds that).
    expect(stepsRunning(ci.jobs.check ?? {}, "pnpm run check")).toHaveLength(1);
    expect(pkg.scripts.check).toBe("vp check");
    // The program tsc reads, listed: the tsx tests are in it, not just in an
    // include array.
    const listed = spawnSync(
      process.execPath,
      [
        join(ROOT, "node_modules", "typescript", "bin", "tsc"),
        "--listFilesOnly",
        "-p",
        join(ROOT, "tsconfig.json"),
      ],
      { cwd: ROOT, encoding: "utf8" }
    );
    expect(listed.status, listed.stderr).toBe(0);
    const files = listed.stdout.split("\n");
    for (const file of [
      "test/usage-panel.test.tsx",
      "test/ci-wiring.test.ts",
    ]) {
      expect(
        files.some((line) => line.endsWith(`/${file}`)),
        file
      ).toBe(true);
    }
  });
});

describe("ci wiring · comments that name a version", () => {
  it("no comment under .github names a pnpm version package.json does not pin", () => {
    const pinned = pkg.packageManager.replace(/^pnpm@/u, "");
    // Known answer: the pin is a version, so the comparison has a side.
    expect(pinned).toMatch(/^\d+\.\d+\.\d+$/u);
    expect(
      stalePnpmComments(
        { "x.yml": "  # package.json pins pnpm 1.0.0 exactly\n  # pi 1.3.0\n" },
        pinned
      )
    ).toStrictEqual([
      'x.yml: 1.0.0 in "# package.json pins pnpm 1.0.0 exactly"',
    ]);
    const files = Object.fromEntries(
      workflowFiles().map((file) => [
        file,
        readFileSync(join(ROOT, file), "utf8"),
      ])
    );
    expect(stalePnpmComments(files, pinned)).toStrictEqual([]);
  });
});

/** Dependabot's configuration, the slice the rule reads. */
interface DependabotConfig {
  readonly updates: readonly {
    readonly directories?: readonly string[];
    readonly directory?: string;
    readonly "package-ecosystem": string;
  }[];
}

/** Each directory that pins an action (`/` and every composite) Dependabot does not watch. */
const unwatchedActionDirs = (
  config: DependabotConfig,
  files: readonly string[]
): string[] => {
  const actions = config.updates.find(
    (update) => update["package-ecosystem"] === "github-actions"
  );
  const watched = new Set([
    ...(actions?.directories ?? []),
    ...(actions?.directory === undefined ? [] : [actions.directory]),
  ]);
  const actionDirs = files
    .filter((file) => /^\.github\/actions\/.+\/action\.ya?ml$/u.test(file))
    .map((file) => `/${dirname(file)}`);
  return ["/", ...actionDirs].filter((dir) => !watched.has(dir));
};

describe("ci wiring · dependabot", () => {
  it("dependabot watches every directory that pins an action", () => {
    // The rule bites: a config that watches only the root misses the action.
    expect(
      unwatchedActionDirs(
        {
          updates: [{ directory: "/", "package-ecosystem": "github-actions" }],
        },
        [".github/actions/setup/action.yml", ".github/workflows/ci.yml"]
      )
    ).toStrictEqual(["/.github/actions/setup"]);

    const config = loadYaml(".github/dependabot.yml") as DependabotConfig;
    // Known answer: the setup action is among the files the rule reads.
    expect(workflowFiles()).toContain(".github/actions/setup/action.yml");
    expect(unwatchedActionDirs(config, workflowFiles())).toStrictEqual([]);
    expect(
      config.updates.some((update) => update["package-ecosystem"] === "npm")
    ).toBe(true);
  });
});

/**
 * What keeps the catalog job from running on a fork's pull request, or lets
 * a step other than the nightly one write. One message per finding.
 */
const catalogForkProblems = (job: Job | undefined): string[] => {
  if (job === undefined) {
    return ["no catalog job"];
  }
  const problems: string[] = [];
  if ((job.if ?? "").includes("head.repo")) {
    problems.push(`the job's if reads the head repository: ${job.if ?? ""}`);
  }
  for (const step of job.steps ?? []) {
    if ((step.if ?? "").includes("head.repo")) {
      problems.push(`${step.name ?? "a step"} reads the head repository`);
    }
    const writes =
      runCommands(step).some((line) => line.includes("git push")) ||
      Object.values(step.env ?? {}).some((value) =>
        String(value).includes("secrets.")
      );
    if (writes && step.if !== "github.event_name == 'schedule'") {
      problems.push(`${step.name ?? "a step"} can write outside the nightly`);
    }
  }
  return problems;
};

describe("ci wiring · the catalog job", () => {
  it("the catalog job runs for a fork, and only its nightly step can write", () => {
    // The rule bites: the fork condition this job once carried, and a
    // writing step that is not the nightly one.
    expect(
      catalogForkProblems({
        if: "github.event.pull_request.head.repo.full_name == github.repository",
        steps: [
          {
            env: { GH_TOKEN: "secrets.X" },
            name: "push",
            run: "git push origin x",
          },
        ],
      })
    ).toStrictEqual([
      "the job's if reads the head repository: github.event.pull_request.head.repo.full_name == github.repository",
      "push can write outside the nightly",
    ]);
    expect(catalogForkProblems(ci.jobs.catalog)).toStrictEqual([]);
    // Known answer: the nightly step is a writer, so the rule had one to read.
    expect(
      (ci.jobs.catalog?.steps ?? []).some(
        (step) =>
          step.if === "github.event_name == 'schedule'" &&
          runCommands(step).some((line) => line.includes("git push"))
      )
    ).toBe(true);
  });
});

describe("ci wiring · the required check", () => {
  it("the job with the name main's branch protection requires gates the unit suite and the ratchet", () => {
    // Renaming it leaves the required check unreported, and every merge
    // waits on a check that never comes.
    const required = Object.entries(ci.jobs).filter(
      ([, job]) => job.name === "check · test · build · gate"
    );
    expect(required.map(([name]) => name)).toStrictEqual(["check"]);
    // The required job is the only gate a merge waits on, so it is the one
    // that runs the unit suite with the coverage ratchet, unconditionally:
    // a run that lived only in the matrix could fail and still merge.
    const [, job] = required[0] ?? ["", {}];
    const runs = stepsRunning(job, "pnpm run test:coverage");
    expect(runs).toHaveLength(1);
    // Neither the step nor the job is conditional: GitHub reports a job its
    // `if:` skipped as a success, which a required check does not block on.
    expect(runs[0]?.step.if).toBeUndefined();
    expect((job as Job).if).toBeUndefined();
    for (const command of ["pnpm run check", "pnpm run build"]) {
      expect(stepsRunning(job, command), command).toHaveLength(1);
    }
    expect(stepsRunning(job, /\bscripts\/check\.ts\b/u)).toHaveLength(1);
  });
});

describe("ci wiring · the release and CI wiring check.ts used to hold (moved)", () => {
  const releaseText = readFileSync(
    join(ROOT, ".github", "workflows", "release.yml"),
    "utf8"
  );
  const ciText = readFileSync(
    join(ROOT, ".github", "workflows", "ci.yml"),
    "utf8"
  );
  const allRuns = (workflow: Workflow): string[] =>
    Object.values(workflow.jobs).flatMap((job) =>
      (job.steps ?? []).flatMap((step) => runCommands(step))
    );
  const ciRuns = (command: string): boolean =>
    Object.values(ci.jobs).some((job) => stepsRunning(job, command).length > 0);

  it("a version tag fires the release, and only the release", () => {
    const releasePush = release.on?.push as { tags?: string[] } | undefined;
    const ciPush = ci.on?.push as { "tags-ignore"?: string[] } | undefined;
    expect(releasePush?.tags).toContain("v*.*.*");
    expect(ciPush?.["tags-ignore"]).toContain("v*.*.*");
  });

  it("the publish authenticates by OIDC, skips a published version, and records what it packed", () => {
    expect(release.jobs.publish?.permissions?.["id-token"]).toBe("write");
    expect(
      (release.jobs.publish?.steps ?? []).some((step) =>
        /npm view .* version 2>\/dev\/null/u.test(step.run ?? "")
      )
    ).toBe(true);
    // Queued per tag, never cancelled: a re-run is how a release recovers.
    expect(release.concurrency?.["cancel-in-progress"]).toBe(false);
    expect(allRuns(release).some((line) => line.startsWith("npm pack"))).toBe(
      true
    );
    expect(
      allRuns(release).some((line) => line.startsWith("shasum -a 256"))
    ).toBe(true);
    expect(releaseText).toContain("scripts/publish-scoped.ts");
  });

  it("every job in every workflow is bounded", () => {
    expect(
      unboundedJobs({
        "x.yml": { jobs: { a: { "timeout-minutes": 5 }, b: {} } },
      })
    ).toStrictEqual(["x.yml: b"]);
    const every = Object.fromEntries(
      workflowFiles()
        .filter((file) => file.startsWith(".github/workflows/"))
        .map((file) => [
          file.slice(".github/workflows/".length),
          loadWorkflow(file.slice(".github/workflows/".length)),
        ])
    );
    // Known answer: the three workflows, release-please's among them.
    expect(Object.keys(every)).toStrictEqual([
      "ci.yml",
      "release-please.yml",
      "release.yml",
    ]);
    expect(jobsOf(every).length).toBeGreaterThan(5);
    expect(unboundedJobs(every)).toStrictEqual([]);
  });

  it("CI runs the generators, the live suite and the coverage ratchet, as commands", () => {
    // A command NAMED in a step is not a command RUN by it: the failure
    // message of a step quotes the command it ran.
    expect(
      runCommands({
        run: `echo "run 'pnpm run catalog:shim'"\n# pnpm run catalog:shim`,
      })
    ).toStrictEqual([]);
    expect(
      stepsRunning(
        { steps: [{ run: `echo "run 'pnpm run catalog:shim'"` }] },
        "pnpm run catalog:shim"
      )
    ).toStrictEqual([]);
    for (const command of [
      "pnpm run catalog:shim",
      "pnpm run limits:shim",
      "pnpm run test:e2e",
      "pnpm run test:coverage",
    ]) {
      expect(ciRuns(command), command).toBe(true);
    }
    expect(pkg.scripts["catalog:shim"]).toContain(
      "scripts/regenerate-catalog-shim.ts"
    );
    expect(pkg.scripts["limits:shim"]).toContain(
      "scripts/generate-go-limits.ts"
    );
    expect(existsSync(join(ROOT, "scripts/regenerate-catalog-shim.ts"))).toBe(
      true
    );
    expect(existsSync(join(ROOT, "scripts/generate-go-limits.ts"))).toBe(true);
  });

  it("the nightly refresh pushes as the token's owner", () => {
    const refresh = (ci.jobs.catalog?.steps ?? []).find(
      (step) => step.name === "propose the refresh (nightly only)"
    );
    expect(refresh?.run).toContain(
      `x-access-token:\${GH_TOKEN}@github.com/\${GITHUB_REPOSITORY}.git`
    );
    expect(ciText).toContain("x-access-token:");
  });

  it("the coverage ratchet is anchored and its provider installed", () => {
    const viteConfig = readFileSync(join(ROOT, "vite.config.ts"), "utf8");
    // Anchored: `_thresholds:` must not read as present.
    expect(/^\s*thresholds\s*:/mu.test("  _thresholds: {")).toBe(false);
    expect(/^\s*thresholds\s*:/mu.test(viteConfig)).toBe(true);
    expect(typeof pkg.devDependencies["@vitest/coverage-v8"]).toBe("string");
    expect(typeof pkg.scripts["test:coverage"]).toBe("string");
  });

  it("the unit run stays offline, and the live suite has its own config", () => {
    const viteConfig = readFileSync(join(ROOT, "vite.config.ts"), "utf8");
    const unitInclude = /include:\s*\[([^\]]*)\]/u.exec(viteConfig)?.[1];
    expect(unitInclude).toBeDefined();
    expect(unitInclude).not.toContain("e2e");
    expect(pkg.scripts["test:e2e"]).toContain("vitest.e2e.config.ts");
    expect(existsSync(join(ROOT, "vitest.e2e.config.ts"))).toBe(true);
  });
});
