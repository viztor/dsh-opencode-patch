import assert from "node:assert/strict";

import { describe, expect, it, vi } from "vitest";

import {
  apply,
  LEGACY_NS,
  LEGACY_PKG,
  NS,
  PKG,
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

    expect(inputRegistrations).toHaveLength(1);
    expect(inputRegistrations[0]?.entry.order).toBe(1000);
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
      readUsage: () => Promise<unknown>;
      t: (k: string) => string;
    };
    expect(injected).toBeDefined();
    expect(injected.directory).toEqual({ isDirectory: true });

    const val = await injected.readUsage();
    expect(val).toEqual({ test: 123 });
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

    // Verify SettingsValueFields exist in tree
    const valueFields = findAll(tree, "SettingsValueField");
    expect(valueFields.length).toBeGreaterThanOrEqual(9);

    // Test form field edit callbacks
    const [firstField] = valueFields;
    assert.ok(firstField);
    const onEdit = firstField.props.onEdit as (val: string) => void;
    onEdit("false");
    expect(edits).toEqual([{ field: "injectUserAgent", text: "false" }]);

    // Test form field reset callbacks
    const onReset = firstField.props.onReset as () => void;
    onReset();
    expect(resets).toEqual(["injectUserAgent"]);
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
    for (const field of valueFields) {
      expect(field.props.disabled).toBe(true);
    }
  });
});
