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
pnpm run test:coverage   # the same run, with the coverage ratchet enforced
pnpm run build   # vp pack + client rename -> lib/index.mjs, lib/index.d.mts, lib/client.js
pnpm run test:e2e   # opt-in end-to-end suite; talks to the real OpenCode gateway
pnpm run catalog:shim   # regenerate src/catalog-data.ts from models.dev
```

> Note: in some shells `pnpm exec` stalls; invoke the binary directly if so: `node node_modules/.pnpm/vite-plus@*/node_modules/vite-plus/bin/vp <cmd>`.

## End-to-end suite

`pnpm run test:e2e` runs `test/e2e/**/*.e2e.ts` through its own config (`vitest.e2e.config.ts`), so `pnpm run test` stays a fully offline, deterministic unit run. Nothing here is collected by the unit suite.

```sh
OPENCODE_E2E=1 OPENCODE_API_KEY=… OPENCODE_GO_API_KEY=… pnpm run test:e2e
```

- `OPENCODE_E2E=1` is required; without it every case skips, so a bare `pnpm run test:e2e` is a safe no-op.
- `OPENCODE_API_KEY` (Zen) arms the live `/models` enrichment case and the **paid** protocol-routing cases; `OPENCODE_GO_API_KEY` (Go plan) arms the live `/usage` case. Each block skips when its key is absent, which is why the CI `e2e` job stays green on fork PRs (secrets are not exposed to them) while still checking the endpoints answer.
- The **free-tier and unmetered** routing cases run keyless on purpose: measured 2026-10-06, a paid model answers `401 AuthError` on every endpoint without a credential, so keyless probing cannot tell them apart at all. Keyless discrimination is real only for the free classes.
- `OPENCODE_ZEN_BASE_URL` / `OPENCODE_GO_BASE_URL` retarget the suite at a mirror.

Two files, two jobs:

- `opencode-live.e2e.ts` — the only place the plugin meets the real API. It catches what a stub cannot: **the vendor changing the payload**. The meter parses `/zen/go/v1/usage` and the picker consumes an enriched `/models` listing, so both shapes are asserted against the live service. The unkeyed cases assert reachability (never a 404) and that our header set does not change the gateway's verdict on a request — compared against the same call without it, rather than hardcoding a status the vendor may tighten.
- `patched-fetch-headers.e2e.ts` — a local `node:http` listener, so the _outgoing_ header set crosses a real socket. The live gateway cannot echo a request back; everywhere else in the suite the injected headers are asserted against a captured `fetch`.

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
- **A component with hooks needs a real mount.** Calling `Component(props)` returns an element and runs none of its state, so a hook-bearing component can have twenty passing cases and still be untested — `usage-pill.tsx` sat at 9% exactly that way, with the poll loop, retry and dismissal all uncovered. `test/usage-pill-mount.test.tsx` is the answer: a `// @vitest-environment jsdom` pragma scoped to that one file, so the rest of the suite keeps the fast node environment and the zero-dependency element-tree style.

### The coverage ratchet

`pnpm run test:coverage` runs the same suite with thresholds from `vite.config.ts`. They are a **ratchet, not a target**: they sit at the level the suite actually reaches, so they fail when coverage DROPS and nothing else. Two rules follow.

- **Raise them when you genuinely add coverage** — a PR that lifts statements by a few points should lift the threshold with it, or the next contributor inherits a gate nobody re-measured.
- **Never set one above the current measurement.** That does not make the suite better; it makes every subsequent PR fail until someone deletes tests.

`src/index.ts` is excluded from the report — it is a pure re-export barrel, and the coverage tools attribute an untaken re-export line to whichever file re-exports it, so leaving it in reports a hole nobody can fill while hiding real ones. `responses-provider.ts` and `responses-routes.ts` carry their own per-file floors: the mount has four host contracts to survive, and a well-covered average must not be able to hide it.

## Release process (maintainers)

1. Use conventional commits (`feat:`, `fix:`) — release-please opens the version-bump + changelog PR automatically; merging it tags and creates the GitHub Release, which fires OIDC publishing to npm and GitHub Packages.
2. For manual releases: bump `version` in `package.json`, add a `CHANGELOG.md` entry, commit, `git tag vX.Y.Z && git push origin vX.Y.Z`.
3. On every release, refresh the **Last verified** date and matrix in `README.md` after smoke-testing: registry install resolves, plugin loads in the DSH Web profile, and a free-tier Zen call succeeds.

## Docs

- `README.md` is consumer-facing: problem-first, install, UI config, troubleshooting. No dev internals.
- `CHANGELOG.md` is the per-version record. `AGENTS.md` is the agent-facing project brief — keep it specific to this repo.
