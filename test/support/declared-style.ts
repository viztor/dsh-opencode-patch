/**
 * What a rendered element DECLARES, read the way the card and the meter style
 * it: inline first, then the stylesheets in the document.
 *
 * `getComputedStyle` cannot answer a token question in jsdom: it resolves no
 * `var()`, so a colour declared as `var(--dsw-alias-state-warn-label)` reads
 * back as nothing. The rules themselves keep the text — measured on jsdom 31,
 * `cssRules[].style.getPropertyValue()` answers `var(...)` as written, and
 * `element.matches(rule.selectorText)` works for a `<style>` in the body — so
 * a pin reads the declaration and asserts the token it names. That lets one
 * pin hold while a declaration moves from a `style` prop into a sheet.
 *
 * Two limits, both on purpose. It ignores specificity: the LAST rule whose
 * selector matches wins, so the sheets keep a modifier after its base at
 * equal specificity (`-outcome` then `-outcome-warn`). And it reads one
 * property as written: a `background:` shorthand holding a `var()` is not
 * expanded, so a pinned fill is declared as `background-color`.
 *
 * Dependency-free and DOM-only, so a jsdom file may import it.
 *
 * @module test/support/declared-style
 */

/** Every style rule in `rules`, descending into `@media` blocks. */
const styleRules = (rules: CSSRuleList): CSSStyleRule[] =>
  [...rules].flatMap((rule) => {
    if (rule instanceof CSSMediaRule) {
      return styleRules(rule.cssRules);
    }
    return rule instanceof CSSStyleRule ? [rule] : [];
  });

/** Whether `element` matches `selector`; a selector jsdom cannot parse never does. */
const matches = (element: Element, selector: string): boolean => {
  try {
    return element.matches(selector);
  } catch {
    return false;
  }
};

/**
 * The value `element` declares for `property`: its inline style when that
 * sets it, else the last matching rule's, else `""`.
 *
 * @param element - the rendered element; a missing one declares nothing, so
 * a pin on an element that was never rendered fails on its value.
 * @param property - a CSS property in its hyphenated spelling.
 */
export const declaredStyle = (
  element: Element | null | undefined,
  property: string
): string => {
  if (element === null || element === undefined) {
    return "";
  }
  const inline =
    element instanceof HTMLElement || element instanceof SVGElement
      ? element.style.getPropertyValue(property)
      : "";
  if (inline !== "") {
    return inline;
  }
  let found = "";
  for (const sheet of document.styleSheets) {
    for (const rule of styleRules(sheet.cssRules)) {
      const value = rule.style.getPropertyValue(property);
      if (value !== "" && matches(element, rule.selectorText)) {
        found = value;
      }
    }
  }
  return found;
};

/**
 * The elements the test stand-ins of the host's primitives render. They are
 * the host's markup, not ours, and the host's own `StateDot` sizes itself
 * inline (`style: { width, height }`), which the stand-in mirrors.
 */
const PRIMITIVE_MARKUP = '[class*="dsh-stub-"]';

/**
 * The one inline declaration the card and the meter keep: the bar fill's
 * width, handed to the meter's sheet as a percent (`barFill` in
 * `src/usage-panel.tsx`).
 */
const OWN_INLINE: Readonly<Record<string, RegExp>> = {
  "--dsh-oc-usage-fill": /^\d+(?:\.\d+)?%$/u,
};

/**
 * Every property set inline under `root`, as `"<tag>.<class> <property>"`,
 * the plugin's one own custom property (see {@link OWN_INLINE}) left out
 * while its value is a percent. Any other property is reported, a custom
 * one included: a `--dsw-*` token re-declared inline (the theme re-declared),
 * another `--dsh-oc-*` property, or the bar's own property holding anything
 * but a percent (reported with its value), so a colour cannot come back
 * through a custom property a sheet reads. Elements a primitive's stand-in
 * renders are skipped (see {@link PRIMITIVE_MARKUP}).
 *
 * @param root - the element whose subtree is read, itself included.
 */
export const inlineDeclarations = (root: Element): string[] =>
  [root, ...root.querySelectorAll("[style]")].flatMap((element) => {
    if (
      !(element instanceof HTMLElement || element instanceof SVGElement) ||
      element.matches(PRIMITIVE_MARKUP)
    ) {
      return [];
    }
    const { style } = element;
    const names = [...Array.from({ length: style.length }).keys()].map(
      (index) => style.item(index)
    );
    const name = `${element.tagName.toLowerCase()}.${element.getAttribute("class") ?? ""}`;
    return names.flatMap((property) => {
      const shape = OWN_INLINE[property];
      if (shape === undefined) {
        return [`${name} ${property}`];
      }
      const value = style.getPropertyValue(property).trim();
      return shape.test(value) ? [] : [`${name} ${property}: ${value}`];
    });
  });
