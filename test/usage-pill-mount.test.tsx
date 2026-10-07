// @vitest-environment jsdom
/**
 * `usage-pill.tsx` — the meter's STATE, mounted for real.
 *
 * The rest of the client is tested by invoking components as plain functions and
 * walking the returned element tree, which works because they are pure and hold
 * no hooks. This one does not: it owns the poll loop, the hover timers, the
 * retry and the dismissal. Calling `UsagePill(props)` returned the element and
 * ran none of that, so every line of the state machine was uncovered — which is
 * why a file with nineteen passing cases sat at 9% of statements. The lines that
 * break in production are exactly the ones a real mount exercises.
 *
 * Hence a DOM. It is scoped to this file by the pragma above, so the rest of the
 * suite stays in the fast node environment and keeps its zero-dependency
 * element-tree style.
 *
 * Timers are faked rather than awaited: the poll interval is 60s and the hover
 * delay 120ms, so a real-time test would either take a minute or assert nothing.
 */

import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { GoUsage } from "../src/usage-contract.ts";
import {
  UsagePill,
  type ModelDirectoryState,
  type SnapshotStore,
} from "../src/usage-pill.tsx";

/** A quota reading with one window in each of the states the panel distinguishes. */
const USAGE: GoUsage = {
  monthly: { status: "ok", percent: 40, resetsAt: "2026-11-01T00:00:00Z" },
  rolling: {
    status: "rate-limited",
    percent: 90,
    resetsAt: "2026-10-07T00:00:00Z",
  },
  source: "opencode-go",
  weekly: { status: "ok", percent: 55, resetsAt: "2026-10-20T00:00:00Z" },
  zenOverflow: false,
};

/**
 * The rejection `parseFailure` recognises.
 *
 * An `Error` carrying the vendor's code, because the parser keys on
 * `"code" in error` — a bare object would satisfy it, and a rejection reason
 * should still be an Error.
 */
const usageUnavailable = (details: Record<string, unknown>): Error =>
  Object.assign(new Error("usage unavailable"), {
    code: "opencode-go/usage-unavailable",
    details,
  });

/** A store that never changes, which is the steady state the gate reads. */
const storeFor = (
  state: ModelDirectoryState
): SnapshotStore<ModelDirectoryState> => ({
  getSnapshot: () => state,
  subscribe: () => () => {
    /* nothing ever changes it */
  },
});

/** `t` echoes the key so a test can assert which string reached the DOM. */
const t = (key: string): string => key;

/**
 * One element, or a failure that names the selector.
 *
 * `querySelector` answers `Element | null` and every assertion below cares that
 * the thing it is about was actually rendered; `!` or `as Element` would turn a
 * missing element into a confusing `null is not an object` further down.
 */
const element = (selector: string): Element => {
  const found = document.querySelector(selector);
  if (found === null) {
    throw new Error(`expected ${selector} to be rendered`);
  }
  return found;
};

/** Whether the panel is open, without asserting on anything inside it. */
const panelOpen = (): boolean =>
  document.querySelector(".dsh-oc-usage-panel") !== null;

const renderPill = async (
  readUsage: (provider?: string) => Promise<GoUsage>,
  provider = "opencode-go"
) => {
  const view = render(
    <UsagePill
      directory={storeFor({ current: { provider } })}
      readUsage={readUsage}
      t={t}
    />
  );
  // The first read is fired from an effect, so let it settle before asserting.
  await waitFor(() => {
    expect(readUsage).toHaveBeenCalled();
  });
  return view;
};

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("usage-pill: the poll loop", () => {
  it("reads once on mount and shows the quota it got back", async () => {
    const readUsage = vi.fn().mockResolvedValue(USAGE);
    await renderPill(readUsage);

    expect(readUsage).toHaveBeenCalledTimes(1);
    // The trigger renders the AFFECTING window's percentage, not an average —
    // `rolling` is rate-limited at 90, so 90 is what the ring must show.
    await waitFor(() => {
      expect(element(".dsh-oc-usage-trigger").textContent).toContain("90%");
    });
  });

  it("re-polls on the 60s interval", async () => {
    const readUsage = vi.fn().mockResolvedValue(USAGE);
    await renderPill(readUsage);
    expect(readUsage).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(readUsage).toHaveBeenCalledTimes(2);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(readUsage).toHaveBeenCalledTimes(3);
  });

  it("re-reads the moment the picker switches models, not on the next tick", async () => {
    // The rate and the monthly allowance are priced for the model the query
    // names. Without this, a switch left the panel describing the PREVIOUS
    // model for up to a minute — the meter looked live and was not.
    const readUsage = vi.fn().mockResolvedValue(USAGE);
    const view = await renderPill(readUsage);
    expect(readUsage).toHaveBeenCalledTimes(1);

    const rerender = (model: string): void => {
      view.rerender(
        <UsagePill
          directory={storeFor({ current: { provider: "opencode-go", model } })}
          readUsage={readUsage}
          t={t}
        />
      );
    };

    await act(async () => {
      rerender("kimi-k3");
    });
    await waitFor(() => {
      expect(readUsage).toHaveBeenCalledTimes(2);
    });
    // The new selection is what the Host was asked to price.
    expect(readUsage).toHaveBeenLastCalledWith("opencode-go", "kimi-k3");

    // Switching BACK does not assume anything: the same read fires again,
    // because the snapshot for the first model is stale the moment the picker
    // left it.
    await act(async () => {
      rerender("grok-4.7");
    });
    await waitFor(() => {
      expect(readUsage).toHaveBeenCalledTimes(3);
    });
    expect(readUsage).toHaveBeenLastCalledWith("opencode-go", "grok-4.7");
  });

  it("re-reads when the provider route changes, as when Go hands off to Zen", async () => {
    // A provider switch is an account switch: the /usage endpoint rejects the
    // other plane's key outright, so carrying the old reading over would show
    // one account's quota beside the other account's model.
    const readUsage = vi.fn().mockResolvedValue(USAGE);
    const view = await renderPill(readUsage, "opencode-go");
    expect(readUsage).toHaveBeenCalledTimes(1);

    await act(async () => {
      view.rerender(
        <UsagePill
          directory={storeFor({ current: { provider: "opencode" } })}
          readUsage={readUsage}
          t={t}
        />
      );
    });
    await waitFor(() => {
      expect(readUsage).toHaveBeenCalledTimes(2);
    });
    // A bare provider switch sends no model — the arg is present but empty,
    // which the Host's `parseUsageQuery` already folds away.
    const [route, model] = readUsage.mock.lastCall as [
      string,
      string | undefined,
    ];
    expect(route).toBe("opencode");
    expect(model ?? "none").toBe("none");
  });

  it("does not poll while the document is hidden, and catches up when it returns", async () => {
    const readUsage = vi.fn().mockResolvedValue(USAGE);
    await renderPill(readUsage);
    expect(readUsage).toHaveBeenCalledTimes(1);

    // A backgrounded tab should not spend the user's quota on reads nobody sees.
    const visibility = vi
      .spyOn(document, "visibilityState", "get")
      .mockReturnValue("hidden");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(readUsage).toHaveBeenCalledTimes(1);

    // Becoming visible is the signal to catch up — an interval that fired while
    // hidden is not replayed, so without this the meter would sit stale.
    visibility.mockReturnValue("visible");
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await waitFor(() => {
      expect(readUsage).toHaveBeenCalledTimes(2);
    });
  });

  it("stops polling once unmounted, so a torn-down meter cannot read", async () => {
    const readUsage = vi.fn().mockResolvedValue(USAGE);
    const view = await renderPill(readUsage);
    expect(readUsage).toHaveBeenCalledTimes(1);

    view.unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(180_000);
    });
    expect(readUsage).toHaveBeenCalledTimes(1);
  });
});

describe("usage-pill: failure handling", () => {
  it("renders nothing when no Go credential is configured", async () => {
    // The meter exists to report a quota. With no account there is no quota, and
    // a permanent unactionable error chip in the composer would be worse than
    // silence — this is the case where the component returns null AFTER reading.
    //
    // `configured: false` arrives as a REJECTION carrying the vendor's code, not
    // as a reading: `parseFailure` lifts it off `details`, and a resolved value
    // would be taken for a quota and run through `getAffectingWindow`, which is
    // exactly the shape mismatch this asserts against.
    const readUsage = vi
      .fn()
      .mockRejectedValue(usageUnavailable({ configured: false }));
    const view = await renderPill(readUsage);

    // `waitFor`, not a bare assertion. `renderPill` waits only for the read to
    // have been CALLED, so a bare `toBeNull()` here races the rejection: before
    // React processes it the component still renders its trigger, and the test
    // failed roughly one run in six. `waitFor` retries until the callback stops
    // throwing, which is the settled state this actually asserts.
    await waitFor(() => {
      expect(view.container.querySelector(".dsh-oc-usage-root")).toBeNull();
    });
  });

  it("shows a failure trigger when the read fails", async () => {
    const readUsage = vi.fn().mockRejectedValue(new Error("usage unavailable"));
    await renderPill(readUsage);

    await waitFor(() => {
      expect(element(".dsh-oc-usage-trigger").textContent).toContain("!");
    });
  });

  it("keeps the last good reading when a later poll fails the same way", async () => {
    // A transient blip must not blank the composer: the panel says the reading
    // is stale, and the previous number stays where the user can still see it.
    let call = 0;
    const readUsage = vi.fn().mockImplementation(() => {
      call += 1;
      return call === 1
        ? Promise.resolve(USAGE)
        : Promise.reject(
            usageUnavailable({
              configured: true,
              retainPrevious: true,
              retryable: true,
              source: "opencode-go",
            })
          );
    });

    await renderPill(readUsage);
    await waitFor(() => {
      expect(element(".dsh-oc-usage-trigger").textContent).toContain("90%");
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });

    await waitFor(() => {
      expect(element(".dsh-oc-usage-trigger").textContent).toContain("90%");
    });
  });

  it("retries on demand from the panel", async () => {
    const readUsage = vi
      .fn()
      .mockRejectedValueOnce(new Error("usage unavailable"))
      .mockResolvedValue(USAGE);
    await renderPill(readUsage);
    await waitFor(() => {
      expect(element(".dsh-oc-usage-trigger").textContent).toContain("!");
    });

    // Open the panel. A click, not a hover: hovering no longer opens it.
    await act(async () => {
      fireEvent.click(element(".dsh-oc-usage-trigger"));
    });

    await act(async () => {
      fireEvent.click(element(".dsh-oc-usage-refresh"));
    });

    await waitFor(() => {
      expect(readUsage).toHaveBeenCalledTimes(2);
    });
    // The trigger recovers from "!" to the real percentage. Scoped to the
    // trigger, because once the panel is open the same number also appears in a
    // row inside it, and a loose query would match both.
    await waitFor(() => {
      expect(element(".dsh-oc-usage-trigger").textContent).toContain("90%");
    });
  });
});

describe("usage-pill: hover, click and dismissal", () => {
  it("does not open on hover; the click opens it", async () => {
    // Hover is deliberately inert — it explains (the Tooltip), it does not open.
    // The panel opened on hover until the popover was aligned with the host's own
    // language, and a panel that appears under the pointer cannot be read.
    const readUsage = vi.fn().mockResolvedValue(USAGE);
    await renderPill(readUsage);

    await act(async () => {
      fireEvent.mouseEnter(element(".dsh-oc-usage-root"));
      await vi.advanceTimersByTimeAsync(150);
    });
    expect(panelOpen()).toBe(false);

    await act(async () => {
      fireEvent.click(element(".dsh-oc-usage-trigger"));
    });
    expect(panelOpen()).toBe(true);
    // The badge is the host's `Tag`, so the stub must RENDER it — a
    // `{props, type}` object there is "Element type is invalid" at runtime, the
    // same failure the missing `Tooltip` caused. This fixture's rolling window is
    // rate-limited, so the badge carries the limit label.
    expect(element(".dsh-stub-tag").textContent).toBe("usageLimited");
  });

  it("shows the headline as a tooltip when the trigger is hovered", async () => {
    // The affordance hover kept: the trigger is wrapped in the host's `Tooltip`,
    // labelled with the same headline the panel opens under. Without it, hovering
    // would do nothing at all and the ring would need a legend.
    const readUsage = vi.fn().mockResolvedValue(USAGE);
    await renderPill(readUsage);

    await act(async () => {
      fireEvent.mouseEnter(element(".dsh-oc-usage-trigger"));
      await vi.advanceTimersByTimeAsync(10);
    });

    expect(element('[role="tooltip"]').textContent).toContain("quota limited");
  });

  it("stays open while the pointer crosses onto the panel, and closes after it leaves", async () => {
    const readUsage = vi.fn().mockResolvedValue(USAGE);
    await renderPill(readUsage);

    await act(async () => {
      fireEvent.click(element(".dsh-oc-usage-trigger"));
    });
    expect(panelOpen()).toBe(true);

    // Leaving the root starts a 200ms grace period so the pointer can cross onto
    // the panel itself; a panel that vanished on the first mouseleave would be
    // unusable.
    await act(async () => {
      fireEvent.mouseLeave(element(".dsh-oc-usage-root"));
    });
    expect(panelOpen()).toBe(true);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    expect(panelOpen()).toBe(false);
  });

  it("closes on Escape", async () => {
    const readUsage = vi.fn().mockResolvedValue(USAGE);
    await renderPill(readUsage);

    await act(async () => {
      fireEvent.click(element(".dsh-oc-usage-trigger"));
    });
    expect(panelOpen()).toBe(true);

    await act(async () => {
      fireEvent.keyDown(document, { key: "Escape" });
    });
    expect(panelOpen()).toBe(false);
  });

  it("closes on a click outside, and stays open for one inside", async () => {
    const readUsage = vi.fn().mockResolvedValue(USAGE);
    await renderPill(readUsage);
    const root = element(".dsh-oc-usage-root");

    await act(async () => {
      fireEvent.click(element(".dsh-oc-usage-trigger"));
    });
    expect(panelOpen()).toBe(true);

    // A press within the pill is the user interacting with it, not a dismissal.
    await act(async () => {
      fireEvent.mouseDown(root);
    });
    expect(panelOpen()).toBe(true);

    await act(async () => {
      fireEvent.mouseDown(document.body);
    });
    expect(panelOpen()).toBe(false);
  });

  it("hands back every document listener it claimed on unmount", async () => {
    const remove = vi.spyOn(document, "removeEventListener");
    const readUsage = vi.fn().mockResolvedValue(USAGE);
    const view = await renderPill(readUsage);

    await act(async () => {
      fireEvent.click(element(".dsh-oc-usage-trigger"));
    });
    view.unmount();

    const events = remove.mock.calls.map((call) => call[0]);
    // Both effects' seams have to be returned, or a leaked `visibilitychange`
    // would keep polling a meter that is already gone.
    expect(events).toContain("visibilitychange");
    expect(events).toContain("mousedown");
    expect(events).toContain("keydown");
  });
});
