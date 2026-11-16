/**
 * The copy fallback that keeps a stale dictionary from reaching the screen.
 *
 * The bug this pins is not hypothetical: the locale service keeps ONE dictionary
 * per (namespace, locale) and throws on a second registration, so a page that
 * outlived a rebuild serves the older dictionary. Keys that existed then still
 * translate, so nothing looks wrong — and every key added since renders
 * verbatim. `goPlanTitle` reached the screen that way on the meter, and
 * `storeInspectTitle` on the settings card.
 *
 * The tests here exercise the translator rather than its inputs: each assertion
 * runs a lookup and checks the WORD that comes back, because a test that asserted
 * the dictionary contained a key would have passed throughout the incident.
 *
 * @module test/settings-copy.test
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  CARD_FIELDS,
  en,
  isRecord,
  withBundleCopy,
  zh,
} from "./support/src.ts";
import { blankCommentLines } from "./support/strip-comments.ts";

/** A seat whose dictionary predates every key: it answers with the key itself. */
const staleSeat = (key: string): string => key;

describe("withBundleCopy", () => {
  it("renders the bundle's word when the seat misses", () => {
    // The incident: the seat holds an older dictionary, so it echoes the key.
    const t = withBundleCopy(staleSeat, () => "en");
    expect(t("storeInspectTitle")).toBe(en.storeInspectTitle);
    assert.notEqual(t("storeInspectTitle"), "storeInspectTitle");
  });

  it("follows the active locale on every call, not on construction", () => {
    // The getter is read per call so a language switch lands without a remount;
    // capturing it would freeze `t` at whatever language was active at build.
    let active = "en";
    const t = withBundleCopy(staleSeat, () => active);
    const english = t("storeInspectTitle");
    active = "zh";
    expect(t("storeInspectTitle")).toBe(zh.storeInspectTitle);
    assert.notEqual(english, zh.storeInspectTitle);
  });

  it("defaults to English when no locale getter is supplied", () => {
    expect(withBundleCopy(staleSeat)("purgeAction")).toBe(en.purgeAction);
  });

  it("keeps the seat's word when the seat has one", () => {
    // A host-side translation, or a locale this bundle does not ship, must win:
    // the bundle is the fallback, not an override.
    const seat = (key: string): string => `seat:${key}`;
    expect(withBundleCopy(seat, () => "zh")("purgeAction")).toBe(
      "seat:purgeAction"
    );
  });

  it("echoes a key this bundle does not define", () => {
    // A miss on both sides is still honest: the key is wrong, and rendering it
    // is how the next person finds out which one.
    expect(withBundleCopy(staleSeat, () => "en")("noSuchKey")).toBe(
      "noSuchKey"
    );
  });
});

describe("the dictionaries", () => {
  it("define the same keys, so a fallback never lands on one language", () => {
    // `zh` is typed against `en`, so a missing key is already a compile error;
    // this asserts the runtime objects agree too, which the type does not check
    // for an extra property added through a spread.
    expect(Object.keys(zh).toSorted()).toEqual(Object.keys(en).toSorted());
  });

  it("give every key a word, except the resets-at pair that grammar splits", () => {
    // A key mapped to "" renders as nothing at all — worse than a raw key,
    // because there is no string to grep for. There is exactly one such pair and
    // it is a grammar fact: the sentence is prefix + time + suffix, and the
    // pieces land differently per language.
    //
    //   en: "Resets at " + "3:00 PM" + ""        → the time ends the sentence
    //   zh: ""          + "3:00"    + " 后重置"   → the verb follows the time
    //
    // So each language has one empty half, and neither has an empty SENTENCE.
    // Naming both here keeps a future empty string from hiding behind "that one
    // is probably fine".
    const emptyByDesign: Record<"en" | "zh", ReadonlySet<string>> = {
      en: new Set(["usageResetsAtSuffix"]),
      zh: new Set(["usageResetsAtPrefix"]),
    };
    for (const [locale, dict] of [
      ["en", en],
      ["zh", zh],
    ] as const) {
      for (const [key, word] of Object.entries(dict)) {
        if (emptyByDesign[locale].has(key)) {
          expect(word, `${locale}.${key} is documented as empty`).toBe("");
          continue;
        }
        expect(word.trim(), `${locale}.${key}`).not.toBe("");
      }
    }
    // And the sentence they compose is never empty in either language.
    for (const dict of [en, zh]) {
      expect(
        `${dict.usageResetsAtPrefix}3:00${dict.usageResetsAtSuffix}`.trim()
      ).not.toBe("3:00");
    }
  });
});

describe("the card's name", () => {
  const ROOT = join(import.meta.dirname, "..");
  const read = (file: string): string => readFileSync(join(ROOT, file), "utf8");
  /**
   * The package's own title in one language. The host heads the card with it
   * (the plugin manager reads `meta.title`), so it is the card's name; the
   * dictionary has no title of its own.
   */
  const metaTitle = (locale: "en" | "zh"): string => {
    const parsed: unknown = JSON.parse(read(`locale/${locale}.json`));
    const title =
      isRecord(parsed) && isRecord(parsed.meta) ? parsed.meta.title : undefined;
    if (typeof title !== "string") {
      throw new TypeError(`locale/${locale}.json has no meta.title`);
    }
    return title;
  };

  it("is the name each README gives the card", () => {
    // Known answers: the reads reached the files.
    expect(metaTitle("en")).toBe("OpenCode Patch");
    expect(metaTitle("zh")).toBe("OpenCode 补丁");
    expect(read("README.md")).toContain(
      `_Settings → Plugins → ${metaTitle("en")}_`
    );
    expect(read("README.zh-CN.md")).toContain(
      `_Settings → Plugins → ${metaTitle("zh")}_`
    );
    // The stale zh name P8 replaced is gone from every zh page, not only from
    // the italic path: one sentence also named the card in bold.
    for (const page of [
      "README.zh-CN.md",
      "docs/detail.zh-CN.md",
      "docs/quota-meter.zh-CN.md",
    ]) {
      const text = read(page);
      expect(text.length, page).toBeGreaterThan(0);
      expect(text, page).not.toContain("OpenCode 补丁设置");
    }
  });
});

describe("every copy key has a reader", () => {
  const SRC = join(import.meta.dirname, "..", "src");

  /**
   * The keys of `keys` nothing in `sources` names: a quoted literal (`"x"`,
   * `'x'` or `` `x` ``) in code, or one of `derived`, the keys the card builds
   * from the settings table rather than spells. Comments are blanked first,
   * so a word a comment quotes is not a reader: comment lines through
   * {@link blankCommentLines}, then a JSX `{/* … *\/}` span and a `// …` tail
   * after code (with a space before the `//`, so a `"https://…"` string is
   * not cut short). Blanking too much is the loud direction for this scan,
   * since a key it hides is reported as unread.
   */
  const unread = (
    keys: readonly string[],
    sources: readonly string[],
    derived: ReadonlySet<string>
  ): string[] => {
    const named = new Set(derived);
    for (const text of sources) {
      const code = blankCommentLines(text)
        .replaceAll(/\{\/\*[\s\S]*?\*\/\}/gu, "")
        .replaceAll(/(?<=\s)\/\/.*$/gmu, "");
      for (const match of code.matchAll(/["'`](\w+)["'`]/gu)) {
        named.add(match[1] ?? "");
      }
    }
    return keys.filter((key) => !named.has(key));
  };

  // Every source file but the dictionary itself, which names every key.
  const sources = readdirSync(SRC, { recursive: true, withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() &&
        /\.tsx?$/u.test(entry.name) &&
        entry.name !== "settings-copy.ts"
    )
    .map((entry) => readFileSync(join(entry.parentPath, entry.name), "utf8"));
  const derived = new Set(
    CARD_FIELDS.flatMap((entry) => [
      entry.labelKey,
      entry.hintKey,
      entry.group,
      ...(entry.options ?? []).map((option) => option.labelKey),
    ])
  );

  it("names every key in src, spelled or derived from the table", () => {
    // Known answers: the read reached the tree, a group heading is only
    // derived, and a purge key is only spelled.
    expect(sources.length).toBeGreaterThan(20);
    expect(sources.some((text) => text.includes('"groupAccess"'))).toBe(false);
    expect(derived).toContain("groupAccess");
    expect(unread(["purgeAction"], sources, new Set())).toEqual([]);
    expect(unread(Object.keys(en), sources, derived)).toEqual([]);
  });

  it("reports a key nothing reads (planted)", () => {
    expect(
      unread([...Object.keys(en), "plantedOrphanKey"], sources, derived)
    ).toEqual(["plantedOrphanKey"]);
    // A key only a comment quotes has no reader: the comment is blanked.
    const commented = [
      "/**",
      " * The panel header (which is `plantedCommentKey`).",
      " */",
      "// and `plantedCommentKey` again",
      'export const read = t("purgeAction");',
    ].join("\n");
    expect(
      unread(["plantedCommentKey", "purgeAction"], [commented], new Set())
    ).toEqual(["plantedCommentKey"]);
    // Nor does one only a JSX comment or a `//` tail after code quotes,
    // though neither opens its line.
    const jsxAndTail = [
      "  return (",
      "    <div>",
      "      {/* the top-up link,",
      '         labelled "plantedJsxKey" */}',
      '      {t("purgeAction")} // was "plantedTailKey"',
      '      {/* "plantedJsxKey" */}',
      "    </div>",
      "  );",
    ].join("\n");
    expect(
      unread(
        ["plantedJsxKey", "plantedTailKey", "purgeAction"],
        [jsxAndTail],
        new Set()
      )
    ).toEqual(["plantedJsxKey", "plantedTailKey"]);
    // The fifteen keys P8 deleted, found by this same scan: had they stayed,
    // each would be reported. `title` among them was quoted only by a comment
    // in `src/usage-ui.ts`, about the meter's own panel header.
    const deleted = [
      "storeInspectFound",
      "loginAction",
      "loginAgain",
      "loginExpired",
      "loginFailed",
      "loginSignedIn",
      "loginSignedOut",
      "loginPlane",
      "loginPlaneGo",
      "loginPlaneZen",
      "loginTitle",
      "loginWaiting",
      "zenFallbackNotice",
      "zenOverflowActive",
      "title",
    ];
    expect(unread(deleted, sources, derived)).toEqual(deleted);
    // A derived key is read only through the table.
    expect(unread(["groupAccess"], sources, new Set())).toEqual([
      "groupAccess",
    ]);
  });
});
