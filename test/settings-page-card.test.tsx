/**
 * The settings page: the OpenCode card as it renders.
 *
 * @module test/settings-page-card.test
 */
import assert from "node:assert/strict";

import { describe, expect, it, vi } from "vitest";

import { COMPONENT_BY_KIND, controlsInOrder } from "./support/card-tree.ts";
import {
  applySettingsPage as apply,
  CARD_FIELDS,
  CONFIG_ONLY_FIELDS,
  en,
  ENDPOINT_FAMILIES,
  KEY_SOURCE_POLICIES,
  PKG,
} from "./support/src.ts";
import { elementName, findAll, firstOf } from "./test-helpers.ts";

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
      inject: (_deps: string[], callback: (scope: unknown) => unknown) =>
        callback(ctx),
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

    // Every register entry renders exactly one control: booleans as
    // SettingsBooleanField (with Switch inside), the enum as SettingsChoiceField.
    const boolFields = findAll(tree, "SettingsBooleanField");
    const choiceFields = findAll(tree, "SettingsChoiceField");
    const valueFields = findAll(tree, "SettingsValueField");
    expect(boolFields.length + choiceFields.length + valueFields.length).toBe(
      CARD_FIELDS.length
    );
    // The card shows only the decisions a user makes — 7 toggles and 2 enums.
    // Every literal/marker override is config-only (see CONFIG_ONLY_FIELDS), so
    // no text or list field renders at all.
    // Seven booleans: the meter's own switch is one, and there is no nested
    // price switch inside it.
    expect(boolFields.length).toBe(7);
    expect(choiceFields.length).toBe(2);
    expect(valueFields.length).toBe(0);
    const choiceFieldsById = new Map(
      choiceFields.map((field) => [String(field.props.id), field])
    );
    const choiceField = choiceFieldsById.get(
      "plugin-config-opencode-keySource"
    );
    assert.ok(choiceField, "expected a keySource SettingsChoiceField");
    // The enum's choices are copy-resolved before they reach the control.
    expect(
      (choiceField.props.options as { label: string; value: string }[]).map(
        (option) => option.value
      )
    ).toEqual([...KEY_SOURCE_POLICIES]);
    // The endpoint family's choices, from the same table `config-values` exports.
    const endpointField = choiceFieldsById.get(
      "plugin-config-opencode-endpoint"
    );
    assert.ok(endpointField, "expected an endpoint SettingsChoiceField");
    expect(
      (endpointField.props.options as { label: string; value: string }[]).map(
        (option) => option.value
      )
    ).toEqual([...ENDPOINT_FAMILIES]);

    // No config-only knob may appear as a control: the simplified UI has to stay
    // simplified, and an override must not become editable by accident.
    const renderedIds = [...boolFields, ...choiceFields].map((f) => f.props.id);
    for (const { field } of CONFIG_ONLY_FIELDS) {
      expect(renderedIds).not.toContain(`plugin-config-opencode-${field}`);
    }

    // Test boolean field edit, addressed by id rather than by position: the
    // render order is the card's own decision, and a positional read breaks the
    // moment a field moves between sections.
    const userAgentField = boolFields.find(
      (field) => field.props.id === "plugin-config-opencode-injectUserAgent"
    );
    assert.ok(
      userAgentField,
      "expected an injectUserAgent SettingsBooleanField"
    );
    const onBoolEdit = userAgentField.props.onEdit as (text: string) => void;
    onBoolEdit("false");
    expect(edits).toContainEqual({ field: "injectUserAgent", text: "false" });

    // Test enum edit: the select stages the raw option value.
    const onChoiceEdit = choiceField.props.onEdit as (text: string) => void;
    onChoiceEdit("request");
    expect(edits).toContainEqual({ field: "keySource", text: "request" });

    // Test reset callback
    const onReset = userAgentField.props.onReset as () => void;
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

  const renderPage = (Card: ReturnType<typeof mountCard>) => {
    const state = {
      fields: {},
      shell: {
        available: true,
        dirty: false,
        failed: false,
        invalid: false,
        saving: false,
        writable: true,
      },
    };
    return Card({
      discard: () => {},
      edit: () => {},
      resetField: () => {},
      save: () => {},
      t: (k: string) => k,
      useOpencodeCard: (selector: (s: typeof state) => unknown) =>
        selector(state),
      view: "page",
    });
  };

  it("renders one control per register entry, in register order", () => {
    const tree = renderPage(mountCard());
    const controls = controlsInOrder(tree);

    // The card's field list is the register's, so it cannot drift again.
    expect(controls.map((f) => f.props.id)).toEqual(
      CARD_FIELDS.map((entry) => `plugin-config-opencode-${entry.field}`)
    );
    // The control kind follows the register's `kind`, not a second list.
    expect(controls.map((f) => elementName(f.type))).toEqual(
      CARD_FIELDS.map((entry) => COMPONENT_BY_KIND[entry.kind])
    );
    // Labels come from the register's copy keys, through the card's translator,
    // so the two cannot disagree. The mock seat translates nothing (it returns
    // the key), which is why this also pins the bundle fallback: a control whose
    // copy the seat cannot render must still reach the screen as words.
    expect(controls.map((f) => f.props.label)).toEqual(
      CARD_FIELDS.map((entry) => en[entry.labelKey])
    );
  });

  it("offers exactly the key-source policies the host accepts", () => {
    // The select's values and the config enum are two lists in two modules; a
    // value offered here but not accepted there would be silently coerced back
    // to the default on save.
    const entry = CARD_FIELDS.find((field) => field.field === "keySource");
    assert.ok(entry, "expected a keySource register entry");
    expect(entry.kind).toBe("select");
    expect((entry.options ?? []).map((option) => option.value)).toEqual([
      ...KEY_SOURCE_POLICIES,
    ]);
  });

  it("renders the documented enrichModels switch", () => {
    // Regression guard: it was declared in the spec register and translated
    // (en + zh) but omitted from the card's hand-written JSX, so the switch
    // documented in the README could not be reached from the UI.
    const ids = controlsInOrder(renderPage(mountCard())).map((f) => f.props.id);
    expect(ids).toContain("plugin-config-opencode-enrichModels");
  });

  it("renders one heading per group, in register order", () => {
    const headings = findAll(renderPage(mountCard()), "GroupHeading");
    const groups = [...new Set(CARD_FIELDS.map((entry) => entry.group))];
    expect(headings).toHaveLength(groups.length);
    expect(headings.map((heading) => heading.props.label)).toEqual(
      groups.map((group) => en[group])
    );
    // Only the first heading drops the separator rule.
    expect(headings.map((heading) => heading.props.first)).toEqual(
      groups.map((_, index) => index === 0)
    );
  });

  it("wires each control's edit and reset back to the form model", () => {
    // The card hands the host an id, a label and two callbacks per control. The
    // ids and labels were asserted; the callbacks were not, so a control could
    // render perfectly and do nothing.
    const edit = vi.fn();
    const resetField = vi.fn();
    const state = {
      fields: {},
      shell: {
        available: true,
        dirty: false,
        failed: false,
        invalid: false,
        saving: false,
        writable: true,
      },
    };
    const Card = mountCard();
    const tree = Card({
      discard: () => {},
      edit,
      resetField,
      save: () => {},
      t: (k: string) => k,
      useOpencodeCard: (selector: (s: typeof state) => unknown) =>
        selector(state),
      view: "page",
    });

    const [first] = controlsInOrder(tree);
    const name = CARD_FIELDS[0]?.field ?? "";
    assert.ok(first, "expected at least one control");
    (first.props.onEdit as (text: string) => void)("draft");
    (first.props.onReset as () => void)();
    expect(edit).toHaveBeenCalledWith(name, "draft");
    expect(resetField).toHaveBeenCalledWith(name);
  });
});
