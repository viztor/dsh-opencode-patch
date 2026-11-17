/**
 * A pointer press as a browser delivers one, for the dismissal pins:
 * `pointerdown` first, then `mousedown`, so a pin holds whichever of the two
 * the dismissal listens for.
 *
 * DOM-only, so a jsdom file may import it.
 *
 * @module test/support/pointer
 */
import { fireEvent } from "@testing-library/react";

/**
 * A press on `target` as a browser delivers it: `pointerdown`, then
 * `mousedown`.
 */
export const press = (target: Element): void => {
  fireEvent.pointerDown(target);
  fireEvent.mouseDown(target);
};
