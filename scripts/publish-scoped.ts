/**
 * Publish the built package under its scoped alias.
 *
 * The package ships as `dsh-opencode-patch` — the unscoped name DSH resolves,
 * the name the docs use, the name release-please versions.
 * `@viztor/dsh-opencode-patch` is the same content under the organization scope,
 * for consumers who install by scope and for the GitHub Packages registry presence.
 *
 * Usage: node --experimental-strip-types scripts/publish-scoped.ts
 * Environment: runs inside the release workflow, authenticated by OIDC.
 */

import { execFileSync } from "node:child_process";
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const SCOPED = "@viztor/dsh-opencode-patch";

const pkgRaw: unknown = JSON.parse(
  readFileSync(path.join(ROOT, "package.json"), "utf-8")
);
const pkg = pkgRaw as {
  files: string[];
  version: string;
};
const version: string = pkg.version;

// The registry being written to.
const registry =
  process.env.PUBLISH_REGISTRY?.trim() ?? "https://registry.npmjs.org";
const { host } = new URL(registry);

// Skip, don't fail, when this version is already out on the registry being written to.
try {
  const published = execFileSync(
    "npm",
    ["view", `${SCOPED}@${version}`, "version", `--registry=${registry}`],
    { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }
  ).trim();
  if (published === version) {
    console.log(`${SCOPED}@${version} is already on ${host}, skipping`);
    process.exit(0);
  }
} catch {
  // Not published yet — continue below.
}

const scratch = mkdtempSync(path.join(tmpdir(), "dsh-opencode-patch-scoped-"));
try {
  for (const file of [...pkg.files, "package.json"]) {
    cpSync(path.join(ROOT, file), path.join(scratch, file), {
      recursive: true,
    });
  }
  const manifest = JSON.parse(
    readFileSync(path.join(scratch, "package.json"), "utf-8")
  ) as Record<string, unknown>;
  manifest.name = SCOPED;
  writeFileSync(
    path.join(scratch, "package.json"),
    `${JSON.stringify(manifest, null, 2)}\n`
  );

  const inCI =
    process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true";
  const mirrorToken =
    registry === "https://registry.npmjs.org"
      ? undefined
      : process.env.NODE_AUTH_TOKEN?.trim();
  const npmrc: string[] =
    mirrorToken !== undefined && mirrorToken !== ""
      ? [`--//${host}/:_authToken=${mirrorToken}`]
      : [];
  const attest =
    inCI && registry === "https://registry.npmjs.org" ? ["--provenance"] : [];

  execFileSync(
    "npm",
    [
      "publish",
      scratch,
      `--registry=${registry}`,
      ...attest,
      ...npmrc,
      "--access",
      "public",
      "--ignore-scripts",
    ],
    { cwd: ROOT, stdio: "inherit" }
  );
  console.log(`published ${SCOPED}@${version}`);
} finally {
  rmSync(scratch, { force: true, recursive: true });
}
