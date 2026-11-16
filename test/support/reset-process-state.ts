/**
 * Reset the plugin's process-wide stores after every test.
 *
 * Vitest isolates FILES, not the tests inside one, and the plugin keeps two
 * stores at module level for the life of the process: the per-session spend,
 * and the live catalog. A case that leaves either behind makes the next case's
 * answer depend on run order — a recorded session becomes the meter's
 * fallback reading, and a fixture refresh changes every catalog count after
 * it. Measured: with the suite shuffled, seeds 42 and 1234 failed three
 * catalog cases on exactly that. The keys the fetch patch captures are kept
 * per root (`captureStoreFor`), so a case's fresh `Context` is a fresh store
 * and there is nothing to clear. The fetch installer's link chain
 * (`src/host/global-fetch.ts`) needs no reset either: its links are compared
 * by identity against `globalThis.fetch` and unwound by their own disposers,
 * so a leftover link answers nothing another case reads.
 *
 * `pnpm run test:shuffle` runs the suite in a random order to keep it that way.
 *
 * Imported through the same specifiers the tests use, so it clears the same
 * module instances they read.
 *
 * @module test/support/reset-process-state
 */
import { afterEach } from "vitest";

import { resetCatalogState } from "../../src/models-catalog.ts";
import { clearSessionUsageStore } from "../../src/session-cost.ts";

afterEach(() => {
  clearSessionUsageStore();
  resetCatalogState();
});
