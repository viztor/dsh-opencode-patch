/**
 * Publish the built package under its scoped alias(es).
 *
 * The package ships as `dsh-opencode-patch` — the unscoped name DSH resolves,
 * the name the docs use, the name release-please versions.
 *
 * It also publishes under:
 * - `@viztor/dsh-opencode-patch` (modern scoped alias)
 * - `@viztor/dsh-opencode` (legacy scoped alias, so existing users upgrade seamlessly)
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
const SCOPED_TARGETS = ["@viztor/dsh-opencode-patch", "@viztor/dsh-opencode"];

const pkgRaw: unknown = JSON.parse(
  readFileSync(path.join(ROOT, "package.json"), "utf-8")
);
const pkg = pkgRaw as {
  files: string[];
  version: string;
};
const version: string = pkg.version;

const registry =
  process.env.PUBLISH_REGISTRY?.trim() ?? "https://registry.npmjs.org";
const { host } = new URL(registry);
const inCI = process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true";
const mirrorToken =
  registry === "https://registry.npmjs.org"
    ? undefined
    : process.env.NODE_AUTH_TOKEN?.trim();
const npmrc: string[] =
  mirrorToken !== undefined && mirrorToken.length > 0
    ? [`--//${host}/:_authToken=${mirrorToken}`]
    : [];
const attest =
  inCI && registry === "https://registry.npmjs.org" ? ["--provenance"] : [];

for (const target of SCOPED_TARGETS) {
  try {
    const published = execFileSync(
      "npm",
      ["view", `${target}@${version}`, "version", `--registry=${registry}`],
      { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }
    ).trim();
    if (published === version) {
      console.log(`${target}@${version} is already on ${host}, skipping`);
      continue;
    }
  } catch {
    // Not published yet — continue below.
  }

  const scratch = mkdtempSync(
    path.join(tmpdir(), "dsh-opencode-patch-scoped-")
  );
  try {
    for (const file of [...pkg.files, "package.json"]) {
      cpSync(path.join(ROOT, file), path.join(scratch, file), {
        recursive: true,
      });
    }
    const manifest = JSON.parse(
      readFileSync(path.join(scratch, "package.json"), "utf-8")
    ) as Record<string, unknown>;
    manifest.name = target;
    writeFileSync(
      path.join(scratch, "package.json"),
      `${JSON.stringify(manifest, null, 2)}\n`
    );

    try {
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
      console.log(`published ${target}@${version} to ${host}`);
    } catch {
      console.log(
        `${target}@${version} already published or staged on ${host}, continuing...`
      );
    }
  } finally {
    rmSync(scratch, { force: true, recursive: true });
  }
}
