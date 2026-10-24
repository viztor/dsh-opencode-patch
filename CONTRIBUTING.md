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
pnpm run test:e2e:host  # opt-in: the published host binary with the probe (see "The e2e-host job")
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
- The **free-tier and unmetered** routing cases run keyless on purpose: measured 2026-10-06, a paid model answers `401 AuthError` on every endpoint without a credential, so keyless probing cannot tell the right PROTOCOL endpoint from a wrong one. Keyless protocol discrimination is real only for the free classes. What a paid model's keyless answer does still tell is whether a PATH exists at all — a removed path answers 404 — which is the one thing the keyless matrix below reads.
- `OPENCODE_ZEN_BASE_URL` / `OPENCODE_GO_BASE_URL` retarget `opencode-live` and `protocol-routing` at a mirror. The keyless matrix measures the vendor's own paths, which a mirror's base cannot name, so it skips while either is set.

What the main files are for:

- `opencode-live.e2e.ts` — the only place the plugin meets the real API. It catches what a stub cannot: **the vendor changing the payload**. The meter parses `/zen/go/v1/usage` and the picker consumes an enriched `/models` listing, so both shapes are asserted against the live service. The unkeyed cases assert reachability (never a 404) and that our header set does not change the gateway's verdict on a request — compared against the same call without it, rather than hardcoding a status the vendor may tighten.
- `patched-fetch-headers.e2e.ts` — a local `node:http` listener, so the _outgoing_ header set crosses a real socket. The live gateway cannot echo a request back; everywhere else in the suite the injected headers are asserted against a captured `fetch`.
- `keyless-matrix.e2e.ts` — the keyless 401-vs-404 matrix: two planes × four protocols × the legacy (`/zen(/go)/v1`) and modern (`/inference(/go)/…`) endpoint families, one PAID model per cell from the live catalog — never a free one, which the gateway serves keyless with a real completion. It **sends no key and reads none**, so the `e2e` job runs it on every pull request, and it retries a cell once on a 429, a 5xx or a transport error before reading it. A 404 means the path is gone, a 401/403 that it exists, a 410 or a 400 "Model is unavailable" that the model is. It asserts that all sixteen cells have a model and were sent, that every answer is readable, and that no cell the plugin dispatches to today with the default endpoint (`auto`, an alias of `modern`; `TODAY_DISPATCH`: completions on the LEGACY family, Responses, Messages and Google on the modern one) is gone — nor the modern completions cells P-R1 moves completions to (`NEXT_DISPATCH`, a labelled forward guard). The other legacy verdicts are recorded for P-R2 — among them the cells an `endpoint: legacy` user dispatches to (Responses and Messages on both planes, and Zen's Google), which are recorded, not asserted; Go's Google stays on `/inference/go/google/v1beta` under every family (`GO_GOOGLE_BASE_URL`), the modern cell `TODAY_DISPATCH` already asserts. The cell table, both sets and the classifier are a pure module (`test/support/keyless-matrix.ts`), unit-tested offline in `test/keyless-matrix.test.ts`, which also derives `TODAY_DISPATCH` from the URLs `S0_TODAY` measured.
- `protocol-routing.e2e.ts` — asks the gateway which endpoint serves each model's wire format: keyless for the free classes, keyed (and skipped without a secret) for paid ones.
- `dispatch-levels.e2e.ts` — every thinking level the picker offers is one pi's own rule accepts, swept over the whole shipped catalog; no network.
- `refusal-classification.e2e.ts` — the refusal classifier's verdicts on the gateway's bytes over a real `node:http` socket.
- `host-binary.e2e.ts` — the published host binary; see [The real-host harness](#the-real-host-harness). It skips unless `DSH_HOST_E2E=1`.

## The real-host harness

`test/support/host.ts` builds the host from the packages this repository installs, at the versions `test/support/host-versions.ts` names (pi 1.1.0 with the harness patch, the `@deepseek-ai` cluster at the published host's tag). The routing work is judged against it: the contract tests pin the host facts the design rests on (`docs/improvement-plan.md`, F11–F20), and the characterization rows record what today's plugin does.

Two tiers, both in-process:

- **Tier A — `mountTierA`.** A bare cordis `Context`, `LlmRuntime`, and `dsh-llm-pi-ai` mounted as a plugin with `{ providers }` (and optionally this plugin). No loader and no files. Use it for the `internal/config` waterfall and pi-ai's credential paths — anything that needs a fiber and the registry and nothing that reads a profile (`host-waterfall`, `host-shapes`, `host-credentials`). Mounted here, this plugin is a **degraded** one: it finds pi-ai through the loader's entries, so with no loader it patches fetch but mounts no hidden route and no Google bridge — the bridge's adapter class comes from the loader's pi-ai entry too (`host-harness` pins both: the stand-down line, and `loadPiAiAdapterHost` answering `undefined`). Characterize the real plugin in tier B.
- **Tier B — `bootTierB`.** dsh-app-boot's `boot()` with a temporary HOME, a test bundle and a profile patch, the way the harness's own composition tests boot one. Use it for the config editor, `settings.describe`, the loader's volatile commit and the characterization of the plugin as it ships (`host-editor-contracts`, `host-characterization`). Its rows carry **package names**, resolved by a stub module loader, not `cordis:` builtins: the plugin finds pi-ai's entry by `options.name === "@deepseek-ai/dsh-llm-pi-ai"` (`src/responses-provider.ts`), so a builtin-named row would silently drop today's hidden-route mount and the Google bridge. The loader starts rows in parallel, so tier B makes the order explicit: `order: "plugin-first"` (the default, and what the published binary does) or `"pi-ai-first"`.

What every case does:

- **Install the recording fetch before mounting** (`vi.stubGlobal("fetch", recordingFetch().fetch)`) and restore it with `vi.unstubAllGlobals()` after disposal: the plugin's fetch patch wraps whatever `fetch` is current when it mounts. The recording fetch answers `opencode.ai` and `models.opencode.ai` with a 401, refuses every other host, and keeps credential headers by length only.
- **Dispose in `afterEach`** (or a `finally`), and boot per case: a key the fetch patch captured in one case would change the next one's listing.
- **Credentials come from the fakes, not the environment.** The fakes (`fakeCredentials`, `fakeLaunchEnvironment`) are provided on the root, which is where pi-ai looks first. The plugin reads `OPENCODE_API_KEY`/`OPENCODE_GO_API_KEY` from the environment directly, so `bootTierB` blanks either one your shell exports for the life of the boot and restores it on dispose: the suite measures the keyless deployment whatever the shell holds (`host-harness` pins it). A case never sets them itself.
- **Give tier-B cases 30 s**, and wait with a deadline (`waitForRoutes`, 10 s by default, so a route that never registers fails by name inside the hook's budget), never a fixed sleep: the plugin mounts its hidden routes asynchronously.
- **A first row that fails does not hang the boot.** Tier B holds the second of pi-ai and the plugin until the first applies OR its fiber settles in any state, so a row whose config the schema rejects boots with that fiber FAILED (`fiber.await()` rethrows the real error) and the other row applied.

**Tags.** Every characterization row is titled `[BASELINE]` (must survive every phase), `[KNOWN_DEFECT]` (wrong today; a phase fixes it) or `[INTENDED_CHANGE]` (right today; a phase changes it on purpose). A phase that flips a row names it in its PR body; nothing else may move, except that P-R2's measured endpoint-family flip, if it happens, may move the family part of a `[BASELINE]` wire facet, re-tagging each one it moves and naming it in its PR body. The per-model rows live in `S0_TODAY` in `host.ts`, which the binary e2e reads too, and each model's three facets — model info, the call-config verdict, the wire — carry their own tag there: `host-characterization` generates one test per model and facet titled with that tag, so the tags in `S0_TODAY` are what govern which entries a phase may flip. The fixture is S0 plus one declared id no catalog knows (`CHARACTERIZED_PROFILE`); the contract tests keep plain S0.

**A catalog refresh can touch the rows.** `S0_TODAY`'s context windows and effort lists are copied from the generated `src/catalog-data.ts`, which the nightly refresh rewrites. A fixture-sanity case compares each row's context window and effort ids to the bundled catalog's derivation and names the model that moved; when it fails on a refresh pull request, update the row in `S0_TODAY`. A phase that moves a non-`BASELINE` `info` facet off the catalog on purpose (the user's context window, a toggle model's Off/On) adds that row's key to the case's `INFO_NOT_FROM_CATALOG` set in the same diff; the case refuses to exempt a `BASELINE` facet. The `e2e-host` job's scope includes `test/support/host.ts`, so the binary e2e runs on that pull request too and checks the edited row against the published binary.

**The apply order is a race on the real host.** Tier B fixes it; the published binary does not. The rows depend on whether the plugin's adapter decoration wrapped pi-ai's plane adapter, so the probe records that and the order it implies (`inferredOrder` — inferred, not observed: a pi-ai restart after the plugin applied would read as plugin-first), and the binary e2e picks its rows with `todayRowsFor(inferredOrder)` instead of pinning one.

### The `e2e-host` job

`.github/workflows/ci.yml`'s `e2e-host` job installs the published `@deepseek-ai/dsh` (at `HOST_VERSIONS.dsh`) into a throwaway prefix, builds this checkout, and runs `test/e2e/host-binary.e2e.ts`. That file creates a temporary HOME whose profile links this checkout and the probe bundle (`test/e2e/host/`) through relative `link:` paths, stores dummy keys in the profile's credentials file, boots `dsh --profile e2e --no-open --port 0`, and reads what `test/e2e/host/probe-plugin.mjs` measured. It asserts today's rows; P-R1 flips them.

- **Cells.** `pinned` forces pi to `HOST_VERSIONS.pi` with npm `overrides` and applies the harness patch with `patch -p1`, then asserts every row. `floating` takes the pi npm resolves for the published host. It skips the rows that depend on which ids pi describes (the keyed listing and the per-model rows) and still asserts the save rows. Those assume the floating pi lacks at least one of `ZEN_UNDESCRIBED` and still describes every other declared Zen id, so a pi that learns all of them or retires a declared id turns them red by design: triage a red floating run as a pi change first. Its stored-gap save row asserts only that SOME undescribed id blocks the save, not which one; its probe JSON is the record.
- **Triggers.** Dispatch and the nightly run take both cells. A pull request takes `pinned`, and only when it touches `src/host/**`, `src/lifecycle.ts`, `src/identity.ts`, the modules that install the host patches and mounts whose behaviour depends on the real loader and apply order, until P-R1 moves them under `src/host/` (`src/responses-provider.ts`, `src/responses-routes.ts`, `src/models-discovery.ts`, `src/google-bridge.ts`, `src/fetch-patch.ts`, `src/pi-provider.ts`, `src/stream-hook.ts`; every other row producer, such as `src/key-capture.ts`, `src/models-catalog.ts` or `src/config.ts`, is covered on each pull request by the in-process characterization of the same `S0_TODAY` rows, and by the nightly run), `cordis.patch.yml`, `test/e2e/host/**`, `test/e2e/host-binary.e2e.ts`, `test/support/host.ts` (the rows the binary e2e asserts), `test/support/host-versions.ts` or `patches/` (what the job installs and patches), `.github/workflows/ci.yml`, `vitest.e2e.config.ts` or `vite.config.ts` (the job's own steps and runner config; `vite.config.ts` also holds the pack config that builds `lib/index.mjs`, the bundle only this job loads into a real host, and the test settings the e2e config inherits) (scoped by a step: a workflow-level path filter would silence every other job; a diff the step cannot compute fails it rather than skipping the job). `package.json` is left out because every dependency bump touches it, so a change to its `test:e2e:host` script alone is exercised only by the nightly run. It needs no secret.

To run it locally, install the host into a prefix outside the checkout, then point the suite at it (placeholder paths; `pnpm` must be on `PATH`). The first line reads the versions from `test/support/host-versions.ts`, the same way the CI job does, so the snippet never names one itself:

```sh
eval "$(node --experimental-strip-types --input-type=module -e "import { HOST_VERSIONS as v } from './test/support/host-versions.ts'; console.log('DSH=' + v.dsh + ' PI=' + v.pi)")"
mkdir -p /home/you/dsh-host
printf '{ "private": true, "overrides": { "@earendil-works/pi-ai": "%s" } }\n' "$PI" > /home/you/dsh-host/package.json
npm install --prefix /home/you/dsh-host "@deepseek-ai/dsh@$DSH"
patch -p1 -d /home/you/dsh-host/node_modules/@earendil-works/pi-ai < "patches/@earendil-works__pi-ai@$PI.patch"
pnpm run build
DSH_HOST_E2E=1 DSH_HOST_PREFIX=/home/you/dsh-host pnpm run test:e2e:host --run
```

`DSH_HOST_PI_CELL=floating` runs the floating cell against an install without the override and the patch.

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

## Release process (maintainers)

1. Use conventional commits (`feat:`, `fix:`) — release-please opens the version-bump + changelog PR automatically; merging it tags and creates the GitHub Release, which fires OIDC publishing to npm and GitHub Packages.
2. For manual releases: bump `version` in `package.json`, add a `CHANGELOG.md` entry, commit, `git tag vX.Y.Z && git push origin vX.Y.Z`.
3. On every release, refresh the **Last verified** date and matrix in `README.md` after smoke-testing: registry install resolves, plugin loads in the DSH Web profile, and a free-tier Zen call succeeds.

## Docs

- `README.md` is consumer-facing: problem-first, install, UI config, troubleshooting. No dev internals.
- `CHANGELOG.md` is the per-version record. `AGENTS.md` is the agent-facing project brief — keep it specific to this repo.
