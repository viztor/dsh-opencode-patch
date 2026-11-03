/**
 * Every host design token this package names, checked against the host's own.
 *
 * A CSS custom property the host does not define resolves to nothing, and the
 * declaration that used it silently falls back — so the card renders in the
 * wrong colour and nothing says so. That is how a warning came to be drawn in
 * the caption colour: `--dsw-alias-label-warning` reads like the other
 * `--dsw-alias-label-*` tokens and is not one of them — the primitives spell it
 * `--dsw-alias-state-warn-label` — and the
 * `var(--…, var(--dsw-alias-label-caption))` fallback made the mistake
 * invisible.
 *
 * **The token set is the primitives' own USE of them.** The primitives consume
 * the host's tokens rather than defining them, so the set of names they use is
 * the host's vocabulary: a name they use is one the host defines, and a name
 * they never use is either undefined or private to a subsystem the plugin is
 * not part of.
 *
 * **And every token the settings card names is in that vocabulary**, whether or
 * not it carries a fallback: the card and every file it renders that names a
 * token are scanned. Which token the mounted card renders for a warning is
 * asserted in settings-card-purge and settings-store-inspect. The meter
 * (`usage-ui.ts`, `usage-panel.tsx`, `usage-pill.tsx`) is left out: the card
 * does not render it, and it builds `--dsw-alias-state-…` names from a
 * template, which a plain scan would misread.
 *
 * @module test/host-tokens.test
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/** The primitives' own stylesheets, where the host's vocabulary shows up. */
const PRIMITIVES = join(
  process.cwd(),
  "node_modules/@deepseek-ai/dsh-client-ui-primitives"
);

/** Every file under `dir` with the given extension. */
const filesWith = (dir: string, extension: RegExp): string[] => {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".")) {
      continue;
    }
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      out.push(...filesWith(path, extension));
    } else if (extension.test(entry)) {
      out.push(path);
    }
  }
  return out;
};

/** The token names the primitives use — the host's vocabulary. */
const hostVocabulary = (): Set<string> => {
  const found = new Set<string>();
  for (const file of filesWith(PRIMITIVES, /\.css$/u)) {
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(/var\(\s*(--dsw-[a-z0-9-]+)/gu)) {
      found.add(match[1] ?? "");
    }
  }
  return found;
};

/**
 * The card files whose tokens are checked against the host's vocabulary. A file
 * that names no token (`settings-boolean-field.tsx`) is not listed, since the
 * scan treats an empty file as one it failed to read.
 */
const CARD_FILES = [
  "src/settings-card.tsx",
  "src/settings-store-inspect.tsx",
  "src/settings-usage.tsx",
  "src/settings-field-shell.tsx",
  "src/settings-choice-field.tsx",
];

const TOKEN = /--dsw-[\w-]+/gu;

describe("the host's design tokens", () => {
  it("never falls back from one token to another", () => {
    // A token the host does not define resolves to nothing. Where the
    // declaration carries a LITERAL fallback the element still renders — that
    // is fine, and `--dsw-radius-full` is the case (a pill: 999px).
    //
    // Where the fallback is another TOKEN, the declaration silently means
    // something else: `--dsw-alias-label-warning` fell back to the caption
    // colour, so a warning was drawn as caption text. That is the case this
    // test exists for, and it is why a token fallback is not a fallback.
    const vocabulary = hostVocabulary();
    const suspicious = new Map<string, string[]>();
    for (const file of filesWith(
      join(process.cwd(), "src"),
      /\.(?:ts|tsx)$/u
    )) {
      const text = readFileSync(file, "utf8");
      for (const match of text.matchAll(
        /var\(\s*(--dsw-[a-z0-9-]+)\s*,\s*(var\(--dsw-[a-z0-9-]+\))/gu
      )) {
        const token = match[1] ?? "";
        if (!vocabulary.has(token)) {
          suspicious.set(token, [...(suspicious.get(token) ?? []), file]);
        }
      }
    }

    expect(
      [...suspicious.keys()].map(
        (token) => `${token} (${suspicious.get(token)?.join(", ")})`
      ),
      "a token the host does not define, whose fallback is another token"
    ).toEqual([]);
  });

  it("names the warning colour the host actually defines", () => {
    // The one that shipped wrong: `--dsw-alias-label-warning` reads like the
    // other `--dsw-alias-label-*` tokens and is not one of them.
    const vocabulary = hostVocabulary();
    expect(vocabulary.has("--dsw-alias-state-warn-label")).toBe(true);
    expect(vocabulary.has("--dsw-alias-label-warning")).toBe(false);
  });

  it("every token the settings card names is one the host's primitives use", () => {
    const vocabulary = hostVocabulary();
    // A read of a directory that moved finds nothing, and "nothing" must not
    // read as "the token is absent".
    expect(vocabulary.size).toBeGreaterThan(0);

    for (const file of CARD_FILES) {
      const named = new Set(
        [
          ...readFileSync(join(process.cwd(), file), "utf8").matchAll(TOKEN),
        ].map((match) => match[0])
      );
      // A file that names no token at all is a scan that read nothing.
      expect(named.size, file).toBeGreaterThan(0);
      for (const token of named) {
        expect(vocabulary.has(token), `${file} names ${token}`).toBe(true);
      }
    }
  });
});
