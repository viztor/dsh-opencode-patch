/**
 * Every `--dsw-*` token the settings card names is one the host's design
 * language carries.
 *
 * A `var(--…)` the host never declares fails silently: the property falls back
 * to whatever it inherits, and a warning renders as ordinary text. That is how
 * `--dsw-alias-label-warning` shipped — the name appears nowhere in the host's
 * primitives, and its caption fallback hid that it resolved to nothing.
 *
 * A PROXY, stated as one: the tokens are DEFINED by the host theme
 * (`@deepseek-ai/dsh-client-ui-theme`, `design-platform.css`), which is not
 * installed here. The primitives' CSS modules are, and they USE the theme's
 * tokens (AGENTS.md: "start from the host's built-ins"), so the check reads
 * their usages. It can therefore fail if no primitive uses a token the theme
 * still defines, or pass on a token some primitive names that the theme
 * dropped. Point it at the theme's definitions once the theme is a
 * devDependency.
 *
 * The scan covers the card and every file it renders that names a token (the
 * store-inspect row, the usage summary, the field shell and the choice field);
 * which token the mounted card renders for a warning is asserted in
 * settings-card-purge and settings-store-inspect. The meter (`usage-ui.ts`,
 * `usage-panel.tsx`) is left to later work: it builds `--dsw-alias-state-…`
 * names from a template, which a plain scan would misread.
 *
 * @module test/host-tokens.test
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PRIMITIVES = join(
  ROOT,
  "node_modules/@deepseek-ai/dsh-client-ui-primitives/lib"
);

/**
 * The card files whose tokens are checked against the host's set. The card
 * itself stays first (the known-answer check below reads it); a file that
 * names no token (`settings-boolean-field.tsx`) is not listed, since the scan
 * treats an empty file as one it failed to read.
 */
const CARD_FILES = [
  "src/settings-card.tsx",
  "src/settings-store-inspect.tsx",
  "src/settings-usage.tsx",
  "src/settings-field-shell.tsx",
  "src/settings-choice-field.tsx",
];

const TOKEN = /--dsw-[\w-]+/gu;

/** Every `--dsw-*` token the primitives' CSS modules mention. */
const hostTokens = (): { files: string[]; tokens: Set<string> } => {
  const files = readdirSync(PRIMITIVES).filter((name) =>
    name.endsWith(".module.css")
  );
  const tokens = new Set<string>();
  for (const name of files) {
    const css = readFileSync(join(PRIMITIVES, name), "utf8");
    for (const match of css.matchAll(TOKEN)) {
      tokens.add(match[0]);
    }
  }
  return { files, tokens };
};

/** Every `--dsw-*` token a source file names. */
const tokensIn = (file: string): Set<string> =>
  new Set(
    [...readFileSync(join(ROOT, file), "utf8").matchAll(TOKEN)].map(
      (match) => match[0]
    )
  );

describe("host tokens", () => {
  it("every token the settings card names is one the host's primitives use", () => {
    const { files, tokens } = hostTokens();
    // A read of a directory that moved finds nothing, and "nothing" must not
    // read as "the token is absent".
    expect(files.length).toBeGreaterThan(0);
    // The known answer: the name that shipped is not a host token.
    expect(tokens.has("--dsw-alias-label-warning")).toBe(false);

    for (const file of CARD_FILES) {
      const named = tokensIn(file);
      // A file that names no token at all is a scan that read nothing.
      expect(named.size, file).toBeGreaterThan(0);
      for (const token of named) {
        expect(tokens.has(token), `${file} names ${token}`).toBe(true);
      }
    }
    expect(tokensIn(CARD_FILES[0] ?? "")).toContain(
      "--dsw-alias-state-warn-label"
    );
  });
});
