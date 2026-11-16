/**
 * The pure half of `verify-session-band.ts`: the vendor's session-id
 * construction, ported, and the four facts the script reports about the
 * low-twelve-bit band `[0xfc0, 0xffe]`, each with the answer it must have.
 *
 * The script printed "CONFIRMED" whatever it measured, so a derivation that
 * left the band would have been confirmed too. The facts are now data, and
 * `bandMismatches` names each one that disagrees with its expectation; the
 * script prints the verdict only when there is none
 * (`test/generators.test.ts`).
 *
 * @module scripts/session-band
 */

/** The direction the vendor mints an id in: sessions are `descending`. */
export type Direction = "ascending" | "descending";

/**
 * A faithful port of upstream `packages/opencode/src/id/id.ts`, both
 * directions, with its per-millisecond counter held in a closure, so each
 * minter starts where the vendor's process does.
 *
 * The bitwise shift/mask and the `BigInt(...)` calls are deliberate: this is a
 * byte-for-byte port of the vendor's arithmetic, and the point of the script is
 * that it reproduces THEIR output rather than a rewritten approximation. The
 * lint rules that object are disabled for exactly this port and this reason.
 *
 * @returns `create(prefix, timestamp, direction)`, which mints one id.
 */
export const upstreamMinter = (): ((
  prefix: string,
  timestamp: number,
  direction: Direction
) => string) => {
  /* oxlint-disable eslint/no-bitwise, unicorn/prefer-bigint-literals -- port of the vendor's arithmetic */
  let lastTimestamp = 0;
  let counter = 0;
  return (prefix, timestamp, direction) => {
    if (timestamp !== lastTimestamp) {
      lastTimestamp = timestamp;
      counter = 0;
    }
    counter += 1;

    const raw = BigInt(timestamp) * BigInt(0x1000) + BigInt(counter);
    const now = direction === "descending" ? ~raw : raw;
    const timeBytes = new Uint8Array(6);
    for (let i = 0; i < 6; i += 1) {
      timeBytes[i] = Number((now >> BigInt(40 - 8 * i)) & BigInt(0xff));
    }
    return `${prefix}_${[...timeBytes]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("")}`;
  };
  /* oxlint-enable eslint/no-bitwise, unicorn/prefer-bigint-literals -- port ends here */
};

/** The low twelve bits: the last three hex characters of the 12-hex time. */
export const low12 = (id: string): number =>
  Number.parseInt(id.slice(4, 16), 16) % 0x1000;

export const BAND_LO = 0xfc0;
export const BAND_HI = 0xffe;

/** Whether a low-twelve value lands in the band the gateway admits. */
export const inBand = (low: number): boolean =>
  low >= BAND_LO && low <= BAND_HI;

/** One measured sample: every low-twelve value, and how many are in band. */
export interface BandFact {
  readonly inBand: number;
  readonly lows: readonly number[];
  readonly total: number;
}

/** The four facts the script reports. */
export interface BandFacts {
  /** One id per millisecond, ascending: the branch sessions do NOT use. */
  readonly ascending: BandFact;
  /** One id per millisecond, descending: what a real client mints. */
  readonly descending: BandFact;
  /** The plugin's own derivation, over distinct session ids. */
  readonly ours: BandFact;
  /** Eighty ids inside ONE millisecond, descending: the counter climbs. */
  readonly withinOneMs: BandFact;
}

/** The number of ids minted inside one millisecond. */
const WITHIN_ONE_MS = 80;

/** The first millisecond every upstream sample starts from. */
const EPOCH = 1_750_000_000_000;

const fact = (lows: readonly number[]): BandFact => ({
  inBand: lows.filter(inBand).length,
  lows,
  total: lows.length,
});

/**
 * Measure the band: the vendor's construction in both directions, the
 * counter climbing inside one millisecond, and the plugin's derivation.
 *
 * @param input.derive - the plugin's derivation, from a session id.
 * @param input.samples - how many ids each upstream direction mints.
 * @param input.oursSamples - how many session ids the plugin derives
 *   (`samples` when omitted).
 * @returns the four facts.
 */
export const bandFacts = ({
  derive,
  oursSamples,
  samples,
}: {
  readonly derive: (sessionId: string) => string;
  readonly oursSamples?: number;
  readonly samples: number;
}): BandFacts => {
  const onePerMillisecond = (direction: Direction): number[] => {
    const create = upstreamMinter();
    return Array.from({ length: samples }, (_, i) =>
      low12(create("ses", EPOCH + i, direction))
    );
  };
  const create = upstreamMinter();
  const within = Array.from({ length: WITHIN_ONE_MS }, () =>
    low12(create("ses", EPOCH, "descending"))
  );
  const ours = Array.from({ length: oursSamples ?? samples }, (_, i) =>
    low12(derive(`band-check-${i}`))
  );
  return {
    ascending: fact(onePerMillisecond("ascending")),
    descending: fact(onePerMillisecond("descending")),
    ours: fact(ours),
    withinOneMs: fact(within),
  };
};

/**
 * Each fact that disagrees with what the band's explanation predicts:
 * ascending ids are never in it (their low bits are the counter, `0x001`
 * first); descending ones always are (`0xFFF - counter`, `0xFFE` first);
 * inside one millisecond exactly the first 63 of 80 fit; and every id the
 * plugin derives is in it.
 *
 * @param facts - `bandFacts`' answer.
 * @returns one sentence per mismatch; empty when the explanation holds.
 */
export const bandMismatches = (facts: BandFacts): string[] => {
  const mismatches: string[] = [];
  const { ascending, descending, ours, withinOneMs } = facts;
  if (ascending.inBand !== 0) {
    mismatches.push(
      `upstream ascending: ${ascending.inBand} of ${ascending.total} in band, expected none`
    );
  }
  if (descending.inBand !== descending.total) {
    mismatches.push(
      `upstream descending: ${descending.inBand} of ${descending.total} in band, expected all`
    );
  }
  const fit = BAND_HI - BAND_LO + 1;
  if (withinOneMs.inBand !== Math.min(fit, withinOneMs.total)) {
    mismatches.push(
      `upstream, one millisecond: ${withinOneMs.inBand} of ${withinOneMs.total} in band, expected the first ${fit}`
    );
  }
  if (ours.inBand !== ours.total) {
    mismatches.push(
      `this plugin's derivation: ${ours.inBand} of ${ours.total} in band, expected all`
    );
  }
  return mismatches;
};

/**
 * The verdict the script prints, and its exit code: one `MISMATCH:` line per
 * fact the explanation does not predict and exit 1, or the `CONFIRMED`
 * paragraph and exit 0. Never both: a verdict that confirms after a mismatch
 * is the "prints CONFIRMED regardless" defect this replaces.
 *
 * @param facts - `bandFacts`' answer.
 * @returns the lines to print and the exit code.
 */
export const bandVerdict = (
  facts: BandFacts
): { readonly exit: 0 | 1; readonly lines: readonly string[] } => {
  const mismatches = bandMismatches(facts);
  if (mismatches.length > 0) {
    return {
      exit: 1,
      lines: mismatches.map((mismatch) => `MISMATCH: ${mismatch}`),
    };
  }
  return {
    exit: 0,
    lines: [
      "CONFIRMED. The band is real, and it is a CONSEQUENCE of minting descending:",
      "the vendor's own construction puts a session's low twelve bits at 0xFFF - counter,",
      "which is inside [0xfc0, 0xffe] for any client minting fewer than 64 ids per",
      "millisecond. This plugin mints ONE id per session, so its counter is 1 and its",
      "low twelve bits are 0xFFE. No clamp is involved anywhere.",
    ],
  };
};
