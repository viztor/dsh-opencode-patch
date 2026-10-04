/**
 * The card's boolean control, asserted as an element tree.
 *
 * `SettingsBooleanField` is the plugin's own control because the host ships no
 * boolean settings field (see the module's doc block). It owns exactly two
 * things now that the chrome lives in `SettingsFieldShell`: turning draft text
 * into the host `Switch`'s `checked`, and turning a toggle back into the
 * `"true"` / `"false"` string the field spec parses. Everything else it renders
 * is the shell's, and is asserted there.
 */

import { describe, expect, it, vi } from "vitest";

import {
  type BooleanFieldProps,
  SettingsBooleanField,
} from "../src/settings-boolean-field.tsx";
import { firstOf } from "./test-helpers.ts";

const baseProps = (
  overrides: Partial<BooleanFieldProps> = {}
): BooleanFieldProps => ({
  disabled: false,
  hint: "the hint",
  id: "plugin-config-opencode-usageEnabled",
  invalid: false,
  invalidLabel: "invalid!",
  label: "Usage",
  onEdit: () => {},
  onReset: () => {},
  overridden: false,
  overriddenLabel: "Overridden",
  resetLabel: "Reset to default",
  text: "false",
  ...overrides,
});

const switchOf = (tree: unknown) => firstOf(tree, "Switch");

describe("SettingsBooleanField", () => {
  it("checks the host Switch from the draft text", () => {
    expect(
      switchOf(SettingsBooleanField(baseProps({ text: "true" }))).props.checked
    ).toBe(true);
    expect(
      switchOf(SettingsBooleanField(baseProps({ text: "false" }))).props.checked
    ).toBe(false);
    // A never-set field renders empty, which reads as off rather than invalid.
    expect(
      switchOf(SettingsBooleanField(baseProps({ text: "" }))).props.checked
    ).toBe(false);
  });

  it("stages the draft as the string the field spec parses", () => {
    const onEdit = vi.fn<() => void>();
    const tree = SettingsBooleanField(baseProps({ onEdit }));
    const onChange = switchOf(tree).props.onChange as (next: boolean) => void;

    onChange(true);
    expect(onEdit).toHaveBeenLastCalledWith("true");
    onChange(false);
    expect(onEdit).toHaveBeenLastCalledWith("false");
  });

  it("delegates every piece of chrome to the shared shell", () => {
    // The shell is the one place the row chrome lives, so the field must hand
    // it through untouched rather than growing its own label or badge.
    const tree = SettingsBooleanField(
      baseProps({ disabled: true, overridden: true })
    );
    const shell = firstOf(tree, "SettingsFieldShell");
    expect(shell.props.disabled).toBe(true);
    expect(shell.props.hint).toBe("the hint");
    expect(shell.props.id).toBe("plugin-config-opencode-usageEnabled");
    expect(shell.props.invalid).toBe(false);
    expect(shell.props.invalidLabel).toBe("invalid!");
    expect(shell.props.label).toBe("Usage");
    expect(shell.props.overridden).toBe(true);
    expect(shell.props.overriddenLabel).toBe("Overridden");
    expect(shell.props.resetLabel).toBe("Reset to default");
  });
});
