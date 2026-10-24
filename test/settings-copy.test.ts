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

import { describe, expect, it } from "vitest";

import { en, withBundleCopy, zh } from "./support/src.ts";

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
