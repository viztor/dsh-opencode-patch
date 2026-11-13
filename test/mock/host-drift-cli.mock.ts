/**
 * The nightly host-drift report's CLI (`scripts/report-host-drift.ts`), run
 * as CI runs it against a loopback registry: what it prints, that it asked
 * for every package, and that a refusing registry still exits 0. The rules it
 * prints are `test/host-drift.test.ts`'s.
 *
 * @module test/mock/host-drift-cli.mock
 */
import { execFile } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  hostDrift,
  type Packument,
  REGISTRY_PACKAGES,
  type RegistryView,
} from "../../scripts/host-drift.ts";
import { ALPHA_NEXT, registryOf } from "../support/host-drift-fixture.ts";
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
