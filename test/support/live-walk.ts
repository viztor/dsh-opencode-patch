/**
 * Walking a protocol's candidates until one reaches the gateway.
 *
 * The live adapter blocks (`test/e2e/protocol-routing.e2e.ts`,
 * `test/e2e/dispatch-levels.e2e.ts`) claim one turn per protocol per plane.
 * The vendor withdraws models and an account may not be entitled to some, so
 * the first model of a protocol is not always one that can answer. Dropping
 * such a protocol and passing on the others reports a protocol as tested when
 * it was not, which is how an earlier revision of both blocks read. So each
 * protocol walks its candidates in catalog order, the way the raw probes'
 * `pickModel` does, and stops at the first turn that says something about the
 * wire; a protocol whose every candidate was refused on entitlement or
 * withdrawn is reported UNREACHED by name, and the case skips with that name
 * rather than passing.
 *
 * Pure: the turn is a parameter, so the walk is unit-tested offline in
 * `test/live-walk.test.ts`.
 *
 * @module test/support/live-walk
 */

/** What one turn said, as the walk reads it. */
export type TurnVerdict =
  /** A completed turn: the protocol is reached and passed. */
  | { readonly kind: "ok" }
  /** An answer about the account (no paid access, no funds, rate limited). */
  | { readonly kind: "entitlement" }
  /** The vendor withdrew the model, CONFIRMED by a raw probe of the same id. */
  | { readonly kind: "gone" }
  /** Anything else: the protocol is reached and failed. */
  | { readonly kind: "refused"; readonly detail: string };

/** The walk's record: every protocol is reached, refused, or named unreached. */
export interface ProtocolWalk {
  /** Each reached protocol and the candidate that reached it. */
  readonly reached: ReadonlyMap<string, string>;
  /** `<id> (<protocol>): <detail>`, one per protocol that failed. */
  readonly refused: readonly string[];
  /** The protocols no candidate reached, in the groups' order. */
  readonly unreached: readonly string[];
}

/**
 * Group rows by protocol, in their own order, keeping at most `limit` each.
 *
 * @param rows - the candidates, in catalog order.
 * @param protocolOf - a row's protocol, or `undefined` to leave it out.
 * @param limit - the most candidates any one protocol keeps.
 * @returns protocol → its first `limit` rows, in first-seen protocol order.
 */
export const candidatesByProtocol = <T>(
  rows: readonly T[],
  protocolOf: (row: T) => string | undefined,
  limit: number
): Map<string, T[]> => {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const protocol = protocolOf(row);
    if (protocol === undefined) {
      continue;
    }
    const group = groups.get(protocol) ?? [];
    if (group.length < limit) {
      group.push(row);
    }
    groups.set(protocol, group);
  }
  return groups;
};

/**
 * Walk each protocol's candidates until one turn says something about the
 * wire.
 *
 * An `entitlement` or a `gone` verdict moves to the next candidate; `ok`
 * reaches the protocol; `refused` reaches it and records the failure. The
 * turns run one at a time: the gateway rate-limits a burst.
 *
 * @param groups - protocol → candidate ids, in the order to try them.
 * @param turn - one turn of `id` on `protocol`.
 * @returns which protocols were reached, refused, or never reached.
 */
export const walkPerProtocol = async (
  groups: ReadonlyMap<string, readonly string[]>,
  turn: (protocol: string, id: string) => Promise<TurnVerdict>
): Promise<ProtocolWalk> => {
  const reached = new Map<string, string>();
  const refused: string[] = [];
  const unreached: string[] = [];
  for (const [protocol, ids] of groups) {
    for (const id of ids) {
      const verdict = await turn(protocol, id);
      if (verdict.kind === "entitlement" || verdict.kind === "gone") {
        continue;
      }
      reached.set(protocol, id);
      if (verdict.kind === "refused") {
        refused.push(`${id} (${protocol}): ${verdict.detail}`);
      }
      break;
    }
    if (!reached.has(protocol)) {
      unreached.push(protocol);
    }
  }
  return { reached, refused, unreached };
};
