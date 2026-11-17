/**
 * The card's constrained-choice control, asserted as an element tree.
 *
 * `SettingsChoiceField` renders the host's `SegmentedControl`. These cases pin
 * the props the card relies on: the draft is the selected value, a change emits
 * the option's raw value, and a draft outside the option set is carried on a
 * segment of its own rather than left unselected (which would silently
 * misreport the stored value). The mounted behaviour is
 * `settings-choice-field-mount.test.tsx`'s.
 */

import { describe, expect, it, vi } from "vitest";

import { type ChoiceFieldProps, SettingsChoiceField } from "./support/src.ts";
import { firstOf } from "./test-helpers.ts";

const OPTIONS = [
  { label: "Automatic", value: "auto" },
  { label: "Live request first", value: "request" },
  { label: "Declared key first", value: "configured" },
];

const baseProps = (
  overrides: Partial<ChoiceFieldProps> = {}
): ChoiceFieldProps => ({
  disabled: false,
  hint: "the hint",
  id: "plugin-config-opencode-keySource",
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

/** The host control the field renders, read off the element tree. */
const controlOf = (tree: unknown) => firstOf(tree, "SegmentedControl");

describe("SettingsChoiceField", () => {
  it("renders one segment per choice, in order, with the given labels", () => {
    const control = controlOf(SettingsChoiceField(baseProps()));
    expect(control.props.options).toEqual(OPTIONS);
  });

  it("names the control after the field, and ids its segments from the field's id", () => {
    const control = controlOf(SettingsChoiceField(baseProps()));
    expect(control.props.label).toBe("Credential Source");
    expect(control.props.id).toBe("plugin-config-opencode-keySource");
  });

  it("selects the option the draft names", () => {
    expect(
      controlOf(SettingsChoiceField(baseProps({ text: "configured" }))).props
        .value
    ).toBe("configured");
  });

  it("emits the raw option value on change", () => {
    const onEdit = vi.fn<() => void>();
    const control = controlOf(SettingsChoiceField(baseProps({ onEdit })));
    const onChange = control.props.onChange as (next: string) => void;

    onChange("request");
    expect(onEdit).toHaveBeenLastCalledWith("request");
  });

  it("carries an unrecognised draft on a segment of its own instead of misreporting it", () => {
    // A segmented control selects by value; with no segment for the draft it
    // would select none, and the row would read as though nothing were stored.
    // The carrier comes first and is the selected one, so it is the segment in
    // the tab order and the arrow keys walk from it to the real choices.
    const control = controlOf(
      SettingsChoiceField(baseProps({ text: "hand-edited" }))
    );
    const options = control.props.options as typeof OPTIONS;
    expect(options[0]).toEqual({ label: "hand-edited", value: "hand-edited" });
    expect(control.props.value).toBe("hand-edited");
    expect(options).toHaveLength(OPTIONS.length + 1);
    expect(options.slice(1)).toEqual(OPTIONS);
  });

  it("propagates disabled to the control", () => {
    expect(
      controlOf(SettingsChoiceField(baseProps({ disabled: true }))).props
        .disabled
    ).toBe(true);
  });

  it("delegates every piece of chrome to the shared shell", () => {
    const tree = SettingsChoiceField(baseProps({ overridden: true }));
    const shell = firstOf(tree, "SettingsFieldShell");
    expect(shell.props.label).toBe("Credential Source");
    expect(shell.props.hint).toBe("the hint");
    expect(shell.props.overridden).toBe(true);
  });
});
