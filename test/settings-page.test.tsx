import assert from "node:assert/strict";

import { describe, expect, it, vi } from "vitest";

import {
  apply,
  LEGACY_NS,
  LEGACY_PKG,
  NS,
  PKG,
  SPECS,
} from "../src/settings-page.tsx";

interface TestElement {
  props: { children?: unknown; [key: string]: unknown };
  type: unknown;
}

const isElement = (node: unknown): node is TestElement =>
  typeof node === "object" &&
  node !== null &&
  "type" in node &&
  "props" in node &&
  typeof (node as { props: unknown }).props === "object";

const nameOf = (type: unknown): string => {
  if (typeof type === "string") return type;
  if (typeof type === "function") return type.name || "fn";
  return String(type);
};

const findAll = (
  node: unknown,
  type: string,
  acc: TestElement[] = []
): TestElement[] => {
  if (!isElement(node)) return acc;
  if (nameOf(node.type) === type) acc.push(node);
  const { children } = node.props;
  if (Array.isArray(children)) {
    for (const child of children) findAll(child, type, acc);
  } else if (children !== undefined) {
    findAll(children, type, acc);
  }
  return acc;
};

const firstOf = (tree: unknown, type: string): TestElement => {
  const [found] = findAll(tree, type);
  assert.ok(found, `expected a ${type} in the tree`);
  return found;
};

describe("settings-page: apply & slots", () => {
  it("registers dictionaries for modern and legacy namespaces without throwing", () => {
    const registered: Record<string, unknown> = {};
    const ctx = {
      effect: (fn: () => unknown) => fn(),
      locale: {
        bind: () => (k: string) => k,
        register: (ns: string, dicts: unknown) => {
          registered[ns] = dicts;
        },
      },
    };

    apply(ctx as never);
    expect(registered[NS]).toBeDefined();
    expect(registered[LEGACY_NS]).toBeDefined();
  });

  it("registers plugins.bundle.config for all 3 package aliases", () => {
    const bundleRegistrations: Array<{
      entry: Record<string, unknown>;
      component: unknown;
    }> = [];
    const dockRegistrations: Array<{
      entry: Record<string, unknown>;
      component: unknown;
    }> = [];
    const inputRegistrations: Array<{
      entry: Record<string, unknown>;
      component: unknown;
    }> = [];

    const snapshot = {
      base: {},
      revision: 1,
      status: "ready",
      user: {},
      value: {},
      writable: true,
    };

    const ctx = {
      configForms: {
        get: () => ({
          getSnapshot: () => snapshot,
          mutate: async () => true,
          subscribe: () => () => {},
        }),
        whileServed: (_namespaces: string[], fn: () => void) => fn(),
      },
      effect: (fn: () => unknown) => fn(),
      locale: {
        bind: () => (k: string) => k,
        register: () => () => {},
      },
      slots: {
        inject: (name: string, fn: () => void) => fn(),
        register: (entry: Record<string, unknown>, component: unknown) => {
          if (entry.name === "plugins.bundle.config") {
            bundleRegistrations.push({ entry, component });
          } else if (entry.name === "conversation.composer.dock") {
            dockRegistrations.push({ entry, component });
          } else if (entry.name === "conversation.input.right") {
            inputRegistrations.push({ entry, component });
          }
        },
      },
    };

    apply(ctx as never);

    expect(bundleRegistrations).toHaveLength(3);
    const keys = bundleRegistrations.map((r) => r.entry.key);
    expect(keys).toContain(PKG);
    expect(keys).toContain(LEGACY_PKG);
    expect(keys).toContain(LEGACY_NS);

    expect(dockRegistrations).toHaveLength(1);
    expect(dockRegistrations[0]?.entry.order).toBe(50);
    expect(dockRegistrations[0]?.entry.id).toBe("dsh-opencode-patch-usage");

    // The meter registers in exactly ONE slot. It used to also register in
    // `conversation.input.right`, and because both slots render, the composer
    // drew two identical meters side by side.
    expect(inputRegistrations).toHaveLength(0);
  });

  it("handles usage injector logic and remote reading", async () => {
    let dockInjector: ((sessionId: unknown) => unknown) | undefined;
    const remoteUsage = vi
      .fn()
      .mockResolvedValue({ ok: true, value: { test: 123 } });

    const ctx = {
      effect: (fn: () => unknown) => fn(),
      modelDirectories: {
        directoryFor: (id: unknown) =>
          id === "valid" ? { store: { isDirectory: true } } : undefined,
      },
      remote: {
        opencodeGoUsage: {
          read: remoteUsage,
        },
      },
      slots: {
        inject: (_name: string, fn: () => void) => fn(),
        register: (entry: Record<string, unknown>) => {
          if (entry.name === "conversation.composer.dock") {
            dockInjector = entry.inject as (s: unknown) => unknown;
          }
        },
      },
    };

    apply(ctx as never);
    expect(dockInjector).toBeDefined();

    // Invalid session ID returns null
    expect(dockInjector?.("invalid")).toBeNull();

    // Valid session ID returns injected props
    const injected = dockInjector?.("valid") as {
      directory: unknown;
      providerMarkers: string[];
      readUsage: () => Promise<unknown>;
      t: (k: string) => string;
    };
    expect(injected).toBeDefined();
    expect(injected.directory).toEqual({ isDirectory: true });
    // No scope in this context: the meter falls back to the plugin defaults.
    expect(injected.providerMarkers).toEqual(["opencode-go", "opencode"]);

    const val = await injected.readUsage();
    expect(val).toEqual({ test: 123 });
  });

  it("sends the provider and conversation id with every usage read", async () => {
    let dockInjector: ((sessionId: unknown) => unknown) | undefined;
    const remoteUsage = vi
      .fn()
      .mockResolvedValue({ ok: true, value: { test: 1 } });

    const ctx = {
      effect: (fn: () => unknown) => fn(),
      modelDirectories: { directoryFor: () => ({ store: {} }) },
      remote: { opencodeGoUsage: { read: remoteUsage } },
      slots: {
        inject: (_name: string, fn: () => void) => fn(),
        register: (entry: Record<string, unknown>) => {
          if (entry.name === "conversation.composer.dock") {
            dockInjector = entry.inject as (s: unknown) => unknown;
          }
        },
      },
    };

    apply(ctx as never);
    const injected = dockInjector?.("session-xyz") as {
      readUsage: (provider?: string) => Promise<unknown>;
    };

    // Both halves matter: the provider picks the route/account, and the
    // session id stops two open conversations from reading one total.
    await injected.readUsage("opencode-go");
    expect(remoteUsage).toHaveBeenLastCalledWith({
      provider: "opencode-go",
      sessionId: "session-xyz",
    });

    // An unnamed provider omits the key entirely rather than sending "".
    await injected.readUsage();
    expect(remoteUsage).toHaveBeenLastCalledWith({ sessionId: "session-xyz" });
    await injected.readUsage("");
    expect(remoteUsage).toHaveBeenLastCalledWith({ sessionId: "session-xyz" });
  });

  it("hides the meter when the Host serves no usage service", () => {
    // The Host registers `opencodeGoUsage` only while Usage Quota Tracking is
    // on, so an absent service is how "switched off" reaches the client. The
    // injector returning null means the slot renders nothing at all, rather
    // than an unavailable meter the user cannot act on.
    let dockInjector: ((sessionId: unknown) => unknown) | undefined;

    const ctx = {
      effect: (fn: () => unknown) => fn(),
      modelDirectories: {
        directoryFor: () => ({ store: {} }),
      },
      slots: {
        inject: (_name: string, fn: () => void) => fn(),
        register: (entry: Record<string, unknown>) => {
          if (entry.name === "conversation.composer.dock") {
            dockInjector = entry.inject as (s: unknown) => unknown;
          }
        },
      },
    };

    apply(ctx as never);
    expect(dockInjector).toBeDefined();
    expect(dockInjector?.("session")).toBeNull();
  });

  it("passes configured quota-meter markers from the scope to the injector", () => {
    let dockInjector: ((sessionId: unknown) => unknown) | undefined;

    const ctx = {
      configForms: {
        get: () => ({
          getSnapshot: () => ({
            base: {},
            revision: 1,
            status: "ready",
            user: {},
            value: {
              usageModelMarkers: ["custom-go-model"],
              usageProviderMarkers: ["custom-go-route"],
            },
            writable: true,
          }),
          mutate: async () => true,
          subscribe: () => () => {},
        }),
        whileServed: (_namespaces: string[], fn: () => void) => fn(),
      },
      effect: (fn: () => unknown) => fn(),
      modelDirectories: {
        directoryFor: () => ({ store: { isDirectory: true } }),
      },
      remote: {
        opencodeGoUsage: {
          read: async () => ({ ok: true, value: {} }),
        },
      },
      slots: {
        inject: (_name: string, fn: () => void) => fn(),
        register: (entry: Record<string, unknown>) => {
          if (entry.name === "conversation.composer.dock") {
            dockInjector = entry.inject as (s: unknown) => unknown;
          }
        },
      },
    };

    apply(ctx as never);
    const injected = dockInjector?.("valid") as {
      providerMarkers: string[];
    };
    expect(injected.providerMarkers).toEqual(["custom-go-route"]);
  });

  it("unpacks remote errors properly in readUsage", async () => {
    let dockInjector: ((sessionId: unknown) => unknown) | undefined;
    const remoteUsage = vi.fn().mockResolvedValue({
      ok: false,
      error: new Error("Rate limit exceeded"),
    });

    const ctx = {
      effect: (fn: () => unknown) => fn(),
      modelDirectories: {
        directoryFor: () => ({ store: {} }),
      },
      remote: {
        opencodeGoUsage: {
          read: remoteUsage,
        },
      },
      slots: {
        inject: (_name: string, fn: () => void) => fn(),
        register: (entry: Record<string, unknown>) => {
          if (entry.name === "conversation.composer.dock") {
            dockInjector = entry.inject as (s: unknown) => unknown;
          }
        },
      },
    };

    apply(ctx as never);
    const injected = dockInjector?.("valid") as {
      readUsage: () => Promise<unknown>;
    };

    await expect(injected.readUsage()).rejects.toThrow("Rate limit exceeded");
  });

  it("degrades gracefully if configForms is missing or not a valid scope", () => {
    const ctx = {
      effect: (fn: () => unknown) => fn(),
      slots: {
        inject: vi.fn(),
        register: vi.fn(),
      },
    };

    expect(() => apply(ctx as never)).not.toThrow();
  });
});

describe("settings-page: OpencodeCard rendering", () => {
  const mountCard = () => {
    let cardComponent:
      | ((props: Record<string, unknown>) => unknown)
      | undefined;
    const snapshot = {
      base: {},
      revision: 1,
      status: "ready",
      user: {},
      value: {
        injectUserAgent: true,
        usageEnabled: true,
      },
      writable: true,
    };

    const ctx = {
      configForms: {
        get: () => ({
          getSnapshot: () => snapshot,
          mutate: async () => true,
          subscribe: () => () => {},
        }),
        whileServed: (_namespaces: string[], fn: () => void) => fn(),
      },
      effect: (fn: () => unknown) => fn(),
      locale: {
        bind: () => (k: string) => k,
        register: () => () => {},
      },
      slots: {
        inject: (_name: string, fn: () => void) => fn(),
        register: (entry: Record<string, unknown>, component: unknown) => {
          if (entry.key === PKG) {
            cardComponent = component as (
              props: Record<string, unknown>
            ) => unknown;
          }
        },
      },
    };

    apply(ctx as never);
    assert.ok(cardComponent, "card component registered");
    return cardComponent;
  };

  it("renders summary view as the description string", () => {
    const Card = mountCard();
    const result = Card({
      view: "summary",
      t: (k: string) => `translated:${k}`,
    }) as {
      props: { children: unknown };
    };
    expect(result.props.children).toBe("translated:description");
  });

  it("renders page view with SettingsForm and all configuration fields", () => {
    const Card = mountCard();
    const edits: Array<{ field: string; text: string }> = [];
    const resets: string[] = [];
    const saveMock = vi.fn();
    const discardMock = vi.fn();

    const state = {
      fields: {
        injectUserAgent: { invalid: false, overridden: true, text: "true" },
        providers: {
          invalid: false,
          overridden: false,
          text: "opencode, opencode-go",
        },
        usageBaseURL: {
          invalid: false,
          overridden: false,
          text: "https://opencode.ai/zen/go/v1",
        },
        usageEnabled: { invalid: false, overridden: false, text: "true" },
      },
      shell: {
        available: true,
        dirty: false,
        failed: false,
        invalid: false,
        saving: false,
        writable: true,
      },
    };

    const tree = Card({
      discard: discardMock,
      edit: (field: string, text: string) => edits.push({ field, text }),
      resetField: (field: string) => resets.push(field),
      save: saveMock,
      t: (k: string) => k,
      useOpencodeCard: (selector: (s: typeof state) => unknown) =>
        selector(state),
      view: "page",
    });

    const form = firstOf(tree, "SettingsForm");
    expect(form).toBeDefined();

    // Boolean fields render as SettingsBooleanField (with Switch inside),
    // text/list fields remain SettingsValueField. Total = 14 (debug/debugFile are file-only, usageModelMarkers removed).
    const valueFields = findAll(tree, "SettingsValueField");
    const boolFields = findAll(tree, "SettingsBooleanField");
    expect(valueFields.length + boolFields.length).toBe(14);
    // 9 text/list fields, 5 boolean fields:
    expect(valueFields.length).toBe(9);
    expect(boolFields.length).toBe(5);
    const ids = valueFields.map((f) => f.props.id);
    for (const knob of [
      "freeModelMarker",
      "gatewayUrls",
      "originClient",
      "sessionIdEnv",
      "usageBaseURL",
      "usageKeyEnv",
      "usageProviderMarkers",
    ]) {
      expect(ids).toContain(`plugin-config-opencode-${knob}`);
    }
    const boolIds = boolFields.map((f) => f.props.id);
    for (const knob of [
      "injectUserAgent",
      "injectOriginHeaders",
      "injectProject",
      "injectCoreTools",
      "usageEnabled",
    ]) {
      expect(boolIds).toContain(`plugin-config-opencode-${knob}`);
    }

    // Test boolean field edit: first boolean field is injectUserAgent
    const [firstBool] = boolFields;
    assert.ok(firstBool);
    const onBoolEdit = firstBool.props.onEdit as (text: string) => void;
    onBoolEdit("false");
    expect(edits).toContainEqual({ field: "injectUserAgent", text: "false" });

    // Test text field edit via the first SettingsValueField (userAgent)
    const [firstValueField] = valueFields;
    assert.ok(firstValueField);
    const onEdit = firstValueField.props.onEdit as (val: string) => void;
    onEdit("opencode/custom");
    expect(edits).toContainEqual({
      field: "userAgent",
      text: "opencode/custom",
    });

    // Test reset callback
    const onReset = firstBool.props.onReset as () => void;
    onReset();
    expect(resets).toContain("injectUserAgent");
  });

  it("disables fields when writable is false", () => {
    const Card = mountCard();

    const state = {
      fields: {},
      shell: {
        available: true,
        dirty: false,
        failed: false,
        invalid: false,
        saving: false,
        writable: false,
      },
    };

    const tree = Card({
      discard: () => {},
      edit: () => {},
      resetField: () => {},
      save: () => {},
      t: (k: string) => k,
      useOpencodeCard: (selector: (s: typeof state) => unknown) =>
        selector(state),
      view: "page",
    });

    const valueFields = findAll(tree, "SettingsValueField");
    for (const f of valueFields) {
      expect(f.props.disabled).toBe(true);
    }
    const boolFields = findAll(tree, "SettingsBooleanField");
    for (const f of boolFields) {
      expect(f.props.disabled).toBe(true);
    }
  });
});

describe("settings-page: field specs", () => {
  const specOf = (field: string) => {
    const found = SPECS.find((s) => s.field === field);
    assert.ok(found, `expected a spec for ${field}`);
    return found;
  };

  it("covers every field the card renders, in render order", () => {
    expect(SPECS.map((s) => s.field)).toEqual([
      "injectUserAgent",
      "userAgent",
      "injectOriginHeaders",
      "originClient",
      "injectProject",
      "injectCoreTools",
      "freeModelMarker",
      "enrichModels",
      "providers",
      "gatewayUrls",
      "sessionIdEnv",
      "usageEnabled",
      "showUsagePrice",
      "usageBaseURL",
      "usageKeyEnv",
      "usageProviderMarkers",
    ]);
  });

  it("round-trips list fields as arrays, not strings", () => {
    const providers = specOf("providers");
    expect(providers.format(["opencode", "opencode-go"])).toBe(
      "opencode, opencode-go"
    );
    expect(providers.parse("opencode , opencode-go ")).toEqual({
      kind: "set",
      value: ["opencode", "opencode-go"],
    });
    // An empty draft clears the field so it re-inherits the default.
    expect(providers.parse(" , ")).toEqual({ kind: "clear" });
    // A non-list stored value renders as an empty draft rather than junk.
    expect(providers.format("not-a-list")).toBe("");
  });

  it("keeps boolean and text fields on their stock semantics", () => {
    const inject = specOf("injectCoreTools");
    expect(inject.format(true)).toBe("true");
    expect(inject.format("not-a-boolean")).toBe("");
    expect(inject.parse("TRUE")).toEqual({ kind: "set", value: true });
    expect(inject.parse("")).toEqual({ kind: "clear" });
    expect(inject.parse("maybe")).toBeUndefined();

    const marker = specOf("freeModelMarker");
    expect(marker.format("free")).toBe("free");
    expect(marker.parse("  pro  ")).toEqual({ kind: "set", value: "pro" });
    expect(marker.parse("   ")).toEqual({ kind: "clear" });
  });
});
