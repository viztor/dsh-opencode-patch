/**
 * `contracts/usage.ts` — the Go usage wire shape and the Typert descriptor.
 *
 * `usage.test.ts` pins the happy path through this module; this file pins what
 * it *rejects* and what it *drops*. That is the half that decides whether a
 * changed vendor payload degrades into an honest error or into a meter drawing
 * confident nonsense, and it is also the boundary every host- and client-side
 * value passes through — so over-acceptance here is silent.
 *
 * @module test/usage-contract.test
 */

import { describe, expect, it } from "vitest";

import {
  type GoUsage,
  parseAccountRef,
  parseGoUsage,
  parseUsageQuery,
  parseUsageReading,
  type SessionUsageSnapshot,
} from "./support/src.ts";

/** One well-formed quota window, with a single field overridden. */
const windowRow = (
  overrides: Record<string, unknown> = {}
): Record<string, unknown> => ({
  percent: 12,
  resetsAt: "2026-10-05T00:00:00.000Z",
  status: "ok",
  ...overrides,
});

/** An unwrapped payload with all three windows, optionally overridden. */
const threeWindows = (
  overrides: Record<string, unknown> = {}
): Record<string, unknown> => ({
  monthly: windowRow(),
  rolling: windowRow(),
  weekly: windowRow(),
  ...overrides,
});

/** A session snapshot the meter can render in full. */
const fullSession = (): Record<string, unknown> => ({
  activeModel: "gpt-5",
  activeRateFormatted: "$2.5 / $15 per 1M",
  cacheReadTokens: 12,
  costFormatted: "$1.25",
  costUsd: 1.25,
  costByPlane: { go: 1.25, zen: 0 },
  freeModel: true,
  inputTokens: 1000,
  modelsUsed: ["gpt-5", "claude-sonnet-4-5"],
  outputTokens: 200,
  totalTokens: 1212,
  turns: 3,
});

describe("parseGoUsage window validation", () => {
  it("rejects a status the meter cannot render and names the window", () => {
    // An unrecognised status would fall through the meter's ring logic as if it
    // were healthy, so the window has to be named in the error to be findable.
    for (const label of ["rolling", "weekly", "monthly"]) {
      expect(() =>
        parseGoUsage(threeWindows({ [label]: windowRow({ status: "ok " }) }))
      ).toThrow(`Invalid OpenCode Go status for ${label}`);
      expect(() =>
        parseGoUsage(
          threeWindows({ [label]: windowRow({ status: undefined }) })
        )
      ).toThrow(`Invalid OpenCode Go status for ${label}`);
    }
  });

  it("rejects a percent that is not a finite non-negative number", () => {
    // The ring geometry multiplies by `percent`, so a string, a NaN or a
    // negative all draw a wrong arc instead of failing.
    for (const label of ["rolling", "weekly", "monthly"]) {
      for (const percent of ["12", Number.NaN, Number.POSITIVE_INFINITY, -1]) {
        expect(() =>
          parseGoUsage(threeWindows({ [label]: windowRow({ percent }) }))
        ).toThrow(`Invalid OpenCode Go percent for ${label}`);
      }
    }
  });

  it("rejects a reset timestamp that is not a parseable string", () => {
    // The countdown does `Date.parse` at render time; a bad value would surface
    // as `Invalid Date` in the panel rather than as a failed read.
    for (const label of ["rolling", "weekly", "monthly"]) {
      for (const resetsAt of [1_700_000_000, "soon", ""]) {
        expect(() =>
          parseGoUsage(threeWindows({ [label]: windowRow({ resetsAt }) }))
        ).toThrow(`Invalid OpenCode Go resetsAt for ${label}`);
      }
    }
  });

  it("refuses a payload that is missing a window entirely", () => {
    // Three windows are the whole contract; a payload carrying two would render
    // a meter with a hole in it.
    expect(() => parseGoUsage({})).toThrow(
      "Invalid OpenCode Go usage response: missing window"
    );
    expect(() =>
      parseGoUsage({ rolling: windowRow(), weekly: windowRow() })
    ).toThrow("missing window");
    expect(() =>
      parseGoUsage({
        monthly: windowRow(),
        rolling: windowRow(),
        weekly: "nope",
      })
    ).toThrow("missing window");
  });
});

describe("parseGoUsage account identity", () => {
  it("carries a host account id through and drops one it cannot trust", () => {
    // The id is the meter's only handle on "still the same account", so an
    // empty or unbounded string must be dropped rather than carried.
    expect(parseGoUsage(threeWindows({ source: "host-1" })).source).toBe(
      "host-1"
    );
    const longest = "s".repeat(128);
    expect(parseGoUsage(threeWindows({ source: longest })).source).toBe(
      longest
    );
    for (const source of ["", "s".repeat(129), 42, null]) {
      const parsed = parseGoUsage(threeWindows({ source }));
      expect(parsed.source).toBeUndefined();
      expect(Object.hasOwn(parsed, "source")).toBe(false);
    }
  });

  it("lets the root overflow flag win over the wrapped one", () => {
    // The Host composes the reading around the vendor payload, so its own flag
    // is at the root and must not be overridden by anything the gateway said.
    const wrapped = threeWindows({ zenOverflow: true });
    expect(
      parseGoUsage({
        ...threeWindows(),
        usage: wrapped,
        zenOverflow: false,
      }).zenOverflow
    ).toBe(false);
    // With no root flag the wrapped one is read instead.
    expect(
      parseGoUsage({ ...threeWindows(), usage: wrapped }).zenOverflow
    ).toBe(true);
    // Neither present: the key is absent, not defaulted to false — the meter
    // distinguishes "no Zen" from "not told".
    const plain = parseGoUsage(threeWindows());
    expect(Object.hasOwn(plain, "zenOverflow")).toBe(false);
  });
});

describe("parseGoUsage session spend", () => {
  it("keeps every field a complete snapshot declares", () => {
    // This is the shape `session-cost.ts` produces; anything dropped here is
    // spend the panel can no longer show.
    const session = fullSession();
    expect(parseGoUsage(threeWindows({ session })).session).toEqual(session);
  });

  it("defaults every optional counter to zero instead of dropping the snapshot", () => {
    // The host attaches spend for sessions whose earliest turns carried no
    // cache reads or cost; a missing counter must read as zero, not as a
    // dropped panel.
    expect(
      parseGoUsage(
        threeWindows({ session: { costFormatted: "$0.50", totalTokens: 40 } })
      ).session
    ).toEqual({
      cacheReadTokens: 0,
      costFormatted: "$0.50",
      costUsd: 0,
      costByPlane: { go: 0, zen: 0 },
      inputTokens: 0,
      modelsUsed: [],
      outputTokens: 0,
      totalTokens: 40,
      turns: 0,
    });
  });

  it("filters the model list and drops fields that say nothing useful", () => {
    // A non-string in `modelsUsed` would render as `undefined` in the panel,
    // and an empty active model / false plan flag are absences, not values.
    expect(
      parseGoUsage(
        threeWindows({
          session: {
            activeModel: "",
            costFormatted: "$1.00",
            freeModel: false,
            modelsUsed: ["gpt-5", 7, null, "claude-sonnet-4-5"],
            totalTokens: 2,
          },
        })
      ).session
    ).toEqual({
      cacheReadTokens: 0,
      costFormatted: "$1.00",
      costUsd: 0,
      costByPlane: { go: 0, zen: 0 },
      inputTokens: 0,
      modelsUsed: ["gpt-5", "claude-sonnet-4-5"],
      outputTokens: 0,
      totalTokens: 2,
      turns: 0,
    });
  });

  it("keeps a rate string even when no model is named beside it", () => {
    // The parser does not re-impose the pairing: `session-cost.ts` always emits
    // a rate with its model, so a lone rate can only come from a hand-built
    // snapshot — and dropping the price while keeping the cost would render a
    // dollar figure nobody can attribute.
    expect(
      parseGoUsage(
        threeWindows({
          session: {
            activeRateFormatted: "$2.5 / $15 per 1M",
            costFormatted: "$1.00",
            totalTokens: 5,
          },
        })
      ).session
    ).toEqual({
      activeRateFormatted: "$2.5 / $15 per 1M",
      cacheReadTokens: 0,
      costFormatted: "$1.00",
      costUsd: 0,
      costByPlane: { go: 0, zen: 0 },
      inputTokens: 0,
      modelsUsed: [],
      outputTokens: 0,
      totalTokens: 5,
      turns: 0,
    });
  });

  it("drops a snapshot that is missing either required field", () => {
    // Spend without a formatted cost or without a token total cannot be
    // rendered, so it is left off rather than half-drawn.
    expect(
      parseGoUsage(threeWindows({ session: { totalTokens: 1 } })).session
    ).toBeUndefined();
    expect(
      parseGoUsage(threeWindows({ session: { costFormatted: "$1" } })).session
    ).toBeUndefined();
    expect(
      parseGoUsage(threeWindows({ session: "nope" })).session
    ).toBeUndefined();
    expect(parseGoUsage(threeWindows()).session).toBeUndefined();
  });

  it("ignores a session hidden inside the usage envelope", () => {
    // Only the root is Host-composed; anything nested under the vendor's own
    // `usage` key is gateway-supplied and must not become a spend figure.
    expect(
      parseGoUsage({
        usage: threeWindows({
          session: { costFormatted: "$9.99", totalTokens: 9_999 },
        }),
      }).session
    ).toBeUndefined();
  });
});

describe("parseGoUsage payload shape", () => {
  it("keeps the vendor envelope authoritative when both shapes are present", () => {
    // A payload carrying the wrapper AND sibling windows is ambiguous; the
    // envelope is the gateway's own, so its windows win.
    const parsed = parseGoUsage({
      ...threeWindows({ rolling: windowRow({ percent: 99 }) }),
      usage: threeWindows(),
    });
    expect(parsed.rolling.percent).toBe(12);
    expect(parsed.weekly.percent).toBe(12);
  });

  it("drops every field the contract does not name", () => {
    // The parsed reading is what crosses to the client, so anything the payload
    // carries beyond the contract — a key, a note, a debug block — must not
    // ride along.
    const parsed = parseGoUsage(
      threeWindows({ apiKey: "sk-should-not-travel", note: "hello" })
    );
    expect(Object.keys(parsed).toSorted()).toEqual([
      "monthly",
      "rolling",
      "weekly",
    ]);
    expect(Object.hasOwn(parsed, "apiKey")).toBe(false);
    expect(Object.hasOwn(parsed, "note")).toBe(false);
  });
});

describe("parseUsageQuery", () => {
  it("refuses anything that is not an object", () => {
    // The value arrives from the wire, so the guard has to reject arrays and
    // primitives too, not just `null`.
    for (const bad of [[], "opencode-go", 42, true]) {
      expect(() => parseUsageQuery(bad)).toThrow(
        "Invalid OpenCode usage query: expected an object"
      );
    }
  });

  it("keeps the two disambiguating fields and drops everything else", () => {
    // `provider` picks the route and `sessionId` scopes the spend; a wire
    // payload carrying more than that must not widen the query.
    expect(
      parseUsageQuery({
        extra: "ignored",
        provider: "opencode-go",
        sessionId: "s-1",
      })
    ).toEqual({ provider: "opencode-go", sessionId: "s-1" });
  });
});

describe("parseAccountRef", () => {
  it("accepts the identifier the sibling account manager names a credential", () => {
    // `dsh-opencode-go` spells a ref as its `apiKeyEnv` name, so this is the
    // shape its account page sends on every read.
    expect(parseAccountRef("DSH_OPENCODE_GO_ACCOUNT_FD96F79E")).toBe(
      "DSH_OPENCODE_GO_ACCOUNT_FD96F79E"
    );
    expect(parseAccountRef("_ref")).toBe("_ref");
  });

  it("refuses anything that is not an identifier", () => {
    // The ref indexes a credential lookup on the caller's side; free text, an
    // empty string and a non-string must not get that far.
    for (const bad of [
      "",
      "has space",
      "0leading",
      "with-dash",
      "a/b",
      42,
      null,
    ]) {
      expect(() => parseAccountRef(bad)).toThrow(
        "Invalid OpenCode Go account reference"
      );
    }
  });
});

describe("parseUsageReading, the client's reading parser", () => {
  it("keeps a well-formed allowance as exactly its three fields", () => {
    const reading = parseUsageReading(
      threeWindows({
        allowance: { extra: "dropped", go: 12, goPlus: 48, model: "Go X" },
      })
    );
    expect(reading.allowance).toEqual({ go: 12, goPlus: 48, model: "Go X" });
    expect(Object.keys(reading.allowance ?? {}).toSorted()).toEqual([
      "go",
      "goPlus",
      "model",
    ]);
  });

  it.each([
    { go: 12, goPlus: 48 },
    { go: 12, model: "Go X" },
    { goPlus: 48, model: "Go X" },
    { go: Number.NaN, goPlus: 48, model: "Go X" },
    { go: 12, goPlus: Number.POSITIVE_INFINITY, model: "Go X" },
    { go: "12", goPlus: 48, model: "Go X" },
    { go: 12, goPlus: 48, model: 7 },
    "Go X",
  ])("drops an allowance that is not one: %j", (allowance) => {
    expect(
      Object.hasOwn(parseUsageReading(threeWindows({ allowance })), "allowance")
    ).toBe(false);
  });

  it("keeps quotaUnavailable only when it is true", () => {
    expect(
      parseUsageReading(threeWindows({ quotaUnavailable: true }))
        .quotaUnavailable
    ).toBe(true);
    for (const quotaUnavailable of [false, "true", 1]) {
      expect(
        Object.hasOwn(
          parseUsageReading(threeWindows({ quotaUnavailable })),
          "quotaUnavailable"
        )
      ).toBe(false);
    }
  });

  it("keeps the session's plane spend, only with a kept session and only in its own type", () => {
    const kept = parseUsageReading(
      threeWindows({
        session: {
          ...fullSession(),
          planeCostFormatted: "$1.25",
          planeSpendUsd: 1.25,
        },
      })
    );
    expect(kept.session?.planeCostFormatted).toBe("$1.25");
    expect(kept.session?.planeSpendUsd).toBe(1.25);

    const mistyped = parseUsageReading(
      threeWindows({
        session: {
          ...fullSession(),
          planeCostFormatted: 1,
          planeSpendUsd: "1",
        },
      })
    );
    expect(Object.hasOwn(mistyped.session ?? {}, "planeCostFormatted")).toBe(
      false
    );
    expect(Object.hasOwn(mistyped.session ?? {}, "planeSpendUsd")).toBe(false);

    // A session the vendor whitelist drops (no `costFormatted`) is not
    // rebuilt from its plane spend alone.
    const dropped = parseUsageReading(
      threeWindows({ session: { planeCostFormatted: "$1", totalTokens: 1 } })
    );
    expect(Object.hasOwn(dropped, "session")).toBe(false);
  });

  it("throws the vendor parser's own TypeError for what is not a reading", () => {
    for (const bad of [
      42,
      undefined,
      threeWindows({ rolling: windowRow({ percent: -1 }) }),
      threeWindows({ weekly: windowRow({ resetsAt: "soon" }) }),
      threeWindows({ monthly: undefined }),
    ]) {
      let expected: unknown;
      try {
        parseGoUsage(bad);
      } catch (error) {
        expected = error;
      }
      expect(expected).toBeInstanceOf(TypeError);
      expect(() => parseUsageReading(bad)).toThrow(
        (expected as TypeError).message
      );
    }
  });

  it("answers every complete reading the Host sends as itself", () => {
    // `Required` so a field added to either type without a reading rule fails
    // to compile here, or reads back different.
    const session: Required<SessionUsageSnapshot> = {
      activeModel: "go-model-x",
      activeModelName: "Go Model X",
      activeRateFormatted: "$1 / $2 per 1M",
      cacheReadTokens: 5,
      costByPlane: { go: 0.25, zen: 0.5 },
      costFormatted: "$0.75",
      costUsd: 0.75,
      freeModel: true,
      inputTokens: 100,
      modelsUsed: ["go-model-x"],
      outputTokens: 200,
      planeCostFormatted: "$0.25",
      planeSpendUsd: 0.25,
      totalTokens: 305,
      turns: 2,
    };
    const full: Required<GoUsage> = {
      allowance: { go: 12, goPlus: 48, model: "Go Model X" },
      monthly: { percent: 14, resetsAt: "2026-11-07T00:55:00Z", status: "ok" },
      quotaUnavailable: true,
      rolling: { percent: 0, resetsAt: "2026-10-09T06:00:00Z", status: "ok" },
      session,
      source: "opencode-go",
      weekly: {
        percent: 100,
        resetsAt: "2026-10-12T00:00:00Z",
        status: "rate-limited",
      },
      zenOverflow: true,
    };
    expect(parseUsageReading(full)).toEqual(full);
    expect(parseUsageReading(parseUsageReading(full))).toEqual(full);
  });
});
