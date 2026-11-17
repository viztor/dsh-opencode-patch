/**
 * The settings page: the OpenCode card as it renders.
 *
 * @module test/settings-page-card.test
 */
import assert from "node:assert/strict";

import { describe, expect, it, vi } from "vitest";

import {
  COMPONENT_BY_KIND,
  controlsInOrder,
  fieldOf,
} from "./support/card-tree.ts";
import {
  applySettingsPage as apply,
  CARD_FIELDS,
  CONFIG_ONLY_FIELDS,
  en,
  ENDPOINT_FAMILIES,
  KEY_SOURCE_POLICIES,
  PKG,
} from "./support/src.ts";
import { collectText, elementName, findAll, firstOf } from "./test-helpers.ts";

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
      choiceFields.map((field) => [fieldOf(field), field])
    );
    const choiceField = choiceFieldsById.get("keySource");
    assert.ok(choiceField, "expected a keySource SettingsChoiceField");
    // The enum's choices are copy-resolved before they reach the control.
    expect(
      (choiceField.props.options as { label: string; value: string }[]).map(
        (option) => option.value
      )
    ).toEqual([...KEY_SOURCE_POLICIES]);
    // The endpoint family's choices, from the same table `config-values` exports.
    const endpointField = choiceFieldsById.get("endpoint");
    assert.ok(endpointField, "expected an endpoint SettingsChoiceField");
    expect(
      (endpointField.props.options as { label: string; value: string }[]).map(
        (option) => option.value
      )
    ).toEqual([...ENDPOINT_FAMILIES]);

    // No config-only knob may appear as a control: the simplified UI has to stay
    // simplified, and an override must not become editable by accident.
    const renderedFields = [...boolFields, ...choiceFields].map(fieldOf);
    for (const { field } of CONFIG_ONLY_FIELDS) {
      expect(renderedFields).not.toContain(field);
    }

    // Test boolean field edit, addressed by field rather than by position: the
    // render order is the card's own decision, and a positional read breaks the
    // moment a field moves between sections.
    const userAgentField = boolFields.find(
      (field) => fieldOf(field) === "injectUserAgent"
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

  it("says once, on the page view, that the settings apply when the plugin is applied again", () => {
    // A Settings write takes the loader's volatile-only path and the plugin
    // reads its row once, at apply, so an edit lands on the next apply. The
    // card says so once, above the form, rather than in every control's hint.
    const Card = mountCard();
    const seat = (k: string): string => `seat:${k}`;
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
    const tree = Card({
      discard: () => {},
      edit: () => {},
      resetField: () => {},
      save: () => {},
      t: seat,
      useOpencodeCard: (selector: (s: typeof state) => unknown) =>
        selector(state),
      view: "page",
    });
    const line = seat("appliesOnReapply");
    expect(collectText(tree).filter((text) => text === line)).toHaveLength(1);
    // Not inside a control: no control carries it as a label or a hint.
    const controls = controlsInOrder(tree);
    expect(controls).toHaveLength(CARD_FIELDS.length);
    for (const control of controls) {
      expect(Object.values(control.props)).not.toContain(line);
      expect(collectText(control)).not.toContain(line);
    }

    const summary = Card({ t: seat, view: "summary" }) as {
      props: { children: unknown };
    };
    expect(summary.props.children).toBe(seat("description"));
  });

  it("renders one control per register entry, in register order", () => {
    const tree = renderPage(mountCard());
    const controls = controlsInOrder(tree);

    // The card's field list is the register's, so it cannot drift again.
    expect(controls.map(fieldOf)).toEqual(
      CARD_FIELDS.map((entry) => entry.field)
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
    const fields = controlsInOrder(renderPage(mountCard())).map(fieldOf);
    expect(fields).toContain("enrichModels");
  });

  it("renders one heading per group, in register order", () => {
    const headings = findAll(renderPage(mountCard()), "GroupHeading");
    const groups = [...new Set(CARD_FIELDS.map((entry) => entry.group))];
    expect(headings).toHaveLength(groups.length);
    expect(headings.map((heading) => heading.props.label)).toEqual(
      groups.map((group) => en[group])
    );
    // The separator rule above every heading after the first is the card's
    // sheet's, pinned on the mounted card (card-rendered-tokens).
  });

  it("wires each control's edit and reset back to the form model", () => {
    // The card hands each control a label and two callbacks (and a choice
    // field an id). The callbacks went unasserted once, so a control could
    // render perfectly and do nothing. Every control is driven, and each must
    // edit and reset the field it is keyed by: that ties `fieldOf` (the React
    // key) to what the control does, so the order, config-only and
    // enrichModels pins above, which read the key, read the edited field.
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

    const controls = controlsInOrder(tree);
    // Every register entry rendered, so the loop below cannot pass over none.
    expect(controls.map(fieldOf)).toEqual(
      CARD_FIELDS.map((entry) => entry.field)
    );
    for (const control of controls) {
      edit.mockClear();
      resetField.mockClear();
      (control.props.onEdit as (text: string) => void)("draft");
      (control.props.onReset as () => void)();
      expect(edit.mock.calls, fieldOf(control)).toEqual([
        [fieldOf(control), "draft"],
      ]);
      expect(resetField.mock.calls, fieldOf(control)).toEqual([
        [fieldOf(control)],
      ]);
    }
  });
});
