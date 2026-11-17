/**
 * Stand-ins for the host's UI primitives, so a test process can RENDER them.
 *
 * `@deepseek-ai/dsh-client-ui-primitives` imports `clsx`, which this package does
 * not install, so requiring the real module throws in a test — measured. Every
 * UI test used to work around that by walking the returned element tree by hand,
 * which never runs hooks, never runs handlers, and never noticed when the card
 * returned something React itself would reject.
 *
 * These render plain HTML. They are deliberately faithful only for the parts the
 * card's assertions are about — a label inside a `<button>`, a `<input>` whose
 * `checked` follows the prop — and they must stay small for that reason: a
 * stand-in that grows behaviour is a second implementation to keep in step.
 *
 * @module test/support/ui-primitives
 */
import { createElement } from "react";

/**
 * The stand-ins that render real elements, shared with the tree-walk stub
 * rather than copied, so a test cannot pass in one family and not the other:
 * `Button` (the host's markup, attributes passed through and the `icon` in a
 * slot before the label), `Tag` (a span with its `data-tone`), `StateDot` (a
 * span carrying its `data-state`, so a pin can read which state a row shows),
 * the two icons (an `svg` keeping `className` and `size`), `Tooltip` (it
 * CLONES its child and renders a `role="tooltip"` bubble as a sibling while
 * shown, so a tooltip around a component instead of a DOM node fails a
 * mounted test), the host's `useDismissOnOutsidePointer` body (with its
 * `portal`) and its `SegmentedControl` markup (honouring an option's
 * `disabled` and `title`, `aria-controls` and the `className`). `SettingsForm`
 * and `Switch` stay separate below: the tree-walk stub returns `{props, type}`
 * objects for them, which a mounted test cannot render.
 */
export {
  Button,
  IconInfoOutlineRegular,
  IconRefreshOutlineRegular,
  SegmentedControl,
  StateDot,
  Tag,
  Tooltip,
  useDismissOnOutsidePointer,
} from "../primitives-stub.tsx";

/** A `SettingsForm` that renders its children and exposes the shell it got. */
export const SettingsForm = (props: {
  children?: React.ReactNode;
  shell?: unknown;
}) =>
  createElement(
    "form",
    { "data-shell": props.shell === undefined ? "none" : "given" },
    props.children
  );

/** A `Switch` that renders a checkbox, so `checked` is observable. */
export const Switch = (props: {
  checked?: boolean;
  disabled?: boolean;
  onChange?: (next: boolean) => void;
}) =>
  createElement("input", {
    checked: props.checked === true,
    disabled: props.disabled,
    onChange: () => props.onChange?.(!props.checked),
    readOnly: true,
    type: "checkbox",
  });

export const __esModule = true;
