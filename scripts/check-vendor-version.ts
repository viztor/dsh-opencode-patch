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
 *  1. the constant, read from `src/identity.ts`, against the published CLI;
 *  2. every other literal `opencode/<version>` in the tree, against the
 *     constant - a copy that drifts from the constant is stale even when the
 *     constant is current.
 *
 * The first version of this script only scanned for literals, which meant it
 * could not see the constant at all: the whole point was invisible to it. It
 * passed while the constant said 1.18.33, and only a control run showed it.
 */

import { readdir, readFile } from "node:fs/promises";

/** Where a copy may appear. Extensions are listed because the scan is recursive. */
const ROOTS = ["src", "test", "docs", "scripts", "README.md"];
const EXTENSIONS = /\.(?:ts|tsx|md|json|ya?ml)$/;

/** The constant every other copy must agree with. */
const CONSTANT = /OPENCODE_CLI_VERSION\s*=\s*"(\d+\.\d+\.\d+)"/;
const CONSTANT_FILE = "src/identity.ts";

/** A literal that names the CLI. */
const LITERAL = /\bopencode\/(\d+\.\d+\.\d+)\b/g;

/** Every literal version found, and the files that say it. */
const literals = async (): Promise<Map<string, string[]>> => {
  const found = new Map<string, string[]>();
  const record = (path: string, text: string): void => {
    for (const match of text.matchAll(LITERAL)) {
      const version = match[1] ?? "";
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
      if (EXTENSIONS.test(path)) {
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
  const pinned = CONSTANT.exec(identity)?.[1];
  if (pinned === undefined) {
    throw new Error(
      `no OPENCODE_CLI_VERSION in ${CONSTANT_FILE} - the check read nothing, which is not the same as passing`
    );
  }

  const copies = await literals();
  const disagree = [...copies].filter(([version]) => version !== pinned);
  if (disagree.length > 0) {
    const detail = disagree
      .map(([version, files]) => `  ${version} in ${files.join(", ")}`)
      .join("\n");
    throw new Error(
      `these copies do not say ${pinned}, which is what ${CONSTANT_FILE} declares:\n${detail}`
    );
  }

  const response = await fetch("https://registry.npmjs.org/opencode-ai/latest");
  if (!response.ok) {
    throw new Error(`the registry answered ${response.status} for opencode-ai`);
  }
  const published = ((await response.json()) as { version?: string }).version;
  if (published === undefined) {
    throw new Error("the registry response carried no version");
  }
  if (pinned !== published) {
    throw new Error(
      `pinned opencode/${pinned}, published opencode/${published} - bump OPENCODE_CLI_VERSION, and the ${copies.size > 0 ? [...copies.values()].flat().join(", ") : "docs"}`
    );
  }
  process.stdout.write(
    `ok   opencode/${pinned} is the published version, and ${[...copies.values()].flat().length} copy/copies agree\n`
  );
};

await main();
