/**
 * A stand-in for `@deepseek-ai/dsh-client-ui-primitives`.
 *
 * The real package is supplied by the Host in the browser and does not resolve
 * outside it — it imports `*.module.css` and host-only workspace utilities that
 * a consumer does not have. Tests that import the settings page's *source*
 * alias it here, so this file's code is what runs and only the host's UI kit is
 * faked. `test/client-bundle.test.ts` evaluates the built bundle against an
 * equivalent stub, so the two agree on the contract.
 *
 * `SettingsFormModel` is modelled closely enough to be worth testing against:
 * it stages drafts, `field()` reports the staged text, and `save()` persists.
 */

import {
  Children,
  cloneElement,
  isValidElement,
  type ReactElement,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";

interface FieldState {
  invalid: boolean;
  overridden: boolean;
  text: string;
}

/** One conversion spec, as the primitives build them. */
function spec(field: string) {
  return {
    field,
    format: (value: unknown) =>
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
        ? String(value)
        : "",
    parse: (text: string) =>
      text === ""
        ? { kind: "clear" as const }
        : { kind: "set" as const, value: text },
  };
}

export const settingsTextField = (field: string) => ({
  field,
  // Mirrors the real primitive: only strings render, and a draft is trimmed
  // on the way in — an all-blank draft clears the field.
  format: (value: unknown) => (typeof value === "string" ? value : ""),
  parse: (text: string) => {
    const trimmed = text.trim();
    return trimmed === ""
      ? { kind: "clear" as const }
      : { kind: "set" as const, value: trimmed };
  },
});
export const settingsNumberField = (field: string) => spec(field);

export interface SecretSpec {
  field: string;
  write: (value: string) => Promise<boolean>;
}

interface FormScope {
  getSnapshot: () => { value?: unknown; user?: unknown; writable: boolean };
}

export class SettingsFormModel {
  private readonly staged = new Map<string, string>();
  private readonly cleared = new Set<string>();
  private readonly secrets: Map<string, SecretSpec>;
  private readonly specs: Map<string, ReturnType<typeof spec>>;
  private readonly value: Record<string, unknown>;
  private readonly user: Record<string, unknown>;
  private readonly scope: FormScope;

  constructor(
    scope: FormScope,
    specs: ReturnType<typeof spec>[],
    secrets: SecretSpec[] = []
  ) {
    this.scope = scope;
    this.specs = new Map(specs.map((one) => [one.field, one]));
    this.secrets = new Map(secrets.map((one) => [one.field, one]));
    const snapshot = scope.getSnapshot();
    this.value = (snapshot.value ?? {}) as Record<string, unknown>;
    this.user = (snapshot.user ?? {}) as Record<string, unknown>;
  }

  field(field: string): FieldState {
    if (this.secrets.has(field)) {
      return {
        invalid: false,
        overridden: false,
        text: this.staged.get(field) ?? "",
      };
    }
    if (this.cleared.has(field)) {
      return { invalid: false, overridden: false, text: "" };
    }
    if (this.staged.has(field)) {
      const stored = this.specs.get(field);
      const text = this.staged.get(field) ?? "";
      return {
        invalid: stored ? stored.parse(text) === undefined : false,
        overridden: true,
        text,
      };
    }
    const stored = this.specs.get(field);
    if (!stored) throw new Error(`plugin card has no field ${field}`);
    return {
      invalid: false,
      overridden: Object.hasOwn(this.user, field),
      text: stored.format(this.value[field]),
    };
  }

  shell() {
    const snapshot = this.scope.getSnapshot();
    return {
      available: true,
      dirty: this.staged.size > 0,
      failed: false,
      invalid: [...this.staged.keys()].some(
        (field) => this.field(field).invalid
      ),
      saving: false,
      writable: snapshot.writable,
    };
  }

  bind<T>(project: () => T): () => T {
    return project;
  }

  actions() {
    return {
      discard: () => {
        this.staged.clear();
        this.cleared.clear();
      },
      edit: (field: string, text: string) => {
        this.cleared.delete(field);
        this.staged.set(field, text);
      },
      resetField: (field: string) => {
        this.staged.delete(field);
        this.cleared.add(field);
      },
      save: async (): Promise<boolean> => {
        if (
          [...this.staged.keys()].some((field) => this.field(field).invalid)
        ) {
          return false;
        }
        for (const [field, text] of this.staged) {
          const secret = this.secrets.get(field);
          if (secret) {
            const value = text.trim();
            if (value === "") continue;
            if (!(await secret.write(value))) return false;
            continue;
          }
          this.user[field] = text;
        }
        return true;
      },
    };
  }

  dispose(): void {
    this.staged.clear();
    this.cleared.clear();
  }
}

type KitProps = Record<string, unknown> & { children?: ReactNode };

export function SettingsForm(props: KitProps) {
  return { props, type: "SettingsForm" };
}

export function SettingsSecretField(props: KitProps) {
  return { props, type: "SettingsSecretField" };
}

export function SettingsValueField(props: KitProps) {
  return { props, type: "SettingsValueField" };
}

export function Button(props: KitProps) {
  return { props, type: "Button" };
}

export function Switch(props: KitProps) {
  return { props, type: "Switch" };
}

/**
 * Real elements, like `Tooltip` below: the settings tests only walk this tree,
 * but the meter's mount test RENDERS its panel — and the panel draws the badge
 * with `Tag`, so a `{props, type}` object here would fail as "Element type is
 * invalid" exactly the way the missing `Tooltip` did.
 *
 * Mirrors the host: a span, a `data-tone`, the children through.
 */
export function Tag({ children, tone = "outline" }: KitProps) {
  return (
    <span className="dsh-stub-tag" data-tone={tone}>
      {children}
    </span>
  );
}

/**
 * `StateDot` renders for real: the meter's window rows draw one per quota
 * window, so a `{props, type}` object would fail the same way `Tag` did. The
 * stub keeps the host's contract — `data-state` on a span sized by `size`
 * (default 10, 14 for the ongoing spinner) — so tests can assert WHICH state a
 * row shows, which is the fact that matters now that the colour lives in the
 * kit's stylesheet.
 */
export function StateDot({
  state,
  size,
  className,
}: {
  state: "done" | "warning" | "ongoing" | "error" | "idle";
  size?: number;
  className?: string;
}) {
  const edge = size ?? 10;
  return (
    <span
      aria-hidden="true"
      className={
        className === undefined
          ? "dsh-stub-state-dot"
          : `dsh-stub-state-dot ${className}`
      }
      data-state={state}
      style={{ height: edge, width: edge }}
    />
  );
}

/**
 * Icons must be REAL elements here too, for the same reason `Tag` is: the meter
 * renders the refresh button with the host's own icon, and a `{props, type}`
 * object fails as "Element type is invalid" the moment the panel mounts. The
 * third time this stub has been the thing that broke — missing `Tooltip`, then
 * `Tag`, now an icon. When the meter starts drawing a kit export, check this file
 * in the SAME commit.
 *
 * Mirrors the host: `(props) => <Artwork {...props} strokeWidth={…} />` over an
 * `svg` with a `size = 16` default, so the stub keeps `className`/`size`.
 */
export interface IconProps {
  className?: string;
  size?: number;
}

export function IconInfoOutlineRegular({ className, size = 16 }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      data-stub-icon="info"
      height={size}
      viewBox="0 0 16 16"
      width={size}
    />
  );
}

export function IconRefreshOutlineRegular({ className, size = 16 }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      data-stub-icon="refresh"
      height={size}
      viewBox="0 0 16 16"
      width={size}
    />
  );
}

export function SegmentedControl(props: KitProps) {
  return { props, type: "SegmentedControl" };
}

/**
 * The one kit component the meter actually RENDERS, so unlike the exports above
 * — which return `{props, type}` because the settings tests only walk the tree —
 * this one returns elements and holds state. It was missing entirely, so
 * `Tooltip` resolved to `undefined` in every mount test and all thirteen died on
 * "Element type is invalid" while the rest of the suite stayed green.
 *
 * Mirrors the host primitive on the points a test can observe
 * (`Tooltip.module.css` + the compiled `Tooltip`): it CLONES its single child
 * rather than wrapping it, composes the child's own handlers before its own, and
 * renders the bubble as a SIBLING with `role="tooltip"`. The bubble is inert to
 * the pointer, which matters here — the pill opens its panel on hover, and a
 * tooltip that swallowed those events would open a panel nobody could close.
 * Positioning is the only thing dropped: it needs layout, and no test asserts a
 * coordinate.
 */
export interface TooltipProps {
  children?: ReactNode;
  delayMs?: number;
  disabled?: boolean;
  label?: ReactNode | (() => ReactNode);
  side?: string;
}

export function Tooltip({
  children,
  delayMs = 0,
  disabled = false,
  label,
  side = "right",
}: TooltipProps) {
  const [visible, setVisible] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancel = () => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  };

  useEffect(() => cancel, []);

  const child = Children.only(children) as ReactElement<
    Record<string, unknown>
  >;
  if (!isValidElement(child)) {
    return child;
  }

  /** The child's own handler first, then the tooltip's — as the host does it. */
  const compose = (name: string, next: () => void) => (event: unknown) => {
    const own = child.props[name];
    if (typeof own === "function") {
      (own as (arg: unknown) => void)(event);
    }
    next();
  };

  const show = () => {
    if (disabled) return;
    cancel();
    timer.current = setTimeout(() => {
      setVisible(true);
    }, delayMs);
  };

  const hide = () => {
    cancel();
    setVisible(false);
  };

  return (
    <>
      {cloneElement(child, {
        onBlur: compose("onBlur", hide),
        onFocus: compose("onFocus", show),
        onMouseEnter: compose("onMouseEnter", show),
        onMouseLeave: compose("onMouseLeave", hide),
      })}
      {visible ? (
        <span
          className="dsh-stub-tooltip-bubble"
          data-side={side}
          role="tooltip"
          style={{ pointerEvents: "none", position: "fixed" }}
        >
          {typeof label === "function" ? label() : label}
        </span>
      ) : null}
    </>
  );
}
