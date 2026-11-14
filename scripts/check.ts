/**
 * The bundle gate: what needs a build or a registry, run once, in CI and
 * before a release.
 *
 * Three checks, each one only this script can make:
 *
 * 1. `lib/` carries the current build (`libFreshness`): no artifact missing
 *    or older than `src/`, which is how a failed build passes for a good one.
 * 2. The packed tarball installs for a consumer with plain npm, and both
 *    halves load from that install: the host entry applies, and the client
 *    bundle resolves through `exports["./client"]`, registers its ids with
 *    the web client's module loader and answers its factory.
 * 3. The client bundle stays under its size tripwire.
 *
 * Every pure file check (the workflows, the manifest, the toolchain, the
 * credential scan, locale parity) is a unit test: `test/ci-wiring.test.ts`,
 * `test/package-checks.test.ts`, `test/toolchain.test.ts` and
 * `test/no-local-paths.test.ts`.
 *
 *   node --experimental-strip-types scripts/check.ts
 */

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { libFreshness } from "./package-checks.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const failures: string[] = [];
const notes: string[] = [];

const fail = (message: string): void => {
  failures.push(message);
};
const ok = (message: string): void => {
  notes.push(message);
};

const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));

/* ------------------------------------------------------- 1. lib/ is current */

/**
 * `vp pack` CLEANS `lib/` and emits `lib/client.cjs`; the served `lib/client.js`
 * comes from `scripts/name-client-bundle.ts`. A build that failed, or one whose
 * rename step was skipped, therefore leaves a `lib/` missing a file the host
 * loads, or older than the source it should have been built from —
 * indistinguishable from success to everything downstream.
 */
const LIB = join(ROOT, "lib");

const newestSource = (dir: string): number => {
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    try {
      newest = Math.max(
        newest,
        entry.isDirectory() ? newestSource(full) : statSync(full).mtimeMs
      );
    } catch {
      // Racing an editor's save is not a failure; skip the file.
    }
  }
  return newest;
};

const mtimeOf = (file: string): number | undefined =>
  existsSync(file) ? statSync(file).mtimeMs : undefined;

const stale = libFreshness({
  artifacts: {
    "client.js": mtimeOf(join(LIB, "client.js")),
    "index.mjs": mtimeOf(join(LIB, "index.mjs")),
  },
  hasClientCjs: existsSync(join(LIB, "client.cjs")),
  newestSource: newestSource(join(ROOT, "src")),
});
if (stale === undefined) {
  ok("lib/ carries the current build, including the served client bundle");
} else {
  fail(stale);
}

/* ---------------------- 2. install it the way a consumer will, and load both halves */

const scratch = mkdtempSync(join(tmpdir(), "dsh-opencode-"));

const CHILD_ENV = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => !/^npm_config_/i.test(name))
);

try {
  // `npm pack --json` answers with an array of results through npm 11 and with
  // a name-keyed object from npm 12 on, which is what Node 26 ships and what CI
  // runs. Both shapes are read rather than pinning the toolchain: the value
  // wanted is one pack result either way.
  const packReport = JSON.parse(
    execFileSync(
      "npm",
      ["pack", "--json", "--ignore-scripts", "--pack-destination", scratch],
      { cwd: ROOT, encoding: "utf8", env: CHILD_ENV }
    )
  ) as
    | { filename: string; entryCount: number }[]
    | Record<string, { filename: string; entryCount: number }>;
  const packed = Array.isArray(packReport)
    ? packReport[0]
    : Object.values(packReport)[0];
  if (packed === undefined) {
    throw new Error("npm pack --json answered with no result");
  }

  const project = join(scratch, "consumer");
  execFileSync("mkdir", ["-p", project]);
  const peers = Object.entries(
    (pkg.peerDependencies ?? {}) as Record<string, unknown>
  ).map(([n, r]) => `${n}@${String(r)}`);
  execFileSync(
    "npm",
    [
      "install",
      join(scratch, packed.filename),
      ...peers,
      "--no-audit",
      "--no-fund",
      "--ignore-scripts",
    ],
    {
      cwd: project,
      encoding: "utf8",
      env: CHILD_ENV,
      stdio: ["ignore", "pipe", "pipe"],
    }
  );

  const installed = join(project, "node_modules/dsh-opencode-patch");
  const installedManifest = JSON.parse(
    readFileSync(join(installed, "package.json"), "utf8")
  );
  if (installedManifest.dsh?.bundle?.patch === undefined) {
    fail(
      "the published manifest lost dsh.bundle.patch — DSH would ignore the package"
    );
  }

  // Loaded from the installed copy, verifying the host entrypoint and Config schema
  const probe = `
    const m = await import(${JSON.stringify(join(installed, pkg.main))});
    if (typeof m.apply !== "function") throw new Error("no apply()");
    if (typeof m.Config !== "function") throw new Error("no Config");
    const calls = [];
    const ctx = {
      plugin: (p) => calls.push(p?.name || "plugin"),
      effect: (fn) => fn(),
      on: (ev) => calls.push(ev),
      get: () => undefined,
      logger: { info: () => {}, warn: () => {} },
    };
    m.apply(ctx, m.Config({}));
    for (const service of ["GoUsageService", "ModelPurgeService", "OpencodeStoreService"]) {
      if (!calls.includes(service)) throw new Error(service + " was not registered");
    }
    if (!calls.includes("llm/stream")) throw new Error("llm/stream was not registered");
    process.stdout.write("ok");
  `;
  execFileSync(process.execPath, ["--input-type=module", "-e", probe], {
    cwd: project,
    encoding: "utf8",
    env: CHILD_ENV,
    stdio: ["ignore", "pipe", "pipe"],
  });

  // The client half, from the same install: the web client loader serves
  // `${package}/client.js`, hands the bundle a `window` whose module loader
  // registers it, and calls the factory with the host's `require`. The probe
  // does the same with a recorder for each, and a `require` whose answer is a
  // stand-in for any host module (callable, constructible, every property
  // another stand-in), so the bundle's module-level code runs as it would.
  // The rule is `clientBundleProblems` (scripts/package-checks.ts), which
  // test/package-checks.test.ts runs on lib/client.js and on planted
  // bundles; here it runs on the bundle the tarball installed, resolved
  // through the package's own `exports`.
  const clientProbe = `
    import { createRequire } from "node:module";
    import { readFileSync } from "node:fs";
    import { runInNewContext } from "node:vm";
    const { clientBundleProblems } = await import(${JSON.stringify(pathToFileURL(join(ROOT, "scripts", "package-checks.ts")).href)});
    const resolved = createRequire(process.cwd() + "/").resolve(${JSON.stringify(`${pkg.name}/client`)});
    if (!resolved.endsWith("/lib/client.js")) throw new Error("the client export resolves to " + resolved);
    const { asked, problems } = clientBundleProblems(
      readFileSync(resolved, "utf8"),
      { ids: ${JSON.stringify([pkg.name, "@viztor/dsh-opencode-patch"])}, ns: ${JSON.stringify(pkg.name)} },
      runInNewContext
    );
    if (problems.length > 0) throw new Error(problems.join("; "));
    process.stdout.write(asked.length + " host module(s) asked for");
  `;
  const asked = execFileSync(
    process.execPath,
    [
      "--experimental-strip-types",
      "--disable-warning=ExperimentalWarning",
      "--input-type=module",
      "-e",
      clientProbe,
    ],
    {
      cwd: project,
      encoding: "utf8",
      env: CHILD_ENV,
      stdio: ["ignore", "pipe", "pipe"],
    }
  );

  ok(
    `installed the packed tarball with plain npm (${packed.entryCount} entries) and loaded the host + client halves (the client: ${asked})`
  );
} catch (error: unknown) {
  const err = error as { stderr?: string; message?: string };
  const detail = [err.stderr, err.message]
    .filter(Boolean)
    .join("\n")
    .split("\n")
    .filter((l) => /Error|Cannot find|ENOENT|EEXIST|npm error|code /.test(l))
    .slice(0, 3)
    .join(" | ");
  fail(`a consumer install or load failed: ${detail}`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

/* ------------------------------------------ 3. the client stays lean */

/*
 * A TRIPWIRE, not a budget. The owner: "the budget doesn't matter — it is there to
 * avoid accidents." It was 64 KiB when the bundle was 604 bytes of copy, then 72
 * KiB when the panel's own work reached ~73 KB — and at THAT number it stopped
 * answering the question it exists for, because a comment or a copy string trips
 * it just as hard as the accident it was built to catch.
 *
 * What it really watches is a DEPENDENCY bundled instead of left external, and
 * that arrives as a jump of THOUSANDS of bytes. So the ceiling sits ~3 KB above
 * the real working size: far enough that prose and copy never trip it, far
 * enough below that a real regression (a date library, an SDK — the bundled React
 * alone is 40+ KB) still lands over it. Raising it costs nothing in signal and
 * buys back the prose in the files that own the knowledge. Measure with
 * `wc -c lib/client.js`.
 */
/**
 * A TRIPWIRE, not a budget. 79 KiB sits ~3.5 KB above the real working size
 * (77.3 KB), which is the whole point: the number catches a dependency being
 * bundled instead of left external, and that lands as a jump of THOUSANDS of
 * bytes. It must never fire on prose. Raised from 75 KiB when a couple of
 * hundred bytes of client comments pushed the bundle over — the owner's
 * standing instruction is to raise the ceiling, never to cut content.
 */
/**
 * A TRIPWIRE, not a budget. 96 KiB sits ~2 KB above the real working size
 * (86.5 KB), which is the whole point: the number catches a dependency being
 * bundled instead of left external, and that lands as a jump of THOUSANDS of
 * bytes. It must never fire on prose or on a feature that earns its bytes.
 *
 * Raised 75 -> 79 when client comments pushed it over, 79 -> 85 when the reset
 * line gained localized durations and an absolute date-time composed from
 * `Intl` parts, and 85 -> 88 when the session-spend row became a component with
 * its own empty state and the Zen hover gained the price. All three were real
 * behaviour, and the owner's standing instruction is to raise the ceiling
 * rather than delete something to fit.
 *
 * Raised 88 -> 96 when the settings card gained the Go usage summary. That was
 * a measured +7.8 KB, and it is the module's own source: this file's rule is
 * that comments ship, and the summary's rationale (why "left" is a percentage
 * and never a dollar figure) is load-bearing. Verified against a stashed
 * baseline before raising, precisely because a jump that size is the shape this
 * guard exists to catch.
 *
 * The margin is what matters, not the number: at 85 the bundle sat 526 bytes
 * under the line, which means the next honest edit trips a guard whose only
 * job is to notice a dependency.
 *
 * Raised 112 -> 116 KB when the sign-in row gained a plane selector. The login
 * is per plane — two authentication routes, one grant each — and the row had no
 * way to say which one it was writing or describing, so a deployment living on
 * Go could not sign in on the plane it used. The growth is a radio group, its
 * two localized labels, and the rationale for why a grant written on one plane
 * still serves the other.
 *
 * Raised 116 -> 120 KB when the login row gained cancellation. A flow started
 * from the card could only be abandoned by reloading the page, and the effect
 * that owns the poll loop now cancels the flow it owns on the way out. The
 * growth is the cancel call, its result type and the release path.
 *
 * Raised 120 -> 124 KB when the client measured 123122 bytes and this ceiling
 * caught it. The commit that crossed the line grew it by 835 bytes — the meter
 * saying WHY it renders nothing instead of rendering nothing quietly — and the
 * growth since the last raise is that kind of thing: copy and JSX in the usage
 * and settings surfaces, hundreds of bytes at a time. Nothing in the curve is a
 * dependency that should have stayed external, which is the case this tripwire
 * exists to catch.
 *
 * Raised 124 -> 128 KB when the local-store inspection row landed: a heading, a
 * hint, one button and the report it renders, plus their two localized copies.
 * That is the same kind of growth as the last raise — UI, not a dependency — and
 * the client measured 127048 bytes against the old line.
 *
 * The 140 KB raise that the catalog-gap row once justified is REVERTED, together
 * with the row: the owner's call was that the card should not offer to declare
 * catalog models at all, so the contract, the caller, the report, the per-plane
 * list and twenty localized strings left with it. A ceiling that stayed at 140
 * would have quietly stopped being a tripwire — 12 KB of slack is more than this
 * guard exists to tolerate.
 *
 * Raised 128 -> 132 KB when the usage contract grew: the client's one helper
 * for the sibling's zero-argument \`read\` (the meter's scoped read and the
 * settings card's quota row both go through it now, instead of each spelling its
 * own call), the account row's \`readAccount\` answer, and the codec that
 * validates the reference before it can reach a credential lookup. The client
 * measured 132541 bytes against the old line.
 *
 * The same 128 -> 132 KB raise was made, independently, when the
 * store-inspection row's remote descriptor landed: the row had been calling a
 * namespace the client never mounted, and the fix is the descriptor plus the
 * whitelist parser its codec runs. Source, not a dependency — the client
 * measured 132320 bytes against the old line, about 1.2 KB over, which is this
 * guard's "raise it" case.
 *
 * Raised 132 -> 136 KB when those two raises met in one merge: each had been
 * measured against a tree without the other, and together the client measured
 * 135604 bytes, about 0.4 KB over. Nothing new arrived with the merge — it is
 * the same two surfaces, counted once each.
 *
 * That is the kind of growth the last four raises were: a surface the HOST
 * answers, not a dependency that should have stayed external — which is the case
 * this tripwire exists to catch, and which the ceiling is not raised for.
 */
const CLIENT_BUDGET = 136 * 1024;
const clientPath = join(ROOT, "lib/client.js");
if (existsSync(clientPath)) {
  const clientStat = statSync(clientPath);
  if (clientStat.size <= CLIENT_BUDGET) {
    ok(
      `lib/client.js is ${clientStat.size} bytes, under the ${CLIENT_BUDGET} tripwire`
    );
  } else {
    fail(
      `lib/client.js is ${clientStat.size} bytes, over the ${CLIENT_BUDGET} tripwire. ` +
        "Two causes, two responses — the owner's standing instruction is to RAISE THE " +
        "CEILING, never to cut content:\n" +
        "  - a jump of thousands of bytes? A dependency was bundled instead of left " +
        "external. Add it to deps.neverBundle in vite.config.ts.\n" +
        "  - a few hundred bytes of copy or comments? Raise CLIENT_BUDGET. Do NOT trim " +
        "prose to fit a number that exists only to catch the case above."
    );
  }
} else {
  fail("lib/client.js is missing — run `pnpm run build`");
}

/* ------------------------------------------------------------------- report */

for (const note of notes) console.log(`  ok   ${note}`);
for (const message of failures) console.error(`  FAIL ${message}`);

if (failures.length) {
  console.error(`\ncheck failed — ${failures.length} problem(s)`);
  process.exit(1);
}
console.log("\ncheck passed");
