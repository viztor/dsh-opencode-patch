/**
 * The settings card's controls, read off a rendered element tree.
 *
 * Shared by the card's rendering tests: which component each register `kind`
 * renders as, the card's controls in document order, and the field each one
 * edits.
 *
 * @module test/support/card-tree
 */
import {
  elementName,
  findAllWhere,
  type TestElement,
} from "../test-helpers.ts";

/** Every control component the card can render, keyed by the register's `kind`. */
export const COMPONENT_BY_KIND = {
  boolean: "SettingsBooleanField",
  select: "SettingsChoiceField",
} as const;

const CONTROL_TYPES: ReadonlySet<string> = new Set(
  Object.values(COMPONENT_BY_KIND)
);

/** The card's controls, in document order. */
export const controlsInOrder = (tree: unknown): TestElement[] =>
  findAllWhere(tree, (element) => CONTROL_TYPES.has(elementName(element.type)));

/**
 * The register field a rendered control edits, read off the element's React
 * `key` (the card keys each control by its field). Not a prop: the boolean
 * control carries no id, because nothing it renders would read one. The key
 * is tied to what the control does by the card test that drives every
 * control's `onEdit` and `onReset` and expects this field back
 * (`settings-page-card.test.tsx`, "wires each control's edit and reset").
 */
export const fieldOf = (control: TestElement): string => {
  const { key } = control as TestElement & { key?: unknown };
  if (typeof key !== "string") {
    throw new TypeError("a card control rendered without its field key");
  }
  return key;
};
