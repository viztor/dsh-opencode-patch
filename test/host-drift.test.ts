/**
 * The nightly host-drift report: the rules (`scripts/host-drift.ts`) with
 * known answers, and the workflow step that runs it, parsed. The CLI
 * (`scripts/report-host-drift.ts`) against a loopback registry binds a socket,
 * so it is the mock suite's (`test/mock/host-drift-cli.mock.ts`).
 *
 * @module test/host-drift
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import semver from "semver";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

import {
  BUMP_FIELDS,
  type DriftRecord,
  floorOf,
  hostDrift,
  newestIn,
  readChannel,
  REGISTRY_PACKAGES,
  type RegistryView,
} from "../scripts/host-drift.ts";
import {
  ALPHA_NEXT,
  NEXT_ALPHA,
  PATCHED,
  registryOf,
  versions,
  withCut,
} from "./support/host-drift-fixture.ts";
import { type Channel, CHANNELS } from "./support/host-versions.ts";
import {
  execute,
  loadWorkflow,
  type Job as WorkflowJob,
  type Step,
  stepEnv,
} from "./support/workflows.ts";

const ROOT = join(import.meta.dirname, "..");

/**
 * The wholesale approval keys: the allow-all, then the allow-list, its file and
 * the deny-list (which builds every dependency it does not list, an empty one
 * included). The pinned pnpm (12.16.1, measured with a dependency whose
 * install script writes a marker) acts on the allow-all in pnpm-workspace.yaml
 * and on none of the other three anywhere, nor on anything in package.json's
 * `pnpm` field, `.npmrc` or `npm_config_*`; they stay named so a pnpm that
 * reads them again cannot reopen the boundary unseen.
 */
const APPROVING_KEYS = [
  "dangerouslyAllowAllBuilds",
  "neverBuiltDependencies",
  "onlyBuiltDependencies",
  "onlyBuiltDependenciesFile",
] as const;

/**
 * What turns builds on from inside a script the step runs: the allow-all flag,
 * a build setting passed as `--config.`, or a `PNPM_CONFIG_` variable the
 * script sets for the pnpm it spawns.
 */
const APPROVING_IN_SCRIPT =
  /--(?:config\.)?dangerously-allow-all-builds|--config\.(?:allow-builds|permissions|only-built-dependencies|never-built-dependencies)|\bpnpm_config_\w+/iu;

/** An environment variable pnpm reads as a build setting. */
const APPROVING_ENV =
  /^pnpm_config_|^npm_config_(?:dangerously_allow_all_builds|only_built_dependencies|never_built_dependencies)/iu;

/**
 * Every place the plan step's installs could be told to run a dependency's
 * build script. What the pinned pnpm reads, each measured: pnpm-workspace.yaml
 * (an `allowBuilds` entry set to `true`, a `permissions` entry granting
 * `build`, `dangerouslyAllowAllBuilds`), a `PNPM_CONFIG_*` variable in the
 * step's environment (which overrides the workspace's `allowBuilds`), and a
 * CLI flag or `PNPM_CONFIG_` variable in anything the step runs pnpm from
 * (its own shell, the proposer and the rc relock the proposer spawns,
 * `scripts/use-channel.ts`). Then what only older pnpm reads: the rest of
 * {@link APPROVING_KEYS} in the workspace, every approval in package.json's
 * `pnpm` field, and the npmrc and `npm_config_*` spellings.
 *
 * @param sources - each source, already read (absent ones empty).
 * @returns one line per approval found, empty when nothing approves.
 */
const buildApprovals = (sources: {
  readonly env: Readonly<Record<string, unknown>>;
  readonly manifest: Readonly<Record<string, unknown>>;
  readonly npmrc: string;
  readonly scripts: Readonly<Record<string, string>>;
  readonly workspace: Readonly<Record<string, unknown>>;
}): string[] => {
  const found: string[] = [];
  const pnpmField = (sources.manifest.pnpm ?? {}) as Record<string, unknown>;
  for (const [where, config] of [
    ["pnpm-workspace.yaml", sources.workspace],
    ["package.json pnpm", pnpmField],
  ] as const) {
    const allowBuilds = (config.allowBuilds ?? {}) as Record<string, unknown>;
    for (const [name, allowed] of Object.entries(allowBuilds)) {
      if (allowed === true) {
        found.push(`${where} allowBuilds approves ${name}`);
      }
    }
    for (const key of APPROVING_KEYS) {
      if (config[key] !== undefined) {
        found.push(`${where} sets ${key}`);
      }
    }
  }
  const permissions = (sources.workspace.permissions ?? {}) as Record<
    string,
    unknown
  >;
  for (const [name, granted] of Object.entries(permissions)) {
    const build = (granted as { build?: unknown } | null)?.build;
    if (build !== undefined && build !== false) {
      found.push(`pnpm-workspace.yaml permissions grant ${name} build`);
    }
  }
  for (const key of [
    "dangerously-allow-all-builds",
    "never-built-dependencies",
    "only-built-dependencies",
  ]) {
    if (new RegExp(`^\\s*${key}`, "mu").test(sources.npmrc)) {
      found.push(`.npmrc sets ${key}`);
    }
  }
  for (const key of Object.keys(sources.env)) {
    if (APPROVING_ENV.test(key)) {
      found.push(`the step's environment sets ${key}`);
    }
  }
  for (const [script, source] of Object.entries(sources.scripts)) {
    const approval = APPROVING_IN_SCRIPT.exec(source);
    if (approval !== null) {
      found.push(`${script} carries ${approval[0]}`);
    }
  }
  return found;
};

describe("host drift · the rules", () => {
  it("resolves a range as npm does: the newest admitted, a prerelease only on its own tuple", () => {
    const cordis = versions("4.0.5", "4.0.6-alpha.1", "4.0.6-alpha.2", "4.1.0");
    expect(newestIn(cordis, "~4.0.6-alpha.1")).toBe("4.0.6-alpha.2");
    expect(newestIn(cordis, "~4.0.5")).toBe("4.0.5");
    expect(
      newestIn(versions("1.3.0", "1.5.0", "1.6.0-beta.1", "2.0.0"), "^1.3.0")
    ).toBe("1.5.0");
    expect(newestIn(versions("1.0.0"), "^1.3.0")).toBeUndefined();
    expect(floorOf("^1.3.0")).toBe("1.3.0");
    expect(floorOf("~4.0.6-alpha.1")).toBe("4.0.6-alpha.1");
    expect(floorOf("not a range")).toBeUndefined();
  });

  it("reports nothing when the registry is what the records say", () => {
    expect(hostDrift(CHANNELS, registryOf(CHANNELS))).toStrictEqual([]);
  });

  it("names a channel whose dist-tag moved, alone when nothing else did", () => {
    const registry = registryOf(CHANNELS);
    // The next cut, declaring exactly the ranges the record's did.
    const cut = withCut(registry, CHANNELS.alpha, NEXT_ALPHA.dsh);
    const moved: RegistryView = {
      ...cut,
      dsh: {
        ...cut.dsh,
        "dist-tags": {
          alpha: NEXT_ALPHA.dsh,
          [CHANNELS.rc.distTag]: CHANNELS.rc.dsh,
        },
      },
    };
    expect(hostDrift(CHANNELS, moved)).toStrictEqual([
      `alpha: @deepseek-ai/dsh@alpha is ${NEXT_ALPHA.dsh} on the registry; the record says ${CHANNELS.alpha.dsh}`,
    ]);
  });

  it("compares the newest build on the record's line, whichever dist-tag carries it", () => {
    // The rc line publishes under two tags: `next` carries the newest rc build
    // ahead of `latest`, which catches up later. Measured 2026-11-12:
    // `latest` 0.2.2-rc.1, `next` 0.2.2-rc.2, `alpha` 0.2.2-alpha.3.
    const record: DriftRecord = {
      ...CHANNELS.rc,
      distTag: "next",
      dsh: "0.2.2-rc.2",
    };
    const base = withCut(registryOf({ rc: record }), record, "0.2.2-rc.3");
    const tagged = (tags: Record<string, string>): RegistryView => ({
      ...base,
      dsh: { ...base.dsh, "dist-tags": tags },
    });
    // Today: the record's build is the newest on its line.
    expect(
      hostDrift(
        { rc: record },
        tagged({
          alpha: "0.2.2-alpha.3",
          latest: "0.2.2-rc.1",
          next: record.dsh,
        })
      )
    ).toStrictEqual([]);
    // `latest` catches up and `next` is retired: still current, not "no tag".
    expect(
      hostDrift(
        { rc: record },
        tagged({ alpha: "0.2.2-alpha.3", latest: record.dsh })
      )
    ).toStrictEqual([]);
    // A newer rc build under any tag is the drift, named by the tag carrying
    // it; a newer build on another line, or an older one, never is.
    expect(
      hostDrift(
        { rc: record },
        tagged({
          alpha: "0.2.3-alpha.1",
          latest: "0.2.2-rc.3",
          next: record.dsh,
          old: "0.2.1-rc.5",
        })
      )
    ).toStrictEqual([
      "rc: @deepseek-ai/dsh@latest is 0.2.2-rc.3 on the registry; the record says 0.2.2-rc.2",
    ]);
    // The line graduates: a stable release newer than the record, under the
    // tag the record names for that (`graduatesUnder`, `latest` for rc), is
    // the drift too, even while `next` still carries the record's rc.
    const graduated = (tags: Record<string, string>): RegistryView => {
      const view = withCut(base, record, "0.2.2");
      return { ...view, dsh: { ...view.dsh, "dist-tags": tags } };
    };
    expect(
      hostDrift(
        { rc: record },
        graduated({ alpha: "0.2.3-alpha.1", latest: "0.2.2", next: record.dsh })
      )
    ).toStrictEqual([
      "rc: @deepseek-ai/dsh@latest is 0.2.2 on the registry; the record says 0.2.2-rc.2",
    ]);
    // An older stable release is not: the line's build still leads.
    expect(
      hostDrift(
        { rc: record },
        tagged({ alpha: "0.2.2-alpha.3", latest: "0.2.1", next: record.dsh })
      )
    ).toStrictEqual([]);
    // Nothing on the line and no record tag: said, never read as current.
    expect(
      hostDrift({ rc: record }, tagged({ alpha: "0.2.2-alpha.3" }))
    ).toStrictEqual([
      "rc: @deepseek-ai/dsh has no 'next' dist-tag and no build on the rc line; nothing compared",
    ]);
  });

  it("scopes graduation to the record whose line graduates: the alpha record never reads `latest`", () => {
    // `latest` reaches the stable `0.2.2` while `alpha` and `next` have not
    // moved. The rc record graduates under `latest`; the alpha record does
    // not, though semver sorts `0.2.2` above every `0.2.2-alpha.N`.
    // The release the rc record's build leads to (`0.2.2-rc.2` to `0.2.2`).
    const stable = semver.inc(CHANNELS.rc.dsh, "patch") ?? "";
    // The stable cluster declares the newer core's ranges (the rc ones), so
    // reading it for alpha would report every alpha floor as drift.
    const base = withCut(registryOf(CHANNELS), CHANNELS.rc, stable);
    const view = (alpha: string): RegistryView => {
      const cut = withCut(base, CHANNELS.alpha, alpha);
      return {
        ...cut,
        dsh: {
          ...cut.dsh,
          "dist-tags": { alpha, latest: stable, next: CHANNELS.rc.dsh },
        },
      };
    };
    // Known answers for the fixture: the stable release outranks the alpha
    // record and its next cut alike.
    expect(semver.prerelease(stable)).toBeNull();
    expect(semver.gt(stable, CHANNELS.alpha.dsh)).toBe(true);
    expect(semver.gt(stable, NEXT_ALPHA.dsh)).toBe(true);
    expect(CHANNELS.rc.graduatesUnder).toBe("latest");
    expect(CHANNELS.alpha.graduatesUnder).toBeUndefined();
    // Only the rc line graduated: one rc line, nothing for alpha.
    expect(hostDrift(CHANNELS, view(CHANNELS.alpha.dsh))).toStrictEqual([
      `rc: @deepseek-ai/dsh@latest is ${stable} on the registry; the record says ${CHANNELS.rc.dsh}`,
    ]);
    // A real alpha cut on the same tuple is still read under `alpha`, never
    // hidden behind the stable release.
    expect(hostDrift(CHANNELS, view(NEXT_ALPHA.dsh))).toStrictEqual([
      `alpha: @deepseek-ai/dsh@alpha is ${NEXT_ALPHA.dsh} on the registry; the record says ${CHANNELS.alpha.dsh}`,
      `rc: @deepseek-ai/dsh@latest is ${stable} on the registry; the record says ${CHANNELS.rc.dsh}`,
    ]);
    // A stable release under a tag other than the one the line graduates
    // under is not the rc line's either.
    expect(
      hostDrift(
        { rc: CHANNELS.rc },
        {
          ...view(CHANNELS.alpha.dsh),
          dsh: {
            ...view(CHANNELS.alpha.dsh).dsh,
            "dist-tags": {
              alpha: CHANNELS.alpha.dsh,
              next: CHANNELS.rc.dsh,
              stable,
            },
          },
        }
      )
    ).toStrictEqual([]);
  });

  it("holds the family to the floors the cluster declares, not the newest patch inside them", () => {
    // Known answer: a newer patch is published inside the recorded range, and
    // npm would install it (the e2e-host npm cell runs it); the record is the
    // desktop's tree, the floor.
    expect(
      newestIn(
        versions(CHANNELS.alpha.cordis, NEXT_ALPHA.cordis),
        `~${CHANNELS.alpha.cordis}`
      )
    ).toBe(NEXT_ALPHA.cordis);
    expect(hostDrift(CHANNELS, PATCHED)).toStrictEqual([]);
  });

  it("names every family floor a dsh cut moves, read from the package that declares it", () => {
    const lines = hostDrift(CHANNELS, ALPHA_NEXT);
    const say = (name: string, found: string, recorded: string) =>
      `alpha: the floor of ${name} ~${found} is ${found} on the registry; the record says ${recorded}`;
    expect(lines).toStrictEqual([
      `alpha: @deepseek-ai/dsh@alpha is ${NEXT_ALPHA.dsh} on the registry; the record says ${CHANNELS.alpha.dsh}`,
      say("@deepseek-ai/cordis", NEXT_ALPHA.cordis, CHANNELS.alpha.cordis),
      say(
        "@deepseek-ai/cordis-plugin-loader",
        NEXT_ALPHA.loader,
        CHANNELS.alpha.loader
      ),
      say(
        "@deepseek-ai/schemastery",
        NEXT_ALPHA.schemastery,
        CHANNELS.alpha.schemastery
      ),
      say(
        "@deepseek-ai/cordis-plugin-include",
        NEXT_ALPHA.include,
        CHANNELS.alpha.include
      ),
      say(
        "@deepseek-ai/cordis-plugin-timer",
        NEXT_ALPHA.timer,
        CHANNELS.alpha.timer
      ),
      say(
        "@deepseek-ai/cordis-plugin-group",
        NEXT_ALPHA.group,
        CHANNELS.alpha.group
      ),
      // cosmokit is declared by cordis, read at the cordis floor just found.
      say(
        "@deepseek-ai/cosmokit",
        NEXT_ALPHA.cosmokit,
        CHANNELS.alpha.cosmokit
      ),
    ]);
    // Known answer for the fixture itself: the next cut is a newer prerelease
    // on the record's own tuple (`0.2.2-alpha.3` to `0.2.2-alpha.4`).
    expect(semver.gt(NEXT_ALPHA.dsh, CHANNELS.alpha.dsh)).toBe(true);
    expect(semver.prerelease(NEXT_ALPHA.cordis)?.[0]).toBe(
      semver.prerelease(CHANNELS.alpha.cordis)?.[0]
    );
    // The rc channel's records are current in this view, and stay silent.
    expect(lines.filter((line) => line.startsWith("rc:"))).toStrictEqual([]);
  });

  it("checks the timer plugin, which no lockfile holds, against the published dsh", () => {
    const registry = registryOf(CHANNELS);
    const wrong = {
      ...CHANNELS,
      alpha: { ...CHANNELS.alpha, timer: NEXT_ALPHA.timer },
    };
    expect(hostDrift(wrong, registry)).toStrictEqual([
      `alpha: the floor of @deepseek-ai/cordis-plugin-timer ~${CHANNELS.alpha.timer} is ${CHANNELS.alpha.timer} on the registry; the record says ${NEXT_ALPHA.timer}`,
    ]);
  });

  it("reports a moved pi range by the range, its floor and what it resolves", () => {
    const registry = registryOf(CHANNELS);
    const bridge = registry.bridge.versions?.[CHANNELS.rc.dsh];
    const moved: RegistryView = {
      ...registry,
      bridge: {
        versions: {
          ...registry.bridge.versions,
          [CHANNELS.rc.dsh]: {
            ...bridge,
            dependencies: {
              ...bridge?.dependencies,
              [REGISTRY_PACKAGES.pi]: "^1.7.0",
            },
          },
        },
      },
      pi: versions(CHANNELS.rc.pi, "1.7.0", "1.7.2"),
    };
    expect(hostDrift({ rc: CHANNELS.rc }, moved)).toStrictEqual([
      `rc: the bridge's pi range is ^1.7.0 on the registry; the record says ${CHANNELS.rc.piRange}`,
      `rc: the pi range's floor is 1.7.0 on the registry; the record says ${CHANNELS.rc.piFloor}`,
      `rc: the newest pi ^1.7.0 resolves is 1.7.2 on the registry; the record says ${CHANNELS.rc.pi}`,
    ]);
  });

  it("reports a newer pi inside the same range", () => {
    const registry = registryOf(CHANNELS);
    const lines = hostDrift(CHANNELS, {
      ...registry,
      pi: versions(...Object.keys(registry.pi.versions ?? {}), "1.6.1"),
    });
    expect(lines).toHaveLength(2);
    for (const channel of ["alpha", "rc"] as Channel[]) {
      expect(lines).toContain(
        `${channel}: the newest pi ${CHANNELS[channel].piRange} resolves is 1.6.1 on the registry; the record says ${CHANNELS[channel].pi}`
      );
    }
  });

  it("never reads 'nothing answered' as current", () => {
    expect(
      hostDrift(CHANNELS, {
        appBoot: {},
        bridge: {},
        cordis: {},
        dsh: {},
        pi: {},
      })
    ).toStrictEqual([
      `alpha: @deepseek-ai/dsh has no '${CHANNELS.alpha.distTag}' dist-tag and no build on the alpha line; nothing compared`,
      `rc: @deepseek-ai/dsh has no '${CHANNELS.rc.distTag}' dist-tag and no build on the rc line; nothing compared`,
    ]);
    const registry = registryOf(CHANNELS);
    expect(
      hostDrift({ alpha: CHANNELS.alpha }, { ...registry, bridge: {} })
    ).toStrictEqual([
      `alpha: @deepseek-ai/dsh-llm-pi-ai@${CHANNELS.alpha.dsh} is not published; the ranges were not compared`,
    ]);
    const bridge = registry.bridge.versions?.[CHANNELS.rc.dsh];
    expect(
      hostDrift(
        { rc: CHANNELS.rc },
        {
          ...registry,
          bridge: {
            versions: {
              [CHANNELS.rc.dsh]: { ...bridge, dependencies: {} },
            },
          },
        }
      )
    ).toStrictEqual([
      `rc: @deepseek-ai/dsh-llm-pi-ai@${CHANNELS.rc.dsh} declares no @earendil-works/pi-ai`,
      `rc: @deepseek-ai/dsh-llm-pi-ai@${CHANNELS.rc.dsh} declares no @deepseek-ai/schemastery`,
    ]);
    expect(
      hostDrift({ rc: CHANNELS.rc }, { ...registry, cordis: {} })
    ).toStrictEqual([
      `rc: @deepseek-ai/cordis@${CHANNELS.rc.cordis} is not published; @deepseek-ai/cosmokit was not compared`,
    ]);
    expect(
      hostDrift(
        { rc: CHANNELS.rc },
        {
          ...registry,
          dsh: { "dist-tags": registry.dsh["dist-tags"] },
          appBoot: {},
        }
      )
    ).toStrictEqual([
      `rc: @deepseek-ai/dsh@${CHANNELS.rc.dsh} is not published; @deepseek-ai/cordis-plugin-include was not compared`,
      `rc: @deepseek-ai/dsh@${CHANNELS.rc.dsh} is not published; @deepseek-ai/cordis-plugin-timer was not compared`,
      `rc: @deepseek-ai/dsh-app-boot@${CHANNELS.rc.dsh} is not published; @deepseek-ai/cordis-plugin-group was not compared`,
    ]);
  });
});

describe("host drift · one reading per channel", () => {
  // Whether the bump plan agrees with this report is a plan-side cross-check
  // (`test/host-bump.test.ts`, "the plan is current exactly when the report
  // has no line for the channel"), never a copy of `hostDrift` compared with
  // itself.
  it("readChannel reads every bump field exactly once, and nothing is unread on the records' registry", () => {
    const registry = registryOf(CHANNELS);
    for (const record of Object.values(CHANNELS)) {
      const findings = readChannel(record, registry);
      expect(
        findings.filter((finding) => finding.kind === "unread")
      ).toStrictEqual([]);
      expect(
        findings
          .map((finding) => (finding.kind === "value" ? finding.field : ""))
          .toSorted()
      ).toStrictEqual([...BUMP_FIELDS].toSorted());
    }
    expect(BUMP_FIELDS).toHaveLength(12);
    // Known answer: a drifted view is read as values, not as unread.
    const drifted = readChannel(CHANNELS.alpha, ALPHA_NEXT);
    expect(drifted.filter((finding) => finding.kind === "unread")).toHaveLength(
      0
    );
    expect(
      drifted.some(
        (finding) =>
          finding.kind === "value" &&
          finding.field === "dsh" &&
          finding.found === NEXT_ALPHA.dsh
      )
    ).toBe(true);
  });
});

describe("host drift · the CI wiring, parsed", () => {
  interface Job {
    readonly if?: string;
    readonly steps: readonly { readonly run?: string }[];
  }
  const { jobs } = parse(
    readFileSync(join(ROOT, ".github", "workflows", "ci.yml"), "utf8")
  ) as { jobs: Record<string, Job> };

  /** The job's `if`, evaluated: a disjunction of event comparisons only. */
  const runsOn = (job: Job, event: string): boolean => {
    const terms = (job.if ?? "").split("||").map((term) => term.trim());
    return terms.some((term) => {
      const match = /^github\.event_name == '([a-z_]+)'$/u.exec(term);
      if (match === null) {
        throw new Error(`unparsed condition term: ${term}`);
      }
      return match[1] === event;
    });
  };

  it("runs the report nightly and on dispatch, never on a pull request or a push", () => {
    const reporting = Object.entries(jobs).filter(([, job]) =>
      job.steps.some((step) =>
        (step.run ?? "").includes("scripts/report-host-drift.ts")
      )
    );
    expect(reporting.map(([name]) => name)).toStrictEqual(["host-drift"]);
    const [[, job]] = reporting as [[string, Job]];
    expect(runsOn(job, "schedule")).toBe(true);
    expect(runsOn(job, "workflow_dispatch")).toBe(true);
    expect(runsOn(job, "pull_request")).toBe(false);
    expect(runsOn(job, "push")).toBe(false);
  });

  it("the bump is planned with no token in its step's environment, then pushed as the token's owner, and can dispatch the floor cells without keys", () => {
    const workflow = loadWorkflow("ci.yml");
    const job = jobs["host-drift"] as unknown as WorkflowJob;
    const steps = job.steps ?? [];
    const planning = steps.filter((step) =>
      (step.run ?? "").includes("scripts/propose-host-bump.ts")
    );
    expect(planning).toHaveLength(1);
    const [plan] = planning;
    expect(plan?.id).toBe("plan");
    expect(plan?.if).toBe("github.event_name == 'schedule'");
    // The proposer resolves and installs a cut nobody has reviewed: no
    // secret, and no token at all, is in the environment the step runs with,
    // which is the workflow's, then the job's, then its own.
    const tokenIn = (env: Readonly<Record<string, unknown>>): boolean =>
      /secrets\.|token/iu.test(JSON.stringify(env));
    expect(tokenIn(stepEnv(workflow, job, plan))).toBe(false);
    // Known answer, through the same composition: the real job and step with
    // a token set at the job's level is named, so a composition that skipped
    // the job's layer would turn this red.
    const tokenAtJob = {
      ...job,
      env: {
        ...job.env,
        GH_TOKEN: ["$", "{{ secrets.RELEASE_PLEASE_TOKEN }}"].join(""),
      },
    };
    expect(tokenIn(stepEnv(workflow, tokenAtJob, plan))).toBe(true);
    // The step is tokenless only because the install runs none of the cut's
    // code: pnpm runs a dependency's build script only when something
    // approves it, and nothing does in any source buildApprovals reads. The
    // scripts are every one the step runs pnpm from: the proposer's own
    // installs, the rc relock it spawns, and the step's own shell.
    const read = (file: string): string =>
      readFileSync(join(ROOT, file), "utf8");
    const scripts = {
      "scripts/propose-host-bump.ts": read("scripts/propose-host-bump.ts"),
      "scripts/use-channel.ts": read("scripts/use-channel.ts"),
      "the plan step": plan?.run ?? "",
    };
    // Each source was read: the step runs the proposer, the proposer spawns
    // the relock, and the relock runs an install.
    expect(scripts["scripts/propose-host-bump.ts"]).toContain(
      '"scripts/use-channel.ts"'
    );
    expect(scripts["scripts/use-channel.ts"]).toContain('"install"');
    expect(scripts["the plan step"]).toContain("propose-host-bump.ts");
    const npmrc = join(ROOT, ".npmrc");
    const workspace = parse(
      readFileSync(join(ROOT, "pnpm-workspace.yaml"), "utf8")
    ) as Record<string, unknown>;
    expect(workspace.allowBuilds).toBeDefined();
    expect(
      buildApprovals({
        env: stepEnv(workflow, job, plan),
        manifest: JSON.parse(
          readFileSync(join(ROOT, "package.json"), "utf8")
        ) as Record<string, unknown>,
        npmrc: existsSync(npmrc) ? readFileSync(npmrc, "utf8") : "",
        scripts,
        workspace,
      })
    ).toStrictEqual([]);
    // Known answers: every source is named. The approvals the pinned pnpm
    // acts on (an `allowBuilds` entry, a `build` permission, the allow-all,
    // a PNPM_CONFIG_ variable in the environment or set by a script, both CLI
    // spellings, in either script), then
    // the spellings only older pnpm reads (the deny-list, empty included,
    // the allow-list, package.json's field, the npmrc line, npm_config_).
    expect(
      buildApprovals({
        env: {
          NODE_OPTIONS: "--max-old-space-size=4096",
          npm_config_dangerously_allow_all_builds: "true",
          PNPM_CONFIG_DANGEROUSLY_ALLOW_ALL_BUILDS: "true",
        },
        manifest: {
          pnpm: {
            allowBuilds: { esbuild: true },
            onlyBuiltDependencies: ["esbuild"],
          },
        },
        npmrc: "dangerously-allow-all-builds=true\n",
        scripts: {
          "scripts/propose-host-bump.ts":
            'run("pnpm", ["install", "--dangerously-allow-all-builds"]);',
          "scripts/use-channel.ts":
            'pnpm("install", "--config.dangerously-allow-all-builds=true");',
          "the plan step":
            "export PNPM_CONFIG_ALLOW_BUILDS='{\"esbuild\":true}'",
        },
        workspace: {
          allowBuilds: { esbuild: true, protobufjs: false },
          dangerouslyAllowAllBuilds: true,
          neverBuiltDependencies: [],
          permissions: {
            "@google/genai": { build: false },
            esbuild: { build: true },
          },
        },
      })
    ).toStrictEqual([
      "pnpm-workspace.yaml allowBuilds approves esbuild",
      "pnpm-workspace.yaml sets dangerouslyAllowAllBuilds",
      "pnpm-workspace.yaml sets neverBuiltDependencies",
      "package.json pnpm allowBuilds approves esbuild",
      "package.json pnpm sets onlyBuiltDependencies",
      "pnpm-workspace.yaml permissions grant esbuild build",
      ".npmrc sets dangerously-allow-all-builds",
      "the step's environment sets npm_config_dangerously_allow_all_builds",
      "the step's environment sets PNPM_CONFIG_DANGEROUSLY_ALLOW_ALL_BUILDS",
      "scripts/propose-host-bump.ts carries --dangerously-allow-all-builds",
      "scripts/use-channel.ts carries --config.dangerously-allow-all-builds",
      "the plan step carries PNPM_CONFIG_ALLOW_BUILDS",
    ]);
    const pushing = steps.filter((step) =>
      (step.run ?? "").includes("git push")
    );
    expect(pushing).toHaveLength(1);
    const [push] = pushing;
    expect(push?.if).toBe(
      "github.event_name == 'schedule' && steps.plan.outputs.proposed == 'true'"
    );
    const at = (wanted: Step | undefined): number =>
      wanted === undefined ? -1 : steps.indexOf(wanted);
    expect(at(push)).toBeGreaterThan(at(plan));
    expect(at(plan)).toBeGreaterThan(-1);
    expect(push?.run).toContain(
      `x-access-token:\${GH_TOKEN}@github.com/\${GITHUB_REPOSITORY}.git`
    );
    expect(push?.run).not.toContain("propose-host-bump.ts");
    expect(push?.run).toContain(
      "gh workflow run ci.yml --ref chore/host-bump -f keyed=none"
    );
    // The dispatch's `keyed` input exists, and `none` is one of its values.
    const dispatch = loadWorkflow("ci.yml").on?.workflow_dispatch as
      | { inputs?: { keyed?: { default?: string; options?: string[] } } }
      | undefined;
    expect(dispatch?.inputs?.keyed?.options).toStrictEqual(["full", "none"]);
    expect(dispatch?.inputs?.keyed?.default).toBe("full");
    // No credential persisted by the checkout: git would send it ahead of the
    // token the push names, and the proposal's CI would wait for a human.
    const checkout = steps.find((candidate) =>
      (candidate.uses ?? "").startsWith("actions/checkout@")
    );
    expect(checkout?.with?.["persist-credentials"]).toBe(false);
    expect(job.permissions?.actions).toBe("write");
    expect(job.permissions?.contents).toBe("write");
    expect(job.permissions?.["pull-requests"]).toBe("write");
  });
});

describe("host drift · the proposal steps, executed", () => {
  const job = loadWorkflow("ci.yml").jobs["host-drift"];
  const plan = (job?.steps ?? []).find((step) => step.id === "plan");
  const push = (job?.steps ?? []).find((step) =>
    (step.run ?? "").includes("git push")
  );
  /** A literal value of the push step's `env`. */
  const envOf = (key: string): string => {
    const value = push?.env?.[key];
    return typeof value === "string" ? value : "";
  };
  const BOT_EMAIL = envOf("BOT_EMAIL");

  /**
   * Shadows the builtins bash 4 added that a step could reach for, so a step
   * that needs them fails here as it would under macOS's bash 3.2 (the
   * runner's bash is 5, and the suite runs with whatever bash is local). A
   * function, not `enable -n`: defining one works on every bash, while
   * `enable -n` on a name bash 3.2 lacks fails, and under `-e` that would
   * end the prelude before the step ran.
   */
  const BASH_3 = [
    'mapfile() { echo "mapfile: bash 4 only" >&2; return 127; }',
    'readarray() { mapfile "$@"; }',
  ].join("\n");

  it("the bash 3.2 stand-in refuses mapfile and readarray, and the steps' read loop runs under it", () => {
    for (const builtin of ["mapfile", "readarray"]) {
      const refused = execute(`${builtin} -t lines < /dev/null`, BASH_3);
      expect(refused.status, builtin).not.toBe(0);
      expect(refused.stderr, builtin).toContain("bash 4 only");
    }
    // Without the stand-in the refusal is not there, so the refusal above is
    // the stand-in's (on a bash 4 or later the line runs; on 3.2 bash itself
    // refuses it, in its own words).
    const bare = execute("mapfile -t lines < /dev/null", "");
    expect(bare.stderr).not.toContain("bash 4 only");
    const loop = execute(
      [
        "files=()",
        `while IFS= read -r file; do files+=("$file"); done < <(printf 'a b\\nc\\n')`,
        `printf "%s|" "\${files[@]}" >> "$GITHUB_OUTPUT"`,
      ].join("\n"),
      BASH_3
    );
    expect(loop.status, loop.stderr).toBe(0);
    expect(loop.output).toBe("a b|c|");
  });

  /** `node` stands in for the proposer: it writes what `--out` would. */
  const proposer = (
    title: string,
    files: readonly string[],
    dispatch: boolean
  ) =>
    [
      BASH_3,
      'node() { echo "node $*" >> "$CALLS"',
      ...(title === ""
        ? []
        : [
            '  out="$RUNNER_TEMP/host-bump"; mkdir -p "$out"',
            `  printf '%s\\n' ${JSON.stringify(title)} > "$out/title"`,
            `  printf '%s\\n' ${files.map((file) => JSON.stringify(file)).join(" ")} > "$out/files"`,
            ...(dispatch ? ['  echo floor > "$out/dispatch"'] : []),
          ]),
      "}",
      'pnpm() { echo "pnpm $*" >> "$CALLS"; }',
    ].join("\n");

  it("the plan step formats only the sources it wrote, and says whether there is a proposal", () => {
    expect(plan?.run).toBeDefined();
    const none = execute(plan?.run ?? "", proposer("", [], false));
    expect(none.status, none.stderr).toBe(0);
    expect(none.calls).toMatch(
      /^node --experimental-strip-types scripts\/propose-host-bump\.ts --write --out \S+\/host-bump\n$/u
    );
    expect(none.calls).not.toContain("pnpm");
    expect(none.output).toBe("");

    const some = execute(
      plan?.run ?? "",
      proposer(
        "build: bump",
        ["test/support/host-versions.ts", "package.json", "pnpm-lock.yaml"],
        false
      )
    );
    expect(some.status, some.stderr).toBe(0);
    expect(some.calls.split("\n")[1]).toBe(
      "pnpm exec vp fmt --write test/support/host-versions.ts package.json"
    );
    expect(some.output).toBe("proposed=true\n");
  });

  /** The marker line a proposal's body ends with (`bumpTarget`), for `dsh`. */
  const targetOf = (dsh: string): string =>
    `<!-- host-bump-target ${JSON.stringify({ alpha: { dsh } })} -->`;
  const TITLE = "build: bump the alpha harness record to X";
  const TARGET = targetOf("X");
  const OLDER = targetOf("W");

  /** One open pull request from `chore/host-bump`, as the stand-in holds it. */
  interface OpenPr {
    /** Its body's line ends, CRLF as a body edited on the web has them. */
    readonly crlf?: boolean;
    readonly number: number;
    readonly owner: string;
    /** The marker line its body carries. */
    readonly target: string;
    readonly title: string;
  }

  /**
   * The push step's stand-ins, as a prelude: `gh` and `git` as functions.
   * `gh api` stands in for GitHub: its `pulls?` arm holds the open pull
   * requests from `chore/host-bump` in every repository (`prs`) and answers,
   * as the API does, only those whose head owner the query's `head=<owner>:`
   * names, one `<number> <title>` line each (what the step's `--jq` prints),
   * while `gh pr list --head`, which has no owner filter, would answer them
   * all; its `pulls/<number>` arm answers that pull request's body, a line of
   * prose and its marker line (or fails); its `compare` arm answers each
   * commit's author email, and its committer's when the `--jq` asks for it
   * (or fails); `gh pr create` succeeds unless told otherwise.
   */
  const standIn = ({
    apiFails = false,
    bodyFails = false,
    commits = [],
    createFails = false,
    dispatch = true,
    listFails = false,
    prs = [],
    target = TARGET,
    title = TITLE,
  }: {
    readonly apiFails?: boolean;
    readonly bodyFails?: boolean;
    /** Each commit's author and committer email. */
    readonly commits?: readonly (readonly [string, string])[];
    readonly createFails?: boolean;
    readonly dispatch?: boolean;
    readonly listFails?: boolean;
    readonly prs?: readonly OpenPr[];
    /** The night's marker line, as `$out/target` holds it. */
    readonly target?: string;
    readonly title?: string;
  }): string => {
    /** One `case` arm's body: fail, answer nothing, or print each line. */
    const answer = (fails: boolean, lines: readonly string[]): string => {
      if (fails) {
        return "return 1";
      }
      if (lines.length === 0) {
        return "return 0";
      }
      return `printf '%s\\n' ${lines.map((line) => JSON.stringify(line)).join(" ")}`;
    };
    /** The pulls arm: each pull request answered only for its own owner. */
    const pullsArm = listFails
      ? ["      return 1"]
      : [
          '      case "$2" in',
          ...[...new Set(prs.map((pr) => pr.owner))].map(
            (owner) =>
              `        *"head=${owner}:chore/host-bump"*) ${answer(
                false,
                prs
                  .filter((pr) => pr.owner === owner)
                  .map((pr) => `${pr.number} ${pr.title}`)
              )} ;;`
          ),
          "      esac",
        ];
    /** The body arm: each pull request's body, by its number. */
    const bodyArm = [
      '      case "$2" in',
      ...prs.map((pr) => {
        const lines = ["The nightly proposes.", "", pr.target]
          .map((line) => JSON.stringify(line))
          .join(" ");
        const each = pr.crlf === true ? "%s\\r\\n" : "%s\\n";
        return `        */pulls/${pr.number}) ${
          bodyFails ? "return 1" : `printf '${each}' ${lines}`
        } ;;`;
      }),
      "      esac",
    ];
    return [
      BASH_3,
      'out="$RUNNER_TEMP/host-bump"; mkdir -p "$out"',
      `printf '%s\\n' ${JSON.stringify(title)} > "$out/title"`,
      `printf '%s\\n' ${JSON.stringify(target)} > "$out/target"`,
      `printf 'body\\n%s\\n' ${JSON.stringify(target)} > "$out/body.md"`,
      `printf 'test/support/host-versions.ts\\npackage.json\\n' > "$out/files"`,
      ...(dispatch ? ['echo floor > "$out/dispatch"'] : []),
      'git() { echo "git $*" >> "$CALLS"; }',
      "gh() {",
      '  echo "gh $* [token $GH_TOKEN]" >> "$CALLS"',
      '  case "$1 $2" in',
      '    "api repos/owner/repo/pulls?"*)',
      ...pullsArm,
      "      ;;",
      '    "api repos/owner/repo/pulls/"*)',
      ...bodyArm,
      "      ;;",
      // The compare arm prints what the step's `--jq` selects: the
      // committer's email only when the expression names it.
      '    "api repos/owner/repo/compare/"*)',
      '      case "$*" in',
      `        *".commit.committer.email"*) ${answer(apiFails, commits.flat())} ;;`,
      `        *) ${answer(
        apiFails,
        commits.map(([author]) => author)
      )} ;;`,
      "      esac",
      "      ;;",
      // gh's own `pr list --head` has no owner filter: every pull request
      // from a branch of that name, by title.
      `    "pr list") ${answer(
        listFails,
        prs.map((pr) => pr.title)
      )} ;;`,
      `    "pr create") ${createFails ? "return 1" : "return 0"} ;;`,
      "  esac",
      "}",
    ].join("\n");
  };
  const STEP_ENV = {
    BOT_EMAIL,
    BOT_NAME: envOf("BOT_NAME"),
    DISPATCH_TOKEN: "dispatch-token",
    GH_TOKEN: "pat",
    GITHUB_REF_NAME: "main",
    GITHUB_REPOSITORY: "owner/repo",
    GITHUB_REPOSITORY_OWNER: "owner",
  };
  /** The push step, run against `standIn`; `open` is #7 from this repository. */
  const pushWith = (
    options: Parameters<typeof standIn>[0] & {
      /** Shorthand for one pull request, #7, from this repository. */
      readonly open?: Partial<OpenPr>;
    }
  ) =>
    execute(
      push?.run ?? "",
      standIn({
        ...options,
        prs: [
          ...(options.open === undefined
            ? []
            : [
                {
                  number: 7,
                  owner: "owner",
                  target: OLDER,
                  title: "build: bump the alpha harness record to W",
                  ...options.open,
                },
              ]),
          ...(options.prs ?? []),
        ],
      }),
      STEP_ENV
    );

  it("an open proposal with the same target is left alone: no push, no edit, no dispatch", () => {
    for (const crlf of [false, true]) {
      const same = pushWith({ open: { crlf, target: TARGET, title: TITLE } });
      expect(same.status, same.stderr).toBe(0);
      expect(same.stdout, String(crlf)).toContain("left alone");
      // The question asked is this repository's own branch, by owner, and
      // the target is read from the body of the pull request it answered.
      expect(same.calls).toContain(
        "gh api repos/owner/repo/pulls?state=open&head=owner:chore/host-bump"
      );
      expect(same.calls).toContain(
        "gh api repos/owner/repo/pulls/7 --jq .body"
      );
      expect(same.calls).not.toContain("git ");
      expect(same.calls).not.toMatch(/gh (pr create|pr edit|workflow run)/u);
    }
  });

  it("the same title over a different target is a newer target: rebuilt while every commit is the nightly's", () => {
    // A pi that moved after the dsh cut was proposed leaves the title as it
    // was; the marker is what changed.
    const newer = pushWith({
      commits: [[BOT_EMAIL, BOT_EMAIL]],
      open: { target: OLDER, title: TITLE },
    });
    expect(newer.status, newer.stderr).toBe(0);
    expect(newer.stdout).not.toContain("left alone");
    expect(newer.calls).toContain("git push --force");
    expect(newer.calls).toContain("gh pr edit 7 --title");
    // A different title over the same target is the same target.
    const retitled = pushWith({
      open: { target: TARGET, title: "build: a reviewer's title" },
    });
    expect(retitled.status, retitled.stderr).toBe(0);
    expect(retitled.stdout).toContain("left alone");
    expect(retitled.calls).not.toContain("git ");
  });

  it("with none open it pushes, opens the pull request and dispatches the floor cells with the keyed tier off", () => {
    const fresh = pushWith({});
    expect(fresh.status, fresh.stderr).toBe(0);
    const calls = fresh.calls.split("\n");
    expect(calls).toContain("git checkout -B chore/host-bump");
    // Each file is its own argument, read back from the list.
    expect(calls).toContain(
      "git add -- test/support/host-versions.ts package.json"
    );
    expect(calls).toContain(
      "git push --force https://x-access-token:pat@github.com/owner/repo.git chore/host-bump"
    );
    expect(fresh.calls).toContain("gh pr create --head chore/host-bump");
    expect(fresh.calls).not.toContain("gh pr edit");
    expect(calls).toContain(
      "gh workflow run ci.yml --ref chore/host-bump -f keyed=none [token dispatch-token]"
    );
    // No dispatch file, no dispatch.
    const quiet = pushWith({ dispatch: false });
    expect(quiet.status, quiet.stderr).toBe(0);
    expect(quiet.calls).not.toContain("gh workflow run");
    // A pull request that cannot be opened fails the run by name.
    const refused = pushWith({ createFails: true });
    expect(refused.status).toBe(1);
    expect(refused.stdout).toContain(
      "::error::could not open the bump pull request"
    );
  });

  it("a fork's pull request from a branch of the same name is not the proposal", () => {
    const forkOnly: readonly OpenPr[] = [
      { number: 9, owner: "someone", target: TARGET, title: TITLE },
    ];
    // Known answer first: the stand-in answers the fork's pull request to a
    // query that names the fork's owner, so the case below can only pass by
    // the step's own filter.
    const asked = execute(
      'gh api "repos/owner/repo/pulls?state=open&head=someone:chore/host-bump" --jq x',
      standIn({ prs: forkOnly }),
      STEP_ENV
    );
    expect(asked.status, asked.stderr).toBe(0);
    expect(asked.stdout).toBe(`9 ${TITLE}\n`);
    // Its target equals the night's: read as the proposal, it would suppress
    // the bump. It is not read, so the proposal is opened.
    const sameTarget = pushWith({ prs: forkOnly });
    expect(sameTarget.status, sameTarget.stderr).toBe(0);
    expect(sameTarget.stdout).not.toContain("left alone");
    expect(sameTarget.calls).not.toContain("pulls/9");
    expect(sameTarget.calls).not.toContain("compare/");
    expect(sameTarget.calls).toContain("gh pr create --head chore/host-bump");
    // Beside the repository's own pull request it changes nothing: the own
    // one is compared, rebuilt and edited by its number.
    const beside = pushWith({
      commits: [[BOT_EMAIL, BOT_EMAIL]],
      open: {},
      prs: [{ number: 9, owner: "someone", target: OLDER, title: TITLE }],
    });
    expect(beside.status, beside.stderr).toBe(0);
    expect(beside.calls).toContain("git push --force");
    expect(beside.calls).toContain("gh pr edit 7 --title");
    expect(beside.calls).not.toContain("gh pr edit 9");
  });

  it("a newer target rebuilds an open proposal only while every commit on it is the nightly's own, as author and as committer", () => {
    const ours = pushWith({
      commits: [[BOT_EMAIL, BOT_EMAIL]],
      open: {},
    });
    expect(ours.status, ours.stderr).toBe(0);
    expect(ours.calls).toContain(
      "gh api repos/owner/repo/compare/main...chore/host-bump"
    );
    expect(ours.calls).toContain("git push --force");
    expect(ours.calls).toContain("gh pr edit 7 --title");
    expect(ours.calls).not.toContain("gh pr create");

    for (const [label, commits] of [
      // A reviewer's own commit on the branch.
      [
        "authored",
        [
          [BOT_EMAIL, BOT_EMAIL],
          ["reviewer@example.com", "reviewer@example.com"],
        ],
      ],
      // A reviewer's amend, rebase or fixup squash of the nightly's commit:
      // the bot stays the author, the reviewer is the committer.
      ["amended", [[BOT_EMAIL, "reviewer@example.com"]]],
    ] as const) {
      const reviewed = pushWith({ commits, open: {} });
      expect(reviewed.status, label + reviewed.stderr).toBe(0);
      expect(reviewed.stdout, label).toMatch(
        /^::warning::the open bump pull request carries commits the nightly did not make/mu
      );
      expect(reviewed.calls, label).not.toContain("git ");
      expect(reviewed.calls, label).not.toMatch(
        /gh (pr create|pr edit|workflow run)/u
      );
    }
    // Known answer: the bot address the step compares with is the one it
    // commits as.
    expect(BOT_EMAIL).toMatch(
      /github-actions\[bot\]@users\.noreply\.github\.com$/u
    );
  });

  it("a question gh could not answer pushes nothing", () => {
    for (const failing of [
      pushWith({ listFails: true }),
      pushWith({ bodyFails: true, open: {} }),
      pushWith({ apiFails: true, open: {} }),
      // Two of this repository's own: which one is the proposal is unknown.
      pushWith({
        open: {},
        prs: [
          { number: 8, owner: "owner", target: OLDER, title: "build: another" },
        ],
      }),
    ]) {
      expect(failing.status).toBe(1);
      expect(failing.stdout).toMatch(/^::error::/mu);
      expect(failing.calls).not.toContain("git ");
    }
  });
});
