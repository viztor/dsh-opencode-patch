// @vitest-environment jsdom
import { render, waitFor } from "@testing-library/react";
/**
 * The settings page's Go usage summary.
 *
 * The view is pure, so these cases invoke it and read the tree — the same
 * contract the composer panel keeps, and the reason the summary is split into a
 * view and a container.
 */
import type { ReactNode } from "react";
import React from "react";
import { describe, expect, it } from "vitest";

import { zh } from "../src/settings-copy.ts";
import {
  readGoUsage,
  UsageSummary,
  UsageSummaryView,
} from "../src/settings-usage.tsx";
import type { GoUsage } from "../src/usage-contract.ts";

const t = (key: string): string => zh[key as keyof typeof zh] ?? key;

/** Every string in the tree, joined — the tree is unmounted, so no DOM. */
const text = (node: ReactNode): string => {
  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }
  if (Array.isArray(node)) {
    return node.map((child) => text(child)).join(" ");
  }
  if (React.isValidElement<{ children?: ReactNode }>(node)) {
    return text(node.props.children);
  }
  return "";
};

const usage = (overrides: Partial<GoUsage> = {}): GoUsage => ({
  monthly: { percent: 14, resetsAt: "2026-11-07T00:55:00Z", status: "ok" },
  rolling: { percent: 0, resetsAt: "2026-10-09T06:00:00Z", status: "ok" },
  source: "opencode-go",
  weekly: { percent: 28, resetsAt: "2026-10-12T00:00:00Z", status: "ok" },
  zenOverflow: false,
  ...overrides,
});

describe("settings: Go usage summary", () => {
  it("puts what is LEFT beside each window, as the complement of the same percent", () => {
    // The vendor publishes a percent per window and no balance, so "left" can
    // only be `100 - percent`. Stating it any other way would be a dollar
    // figure we cannot compute: the plan tier is not discoverable.
    const view = UsageSummaryView({ locale: "zh", t, usage: usage() });
    const body = text(view);
    expect(body).toContain("0% 已用");
    expect(body).toContain("100%"); // 0% used -> all of it left
    expect(body).toContain("72%"); // 28% used
    expect(body).toContain("86%"); // 14% used
    expect(body).toContain(t("usageSummaryRemaining"));
  });

  it("says which of the three states the reading is in", () => {
    expect(
      text(UsageSummaryView({ locale: "zh", t, usage: usage() }))
    ).toContain(t("usageSummaryStatusOk"));
    const limited = UsageSummaryView({
      locale: "zh",
      t,
      usage: usage({
        weekly: {
          percent: 100,
          resetsAt: "2026-10-12T00:00:00Z",
          status: "rate-limited",
        },
      }),
    });
    expect(text(limited)).toContain(t("usageSummaryStatusLimited"));
    // 100% used is 0% left, and never a negative.
    expect(text(limited)).toContain("0%");
  });

  it("shows no numbers at all when the quota could not be read", () => {
    // A fabricated 0% is worse than silence: this page has no retry
    // affordance, so a row of zeroes would read as a real reading.
    const body = text(UsageSummaryView({ locale: "zh", t, usage: undefined }));
    expect(body).toContain(t("usageSummaryUnavailable"));
    expect(body).not.toContain("%");
  });

  it("states the monthly allowance as a total, for both tiers", () => {
    const body = text(
      UsageSummaryView({
        locale: "zh",
        t,
        usage: usage({
          allowance: { go: 60, goPlus: 120, model: "mimo-v2.6-pro" },
        }),
      })
    );
    expect(body).toContain("mimo-v2.6-pro");
    expect(body).toContain("$60");
    expect(body).toContain("$120");
    // And the honest note travels with it.
    expect(body).toContain(t("usageSummaryNote"));
  });
});

describe("settings: reading the quota through the Host", () => {
  /** A scope carrying a `read` that answers with whatever the test needs. */
  const scopeWith = (read: unknown): unknown => ({
    remote: { opencodeGoUsage: { read } },
  });

  it("refuses every scope that cannot serve a reading, rather than guessing", async () => {
    // Each of these is a real boot state: no remote at all, a remote without the
    // service, and a service whose `read` is not callable. `undefined` is the
    // only honest answer — this page has no retry affordance.
    // A named `undefined`, because the rule rejects the literal as an argument.
    const nothing: unknown = undefined;
    await expect(readGoUsage(nothing)).resolves.toBeUndefined();
    await expect(readGoUsage({})).resolves.toBeUndefined();
    await expect(readGoUsage({ remote: {} })).resolves.toBeUndefined();
    await expect(
      readGoUsage({ remote: { opencodeGoUsage: {} } })
    ).resolves.toBeUndefined();
    await expect(
      readGoUsage(scopeWith("not a function"))
    ).resolves.toBeUndefined();
  });

  it("unwraps the result envelope, and the bare value", async () => {
    const valid = usage();
    await expect(
      readGoUsage(scopeWith(async () => ({ ok: true, value: valid })))
    ).resolves.toEqual(valid);
    await expect(readGoUsage(scopeWith(async () => valid))).resolves.toEqual(
      valid
    );
  });

  it("rejects a payload that is not a reading", async () => {
    // A half-built row is worse than none: the view renders percentages, and a
    // missing window would print `NaN%`.
    await expect(
      readGoUsage(scopeWith(async () => ({ ok: true, value: { rolling: {} } })))
    ).resolves.toBeUndefined();
    await expect(
      readGoUsage(scopeWith(async () => 42))
    ).resolves.toBeUndefined();
  });
});

describe("settings: the summary container", () => {
  it("reads once and renders what came back", async () => {
    const view = render(
      <UsageSummary
        getLocale={() => "zh"}
        readUsage={() => Promise.resolve(usage())}
        t={t}
      />
    );
    await waitFor(() => {
      expect(view.container.textContent).toContain("72%");
    });
  });

  it("renders nothing at all when there is no service to read", () => {
    const view = render(
      <UsageSummary getLocale={() => "zh"} readUsage={undefined} t={t} />
    );
    expect(view.container.textContent).toBe("");
  });

  it("shows the unavailable state when the read rejects", async () => {
    const view = render(
      <UsageSummary
        getLocale={() => "zh"}
        readUsage={() => Promise.reject(new Error("no key"))}
        t={t}
      />
    );
    await waitFor(() => {
      expect(view.container.textContent).toContain(
        t("usageSummaryUnavailable")
      );
    });
  });
});
