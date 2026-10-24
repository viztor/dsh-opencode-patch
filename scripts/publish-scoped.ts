/**
 * Publish the built package under its scoped alias(es).
 *
 * The package ships as `dsh-opencode-patch` — the unscoped name DSH resolves,
 * the name the docs use, the name release-please versions.
 *
 * It also publishes under `@viztor/dsh-opencode-patch` — the CANONICAL scoped
 * name. Same tree, same bundle, same version as the unscoped one; this is the
 * name new installs should use, and the one the client bundle registers its
 * card under (`SCOPED_PKG`). The list is `SCOPED_TARGETS`
 * (`scripts/scoped-targets.ts`), which `scripts/check.ts` holds in step with
 * release.yml's verify step.
 *
 * The retired name `@viztor/dsh-opencode` is no longer published: its last
 * version's "Renamed to @viztor/dsh-opencode-patch" deprecation stands as the
 * final message on the registry.
 *
 * Usage: node --experimental-strip-types scripts/publish-scoped.ts
 *        PUBLISH_DRY_RUN=1 node --experimental-strip-types scripts/publish-scoped.ts
 * Environment: runs inside the release workflow, authenticated by OIDC.
 *
 * `PUBLISH_DRY_RUN=1` builds every scratch tree, prints the exact manifest each
 * alias would publish, and stops before the first network call. The per-alias
 * transformations are otherwise only observable after a real release.
 */

import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { SCOPED_TARGETS } from "./scoped-targets.ts";

const ROOT = path.resolve(import.meta.dirname, "..");

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

// `PUBLISH_DRY_RUN=1` inspects the scratch trees without touching the network,
// so it must not consult the registry either — otherwise a version that is
// already published short-circuits before the transform is ever shown.
const dryRun = process.env.PUBLISH_DRY_RUN === "1";

for (const target of SCOPED_TARGETS) {
  try {
    if (dryRun) throw new Error("dry run");
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
    // `files` is npm's publish filter and may hold glob patterns, such as
    // `locale/*.json`. `cpSync` copies a path, not a pattern, so a pattern is
    // reduced to the directory it selects from: the whole directory lands in
    // the scratch tree and npm applies the pattern again when it packs. Naming
    // a pattern here used to abort the release with ENOENT on a literal
    // `locale/*.json`.
    const copyRoot = (entry: string): string => {
      if (!entry.includes("*")) return entry;
      const slash = entry.indexOf("/");
      return slash === -1 ? "." : entry.slice(0, slash);
    };
    for (const file of new Set([...pkg.files, "package.json"].map(copyRoot))) {
      cpSync(path.join(ROOT, file), path.join(scratch, file), {
        recursive: true,
      });
    }
    const manifest = JSON.parse(
      readFileSync(path.join(scratch, "package.json"), "utf-8")
    ) as Record<string, unknown>;
    manifest.name = target;
    if (target === "@viztor/dsh-opencode-patch") {
      const patchPath = path.join(scratch, "cordis.patch.yml");
      const patchContent = readFileSync(patchPath, "utf-8");
      writeFileSync(
        patchPath,
        patchContent.replaceAll(
          'name: "dsh-opencode-patch"',
          'name: "@viztor/dsh-opencode-patch"'
        )
      );
    }
    writeFileSync(
      path.join(scratch, "package.json"),
      `${JSON.stringify(manifest, null, 2)}\n`
    );

    if (dryRun) {
      console.log(`--- ${target}@${version} (dry run) ---`);
      console.log(readFileSync(path.join(scratch, "package.json"), "utf8"));
      console.log(
        `${
          existsSync(path.join(scratch, "lib", "client.js"))
            ? "ships"
            : "does not ship"
        } lib/client.js`
      );
      continue;
    }

    // Capture the output instead of inheriting stdio: a failure has to be
    // *classified*, because npm reports the one benign case only in its text.
    //
    // The benign case is a re-pushed tag. `npm view` above still says "no such
    // version" while the registry has the tarball staged but not yet indexed,
    // so the PUT returns 409 "Cannot publish over previously staged version".
    // That version is on its way; it must not fail the rerun.
    //
    // Everything else — a missing Trusted Publisher (404), an expired token, a
    // network failure — is a release that did NOT happen, and it is thrown so
    // the workflow stops reporting a publish that never landed. The release
    // workflow's final verification step then names every target that is
    // actually absent from the registry.
    try {
      const output = execFileSync(
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
        { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
      );
      if (output.trim() !== "") console.log(output.trim());
      console.log(`published ${target}@${version} to ${host}`);
    } catch (error: unknown) {
      const failure = error as {
        message?: string;
        stderr?: string;
        stdout?: string;
      };
      const output = `${failure.stdout ?? ""}${failure.stderr ?? ""}${
        failure.message ?? ""
      }`;
      if (
        /previously published|previously staged|EPUBLISHCONFLICT|E409/u.test(
          output
        )
      ) {
        console.log(
          `${target}@${version} was already staged on ${host}; continuing`
        );
      } else {
        console.error(output.trim());
        throw error;
      }
    }
  } finally {
    rmSync(scratch, { force: true, recursive: true });
  }
}
