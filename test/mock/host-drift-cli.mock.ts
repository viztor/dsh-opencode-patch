/**
 * The nightly host-drift report's CLI (`scripts/report-host-drift.ts`), run
 * as CI runs it against a loopback registry: what it prints, that it asked
 * for every package, and that a refusing registry still exits 0. The rules it
 * prints are `test/host-drift.test.ts`'s. The bump proposal's CLI
 * (`scripts/propose-host-bump.ts`) runs the same way: what it plans for each
 * channel, that a refusing registry or a cut inside pnpm's release-age window
 * is a warning and exit 0, the `--out` files CI's push step reads (with no
 * tracked file touched without `--write`), that a pi move carries a channel
 * waiting on its own cut (`coupleSharedPi`), and, on a scratch copy
 * (`--root`), that a successful `--write` lists exactly the files it changed
 * for the push step to `git add`, and one whose pnpm step fails puts every
 * file back and exits 1. Its rules are `test/host-bump.test.ts`'s.
 *
 * @module test/mock/host-drift-cli.mock
 */
import { execFile } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import semver from "semver";
import { describe, expect, it } from "vitest";

import {
  hostDrift,
  type Packument,
  REGISTRY_PACKAGES,
  type RegistryView,
} from "../../scripts/host-drift.ts";
import {
  ALPHA_NEXT,
  NEXT_ALPHA,
  registryOf,
  withCut,
} from "../support/host-drift-fixture.ts";
import { CHANNELS } from "../support/host-versions.ts";

const ROOT = join(import.meta.dirname, "..", "..");

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
    const { asked, server, url } = await serve(byName(ALPHA_NEXT));
    try {
      const { stdout, stderr } = await report(url);
      expect(stderr).toBe("");
      const warnings = stdout.split("\n").filter((line) => line !== "");
      expect(warnings).toStrictEqual(
        hostDrift(CHANNELS, ALPHA_NEXT).map((line) => `::warning::${line}`)
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

describe("host bump · the proposal's CLI", () => {
  const HOUR = 60 * 60 * 1000;

  /**
   * The view by package name, with `time` on dsh and pi as a full packument
   * has it: every version published `age` ago, or as `ages` says by version.
   */
  const published = (
    view: RegistryView,
    age: number,
    ages: Readonly<Record<string, number>> = {}
  ): Record<string, Packument & { time?: Record<string, string> }> => {
    const at = (version: string) =>
      new Date(Date.now() - (ages[version] ?? age)).toISOString();
    const timed = (packument: Packument) => ({
      ...packument,
      time: Object.fromEntries(
        Object.keys(packument.versions ?? {}).map((version) => [
          version,
          at(version),
        ])
      ),
    });
    return Object.fromEntries(
      Object.entries(REGISTRY_PACKAGES).map(([role, name]) => {
        const packument = view[role as keyof RegistryView];
        return [
          name,
          role === "dsh" || role === "pi" ? timed(packument) : packument,
        ];
      })
    );
  };

  const propose = async (url: string, ...more: string[]) =>
    run(
      process.execPath,
      [
        "--experimental-strip-types",
        "--disable-warning=ExperimentalWarning",
        join(ROOT, "scripts", "propose-host-bump.ts"),
        "--registry",
        url,
        ...more,
      ],
      { cwd: ROOT, env: { ...process.env, DSH_CHANNEL: "" } }
    );

  /** The files a bump may move, from the repository root. */
  const MOVABLE = [
    "test/support/host-versions.ts",
    "package.json",
    "README.md",
    "README.zh-CN.md",
    ...new Set(Object.values(CHANNELS).map((record) => record.lockfile)),
  ];
  const snapshot = (root: string): Map<string, string> =>
    new Map(
      MOVABLE.map((file) => [file, readFileSync(join(root, file), "utf8")])
    );

  /** Alpha's next cut moving dsh alone: no family field, so no floor cells. */
  const DSH_ONLY: RegistryView = (() => {
    const cut = withCut(registryOf(CHANNELS), CHANNELS.alpha, NEXT_ALPHA.dsh);
    return {
      ...cut,
      dsh: {
        ...cut.dsh,
        "dist-tags": {
          alpha: NEXT_ALPHA.dsh,
          [CHANNELS.rc.distTag]: CHANNELS.rc.dsh,
        },
      },
    };
  })();

  /** The next pi patch, which both bridges' `^1.x` range admits. */
  const NEXT_PI = semver.inc(CHANNELS.alpha.pi, "patch") ?? "";
  /**
   * Alpha's next cut published hours ago, and the next pi two days ago:
   * alpha waits on its own cut while rc moves pi.
   */
  const PI_WHILE_ALPHA_WAITS = published(
    {
      ...DSH_ONLY,
      pi: {
        versions: {
          ...DSH_ONLY.pi.versions,
          [NEXT_PI]: {},
        },
      },
    },
    48 * HOUR,
    { [NEXT_ALPHA.dsh]: 3 * HOUR }
  );

  it("moves a channel waiting on its own cut to the pi the other proposes, since both lockfiles hold one pi", async () => {
    expect(NEXT_PI).not.toBe("");
    const { server, url } = await serve(PI_WHILE_ALPHA_WAITS);
    try {
      const { stdout } = await propose(url);
      const lines = stdout.split("\n").filter((line) => line !== "");
      expect(lines.find((line) => line.startsWith("alpha: "))).toMatch(
        new RegExp(
          `^alpha: data: pi ${CHANNELS.alpha.pi} -> ${NEXT_PI}; pi moves with rc`,
          "u"
        )
      );
      expect(lines.find((line) => line.startsWith("rc: "))).toBe(
        `rc: data: pi ${CHANNELS.rc.pi} -> ${NEXT_PI}`
      );
      expect(stdout).not.toContain("::warning::");
    } finally {
      server.close();
    }
  });

  it("a successful --write lists exactly the files it changed, for the push step to add, and the body and target name the records", async () => {
    const temp = mkdtempSync(join(tmpdir(), "host-bump-write-"));
    try {
      // A scratch copy of the files a bump moves, a pnpm that succeeds and a
      // relock script that succeeds, each recording its call.
      const root = join(temp, "root");
      for (const file of MOVABLE) {
        mkdirSync(dirname(join(root, file)), { recursive: true });
        copyFileSync(join(ROOT, file), join(root, file));
      }
      const before = snapshot(root);
      const calls = join(temp, "calls");
      mkdirSync(join(root, "scripts"));
      writeFileSync(
        join(root, "scripts", "use-channel.ts"),
        [
          'import { appendFileSync } from "node:fs";',
          'appendFileSync(process.env.CALLS ?? "", "use-channel " + process.argv.slice(2).join(" ") + "\\n");',
          "",
        ].join("\n")
      );
      const bin = join(temp, "bin");
      mkdirSync(bin);
      writeFileSync(
        join(bin, "pnpm"),
        '#!/bin/sh\necho "pnpm $*" >> "$CALLS"\n'
      );
      chmodSync(join(bin, "pnpm"), 0o755);
      const out = join(temp, "out");
      const { server, url } = await serve(PI_WHILE_ALPHA_WAITS);
      try {
        await run(
          process.execPath,
          [
            "--experimental-strip-types",
            "--disable-warning=ExperimentalWarning",
            join(ROOT, "scripts", "propose-host-bump.ts"),
            "--registry",
            url,
            "--write",
            "--out",
            out,
            "--root",
            root,
          ],
          {
            cwd: ROOT,
            env: {
              ...process.env,
              CALLS: calls,
              DSH_CHANNEL: "",
              PATH: `${bin}:${process.env.PATH ?? ""}`,
            },
          }
        );
      } finally {
        server.close();
      }
      // It ran the installs it promises, pi's update included, in the root.
      expect(readFileSync(calls, "utf8")).toBe(
        [
          "pnpm install --no-frozen-lockfile",
          "pnpm update @earendil-works/pi-ai --no-save",
          "use-channel rc --relock",
          "",
        ].join("\n")
      );
      const after = snapshot(root);
      const changed = MOVABLE.filter(
        (file) => after.get(file) !== before.get(file)
      );
      // Known answer: the records moved, both to the one pi.
      expect(changed).toContain("test/support/host-versions.ts");
      const records = after.get("test/support/host-versions.ts") ?? "";
      expect(records.match(new RegExp(`pi: "${NEXT_PI}",`, "gu"))).toHaveLength(
        2
      );
      // `files` is exactly what changed on disk, one per line.
      expect(readFileSync(join(out, "files"), "utf8")).toBe(
        changed.map((file) => `${file}\n`).join("")
      );
      const body = readFileSync(join(out, "body.md"), "utf8");
      expect(body).toContain("**Files moved:**");
      for (const file of changed) {
        expect(body).toContain(`- \`${file}\``);
      }
      expect(body).not.toContain("Left for review");
      // The target is the body's last line, and names both records.
      const target = readFileSync(join(out, "target"), "utf8").trimEnd();
      expect(body.trimEnd().split("\n").at(-1)).toBe(target);
      expect(target).toContain(`"alpha":{`);
      expect(target).toContain(`"rc":{`);
      expect(readFileSync(join(out, "title"), "utf8")).toBe(
        `build: bump the alpha and rc harness records to pi ${NEXT_PI}\n`
      );
      expect(existsSync(join(out, "dispatch"))).toBe(false);
    } finally {
      rmSync(temp, { force: true, recursive: true });
    }
  });

  it("leaves what CI's push step reads in --out, and touches no tracked file without --write", async () => {
    const before = snapshot(ROOT);
    const temp = mkdtempSync(join(tmpdir(), "host-bump-out-"));
    try {
      for (const [label, view, dispatch] of [
        ["family", ALPHA_NEXT, true],
        ["dsh-only", DSH_ONLY, false],
      ] as const) {
        const out = join(temp, label);
        const { server, url } = await serve(published(view, 48 * HOUR));
        try {
          await propose(url, "--out", out);
        } finally {
          server.close();
        }
        expect(readFileSync(join(out, "title"), "utf8"), label).toMatch(
          /^build: bump the alpha harness record to /u
        );
        expect(readFileSync(join(out, "body.md"), "utf8"), label).toContain(
          NEXT_ALPHA.dsh
        );
        // Nothing was written, so nothing is listed to commit.
        expect(readFileSync(join(out, "files"), "utf8"), label).toBe("");
        expect(existsSync(join(out, "dispatch")), label).toBe(dispatch);
      }
      // Nothing to propose: no title, so the push step never runs.
      const quiet = join(temp, "current");
      const { server, url } = await serve(
        published(registryOf(CHANNELS), 48 * HOUR)
      );
      try {
        await propose(url, "--out", quiet);
      } finally {
        server.close();
      }
      expect(existsSync(join(quiet, "title"))).toBe(false);
    } finally {
      rmSync(temp, { force: true, recursive: true });
    }
    expect(snapshot(ROOT)).toStrictEqual(before);
  });

  it("a --write whose pnpm step fails puts every file back and exits 1, proposing nothing", async () => {
    const temp = mkdtempSync(join(tmpdir(), "host-bump-root-"));
    try {
      // A scratch copy of the files a bump moves, and a pnpm that fails.
      const root = join(temp, "root");
      for (const file of MOVABLE) {
        mkdirSync(dirname(join(root, file)), { recursive: true });
        copyFileSync(join(ROOT, file), join(root, file));
      }
      const before = snapshot(root);
      const bin = join(temp, "bin");
      mkdirSync(bin);
      writeFileSync(
        join(bin, "pnpm"),
        '#!/bin/sh\necho "stub pnpm: $*" >&2\nexit 1\n'
      );
      chmodSync(join(bin, "pnpm"), 0o755);
      const out = join(temp, "out");
      const { server, url } = await serve(published(ALPHA_NEXT, 48 * HOUR));
      const result = await new Promise<{
        code: number | null;
        stderr: string;
        stdout: string;
      }>((resolve) => {
        execFile(
          process.execPath,
          [
            "--experimental-strip-types",
            "--disable-warning=ExperimentalWarning",
            join(ROOT, "scripts", "propose-host-bump.ts"),
            "--registry",
            url,
            "--write",
            "--out",
            out,
            "--root",
            root,
          ],
          {
            cwd: ROOT,
            env: {
              ...process.env,
              DSH_CHANNEL: "",
              PATH: `${bin}:${process.env.PATH ?? ""}`,
            },
          },
          (error, stdout, stderr) => {
            let code: number | null = 0;
            if (error !== null) {
              code = typeof error.code === "number" ? error.code : null;
            }
            resolve({ code, stderr, stdout });
          }
        );
      }).finally(() => {
        server.close();
      });
      expect(result.code, result.stdout).toBe(1);
      // Known answer: it got as far as the pnpm step, having written.
      expect(result.stderr).toContain(
        "stub pnpm: install --no-frozen-lockfile"
      );
      expect(result.stdout).toMatch(
        /^::error::the bump was not proposed: pnpm install --no-frozen-lockfile exited with 1; every tracked file it wrote is put back$/mu
      );
      expect(snapshot(root)).toStrictEqual(before);
      expect(existsSync(join(out, "title"))).toBe(false);
    } finally {
      rmSync(temp, { force: true, recursive: true });
    }
  });

  it("plans the next alpha cut as data and leaves rc current, writing nothing", async () => {
    const { server, url } = await serve(published(ALPHA_NEXT, 48 * HOUR));
    try {
      const { stdout, stderr } = await propose(url);
      expect(stderr).toBe("");
      const lines = stdout.split("\n").filter((line) => line !== "");
      expect(lines.find((line) => line.startsWith("alpha: "))).toMatch(
        new RegExp(
          `^alpha: data: dsh ${CHANNELS.alpha.dsh} -> ${NEXT_ALPHA.dsh}`,
          "u"
        )
      );
      expect(lines).toContain(
        `rc: current (dsh@${CHANNELS.rc.dsh}, pi ${CHANNELS.rc.pi})`
      );
      expect(
        lines.filter((line) => line.startsWith("::warning::"))
      ).toStrictEqual([]);
    } finally {
      server.close();
    }
  });

  it("waits a night for a cut inside pnpm's release-age window", async () => {
    const { server, url } = await serve(published(ALPHA_NEXT, HOUR));
    try {
      const { stdout } = await propose(url);
      expect(stdout).toMatch(/^::warning::alpha: waiting: /mu);
      expect(stdout).not.toMatch(/^alpha: data:/mu);
    } finally {
      server.close();
    }
  });

  it("warns, and still exits 0, when the registry refuses", async () => {
    const { server, url } = await serve(503);
    try {
      const { stdout } = await propose(url);
      expect(stdout).toMatch(
        /^::warning::host bump not proposed: the registry answered 503 for @/u
      );
    } finally {
      server.close();
    }
  });
});
