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

import { type FieldShellProps, SettingsFieldShell } from "./support/src.ts";
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

  it("shows the field's label without a `for` aimed at an id no control carries", () => {
    // The Switch takes no id and the SegmentedControl ids only its tabs, so a
    // `<label for={id}>` dangled; each control names itself through its own
    // `label`. A label aimed at the selected tab would rename that tab.
    const tree = SettingsFieldShell(baseProps());
    expect(findAll(tree, "label")).toHaveLength(0);
    const label = firstOf(tree, "span");
    expect(label.props.className).toBe("dsh-oc-card-field-label");
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

  it("marks the message line as a message, and as invalid while the draft is", () => {
    // The colours are the card's sheet's (`settings-css.ts`): which token each
    // class is drawn in is pinned on the mounted card (card-rendered-tokens),
    // and host-tokens holds every token the sheet names to the host's own.
    const classOf = (element: TestElement): unknown => element.props.className;
    expect(classOf(firstOf(SettingsFieldShell(baseProps()), "p"))).toBe(
      "dsh-oc-card-field-message"
    );
    expect(
      classOf(firstOf(SettingsFieldShell(baseProps({ invalid: true })), "p"))
    ).toBe("dsh-oc-card-field-message dsh-oc-card-field-message-invalid");
  });

  it("renders no message when there is neither a hint nor an invalid draft", () => {
    expect(
      findAll(SettingsFieldShell(baseProps({ hint: undefined })), "p")
    ).toHaveLength(0);
  });
});
