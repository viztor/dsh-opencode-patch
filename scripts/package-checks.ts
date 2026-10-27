/**
 * Pure checks over the package's publish shape, shared by `scripts/check.ts`
 * and `test/package-checks.test.ts`.
 *
 * Every function here is a function of its arguments — the caller reads
 * `package.json` and `release.yml`, and these decide — so the test can prove
 * each answer on a fixture whose answer is known before it trusts the answer
 * on the real tree.
 *
 * @module scripts/package-checks
 */

/**
 * Every string target of an `exports` value, in declaration order: a bare
 * string, a subpath map and nested condition objects all flatten to strings.
 *
 * @param exports - `package.json`'s `exports`, as parsed.
 * @returns the targets, such as `./lib/index.mjs`.
 */
export const exportTargets = (exports: unknown): string[] => {
  if (typeof exports === "string") {
    return [exports];
  }
  if (exports === null || typeof exports !== "object") {
    return [];
  }
  return Object.values(exports).flatMap((value: unknown) =>
    exportTargets(value)
  );
};

/** A `files` glob as a whole-path pattern: `*` stays inside one segment. */
const globPattern = (entry: string): RegExp =>
  new RegExp(
    `^${entry
      .split("*")
      .map((part) => part.replaceAll(/[.+?^${}()|[\]\\]/gu, String.raw`\$&`))
      .join("[^/]*")}$`,
    "u"
  );

/**
 * Whether npm packs `target` under this `files` allowlist.
 *
 * Deliberately no more of npm than the package uses: an entry equal to the
 * target, a directory entry that is a prefix of it (`lib` covers
 * `lib/index.mjs`), and a glob entry (`*` within one segment) that matches it —
 * or equals it, for an `exports` subpath pattern such as `./locale/*.json`.
 * `package.json` is always packed. A target with a `*` that no glob entry
 * equals is outside: a subpath pattern resolves to files the allowlist has to
 * name the same way.
 *
 * @param target - an `exports` target, usually `./`-relative.
 * @param files - `package.json`'s `files`.
 * @returns `true` when the tarball carries the target.
 */
export const coveredByFiles = (
  target: string,
  files: readonly string[]
): boolean => {
  const path = target.replace(/^\.\//u, "");
  if (path === "package.json") {
    return true;
  }
  return files.some((raw) => {
    const entry = raw.replace(/^\.\//u, "").replace(/\/$/u, "");
    if (entry === path) {
      return true;
    }
    if (entry.includes("*")) {
      return !path.includes("*") && globPattern(entry).test(path);
    }
    return !path.includes("*") && path.startsWith(`${entry}/`);
  });
};

/**
 * The `exports` targets the published tarball does not carry. Each one
 * resolves in this repository and fails with ENOENT in every install.
 *
 * @param pkg - the parsed `package.json`.
 * @returns the uncovered targets, in `exports` order.
 */
export const exportsOutsideFiles = (pkg: {
  readonly exports?: unknown;
  readonly files?: readonly string[];
}): string[] =>
  exportTargets(pkg.exports).filter(
    (target) => !coveredByFiles(target, pkg.files ?? [])
  );

/**
 * The package names release.yml's verify step polls, read off its
 * `pending="name@$VER …"` line.
 *
 * @param releaseYml - the workflow's text.
 * @returns the names with `@$VER` stripped, or `undefined` unless there is
 *   exactly one such line — absent, or ambiguous because a second list
 *   elsewhere in the workflow could be the one read. The caller must treat
 *   `undefined` as a failure, never as an empty list that agrees with nothing.
 */
export const releasePendingTargets = (
  releaseYml: string
): string[] | undefined => {
  const lines = [...releaseYml.matchAll(/^\s*pending="([^"]*)"/gmu)];
  const line = lines.length === 1 ? lines[0]?.[1] : undefined;
  if (line === undefined) {
    return undefined;
  }
  return line
    .split(/\s+/u)
    .filter((entry) => entry !== "")
    .map((entry) => entry.replace(/@\$VER$/u, ""));
};

/**
 * Where the published list and the verified list disagree, one message per
 * name that is in one and not the other.
 *
 * @param published - what the release publishes.
 * @param verified - what the verify step polls for.
 * @returns the messages; empty when the lists hold the same names.
 */
export const publishListMismatch = (
  published: readonly string[],
  verified: readonly string[]
): string[] => [
  ...published
    .filter((name) => !verified.includes(name))
    .map(
      (name) =>
        `${name} is published but release.yml's verify step never checks it`
    ),
  ...verified
    .filter((name) => !published.includes(name))
    .map(
      (name) =>
        `${name} is verified by release.yml but nothing publishes it, so every release fails on it`
    ),
];
