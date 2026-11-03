/**
 * Switch the dev install between the harness channels the plugin supports.
 *
 *     node --experimental-strip-types scripts/use-channel.ts <rc|alpha> [--floor | --relock]
 *
 * - `<channel>` installs that channel's committed lockfile with
 *   `--frozen-lockfile`: the channel's `@deepseek-ai` cluster and pi UNPATCHED
 *   at the newest version the bridge's range admits, which is what an npm
 *   user of the channel runs. `alpha` is the root lockfile; `rc` is
 *   `channels/rc/pnpm-lock.yaml`.
 * - `--floor` installs the same cluster with every pi held to the range's
 *   floor (the harness's own pin, which the desktop app ships), unpatched.
 *   Never committed.
 * - `--relock` regenerates the channel's committed lockfile from the root one,
 *   so only the host packages move (`rc` only: the root lockfile is alpha's,
 *   and `pnpm install` regenerates it).
 *
 * Every tracked file the switch rewrites (`package.json`,
 * `pnpm-workspace.yaml`, `pnpm-lock.yaml`) is restored when it ends, whatever
 * happened, so a switch leaves no diff. What the tree holds is recorded in
 * `node_modules/.dsh-channel.json` with a hash of pnpm's own installed-lockfile
 * copy, which `test/support/host-versions.ts` reads to know which record to
 * check, and ignores once a plain `pnpm install` has replaced that install.
 *
 * @module scripts/use-channel
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  CHANNELS,
  DEFAULT_CHANNEL,
  installedLockHash,
  isChannel,
  MARKER,
  type Marker,
} from "../test/support/host-versions.ts";
import {
  channelManifest,
  withoutHostPackages,
  workspaceWithPi,
} from "./channel-manifest.ts";

const ROOT = join(import.meta.dirname, "..");
const TRACKED = ["package.json", "pnpm-workspace.yaml", "pnpm-lock.yaml"];
const USAGE =
  "usage: node --experimental-strip-types scripts/use-channel.ts <rc|alpha> [--floor | --relock]";

function fail(message: string): never {
  console.error(`error: ${message}\n${USAGE}`);
  process.exit(2);
}

const args = process.argv.slice(2);
const [channel, ...flags] = args;
if (!isChannel(channel)) {
  fail(`name a channel: ${Object.keys(CHANNELS).join(" or ")}`);
}
const unknown = flags.filter(
  (flag) => flag !== "--floor" && flag !== "--relock"
);
if (unknown.length > 0) {
  fail(`unknown option ${unknown.join(" ")}`);
}
const floor = flags.includes("--floor");
const relock = flags.includes("--relock");
if (floor && relock) {
  fail("--floor is never committed, so it cannot --relock");
}
if (relock && channel === DEFAULT_CHANNEL) {
  fail(
    `the root lockfile is ${DEFAULT_CHANNEL}'s; \`pnpm install\` regenerates it`
  );
}

const record = CHANNELS[channel];
const path = (file: string): string => join(ROOT, file);
const saved = new Map(TRACKED.map((file) => [file, readFileSync(path(file))]));

const pnpm = (...argv: string[]): void => {
  console.log(`$ pnpm ${argv.join(" ")}`);
  const result = spawnSync("pnpm", argv, { cwd: ROOT, stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(`pnpm ${argv.join(" ")} exited with ${result.status}`);
  }
};

const versionOf = (name: string): string => {
  try {
    const manifest = JSON.parse(
      readFileSync(path(join("node_modules", name, "package.json")), "utf8")
    ) as { version?: string };
    return manifest.version ?? "?";
  } catch {
    return "not installed";
  }
};

rmSync(path(MARKER), { force: true });
try {
  if (channel !== DEFAULT_CHANNEL || floor) {
    writeFileSync(
      path("package.json"),
      channelManifest(String(saved.get("package.json")), record)
    );
  }
  if (relock) {
    writeFileSync(
      path("pnpm-lock.yaml"),
      withoutHostPackages(String(saved.get("pnpm-lock.yaml")))
    );
  } else if (channel !== DEFAULT_CHANNEL) {
    writeFileSync(path("pnpm-lock.yaml"), readFileSync(path(record.lockfile)));
  }
  if (floor) {
    writeFileSync(
      path("pnpm-workspace.yaml"),
      workspaceWithPi(String(saved.get("pnpm-workspace.yaml")), record.piFloor)
    );
  }
  pnpm(
    "install",
    floor || relock ? "--no-frozen-lockfile" : "--frozen-lockfile"
  );
  if (relock) {
    mkdirSync(dirname(path(record.lockfile)), { recursive: true });
    writeFileSync(path(record.lockfile), readFileSync(path("pnpm-lock.yaml")));
    console.log(`wrote ${record.lockfile}`);
  }
} finally {
  for (const [file, content] of saved) {
    writeFileSync(path(file), content);
  }
}

const installed = installedLockHash(ROOT);
if (installed !== undefined && (channel !== DEFAULT_CHANNEL || floor)) {
  const marker: Marker = { channel, floor, installed };
  writeFileSync(path(MARKER), `${JSON.stringify(marker, null, 2)}\n`);
}

console.log(
  [
    `channel ${channel}${floor ? " (pi at the range floor)" : ""}:`,
    `dsh-llm-pi-ai ${versionOf("@deepseek-ai/dsh-llm-pi-ai")} (record ${record.dsh}),`,
    `pi ${versionOf("@earendil-works/pi-ai")} (record ${floor ? record.piFloor : record.pi}),`,
    `cordis ${versionOf("@deepseek-ai/cordis")} (record ${record.cordis})`,
  ].join(" ")
);
