/**
 * Which freshness checks a pull request is GATED on, and which it only REPORTS.
 *
 * The three freshness checks in CI's `catalog` job (`catalog:shim`,
 * `limits:shim`, `cli:version`) compare something checked in against something
 * the vendor publishes, and the vendor moves most days. A check that fails
 * every open pull request on each move blames the pull request for the
 * vendor's change, and a red that is never the reader's fault is one the
 * reader learns to skip.
 *
 * What the gate exists for is an OMISSION: someone changes a generator (or the
 * parser it calls) and forgets to regenerate. That is a fact about the pull
 * request's own diff, so the diff decides: a check GATES when the diff touches
 * one of its INPUTS, and REPORTS (a warning, exit 0) otherwise.
 *
 * The inputs are code, never output. A check's inputs are its script and every
 * local module the script loads, transitively, read from the sources rather
 * than listed by hand - so adding an import to a generator moves its inputs
 * without anyone remembering to. The edges are the ones Node would load: types
 * erased by Node's own stripper, specifiers read by a real lexer, so a
 * type-only import is no edge and a string that only looks like an import is
 * none either (`importSpecifiers`). The two generated files are never inputs: a
 * pull request that only carries a refresh must report drift, not fail on it.
 * A pull request that edits a generated file without touching what generates
 * it is still named, in a warning (`handEditedOutputs`), because a hand-edit
 * is forbidden (AGENTS.md) and should stay visible.
 *
 * Everything exported is a function of its arguments - the file reader is a
 * parameter - so the decision is testable without a filesystem or a diff. The
 * CLI at the bottom is the effect half:
 *
 * ```sh
 * git diff --name-only HEAD^1 HEAD \
 *   | node --experimental-strip-types --disable-warning=ExperimentalWarning \
 *       scripts/freshness-scope.ts catalog:shim
 * # prints "gate" or "report" on stdout; any hand-edit warning goes to stderr
 * ```
 *
 * No network: it reads the changed-file list and the repository's sources.
 */

import { readFileSync, realpathSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { dirname, join, normalize, resolve } from "node:path/posix";
import { fileURLToPath } from "node:url";

import { initSync, parse } from "es-module-lexer";

/** The three checks, by the `package.json` script that runs each. */
export type FreshnessCheck = "catalog:shim" | "cli:version" | "limits:shim";

/** What the diff decides for one check. */
export type FreshnessScope = "gate" | "report";

/** One check: the script it runs, inputs it reads as data, and what it generates. */
export interface FreshnessCheckSpec {
  /** The script the check runs; the import walk starts here. */
  readonly entry: string;
  /**
   * Inputs the script reads as data rather than importing, so the import walk
   * cannot see them. `check-vendor-version.ts` reads the pinned version out of
   * `src/identity.ts` with a regular expression.
   */
  readonly dataInputs: readonly string[];
  /** The generated files the check compares, and its `--write` rewrites. */
  readonly outputs: readonly string[];
}

/**
 * Every generated file. Never an input, whichever import reaches it.
 * `check-vendor-version.ts` keeps its own copy of this list (it skips these in
 * its copy scan, since they hold vendor data, not copies the repository
 * maintains) rather than importing it, which would make this module one of its
 * inputs; `test/freshness-scope.test.ts` ties the two.
 */
export const GENERATED_OUTPUTS: readonly string[] = [
  "src/catalog-data.ts",
  "src/go-limits-data.ts",
];

export const FRESHNESS_CHECKS: Readonly<
  Record<FreshnessCheck, FreshnessCheckSpec>
> = {
  "catalog:shim": {
    dataInputs: [],
    entry: "scripts/regenerate-catalog-shim.ts",
    outputs: ["src/catalog-data.ts"],
  },
  "cli:version": {
    dataInputs: ["src/identity.ts"],
    entry: "scripts/check-vendor-version.ts",
    outputs: [],
  },
  "limits:shim": {
    dataInputs: [],
    entry: "scripts/generate-go-limits.ts",
    outputs: ["src/go-limits-data.ts"],
  },
};

export const isFreshnessCheck = (value: string): value is FreshnessCheck =>
  Object.hasOwn(FRESHNESS_CHECKS, value);

/**
 * Every module specifier one source LOADS, as Node would load it: the source's
 * types erased by Node's own stripper (`stripTypeScriptTypes`, the same
 * erasure `--experimental-strip-types` applies when the generator runs), and
 * the specifiers read off the result by a real lexer (`es-module-lexer`), not
 * by a pattern.
 *
 * Both halves matter. The stripper decides what is type-only: a whole-statement
 * `import type …` or `export type … from` is erased, so the module is never
 * loaded and cannot change what the generator emits (`test/architecture.test.ts`
 * skips these edges for the client graph on the same ground); an inline
 * `import { type A }` strips to `import {}`, which still loads the module, so
 * it IS an edge. The lexer knows strings, templates, regular expressions and
 * comments: a `"docs/*"` string or a `/\/*$/u` regex cannot open a fake
 * comment that hides the import after it, and an import written inside a
 * template is text, not an edge. A hand-written pattern got both wrong, and a
 * missed edge is the dangerous direction - it turns a gate into a report.
 *
 * Throws on a source Node itself could not load in strip mode (an `enum`, a
 * `namespace`): every input runs under that flag, so such a file would break
 * the generator first, and a throw fails the scope step closed rather than
 * reporting a walk that stopped early. A type error in a skipped file is
 * `pnpm run check`'s to catch, not freshness's. A dynamic `import()` whose
 * argument is not a string literal names no file and is skipped. Only module
 * source belongs here: `inputsOf` never hands it a JSON file or other data a
 * generator imports, and names the file when this throws.
 */
export const importSpecifiers = (source: string): string[] => {
  initSync();
  const [imports] = parse(stripTypeScriptTypes(source));
  return [
    ...new Set(
      imports.flatMap((entry) => (entry.n === undefined ? [] : [entry.n]))
    ),
  ];
};

/**
 * The extensions Node parses as JavaScript or TypeScript modules. Any other
 * local file a generator imports (`../package.json` with a JSON import
 * attribute) is data: an input, but a leaf, never lexed.
 */
const MODULE_EXTENSION = /\.(?:[cm]?[jt]s|tsx)$/u;

/** Reads one repository-relative path, or answers `undefined` when there is no such file. */
export type SourceReader = (path: string) => string | undefined;

/**
 * The repository-relative file a LOCAL specifier names, from the importing
 * file's own directory - or `undefined` for a package, a built-in, or a
 * specifier that names no file in the tree.
 */
export const resolveLocalImport = (
  importer: string,
  specifier: string,
  read: SourceReader
): string | undefined => {
  if (!specifier.startsWith("./") && !specifier.startsWith("../")) {
    return undefined;
  }
  const base = normalize(join(dirname(importer), specifier));
  const candidates = [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`];
  return candidates.find((candidate) => read(candidate) !== undefined);
};

/**
 * A check's inputs: its entry, every local module the entry reaches through
 * its imports, and its data inputs - minus the generated files, which are
 * neither walked nor counted. A reached file that is not module source (a
 * JSON import) counts as an input and is not walked further. Sorted,
 * repository-relative.
 *
 * Throws when the entry cannot be read: an empty walk would answer "touches
 * nothing", which reports a change that should have gated. Throws, naming the
 * file, when a reached module cannot be stripped (`importSpecifiers`).
 */
export const inputsOf = (
  check: FreshnessCheck,
  read: SourceReader
): string[] => {
  const spec = FRESHNESS_CHECKS[check];
  if (read(spec.entry) === undefined) {
    throw new Error(
      `${check}: cannot read ${spec.entry} - the walk read nothing, which is not the same as no inputs`
    );
  }
  const generated = new Set(GENERATED_OUTPUTS);
  const seen = new Set<string>();
  const pending = [spec.entry];
  while (pending.length > 0) {
    const file = pending.pop();
    if (file === undefined || seen.has(file) || generated.has(file)) {
      continue;
    }
    seen.add(file);
    if (!MODULE_EXTENSION.test(file)) {
      continue;
    }
    let specifiers: string[];
    try {
      specifiers = importSpecifiers(read(file) ?? "");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`${file}: ${message}`, { cause: error });
    }
    for (const specifier of specifiers) {
      const target = resolveLocalImport(file, specifier, read);
      if (target !== undefined) {
        pending.push(target);
      }
    }
  }
  for (const data of spec.dataInputs) {
    if (!generated.has(data)) {
      seen.add(data);
    }
  }
  return [...seen].toSorted();
};

/** One changed-file list, as `git diff --name-only` prints it. */
export const parseChangedFiles = (text: string): string[] =>
  text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line !== "");

/** GATE when the diff touches an input, REPORT otherwise. */
export const scopeFor = (
  changedFiles: readonly string[],
  inputs: readonly string[]
): FreshnessScope => {
  const wanted = new Set(inputs);
  return changedFiles.some((file) => wanted.has(file)) ? "gate" : "report";
};

/**
 * The check's generated files the diff changed while touching none of its
 * inputs - a refresh, or a hand-edit; either way worth naming. Empty when the
 * check gates: a generator change is expected to carry its regenerated output.
 */
export const handEditedOutputs = (
  check: FreshnessCheck,
  changedFiles: readonly string[],
  inputs: readonly string[]
): string[] => {
  if (scopeFor(changedFiles, inputs) === "gate") {
    return [];
  }
  const changed = new Set(changedFiles);
  return FRESHNESS_CHECKS[check].outputs.filter((output) =>
    changed.has(output)
  );
};

/** The GitHub annotation that names one such file. */
export const handEditWarning = (
  check: FreshnessCheck,
  output: string
): string =>
  `::warning file=${output}::${output} changed, but nothing that generates it did (${FRESHNESS_CHECKS[check].entry} and its imports). It is generated: a refresh carries it, a hand-edit is forbidden (AGENTS.md). Regenerate with 'pnpm run ${check} -- --write' if this was not one.`;

/** Reads a repository-relative path under `root`, or `undefined`. */
const fileReader =
  (root: string): SourceReader =>
  (path: string): string | undefined => {
    try {
      return readFileSync(resolve(root, path), "utf8");
    } catch {
      return undefined;
    }
  };

const main = (): void => {
  const check = process.argv[2] ?? "";
  if (!isFreshnessCheck(check)) {
    process.stderr.write(
      `usage: freshness-scope.ts <${Object.keys(FRESHNESS_CHECKS).join("|")}> < changed-files\n`
    );
    process.exit(2);
  }
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const changed = parseChangedFiles(readFileSync(0, "utf8"));
  const inputs = inputsOf(check, fileReader(root));
  for (const output of handEditedOutputs(check, changed, inputs)) {
    process.stderr.write(`${handEditWarning(check, output)}\n`);
  }
  process.stdout.write(`${scopeFor(changed, inputs)}\n`);
};

/** The real path of `path`, or `undefined` when there is none to resolve. */
const realPath = (path: string | undefined): string | undefined => {
  if (path === undefined) {
    return undefined;
  }
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
};

// Run only as a script, never on import (the tests import the functions above).
// Both sides are real paths: Node realpaths the main module's URL but only
// resolves `argv[1]`, so a plain comparison misses an absolute invocation
// through a symlink, and the CLI would print nothing and exit 0.
const invoked = realPath(process.argv[1]);
if (
  invoked !== undefined &&
  invoked === realPath(fileURLToPath(import.meta.url))
) {
  main();
}
