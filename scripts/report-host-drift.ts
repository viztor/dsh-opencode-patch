/**
 * Report where the harness channels' latest releases have moved past the
 * records in `test/support/host-versions.ts` (D22'').
 *
 *     node --experimental-strip-types scripts/report-host-drift.ts [--registry <url>]
 *
 * CI runs it nightly and on dispatch. It REPORTS and never gates: each drift is
 * one `::warning::` line and the exit code is 0, whatever the registry
 * answered, because a channel moving is the harness's release, not a
 * regression of this repository. The bump itself is proposed by
 * `scripts/propose-host-bump.ts`, the nightly step after this one, following
 * CONTRIBUTING's release step 3.
 *
 * The rules are `scripts/host-drift.ts`; this half fetches one abbreviated
 * packument per package from the registry (`--registry`, default the public
 * one; `scripts/registry-view.ts`) and prints what the rules answer. A fetch
 * that fails is a warning too, so a run that read nothing never prints
 * "current".
 *
 * @module scripts/report-host-drift
 */
import { CHANNELS } from "../test/support/host-versions.ts";
import { hostDrift } from "./host-drift.ts";
import { fetchRegistryView } from "./registry-view.ts";

const flag = process.argv.indexOf("--registry");
const registry =
  flag === -1 ? "https://registry.npmjs.org" : (process.argv[flag + 1] ?? "");

try {
  const view = await fetchRegistryView(registry);
  const lines = hostDrift(CHANNELS, view);
  for (const line of lines) {
    console.log(`::warning::${line}`);
  }
  if (lines.length === 0) {
    console.log(
      `current: ${Object.entries(CHANNELS)
        .map(
          ([channel, record]) => `${channel} dsh@${record.dsh}, pi ${record.pi}`
        )
        .join("; ")}`
    );
  }
} catch (error) {
  console.log(
    `::warning::host drift not checked: ${error instanceof Error ? error.message : String(error)}`
  );
}
