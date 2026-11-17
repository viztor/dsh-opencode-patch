// @vitest-environment jsdom
/**
 * The settings card, mounted whole, read for what it DECLARES: which host
 * token each state is drawn in, that the summary's refresh glyph turns with
 * no meter on the page, that nothing is styled inline, and that every id
 * reference the card emits names an element it renders.
 *
 * Pins of the rendered behaviour, not of the markup: each reads the
 * declaration through `declaredStyle` (inline first, then the sheets in the
 * document), so it holds while a colour moves from a `style` prop into the
 * card's own stylesheet, and fails if the token it names changes on the way.
 * The purge line's two colours are pinned in `settings-card-purge.test.tsx`,
 * their subject; this file holds the states no other file pins.
 *
 * @module test/card-rendered-tokens.test
 */
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";

(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

// The host's UI kit imports `clsx`, which this package does not install; the
// stand-ins render real elements (see test/support/ui-primitives.ts).
vi.mock(
  "@deepseek-ai/dsh-client-ui-primitives",
  () => import("./support/ui-primitives.ts")
);

import type { GoUsage } from "../src/contracts/usage.ts";
import { OpencodeCard } from "../src/settings-card.tsx";
import { en } from "../src/settings-copy.ts";
import { declaredStyle, inlineDeclarations } from "./support/declared-style.ts";

const shell = {
  available: true,
  dirty: false,
  failed: false,
  invalid: false,
  saving: false,
  writable: true,
};

type Fields = Record<
  string,
  { invalid: boolean; overridden: boolean; text: string }
>;

const props = (extra: Record<string, unknown>, fields: Fields = {}) =>
  ({
    discard: () => {},
    edit: () => {},
    resetField: () => {},
    save: () => {},
    getLocale: () => "en",
    t: (key: string) => key,
    useOpencodeCard: (selector: (s: unknown) => unknown) =>
      selector({ fields, shell }),
    view: "page",
    ...extra,
  }) as never;

/** The card mounted into the document, with a settle and a cleanup. */
const mount = async (extra: Record<string, unknown>, fields?: Fields) => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  act(() => {
    root.render(createElement(OpencodeCard, props(extra, fields)));
  });
  const settle = async (): Promise<void> => {
    await act(async () => {
      await new Promise((resolve) => {
        setTimeout(resolve, 0);
      });
    });
  };
  await settle();
  const cleanup = (): void => {
    act(() => {
      root.unmount();
    });
    host.remove();
  };
  const button = (label: string): HTMLButtonElement | undefined =>
    [...host.querySelectorAll("button")].find((b) =>
      (b.textContent ?? "").includes(label)
    );
  /** Click the button labelled `label`; a button that never rendered throws. */
  const press = (label: string): void => {
    const found = button(label);
    if (found === undefined) {
      throw new Error(`expected a button labelled ${label}`);
    }
    found.click();
  };
  return { cleanup, host, press, settle };
};

const KEY_SOURCE = "plugin-config-opencode-keySource";

/**
 * The shell root of the choice field id'd `id`, reached from one of its
 * segments (`<id>-<value>`): the field's label is a plain element, so the
 * control is the one thing that carries the id.
 */
const fieldRoot = (host: Element, id: string): Element => {
  const root = host
    .querySelector(`[role="tab"][id^="${id}-"]`)
    ?.closest(".dsh-oc-card-field");
  if (root === null || root === undefined) {
    throw new Error(`expected the ${id} field to be rendered`);
  }
  return root;
};

const READING: GoUsage = {
  monthly: { percent: 40, resetsAt: "2026-12-01T00:00:00Z", status: "ok" },
  rolling: { percent: 12, resetsAt: "2026-11-18T00:00:00Z", status: "ok" },
  source: "opencode-go",
  weekly: { percent: 55, resetsAt: "2026-11-20T00:00:00Z", status: "ok" },
};

describe("the mounted card: the token each state is drawn in", () => {
  it("a field's message is declared tertiary, and error-primary while the draft is invalid", async () => {
    for (const [invalid, token] of [
      [false, "var(--dsw-alias-label-tertiary)"],
      [true, "var(--dsw-alias-state-error-primary)"],
    ] as const) {
      // oxlint-disable-next-line no-await-in-loop -- one card at a time.
      const { cleanup, host } = await mount(
        {},
        { keySource: { invalid, overridden: false, text: "auto" } }
      );
      try {
        const row = fieldRoot(host, KEY_SOURCE);
        const message = row.querySelector("p");
        expect(message, "the keySource field's message").not.toBeNull();
        // The text says WHICH message was read: the hint, or the invalid copy
        // that replaces it — never another field's line.
        expect(message?.textContent).toBe(
          invalid ? en.invalidText : en.keySourceHint
        );
        expect(declaredStyle(message, "color")).toBe(token);
      } finally {
        cleanup();
      }
    }
  });

  it("lets the choice field's control drop under its label, and keeps a switch beside its own", async () => {
    const { cleanup, host } = await mount({});
    try {
      const head = (root: Element): Element | null =>
        root.querySelector(".dsh-oc-card-field-head");
      expect(
        declaredStyle(head(fieldRoot(host, KEY_SOURCE)), "flex-wrap")
      ).toBe("wrap");
      const switchRoot = host
        .querySelector('input[type="checkbox"]')
        ?.closest(".dsh-oc-card-field");
      expect(switchRoot, "a boolean field").not.toBeNull();
      expect(
        head(switchRoot ?? host),
        "the boolean field's head"
      ).not.toBeNull();
      expect(declaredStyle(head(switchRoot ?? host), "flex-wrap")).toBe("");
    } finally {
      cleanup();
    }
  });

  it("draws the separator rule above every group heading but the first", async () => {
    const { cleanup, host } = await mount({});
    try {
      const labels = new Set<string>([
        en.groupAccess,
        en.groupModels,
        en.groupQuota,
        en.groupRequests,
      ]);
      const headings = [...host.querySelectorAll("div")].filter(
        (element) =>
          labels.has(element.textContent ?? "") &&
          element.querySelector("div") === null
      );
      expect(headings.length, "the group headings").toBeGreaterThan(1);
      const rules = headings.map((heading) =>
        declaredStyle(heading, "border-top")
      );
      expect(rules[0]).toBe("");
      for (const rule of rules.slice(1)) {
        expect(rule).toBe("0.5px solid var(--dsw-alias-border-l2)");
      }
    } finally {
      cleanup();
    }
  });

  it("the summary's refresh glyph turns while a read is in flight, with no meter mounted", async () => {
    let settleRead: (value: GoUsage) => void = () => {};
    const readUsage = vi.fn(
      () =>
        new Promise<GoUsage>((resolve) => {
          settleRead = resolve;
        })
    );
    const { cleanup, host, settle } = await mount({ readUsage });
    try {
      /** The icon and every ancestor up to (and with) its button. */
      const glyphPath = (): Element[] => {
        // The plugin's own class, the one the card's sheet animates — not a
        // stand-in's attribute.
        const icon = host.querySelector(".dsh-oc-card-refresh-icon");
        expect(icon, "the summary's refresh icon").not.toBeNull();
        const path: Element[] = [];
        for (
          let at: Element | null = icon;
          at !== null && at !== host;
          at = at.parentElement
        ) {
          path.push(at);
          if (at.tagName === "BUTTON") {
            break;
          }
        }
        return path;
      };
      const turning = (): boolean =>
        glyphPath().some(
          (element) => getComputedStyle(element).animationName === "dsh-oc-spin"
        );

      expect(readUsage).toHaveBeenCalled();
      expect(turning(), "the glyph turns while the read is in flight").toBe(
        true
      );
      const keyframes = [...document.styleSheets]
        .flatMap((sheet) => [...sheet.cssRules])
        .filter(
          (rule): rule is CSSKeyframesRule =>
            rule instanceof CSSKeyframesRule && rule.name === "dsh-oc-spin"
        );
      expect(keyframes.length, "the spin's keyframes").toBeGreaterThan(0);
      expect(document.querySelector(".dsh-oc-usage-root")).toBeNull();

      act(() => {
        settleRead(READING);
      });
      await settle();
      expect(turning(), "the glyph rests once the read settled").toBe(false);
    } finally {
      cleanup();
    }
  });
});

describe("the mounted card: styles live in a sheet", () => {
  it("the inline scan reports a property, a re-declared host token and a custom property holding a colour, and lets the bar fill's percent through", () => {
    // Known answers for the scan the two cases below rely on.
    const root = document.createElement("div");
    const own = document.createElement("span");
    own.className = "own";
    own.style.setProperty("--dsh-oc-usage-fill", "40%");
    const theme = document.createElement("span");
    theme.className = "theme";
    theme.style.setProperty("--dsw-alias-label-primary", "white");
    const plain = document.createElement("span");
    plain.className = "plain";
    plain.style.setProperty("color", "red");
    // A plugin property other than the bar's, and the bar's holding a colour:
    // a named colour behind a custom property a sheet reads.
    const tint = document.createElement("span");
    tint.className = "tint";
    tint.style.setProperty("--dsh-oc-tint", "white");
    const fill = document.createElement("span");
    fill.className = "fill";
    fill.style.setProperty("--dsh-oc-usage-fill", "white");
    const fraction = document.createElement("span");
    fraction.className = "fraction";
    fraction.style.setProperty("--dsh-oc-usage-fill", "12.5%");
    root.append(own, theme, plain, tint, fill, fraction);
    expect(inlineDeclarations(root)).toEqual([
      "span.theme --dsw-alias-label-primary",
      "span.plain color",
      "span.tint --dsh-oc-tint",
      "span.fill --dsh-oc-usage-fill: white",
    ]);
  });

  it("the mounted card declares nothing inline but custom properties", async () => {
    const { cleanup, host, press, settle } = await mount({
      inspectStore: async () => ({
        inspection: {
          account: { email: "someone@example.com", type: "oauth" },
          found: true,
        },
        kind: "inspected",
      }),
      purgeDeprecated: async () => ({ kind: "failed", message: "boom" }),
      // Never settles: the summary stays in its refreshing state.
      readUsage: () => new Promise<GoUsage>(() => {}),
    });
    try {
      act(() => {
        press(en.purgeAction);
        press(en.storeInspect);
      });
      await settle();
      expect(host.textContent).toContain(en.purgeFailed);
      expect(host.textContent).toContain("someone@example.com");
      expect(inlineDeclarations(host)).toEqual([]);
    } finally {
      cleanup();
    }
  });

  it("the settled card declares nothing inline either: the summary's rows and allowance, the removal row, an overridden field", async () => {
    // The surfaces that held most of the inline styles this sheet replaced:
    // each is asserted PRESENT first, so the scan cannot pass over a state
    // that never rendered.
    const { cleanup, host } = await mount(
      {
        purgeDeprecated: async () => ({
          kind: "purged",
          result: { catalogRead: true, removed: [] },
        }),
        readUsage: async () => ({
          ...READING,
          allowance: { go: 60, goPlus: 120, model: "Model X" },
        }),
        removeUnserved: async () => ({
          kind: "purged",
          result: { catalogRead: true, removed: [] },
        }),
        reviewPurge: async () => ({
          kind: "review",
          review: {
            piRead: true,
            unserved: [{ id: "gap-1", provider: "opencode" }],
          },
        }),
      },
      { keySource: { invalid: false, overridden: true, text: "request" } }
    );
    try {
      expect(host.textContent, "the allowance line").toContain("Model X");
      expect(
        host.querySelectorAll(".dsh-oc-card-summary-row").length,
        "the window rows"
      ).toBe(3);
      expect(host.textContent, "the removal row's detail").toContain(
        "opencode: gap-1"
      );
      expect(host.textContent, "the override badge").toContain(en.overridden);
      expect(
        [...host.querySelectorAll("button")].some(
          (button) => button.textContent === en.reset
        ),
        "the reset button"
      ).toBe(true);
      expect(inlineDeclarations(host)).toEqual([]);

      // The removal row sits under the purge row with a gap of its own, which
      // the sheet gives every action row after the first.
      const actions = [...host.querySelectorAll(".dsh-oc-card-action")];
      expect(actions.length, "the purge row and the removal row").toBe(2);
      expect(declaredStyle(actions[0], "margin-top")).toBe("");
      expect(declaredStyle(actions[1], "margin-top")).toBe("12px");
    } finally {
      cleanup();
    }
  });
});

/** Attributes whose value is a list of ids that must name rendered elements. */
const IDREF_ATTRIBUTES = [
  "for",
  "aria-activedescendant",
  "aria-controls",
  "aria-describedby",
  "aria-details",
  "aria-errormessage",
  "aria-flowto",
  "aria-labelledby",
  "aria-owns",
] as const;

/** Every id reference under `root` that names no element in the document. */
const danglingReferences = (root: Element): string[] =>
  [...root.querySelectorAll("*")].flatMap((element) =>
    IDREF_ATTRIBUTES.flatMap((attribute) =>
      (element.getAttribute(attribute) ?? "")
        .split(/\s+/u)
        .filter(
          (id) =>
            id !== "" &&
            document.querySelector(`[id=${JSON.stringify(id)}]`) === null
        )
        .map(
          (id) =>
            `<${element.tagName.toLowerCase()} ${attribute}="${id}">${element.getAttribute("role") === null ? "" : ` role=${String(element.getAttribute("role"))}`}`
        )
    )
  );

/**
 * The one recorded exception: the host's `SegmentedControl` names a
 * `<id>-<value>-panel` in each tab's `aria-controls`, and the card, which uses
 * it as a value picker, renders no panel. A host gap (D26), not compensated
 * with placeholder panels; the plan's P11 row records it.
 */
const isSegmentPanelReference = (line: string): boolean =>
  /^<button aria-controls="plugin-config-opencode-[A-Za-z]+-.*-panel"> role=tab$/u.test(
    line
  );

describe("the mounted card: every id reference resolves", () => {
  it("no `for` or aria reference the card emits names a missing element, the segment panels aside", async () => {
    const { cleanup, host, press, settle } = await mount(
      {
        inspectStore: async () => ({
          inspection: {
            account: { email: "someone@example.com", type: "oauth" },
            found: true,
          },
          kind: "inspected",
        }),
        purgeDeprecated: async () => ({ kind: "failed", message: "boom" }),
        readUsage: async () => READING,
      },
      { keySource: { invalid: true, overridden: true, text: "request" } }
    );
    try {
      act(() => {
        press(en.purgeAction);
        press(en.storeInspect);
      });
      await settle();
      // Each state the scan is about is asserted PRESENT first, so it cannot
      // pass over markup that never rendered.
      expect(host.textContent, "the purge outcome").toContain(en.purgeFailed);
      expect(host.textContent, "the store report").toContain(
        "someone@example.com"
      );
      expect(host.textContent, "the invalid field's message").toContain(
        en.invalidText
      );
      expect(host.textContent, "the override badge").toContain(en.overridden);
      const dangling = danglingReferences(host);
      // The known answer: the segment panels ARE missing, so a check that read
      // nothing (or a stand-in that dropped the attribute) cannot pass here.
      const panels = dangling.filter(isSegmentPanelReference);
      expect(
        panels.length,
        "the choice tabs' panel references"
      ).toBeGreaterThan(0);
      expect(dangling.filter((line) => !isSegmentPanelReference(line))).toEqual(
        []
      );
    } finally {
      cleanup();
    }
  });
});
