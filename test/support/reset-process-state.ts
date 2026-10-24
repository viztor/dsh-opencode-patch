/**
 * Reset the plugin's process-wide stores after every test.
 *
 * Vitest isolates FILES, not the tests inside one, and the plugin keeps three
 * stores at module level for the life of the process: the keys the fetch patch
 * captured, the per-session spend, and the live catalog. A case that leaves any
 * of them behind makes the next case's answer depend on run order — a captured
 * key turns a "no credential" case into a "credential resolved" one, a recorded
 * session becomes the meter's fallback reading, and a fixture refresh changes
 * every catalog count after it. Measured: with the suite shuffled, seeds 42 and
 * 1234 failed three catalog cases on exactly that.
 *
 * `pnpm run test:shuffle` runs the suite in a random order to keep it that way.
 *
 * Imported through the same specifiers the tests use, so it clears the same
 * module instances they read.
 *
 * @module test/support/reset-process-state
 */
import { afterEach } from "vitest";

import { clearCapturedApiKeys } from "../../src/key-capture.ts";
import { resetCatalogState } from "../../src/models-catalog.ts";
import { clearSessionUsageStore } from "../../src/session-cost.ts";

afterEach(() => {
  clearCapturedApiKeys();
  clearSessionUsageStore();
  resetCatalogState();
});
