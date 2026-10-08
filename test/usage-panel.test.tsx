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
import { CONSOLE_URL, GO_PLAN_URL, STYLES } from "../src/usage-ui.ts";
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
  title: "t:goPlanTitle",
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
    // Plan first: it lives in the Go layer, above the shared footer that
    // carries the console.
    expect(findAll(tree, "a").map((a) => a.props.href)).toEqual([
      GO_PLAN_URL,
      CONSOLE_URL,
    ]);
    const order = classOrder(tree);
    expect(order.indexOf("dsh-oc-usage-links")).toBeGreaterThan(
      order.indexOf("dsh-oc-usage-breakdown")
    );
    expect(order.indexOf("dsh-oc-usage-links")).toBeLessThan(
      order.indexOf("dsh-oc-usage-footer")
    );
    expect(byClass(tree, "dsh-oc-usage-console")[0]?.props.href).toBe(
      CONSOLE_URL
    );
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
    expect(byClass(zen, "dsh-oc-usage-links")).toHaveLength(0);

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

  it("paints the panel with the host's TRANSLUCENT menu material", () => {
    // The panel was solid white while every other popover in the composer was
    // translucent — the one surface in the dock that did not look like part of
    // the harness. Both tokens in the old chain were REAL and correctly named;
    // what made it white was their product: --dsw-specific-menu is #f8f9faf0
    // (94% opaque) and --dsw-alias-bg-layer-2 resolves to #fff. So this pins the
    // surface fill, not merely "some --dsw token is mentioned" — a chain of
    // individually valid names is exactly how it went wrong.
    // Comments are stripped first: they explain the old tokens by name, and a
    // rule that merely TALKS about a value is not a rule that sets it.
    const panel = /\.dsh-oc-usage-panel \{[^}]*\}/
      .exec(STYLES)?.[0]
      ?.replaceAll(/\/\*[\s\S]*?\*\//g, "");
    expect(panel).toContain("var(--dsw-menu-surface-fill");
    expect(panel).toContain("var(--dsw-menu-backdrop-filter");
    // Neither of the opaque layers, nor a bare `Canvas` fill behind them.
    expect(panel).not.toContain("--dsw-specific-menu");
    expect(panel).not.toContain("--dsw-alias-bg-layer-2");
    expect(panel).not.toMatch(/background-color:\s*Canvas/);
    // The host scopes this stroke to its menu material; we are the material.
    expect(panel).toContain(
      "--dsw-elevation-stroke-color: var(--dsw-alias-border-l3)"
    );
  });

  it("gives a rejected credential its own heading, not the refresh one", () => {
    // "Refresh failed" and "this key is not accepted" are different facts, and
    // only the second one tells the user what to do about it.
    const auth = UsagePanel(
      panelProps({
        usage: usage(),
        failure: { reason: "auth", message: "rejected", retainPrevious: false },
      })
    );
    expect(collectText(auth)).toContain("t:usageAuthRejected");
    expect(collectText(auth)).not.toContain("t:usageRefreshFailed");

    const outage = UsagePanel(
      panelProps({
        usage: usage(),
        failure: { message: "boom", retainPrevious: false },
      })
    );
    expect(collectText(outage)).toContain("t:usageRefreshFailed");
  });

  it("spaces the actions apart and styles them as host links", () => {
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

  it("names the model even when it costs nothing, and says free once", () => {
    // The free case used to render a bare sentence with no model in it, so the
    // one row whose value is always $0.00 was also the only row that could not
    // say what you are paying for. It now has the SAME shape as a paid one:
    // which model, then what it costs.
    const free = usage({
      session: session({
        activeModel: "muse-spark-1.3-contributor-free",
        freeModel: true,
      }),
    });
    const line = collectText(UsagePanel(panelProps({ usage: free }))).join("");
    expect(line).toContain("muse-spark-1.3-contributor-free");
    expect(line).toContain("t:freeModel");

    // A paid model still reads model · rate.
    const paid = usage({
      session: session({ activeRateFormatted: "$0.3 / $1.2 per 1M" }),
    });
    expect(
      collectText(UsagePanel(panelProps({ usage: paid }))).join("")
    ).toContain("$0.3 / $1.2 per 1M");
  });

  it("prefers the catalog's display name over the raw model id", () => {
    // A turn records the id, because that is what the gateway speaks; the name
    // is what the catalog calls it. Showing the id in a meter's own row reads
    // like a debug value.
    const named = usage({
      session: session({
        activeModel: "muse-spark-1.3-contributor-free",
        activeModelName: "Muse Spark 1.3 Free",
        freeModel: true,
      }),
    });
    const line = collectText(UsagePanel(panelProps({ usage: named }))).join("");
    expect(line).toContain("Muse Spark 1.3 Free");
    expect(line).not.toContain("muse-spark-1.3-contributor-free");
  });

  it("hides the Go breakdown on a Zen route", () => {
    const tree = UsagePanel(
      panelProps({
        badgeText: "t:zenPaygBadge",
        title: "t:zenPaygTitle",
        isZen: true,
        usage: usage(),
      })
    );
    expect(byClass(tree, "dsh-oc-usage-bar-track")).toHaveLength(0);
    expect(byClass(tree, "dsh-oc-usage-breakdown")).toHaveLength(0);
    expect(byClass(tree, "dsh-oc-usage-cards")).toHaveLength(0);
    expect(collectText(tree)).toContain("t:zenPaygTitle");
  });

  it("attaches the Zen card to Go overflow only, never to a Zen route", () => {
    // The card answers "where does an over-limit Go request get billed?". On a
    // Zen route you are already paying per token, and OpenCode has no balance
    // endpoint at all — so there the row could only restate the badge.
    expect(
      byClass(UsagePanel(panelProps({ usage: usage() })), "dsh-oc-usage-detail")
    ).toHaveLength(0);
    expect(
      byClass(
        UsagePanel(panelProps({ usage: usage({ zenOverflow: true }) })),
        "dsh-oc-usage-detail"
      )
    ).toHaveLength(1);
    expect(
      byClass(
        UsagePanel(
          panelProps({ isZen: true, usage: usage({ zenOverflow: true }) })
        ),
        "dsh-oc-usage-detail"
      )
    ).toHaveLength(0);
  });

  it("says the billing model once: the badge carries it", () => {
    // `Pay-as-you-go` used to appear three times on a Zen panel — badge,
    // subtitle, and the balance row's own value — with a per-token explanation
    // under the header AND under that row. The badge is where the Go panel puts
    // its billing model too, so one line is enough.
    const tree = UsagePanel(
      panelProps({
        badgeText: "t:zenPaygBadge",
        title: "t:zenPaygTitle",
        isZen: true,
        usage: usage(),
      })
    );
    expect(collectText(tree)).toContain("t:zenPaygBadge");
    expect(collectText(tree)).not.toContain("t:zenCredit");
  });

  it("renders the limited label through the sheet, not an inline style", () => {
    // The subrow used to carry its colour in an ad-hoc `style` prop — the only
    // one surviving in the panel — so a second limited-state tone could only
    // duplicate it or diverge from it.
    const limited = usage({
      rolling: {
        percent: 100,
        resetsAt: "2026-11-01T00:00:00Z",
        status: "rate-limited",
      },
    });
    expect(
      byClass(
        UsagePanel(panelProps({ usage: limited })),
        "dsh-oc-usage-limited"
      )
    ).toHaveLength(1);
  });

  it("states the active model's monthly allowance, for both tiers", () => {
    // The percentage needs a denominator. It is stated as a TOTAL — never as a
    // remainder: `/usage` takes no model parameter, so its percentages are the
    // account's and the product of the two would be a number with no referent.
    const go = UsagePanel(
      panelProps({
        usage: usage({
          allowance: { go: 60, goPlus: 120, model: "mimo-v2.6-flash" },
        }),
      })
    );
    const text = collectText(go);
    expect(text).toContain("t:monthlyAllowance");
    expect(text).toContain("mimo-v2.6-flash");
    // The label and both tiers are separate nodes, so they are asserted apart.
    expect(text).toContain("t:goTier");
    expect(text).toContain("t:goPlusTier");
    expect(text).toContain("$60");
    expect(text).toContain("$120");

    // The row is a PLAN fact, so it renders inside the Go layer — after the
    // windows it explains and before the plan link, not below the session rows.
    const order = classOrder(go);
    expect(order.indexOf("dsh-oc-usage-detail")).toBeGreaterThan(
      order.indexOf("dsh-oc-usage-breakdown")
    );
    expect(order.indexOf("dsh-oc-usage-detail")).toBeLessThan(
      order.indexOf("dsh-oc-usage-links")
    );

    // No allowance, no row — and never on a Zen route, where the Go plan is not
    // what the user is on.
    expect(
      byClass(UsagePanel(panelProps({ usage: usage() })), "dsh-oc-usage-detail")
    ).toHaveLength(0);
    expect(
      byClass(
        UsagePanel(
          panelProps({
            isZen: true,
            usage: usage({
              allowance: { go: 60, goPlus: 120, model: "mimo-v2.6-flash" },
            }),
          })
        ),
        "dsh-oc-usage-detail"
      )
    ).toHaveLength(0);
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
