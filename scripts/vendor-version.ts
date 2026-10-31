/**
 * The rules `check-vendor-version.ts` enforces, as functions of their input.
 *
 * The User-Agent is origin proof — the gateway reads it to decide whether the
 * caller is the official CLI — so the version it names has to be a version the
 * CLI actually has. It lives in one constant (`OPENCODE_CLI_VERSION`), and the
 * docs, the comments and the fixtures carry copies, because none of them can
 * import it.
 *
 * The scanning lived inside a top-level-await script, so nothing could exercise
 * the part that decides PASS, and this gate has already passed while wrong
 * twice: the first version could not see the constant at all (it only looked for
 * literals), and the second could not see a bare copy (it only looked for
 * `opencode/<version>`). Both were found by a control run, not by a test — which
 * is the reason this module exists.
 *
 * @module scripts/vendor-version
 */

/** The constant every other copy must agree with, read from `src/identity.ts`. */
export const PINNED_VERSION = /OPENCODE_CLI_VERSION\s*=\s*"(\d+\.\d+\.\d+)"/;

/** A literal that names the CLI: `opencode/1.19.5`. */
export const CLI_LITERAL = /\bopencode\/(\d+\.\d+\.\d+)\b/g;

/**
 * A bare (or `v`-prefixed) literal of the pinned SERIES: `1.19.5`, `v1.19.5`.
 *
 * The second form the scan needs. The `(?<!opencode/)` keeps it from matching
 * the same token twice, which would report every prefixed copy as two copies.
 *
 * @param pinned - the version the constant declares; its first two fields are
 * the series this pattern accepts.
 * @returns the pattern for a bare mention of that series.
 */
export const bareLiteral = (pinned: string): RegExp => {
  const series = pinned.split(".").slice(0, 2).join("\\.");
  return new RegExp(String.raw`(?<!opencode/)\bv?(${series}\.\d+)\b`, "g");
};

/**
 * The version the constant declares.
 *
 * @param identity - the text of `src/identity.ts`.
 * @returns the version, or `undefined` when the file carries no such constant.
 */
export const pinnedVersion = (identity: string): string | undefined =>
  PINNED_VERSION.exec(identity)?.[1];

/**
 * Every copy that disagrees with the constant.
 *
 * Two reasons to fail, and they are different failures: a copy that says another
 * version is stale even when the constant is current, and a constant that
 * disagrees with the published CLI means the whole claim is out of date. This
 * function only decides the first; the published comparison is the caller's.
 *
 * @param pinned - the version the constant declares.
 * @param copies - every `opencode/<version>` literal found, with the files that
 * say it.
 * @param mentions - every bare mention of the pinned series, with the files.
 * @returns one entry per disagreeing version, sorted by version.
 */
export const disagreements = (
  pinned: string,
  copies: ReadonlyMap<string, readonly string[]>,
  mentions: ReadonlyMap<string, readonly string[]>
): { readonly files: readonly string[]; readonly version: string }[] =>
  [...copies, ...mentions]
    .filter(([version]) => version !== pinned)
    .map(([version, files]) => ({ files, version }))
    .toSorted((left, right) => left.version.localeCompare(right.version));
