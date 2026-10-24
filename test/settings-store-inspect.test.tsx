// @vitest-environment jsdom
/**
 * The "check this machine" row: what it says for each answer, and that the button
 * actually performs the check.
 *
 * The report is a pure function, so every branch is asserted without React; the
 * mounted cases then prove the two states a static render cannot reach (busy and
 * reported), because those live in `useState`.
 *
 * @module dsh-opencode-patch/settings-store-inspect.test
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

// The host's UI kit imports `clsx`, which this package does not install, so
// requiring the real module throws in a test process. The stand-in renders a
// real `<button>`, which is what the click assertions need.
vi.mock(
  "@deepseek-ai/dsh-client-ui-primitives",
  () => import("./support/ui-primitives.ts")
);

import { en } from "../src/settings-copy.ts";
import {
  inspectLine,
  StoreInspectRow,
} from "../src/settings-store-inspect.tsx";
import type { StoreInspectOutcome } from "../src/settings-store.ts";

const t = (key: string): string =>
  (en as unknown as Record<string, string>)[key] ?? key;

describe("settings-store-inspect: the report", () => {
  it("details the account, the org, the kind and the expiry", () => {
    const report = inspectLine(
      t,
      {
        kind: "inspected",
        inspection: {
          account: {
            email: "someone@example.com",
            expired: false,
            expiresAt: "2026-11-20T21:32:12.305Z",
            orgName: "Default",
            type: "oauth",
          },
          found: true,
        },
      },
      "en"
    );
    const labels = report.rows.map((row) => row.label);
    expect(labels).toEqual([
      t("storeInspectAccount"),
      t("storeInspectOrg"),
      t("storeInspectKind"),
      t("storeInspectExpires"),
    ]);
    const values = report.rows.map((row) => row.value).join(" ");
    expect(values).toContain("someone@example.com");
    expect(values).toContain("Default");
    expect(values).toContain(t("storeInspectKindOauth"));
    expect(values).toContain(t("storeInspectValid"));
    expect(report.warn).toBe(false);
    expect(report.note).toBeUndefined();
  });

  it("warns about an expired credential that cannot renew", () => {
    const report = inspectLine(t, {
      kind: "inspected",
      inspection: {
        account: {
          email: "someone@example.com",
          expired: true,
          expiresAt: "2026-01-01T00:00:00.000Z",
          type: "oauth",
        },
        found: true,
      },
    });
    expect(report.warn).toBe(true);
    expect(report.rows.map((row) => row.value).join(" ")).toContain(
      t("storeInspectExpired")
    );
  });

  it("does NOT warn about a lapsed session that renews itself", () => {
    // The ordinary state of a working installation: the access token lapses and
    // the CLI refreshes it on the next use. Reporting that as a failure would
    // teach the reader to ignore the one warning that matters.
    const report = inspectLine(t, {
      kind: "inspected",
      inspection: {
        account: {
          expired: true,
          expiresAt: "2026-01-01T00:00:00.000Z",
          refreshable: true,
          type: "oauth",
        },
        found: true,
      },
    });
    expect(report.warn).toBe(false);
    expect(report.rows.map((row) => row.value).join(" ")).toContain(
      t("storeInspectRefreshable")
    );
  });

  it("names an API key row as an API key", () => {
    const report = inspectLine(t, {
      kind: "inspected",
      inspection: {
        account: { label: "API key", type: "key" },
        found: true,
      },
    });
    const values = report.rows.map((row) => row.value).join(" ");
    expect(values).toContain(t("storeInspectKindKey"));
  });

  it("names a credential whose kind it cannot place as unknown", () => {
    const report = inspectLine(t, {
      kind: "inspected",
      inspection: {
        account: { email: "someone@example.com", type: "unknown" },
        found: true,
      },
    });
    expect(report.rows.map((row) => row.value).join(" ")).toContain(
      t("storeInspectKindUnknown")
    );
  });

  it("falls back to the ISO date when the reader's language is unknown", () => {
    // `locale` is optional on the props, so this branch is the ordinary one for a
    // host that reports no active language — not an edge case.
    const report = inspectLine(t, {
      kind: "inspected",
      inspection: {
        account: {
          expired: false,
          expiresAt: "2026-11-20T21:32:12.305Z",
          type: "oauth",
        },
        found: true,
      },
    });
    expect(report.rows.map((row) => row.value).join(" ")).toContain(
      "2026-11-20T21:32:12.305Z"
    );
  });

  it("omits the expiry row when the host's date cannot be parsed", () => {
    // A row that printed "Invalid Date" would be worse than no row: the reader
    // would think the credential had no expiry rather than that the field was junk.
    const report = inspectLine(t, {
      kind: "inspected",
      inspection: {
        account: {
          email: "someone@example.com",
          expiresAt: "not-a-date",
          type: "oauth",
        },
        found: true,
      },
    });
    expect(report.rows.map((row) => row.label)).not.toContain(
      t("storeInspectExpires")
    );
  });

  it("says the machine has no store, as a problem", () => {
    const report = inspectLine(t, {
      kind: "inspected",
      inspection: { found: false },
    });
    expect(report.rows).toEqual([]);
    expect(report.note).toBe(t("storeInspectMissing"));
    expect(report.warn).toBe(true);
  });

  it("says the store exists but holds no account", () => {
    const report = inspectLine(t, {
      kind: "inspected",
      inspection: { found: true, message: "no_credentials_in_store" },
    });
    expect(report.rows).toEqual([]);
    expect(report.note).toBe(t("storeInspectNoAccount"));
    expect(report.warn).toBe(true);
  });

  it("says the host mounted no inspection service", () => {
    const report = inspectLine(t, { kind: "unavailable" });
    expect(report.note).toBe(t("storeInspectUnavailable"));
    expect(report.warn).toBe(true);
  });

  it("carries the host's message when the check failed", () => {
    const report = inspectLine(t, { kind: "failed", message: "boom" });
    expect(report.note).toBe(`${t("storeInspectFailed")}: boom`);
    expect(report.warn).toBe(true);
  });
});

describe("settings-store-inspect: the row", () => {
  it("renders the heading, the hint and the action", () => {
    const html = renderToStaticMarkup(
      createElement(StoreInspectRow, {
        onInspect: () =>
          Promise.resolve<StoreInspectOutcome>({ kind: "unavailable" }),
        t,
      })
    );
    expect(html).toContain(t("storeInspectTitle"));
    expect(html).toContain(t("storeInspectHint"));
    expect(html).toContain(t("storeInspect"));
  });

  it("performs the check on click and renders what it found", async () => {
    // A MOUNTED render: the busy state and the report both live in `useState`,
    // so a static render can reach neither.
    const { act } = await import("react");
    const { createRoot } = await import("react-dom/client");

    const onInspect = vi.fn(() =>
      Promise.resolve<StoreInspectOutcome>({
        kind: "inspected",
        inspection: {
          account: { email: "someone@example.com", type: "oauth" },
          found: true,
        },
      })
    );

    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    try {
      act(() => {
        root.render(createElement(StoreInspectRow, { onInspect, t }));
      });
      const button = [...host.querySelectorAll("button")].find((b) =>
        (b.textContent ?? "").includes(t("storeInspect"))
      );
      expect(button, "the check button must be rendered").toBeDefined();

      act(() => {
        button?.click();
      });
      await act(async () => {
        await new Promise((resolve) => {
          setTimeout(resolve, 0);
        });
      });

      expect(onInspect).toHaveBeenCalledTimes(1);
      expect(host.textContent).toContain("someone@example.com");
      expect(host.textContent).toContain(t("storeInspectKindOauth"));
    } finally {
      act(() => {
        root.unmount();
      });
      host.remove();
    }
  });

  it("renders a problem note in the host's warning text colour", async () => {
    const { act } = await import("react");
    const { createRoot } = await import("react-dom/client");

    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    try {
      act(() => {
        root.render(
          createElement(StoreInspectRow, {
            onInspect: () =>
              Promise.resolve<StoreInspectOutcome>({ kind: "unavailable" }),
            t,
          })
        );
      });
      const button = [...host.querySelectorAll("button")].find((b) =>
        (b.textContent ?? "").includes(t("storeInspect"))
      );
      act(() => {
        button?.click();
      });
      await act(async () => {
        await new Promise((resolve) => {
          setTimeout(resolve, 0);
        });
      });

      // The innermost div whose whole text is the note: with no rows, the
      // report's wrapper carries the same text.
      const note = [...host.querySelectorAll("div")].find(
        (d) =>
          d.textContent === t("storeInspectUnavailable") &&
          d.querySelector("div") === null
      );
      expect(note, "the note must be rendered").toBeDefined();
      expect(note?.style.color).toBe("var(--dsw-alias-state-warn-label)");
    } finally {
      act(() => {
        root.unmount();
      });
      host.remove();
    }
  });
});
