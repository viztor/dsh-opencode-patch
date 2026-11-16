/**
 * Propose the harness bump the nightly drift report found (D22'').
 *
 *     node --experimental-strip-types scripts/propose-host-bump.ts [--registry <url>] [--write] [--out <dir>] [--root <dir>]
 *
 * Reads the registry the way the report does (`scripts/registry-view.ts`),
 * plans each channel (`bumpPlan` in `scripts/host-bump.ts`), couples the
 * channels' pi (`coupleSharedPi`: both lockfiles hold one pi, so a pi move
 * carries every record or none) and prints one line per plan. A plan that cannot be proposed is a `::warning::` line
 * (`blocked`: a partial read; `waiting`: a cut inside pnpm's one-day
 * release-age window, proposed the next night), and nothing that cannot be
 * proposed ever fails the run: it exits 0.
 *
 * With `--write`, for each `data` or `range` plan it moves CONTRIBUTING's
 * release-step-3 data and nothing else: the record in
 * `test/support/host-versions.ts`, alpha's exact pins in `package.json`
 * (`channelManifest`), the README pair's "today" sentences, the root
 * lockfile (`pnpm install`, and `pnpm update @earendil-works/pi-ai --no-save`
 * when pi moved, since an install keeps a pi the lockfile satisfies) and the
 * rc lockfile (`scripts/use-channel.ts rc --relock`). It runs no test: the
 * proposed pull request's own CI is the run. A pnpm step that fails puts back
 * every tracked file this wrote and exits 1.
 *
 * With `--out <dir>`, it leaves what CI's step needs to open the pull request:
 * `title`, `body.md`, `target` (the marker line `body.md` ends with, which
 * names every proposed record in full: the push step's "same target"),
 * `files` (the paths it changed, one per line) and `dispatch` (present only
 * when the floor cells must run). No `title` means nothing to propose.
 *
 * With `--root <dir>`, the files it reads and writes, and the commands it
 * runs, are under that directory instead of the repository (the records it
 * plans from are still the repository's own). The mock suite uses it to run
 * the write and its put-back on a scratch copy.
 *
 * @module scripts/propose-host-bump
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  CHANNELS,
  type Channel,
  type ChannelRecord,
  RECORD_TAGS,
} from "../test/support/host-versions.ts";
import {
  applyBumpTexts,
  type BumpPlan,
  bumpBody,
  bumpPlan,
  bumpTarget,
  bumpTitle,
  coupleSharedPi,
} from "./host-bump.ts";
import {
  type BumpField,
  readChannel,
  REGISTRY_PACKAGES,
} from "./host-drift.ts";
import { fetchPublishTimes, fetchRegistryView } from "./registry-view.ts";

const argv = process.argv.slice(2);
const option = (name: string): string | undefined => {
  const at = argv.indexOf(name);
  return at === -1 ? undefined : argv[at + 1];
};
const ROOT = option("--root") ?? join(import.meta.dirname, "..");
const registry = option("--registry") ?? "https://registry.npmjs.org";
const write = argv.includes("--write");
const out = option("--out");

/** The files a bump may move, from the repository root. */
const RECORDS = "test/support/host-versions.ts";
const READMES = [
  ["README.md", "**Support policy.**"],
  ["README.zh-CN.md", "**支持策略。**"],
] as const;
const MOVABLE = [
  RECORDS,
  "package.json",
  ...READMES.map(([file]) => file),
  "pnpm-lock.yaml",
  ...Object.values(CHANNELS).map((record) => record.lockfile),
].filter((file, index, all) => all.indexOf(file) === index);

const read = (file: string): string => readFileSync(join(ROOT, file), "utf8");

/** One line per plan, as the nightly log reads it. */
const describe = (plan: BumpPlan): string => {
  if (plan.kind === "current") {
    return `${plan.channel}: current (dsh@${plan.from.dsh}, pi ${plan.from.pi})`;
  }
  if (plan.kind === "blocked" || plan.kind === "waiting") {
    return `::warning::${plan.channel}: ${plan.kind}: ${plan.notes.join("; ")}`;
  }
  const moves = plan.moved
    .map((field) => `${field} ${plan.from[field]} -> ${plan.to[field]}`)
    .join(", ");
  return `${plan.channel}: ${plan.kind}: ${moves}${plan.notes.length === 0 ? "" : `; ${plan.notes.join("; ")}`}`;
};

/** Run a command in the repository, its output inherited; throws on failure. */
const run = (command: string, args: readonly string[]): void => {
  console.log(`$ ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, { cwd: ROOT, stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} exited with ${String(result.status)}`
    );
  }
};

/** Read the registry and plan every channel; undefined when it could not be read. */
const plan = async (): Promise<BumpPlan[] | undefined> => {
  try {
    const view = await fetchRegistryView(registry);
    const channels = Object.entries(CHANNELS) as [Channel, ChannelRecord][];
    // The versions each channel would move to, for their publish times.
    const foundOf = (record: ChannelRecord, field: BumpField) =>
      readChannel(record, view).flatMap((finding) =>
        finding.kind === "value" && finding.field === field
          ? [finding.found]
          : []
      );
    const wanted = {
      dsh: channels.flatMap(([, record]) => foundOf(record, "dsh")),
      pi: channels.flatMap(([, record]) => foundOf(record, "pi")),
    };
    const [dshTimes, piTimes] = await Promise.all([
      fetchPublishTimes(registry, REGISTRY_PACKAGES.dsh, wanted.dsh),
      fetchPublishTimes(registry, REGISTRY_PACKAGES.pi, wanted.pi),
    ]);
    const peers = (
      JSON.parse(read("package.json")) as {
        peerDependencies?: Record<string, string>;
      }
    ).peerDependencies;
    const planned = channels.map(([channel, record]) => {
      const [dsh] = foundOf(record, "dsh");
      const [pi] = foundOf(record, "pi");
      return bumpPlan({
        channel,
        now: Date.now(),
        peers: peers ?? {},
        publishedAt: {
          dsh: dsh === undefined ? undefined : dshTimes[dsh],
          pi: pi === undefined ? undefined : piTimes[pi],
        },
        record,
        registry: view,
        tags: RECORD_TAGS,
      });
    });
    return coupleSharedPi(planned);
  } catch (error) {
    console.log(
      `::warning::host bump not proposed: ${error instanceof Error ? error.message : String(error)}`
    );
    return undefined;
  }
};

/** Move the data, then the lockfiles; the README fields left for review. */
const apply = (
  proposed: readonly BumpPlan[]
): Readonly<Record<string, readonly BumpField[]>> => {
  const texts = applyBumpTexts(
    {
      manifest: read("package.json"),
      readmes: READMES.map(([file, marker]) => ({
        file,
        marker,
        text: read(file),
      })),
      records: read(RECORDS),
    },
    proposed,
    CHANNELS
  );
  writeFileSync(join(ROOT, RECORDS), texts.records);
  writeFileSync(join(ROOT, "package.json"), texts.manifest);
  for (const { file, text } of texts.readmes) {
    writeFileSync(join(ROOT, file), text);
  }

  run("pnpm", ["install", "--no-frozen-lockfile"]);
  if (proposed.some((each) => each.moved.includes("pi"))) {
    run("pnpm", ["update", "@earendil-works/pi-ai", "--no-save"]);
  }
  run(process.execPath, [
    "--experimental-strip-types",
    "scripts/use-channel.ts",
    "rc",
    "--relock",
  ]);
  return texts.unresolved;
};

const plans = await plan();
if (plans !== undefined) {
  for (const each of plans) {
    console.log(describe(each));
  }
  const proposed = plans.filter(
    (each) => each.kind === "data" || each.kind === "range"
  );
  if (proposed.length > 0) {
    const before = new Map(MOVABLE.map((file) => [file, read(file)]));
    let unresolved: Record<string, readonly BumpField[]> = {};
    if (write) {
      try {
        unresolved = apply(proposed);
      } catch (error) {
        for (const [file, text] of before) {
          writeFileSync(join(ROOT, file), text);
        }
        console.log(
          `::error::the bump was not proposed: ${error instanceof Error ? error.message : String(error)}; every tracked file it wrote is put back`
        );
        process.exit(1);
      }
    }
    const files = MOVABLE.filter((file) => read(file) !== before.get(file));
    if (out !== undefined) {
      mkdirSync(out, { recursive: true });
      writeFileSync(join(out, "title"), `${bumpTitle(proposed)}\n`);
      writeFileSync(join(out, "target"), `${bumpTarget(proposed)}\n`);
      writeFileSync(
        join(out, "body.md"),
        `${bumpBody(proposed, { files, unresolved })}\n`
      );
      writeFileSync(
        join(out, "files"),
        files.map((file) => `${file}\n`).join("")
      );
      if (proposed.some((each) => each.needsFloorCells)) {
        writeFileSync(join(out, "dispatch"), "floor cells\n");
      }
    }
  }
}
