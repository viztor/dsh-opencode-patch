# Contributing to dsh-opencode-patch

## Prerequisites

- Node.js `>= 24` (CI runs the version in `.node-version`, and the floor in a job of its own), `pnpm` (v12). The suite refuses to start below the floor and names both versions: below it, `node:sqlite`, `Intl.DurationFormat` and the ICU strings the tests pin differ, and the failures read like regressions.
- The host versions the suite runs against (pi, the `@deepseek-ai` cluster, cordis and its loader) are named once, in `test/support/host-versions.ts`. `pnpm install` pins pi for every copy in the tree and applies the harness's own patch from `patches/` — that is what the `overrides` and `patchedDependencies` in `pnpm-workspace.yaml` do.
- A checkout of this repo; for live testing, a DeepSeek Harness profile (see README for the `link:` setup)

## Commands

All tasks go through `pnpm` (which delegates to the Vite+ toolchain):

```sh
pnpm install     # install dependencies
pnpm run check   # format + lint + types; must be zero *errors* (warnings are reported, not gating)
pnpm run test    # Vitest suite, must be fully green and deterministic
pnpm run test:coverage   # the same run, with the coverage ratchet enforced
pnpm run test:shuffle    # the same run in a random order; reproduce a failure with --sequence.seed=<n>
pnpm run test:mock       # gateway mock suite: offline, loopback only, runs in CI
pnpm run build   # vp pack + client rename -> lib/index.mjs, lib/index.d.mts, lib/client.js
pnpm run test:e2e   # opt-in end-to-end suite; talks to the real OpenCode gateway
pnpm run catalog:shim   # is src/catalog-data.ts current? (-- --write regenerates it from models.dev)
pnpm run limits:shim    # is src/go-limits-data.ts current? (-- --write regenerates it)
pnpm run cli:version    # is the pinned OpenCode CLI version the published one?
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
- **Offline by construction.** `test/support/offline.ts` refuses every non-loopback request in the unit and mock suites. The catalog's background revalidation used to reach `models.opencode.ai` dozens of times per run, so a networked runner's results could depend on the vendor's live catalog. A case that means to fetch stubs `fetch` itself.
- **No order dependence.** `test/support/reset-process-state.ts` clears the plugin's module-level stores (captured keys, session spend, the live catalog) after every test. A new module-level store gets a reset next to its siblings. `pnpm run test:shuffle` is how to check, and CI runs it.
- **Tests reach `src` through `test/support/src.ts`.** It re-exports, from each defining module, everything a test needs, so a module move or a barrel change edits one file instead of thirty. A new test imports from `./support/src.ts` (`../support/src.ts` under `test/mock` and `test/e2e`); add a missing name there rather than importing a `src` path. The exceptions are `vi.mock("../src/x.ts")` targets (and their `importOriginal<typeof import(…)>` type), which must name the module; fresh-module re-imports after `vi.resetModules()`, whose subject is module identity; the architecture and public-API tests, whose subject is the `src` layout and the barrel; the jsdom (client) tests, which import the defining module directly, because `src.ts` re-exports the host graph (`node:sqlite`, pi, `lifecycle.ts`) and the next rule keeps that out of client tests; and the setup file `test/support/reset-process-state.ts`, which runs before the jsdom tests too. `test/architecture.test.ts` fails on a static or side-effect `src` import anywhere else, on a dynamic `import("../src/…")` in a file that never calls `vi.resetModules()`, and on a jsdom test that value-imports the door. Importing the door loads the whole `src` graph, host and client, so a module that fails to load fails every test that comes through it.
- **Host-only fixtures stay out of shared helpers.** `test/test-helpers.ts` is imported by the jsdom (client) tests, so anything that needs `node:sqlite` or the filesystem belongs in `test/support/`, as `opencode-store-fixture.ts` does.
- **A test for a fix fails without it.** Before committing a regression test, revert the fix locally and watch it fail.
- **Meaningful coverage.** Every config field in the `SPECS` register (`src/settings-fields.ts`) needs both the on and off path where it has one; every passthrough claim needs a non-OpenCode URL test proving headers are untouched; helper functions exported from `usage-ui.ts` are asserted directly, not re-derived in the test.
- **A component with hooks needs a real mount.** Calling `Component(props)` returns an element and runs none of its state, so a hook-bearing component can have twenty passing cases and still be untested — `usage-pill.tsx` sat at 9% exactly that way, with the poll loop, retry and dismissal all uncovered. `test/usage-pill-mount.test.tsx` is the answer: a `// @vitest-environment jsdom` pragma scoped to that one file, so the rest of the suite keeps the fast node environment and the zero-dependency element-tree style.

### The coverage ratchet

`pnpm run test:coverage` runs the same suite with thresholds from `vite.config.ts`. They are a **ratchet, not a target**: they sit at the level the suite actually reaches, so they fail when coverage DROPS and nothing else. Two rules follow.

- **Raise them when you genuinely add coverage** — a PR that lifts statements by a few points should lift the threshold with it, or the next contributor inherits a gate nobody re-measured.
- **Never set one above the current measurement.** That does not make the suite better; it makes every subsequent PR fail until someone deletes tests.

`src/index.ts` is excluded from the report — it is a pure re-export barrel, and the coverage tools attribute an untaken re-export line to whichever file re-exports it, so leaving it in reports a hole nobody can fill while hiding real ones. `responses-provider.ts` and `responses-routes.ts` carry their own per-file floors: the mount has four host contracts to survive, and a well-covered average must not be able to hide it.

## The freshness checks in CI

The `catalog freshness` job runs three checks against what the vendor publishes: `catalog:shim` (the bundled catalog, `src/catalog-data.ts`), `limits:shim` (the Go allowances, `src/go-limits-data.ts`) and `cli:version` (the pinned CLI version in `src/identity.ts`). The vendor moves all three most days, so what a run does with a mismatch depends on whether the change under test could have caused it.

- **A pull request is gated on a check only when its own diff touches that check's inputs.** The inputs are the check's script and every local module it loads, transitively, plus `src/identity.ts` for `cli:version`, which the script reads as data. The edges are the ones Node loads: the source's types are erased by Node's own stripper and the specifiers read by a real lexer, so a whole-statement `import type` loads nothing and is no edge, and an import written in a string or template is not one either; anything else is, so the set reaches further than the generator's own folder: the catalog parser loads `src/config.ts`, so a settings change gates `catalog:shim`. `scripts/freshness-scope.ts` derives the inputs from the sources and answers `gate` or `report` for the diff (`git diff --name-only HEAD^1 HEAD` on the merge ref). Change `src/models-catalog.ts` and forget to regenerate, and the pull request fails; that omission is what the gate exists to catch.
- **One half of `cli:version` gates every pull request.** The script checks two things: that every copy of the CLI version in `src/`, `test/`, `docs/`, `scripts/` and `README.md` agrees with `src/identity.ts`, and that the pin is the published version. The first is offline and skips the two generated tables (they hold the vendor's data, not copies the repository maintains), so only the repository can break it, and `pnpm run cli:version -- --copies` runs on every pull request as a gate. Only the registry comparison is scoped as above, and when it only warns, the warning quotes the script's own `error:` line.
- **Otherwise the check reports.** A stale file is a `::warning::`, the job stays green, and the nightly run regenerates both files and opens the refresh as a pull request of its own. A stale CLI pin is only warned about, by every run including the nightly; bumping it is a human pull request to `src/identity.ts` and its copies, which is then gated, because the pin is an input. Vendor drift is not a regression your pull request introduced, so it is not a reason to fail it.
- **The generated files are never inputs.** A pull request that carries only a refresh reports. One that changes `src/catalog-data.ts` or `src/go-limits-data.ts` without touching what generates it gets a warning naming the file, because those files are never edited by hand.
- **A push to `main` reports.** The nightly run regenerates the two generated files and opens the refresh as a pull request; for the CLI version it warns. A manual dispatch only reports the CLI version. None of these paths gates, for the same reason.
- **The gates fail closed.** Each runs unless the scope step answered `report`, so a lost answer gates every pull request rather than skipping the check.

To see the answer for your branch before CI does:

```sh
git diff --name-only main... \
  | node --experimental-strip-types --disable-warning=ExperimentalWarning scripts/freshness-scope.ts catalog:shim
```

## Release process (maintainers)

1. Use conventional commits (`feat:`, `fix:`) — release-please opens the version-bump + changelog PR automatically; merging it tags and creates the GitHub Release, which fires OIDC publishing to npm and GitHub Packages.
2. For manual releases: bump `version` in `package.json`, add a `CHANGELOG.md` entry, commit, `git tag vX.Y.Z && git push origin vX.Y.Z`.
3. On every release, refresh the **Last verified** date and matrix in `README.md` after smoke-testing: registry install resolves, plugin loads in the DSH Web profile, and a free-tier Zen call succeeds.

## Docs

- `README.md` is consumer-facing: problem-first, install, UI config, troubleshooting. No dev internals.
- `CHANGELOG.md` is the per-version record. `AGENTS.md` is the agent-facing project brief — keep it specific to this repo.
