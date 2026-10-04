/**
 * The card's shared row chrome, asserted as an element tree.
 *
 * `SettingsFieldShell` frames every non-text control the card renders (the
 * boolean toggle and the enum select), so this is the one place the label /
 * override-badge / reset / message contract is pinned. It is asserted directly
 * rather than through a field, so a regression here cannot hide behind a
 * passing control test.
 */

import assert from "node:assert/strict";

import { describe, expect, it, vi } from "vitest";

import {
  type FieldShellProps,
  SettingsFieldShell,
} from "../src/settings-field-shell.tsx";
import {
  collectText,
  findAll,
  firstOf,
  type TestElement,
} from "./test-helpers.ts";

const CONTROL = "the-control";

const baseProps = (
  overrides: Partial<FieldShellProps> = {}
): FieldShellProps => ({
  children: CONTROL,
  disabled: false,
  hint: "the hint",
  id: "plugin-config-opencode-usageEnabled",
  invalid: false,
  invalidLabel: "invalid!",
  label: "Usage",
  onReset: () => {},
  overridden: false,
  overriddenLabel: "Overridden",
  resetLabel: "Reset to default",
  ...overrides,
});

describe("SettingsFieldShell", () => {
  it("renders the control inside the row", () => {
    expect(collectText(SettingsFieldShell(baseProps()))).toContain(CONTROL);
  });

  it("labels the control with the field id", () => {
    const label = firstOf(SettingsFieldShell(baseProps()), "label");
    expect(label.props.htmlFor).toBe("plugin-config-opencode-usageEnabled");
    expect(label.props.children).toBe("Usage");
  });

  it("shows the override badge and a working reset only when overridden", () => {
    expect(findAll(SettingsFieldShell(baseProps()), "Tag")).toHaveLength(0);

    const onReset = vi.fn<() => void>();
    const overridden = SettingsFieldShell(
      baseProps({ onReset, overridden: true })
    );
    expect(findAll(overridden, "Tag")).toHaveLength(1);
    expect(collectText(overridden)).toContain("Overridden");

    const [reset] = findAll(overridden, "Button");
    assert.ok(reset, "expected a reset control");
    (reset.props.onClick as () => void)();
    expect(onReset).toHaveBeenCalledOnce();
  });

  it("propagates disabled to the reset control", () => {
    const tree = SettingsFieldShell(
      baseProps({ disabled: true, overridden: true })
    );
    const [reset] = findAll(tree, "Button");
    assert.ok(reset, "expected a reset control");
    expect(reset.props.disabled).toBe(true);
  });

  it("replaces the hint with the invalid copy when the draft is invalid", () => {
    const text = collectText(SettingsFieldShell(baseProps({ invalid: true })));
    expect(text).toContain("invalid!");
    expect(text).not.toContain("the hint");
  });

  it("paints the message line with host tokens", () => {
    // Same trap as the enum control: an invented variable name resolves to
    // nothing and its hard-coded fallback then ignores the theme.
    const colorOf = (element: TestElement): unknown =>
      (element.props.style as { color?: unknown }).color;
    expect(colorOf(firstOf(SettingsFieldShell(baseProps()), "p"))).toBe(
      "var(--dsw-alias-label-tertiary)"
    );
    expect(
      colorOf(firstOf(SettingsFieldShell(baseProps({ invalid: true })), "p"))
    ).toBe("var(--dsw-alias-state-error-primary)");
  });

  it("renders no message when there is neither a hint nor an invalid draft", () => {
    expect(
      findAll(SettingsFieldShell(baseProps({ hint: undefined })), "p")
    ).toHaveLength(0);
  });
});
