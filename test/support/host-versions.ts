/**
 * The host this repository's test install runs, named once.
 *
 * - `pi` is the `@earendil-works/pi-ai` the harness's own lockfile pins, and
 *   patches with the hunks committed under `patches/` (D14). A registry install
 *   of the published host resolves the wrapper's `^1.1.0` to the newest 1.x
 *   instead; this pin is the version the harness itself builds and tests on.
 * - `dsh`, `cordis` and `loader` are what a registry install of
 *   `@deepseek-ai/dsh` resolves today (D22) — `dsh-llm`, `dsh-llm-pi-ai` and the
 *   rest of the cluster on one tag, `@deepseek-ai/cordis` and
 *   `@deepseek-ai/cordis-plugin-loader` on their own untagged lines. Re-measured
 *   by installing the published host into a throwaway prefix and reading the
 *   installed `package.json` versions.
 *
 * `pnpm-workspace.yaml` (overrides, patchedDependencies) and `package.json` are
 * what install these; `test/host-versions.test.ts` checks the installed tree
 * (with `pnpm-lock.yaml` as the record of what pnpm resolved, and the published
 * peer ranges) against this record, and `test/harness-channel.test.ts` checks
 * the declarations and the lockfile, so a host bump is a deliberate change to
 * both sides.
 *
 * @module test/support/host-versions
 */
export const HOST_VERSIONS = {
  cordis: "4.0.5",
  dsh: "0.2.1-rc.2",
  loader: "1.0.6",
  pi: "1.1.0",
} as const;
