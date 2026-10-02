# Contributing to dsh-opencode-patch

## Prerequisites

- Node.js `>= 24`, `pnpm` (v12)
- A checkout of this repo; for live testing, a DeepSeek Harness profile (see README for the `link:` setup)

## Commands

All tasks go through `pnpm` (which delegates to the Vite+ toolchain):

```sh
pnpm install     # install dependencies
pnpm run check   # format + lint + types; must be zero *errors* (warnings are reported, not gating)
pnpm run test    # Vitest suite, must be fully green and deterministic
pnpm run build   # vp pack + client rename -> lib/index.mjs, lib/index.d.mts, lib/client.js
```

> Note: in some shells `pnpm exec` stalls; invoke the binary directly if so: `node node_modules/.pnpm/vite-plus@*/node_modules/vite-plus/bin/vp <cmd>`.

## Live profile loop

The web profile wires this checkout with `link:`, so builds are picked up like this:

- **Host (`lib/index.mjs`) — restart required.** The base bundle ships `hmr root: []` (config watches only, `**/node_modules` ignored) and the loader caches ESM imports per process, so a linked package is never re-imported after boot. After every `pnpm run build`, restart `dsh web` — otherwise the profile silently keeps running the module from boot time. Symptom of a stale host: the plugin row is active but the settings card shows "This plugin is not loaded, so it cannot be configured." — `dsh-settings` is filtering on the old module's `Config` schema.
- **Client (`lib/client.js`) — refresh suffices.** The client bundle is re-served from disk on every page load; a browser refresh picks it up.
- **Verify after a restart:** the Plugins page shows the **OpenCode Patch** card, and its configure view renders all 17 fields (no unavailable line). `node --experimental-strip-types scripts/check.ts` catches a stale `lib/` before you do (`src/` newer than `lib/`).

## Code conventions

- **100% strict TypeScript.** No `any` leaks, no `as` assertions in `src/` — narrow `unknown` with `in`-operator type guards (`isRecord`, `isUnknownArray`, …).
- **Zero errors and zero warnings.** `vp check` must report neither — that is what `release:gate` and CI enforce, and the warnings tier has been paid down to zero: do not reintroduce one. The `error` tier is reserved for defects: async safety and throw contracts. If a rule fights a correct pattern (e.g. sync Promise wrappers that preserve `AsyncLocalStorage` context), prefer a targeted `oxlint-disable` comment with justification over weakening the rule globally.
- **Sync-over-async for context propagation.** `withStore` iterators and the `fetch` patch intentionally return promises from non-`async` functions so `als.run()` keeps turn context without an extra tick. Don't "fix" these into `async`.
- **Style:** arrow-function consts (not `function` declarations), dot notation, explicit `=== undefined` checks, `oxfmt` formatting.

## Test conventions

- **Deterministic only.** No `Math.random()`, no fixed `sleep()` waits. Async file assertions poll with a deadline (`waitForFileContent`).
- **No secret fixtures.** Session IDs are derived at runtime (`openCodeSessionIdFor`) or read from `OPENCODE_SESSION_ID`; never hardcode `ses_…` or API keys. `lib/` and `*.log` stay gitignored.
- **Restore globals.** Tests that touch `globalThis.fetch` or `process.env` must restore them in `afterEach` (`vi.unstubAllGlobals()`, `delete process.env.…`).
- **Meaningful coverage.** Every config field in the `SPECS` register (`src/settings-fields.ts`) needs both the on and off path where it has one; every passthrough claim needs a non-OpenCode URL test proving headers are untouched; helper functions exported from `usage-ui.ts` are asserted directly, not re-derived in the test.

## Release process (maintainers)

1. Use conventional commits (`feat:`, `fix:`) — release-please opens the version-bump + changelog PR automatically; merging it tags and creates the GitHub Release, which fires OIDC publishing to npm and GitHub Packages.
2. For manual releases: bump `version` in `package.json`, add a `CHANGELOG.md` entry, commit, `git tag vX.Y.Z && git push origin vX.Y.Z`.
3. On every release, refresh the **Last verified** date and matrix in `README.md` after smoke-testing: registry install resolves, plugin loads in the DSH Web profile, and a free-tier Zen call succeeds.

## Docs

- `README.md` is consumer-facing: problem-first, install, UI config, troubleshooting. No dev internals.
- `CHANGELOG.md` is the per-version record. `AGENTS.md` is the agent-facing project brief — keep it specific to this repo.
