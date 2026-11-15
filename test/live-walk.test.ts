/**
 * The live adapter blocks walk a protocol's candidates rather than dropping
 * the protocol on its first withdrawn model.
 *
 * Offline: the turn is a scripted function, so each verdict path is taken on
 * purpose. The case that matters is the one an earlier revision passed: a
 * protocol whose only candidate is withdrawn must come back UNREACHED by name,
 * never vanish while the others pass.
 *
 * @module test/live-walk.test
 */
import { describe, expect, it } from "vitest";

import {
  candidatesByProtocol,
  type TurnVerdict,
  walkPerProtocol,
} from "./support/live-walk.ts";

/** A turn that answers from a script, and records what it was asked. */
const scripted = (answers: Readonly<Record<string, TurnVerdict>>) => {
  const asked: string[] = [];
  const turn = async (protocol: string, id: string): Promise<TurnVerdict> => {
    asked.push(`${protocol}/${id}`);
    const answer = answers[id];
    if (answer === undefined) {
      throw new Error(`unscripted ${id}`);
    }
    return answer;
  };
  return { asked, turn };
};

describe("walking each protocol's candidates", () => {
  it("moves past a withdrawn or unentitled model to the next candidate", async () => {
    const { asked, turn } = scripted({
      a1: { kind: "gone" },
      a2: { kind: "entitlement" },
      a3: { kind: "ok" },
      a4: { kind: "ok" },
      b1: { kind: "ok" },
    });
    const walk = await walkPerProtocol(
      new Map([
        ["a", ["a1", "a2", "a3", "a4"]],
        ["b", ["b1"]],
      ]),
      turn
    );
    expect([...walk.reached]).toEqual([
      ["a", "a3"],
      ["b", "b1"],
    ]);
    expect(walk.refused).toEqual([]);
    expect(walk.unreached).toEqual([]);
    // It stops at the first turn that reached the wire.
    expect(asked).toEqual(["a/a1", "a/a2", "a/a3", "b/b1"]);
  });

  it("names a protocol whose every candidate is gone, while the others pass", async () => {
    // The case the earlier revision reported green: Go's only Google model
    // withdrawn, the other three protocols completing.
    const { turn } = scripted({
      argon: { kind: "gone" },
      claude: { kind: "ok" },
      gpt: { kind: "ok" },
    });
    const walk = await walkPerProtocol(
      new Map([
        ["anthropic-messages", ["claude"]],
        ["google-generative-ai", ["argon"]],
        ["openai-responses", ["gpt"]],
      ]),
      turn
    );
    expect(walk.unreached).toEqual(["google-generative-ai"]);
    expect(walk.refused).toEqual([]);
    expect(walk.reached.has("google-generative-ai")).toBe(false);
  });

  it("records a refusal and stops walking that protocol", async () => {
    const { asked, turn } = scripted({
      x1: { detail: "400 bad body", kind: "refused" },
      x2: { kind: "ok" },
    });
    const walk = await walkPerProtocol(new Map([["x", ["x1", "x2"]]]), turn);
    expect(walk.refused).toEqual(["x1 (x): 400 bad body"]);
    expect(walk.reached.get("x")).toBe("x1");
    expect(walk.unreached).toEqual([]);
    // A refusal is about the wire: a later candidate does not overrule it.
    expect(asked).toEqual(["x/x1"]);
  });

  it("reports an empty group as unreached", async () => {
    const { asked, turn } = scripted({});
    const walk = await walkPerProtocol(new Map([["y", []]]), turn);
    expect(walk.unreached).toEqual(["y"]);
    expect(asked).toEqual([]);
  });
});

describe("grouping candidates by protocol", () => {
  it("keeps catalog order, first-seen protocol order, and at most `limit` each", () => {
    const rows = [
      { id: "a1", p: "a" },
      { id: "skip", p: undefined },
      { id: "b1", p: "b" },
      { id: "a2", p: "a" },
      { id: "a3", p: "a" },
      { id: "b2", p: "b" },
    ];
    const groups = candidatesByProtocol(rows, (row) => row.p, 2);
    expect(
      [...groups].map(([protocol, list]) => [protocol, list.map((r) => r.id)])
    ).toEqual([
      ["a", ["a1", "a2"]],
      ["b", ["b1", "b2"]],
    ]);
  });
});
