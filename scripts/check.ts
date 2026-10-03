/**
 * Package checks — one script, run once, in CI and before a release.
 *
 * Verifies that the packed artifact installs cleanly for a consumer, that the
 * host plugin and client bundle initialize, that peer ranges are resolvable by
 * plain npm, that release workflows are wired correctly, and that no credentials
 * or stale builds ship.
 *
 *   node --experimental-strip-types scripts/check.ts
 */

import assert from "node:assert/strict";
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
import { fileURLToPath } from "node:url";

import { en as cardCopy } from "../src/settings-copy.ts";

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

function newestMtime(dir: string): number {
  let newest = 0;
  for (const name of readdirSync(dir, { recursive: true })) {
    const full = join(dir, String(name));
    try {
      if (statSync(full).isFile())
        newest = Math.max(newest, statSync(full).mtimeMs);
    } catch {
      // Racing a build is not a failure; skip it.
    }
  }
  return newest;
}

const lib = join(ROOT, "lib");
if (!existsSync(lib)) {
  fail("lib/ is missing — run `pnpm run build`");
} else if (newestMtime(join(ROOT, "src")) > newestMtime(lib)) {
  fail(
    "src/ is newer than lib/ — run `pnpm run build`, or DSH will load the old one"
  );
} else {
  ok("lib/ is newer than src/");
}

/* ------------------------------------------- 2. peers npm must be able to read */

for (const [name, range] of Object.entries(
  (pkg.peerDependencies ?? {}) as Record<string, unknown>
)) {
  if (typeof range !== "string" || range.trim() === "") {
    fail(`peer ${name} has no usable range`);
    continue;
  }
  if (/^(workspace|link|file|catalog):/.test(range)) {
    fail(
      `peer ${name} uses "${range.split(":")[0]}:" — npm cannot parse it, so install fails`
    );
    continue;
  }
  if (!/^[\^~><=|*]/.test(range.trim())) {
    fail(
      `peer ${name} is pinned to "${range}" — a DSH patch release would orphan the plugin`
    );
  }
}
if (!failures.length) {
  ok(
    `${Object.keys(pkg.peerDependencies ?? {}).length} peer ranges npm can resolve`
  );
}

/* ------------------------------------------- 3. it is a bundle, and it loads */

const patch = pkg.dsh?.bundle?.patch;
if (!patch) {
  fail("no dsh.bundle.patch — DSH would install this and then ignore it");
} else if (existsSync(join(ROOT, patch))) {
  ok(`dsh.bundle.patch -> ${patch}`);
} else {
  fail(`dsh.bundle.patch points at "${patch}", which does not exist`);
}
for (const field of ["main", "types"]) {
  if (!pkg[field]) fail(`no ${field} declared`);
}

/* --------------------------------------- 4. the harness surfaces are still there */

const SURFACES = ["@deepseek-ai/dsh-typert-protocol"];

const REQUIRED: Record<string, [RegExp, string][] | undefined> = {
  "@deepseek-ai/dsh-typert-protocol": [
    [
      /(?:export declare class RemoteError|export \{[^}]*\bRemoteError\b)/,
      "RemoteError",
    ],
    [
      /export declare (?:abstract )?class TypertRemoteService/,
      "TypertRemoteService",
    ],
    [/interface TypertRemoteContribution\b/, "TypertRemoteContribution"],
  ],
};

for (const name of SURFACES) {
  let dir;
  try {
    dir = dirname(
      execFileSync(
        process.execPath,
        [
          "-e",
          `process.stdout.write(require.resolve(${JSON.stringify(`${name}/package.json`)}))`,
        ],
        { cwd: ROOT, encoding: "utf8" }
      )
    );
  } catch {
    notes.push(
      `skip  ${name} is not installed, so its surfaces were not checked`
    );
    continue;
  }

  const typesDir = join(dir, "lib/types");
  const files = existsSync(typesDir)
    ? readdirSync(typesDir)
        .filter((f) => f.endsWith(".d.ts"))
        .map((f) => join(typesDir, f))
    : [join(dir, "lib/index.d.ts")].filter(existsSync);

  if (files.length === 0) {
    fail(`${name} ships no readable type declarations — the contract moved`);
    continue;
  }

  const dts = files.map((f) => readFileSync(f, "utf8")).join("\n");
  const required = REQUIRED[name];
  assert.ok(required, `no surface contract for ${name}`);
  for (const [pattern, what] of required) {
    if (!pattern.test(dts)) fail(`${name} no longer exposes ${what}`);
  }
}
if (!failures.some((f) => f.includes("no longer exposes"))) {
  ok("every harness surface this package depends on is present");
}

/* --------------------------------- 5. the lint and format configs are actually loaded */

try {
  const printed = execFileSync(
    "pnpm",
    ["exec", "vp", "lint", "--print-config"],
    {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }
  );
  const effective = JSON.parse(printed.slice(printed.indexOf("{")));
  const ruleCount = Object.keys(effective.rules ?? {}).length;

  if (ruleCount < 300) {
    fail(
      `the effective lint config has ${ruleCount} rules — the \`lint\` block in vite.config.ts is not being loaded`
    );
  } else if (effective.options?.typeAware !== true) {
    fail("typeAware is off, so every typescript/* gate is listed but inert");
  } else if (effective.rules["typescript/no-floating-promises"] === undefined) {
    fail("the effective config is missing this package's own gates");
  } else {
    ok(`lint config is live (${ruleCount} rules, typeAware on)`);
  }
} catch (error) {
  const detail =
    error instanceof Error ? error.message.split("\n")[0] : String(error);
  fail(`could not read the effective lint config: ${detail}`);
}

/* --------------------------------------------------- 6. no credentials in the tree */

const SECRETS: [RegExp, string][] = [
  [/\bmonid_live_[A-Za-z0-9]{10,}/, "a Monid platform key"],
  [/\bsk-tinyfish-[A-Za-z0-9_-]{10,}/, "a TinyFish key"],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/, "a GitHub token"],
  [/sk-ant-[A-Za-z0-9_-]{10,}/, "an Anthropic key"],
];

const parts = { m: "monid_live_", t: "sk-tinyfish-", g: "ghp_", a: "sk-ant-" };
const CANARIES = [
  [`${parts.m}AbCdEf1234567890`, true],
  [`${parts.t}Pm-QkiaUloPEyNN`, true],
  [`${parts.g}abcdefghijklmnopqrstuvwxyz0123456789`, true],
  [`${parts.a}api03-AbCdEf1234567890`, true],
  [parts.m, false],
  [parts.t, false],
  ["$OPENCODE_GO_API_KEY", false],
  ["Authorization: Bearer <key>", false],
];
for (const [sample, shouldMatch] of CANARIES as [string, boolean][]) {
  if (SECRETS.some(([re]) => re.test(sample)) !== shouldMatch) {
    fail(
      `the secret scanner is ${shouldMatch ? "missing" : "over-matching"} on a sample`
    );
  }
}

const SKIP = new Set(["node_modules", ".git", "lib"]);
let scanned = 0;
const walk = (dir: string): void => {
  for (const name of readdirSync(dir)) {
    if (
      SKIP.has(name) ||
      name.startsWith(".build-check") ||
      name.endsWith(".tgz")
    )
      continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      walk(full);
      continue;
    }
    if (!/\.(mjs|js|ts|json|yml|yaml|md)$/.test(name)) continue;
    scanned += 1;
    const text = readFileSync(full, "utf8");
    for (const [re, what] of SECRETS) {
      if (re.test(text))
        fail(`${full.replace(`${ROOT}/`, "")} contains ${what}`);
    }
  }
};
walk(ROOT);
ok(`scanned ${scanned} files for credentials`);

/* ------------------------------ 7. install it the way a consumer will, and load it */

const scratch = mkdtempSync(join(tmpdir(), "dsh-opencode-"));

const CHILD_ENV = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => !/^npm_config_/i.test(name))
);

try {
  const [packed] = JSON.parse(
    execFileSync(
      "npm",
      ["pack", "--json", "--ignore-scripts", "--pack-destination", scratch],
      { cwd: ROOT, encoding: "utf8", env: CHILD_ENV }
    )
  ) as [{ filename: string; entryCount: number }];

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
    if (!calls.includes("GoUsageService")) throw new Error("GoUsageService was not registered");
    if (!calls.includes("llm/stream")) throw new Error("llm/stream was not registered");
    process.stdout.write("ok");
  `;
  execFileSync(process.execPath, ["--input-type=module", "-e", probe], {
    cwd: project,
    encoding: "utf8",
    env: CHILD_ENV,
    stdio: ["ignore", "pipe", "pipe"],
  });

  ok(
    `installed the packed tarball with plain npm (${packed.entryCount} entries) and loaded the host + client halves`
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

/* ------------------------------------------------- 8. the release can fire */

const workflows = join(ROOT, ".github/workflows");
const release = readFileSync(join(workflows, "release.yml"), "utf8");
const ci = readFileSync(join(workflows, "ci.yml"), "utf8");

if (/^\s*tags:\s*\[?\s*"?v\*\.\*\.\*"?/m.test(release)) {
  ok("release.yml is triggered by a version tag");
} else {
  fail("release.yml does not trigger on v*.*.* tags — nothing would publish");
}

if (/^\s*tags-ignore:\s*\[?\s*"?v\*\.\*\.\*"?/m.test(ci)) {
  ok("ci.yml ignores version tags, leaving them to release.yml");
} else {
  fail(
    "ci.yml does not ignore version tags; a tag push matches no branch, so " +
      "ci.yml never runs on one and anything gated on it is unreachable"
  );
}

if (/^\s*id-token:\s*write/m.test(release)) {
  ok("release.yml grants id-token: write for OIDC trusted publishing");
} else {
  fail(
    "release.yml has no id-token: write, so npm trusted publishing cannot " +
      "authenticate and the publish would need a stored token"
  );
}

if (/npm view .* version 2>\/dev\/null/.test(release)) {
  ok("release.yml skips a version that is already on the registry");
} else {
  fail(
    "release.yml does not skip an already-published version, so re-running a " +
      "tag fails on npm's refusal to republish"
  );
}

/* --------------------------------------------------- 9. the toolchain is Vite+ */

const TOOLCHAIN = ["build", "check", "format", "lint", "test"];
const UNBYPASSED = /(?:^|[\s(])(oxlint|oxfmt|tsdown|vitest|tsc)(?:[\s)]|$)/;

if (pkg.devDependencies?.["vite-plus"]) {
  ok(`the toolchain is vite-plus (${pkg.devDependencies["vite-plus"]})`);
} else {
  fail("the package does not depend on vite-plus; the toolchain is unpinned");
}

for (const name of TOOLCHAIN) {
  const script = pkg.scripts?.[name];
  if (!script) {
    fail(`no ${name} script`);
  } else if (!/\bvp\b/.test(script)) {
    fail(`the ${name} script does not go through vp: ${script}`);
  } else if (UNBYPASSED.test(script.replaceAll(/\bvp\b[^\s]*/g, ""))) {
    const bare = script.match(new RegExp(UNBYPASSED, "g")) ?? [];
    const real = bare.filter((tool: string) => tool.trim() !== "tsc");
    if (real.length > 0) {
      fail(
        `the ${name} script reaches past vp for ${real.map((t: string) => t.trim()).join(", ")}; ` +
          "that bypasses the entry point that reads the config"
      );
    }
  }
}
ok(`${TOOLCHAIN.length} toolchain scripts route through vp`);

/* -------------------------------------------- 10. the scoped alias ships too */

const releaseYml = readFileSync(join(workflows, "release.yml"), "utf8");
if (releaseYml.includes("scripts/publish-scoped.ts")) {
  ok("release.yml publishes scoped aliases from the same tree");
} else {
  fail(
    "release.yml does not publish the scoped alias; @viztor/dsh-opencode-patch " +
      "would go stale while dsh-opencode-patch moves on"
  );
}

/* ------------------------------------------ 11. the client stays lean */

const CLIENT_BUDGET = 64 * 1024;
const clientPath = join(ROOT, "lib/client.js");
if (existsSync(clientPath)) {
  const clientStat = statSync(clientPath);
  if (clientStat.size <= CLIENT_BUDGET) {
    ok(`lib/client.js is ${clientStat.size} bytes, under budget`);
  } else {
    fail(
      `lib/client.js is ${clientStat.size} bytes, over the ${CLIENT_BUDGET} budget — ` +
        "a dependency was likely bundled instead of left external"
    );
  }
} else {
  fail("lib/client.js is missing — run `pnpm run build`");
}

/* ------------------------------------ 12. one name everywhere (identity + i18n) */

const settingsPage = readFileSync(join(ROOT, "src/settings-page.tsx"), "utf8");
const nsMatch = /export const NS = "([^"]+)"/u.exec(settingsPage);
if (nsMatch?.[1] === pkg.name) {
  ok(`settings namespace == package name (${pkg.name})`);
} else {
  fail(
    `settings NS is "${nsMatch?.[1]}" but package.json name is "${pkg.name}" — ` +
      "the card would bind a namespace the host never serves"
  );
}

const localeKeys = (value: unknown, prefix = ""): string[] =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
        localeKeys(child, prefix === "" ? key : `${prefix}.${key}`)
      )
    : [prefix];

const [enLocale, zhLocale] = ["en", "zh"].map(
  (lang) =>
    JSON.parse(
      readFileSync(join(ROOT, `locale/${lang}.json`), "utf8")
    ) as unknown
);
const enKeys = localeKeys(enLocale).toSorted();
const zhKeys = localeKeys(zhLocale).toSorted();
if (enKeys.join("\n") === zhKeys.join("\n")) {
  ok(`${enKeys.length} locale keys in sync across en/zh`);
} else {
  fail(
    `locale/en.json and locale/zh.json disagree on keys (${enKeys.length} en vs ` +
      `${zhKeys.length} zh) — a missing translation would render as a raw key`
  );
}

const bundleTitle = (enLocale as { meta?: { title?: unknown } }).meta?.title;
if (bundleTitle === cardCopy.title) {
  ok(`one display name everywhere ("${bundleTitle}")`);
} else {
  fail(
    `the plugin shows two names: locale/en.json meta.title "${String(bundleTitle)}" ` +
      `!= settings-card title "${cardCopy.title}" — keep one display name`
  );
}

/* ------------------------------------------------------------------- report */

for (const note of notes) console.log(`  ok   ${note}`);
for (const message of failures) console.error(`  FAIL ${message}`);

if (failures.length) {
  console.error(`\ncheck failed — ${failures.length} problem(s)`);
  process.exit(1);
}
console.log("\ncheck passed");
