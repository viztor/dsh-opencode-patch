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
 *        PUBLISH_DRY_RUN=1 node --experimental-strip-types scripts/publish-scoped.ts
 * Environment: runs inside the release workflow, authenticated by OIDC.
 *
 * `PUBLISH_DRY_RUN=1` builds every scratch tree, prints the exact manifest each
 * alias would publish, and stops before the first network call. The per-alias
 * transformations — the thin wrapper in particular — are otherwise only
 * observable after a real release.
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
    } else if (target === "@viztor/dsh-opencode") {
      manifest.deprecated =
        "Package renamed to dsh-opencode-patch. Please install dsh-opencode-patch instead: https://www.npmjs.com/package/dsh-opencode-patch";
      const existingDeps =
        (manifest.dependencies as Record<string, string> | undefined) ?? {};
      manifest.dependencies = {
        ...existingDeps,
        "dsh-opencode-patch": `^${version}`,
      };

      // Thin wrapper entrypoints that re-export dsh-opencode-patch directly
      const forwarder = [
        'export * from "dsh-opencode-patch";',
        'export { default } from "dsh-opencode-patch";',
      ].join("\n");
      writeFileSync(path.join(scratch, "lib", "index.mjs"), `${forwarder}\n`);
      writeFileSync(path.join(scratch, "lib", "index.d.mts"), `${forwarder}\n`);

      // The wrapper carries no client half of its own.
      //
      // Its patch forwards to the `dsh-opencode-patch` row, and that row's own
      // package supplies the browser bundle. Shipping a second copy here — the
      // manifest's whole-`lib` `files` entry copies it in — would hand the page
      // the same bundle twice under the same module ids, mounting the client
      // half twice. A ~38 kB duplicate in a package whose stated job is to
      // forward two lines is also simply not thin.
      const dsh = manifest.dsh as Record<string, unknown> | undefined;
      if (dsh !== undefined) delete dsh.client;
      const wrapperExports = manifest.exports as
        | Record<string, unknown>
        | undefined;
      if (wrapperExports !== undefined) delete wrapperExports["./client"];
      rmSync(path.join(scratch, "lib", "client.js"), { force: true });

      // Forwarding cordis patch to mount dsh-opencode-patch
      const forwarderPatch = [
        "# Thin wrapper patch forwarding to dsh-opencode-patch",
        "- insert:",
        "    - id: dsh-opencode-patch",
        '      name: "dsh-opencode-patch"',
      ].join("\n");
      writeFileSync(
        path.join(scratch, "cordis.patch.yml"),
        `${forwarderPatch}\n`
      );

      const redirectReadme = [
        "# @viztor/dsh-opencode (Renamed to dsh-opencode-patch)",
        "",
        "> ⚠️ **Notice**: This package has been renamed to [`dsh-opencode-patch`](https://www.npmjs.com/package/dsh-opencode-patch).",
        "",
        "This package is a **thin compatibility wrapper** that depends on and re-exports `dsh-opencode-patch`.",
        "",
        "### How to migrate:",
        "",
        "```sh",
        '# Via DSH Web UI (Recommended): Settings → Plugins → Install Plugin → "dsh-opencode-patch"',
        "",
        "# Or via terminal in your profile directory:",
        "npm install dsh-opencode-patch",
        "```",
      ].join("\n");
      writeFileSync(path.join(scratch, "README.md"), redirectReadme);
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
