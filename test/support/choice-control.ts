/**
 * A mounted choice field, read by what it DOES rather than by its markup:
 * which values it offers, which one is selected, what choosing one emits,
 * and whether it refuses. It reads the host's segmented control (a
 * `[role=tablist]` of `[role=tab]` buttons, each id'd `<id>-<value>`). It read
 * a native `<select>` too while the field was one, which is how the mounted
 * pin held unchanged across the move to the host's control.
 *
 * DOM-only, so a jsdom file may import it.
 *
 * @module test/support/choice-control
 */
import { fireEvent } from "@testing-library/react";

/** What a test can ask of a mounted choice field. */
export interface ChoiceControl {
  /** Every value the control offers, in order. */
  values: () => string[];
  /** The value the control shows as selected. */
  selected: () => string | undefined;
  /** Choose `value` the way a reader would. */
  choose: (value: string) => void;
  /** Whether the control refuses every choice. */
  disabled: () => boolean;
}

/** One element, or a failure that names what was missing. */
const required = <T>(value: T | null | undefined, what: string): T => {
  if (value === null || value === undefined) {
    throw new Error(`expected ${what} to be rendered`);
  }
  return value;
};

/**
 * The choice field rendered under `host`.
 *
 * @param host - the element the field is mounted in.
 * @param id - the field's id: each segment is `<id>-<value>`, which is how a
 * segment's value is read back.
 */
export const choiceControl = (host: Element, id: string): ChoiceControl => {
  const list = required(host.querySelector('[role="tablist"]'), "a tablist");
  // At least one segment, or a failure: an id that matches nothing (a wrong
  // id, or the host changing its id scheme) would otherwise answer every
  // question vacuously — `disabled()` true over no segments at all.
  const tabs = (): HTMLButtonElement[] => {
    const found = [
      ...list.querySelectorAll<HTMLButtonElement>('[role="tab"]'),
    ].filter((tab) => tab.id.startsWith(`${id}-`));
    return required(
      found.length === 0 ? undefined : found,
      `a segment id'd ${id}-<value>`
    );
  };
  const valueOf = (tab: HTMLButtonElement): string =>
    tab.id.slice(id.length + 1);
  return {
    choose: (value) => {
      fireEvent.click(
        required(
          tabs().find((tab) => valueOf(tab) === value),
          `a segment for ${value}`
        )
      );
    },
    disabled: () => tabs().every((tab) => tab.disabled),
    selected: () => {
      const tab = tabs().find(
        (one) => one.getAttribute("aria-selected") === "true"
      );
      return tab === undefined ? undefined : valueOf(tab);
    },
    values: () => tabs().map((tab) => valueOf(tab)),
  };
};
