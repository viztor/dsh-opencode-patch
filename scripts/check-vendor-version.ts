/**
 * The CLI version this plugin claims to be, against the one the vendor ships.
 *
 * The User-Agent is origin proof: the gateway reads it to decide whether the
 * caller is the official CLI, so it has to name a version the CLI actually has.
 * It is a hand-copied constant, which means it drifts every time OpenCode
 * releases, and nothing notices: a stale patch version still looks like a
 * version, and the gateway does not announce which ones it accepts.
 *
 * This compares every copy in the tree against the vendor's published version,
 * so the drift is a build result rather than a surprise. Copies are checked for
 * agreement with each other too, because three hand-written strings are three
 * chances to disagree.
 */

import { readFile } from "node:fs/promises";

/** Every file that names the CLI version, and what it is for. */
const COPIES = [
  ["src/session.ts", "the injected User-Agent"],
  ["src/usage.ts", "the usage request"],
  ["test/e2e/protocol-routing.e2e.ts", "the live probes"],
  ["test/usage-service.test.ts", "the assertion on it"],
  ["docs/deep-dive.md", "the header matrix"],
] as const;

const VERSION = /\bopencode\/(\d+\.\d+\.\d+)\b/g;

const main = async (): Promise<void> => {
  const found = new Map<string, string[]>();
  for (const [file] of COPIES) {
    const text = await readFile(file, "utf8");
    for (const match of text.matchAll(VERSION)) {
      const version = match[1] ?? "";
      found.set(version, [...(found.get(version) ?? []), file]);
    }
  }

  if (found.size === 0) {
    throw new Error(
      `no opencode/<version> string found in ${COPIES.map(([f]) => f).join(", ")} - the check read nothing, which is not the same as passing`
    );
  }
  if (found.size > 1) {
    const detail = [...found]
      .map(([v, files]) => `  ${v}: ${files.join(", ")}`)
      .join("\n");
    throw new Error(`the copies disagree about the CLI version:\n${detail}`);
  }

  const [pinned] = [...found.keys()];
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
      `pinned opencode/${pinned}, published opencode/${published} - bump ${COPIES.map(([f]) => f).join(", ")}`
    );
  }
  process.stdout.write(`ok   opencode/${pinned} is the published version\n`);
};

await main();
