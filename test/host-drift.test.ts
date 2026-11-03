/**
 * The nightly host-drift report: the rules (`scripts/host-drift.ts`) with
 * known answers, the CLI (`scripts/report-host-drift.ts`) run against a
 * loopback registry, and the workflow step that runs it, parsed.
 *
 * @module test/host-drift
 */
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

import {
  type DriftRecord,
  floorOf,
  hostDrift,
  newestIn,
  type Packument,
  REGISTRY_PACKAGES,
  type RegistryView,
} from "../scripts/host-drift.ts";
import { type Channel, CHANNELS } from "./support/host-versions.ts";

const ROOT = join(import.meta.dirname, "..");

/** Run a command to completion without blocking the loopback server. */
const run = async (
  file: string,
  args: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv }
): Promise<{ stderr: string; stdout: string }> =>
  new Promise((resolve, reject) => {
    execFile(file, args, options, (error, stdout, stderr) => {
      if (error === null) {
        resolve({ stderr, stdout });
      } else {
        reject(new Error(`${error.message}\n${stderr}`));
      }
    });
  });

const versions = (...list: string[]): Packument => ({
  versions: Object.fromEntries(list.map((version) => [version, {}])),
});

/**
 * The registry exactly as the records describe it: each channel's dsh under
 * its dist-tag, a bridge at that version declaring the record's ranges, and
 * every recorded version published.
 */
const registryOf = (
  records: Readonly<Record<string, DriftRecord>>
): RegistryView => {
  const all = Object.values(records);
  return {
    bridge: {
      versions: Object.fromEntries(
        all.map((record) => [
          record.dsh,
          {
            dependencies: {
              [REGISTRY_PACKAGES.pi]: record.piRange,
              [REGISTRY_PACKAGES.schemastery]: `~${record.schemastery}`,
            },
            peerDependencies: {
              [REGISTRY_PACKAGES.cordis]: `~${record.cordis}`,
              [REGISTRY_PACKAGES.loader]: `~${record.loader}`,
            },
          },
        ])
      ),
    },
    cordis: versions(...all.map((record) => record.cordis)),
    dsh: {
      "dist-tags": Object.fromEntries(
        all.map((record) => [record.distTag, record.dsh])
      ),
    },
    loader: versions(...all.map((record) => record.loader)),
    pi: versions(
      ...all.flatMap((record) => [record.pi, record.piFloor]),
      // Never the newest 1.x: a prerelease and the next major.
      "1.99.0-beta.1",
      "2.0.0"
    ),
    schemastery: versions(...all.map((record) => record.schemastery)),
  };
};

/** Today's alpha cut: dsh moved, the cluster's ranges with it. */
const ALPHA_3: RegistryView = (() => {
  const base = registryOf(CHANNELS);
  return {
    ...base,
    bridge: {
      versions: {
        ...base.bridge.versions,
        "0.2.2-alpha.3": {
          dependencies: {
            [REGISTRY_PACKAGES.pi]: CHANNELS.alpha.piRange,
            [REGISTRY_PACKAGES.schemastery]: "~3.18.6-alpha.2",
          },
          peerDependencies: {
            [REGISTRY_PACKAGES.cordis]: "~4.0.6-alpha.2",
            [REGISTRY_PACKAGES.loader]: "~1.0.7-alpha.2",
          },
        },
      },
    },
    cordis: versions(CHANNELS.rc.cordis, "4.0.6-alpha.1", "4.0.6-alpha.2"),
    dsh: {
      "dist-tags": { alpha: "0.2.2-alpha.3", latest: CHANNELS.rc.dsh },
    },
    loader: versions(CHANNELS.rc.loader, "1.0.7-alpha.1", "1.0.7-alpha.2"),
    schemastery: versions(
      CHANNELS.rc.schemastery,
      "3.18.6-alpha.1",
      "3.18.6-alpha.2"
    ),
  };
})();

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
    const moved: RegistryView = {
      ...registry,
      bridge: {
        versions: {
          ...registry.bridge.versions,
          "0.2.2-alpha.3": registry.bridge.versions?.[CHANNELS.alpha.dsh] ?? {},
        },
      },
      dsh: { "dist-tags": { alpha: "0.2.2-alpha.3", latest: CHANNELS.rc.dsh } },
    };
    expect(hostDrift(CHANNELS, moved)).toStrictEqual([
      `alpha: @deepseek-ai/dsh@alpha is 0.2.2-alpha.3 on the registry; the record says ${CHANNELS.alpha.dsh}`,
    ]);
  });

  it("follows the cluster's ranges, not the packages' own tags: today's alpha cut", () => {
    const lines = hostDrift(CHANNELS, ALPHA_3);
    expect(lines).toHaveLength(4);
    expect(lines[0]).toMatch(
      /^alpha: @deepseek-ai\/dsh@alpha is 0\.2\.2-alpha\.3/u
    );
    expect(lines).toContain(
      `alpha: @deepseek-ai/cordis (~4.0.6-alpha.2) is 4.0.6-alpha.2 on the registry; the record says ${CHANNELS.alpha.cordis}`
    );
    expect(lines).toContain(
      `alpha: @deepseek-ai/cordis-plugin-loader (~1.0.7-alpha.2) is 1.0.7-alpha.2 on the registry; the record says ${CHANNELS.alpha.loader}`
    );
    expect(lines).toContain(
      `alpha: @deepseek-ai/schemastery (~3.18.6-alpha.2) is 3.18.6-alpha.2 on the registry; the record says ${CHANNELS.alpha.schemastery}`
    );
    // The rc channel's records are current in this view, and stay silent.
    expect(lines.filter((line) => line.startsWith("rc:"))).toStrictEqual([]);
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
        bridge: {},
        cordis: {},
        dsh: {},
        loader: {},
        pi: {},
        schemastery: {},
      })
    ).toStrictEqual([
      "alpha: @deepseek-ai/dsh has no 'alpha' dist-tag; nothing compared",
      "rc: @deepseek-ai/dsh has no 'latest' dist-tag; nothing compared",
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
      `rc: no published @deepseek-ai/cordis satisfies ~${CHANNELS.rc.cordis}`,
    ]);
  });
});

/** A loopback registry serving `packuments` by name, recording each request. */
const serve = async (
  packuments: Readonly<Record<string, Packument>> | number
): Promise<{ asked: string[]; server: Server; url: string }> => {
  const asked: string[] = [];
  const server = createServer((request, response) => {
    const name = decodeURIComponent((request.url ?? "").slice(1));
    asked.push(name);
    const body = typeof packuments === "number" ? undefined : packuments[name];
    if (body === undefined) {
      response.writeHead(typeof packuments === "number" ? packuments : 404);
      response.end();
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address() as AddressInfo;
  return { asked, server, url: `http://127.0.0.1:${port}` };
};

const report = async (url: string) =>
  run(
    process.execPath,
    [
      "--experimental-strip-types",
      "--disable-warning=ExperimentalWarning",
      join(ROOT, "scripts", "report-host-drift.ts"),
      "--registry",
      url,
    ],
    { cwd: ROOT, env: { ...process.env, DSH_CHANNEL: "" } }
  );

describe("host drift · the CLI", () => {
  const byName = (view: RegistryView): Record<string, Packument> =>
    Object.fromEntries(
      Object.entries(REGISTRY_PACKAGES).map(([role, name]) => [
        name,
        view[role as keyof RegistryView],
      ])
    );

  it("prints one warning per drift and exits 0, having asked for every package", async () => {
    const { asked, server, url } = await serve(byName(ALPHA_3));
    try {
      const { stdout, stderr } = await report(url);
      expect(stderr).toBe("");
      const warnings = stdout.split("\n").filter((line) => line !== "");
      expect(warnings).toStrictEqual(
        hostDrift(CHANNELS, ALPHA_3).map((line) => `::warning::${line}`)
      );
      expect(warnings.length).toBeGreaterThan(0);
      expect(asked.toSorted()).toStrictEqual(
        Object.values(REGISTRY_PACKAGES).toSorted()
      );
    } finally {
      server.close();
    }
  });

  it("says current when nothing moved", async () => {
    const { server, url } = await serve(byName(registryOf(CHANNELS)));
    try {
      const { stdout } = await report(url);
      expect(stdout).toBe(
        `current: alpha dsh@${CHANNELS.alpha.dsh}, pi ${CHANNELS.alpha.pi}; rc dsh@${CHANNELS.rc.dsh}, pi ${CHANNELS.rc.pi}\n`
      );
    } finally {
      server.close();
    }
  });

  it("warns, and still exits 0, when the registry refuses", async () => {
    const { server, url } = await serve(503);
    try {
      const { stdout } = await report(url);
      expect(stdout).toMatch(
        /^::warning::host drift not checked: the registry answered 503 for @/u
      );
    } finally {
      server.close();
    }
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
