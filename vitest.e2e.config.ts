/**
 * Vitest config for the opt-in end-to-end suite.
 *
 * Deliberately separate from `vite.config.ts`: `pnpm test` must stay a fully
 * deterministic, offline unit run, so the `*.e2e.ts` files are collected only
 * here. `vp test` forwards `--config` to Vitest, which is what makes
 * `pnpm run test:e2e` the single entry point.
 *
 * @module vitest.e2e.config
 */

import { defineConfig } from "vite-plus";

import base from "./vite.config.ts";

export default defineConfig({
  ...base,
  test: {
    ...base.test,
    // Only the E2E files; the unit `include` from the base config is replaced.
    include: ["test/e2e/**/*.e2e.ts"],
    // These cross the public internet from CI, where 5s is far too tight.
    hookTimeout: 30_000,
    testTimeout: 30_000,
    // One file at a time: the live gateway rate-limits, and the header suite
    // binds a socket.
    fileParallelism: false,
  },
});
