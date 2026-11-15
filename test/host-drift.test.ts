/**
 * The nightly host-drift report: the rules (`scripts/host-drift.ts`) with
 * known answers, and the workflow step that runs it, parsed. The CLI
 * (`scripts/report-host-drift.ts`) against a loopback registry binds a socket,
 * so it is the mock suite's (`test/mock/host-drift-cli.mock.ts`).
 *
 * @module test/host-drift
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import semver from "semver";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

import {
  type DriftRecord,
  floorOf,
  hostDrift,
  newestIn,
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

const ROOT = join(import.meta.dirname, "..");

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
});
