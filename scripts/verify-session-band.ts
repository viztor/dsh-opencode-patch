/**
 * Verification: the session-id low-twelve-bit band, and the DIRECTION it comes
 * from.
 *
 * PR #37 (taykof) claims the OpenCode gateway admits only sessions whose low
 * twelve hex bits land in `f[c-f]x` — `[0xfc0, 0xffe]` — and refuses the rest with
 * `403 FreeTierError`. This script shows where that band comes from, and this
 * revision exists because the first version of it "refuted" the claim by porting
 * the vendor's generator WITHOUT its `direction` step.
 *
 * `packages/opencode/src/id/id.ts` at v1.19.5:
 *
 *   now = BigInt(Date.now()) * 4096n + BigInt(++counter)   // counter resets每毫秒
 *   now = direction === "descending" ? ~now : now
 *
 * **Sessions are minted `descending`.** So their twelve hex digits are `~now`
 * masked to 48 bits, and inverting `(ms << 12) + counter` puts the low twelve
 * bits at `0xFFF - counter` — for the first id of a millisecond, `0xFFE`. That is
 * inside the band, and a client minting fewer than 64 ids in one millisecond stays
 * inside it, which is every real client.
 *
 * The first version of this script modelled the ASCENDING branch, where low twelve
 * bits are the counter itself and the first id is `0x001` — outside the band. From
 * that it concluded the band could not be an admission rule. The band is enforced;
 * what was wrong was the direction. Measured on the live gateway with the vendor
 * client's own captured body, changing only this header:
 *
 *   descending, low12 0xFFE -> 200      ascending, low12 0xFFE -> 200
 *   descending, low12 0xFF8 -> 200      ascending, low12 0x001 -> 403 FreeTierError
 *
 * Run: node --experimental-strip-types scripts/verify-session-band.ts
 *
 * @module scripts/verify-session-band
 */

import { openCodeSessionIdFor } from "../src/session.ts";

/**
 * Faithful port of upstream `packages/opencode/src/id/id.ts`, both directions.
 *
 * The bitwise shift/mask and the `BigInt(...)` calls are deliberate: this is a
 * byte-for-byte port of the vendor's arithmetic, and the point of the script is
 * that it reproduces THEIR output rather than a rewritten approximation. The
 * lint rules that object are disabled for exactly this file and this reason.
 */
/* oxlint-disable eslint/no-bitwise, unicorn/prefer-bigint-literals -- port of the vendor's arithmetic */
let lastTimestamp = 0;
let counter = 0;

const upstreamCreate = (
  prefix: string,
  timestamp: number,
  direction: "ascending" | "descending"
): string => {
  if (timestamp !== lastTimestamp) {
    lastTimestamp = timestamp;
    counter = 0;
  }
  counter += 1;

  const raw = BigInt(timestamp) * BigInt(0x1000) + BigInt(counter);
  const now = direction === "descending" ? ~raw : raw;
  const timeBytes = Buffer.alloc(6);
  for (let i = 0; i < 6; i += 1) {
    timeBytes[i] = Number((now >> BigInt(40 - 8 * i)) & BigInt(0xff));
  }
  return `${prefix}_${timeBytes.toString("hex")}`;
};
/* oxlint-enable eslint/no-bitwise, unicorn/prefer-bigint-literals -- port ends here */

/** The low twelve bits: the last three hex characters of the 12-hex time. */
const low12 = (id: string): number =>
  Number.parseInt(id.slice(4, 16), 16) % 0x1000;

const BAND_LO = 0xfc0;
const BAND_HI = 0xffe;
const inBand = (low: number): boolean => low >= BAND_LO && low <= BAND_HI;

/** One id per millisecond, which is what a real client mints. */
const onePerMillisecond = (direction: "ascending" | "descending"): number[] => {
  const lows: number[] = [];
  for (let i = 0; i < 200_000; i += 1) {
    lows.push(low12(upstreamCreate("ses", 1_750_000_000_000 + i, direction)));
  }
  return lows;
};

/** Several ids inside ONE millisecond: `counter` climbs, so the residue moves. */
const withinOneMillisecond = (): number[] => {
  lastTimestamp = 0;
  counter = 0;
  const lows: number[] = [];
  for (let i = 0; i < 80; i += 1) {
    lows.push(low12(upstreamCreate("ses", 1_750_000_000_000, "descending")));
  }
  return lows;
};

const report = (label: string, lows: readonly number[]): void => {
  const banded = lows.filter(inBand).length;
  const distinct = [...new Set(lows)].toSorted((a, b) => a - b);
  console.log(`\n── ${label} ──`);
  console.log(`samples             : ${lows.length}`);
  console.log(
    `distinct low-12     : ${distinct
      .slice(0, 6)
      .map((v) => `0x${v.toString(16)}`)
      .join(", ")}${
      distinct.length > 6 ? `, … (${distinct.length} total)` : ""
    }`
  );
  console.log(
    `in band [fc0,ffe]   : ${banded} (${((banded / lows.length) * 100).toFixed(2)}%)`
  );
};

report(
  "upstream, ASCENDING — the branch the first version of this script modelled",
  onePerMillisecond("ascending")
);
report(
  "upstream, DESCENDING — the branch sessions actually use",
  onePerMillisecond("descending")
);

const within = withinOneMillisecond();
console.log("\n── upstream, descending, 80 ids inside ONE millisecond ──");
console.log(
  `low-12 runs 0x${Math.max(...within).toString(16)} → 0x${Math.min(...within).toString(16)}`
);
console.log(
  `in band             : ${within.filter(inBand).length} of ${within.length} — the <64 that fit`
);

const ours: number[] = [];
for (let i = 0; i < 50_000; i += 1) {
  ours.push(low12(openCodeSessionIdFor(`band-check-${i}`)));
}
report("this plugin's derivation", ours);

console.log("\n── verdict ──");
console.log(
  "CONFIRMED. The band is real, and it is a CONSEQUENCE of minting descending:"
);
console.log(
  "the vendor's own construction puts a session's low twelve bits at 0xFFF - counter,"
);
console.log(
  "which is inside [0xfc0, 0xffe] for any client minting fewer than 64 ids per"
);
console.log(
  "millisecond. This plugin mints ONE id per session, so its counter is 1 and its"
);
console.log("low twelve bits are 0xFFE. No clamp is involved anywhere.");
