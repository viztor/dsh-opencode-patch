/**
 * Vitest config for the deterministic mock-gateway suite.
 *
 * Deliberately separate from `vite.config.ts`, for the opposite reason
 * `vitest.e2e.config.ts` is: `pnpm test` must stay a plain unit run, while
 * these files boot a Vite server and bind a socket. Unlike the e2e suite they
 * need no secrets and never leave the loopback interface, so CI runs them on
 * every push: `pnpm run test:mock`.
 *
 * @module vitest.mock.config
 */

import { defineConfig } from "vite-plus";

import base from "./vite.config.ts";

export default defineConfig({
  ...base,
  test: {
    ...base.test,
    // Only the mock files; the unit `include` from the base config is replaced.
    // They keep the base config's file parallelism: each socket they bind is
    // an ephemeral loopback port of its own.
    include: ["test/mock/**/*.mock.ts"],
    // A Vite server boots inside each file and pi parses a full stream per
    // case; neither is slow, but 5s is a unit-run budget, not this one.
    hookTimeout: 30_000,
    testTimeout: 30_000,
  },
});
