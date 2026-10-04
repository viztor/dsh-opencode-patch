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

import type { ReactNode } from "react";

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

export function Tag(props: KitProps) {
  return { props, type: "Tag" };
}

export function SegmentedControl(props: KitProps) {
  return { props, type: "SegmentedControl" };
}
