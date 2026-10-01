/**
 * The client bundle, exercised the way the web client loads it.
 *
 * `lib/client.js` is not a module the page imports — it is a factory the page
 * hands a `require` to, and everything it does happens inside that call. So the
 * thing worth testing is the contract at that boundary: that the built artifact
 * calls `window.__ModuleLoader__.load` with the right id(s), that its factory
 * returns `NS` / `inject` / `apply`, that it asks the host for its dependencies
 * rather than bundling them, and that `apply` registers slots properly.
 *
 * Reads `lib/client.js`, so `pnpm run build` must have run.
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";

import { describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BUNDLE = join(ROOT, "lib/client.js");

if (!existsSync(BUNDLE)) {
  throw new Error(
    "lib/client.js is missing — run `pnpm run build` before the tests"
  );
}

const SOURCE = readFileSync(BUNDLE, "utf8");

interface RegistrationSpec {
  id: string;
  factory: (require: (name: string) => unknown) => {
    NS: string;
    LEGACY_NS?: string;
    PKG?: string;
    LEGACY_PKG?: string;
    inject: string[];
    apply: (ctx: unknown) => void;
  };
}

const evaluateBundle = (): {
  loaded: string[];
  registrations: RegistrationSpec[];
} => {
  const loaded: string[] = [];
  const registrations: RegistrationSpec[] = [];

  const window = {
    __ModuleLoader__: {
      load: (spec: RegistrationSpec) => {
        registrations.push(spec);
      },
    },
  };

  const requireStub = (name: string) => {
    loaded.push(name);
    if (name === "react/jsx-runtime" || name === "react") {
      const el = (
        type: unknown,
        props: Record<string, unknown>,
        ...rest: unknown[]
      ) => ({
        children: rest,
        props: props ?? {},
        type,
      });
      return { Fragment: "Fragment", jsx: el, jsxs: el };
    }
    if (name === "@deepseek-ai/dsh-client-ui-primitives") {
      return {
        SegmentedControl: () => null,
        SettingsForm: () => null,
        SettingsFormModel: class {
          actions() {
            return {
              discard: () => {},
              edit: () => {},
              resetField: () => {},
              save: async () => true,
            };
          }
          bind<T>(fn: () => T) {
            return fn;
          }
          dispose() {}
          field() {
            return { invalid: false, overridden: false, text: "" };
          }
          shell() {
            return {
              available: true,
              dirty: false,
              failed: false,
              invalid: false,
              saving: false,
              writable: true,
            };
          }
        },
        SettingsSecretField: () => null,
        SettingsValueField: () => null,
        Switch: () => null,
        settingsBooleanField: (field: string) => ({
          field,
          format: String,
          parse: () => {},
        }),
        settingsNumberField: (field: string) => ({
          field,
          format: String,
          parse: () => {},
        }),
        settingsTextField: (field: string) => ({
          field,
          format: String,
          parse: () => {},
        }),
      };
    }
    throw new Error(`Undeclared client dependency: ${name}`);
  };

  const module_ = { exports: {} };
  runInNewContext(SOURCE, {
    exports: module_.exports,
    module: module_,
    require: requireStub,
    window,
  });

  return { loaded, registrations };
};

describe("client-bundle: artifact & VM loader boundary", () => {
  it("points at lib/client.js in package manifest and includes it in files", () => {
    const pkg = JSON.parse(
      readFileSync(join(ROOT, "package.json"), "utf8")
    ) as {
      exports: Record<string, { default: string }>;
      files: string[];
    };
    expect(pkg.exports["./client"]?.default).toBe("./lib/client.js");
    expect(
      pkg.files.includes("lib") || pkg.files.includes("lib/client.js")
    ).toBe(true);
  });

  it("calls window.__ModuleLoader__.load for all 4 aliases", () => {
    const { registrations } = evaluateBundle();
    const registeredIds = registrations.map((r) => r.id);

    expect(registeredIds).toContain("dsh-opencode-patch");
    expect(registeredIds).toContain("@viztor/dsh-opencode");
    expect(registeredIds).toContain("@viztor/dsh-opencode-patch");
    expect(registeredIds).toContain("dsh-opencode");
  });

  it("exports NS, LEGACY_NS, PKG, LEGACY_PKG, inject, and apply from factory", () => {
    const { registrations } = evaluateBundle();
    const primary = registrations.find((r) => r.id === "dsh-opencode-patch");
    assert.ok(primary, "primary registration found");

    const requireStub = (name: string): unknown => {
      if (name === "react" || name === "react/jsx-runtime") {
        return { Fragment: "Fragment", jsx: () => null, jsxs: () => null };
      }
      if (name === "@deepseek-ai/dsh-client-ui-primitives") {
        return {
          SettingsForm: () => null,
          SettingsFormModel: class {
            actions() {
              return {};
            }
            bind() {
              return () => {};
            }
            dispose() {}
            field() {
              return {};
            }
            shell() {
              return {};
            }
          },
          SettingsValueField: () => null,
          settingsBooleanField: (field: string) => ({ field }),
          settingsTextField: (field: string) => ({ field }),
        };
      }
      return {};
    };

    const exports = primary.factory(requireStub);
    expect(exports.NS).toBe("dsh-opencode-patch");
    expect(exports.LEGACY_NS).toBe("dsh-opencode");
    expect(exports.PKG).toBe("dsh-opencode-patch");
    expect(exports.LEGACY_PKG).toBe("@viztor/dsh-opencode");
    expect(exports.inject).toEqual([
      "slots",
      "locale",
      "configForms",
      "modelDirectories",
      "remote",
    ]);
    expect(typeof exports.apply).toBe("function");
  });

  it("runs apply() in VM context and registers slots cleanly", () => {
    const { registrations } = evaluateBundle();
    const primary = registrations.find((r) => r.id === "dsh-opencode-patch");
    assert.ok(primary, "primary registration found");

    const requireStub = (name: string): unknown => {
      if (name === "react" || name === "react/jsx-runtime") {
        return { Fragment: "Fragment", jsx: () => null, jsxs: () => null };
      }
      if (name === "@deepseek-ai/dsh-client-ui-primitives") {
        return {
          SettingsForm: () => null,
          SettingsFormModel: class {
            actions() {
              return {};
            }
            bind() {
              return () => ({});
            }
            dispose() {}
            field() {
              return { invalid: false, overridden: false, text: "" };
            }
            shell() {
              return {
                available: true,
                dirty: false,
                failed: false,
                invalid: false,
                saving: false,
                writable: true,
              };
            }
          },
          SettingsValueField: () => null,
          settingsBooleanField: (field: string) => ({ field }),
          settingsTextField: (field: string) => ({ field }),
        };
      }
      return {};
    };

    const exports = primary.factory(requireStub);

    const registeredSlots: string[] = [];
    const ctx = {
      configForms: {
        get: () => ({
          getSnapshot: () => ({
            base: {},
            revision: 1,
            status: "ready",
            user: {},
            value: {},
            writable: true,
          }),
          mutate: async () => true,
          subscribe: () => () => {},
        }),
        whileServed: (_ns: string[], cb: () => void) => cb(),
      },
      effect: (fn: () => unknown) => fn(),
      locale: {
        bind: () => (k: string) => k,
        register: () => () => {},
      },
      slots: {
        inject: (name: string, cb: () => void) => {
          registeredSlots.push(name);
          cb();
        },
        register: () => {},
      },
    };

    exports.apply(ctx);
    expect(registeredSlots).toContain("conversation.composer.dock");
    expect(registeredSlots).toContain("plugins.bundle.config");
    // Exactly one usage slot. The bundle used to register the meter in
    // `conversation.input.right` as well, and since both slots render, the
    // composer showed two identical meters.
    expect(registeredSlots).not.toContain("conversation.input.right");
    expect(
      registeredSlots.filter((slot) => slot === "conversation.composer.dock")
    ).toHaveLength(1);
  });
});
