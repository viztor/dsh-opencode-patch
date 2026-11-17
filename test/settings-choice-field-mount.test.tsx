// @vitest-environment jsdom
/**
 * The card's choice field, MOUNTED and driven the way a reader drives it.
 *
 * `settings-choice-field.test.tsx` reads the element tree; this file is the
 * behaviour that tree has to produce, read through `choiceControl`, which
 * answers the same questions of a native `<select>` and of the host's
 * segmented control. So the case below is one pin across the change of
 * control: the draft's option is the selected one, choosing another emits its
 * raw value, a disabled field refuses, and a draft outside the option set is
 * shown as itself rather than misreported as the first option.
 *
 * A file of its own because a jsdom file may not load the test door, and the
 * tree-walk file reads the field through it.
 *
 * @module test/settings-choice-field-mount.test
 */
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// The host's UI kit imports `clsx`, which this package does not install; the
// stand-ins render real elements (see test/support/ui-primitives.ts).
vi.mock(
  "@deepseek-ai/dsh-client-ui-primitives",
  () => import("./support/ui-primitives.ts")
);

import {
  type ChoiceFieldProps,
  SettingsChoiceField,
} from "../src/settings-choice-field.tsx";
import { choiceControl } from "./support/choice-control.ts";

const ID = "plugin-config-opencode-keySource";

const OPTIONS = [
  { label: "Automatic", value: "auto" },
  { label: "Live request first", value: "request" },
  { label: "Declared key first", value: "configured" },
];

const props = (
  overrides: Partial<ChoiceFieldProps> = {}
): ChoiceFieldProps => ({
  disabled: false,
  hint: "the hint",
  id: ID,
  invalid: false,
  invalidLabel: "invalid!",
  label: "Credential Source",
  onEdit: () => {},
  onReset: () => {},
  options: OPTIONS,
  overridden: false,
  overriddenLabel: "Overridden",
  resetLabel: "Reset to default",
  text: "auto",
  ...overrides,
});

afterEach(() => {
  cleanup();
});

describe("SettingsChoiceField, mounted", () => {
  it("mounted: the draft's option is the selected one, choosing another emits its raw value, a disabled field refuses, and an unknown draft is never reported as a real option", () => {
    const onEdit = vi.fn<(text: string) => void>();
    const chosen = render(
      <SettingsChoiceField {...props({ onEdit, text: "configured" })} />
    );
    const control = choiceControl(chosen.container, ID);
    expect(control.selected()).toBe("configured");
    expect(control.disabled()).toBe(false);
    control.choose("request");
    expect(onEdit).toHaveBeenCalledTimes(1);
    expect(onEdit).toHaveBeenLastCalledWith("request");
    chosen.unmount();

    const refused = vi.fn<(text: string) => void>();
    const locked = render(
      <SettingsChoiceField {...props({ disabled: true, onEdit: refused })} />
    );
    const lockedControl = choiceControl(locked.container, ID);
    expect(lockedControl.disabled()).toBe(true);
    // Refusing is what the reader sees: a choice on the locked field emits
    // nothing, and the draft stays selected.
    lockedControl.choose("request");
    expect(refused).not.toHaveBeenCalled();
    expect(lockedControl.selected()).toBe("auto");
    locked.unmount();

    // A draft outside the option set is carried as itself: shown selected,
    // never as "auto" (the first option), and every real option still offered.
    const unknown = render(
      <SettingsChoiceField {...props({ text: "hand-edited" })} />
    );
    const carried = choiceControl(unknown.container, ID);
    expect(carried.selected()).toBe("hand-edited");
    expect(carried.values()).toEqual(
      expect.arrayContaining(OPTIONS.map((option) => option.value))
    );
  });

  it("mounted: an empty draft (a field the snapshot does not carry) is selected as itself, never read as the first option", () => {
    // What the card hands a field missing from its snapshot (`staged()`
    // defaults the draft to ""), and so what every card mount with no fields
    // renders. The host always sends the field, so a reader does not see it;
    // this pins what it looks like should that ever change.
    const empty = render(<SettingsChoiceField {...props({ text: "" })} />);
    const control = choiceControl(empty.container, ID);
    expect(control.selected()).toBe("");
    expect(control.values()).toEqual([
      "",
      ...OPTIONS.map((option) => option.value),
    ]);
  });
});
