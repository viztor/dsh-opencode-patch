/**
 * The settings card's controls, read off a rendered element tree.
 *
 * Shared by the card's rendering tests: which component each register `kind`
 * renders as, and the card's controls in document order.
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
