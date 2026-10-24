/**
 * Refuse to run the suite on a Node the package does not support.
 *
 * `package.json` declares `engines.node`, and several cases depend on what that
 * floor guarantees: `node:sqlite` unflagged, `Intl.DurationFormat`, and ICU data
 * new enough to agree with the strings the tests pin. Below the floor those cases
 * do not fail for a reason anyone could act on — they fail as a bundling error in
 * an unrelated jsdom file and as a unit word that differs by one character, which
 * reads as a regression in the code under test.
 *
 * So the run stops before collecting a single file and names the real cause.
 * The floor is read from `package.json`, not restated, so raising it there is the
 * whole of raising it here.
 *
 * @module test/support/node-engine
 */
import { readFileSync } from "node:fs";

/**
 * The lowest major a `>=N` range admits, or `undefined` for any other shape.
 *
 * Deliberately narrow: `engines.node` is a single `>=` floor in this package,
 * and a range this cannot read is reported rather than guessed at.
 *
 * @param range - the `engines.node` value.
 * @returns the floor's major version.
 */
export const floorMajorOf = (range: unknown): number | undefined => {
  if (typeof range !== "string") {
    return undefined;
  }
  const match = /^\s*>=\s*(\d+)(?:\.\d+){0,2}\s*$/u.exec(range);
  return match?.[1] === undefined ? undefined : Number(match[1]);
};

/**
 * Why this Node cannot run the suite, or `undefined` when it can.
 *
 * @param version - `process.versions.node`.
 * @param range - `engines.node` from `package.json`.
 * @returns a message naming the version found and the floor required.
 */
export const engineRefusal = (
  version: string,
  range: unknown
): string | undefined => {
  const floor = floorMajorOf(range);
  if (floor === undefined) {
    return `engines.node is ${JSON.stringify(range)}, which this guard cannot read; expected a single ">=N" floor`;
  }
  const major = Number(version.split(".")[0]);
  if (!Number.isFinite(major) || major < floor) {
    return (
      `this suite needs Node ${String(range)} (package.json engines.node) and is running on ${version}. ` +
      "Below the floor, cases fail for engine reasons — a missing node:sqlite or Intl.DurationFormat — " +
      "that read like regressions. Switch Node (the version CI uses is in .node-version) and re-run."
    );
  }
  return undefined;
};

/** Vitest `globalSetup`: runs once, before any test file is collected. */
export default function setup(): void {
  const pkg: unknown = JSON.parse(
    readFileSync(new URL("../../package.json", import.meta.url), "utf8")
  );
  const range =
    typeof pkg === "object" && pkg !== null
      ? (pkg as { engines?: { node?: unknown } }).engines?.node
      : undefined;
  const refusal = engineRefusal(process.versions.node, range);
  if (refusal !== undefined) {
    throw new Error(refusal);
  }
}
