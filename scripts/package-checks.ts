/**
 * Pure checks over the package's publish shape, shared by `scripts/check.ts`
 * (which asks only `libFreshness`: the gate keeps what needs a build) and the
 * unit tests (`test/package-checks.test.ts`, `test/toolchain.test.ts`,
 * `test/no-local-paths.test.ts`), which hold every other rule.
 *
 * Every function here is a function of its arguments — the caller reads
 * `package.json`, `release.yml`, the locales or a file's mtime, and these
 * decide — so a test can prove each answer on a fixture whose answer is known
 * before it trusts the answer on the real tree.
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

/**
 * Whether `lib/` carries the current build, as one rule: a missing artifact,
 * a half-built `lib/` (`vp pack` emits `client.cjs`, and the served
 * `client.js` comes from `scripts/name-client-bundle.ts`), or an artifact
 * older than the newest source.
 *
 * Not hypothetical: a `vp pack` whose output was discarded shipped a `lib/`
 * with no `client.js`, and nothing noticed. The host loads exactly these
 * files, so a build that failed looks like one that succeeded to everything
 * downstream.
 *
 * @param input.artifacts - each required artifact's mtime, `undefined` when
 *   the file is missing.
 * @param input.newestSource - the newest mtime under `src/`.
 * @param input.hasClientCjs - whether `lib/client.cjs` exists.
 * @returns the failure, or `undefined` when `lib/` is current.
 */
export const libFreshness = ({
  artifacts,
  hasClientCjs,
  newestSource,
}: {
  readonly artifacts: Readonly<Record<string, number | undefined>>;
  readonly hasClientCjs: boolean;
  readonly newestSource: number;
}): string | undefined => {
  const missing = Object.entries(artifacts)
    .filter(([, mtime]) => mtime === undefined)
    .map(([name]) => name);
  if (missing.length > 0) {
    const hint =
      hasClientCjs && missing.includes("client.js")
        ? " (lib/client.cjs exists — run scripts/name-client-bundle.ts)"
        : "";
    return (
      `lib/ is missing ${missing.join(", ")}${hint}; run \`pnpm run build\`. ` +
      "The host loads these files, so a build that failed looks exactly like one that succeeded"
    );
  }
  const builtAt = Math.min(
    ...Object.values(artifacts).map((mtime) => mtime ?? 0)
  );
  return builtAt < newestSource
    ? "lib/ is OLDER than src/ — the artifacts were not rebuilt from the current " +
        "source, which ships a plugin whose behaviour does not match its code; run `pnpm run build`"
    : undefined;
};

/**
 * Each peer range npm cannot use: empty, a pnpm-only protocol npm cannot
 * parse (so the install fails), or an exact pin (so a DSH patch release
 * orphans the plugin).
 *
 * @param peers - `package.json`'s `peerDependencies`.
 * @returns one message per bad peer, in declaration order.
 */
export const peerRangeProblems = (
  peers: Readonly<Record<string, unknown>>
): string[] =>
  Object.entries(peers).flatMap(([name, range]) => {
    if (typeof range !== "string" || range.trim() === "") {
      return [`peer ${name} has no usable range`];
    }
    if (/^(workspace|link|file|catalog):/u.test(range)) {
      return [
        `peer ${name} uses "${range.split(":")[0]}:" — npm cannot parse it, so install fails`,
      ];
    }
    if (!/^[\^~><=|*]/u.test(range.trim())) {
      return [
        `peer ${name} is pinned to "${range}" — a DSH patch release would orphan the plugin`,
      ];
    }
    return [];
  });

/** The credential shapes the tree must never carry, each with what it is. */
export const SECRET_PATTERNS: readonly (readonly [RegExp, string])[] = [
  [/\bmonid_live_[A-Za-z0-9]{10,}/u, "a Monid platform key"],
  [/\bsk-tinyfish-[A-Za-z0-9_-]{10,}/u, "a TinyFish key"],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/u, "a GitHub token"],
  [/sk-ant-[A-Za-z0-9_-]{10,}/u, "an Anthropic key"],
];

/**
 * What credentials a text carries, by kind.
 *
 * @param text - a file's contents.
 * @returns one description per pattern that matches (empty when none does).
 */
export const secretsIn = (text: string): string[] =>
  SECRET_PATTERNS.filter(([pattern]) => pattern.test(text)).map(
    ([, what]) => what
  );

/** The scripts that must reach the toolchain through `vp`. */
export const TOOLCHAIN_SCRIPTS: readonly string[] = [
  "build",
  "check",
  "format",
  "lint",
  "test",
];

/** A tool `vp` wraps, named directly: that bypasses the config `vp` reads. */
const UNBYPASSED = /(?:^|[\s(])(oxlint|oxfmt|tsdown|vitest|tsc)(?:[\s)]|$)/gu;

/**
 * Each toolchain script that is missing, does not go through `vp`, or reaches
 * past it for a tool `vp` wraps. `tsc` is the one tool `vp` does not wrap,
 * so a `vp` script may name it.
 *
 * @param scripts - `package.json`'s `scripts`.
 * @param names - the scripts to hold to the rule.
 * @returns one message per offending script.
 */
export const scriptsBypassingVp = (
  scripts: Readonly<Record<string, string | undefined>>,
  names: readonly string[] = TOOLCHAIN_SCRIPTS
): string[] =>
  names.flatMap((name) => {
    const script = scripts[name];
    if (script === undefined) {
      return [`no ${name} script`];
    }
    if (!/\bvp\b/u.test(script)) {
      return [`the ${name} script does not go through vp: ${script}`];
    }
    const bare = [...script.replaceAll(/\bvp\b\S*/gu, "").matchAll(UNBYPASSED)]
      .map((match) => match[1] ?? "")
      .filter((tool) => tool !== "tsc");
    return bare.length === 0
      ? []
      : [
          `the ${name} script reaches past vp for ${bare.join(", ")}; that bypasses the entry point that reads the config`,
        ];
  });

/**
 * Every leaf of a locale file as a dotted key path, so two locales can be
 * compared key for key: a key missing from one renders as the raw key.
 *
 * @param value - a parsed locale file, or any value within it.
 * @param prefix - the path to `value` (empty at the root).
 * @returns the leaf paths, in document order.
 */
export const localeKeyPaths = (value: unknown, prefix = ""): string[] =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
        localeKeyPaths(child, prefix === "" ? key : `${prefix}.${key}`)
      )
    : [prefix];

/**
 * An error's message, from any realm: an error thrown inside a `vm` context
 * is not an `instanceof Error` here.
 */
const messageOf = (error: unknown): string =>
  typeof error === "object" &&
  error !== null &&
  typeof (error as { message?: unknown }).message === "string"
    ? (error as { message: string }).message
    : String(error);

/**
 * The target of a host-module stand-in: a plain function, which both the
 * `apply` and the `construct` trap can wrap (an arrow function cannot be
 * constructed). Its body never runs; the traps answer instead.
 */
function standInTarget(): void {
  // Never called: the proxy's traps answer every call and construction.
}

/** One `window.__ModuleLoader__.load` call a client bundle makes. */
interface ClientRegistration {
  readonly factory?: (require: (name: string) => unknown) => unknown;
  readonly id?: unknown;
}

/**
 * What is wrong with a client bundle, read the way the web client loader
 * reads it: the bundle runs with a `window` whose module loader records each
 * registration, every expected id must be registered, and the first
 * registration's factory, called with a `require` that answers a stand-in for
 * any host module (callable, constructible, every property another stand-in),
 * must answer the expected `NS` and an `apply()`.
 *
 * `scripts/check.ts` runs it on the bundle the packed tarball installs;
 * `test/package-checks.test.ts` runs it on `lib/client.js` and on planted
 * bundles. The context runner is a parameter (`node:vm`'s
 * `runInNewContext`), so this stays a function of its arguments.
 *
 * @param source - the bundle's text.
 * @param expected.ids - the ids the bundle must register.
 * @param expected.ns - the `NS` its factory must answer.
 * @param runInContext - runs `source` with `sandbox` as its global object.
 * @returns one message per problem (empty when the bundle loads as the host
 *   loads it), and the host modules the factory asked for.
 */
export const clientBundleProblems = (
  source: string,
  expected: { readonly ids: readonly string[]; readonly ns: string },
  runInContext: (code: string, sandbox: Record<string, unknown>) => unknown
): { readonly asked: readonly string[]; readonly problems: string[] } => {
  const registered: ClientRegistration[] = [];
  const asked: string[] = [];
  try {
    runInContext(source, {
      window: {
        __ModuleLoader__: {
          load: (spec: ClientRegistration) => {
            registered.push(spec);
          },
        },
      },
    });
  } catch (error) {
    return {
      asked,
      problems: [`the client bundle threw while loading: ${messageOf(error)}`],
    };
  }
  const ids = registered.map((spec) => String(spec.id));
  const problems = expected.ids
    .filter((id) => !ids.includes(id))
    .map(
      (id) =>
        `the client bundle did not register ${id} (it registered ${ids.join(", ") || "nothing"})`
    );
  const factory = registered[0]?.factory;
  if (typeof factory !== "function") {
    return {
      asked,
      problems: [...problems, "the client bundle registered no factory"],
    };
  }
  const stand = (): unknown =>
    new Proxy(standInTarget, {
      apply: () => stand(),
      construct: () => stand() as object,
      get: (target, key) => {
        if (key === "prototype") {
          return target.prototype;
        }
        return typeof key === "symbol" ? undefined : stand();
      },
    });
  let client: unknown;
  try {
    client = factory((name) => {
      asked.push(name);
      return stand();
    });
  } catch (error) {
    return {
      asked,
      problems: [...problems, `the client factory threw: ${messageOf(error)}`],
    };
  }
  const { NS, apply } = (client ?? {}) as { NS?: unknown; apply?: unknown };
  if (NS !== expected.ns) {
    problems.push(`the client factory answered NS ${String(NS)}`);
  }
  if (typeof apply !== "function") {
    problems.push("the client factory answered no apply()");
  }
  return { asked, problems };
};
