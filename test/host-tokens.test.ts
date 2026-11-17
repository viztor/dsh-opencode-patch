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
 * **And every token the card or the meter names is in that vocabulary**,
 * whether or not it carries a fallback: every `src/settings-*` and
 * `src/usage-*` module is scanned, comments included, so a prose comment names
 * whole tokens too (a wildcard such as a family name ending in a hyphen reads
 * as a name the host does not define). The list is a directory read, so a new
 * card or meter file is scanned without being added to anything. Which token
 * each state is drawn in is asserted on the mounted surfaces
 * (`card-rendered-tokens`, `settings-card-purge`, `settings-store-inspect`,
 * `usage-pill-mount`).
 *
 * **And neither stylesheet carries a literal colour.** A hex, `rgb()`,
 * `hsl()`, `oklch()` or a named colour beside a token is a second answer the
 * theme does not own: it renders whenever the token is missing, in one
 * theme's colour. Held two ways: a deny-list over the whole sheet for the
 * functional and hex spellings, and an ALLOW-list over every colour-bearing
 * declaration, whose value may be built only from tokens, `currentColor`,
 * `transparent`, `inherit`, `none`, `color-mix` and lengths — so a named
 * colour (`white`, `red`) fails without a 148-name list, and `white-space`
 * is never mistaken for one. The two sheets (`STYLES`, the meter's, and
 * `CARD_STYLES`, the card's) are read with their comments stripped, since a
 * comment may quote a host value. No `.tsx` file among them sets a colour
 * attribute (`fill=`, `stroke=`, `color=`), and none sets a `style` prop
 * but the meter's bar fill (`style={barFill(…)}`), which two source scans
 * hold over every branch, mounted or not. The allow-list reads every custom
 * property's value and every property ending in `color`, so a named colour
 * cannot come back behind a `var()`; the mounted inline-declaration scans
 * hold the bar fill's one property to a percent.
 *
 * @module test/host-tokens.test
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { CARD_STYLES, STYLES } from "./support/src.ts";

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
 * The card's and the meter's modules: every `src/settings-*` and `src/usage-*`
 * file, read off the directory so a new one is scanned without a list to edit.
 */
const UI_FILES = readdirSync(join(process.cwd(), "src"))
  .filter((name) => /^(?:settings|usage)-[\w-]+\.tsx?$/u.test(name))
  .map((name) => `src/${name}`)
  .toSorted();

const TOKEN = /--dsw-[\w-]+/gu;

/**
 * A property that takes a colour, in whole or as part of a shorthand: the
 * named ones, any property whose name ends in `color` (`scrollbar-color`,
 * `-webkit-text-fill-color`, `text-emphasis-color`), and every custom
 * property, since `--x: white` read back as `color: var(--x)` is a named
 * colour the `var()` hides. A custom property holding a length or a percent
 * still passes the allow-list.
 */
const COLOUR_BEARING =
  /^(?:color|background(?:-(?:color|image))?|border(?:-(?:top|right|bottom|left|(?:block|inline)(?:-(?:start|end))?))?|outline|fill|stroke|box-shadow|text-shadow|text-decoration|column-rule|[\w-]*-color|--[\w-]+)$/u;

/** The words a colour-bearing value may be built from, besides a token. */
const ALLOWED_WORD =
  /^(?:currentColor|transparent|inherit|none|initial|unset|solid|dashed|dotted|double|wavy|underline|overline|line-through|inset|in|srgb|color-mix|-?\d*\.?\d+(?:px|em|rem|%)?)$/u;

/**
 * Every colour-bearing declaration in `code` (a sheet with its comments
 * stripped), and the words in its value that are neither a token nor in
 * {@link ALLOWED_WORD}. A declaration ends at `;` or at its block's `}`, since
 * the last one in a block may omit the semicolon.
 */
const colourDeclarations = (
  code: string
): { declaration: string; foreign: string[] }[] =>
  [...code.matchAll(/(?<=[{;\s])([\w-]+)\s*:\s*([^;{}]+)(?=[;}])/gu)]
    .filter((match) => COLOUR_BEARING.test(match[1] ?? ""))
    .map((match) => {
      const value = match[2] ?? "";
      const foreign = value
        .replaceAll(/var\(\s*--[\w-]+/gu, " ")
        .split(/[\s(),/]+/u)
        .filter((word) => word !== "" && !ALLOWED_WORD.test(word));
      return { declaration: `${match[1]}: ${value.trim()}`, foreign };
    });

describe("the host's design tokens", () => {
  it("never falls back from one token to another", () => {
    // A token the host does not define resolves to nothing. Where the
    // declaration carries a LITERAL fallback the element still renders.
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

  it("every token a settings-* or usage-* file names is one the host's primitives use, and neither stylesheet carries a literal colour", () => {
    const vocabulary = hostVocabulary();
    // A read of a directory that moved finds nothing, and "nothing" must not
    // read as "the token is absent".
    expect(vocabulary.size).toBeGreaterThan(0);
    // The same for the list: a glob that matched nothing scans nothing. The
    // two stylesheets are named, and each must name a token: a sheet the scan
    // read as empty would pass every check below.
    expect(UI_FILES).toContain("src/settings-css.ts");
    expect(UI_FILES).toContain("src/usage-css.ts");

    const unknown: string[] = [];
    for (const file of UI_FILES) {
      const named = new Set(
        [
          ...readFileSync(join(process.cwd(), file), "utf8").matchAll(TOKEN),
        ].map((match) => match[0])
      );
      if (file.endsWith("-css.ts")) {
        expect(named.size, file).toBeGreaterThan(0);
      }
      for (const token of named) {
        if (!vocabulary.has(token)) {
          unknown.push(`${file} names ${token}`);
        }
      }
    }
    expect(unknown, "tokens the host's primitives never use").toEqual([]);

    const LITERAL =
      /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(|\bCanvasText\b/gu;
    for (const [name, sheet] of [
      ["STYLES", STYLES],
      ["CARD_STYLES", CARD_STYLES],
    ] as const) {
      expect(typeof sheet, name).toBe("string");
      const code = sheet.replaceAll(/\/\*[\s\S]*?\*\//gu, "");
      expect(
        [...code.matchAll(LITERAL)].map((match) => match[0]),
        name
      ).toEqual([]);
      const declarations = colourDeclarations(code);
      // The read found the sheet's colours: a pattern that matched nothing
      // would pass the allow-list below over an empty list.
      expect(
        declarations.length,
        `${name}'s colour declarations`
      ).toBeGreaterThan(5);
      expect(
        declarations
          .filter((one) => one.foreign.length > 0)
          .map((one) => `${one.declaration} (${one.foreign.join(", ")})`),
        `${name}: a colour-bearing value built from something but tokens`
      ).toEqual([]);
    }
  });

  it("the colour allow-list refuses a named colour and a modern colour function, and passes what the sheets write", () => {
    // Known answers, so the check above is shown to read what it claims to.
    const foreign = (code: string): string[] =>
      colourDeclarations(code).flatMap((one) => one.foreign);
    expect(foreign(".a { color: white; }")).toEqual(["white"]);
    expect(foreign(".a { fill: red; }")).toEqual(["red"]);
    expect(foreign(".a { border-top: 1px solid black; }")).toEqual(["black"]);
    expect(foreign(".a { background: oklch(0.5 0.1 200); }")).toContain(
      "oklch"
    );
    expect(foreign(".a { white-space: nowrap; color: currentColor; }")).toEqual(
      []
    );
    // A block's last declaration may omit its semicolon.
    expect(foreign(".a { color: white }")).toEqual(["white"]);
    expect(foreign(".a { gap: 4px; color: white }\n.b { fill: red }")).toEqual([
      "white",
      "red",
    ]);
    // A selector's pseudo-class is not a declaration.
    expect(colourDeclarations("button:hover { gap: 4px }")).toEqual([]);
    expect(foreign(".a { text-shadow: 0 0 2px black; }")).toEqual(["black"]);
    expect(
      foreign(".a { background-image: linear-gradient(red, blue); }")
    ).toEqual(expect.arrayContaining(["red", "blue"]));
    expect(foreign(".a { border-inline-start: 1px solid red; }")).toEqual([
      "red",
    ]);
    expect(foreign(".a { border-block-end-color: red; }")).toEqual(["red"]);
    // Any property ending in `color`, not only the named ones.
    expect(foreign(".a { scrollbar-color: red blue; }")).toEqual([
      "red",
      "blue",
    ]);
    expect(foreign(".a { -webkit-text-fill-color: red; }")).toEqual(["red"]);
    // A custom property is read for its value: a named colour behind a
    // `var()` is still a named colour, and a length or a percent is not one.
    expect(
      foreign(".a { --dsh-oc-tint: white; } .b { color: var(--dsh-oc-tint); }")
    ).toEqual(["white"]);
    expect(foreign(".a { --dsh-oc-usage-fill: 42%; --x-gap: 4px }")).toEqual(
      []
    );
    expect(
      foreign(
        ".a { border-top: 0.5px solid var(--dsw-alias-border-l2); background: color-mix(in srgb, currentColor 7%, transparent); color: var(--dsw-x, inherit); }"
      )
    ).toEqual([]);
  });

  it("no card or meter .tsx sets an inline style but the bar fill's width", () => {
    // The mounted scans read the states they mount; this one reads every
    // branch, mounted or not. The one `style=` allowed is `barFill`'s, whose
    // value the inline scan holds to a percent (`OWN_INLINE`).
    const STYLE_PROP = /\bstyle=(?!\{barFill\()/gu;
    // Known answers first: the bar fill passes, any other `style=` is read.
    expect("style={barFill(window.percent)}".match(STYLE_PROP)).toBeNull();
    expect('style={{ color: "white" }}'.match(STYLE_PROP)).toHaveLength(1);
    expect('<i style="color: red" />'.match(STYLE_PROP)).toHaveLength(1);
    const views = UI_FILES.filter((file) => file.endsWith(".tsx"));
    expect(views).toContain("src/usage-panel.tsx");
    const sources = views.map((file) => ({
      file,
      text: readFileSync(join(process.cwd(), file), "utf8"),
    }));
    // The read found the one site it allows, so it read the meter's view.
    expect(
      sources.filter(({ text }) => text.includes("style={barFill(")),
      "the bar fill's site"
    ).toHaveLength(1);
    expect(
      sources.flatMap(({ file, text }) =>
        [...text.matchAll(STYLE_PROP)].map(
          (match) =>
            `${file}: ${text.slice(match.index, match.index + 40).split("\n")[0] ?? ""}`
        )
      )
    ).toEqual([]);
  });

  it("no card or meter .tsx sets a colour attribute", () => {
    const COLOUR_ATTRIBUTE = /\b(?:fill|stroke|color)=/gu;
    // Known answers first: the pattern reads an attribute, not a word.
    expect('<path fill="red" />'.match(COLOUR_ATTRIBUTE)).toHaveLength(1);
    expect("const fill = 1; // stroke".match(COLOUR_ATTRIBUTE)).toBeNull();
    const views = UI_FILES.filter((file) => file.endsWith(".tsx"));
    // A list that matched nothing would scan nothing.
    expect(views).toContain("src/usage-panel.tsx");
    expect(views).toContain("src/settings-card.tsx");
    expect(
      views.flatMap((file) =>
        [
          ...readFileSync(join(process.cwd(), file), "utf8").matchAll(
            COLOUR_ATTRIBUTE
          ),
        ].map((match) => `${file}: ${match[0]}`)
      )
    ).toEqual([]);
  });
});
