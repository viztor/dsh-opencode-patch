/**
 * A live catalog whose two planes disagree about which models are free.
 *
 * No id the shipped shim lists on both planes disagrees on `is_free`, so a
 * lookup that reads the wrong plane gives the right answer on every shared row
 * and the defect stays invisible. (Zen-only free ids are a different case: the
 * Go plane does not list them at all — see the `big-pickle` case in
 * `test/tool-fallback.test.ts`.) This fixture refreshes the live catalog with two
 * probes that flip between the planes: `plane-probe` is free on Zen and paid on
 * Go, `go-probe` the reverse. `is_free` is derived from `id.includes("free")` or
 * a zero cost, so neither id contains "free" and only the cost decides.
 *
 * `refreshCatalog` merges into the live maps, and
 * `test/support/reset-process-state.ts` restores the shim after every test. The
 * stubbed fetch never touches the network.
 *
 * @module test/support/catalog-fixture
 */
import { refreshCatalog } from "./src.ts";

/** Free on Zen, paid on Go. */
export const ZEN_FREE_PROBE = "plane-probe";

/** Free on Go, paid on Zen. */
export const GO_FREE_PROBE = "go-probe";

const FREE = { input: 0, output: 0 } as const;
const PAID = { input: 1, output: 2 } as const;

/** Refresh the live catalog with the two plane-divergent probes. */
export const seedDivergentCatalog = async (): Promise<void> => {
  await refreshCatalog(
    (async () =>
      Response.json({
        opencode: {
          models: {
            [GO_FREE_PROBE]: { cost: PAID, name: "Go Probe" },
            [ZEN_FREE_PROBE]: { cost: FREE, name: "Plane Probe" },
          },
        },
        "opencode-go": {
          models: {
            [GO_FREE_PROBE]: { cost: FREE, name: "Go Probe" },
            [ZEN_FREE_PROBE]: { cost: PAID, name: "Plane Probe" },
          },
        },
      })) as unknown as typeof fetch,
    true
  );
};
