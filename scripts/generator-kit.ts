/**
 * What the two generators (`regenerate-catalog-shim.ts`, `generate-go-limits.ts`)
 * and `verify-catalog.ts` share: their arguments, how each reads its source,
 * and the ONE staleness rule.
 *
 * The rule used to be three. The catalog generator compared canonical data
 * but only its two arrays, so a moved plane or family endpoint read as
 * current; the limits generator compared file bytes, so a formatter's reflow
 * read as drift; `verify-catalog` compared id sets, so a changed price or
 * protocol on a kept id read as current. Now each asks `stale` over every
 * value it generates, and a difference in data is staleness, while key order
 * and formatting never are.
 *
 * Everything here but `readSource` is a function of its arguments
 * (`test/generators.test.ts`).
 *
 * @module scripts/generator-kit
 */
import { readFileSync } from "node:fs";

/** A generator's command line: whether to write, and a local source if given. */
export interface GeneratorArgs {
  readonly from?: string;
  readonly write: boolean;
}

/**
 * Read `--write` and `--from <path>`.
 *
 * @param argv - the arguments after the script's path.
 * @returns the parsed flags.
 * @throws {Error} when `--from` names no path: reading nothing must never pass for
 *   reading the registry.
 */
export const generatorArgs = (argv: readonly string[]): GeneratorArgs => {
  const at = argv.indexOf("--from");
  const write = argv.includes("--write");
  if (at === -1) {
    return { write };
  }
  const from = argv[at + 1];
  if (from === undefined || from.startsWith("--")) {
    throw new Error("--from needs the path of a local copy of the source");
  }
  return { from, write };
};

/**
 * Canonical form for comparison: object keys sorted at every depth.
 *
 * Needed because a parser builds an object in its own insertion order while a
 * renderer emits sorted keys, so a plain `JSON.stringify` compares equal data
 * as different and reports the file stale forever. Order is the renderer's
 * business, not the data's. `NaN` (a model with no published allowance)
 * reads as `null` on both sides, so it compares equal to itself.
 *
 * @param value - any JSON-shaped value.
 * @returns a string equal for equal data.
 */
export const canonical = (value: unknown): string => {
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .toSorted()
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
};

/**
 * The one staleness rule: what is shipped and what the source says differ in
 * data. Key order and formatting never count.
 *
 * @param current - what the generated file holds now.
 * @param next - what the source makes of it today.
 * @returns whether the generated file is stale.
 */
export const stale = (current: unknown, next: unknown): boolean =>
  canonical(current) !== canonical(next);

/**
 * What a generator does with its answer, and how it exits.
 *
 * Without `--write` a stale file is a failure (exit 1), which is what the
 * pull-request gate reads; with `--write` it is rewritten. A file whose data
 * is current is left untouched, with one exception for a generator that
 * renders the whole file: with `--write`, data that is current in TEXT that
 * is not the renderer's (`textCurrent: false`, a template change) is
 * `rewrite`, so the generator applies the template, never a hand. Without
 * `--write` that text is still `current`: a template is not vendor drift.
 *
 * @param input.stale - whether the file is stale.
 * @param input.textCurrent - whether the file's text is what the renderer
 *   makes of its data (default true: a generator that splices, as the
 *   catalog's does, has no text of its own to compare).
 * @param input.write - whether `--write` was given.
 * @returns the exit code and the action.
 */
export const outcome = ({
  stale: isStale,
  textCurrent = true,
  write,
}: {
  readonly stale: boolean;
  readonly textCurrent?: boolean;
  readonly write: boolean;
}): {
  readonly action: "current" | "report-stale" | "rewrite" | "write";
  readonly exit: 0 | 1;
} => {
  if (!isStale) {
    return write && !textCurrent
      ? { action: "rewrite", exit: 0 }
      : { action: "current", exit: 0 };
  }
  return write
    ? { action: "write", exit: 0 }
    : { action: "report-stale", exit: 1 };
};

/**
 * A generator's source text: the local file `from` names, else `url`
 * fetched with a timeout.
 *
 * @param input.from - a local copy of the source, the offline path.
 * @param input.url - the source.
 * @param input.timeoutMs - how long the fetch may take.
 * @returns the text.
 * @throws {Error} on an unreadable file or a non-ok answer, naming the status: a
 *   source that was not read is never answered as current.
 */
export const readSource = async ({
  from,
  timeoutMs,
  url,
}: {
  readonly from?: string;
  readonly timeoutMs: number;
  readonly url: string;
}): Promise<string> => {
  if (from !== undefined) {
    return readFileSync(from, "utf8");
  }
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) {
    throw new Error(
      `${new URL(url).host} answered ${response.status} ${response.statusText}`
    );
  }
  return response.text();
};
