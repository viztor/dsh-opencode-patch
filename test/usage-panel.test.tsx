/**
 * The quota meter's presentational components, asserted as element trees.
 *
 * `UsageTrigger` and `UsagePanel` are pure (no hooks), so they are invoked
 * directly and their output walked — the same technique the settings-card
 * tests use. What the meter *does* (polling, hover, retry) lives in
 * `usage-pill.tsx`; these cases pin what it *shows*.
 */

import assert from "node:assert/strict";

import { MenuSurface } from "@deepseek-ai/dsh-client-ui-primitives";
import { describe, expect, it, vi } from "vitest";

import type { SessionUsageSnapshot } from "../src/session-cost.ts";
import { en as copyEn, zh as copyZh } from "../src/settings-copy.ts";
import type { GoUsage } from "../src/usage-contract.ts";
import {
  UsagePanel,
  type UsagePanelProps,
  UsageTrigger,
  type UsageTriggerProps,
} from "../src/usage-panel.tsx";
import {
  CONSOLE_URL,
  GO_PLAN_URL,
  type RelativeReset,
  resetLabel,
  STYLES,
} from "../src/usage-ui.ts";
import {
  childrenOf,
  collectText,
  findAll,
  findAllOf,
  findAllWhere,
  firstOf,
  isElement,
  type TestElement,
} from "./test-helpers.ts";

const t = (key: string): string => `t:${key}`;

const isoAt = (offsetMs: number): string =>
  new Date(Date.now() + offsetMs).toISOString();

const usage = (overrides: Partial<GoUsage> = {}): GoUsage => ({
  monthly: { percent: 10, resetsAt: isoAt(86_400_000), status: "ok" },
  rolling: { percent: 20, resetsAt: isoAt(3_600_000), status: "ok" },
  weekly: { percent: 30, resetsAt: isoAt(3 * 86_400_000), status: "ok" },
  ...overrides,
});

it("renders unknown allowances before and after the JSON transport", () => {
  // The generator writes `Number.NaN` for a model the vendor's page does not
  // price. Whether today's table holds such a row is the vendor's choice, so
  // the allowance is built here in the shape the generator emits.
  const model = "gemini-4-argon";
  const raw = usage({
    allowance: { model, go: Number.NaN, goPlus: Number.NaN },
  });
  // JSON turns the catalog's NaN into null across the host/client boundary.
  // oxlint-disable-next-line unicorn/prefer-structured-clone -- exercise the host's JSON transport
  const transported = JSON.parse(JSON.stringify(raw)) as GoUsage;
  expect(transported.allowance?.go).toBeNull();
  for (const state of [raw, transported]) {
    const tree = UsagePanel(panelProps({ usage: state }));
    const text = collectText(tree);
    expect(text).toContain("t:monthlyAllowance");
    expect(text).toContain(model);
    expect(
      byClass(tree, "dsh-oc-usage-detail-value").some(
        (element) =>
          collectText(element).filter((part) => part === "—").length === 2
      )
    ).toBe(true);
    expect(text).not.toContain("$NaN");
    expect(text).not.toContain("$0");
  }
});

const session = (
  overrides: Partial<SessionUsageSnapshot> = {}
): SessionUsageSnapshot => ({
  cacheReadTokens: 0,
  costByPlane: { go: 0, zen: 0.42 },
  costFormatted: "$0.42",
  costUsd: 0.42,
  inputTokens: 10,
  modelsUsed: ["deepseek-v4.1-flash"],
  outputTokens: 20,
  totalTokens: 30,
  turns: 1,
  ...overrides,
});

const byClass = (tree: unknown, className: string): TestElement[] =>
  findAllWhere(tree, (element) => element.props.className === className);

/** Every className in the tree, in render order — for asserting WHERE a row sits. */
const classOrder = (node: unknown, acc: string[] = []): string[] => {
  if (!isElement(node)) {
    return acc;
  }
  const name = node.props.className;
  if (typeof name === "string") {
    acc.push(name);
  }
  for (const child of childrenOf(node)) {
    classOrder(child, acc);
  }
  return acc;
};

const triggerProps = (
  overrides: Partial<UsageTriggerProps> = {}
): UsageTriggerProps => ({
  displayPercent: 42,
  isLimited: false,
  isZen: false,
  onClick: () => {},
  open: false,
  ringColor: "var(--ring)",
  strokeDasharray: "3 34",
  t,
  tooltipLabel: "42% of Weekly used",
  triggerLabel: "42%",
  usage: undefined,
  ...overrides,
});

const panelProps = (
  overrides: Partial<UsagePanelProps> = {}
): UsagePanelProps => ({
  badgeText: "Go Plan",
  failure: null,
  title: "t:goPlanTitle",
  isLimited: false,
  isZen: false,
  locale: undefined,
  onMouseEnter: () => {},
  onMouseLeave: () => {},
  refreshing: false,
  retry: () => {},
  t,
  updatedAt: 1_700_000_000_000,
  usage: undefined,
  zenCardCredit: "t:zenPaygBadge",
  ...overrides,
});

describe("UsageTrigger", () => {
  it("renders the quota ring and reports its open/limited state", () => {
    const tree = UsageTrigger(triggerProps({ open: true }));
    const button = firstOf(tree, "button");
    expect(button.props.className).toBe("dsh-oc-usage-trigger");
    expect(button.props["aria-haspopup"]).toBe("dialog");
    expect(button.props["aria-expanded"]).toBe(true);
    expect(button.props["aria-label"]).toBe("t:usageTitle: 42%");

    const [fill] = byClass(tree, "dsh-oc-usage-ring-fill");
    assert.ok(fill, "expected a ring fill");
    expect(fill.props.strokeDasharray).toBe("3 34");
    expect(fill.props.style).toEqual({ stroke: "var(--ring)" });
    expect(collectText(tree)).toContain("42%");
  });

  it("marks a limited route and forwards clicks", () => {
    const onClick = vi.fn<() => void>();
    const tree = UsageTrigger(triggerProps({ isLimited: true, onClick }));
    const button = firstOf(tree, "button");
    expect(button.props.className).toBe(
      "dsh-oc-usage-trigger dsh-oc-usage-alert"
    );
    (button.props.onClick as () => void)();
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("does not paint the Zen trigger as an alert for a GO limit", () => {
    // `isLimited` is the GO window's state. On a Zen route it means nothing —
    // the route bills per token and no window of it can be exhausted — so the
    // red frame must not appear there.
    const tree = UsageTrigger(triggerProps({ isLimited: true, isZen: true }));
    expect(firstOf(tree, "button").props.className).toBe(
      "dsh-oc-usage-trigger"
    );
  });

  it("renders NO ring on Zen: there is no gauge to draw", () => {
    const tree = UsageTrigger(
      triggerProps({ isZen: true, usage: usage({ session: session() }) })
    );
    // The ring is a GAUGE, and Zen has none: a permanently hollow ring is
    // decoration. (It used to be a coin emoji here, which rendered as a moon in
    // some font stacks — the ring replaced it; the number replaces the ring.)
    expect(findAll(tree, "svg")).toHaveLength(0);
    expect(collectText(tree)).toContain("$0.42");
    expect(firstOf(tree, "button").props["aria-label"]).toBe(
      "t:zenPaygTitle (t:zenPaygBadge)"
    );
  });

  it("draws no badge at all when the label would be empty", () => {
    // The Go panel has nothing to say on the right until the plan is limited,
    // and an empty `Tag` is a frame around nothing.
    const plain = UsagePanel(panelProps({ badgeText: "", usage: usage() }));
    expect(findAllOf(plain, new Set(["Tag"])).length).toBe(0);
    // `Limited` is the case that earns the chip.
    const limited = UsagePanel(
      panelProps({ badgeText: "Limited", isLimited: true, usage: usage() })
    );
    expect(findAllOf(limited, new Set(["Tag"]))[0]?.props.tone).toBe("danger");
  });

  it("draws the badge with the host's Tag, not a hand-rolled span", () => {
    // The hand-rolled version used the HOVER fill token as its resting
    // background, so the chip sat permanently lit. `neutral` is the host's plain
    // label and `danger` its limit tone.
    const plain = UsagePanel(panelProps({ usage: usage() }));
    const [tag] = findAllOf(plain, new Set(["Tag"]));
    expect(tag?.props.tone).toBe("neutral");
    expect(collectText(plain)).toContain("Go Plan");

    const limited = UsagePanel(panelProps({ isLimited: true, usage: usage() }));
    expect(findAllOf(limited, new Set(["Tag"]))[0]?.props.tone).toBe("danger");
  });

  it("is ghost at rest and tinted only on hover", () => {
    // The composer's own controls carry no fill, and a tinted pill beside the
    // model selector reads as a chip with a frame of its own. The tint is the
    // affordance, so it has to be the HOVER state that draws it.
    const base = /\.dsh-oc-usage-trigger \{[^}]*\}/.exec(STYLES)?.[0];
    expect(base).toContain("background: transparent");

    const hover = /\.dsh-oc-usage-trigger:hover,[^}]*\}/.exec(STYLES)?.[0];
    expect(hover).toContain("--dsw-alias-interactive-bg-hover");
  });

  it("shows no spend label for Zen when the session has no record", () => {
    // Nothing to print, so the trigger carries no number — the honest state,
    // not a zero.
    expect(
      collectText(UsageTrigger(triggerProps({ isZen: true, usage: usage({}) })))
    ).not.toContain("t:zenPaygTitle");
  });

  it("puts the button INSIDE the tooltip, because the tooltip clones it", () => {
    // The host `Tooltip` clones its child and hands that clone the hover
    // handlers and the anchor ref. Wrapping the component instead attached them
    // to a component that ignores unknown props, and hovering the pill did
    // nothing at all — the wiring looked right and no test could see it.
    const tree = UsageTrigger(
      triggerProps({ tooltipLabel: "90% of Weekly used" })
    );

    const [tooltip] = findAllOf(tree, new Set(["Tooltip"]));
    expect(tooltip).toBeDefined();
    expect(tooltip.props.label).toBe("90% of Weekly used");
    // The clone's target: the button, not this component.
    expect(childrenOf(tooltip)).toContain(firstOf(tree, "button"));
  });
});

describe("UsagePanel", () => {
  it("composes the reset line with the grammar its shape needs", () => {
    // The bug this pins: one prefix key served both shapes, so the panel printed
    // `重置于 1h 11m` — "resets at 1h 11m" — for two of the three windows, while
    // being correct only for the absolute one. Nothing asserted this line at
    // all, which is why it shipped; `t` in this file echoes keys, so the real
    // dictionaries are used here.
    const en = {
      usageResetsAtPrefix: "Resets ",
      usageResetsAtSuffix: "",
      usageResetsIn: " until reset",
      usageResetPassed: "Already reset",
      usageResetUnderMinute: "<1m",
    };
    const zh = {
      usageResetsAtPrefix: "",
      usageResetsAtSuffix: "重置",
      usageResetsIn: "后重置",
      usageResetPassed: "已重置",
      usageResetUnderMinute: "<1分",
    };
    const duration: RelativeReset = { kind: "duration", text: "1h 11m" };
    const absolute: RelativeReset = {
      kind: "absolute",
      text: "Nov 7, 8:55 AM",
    };
    // The same instant as zh renders it — the date and time words are the
    // platform's, only the hour/minute separator is Chinese.
    const absoluteZh: RelativeReset = {
      kind: "absolute",
      text: "11月7日8点55分",
    };
    const passed: RelativeReset = { kind: "passed", text: "" };
    const translator =
      (dict: typeof en) =>
      (key: keyof typeof en): string =>
        dict[key];

    // A duration takes a SUFFIX — zh wants no space, en needs one, which is why
    // the copy carries its own leading space rather than the panel adding it.
    expect(resetLabel(duration, translator(en))).toBe("1h 11m until reset");
    expect(resetLabel(duration, translator(zh))).toBe("1h 11m后重置");
    // An instant takes a prefix in en and a SUFFIX in zh: the two languages
    // disagree about where the word goes, which is why the dictionary carries
    // both halves and one of them is empty per locale. `重置于 11月7日 08:55` was
    // the wrong shape AND the wrong time format.
    expect(resetLabel(absolute, translator(en))).toBe("Resets Nov 7, 8:55 AM");
    expect(resetLabel(absoluteZh, translator(zh))).toBe("11月7日8点55分重置");
    expect(resetLabel(absoluteZh, translator(en))).toBe(
      "Resets 11月7日8点55分"
    );
    // A window that already rolled over has no countdown to give, and must not
    // claim one.
    expect(resetLabel(passed, translator(en))).toBe("Already reset");
    expect(resetLabel(passed, translator(zh))).toBe("已重置");
    // Under a minute: copy, not a duration, so the unit localizes too — the old
    // hardcoded `<1m` put a Latin unit in the Chinese line.
    const underMinute: RelativeReset = { kind: "underMinute", text: "" };
    expect(resetLabel(underMinute, translator(en))).toBe("<1m until reset");
    expect(resetLabel(underMinute, translator(zh))).toBe("<1分后重置");
  });

  it("renders the composed reset line through the panel, in both languages", () => {
    // The gap that let `重置于 1h 11m` ship: `t` in this file echoes keys, so the
    // COMPOSED string was invisible to every panel test — only the helper was
    // ever asserted. These cases drive the real dictionaries through the real
    // component and read the line as a user would.
    const windows = {
      monthly: {
        percent: 10,
        resetsAt: isoAt(9 * 86400 * 1000),
        status: "ok" as const,
      },
      rolling: {
        percent: 20,
        // 90m30s, not a bare 90m: the formatter FLOORS, so a fixture sitting
        // exactly on the minute lands in the bucket below it the moment any
        // time passes between `isoAt()` and the assertion.
        resetsAt: isoAt(90 * 60 * 1000 + 30_000),
        status: "ok" as const,
      },
      weekly: {
        percent: 30,
        resetsAt: isoAt(3 * 86400 * 1000),
        status: "ok" as const,
      },
    };
    // `collectText` returns one entry PER TEXT NODE, so a substring assertion
    // needs them joined — `toContain` on the array would demand an exact match.
    const line = (locale: "en" | "zh"): string => {
      const dict = locale === "zh" ? copyZh : copyEn;
      return collectText(
        UsagePanel(
          panelProps({
            locale,
            t: (key: string) => dict[key as keyof typeof dict] ?? key,
            usage: usage(windows),
          })
        )
      ).join(" ");
    };

    // A duration reads as a suffix in both languages, with the units localized.
    expect(line("en")).toContain("1h 30m until reset");
    expect(line("zh")).toContain("1小时30分钟后重置");
    // An instant is a prefix in en and a suffix in zh.
    expect(line("en")).toMatch(/Resets [A-Z][a-z]{2} \d+, \d+:\d+ [AP]M/u);
    expect(line("zh")).toMatch(/月\d+日\d+点\d+分重置/u);
    // And the malformed composition this pins against never appears.
    expect(line("zh")).not.toContain("重置于 1小时");
    expect(line("zh")).not.toContain("重置于 3天");
  });

  it("keeps the spend row when there is nothing to price, and says so", () => {
    // The row used to be OMITTED when the accumulator held nothing for the
    // session — which reads as "this feature is gone", not as "no turns yet".
    // The accumulator is per-process and only counts OpenCode-route turns, so
    // that state is reachable on every host restart.
    const bare = UsagePanel(
      panelProps({ usage: usage({ session: undefined }) })
    );
    expect(collectText(bare)).toContain("t:sessionSpendEmpty");
    expect(collectText(bare)).toContain("—");
  });

  it("shows each panel its OWN plane's spend, not the session total", () => {
    // The accumulator folds every turn of a session into one number, and the
    // Zen panel once billed the session with it: $1.44 of GO allowance spend
    // displayed against a FREE model, on a panel that answers for the Zen
    // balance. The snapshot now carries the split, and each panel reads its own.
    // The projection is the HOST's job (attachSession knows the route's plane),
    // so each fixture arrives at the panel already projected — the same way the
    // wire delivers it.
    const base = {
      ...session(),
      costByPlane: { go: 1.44, zen: 0 } as const,
      costFormatted: "$1.44",
      costUsd: 1.44,
      freeModel: true,
    };

    // Zen: the free model spent nothing OF ZEN, whatever the session's total is.
    const zen = UsagePanel(
      panelProps({
        isZen: true,
        usage: usage({
          session: { ...base, planeCostFormatted: "$0.00", planeSpendUsd: 0 },
        }),
      })
    );
    expect(collectText(zen)).toContain("$0.00");
    expect(collectText(zen)).not.toContain("$1.44");

    // Go: the same session, projected for the Go allowance, which DID pay.
    const go = UsagePanel(
      panelProps({
        usage: usage({
          session: {
            ...base,
            planeCostFormatted: "$1.44",
            planeSpendUsd: 1.44,
          },
        }),
      })
    );
    expect(collectText(go)).toContain("$1.44");
  });

  it("renders a passed reset without inventing a countdown", () => {
    // End to end through the panel: a past `resetsAt` must reach the row as the
    // passed copy, never as `<1m`.
    const stale = usage({
      rolling: {
        percent: 4,
        resetsAt: "2026-10-07T00:00:00Z",
        status: "ok",
      },
    });
    const text = collectText(UsagePanel(panelProps({ usage: stale })));
    expect(text).toContain("t:usageResetPassed");
    expect(text).not.toContain("<1m");
  });

  it("draws each window's state through the kit's StateDot", () => {
    // The dot was a hand-rolled 6px circle with an inline backgroundColor per
    // state — one more look-alike of a primitive this repo already ships, with
    // the state ladder written twice (dot and bar). The rows now render the
    // kit's dot from the SEMANTIC (done/warning/error), and its stylesheet maps
    // those to the same `--dsw-alias-state-*` tokens; the bar keeps reading the
    // colour off the one shared map. Pinned on data-state, because that is the
    // fact the row asserts — the colour is the kit's business.
    const limited = usage({
      rolling: {
        percent: 100,
        resetsAt: "2026-11-01T00:00:00Z",
        status: "rate-limited",
      },
    });
    const trees: Array<[ReturnType<typeof UsagePanel>, string]> = [
      [UsagePanel(panelProps({ usage: usage() })), "done"],
      [
        UsagePanel(
          panelProps({
            usage: usage({
              rolling: {
                percent: 90,
                resetsAt: "2026-11-01T00:00:00Z",
                status: "ok",
              },
            }),
          })
        ),
        "warning",
      ],
      [UsagePanel(panelProps({ usage: limited })), "error"],
    ];
    // This file walks the UNMOUNTED tree, so the dot is a function element
    // typed `StateDot` — its span exists only when mounted (the mount file
    // covers that side). Assert the type and its `state` prop, which is the
    // fact the row asserts; the colour is the kit's stylesheet's business.
    for (const [tree, expected] of trees) {
      const dots = findAllOf(tree, new Set(["StateDot"]));
      expect(dots.length).toBe(3);
      expect(dots.map((dot) => dot.props.state)).toContain(expected);
    }
    // And the hand-rolled circle is gone from both sides.
    expect(STYLES).not.toContain("dsh-oc-usage-dot");
  });

  it("renders the Go breakdown: three window rows and the links", () => {
    const tree = UsagePanel(panelProps({ usage: usage() }));
    // The header names the ACCOUNT, not its state: it used to carry the ring's
    // own figure, so the one line identifying the surface changed on every poll
    // ("42% of Weekly used" → "Monthly quota limited"). That figure is the
    // trigger's hover label now, and both facts it stated are already here —
    // the badge, and each window's own row.
    expect(collectText(tree)).toContain("t:goPlanTitle");
    expect(collectText(tree)).not.toContain("42% of Weekly used");
    expect(collectText(tree)).toContain("Go Plan");

    // Three rows carry the whole breakdown, each with its own bar. The QUOTA
    // OVERVIEW strip of three cards stays dead — those were a second frame.
    expect(byClass(tree, "dsh-oc-usage-row")).toHaveLength(3);
    expect(byClass(tree, "dsh-oc-usage-bar")).toHaveLength(3);
    expect(byClass(tree, "dsh-oc-usage-card")).toHaveLength(0);
    // The console sits on the update row; the Go layer's own action row carries
    // the plan link, and it renders INSIDE that layer — above the shared spend
    // and footer rows, not below them.
    // Both actions, in the FOOTER, plan first. The plan link used to have its own
    // row behind a divider — one row taller, and a second action in a second
    // place. Every link now sits together and reads as what it is.
    expect(findAll(tree, "a").map((a) => a.props.href)).toEqual([
      GO_PLAN_URL,
      CONSOLE_URL,
    ]);
    const order = classOrder(tree);
    for (const name of ["dsh-oc-usage-links", "dsh-oc-usage-divider"]) {
      expect(order).not.toContain(name);
    }
    // The console is inside the footer, after the timestamp it refreshes.
    expect(order.indexOf("dsh-oc-usage-console")).toBeGreaterThan(
      order.indexOf("dsh-oc-usage-updated")
    );
    expect(byClass(tree, "dsh-oc-usage-console")).toHaveLength(2);
  });

  it("refreshes by icon beside the timestamp, not by a second label", () => {
    // "更新于 06:46 PM" already says what the control does; a button repeating it
    // as text made the row two sentences long for no gain. The label moves to
    // aria-label, so it is still announced.
    const tree = UsagePanel(panelProps({ usage: usage() }));
    const [refresh] = byClass(tree, "dsh-oc-usage-refresh");
    expect(refresh?.props["aria-label"]).toBe("t:usageRetry");
    expect(refresh?.props.type).toBe("button");
    // The glyph is a component, not a raw <svg>: the panel is invoked as a
    // plain function in these tests, so nothing renders it out.
    expect(findAllOf(tree, new Set(["RefreshIcon"]))).toHaveLength(1);

    // While a read is in flight the control says so and stops accepting clicks.
    const busy = UsagePanel(panelProps({ refreshing: true, usage: usage() }));
    expect(byClass(busy, "dsh-oc-usage-refresh")[0]?.props["aria-label"]).toBe(
      "t:usageRefreshing"
    );
    expect(byClass(busy, "dsh-oc-usage-refresh")[0]?.props.disabled).toBe(true);
  });

  it("gives Zen one link — top-up — and Go the console plus the plan", () => {
    // Same component, different content. Zen's single action IS the console on
    // the update row (labelled 充值, which is what a pay-as-you-go user wants
    // from it), so repeating it below would be two links to one page.
    const zen = UsagePanel(panelProps({ isZen: true, usage: usage() }));
    expect(findAll(zen, "a").map((a) => a.props.href)).toEqual([CONSOLE_URL]);
    expect(collectText(zen)).toContain("t:usageTopUp");
    expect(byClass(zen, "dsh-oc-usage-console")).toHaveLength(1);

    const go = UsagePanel(panelProps({ usage: usage() }));
    expect(findAll(go, "a").map((a) => a.props.href)).toEqual([
      GO_PLAN_URL,
      CONSOLE_URL,
    ]);
    expect(collectText(go)).toContain("t:usageConsole");
    expect(collectText(go)).toContain("t:usageUpgradePlan");
  });

  it("styles the window bars with host tokens", () => {
    // The bar fell back to nothing for one round (the rule was deleted with the
    // cards it used to live beside), so pin both the rule and its palette.
    const track = /\.dsh-oc-usage-bar \{[^}]*\}/.exec(STYLES)?.[0];
    expect(track).toContain("--dsw-alias-border-l4");
    const fill = /\.dsh-oc-usage-bar-fill \{[^}]*\}/.exec(STYLES)?.[0];
    expect(fill).toContain("transition:");
  });

  it("renders through the host's MenuSurface rather than hand-rolling the material", () => {
    // **The panel supplies geometry; the host supplies the material.**
    //
    // This module used to declare `background: var(--dsw-menu-surface-fill)` and
    // `backdrop-filter` on the panel div itself. That is a different pattern
    // from the host's, which is why the popover went see-through:
    //
    //   .surface    { isolation: isolate }          <- contains the negative index
    //   .material   { position:absolute; inset:0; z-index:-1;
    //                 background: var(--dsw-menu-surface-fill); ... }
    //   + a `.backing` div PORTALED into document.body, which is what Chromium
    //     has to blur on macOS.
    //
    // The surface fill is ~58% opaque on purpose, and without that backing the
    // page showed straight through it. So the assertion is that the panel is a
    // MenuSurface, not that some token is mentioned in CSS we wrote.
    const root = UsagePanel(panelProps());
    expect(isElement(root)).toBe(true);
    expect(isElement(root) && root.type).toBe(MenuSurface);
  });

  it("leaves the menu-material attribute to the component that owns it", () => {
    // MenuSurface sets `data-menu-material="translucent"` itself, because the
    // theme reads that attribute to pick the stroke per theme (l4 light,
    // l3 dark). Setting it on a plain div would opt into a rule whose companion
    // material layer we were not rendering.
    const root = UsagePanel(panelProps());
    expect(isElement(root) && root.props["data-menu-material"]).toBeUndefined();
  });

  it("uses the host's PANEL radius and elevation, not a control's", () => {
    // Read from the host, not guessed: --dsw-radius-panel is 28px and is what
    // the harness's own floating panels in this dock use; --dsw-radius-lg is
    // 16px and is a CONTROL radius. --dsw-elevation-prominent is a louder
    // surface than a popover wants; --dsw-elevation-panel is the panel one.
    // Comments are stripped first — a rule that merely names the token is not a
    // rule that sets it.
    const rule = /\.dsh-oc-usage-panel \{[^}]*\}/.exec(
      STYLES.replaceAll(/\/\*[\s\S]*?\*\//g, "")
    )?.[0];
    // The reference is MenuSurface.module.css — THIS panel is menu material
    // (--dsw-menu-surface-fill + --dsw-menu-backdrop-filter), so it takes a
    // popover's radius and a [data-menu-material] popover's stroke.
    expect(rule).toContain("var(--dsw-radius-lg, 16px)");
    expect(rule).not.toContain("--dsw-radius-panel");

    expect(rule).toContain("var(--dsw-elevation-prominent");
    expect(rule).not.toContain("--dsw-elevation-panel");

    // The stroke is not declared at all. The theme picks it PER THEME off
    // data-menu-material: body -> l4 (light), and the dark override -> l3.
    // Declaring a level here would pin one theme and break the other.
    expect(rule).not.toContain("elevation-stroke-color");
  });

  it("draws NO window rows when Go's quota could not be read", () => {
    // The screenshot this pins: three confident "0%" rows all counting down from
    // "<1m". Those figures were never measured — the Host fills them to satisfy
    // the shape when /usage refuses, and 0% plus a reset time of "now" is what
    // a type floor looks like once it is rendered. The live API returns real
    // figures for the same key moments later.
    const unreadable = UsagePanel(
      panelProps({
        usage: { ...usage(), quotaUnavailable: true, zenOverflow: true },
      })
    );
    expect(byClass(unreadable, "dsh-oc-usage-breakdown")).toHaveLength(0);
    // The overflow inference is honest — it came from the 403 — so it stays.

    // A normal reading still draws all three, even with overflow configured
    // (that is the common case: a Zen key exists AND Go quota is readable).
    expect(
      byClass(
        UsagePanel(panelProps({ usage: usage() })),
        "dsh-oc-usage-breakdown"
      )
    ).toHaveLength(1);
  });

  it("puts the refresh control AFTER the timestamp it refreshes", () => {
    // Leading with the icon read as a lone button with a caption beside it, and
    // the 20px hit box plus a 5px gap left a hole where the sentence should be.
    // A value followed by the thing that refreshes it reads like any "as of"
    // field — and the 20px target stays, because the gap was not its padding.
    const cell = UsagePanel(panelProps({ updatedAt: 1_700_000_000_000 }));
    const order = classOrder(cell).filter(
      (name) =>
        name === "dsh-oc-usage-updated" || name === "dsh-oc-usage-refresh"
    );
    expect(order).toEqual(["dsh-oc-usage-updated", "dsh-oc-usage-refresh"]);

    // The target keeps its 20px box; only the gap tightened.
    const rule = /\.dsh-oc-usage-refresh \{[^}]*\}/.exec(STYLES)?.[0];
    expect(rule).toContain("width: 20px");
    expect(rule).toContain("padding: 0");
    const cellRule = /\.dsh-oc-usage-updated \{[^}]*\}/.exec(STYLES)?.[0];
    expect(cellRule).toContain("gap: 1px");
  });

  it("leaves the footer empty until the first read, then wires retry", () => {
    // No loading text: a cell that fills in and then empties makes the row jump
    // on every mount, which reads as a glitch rather than as progress.
    expect(
      collectText(UsagePanel(panelProps({ updatedAt: null })))
    ).not.toContain("usageLoading");

    const retry = vi.fn<() => void>();
    const ready = UsagePanel(panelProps({ retry }));
    // The footer renders "last updated <time>" as one string.
    expect(
      collectText(ready).some((text) => text.startsWith("t:usageLastUpdated"))
    ).toBe(true);
    const [retryButton] = byClass(ready, "dsh-oc-usage-refresh");
    assert.ok(retryButton, "expected a refresh control");
    expect(retryButton.props.disabled).toBe(false);
    (retryButton.props.onClick as () => void)();
    expect(retry).toHaveBeenCalledOnce();

    // The busy state is announced, not drawn: an icon has no text to swap.
    const busy = UsagePanel(panelProps({ refreshing: true }));
    expect(byClass(busy, "dsh-oc-usage-refresh")[0]?.props["aria-label"]).toBe(
      "t:usageRefreshing"
    );
    expect(byClass(busy, "dsh-oc-usage-refresh")[0]?.props.disabled).toBe(true);
  });

  it("styles the failure callout it renders", () => {
    // The class shipped with NO rule at all, so a failure fell back to a bare
    // div: UA margins on its <p>, no error colour, no emphasis on the one
    // message in the panel the user can act on.
    const callout = /\.dsh-oc-usage-warning \{[^}]*\}/.exec(STYLES)?.[0];
    expect(callout).toContain("--dsw-alias-state-error-primary");

    const detail = /\.dsh-oc-usage-warning p \{[^}]*\}/.exec(STYLES)?.[0];
    expect(detail).toContain("margin:");
  });

  it("surfaces a refresh failure, with a fallback message", () => {
    const withMessage = UsagePanel(
      panelProps({ failure: { message: "boom", retainPrevious: false } })
    );
    const [alert] = findAllWhere(
      withMessage,
      (element) => element.props.role === "alert"
    );
    assert.ok(alert, "expected an alert");
    expect(collectText(alert)).toContain("boom");

    const bare = UsagePanel(panelProps({ failure: { retainPrevious: false } }));
    expect(collectText(bare)).toContain("t:usageUnavailable");
  });

  it("marks the panel busy while refreshing", () => {
    const tree = UsagePanel(panelProps({ refreshing: true }));
    expect(byClass(tree, "dsh-oc-usage-panel")[0]?.props["aria-busy"]).toBe(
      true
    );
  });
});
