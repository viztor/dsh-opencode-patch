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
// @vitest-environment jsdom
import {
  readGoUsage,
  UsageSummary,
  UsageSummaryView,
  readUntilAnswered,
} from "../src/settings-usage.tsx";
import type { GoUsage } from "../src/usage-contract.ts";
import { findAll, findAllOf } from "./test-helpers.ts";

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

  it("says refreshing when a refresh is actively running", () => {
    const refreshing = UsageSummaryView({
      locale: "zh",
      refreshing: true,
      t,
      usage: undefined,
    });
    expect(text(refreshing)).toContain(t("usageRefreshing"));
  });

  it("carries the spinner's own keyframes, so it turns without the meter", () => {
    // The meter's stylesheet defines the animation, and that stylesheet is
    // rendered by the METER — so the settings summary's refresh button turned
    // only while the meter happened to be on screen. The summary carries its own
    // declaration, and it is the same animation.
    const refreshing = UsageSummaryView({
      locale: "zh",
      refreshing: true,
      t,
      usage: undefined,
    });
    const styles = findAll(refreshing, "style")
      .map((node) => String(node.props.children))
      .join("\n");
    expect(styles).toContain("@keyframes dsh-oc-spin");
    expect(styles).toContain("rotate(360deg)");
  });

  it("states the monthly allowance as a total, for both tiers", () => {
    const view = UsageSummaryView({
      locale: "zh",
      t,
      usage: usage({
        allowance: { go: 60, goPlus: 120, model: "mimo-v2.6-pro" },
      }),
    });
    const body = text(view);
    expect(body).toContain("mimo-v2.6-pro");
    expect(body).toContain("$60");
    expect(body).toContain("$120");
    // And the honest note travels with it — as a TOOLTIP label, not as a
    // paragraph: an explanation hides behind a hover, an instruction does not.
    expect(body).not.toContain(t("usageSummaryNote"));
    const labels = findAllOf(view, new Set(["Tooltip"])).map(
      (node) => node.props.label
    );
    expect(labels).toContain(t("usageSummaryNote"));
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

  it("propagates an error from an unfulfilled result envelope", async () => {
    const error = new Error("quota service unavailable");
    await expect(
      readGoUsage(scopeWith(async () => ({ ok: false, error })))
    ).rejects.toBe(error);
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

  it("survives a remote whose guarded access THROWS", async () => {
    // The regression this pins: `scope.remote.opencodeGoUsage` is not an
    // optional chain, it is a cordis GUARDED PROPERTY. For a namespace this
    // bundle never declared in `inject` it throws
    // `cannot get property "remote.opencodeGoUsage" without inject`, and a
    // throw out of a render takes the whole settings card — which is what "the
    // usage meter is not shown properly" was.
    //
    // The meter's own injector was fixed for this once already. This call site
    // was missed, so the card still died. Both now read through the one guard
    // in `settings-remote.ts`, and this is the test that says so.
    const throwingRemote = new Proxy(
      {},
      {
        get: (_target, prop) => {
          if (prop === "opencodeGoUsage") {
            throw new TypeError(
              'cannot get property "remote.opencodeGoUsage" without inject'
            );
          }
          // Every other namespace is simply absent, as on a host that mounts
          // nothing — the throw is the whole point of the fixture.
        },
      }
    );

    await expect(
      readGoUsage({ remote: throwingRemote })
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
        attempts={1}
        getLocale={() => "zh"}
        readUsage={() => Promise.reject(new Error("no key"))}
        sleep={() => Promise.resolve()}
        t={t}
      />
    );
    await waitFor(() => {
      expect(view.container.textContent).toContain(
        t("usageSummaryUnavailable")
      );
    });
  });

  it("renders a refresh button that can be clicked to refresh usage", async () => {
    let calls = 0;
    const read = () => {
      calls += 1;
      return Promise.resolve(usage());
    };
    const view = render(
      <UsageSummary getLocale={() => "zh"} readUsage={read} t={t} />
    );
    await waitFor(() => {
      expect(view.container.textContent).toContain("72%");
    });
    expect(calls).toBe(1);

    const button = view.container.querySelector("button");
    expect(button).not.toBeNull();
    button?.click();
    await waitFor(() => {
      expect(calls).toBeGreaterThanOrEqual(2);
    });
  });
});

describe("settings-usage: reading until the remote answers", () => {
  const answered = { go: { limit: 60, percent: 10 }, model: "m" } as never;
  const noSleep = () => Promise.resolve();

  it("returns the first answer without retrying", async () => {
    let calls = 0;
    const read = () => {
      calls += 1;
      return Promise.resolve(answered);
    };
    expect(await readUntilAnswered(read, 5, noSleep)).toBe(answered);
    expect(calls).toBe(1);
  });

  it("retries when read throws an error on early attempts and returns answer", async () => {
    let calls = 0;
    const read = () => {
      calls += 1;
      if (calls < 3) {
        return Promise.reject(
          new Error("transient network or cold-start error")
        );
      }
      return Promise.resolve(answered);
    };
    expect(await readUntilAnswered(read, 5, noSleep)).toBe(answered);
    expect(calls).toBe(3);
  });

  it("returns undefined after all attempts throw errors rather than unhandled rejection", async () => {
    let calls = 0;
    const read = () => {
      calls += 1;
      return Promise.reject(new Error("repeated outage"));
    };
    expect(await readUntilAnswered(read, 3, noSleep)).toBeUndefined();
    expect(calls).toBe(3);
  });

  it("keeps asking while the answer is undefined", async () => {
    // The remote is mounted asynchronously, so the first reads answer nothing.
    // Reading once leaves the card empty until a reload - which is the bug this
    // exists for, and the reason the composer meter is never empty.
    let calls = 0;
    const read = () => {
      calls += 1;
      return Promise.resolve(calls < 3 ? undefined : answered);
    };
    expect(await readUntilAnswered(read, 5, noSleep)).toBe(answered);
    expect(calls).toBe(3);
  });

  it("gives up after the attempts rather than asking forever", async () => {
    let calls = 0;
    const read = async (): Promise<GoUsage | undefined> => {
      calls += 1;
      return undefined;
    };
    expect(await readUntilAnswered(read, 3, noSleep)).toBeUndefined();
    expect(calls).toBe(3);
  });

  it("abandons the loop when the surface is gone", async () => {
    // Unmounting must stop the retries, or a closed card keeps reading.
    let calls = 0;
    let alive = true;
    const read = async (): Promise<GoUsage | undefined> => {
      calls += 1;
      alive = false;
      return undefined;
    };
    expect(
      await readUntilAnswered(read, 5, noSleep, () => alive)
    ).toBeUndefined();
    expect(calls).toBe(1);
  });
});
