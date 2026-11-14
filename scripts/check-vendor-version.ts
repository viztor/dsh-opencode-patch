/**
 * The CLI version this plugin claims to be, against the one the vendor ships.
 *
 * The User-Agent is origin proof: the gateway reads it to decide whether the
 * caller is the official CLI, so it has to name a version the CLI actually has.
 * It lives in one constant, `OPENCODE_CLI_VERSION`, and the docs cannot import
 * that constant, so they carry a copy.
 *
 * Two things are checked, and they fail for different reasons:
 *
 *  1. the constant, read from `src/identity.ts`, against the published CLI -
 *     `latest` among the registry's dist-tags, which is the 1.x line this
 *     plugin claims. A `latest` that left the pinned major is named as a
 *     generation change, not a bump: the 2.x line sends another User-Agent
 *     format (`opencode/<channel>/<version>/<client>`). The snapshot builds
 *     under dist-tags (`0.0.0-<tag>-<stamp>`: the 2.x line's `dev`, `next`
 *     and `beta`, and many older 1.x feature branches) are listed as not
 *     claimed, with no format asserted for any of them;
 *  2. every other copy in the tree, against the constant - a copy that drifts
 *     from the constant is stale even when the constant is current - and no
 *     literal in the 2.x form at all, since no constant pins that generation
 *     (a concrete one is a claim nothing checks; write the placeholder).
 *
 * The copy scan reads two forms, because a copy is not always prefixed: the
 * `opencode/<version>` literal, and a bare (or `v`-prefixed) literal of the
 * constant's own series - a comment, a tag reference.
 *
 * The first version of this script only scanned for literals, which meant it
 * could not see the constant at all: the whole point was invisible to it. It
 * passed while the constant said 1.18.33, and only a control run showed it.
 * The second version only scanned `opencode/<version>`, which meant a bare copy
 * was invisible to it: it passed while three e2e comments were two patches
 * stale.
 *
 * `--copies` runs the second check alone and stops before the registry. That
 * half is offline and reads only files the repository maintains (the generated
 * tables, which hold vendor data, are skipped), so only the repository can
 * break it, and CI gates every pull request on it. The first half follows the
 * vendor, and gates only a pull request that touches the pin or this script
 * (`scripts/freshness-scope.ts` decides).
 *
 * A failure prints one `error: <cause>` line first (the detail after it), so a
 * CI step that only warns can quote the cause rather than guess it.
 *
 * `--registry <url>` reads another registry (default the public one), which
 * is how the mock suite serves it a known answer.
 */

import { readdir, readFile } from "node:fs/promises";

import {
  bareLiteral,
  CLI_GENERATION_LITERAL,
  CLI_LITERAL as LITERAL,
  disagreements,
  pinnedVersion,
  pinVerdict,
  publishedCli,
  scansFile,
  unpinnedGenerationClaims,
} from "./vendor-version.ts";

/** Where a copy may appear; `scansFile` decides which files under them are read. */
const ROOTS = ["src", "test", "docs", "scripts", "README.md"];

const CONSTANT_FILE = "src/identity.ts";

const flag = process.argv.indexOf("--registry");
const REGISTRY = (
  flag === -1 ? "https://registry.npmjs.org" : (process.argv[flag + 1] ?? "")
).replace(/\/+$/u, "");

/**
 * Every literal found, keyed by `key` (the version, by default), and the
 * files that say it.
 */
const literals = async (
  pattern: RegExp,
  key: (match: RegExpMatchArray) => string = (match) => match[1] ?? ""
): Promise<Map<string, string[]>> => {
  const found = new Map<string, string[]>();
  const record = (path: string, text: string): void => {
    for (const match of text.matchAll(pattern)) {
      const version = key(match);
      found.set(version, [...(found.get(version) ?? []), path]);
    }
  };
  const visit = async (path: string): Promise<void> => {
    try {
      for (const entry of await readdir(path, { withFileTypes: true })) {
        await visit(`${path}/${entry.name}`);
      }
    } catch {
      // Not a directory, so read it as a file when it is one we scan.
      if (scansFile(path)) {
        record(path, await readFile(path, "utf8"));
      }
    }
  };
  for (const root of ROOTS) {
    await visit(root);
  }
  return found;
};

const main = async (): Promise<void> => {
  const identity = await readFile(CONSTANT_FILE, "utf8");
  const pinned = pinnedVersion(identity);
  if (pinned === undefined) {
    throw new Error(
      `no OPENCODE_CLI_VERSION in ${CONSTANT_FILE} - the check read nothing, which is not the same as passing`
    );
  }

  const copies = await literals(LITERAL);
  const mentions = await literals(bareLiteral(pinned));
  const disagree = disagreements(pinned, copies, mentions);
  if (disagree.length > 0) {
    const detail = disagree
      .map(({ files, version }) => `  ${version} in ${files.join(", ")}`)
      .join("\n");
    throw new Error(
      `these copies do not say ${pinned}, which is what ${CONSTANT_FILE} declares:\n${detail}`
    );
  }
  const claims = unpinnedGenerationClaims(
    await literals(CLI_GENERATION_LITERAL, (match) => match[0])
  );
  if (claims.length > 0) {
    throw new Error(
      `these User-Agent literals use the 2.x form, which no constant pins:\n${claims.map((claim) => `  ${claim}`).join("\n")}`
    );
  }
  if (process.argv.includes("--copies")) {
    process.stdout.write(
      `ok   ${[...copies.values()].flat().length} copy/copies and ${[...mentions.values()].flat().length} bare mention/mentions say ${pinned}, as ${CONSTANT_FILE} does (registry not asked)\n`
    );
    return;
  }

  const response = await fetch(`${REGISTRY}/-/package/opencode-ai/dist-tags`);
  if (!response.ok) {
    throw new Error(`the registry answered ${response.status} for opencode-ai`);
  }
  const published = publishedCli(await response.json());
  if (published === undefined) {
    throw new Error(
      "the registry's dist-tags carried no x.y.z `latest` for opencode-ai"
    );
  }
  const files = [...new Set([...copies.values(), ...mentions.values()].flat())];
  const verdict = pinVerdict(pinned, published, files);
  if (verdict !== undefined) {
    throw new Error(verdict);
  }
  process.stdout.write(
    `ok   opencode/${pinned} is the published version, and ${[...copies.values()].flat().length} copy/copies and ${[...mentions.values()].flat().length} bare mention/mentions agree\n`
  );
  const snapshots = Object.entries(published.snapshots);
  process.stdout.write(
    snapshots.length === 0
      ? "note no snapshot build is published under a dist-tag\n"
      : `note snapshot builds under dist-tags, their generation and User-Agent format not read from the tag (not claimed): ${snapshots.map(([tag, version]) => `${tag} ${version}`).join(", ")}\n`
  );
};

try {
  await main();
} catch (error) {
  // The cause, not a stack: every failure above is a sentence written for the
  // reader, and the line a warning step quotes.
  process.stderr.write(
    `error: ${error instanceof Error ? error.message : String(error)}\n`
  );
  process.exitCode = 1;
}
