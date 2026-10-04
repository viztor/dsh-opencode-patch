/**
 * The card's constrained-choice control, asserted as an element tree.
 *
 * The host ships no enum settings field, so `SettingsChoiceField` renders a
 * native `<select>`. These cases pin the contract `settings-card.tsx` relies
 * on: the draft becomes the selected option, a change emits the option's raw
 * value, and a draft outside the option set still renders without React falling
 * back to the first option (which would silently misreport the stored value).
 */

import { describe, expect, it, vi } from "vitest";

import {
  type ChoiceFieldProps,
  SettingsChoiceField,
} from "../src/settings-choice-field.tsx";
import { findAll, firstOf } from "./test-helpers.ts";

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

const selectOf = (tree: unknown) => firstOf(tree, "select");

describe("SettingsChoiceField", () => {
  it("renders one option per choice, in order, with the given labels", () => {
    const select = selectOf(SettingsChoiceField(baseProps()));
    const rendered = findAll(select, "option").map((option) => ({
      label: option.props.children,
      value: option.props.value,
    }));
    expect(rendered).toEqual(OPTIONS);
  });

  it("selects the option the draft names", () => {
    expect(
      selectOf(SettingsChoiceField(baseProps({ text: "configured" }))).props
        .value
    ).toBe("configured");
  });

  it("emits the raw option value on change", () => {
    const onEdit = vi.fn<() => void>();
    const select = selectOf(SettingsChoiceField(baseProps({ onEdit })));
    const onChange = select.props.onChange as (event: {
      target: { value: string };
    }) => void;

    onChange({ target: { value: "request" } });
    expect(onEdit).toHaveBeenLastCalledWith("request");
  });

  it("carries an unrecognised draft on a blank option instead of misreporting it", () => {
    // A select cannot render a value it has no option for; React would fall
    // back to the first option and the row would claim "auto" while the stored
    // value is something else.
    const tree = SettingsChoiceField(baseProps({ text: "hand-edited" }));
    const options = findAll(tree, "option");
    expect(options[0]?.props.value).toBe("hand-edited");
    expect(options[0]?.props.children).toBeUndefined();
    expect(options).toHaveLength(OPTIONS.length + 1);
  });

  it("propagates disabled to the select", () => {
    expect(
      selectOf(SettingsChoiceField(baseProps({ disabled: true }))).props
        .disabled
    ).toBe(true);
  });

  it("styles the control with host tokens, not invented ones", () => {
    // The first version of this control used made-up variable names
    // (--color-bg-elevated, --color-border-default). Those resolve to nothing,
    // so the hard-coded dark fallbacks rendered instead — dark-theme colours
    // inside a light theme. The host's only token family is `--dsw-*`.
    const style = selectOf(SettingsChoiceField(baseProps())).props
      .style as Record<string, unknown>;
    const values = Object.values(style).filter(
      (value): value is string => typeof value === "string"
    );
    expect(values.some((value) => value.includes("--dsw-alias-"))).toBe(true);
    for (const value of values) {
      expect(value).not.toContain("--color-");
    }
  });

  it("delegates every piece of chrome to the shared shell", () => {
    const tree = SettingsChoiceField(baseProps({ overridden: true }));
    const shell = firstOf(tree, "SettingsFieldShell");
    expect(shell.props.label).toBe("Credential Source");
    expect(shell.props.hint).toBe("the hint");
    expect(shell.props.id).toBe("plugin-config-opencode-keySource");
    expect(shell.props.overridden).toBe(true);
  });
});
