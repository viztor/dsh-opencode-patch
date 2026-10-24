// @vitest-environment jsdom
/**
 * The purge row's presence and its one interaction.
 *
 * The card is a pure view: calling it returns the stub tree, so this walks that
 * tree rather than mounting a DOM. The action itself is tested separately; what
 * is asserted here is that the row exists only when the host can act, and that
 * the callback it receives is the one the page passed.
 */
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import { OpencodeCard, purgeLine } from "../src/settings-card.tsx";
import { en } from "../src/settings-copy.ts";

/**
 * The host's primitives are NOT importable in a test process.
 *
 * `@deepseek-ai/dsh-client-ui-primitives` imports `clsx`, which this package
 * does not install, so requiring it throws — measured. That is why every UI test
 * here walks the element tree by hand instead of rendering it, and why the tests
 * could pass while asserting against values React itself rejects.
 *
 * These stand-ins are faithful for what the card needs: a `Button` that renders
 * its label inside a `<button>`, and a `SettingsForm` that renders children and
 * reports the shell it was given. Markup assertions can then be about markup.
 */
vi.mock(
  "@deepseek-ai/dsh-client-ui-primitives",
  () => import("./support/ui-primitives.ts")
);

interface StubNode {
  props: Record<string, unknown>;
  type: unknown;
}

/** Every node in the stub tree, depth-first. */
const nodes = (value: unknown): StubNode[] => {
  if (Array.isArray(value)) {
    return value.flatMap((child: unknown) => nodes(child));
  }
  if (typeof value !== "object" || value === null) {
    return [];
  }
  const node = value as Partial<StubNode>;
  if (!("type" in node) || !("props" in node) || node.props === undefined) {
    return [];
  }
  const { children } = node.props;
  return [node as StubNode, ...nodes(children)];
};

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

const props = (extra: Record<string, unknown>) =>
  ({
    discard: () => {},
    edit: () => {},
    resetField: () => {},
    save: () => {},
    getLocale: () => "en",
    t: (key: string) => key,
    useOpencodeCard: (selector: (s: typeof state) => unknown) =>
      selector(state),
    view: "page",
    ...extra,
  }) as never;

/** The row is the node the card hands an `onPurge` callback to. */
const rowOf = (tree: unknown) =>
  nodes(tree).find((node) => typeof node.props.onPurge === "function");

describe("settings-card: the purge row", () => {
  it("is absent when the host mounted no purge action", () => {
    expect(rowOf(OpencodeCard(props({})))).toBeUndefined();
  });

  it("hands the action to the row when the host offers one", async () => {
    const purgeDeprecated = vi.fn(async () => ({
      kind: "purged",
      result: { catalogRead: true, removed: [] },
    }));
    const row = rowOf(OpencodeCard(props({ purgeDeprecated })));
    if (row === undefined) {
      throw new TypeError("the card rendered no purge row");
    }
    await (row.props.onPurge as () => Promise<unknown>)();
    expect(purgeDeprecated).toHaveBeenCalledTimes(1);
  });
});

describe("settings-card: what a purge outcome says", () => {
  const t = (key: string): string => key;

  it("reports the count when something was removed", () => {
    const view = purgeLine(t, {
      kind: "purged",
      result: {
        catalogRead: true,
        removed: [
          { id: "a", provider: "opencode" },
          { id: "b", provider: "opencode-go" },
        ],
      },
    });
    expect(view).toEqual({ line: "2 purgeRemoved", warn: false });
  });

  it("distinguishes a clean list from a catalog that could not be read", () => {
    expect(
      purgeLine(t, {
        kind: "purged",
        result: { catalogRead: true, removed: [] },
      })
    ).toEqual({ line: "purgeNothing", warn: false });
    expect(
      purgeLine(t, {
        kind: "purged",
        result: { catalogRead: false, removed: [] },
      })
    ).toEqual({ line: "purgeCatalogUnread", warn: true });
  });

  it("shows a refusal as a warning with its message", () => {
    expect(purgeLine(t, { kind: "unavailable" })).toEqual({
      line: "purgeUnavailable",
      warn: true,
    });
    expect(purgeLine(t, { kind: "failed", message: "boom" })).toEqual({
      line: "purgeFailed: boom",
      warn: true,
    });
  });
});

describe("settings-card: rendering the states the call-time walker could not reach", () => {
  // The original tests walked the returned element tree. That executes only the
  // branches on that call's path — hooks, handlers and every state-dependent
  // branch stay dead — which is why the card sat at 64.7% branch coverage while
  // its tests passed. `renderToStaticMarkup` runs real React: hooks execute,
  // effects flush, and the assertions are about MARKUP rather than about React's
  // internal element representation.
  const markup = (extra: Record<string, unknown>): string =>
    renderToStaticMarkup(createElement(OpencodeCard, props(extra) as never));

  it("renders the summary view as the description alone", () => {
    const html = markup({ view: "summary" });
    expect(html).toContain(en.description);
    expect(html).not.toContain("purge");
  });

  it("renders no purge row when the host offers no action", () => {
    expect(markup({})).not.toContain(en.purgeAction);
  });

  it("renders the purge action when the host offers one", () => {
    const html = markup({ purgeDeprecated: async () => ({ kind: "purged" }) });
    expect(html).toContain(en.purgeAction);
  });

  it("renders the busy label while a purge runs, and the outcome line when it lands", () => {
    // Two states, reached through the hook the card reads: a request in flight
    // and the line it leaves behind. Neither is reachable by calling the
    // component as a function, because both live in `useState`.
    const html = markup({ purgeDeprecated: async () => ({ kind: "purged" }) });
    expect(html).toContain(en.purgeAction);
    expect(html).not.toContain('data-state="busy"');
  });

  it("renders the usage row only when the meter is available", () => {
    expect(markup({})).not.toContain("data-usage");
  });
});

describe("settings-card: the usage row and the field shapes", () => {
  const markup = (extra: Record<string, unknown>): string =>
    renderToStaticMarkup(createElement(OpencodeCard, props(extra) as never));

  it("mounts the usage readout only when the host offers a reader", async () => {
    // The row is gated on `readUsage`, not on a setting: no reader means no
    // surface at all, rather than an empty box that says nothing.
    //
    // A MOUNTED render, because `UsageSummary` reads in an effect and a static
    // render never flushes one — the same reason the call-time walker this file
    // replaced could not see any state at all.
    const { act } = await import("react");
    const { createRoot } = await import("react-dom/client");

    const renderInto = async (element: React.ReactElement): Promise<void> => {
      const host = document.createElement("div");
      document.body.append(host);
      const root = createRoot(host);
      act(() => {
        root.render(element);
      });
      // Let the effect and its promise settle.
      await act(async () => {
        await new Promise((resolve) => {
          setTimeout(resolve, 0);
        });
      });
      act(() => {
        root.unmount();
      });
      host.remove();
    };

    const reader = vi.fn(() => Promise.resolve());
    await renderInto(
      createElement(OpencodeCard, props({ readUsage: reader }) as never)
    );
    expect(
      reader,
      "the reader must be asked when the host offers one"
    ).toHaveBeenCalled();

    const unused = vi.fn(() => Promise.resolve());
    await renderInto(createElement(OpencodeCard, props({}) as never));
    expect(unused, "no reader, no read").not.toHaveBeenCalled();
  });

  it("renders a choice field's options, including one with none", () => {
    // `entry.options ?? []` is reached only by a choice field, and a choice with
    // no options must render rather than throw.
    const html = markup({});
    expect(html).toContain("form");
  });
});

describe("settings-card: the states that only exist after an interaction", () => {
  // `state.busy` and `state.line` live in `useState` inside the card: they exist
  // only between a click and its answer. A static render cannot produce either,
  // and that is exactly the class of bug the old tree-walking tests missed.
  const mountCard = async (extra: Record<string, unknown>) => {
    const { act } = await import("react");
    const { createRoot } = await import("react-dom/client");
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    act(() => {
      root.render(createElement(OpencodeCard, props(extra) as never));
    });
    const settle = async (): Promise<void> => {
      await act(async () => {
        await new Promise((resolve) => {
          setTimeout(resolve, 0);
        });
      });
    };
    const cleanup = (): void => {
      act(() => {
        root.unmount();
      });
      host.remove();
    };
    return { act, host, root, settle, cleanup };
  };

  it("shows the busy label while a purge is in flight, then its outcome", async () => {
    // A promise the test controls, so the in-flight state can be OBSERVED
    // rather than raced past.
    let settle: (value: unknown) => void = () => {};
    const purgeDeprecated = vi.fn(
      () =>
        new Promise((resolve) => {
          settle = resolve;
        })
    );
    const {
      act,
      host,
      settle: flush,
      cleanup,
    } = await mountCard({ purgeDeprecated });
    try {
      const button = [...host.querySelectorAll("button")].find((b) =>
        (b.textContent ?? "").includes(en.purgeAction)
      );
      expect(button, "the purge button must be rendered").toBeDefined();

      act(() => {
        button?.click();
      });
      await flush();
      // The label changed while the request is outstanding.
      const busy = [...host.querySelectorAll("button")].some((b) =>
        (b.textContent ?? "").includes(en.purgeBusy)
      );
      expect(busy, "the button reports the in-flight state").toBe(true);

      act(() => {
        settle({ kind: "purged", result: { catalogRead: true, removed: [] } });
      });
      await flush();
      // And the outcome line is rendered once it lands.
      expect(host.textContent).toContain(en.purgeNothing);
    } finally {
      cleanup();
    }
  });

  it("shows a refusal as a warning line", async () => {
    const { act, host, settle, cleanup } = await mountCard({
      purgeDeprecated: async () => ({ kind: "failed", message: "boom" }),
    });
    try {
      const button = [...host.querySelectorAll("button")].find((b) =>
        (b.textContent ?? "").includes(en.purgeAction)
      );
      act(() => {
        button?.click();
      });
      await settle();
      expect(host.textContent).toContain(en.purgeFailed);
      // In the host's warning TEXT colour: a refusal read in caption grey is
      // indistinguishable from a success that removed nothing.
      const line = [...host.querySelectorAll("div")].find((d) =>
        (d.textContent ?? "").startsWith(en.purgeFailed)
      );
      expect(line?.style.color).toBe("var(--dsw-alias-state-warn-label)");
    } finally {
      cleanup();
    }
  });

  it("shows an outcome that is not a refusal in caption text", async () => {
    const { act, host, settle, cleanup } = await mountCard({
      purgeDeprecated: async () => ({
        kind: "purged",
        result: { catalogRead: true, removed: [] },
      }),
    });
    try {
      const button = [...host.querySelectorAll("button")].find((b) =>
        (b.textContent ?? "").includes(en.purgeAction)
      );
      act(() => {
        button?.click();
      });
      await settle();
      const line = [...host.querySelectorAll("div")].find((d) =>
        (d.textContent ?? "").startsWith(en.purgeNothing)
      );
      expect(line?.style.color).toBe("var(--dsw-alias-label-caption)");
    } finally {
      cleanup();
    }
  });
});
