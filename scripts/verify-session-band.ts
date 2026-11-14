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
 * It prints "CONFIRMED" only when every measured fact is the one the
 * explanation predicts (`bandVerdict` in `session-band.ts`, the pure half);
 * otherwise it prints one `MISMATCH:` line per fact and exits 1.
 *
 * @module scripts/verify-session-band
 */

import { openCodeSessionIdFor } from "../src/session.ts";
import { type BandFact, bandFacts, bandVerdict } from "./session-band.ts";

const report = (label: string, { inBand, lows, total }: BandFact): void => {
  const distinct = [...new Set(lows)].toSorted((a, b) => a - b);
  console.log(`\n── ${label} ──`);
  console.log(`samples             : ${total}`);
  console.log(
    `distinct low-12     : ${distinct
      .slice(0, 6)
      .map((v) => `0x${v.toString(16)}`)
      .join(", ")}${
      distinct.length > 6 ? `, … (${distinct.length} total)` : ""
    }`
  );
  console.log(
    `in band [fc0,ffe]   : ${inBand} (${((inBand / total) * 100).toFixed(2)}%)`
  );
};

const facts = bandFacts({
  derive: (sessionId) => openCodeSessionIdFor(sessionId),
  oursSamples: 50_000,
  samples: 200_000,
});

report(
  "upstream, ASCENDING — the branch the first version of this script modelled",
  facts.ascending
);
report(
  "upstream, DESCENDING — the branch sessions actually use",
  facts.descending
);

const within = facts.withinOneMs;
console.log("\n── upstream, descending, 80 ids inside ONE millisecond ──");
console.log(
  `low-12 runs 0x${Math.max(...within.lows).toString(16)} → 0x${Math.min(...within.lows).toString(16)}`
);
console.log(
  `in band             : ${within.inBand} of ${within.total} — the <64 that fit`
);

report("this plugin's derivation", facts.ours);

console.log("\n── verdict ──");
// The verdict is the pure half's (`bandVerdict`): the script only prints it.
const verdict = bandVerdict(facts);
for (const line of verdict.lines) {
  console.log(line);
}
process.exitCode = verdict.exit;
