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

/**
 * The extensions a copy can live in. Listed because the scan is recursive and
 * would otherwise read every file under its roots.
 */
export const SCANNED_EXTENSIONS = /\.(?:ts|tsx|md|json|ya?ml)$/;

/**
 * Never scanned: the generated tables hold the vendor's data, not copies the
 * repository maintains, so a version-shaped string arriving in a refresh is not
 * a stale copy - and scanning them would let a vendor move fail the gate that
 * only the repository is supposed to be able to break. The same list as
 * `GENERATED_OUTPUTS` in `scripts/freshness-scope.ts`, kept here rather than
 * imported (an import would make that module an input of this check);
 * `test/freshness-scope.test.ts` ties the two.
 */
export const GENERATED_TABLES: ReadonlySet<string> = new Set([
  "src/catalog-data.ts",
  "src/go-limits-data.ts",
]);

/**
 * Whether the copy scan reads a file.
 *
 * @param path - the file's path relative to the repository root, as the scan
 * walks it (`src/identity.ts`, `README.md`).
 * @returns whether the file can hold a copy the repository maintains.
 */
export const scansFile = (path: string): boolean =>
  SCANNED_EXTENSIONS.test(path) && !GENERATED_TABLES.has(path);

/** The constant every other copy must agree with, read from `src/identity.ts`. */
export const PINNED_VERSION = /OPENCODE_CLI_VERSION\s*=\s*"(\d+\.\d+\.\d+)"/;

/**
 * A literal that names the CLI in the 1.x User-Agent form: `opencode/1.19.5`,
 * whatever follows it (`opencode/1.19.5/cli` is still a 1.x copy). The 2.x
 * form never matches: its first segment is a channel name, never a digit.
 */
export const CLI_LITERAL = /\bopencode\/(\d+\.\d+\.\d+)\b/g;

/**
 * A literal in the 2.x User-Agent form, `opencode/<channel>/<version>/<client>`:
 * a channel (`latest`, `dev`, `next`, ...), a semver version with an optional
 * prerelease, and the client that sent it (`cli`, ...). Captures the three
 * parts. A placeholder such as `opencode/<channel>/<version>/<client>` is
 * not one: every part must be a value.
 */
export const CLI_GENERATION_LITERAL =
  /\bopencode\/([a-z][a-z0-9-]*)\/(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\/([a-z][\w-]*)\b/g;

/**
 * A bare (or `v`-prefixed) literal of the pinned SERIES: `1.19.5`, `v1.19.5`.
 *
 * The second form the scan needs. The lookbehinds keep it from matching a
 * token the prefixed scans own, which would report every prefixed copy twice.
 *
 * @param pinned - the version the constant declares; its first two fields are
 * the series this pattern accepts.
 * @returns the pattern for a bare mention of that series.
 */
export const bareLiteral = (pinned: string): RegExp => {
  const series = pinned.split(".").slice(0, 2).join("\\.");
  // Neither the 1.x form (`opencode/<version>`) nor the version inside the
  // 2.x one (`opencode/<channel>/<version>`): each scan owns its own form.
  return new RegExp(
    String.raw`(?<!opencode/)(?<!opencode/[a-z][a-z0-9-]*/)\bv?(${series}\.\d+)\b`,
    "g"
  );
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

/**
 * One message per literal in the 2.x User-Agent form.
 *
 * No constant pins that generation: `OPENCODE_CLI_VERSION` is a 1.x version
 * and the plugin sends the 1.x form. A 2.x literal in the tree is therefore a
 * claim about what the CLI sends that nothing checks, the kind of copy this
 * gate exists to keep from drifting. The client-generation table that would
 * pin it is P7's (L6); until then such a literal is a placeholder, never a
 * value.
 *
 * @param found - each 2.x-form literal, with the files that say it.
 * @returns the messages, one per literal.
 */
export const unpinnedGenerationClaims = (
  found: ReadonlyMap<string, readonly string[]>
): string[] =>
  [...found].map(
    ([literal, files]) =>
      `${literal} in ${files.join(", ")}: no constant pins the 2.x User-Agent form, so it is a claim nothing checks (write opencode/<channel>/<version>/<client>)`
  );

/** What the registry publishes of the CLI: the stable line and the snapshots. */
export interface PublishedCli {
  /**
   * Each tag carrying a `0.0.0-<tag>-<stamp>` snapshot of its own name. Most
   * are feature-branch builds from the 1.x years (`snapshot-pnpm`, `ci`), and
   * only some (`dev`, `next`, `beta`) carry the 2.x line, so nothing about a
   * snapshot's generation or User-Agent format is read from its tag.
   */
  readonly snapshots: Readonly<Record<string, string>>;
  /** `latest`, the stable release. */
  readonly stable: string;
}

/**
 * Read `opencode-ai`'s dist-tags: `latest` as the stable release, and every
 * tag whose value is a snapshot of its own name (`dev` carries
 * `0.0.0-dev-<stamp>`). The 2.x line publishes that way, and so did 1.x's
 * feature branches, so the snapshots are listed and never classified: the
 * only generation claim is `pinVerdict`'s, on `latest`.
 *
 * @param distTags - the registry's `/-/package/opencode-ai/dist-tags` answer.
 * @returns the reading, or `undefined` when there is no plain `x.y.z`
 *   `latest`: a registry that said nothing usable is never read as current.
 */
export const publishedCli = (distTags: unknown): PublishedCli | undefined => {
  if (distTags === null || typeof distTags !== "object") {
    return undefined;
  }
  const tags = distTags as Record<string, unknown>;
  const { latest } = tags;
  if (typeof latest !== "string" || !/^\d+\.\d+\.\d+$/u.test(latest)) {
    return undefined;
  }
  // String operations, never a pattern built from a tag: a tag is the
  // registry's data, and `c++` or `a.b` must neither throw nor match loosely.
  const isSnapshotOf = (tag: string, value: string): boolean => {
    const prefix = `0.0.0-${tag}-`;
    return (
      value.startsWith(prefix) && /^\d+$/u.test(value.slice(prefix.length))
    );
  };
  const snapshots = Object.fromEntries(
    Object.entries(tags).filter(
      (entry): entry is [string, string] =>
        typeof entry[1] === "string" && isSnapshotOf(entry[0], entry[1])
    )
  );
  return { snapshots, stable: latest };
};

/**
 * The pin against what is published.
 *
 * @param pinned - `OPENCODE_CLI_VERSION`.
 * @param published - `publishedCli`'s reading.
 * @param files - the files that carry a copy, for the bump's message.
 * @returns `undefined` when the pin is `latest`; the bump when `latest` is
 *   another version on the pinned major; and a generation change when
 *   `latest` left the pinned major, because the User-Agent format moved with
 *   it and a version bump alone would claim a format the plugin does not send.
 */
export const pinVerdict = (
  pinned: string,
  published: PublishedCli,
  files: readonly string[] = []
): string | undefined => {
  const { stable } = published;
  if (stable === pinned) {
    return undefined;
  }
  if (stable.split(".")[0] !== pinned.split(".")[0]) {
    return `pinned opencode/${pinned}, and latest is ${stable}, which left the pinned major: that is a generation change, not a bump: the User-Agent format differs (opencode/<channel>/<version>/<client>), and the plugin claims the 1.x one`;
  }
  return `pinned opencode/${pinned}, published opencode/${stable} - bump OPENCODE_CLI_VERSION, and the ${files.length > 0 ? files.join(", ") : "docs"}`;
};
