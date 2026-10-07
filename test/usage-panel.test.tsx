/**
 * The quota meter's presentational components, asserted as element trees.
 *
 * `UsageTrigger` and `UsagePanel` are pure (no hooks), so they are invoked
 * directly and their output walked — the same technique the settings-card
 * tests use. What the meter *does* (polling, hover, retry) lives in
 * `usage-pill.tsx`; these cases pin what it *shows*.
 */

import assert from "node:assert/strict";

import { describe, expect, it, vi } from "vitest";

import type { SessionUsageSnapshot } from "../src/session-cost.ts";
import type { GoUsage } from "../src/usage-contract.ts";
import {
  UsagePanel,
  type UsagePanelProps,
  UsageTrigger,
  type UsageTriggerProps,
} from "../src/usage-panel.tsx";
import {
  GO_CONSOLE_URL,
  GO_LIMITS_DOC_URL,
  GO_PLAN_URL,
  STYLES,
} from "../src/usage-ui.ts";
import {
  childrenOf,
  collectText,
  findAll,
  findAllOf,
  findAllWhere,
  firstOf,
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

const session = (
  overrides: Partial<SessionUsageSnapshot> = {}
): SessionUsageSnapshot => ({
  cacheReadTokens: 0,
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

const triggerProps = (
  overrides: Partial<UsageTriggerProps> = {}
): UsageTriggerProps => ({
  displayPercent: 42,
  isLimited: false,
  isZen: false,
  onClick: () => {},
  open: false,
  ringColor: "var(--ring)",
  showUsagePrice: true,
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
  headline: "42% of Weekly used",
  isLimited: false,
  isZen: false,
  locale: undefined,
  onMouseEnter: () => {},
  onMouseLeave: () => {},
  refreshing: false,
  retry: () => {},
  showUsagePrice: true,
  t,
  updatedAt: 1_700_000_000_000,
  usage: undefined,
  zenCardCredit: "t:zenPaygBadge",
  zenCardDesc: "t:zenOverflowActive",
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

  it("renders the ring for Zen too, with spend as the label", () => {
    const tree = UsageTrigger(
      triggerProps({ isZen: true, usage: usage({ session: session() }) })
    );
    // The ring is the trigger for both providers. Zen used to show a coin emoji
    // here, which rendered as a moon in some font stacks.
    expect(findAll(tree, "svg")).toHaveLength(1);
    expect(collectText(tree)).toContain("$0.42");
    expect(firstOf(tree, "button").props["aria-label"]).toBe(
      "t:zenPaygTitle (t:zenPaygBadge)"
    );
  });

  it("falls back to the Zen title when spend is hidden or absent", () => {
    const withSpend = usage({ session: session() });
    expect(
      collectText(
        UsageTrigger(
          triggerProps({ isZen: true, showUsagePrice: false, usage: withSpend })
        )
      )
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
  it("renders the Go breakdown: three window rows and the links", () => {
    const tree = UsagePanel(panelProps({ usage: usage() }));
    expect(collectText(tree)).toContain("42% of Weekly used");
    expect(collectText(tree)).toContain("Go Plan");

    // Three rows carry the whole breakdown. A progress bar and a QUOTA OVERVIEW
    // strip of three cards used to repeat exactly this data, so both were removed.
    expect(byClass(tree, "dsh-oc-usage-row")).toHaveLength(3);
    expect(byClass(tree, "dsh-oc-usage-bar-fill")).toHaveLength(0);
    expect(byClass(tree, "dsh-oc-usage-card")).toHaveLength(0);
    expect(findAll(tree, "a").map((a) => a.props.href)).toEqual([
      GO_PLAN_URL,
      GO_CONSOLE_URL,
      GO_LIMITS_DOC_URL,
    ]);
  });

  it("spaces the three actions apart and styles them as host links", () => {
    // The row had no stylesheet rule at all, so the anchors fell back to the UA
    // default — purple, solid underline, no gap — and the three labels ran
    // together into one sentence across the panel: "升级套餐控制台与余额额度说明".
    // Both halves regress independently, so pin the wiring and the sheet.
    const tree = UsagePanel(panelProps({ usage: usage() }));
    expect(byClass(tree, "dsh-oc-usage-links")).toHaveLength(1);

    const row = /\.dsh-oc-usage-links \{[^}]*\}/.exec(STYLES)?.[0];
    expect(row).toContain("gap:");

    const anchor = /\.dsh-oc-usage-links a \{[^}]*\}/.exec(STYLES)?.[0];
    // Only `--dsw-*` resolves; an invented token falls back to its own literal
    // colour and the link ignores the theme.
    expect(anchor).toContain("--dsw-alias-link");
    expect(anchor).not.toContain("--color-");
  });

  it("shows session spend only when enabled and present", () => {
    const withSession = usage({ session: session() });
    const shown = UsagePanel(
      panelProps({ showUsagePrice: true, usage: withSession })
    );
    expect(collectText(shown)).toContain("t:sessionSpend");
    expect(collectText(shown)).toContain("$0.42");

    const hidden = UsagePanel(
      panelProps({ showUsagePrice: false, usage: withSession })
    );
    expect(collectText(hidden)).not.toContain("t:sessionSpend");
  });

  it("labels plan-included spend instead of a model rate", () => {
    const included = usage({
      session: session({ includedInPlan: true }),
    });
    expect(collectText(UsagePanel(panelProps({ usage: included })))).toContain(
      "t:includedInPlan"
    );
  });

  it("hides the Go breakdown on a Zen route", () => {
    const tree = UsagePanel(
      panelProps({
        badgeText: "t:zenPaygBadge",
        headline: "t:zenPaygTitle",
        isZen: true,
        usage: usage(),
      })
    );
    expect(byClass(tree, "dsh-oc-usage-bar-track")).toHaveLength(0);
    expect(byClass(tree, "dsh-oc-usage-breakdown")).toHaveLength(0);
    expect(byClass(tree, "dsh-oc-usage-cards")).toHaveLength(0);
    expect(collectText(tree)).toContain("t:zenPaygTitle");
  });

  it("attaches the Zen card for Zen routes and for Go overflow", () => {
    expect(
      byClass(UsagePanel(panelProps({ usage: usage() })), "dsh-oc-zen-card")
    ).toHaveLength(0);
    expect(
      byClass(
        UsagePanel(panelProps({ usage: usage({ zenOverflow: true }) })),
        "dsh-oc-zen-card"
      )
    ).toHaveLength(1);
    expect(
      byClass(UsagePanel(panelProps({ isZen: true })), "dsh-oc-zen-card")
    ).toHaveLength(1);
  });

  it("warns about Zen fallback only when limited without overflow", () => {
    expect(
      byClass(
        UsagePanel(panelProps({ isLimited: true, usage: usage() })),
        "dsh-oc-usage-zen-notice"
      )
    ).toHaveLength(1);
    expect(
      byClass(
        UsagePanel(
          panelProps({ isLimited: true, usage: usage({ zenOverflow: true }) })
        ),
        "dsh-oc-usage-zen-notice"
      )
    ).toHaveLength(0);
  });

  it("switches the footer between loading and last-updated, and wires retry", () => {
    expect(collectText(UsagePanel(panelProps({ updatedAt: null })))).toContain(
      "t:usageLoading"
    );

    const retry = vi.fn<() => void>();
    const ready = UsagePanel(panelProps({ retry }));
    // The footer renders "last updated <time>" as one string.
    expect(
      collectText(ready).some((text) => text.startsWith("t:usageLastUpdated"))
    ).toBe(true);
    const [retryButton] = byClass(ready, "dsh-oc-usage-retry");
    assert.ok(retryButton, "expected a retry control");
    expect(retryButton.props.disabled).toBe(false);
    (retryButton.props.onClick as () => void)();
    expect(retry).toHaveBeenCalledOnce();

    const busy = UsagePanel(panelProps({ refreshing: true }));
    expect(collectText(busy)).toContain("t:usageRefreshing");
    expect(byClass(busy, "dsh-oc-usage-retry")[0]?.props.disabled).toBe(true);
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
