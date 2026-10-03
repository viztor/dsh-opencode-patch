---
tags:
  - dsh
  - plugin
  - opencode
  - cordis
status: note
aliases:
  - dsh-opencode
  - dsh-opencode-patch
---

# `dsh-opencode-patch` — OpenCode on DeepSeek Harness

> [!info] Summary DSH host plugin (`dsh-opencode-patch` on npm, published with the `@viztor/dsh-opencode-patch` and `@viztor/dsh-opencode` scoped aliases from the same tree; repo `viztor/dsh-opencode-patch`) that keeps OpenCode Zen free-tier models working inside DeepSeek Harness: deterministic `ses_…` session affinity, gateway origin-header restoration, `read`/`bash` tool-schema fallback, a models.dev-backed model catalog with SWR refresh, and a composer meter showing Go quota, Zen overflow, session spend and the active model's rate. Standards reference: [[OBSIDIAN]] (`~/dev/OBSIDIAN.md`).

## How it works

1. **Turn scope** — `apply()` hooks `llm/stream` for configured providers, derives a stable `ses_<12hex><14base62>` ID per DSH session (`openCodeSessionIdFor`, SHA-256), and carries it in `AsyncLocalStorage` across the streamed turn (`withStore`).
2. **Fetch patch** — `patchFetch()` intercepts only OpenCode traffic (`isOpenCodeRequest`: `opencode.ai/zen` URL or matching provider in turn state). It always sets `x-opencode-session`, optionally restores `User-Agent` / `x-opencode-client` / `x-opencode-project`, and injects fallback `read`+`bash` schemas into free-tier `/responses` bodies. Non-OpenCode requests return via the original fetch untouched.
3. **Settings UI** — `src/settings-page.tsx` builds `lib/client.js`, contributing the OpenCode Patch card under DSH Settings → Plugins: 16 fields covering every injection toggle, provider/gateway/session/origin overrides, the `enrichModels` catalog switch, and the usage markers/`showUsagePrice` knobs that decide what the composer meter mounts and shows.

## Package vs component (do not conflate)

- **npm package** `dsh-opencode-patch`: the installable unit (host `main` + `lib/client.js`); the `@viztor/dsh-opencode-patch` and `@viztor/dsh-opencode` scoped aliases are published from the same tree. The host resolves a row to `node_modules/<row name>`, so the row's `name` must equal `dsh-opencode-patch` exactly.
- **cordis row**: one _instance_ of the package. `id` (`dsh-opencode-patch`) is the instance id and doubles as the settings namespace the client card binds (with a fallback to the legacy namespace `dsh-opencode`). One package can back N rows with different ids/configs — the card binds the default `dsh-opencode-patch` row (single-row assumption; a second row would need its own NS binding).
- **plugin `name` export** (`src/index.ts`): the component identity (log lines, service scoping). Matches the default row id by convention only.
- **client slot key** (`PKG` in `src/settings-page.tsx`): bundle-level page key, always the npm package name.

## Repo map

Host bundle (`lib/index.mjs`) — a thin `apply` barrel over small modules:

- `src/index.ts` — `name` export + `apply` wiring. No `as`, arrow consts, sync Promise wrappers (ALS-safe by design).
- `src/config.ts` — schemastery `Config` schema + `resolveConfig`; every default lives once in `CONFIG_DEFAULTS`.
- `src/config-values.ts` · `src/guards.ts` — dependency-free readers and type guards. **The only host modules the client bundle may import** (never `config.ts`/schemastery).
- `src/session.ts` · `src/turn-store.ts` — `ses_<12hex><14base62>` hashing (`OPENCODE_SESSION_ID` override) and the ALS turn store.
- `src/stream-hook.ts` · `src/fetch-patch.ts` · `src/tool-fallback.ts` — the `llm/stream` hook, the fetch interceptor, and the free-tier `read`/`bash` fallback.
- `src/go-discovery.ts` · `src/usage.ts` · `src/usage-contract.ts` — credential/base-URL precedence, the usage Host service, and the shared `GoUsage` shape.
- `src/models-catalog.ts` — the canonical OpenCode Go/Zen catalog. A bundled shim (active models only, with per-million-token rates) plus SWR revalidation against `models.dev`; enriches gateway `/models` listings and feeds DSH model discovery. Both sit behind `enrichModels`.
- `src/session-cost.ts` — per-turn token/dollar accounting from `llm/stream` usage events, priced with catalog rates. Tracks the ACTIVE model so a mid-session switch reprices without discarding spend.
- `src/cordis-context.ts` · `src/debug.ts` — typed ctx/remote/slots interfaces and JSONL stream debug logging.

Web client bundle (`lib/client.js`):

- `src/settings-page.tsx` — bundle entry (`vp pack`): card wiring — `ClientContext`, `apply`, scope validation, dock injector, quota-pill props; re-exports `SPECS`. Guard unknown scope with `isSettingsFormScope`, never assert.
- `src/settings-copy.ts` — en/zh dictionaries + `Translate`; `zh` is typed against `en`'s keys, so a missing translation is a type error.
- `src/settings-fields.ts` — `FIELD` names, boolean/list/text draft conversions, and the 16-entry `SPECS` register in render order.
- `src/usage-pill.tsx` — quota ring + hover modal component; mounts only while an active provider matches a usage marker. Shows session spend/rate only when `showUsagePrice` is on.
- `src/usage-ui.ts` — dependency-free meter pieces (geometry, action links, `matchesAny`, window helpers, stylesheet), exported so tests hit real logic.

Tests — 139 deterministic cases in 11 files; polling helper instead of sleeps; each file restores `globalThis.fetch`/env in `afterEach` (the hook must live in every file, not just the old monolith):

- `session` · `config` · `fetch-patch` · `lifecycle` · `manifest` · `usage` · `catalog` · `session-cost` — host behavior split by concern; `settings-page` (14) card · `usage-pill` (11) meter gating · `client-bundle` (4) bundle boundary.
- `test/test-helpers.ts` — shared fixtures: mock streams, capture fetch, predicates, `createMockContext`.
- `test/primitives-stub.tsx` — stand-in for the host UI kit; keep it behaviourally faithful to the real primitives (trimmed drafts, empty clears).

Supporting files:

- `scripts/name-client-bundle.ts` — renames `vp pack`'s `.cjs` output to `lib/client.js` (DSH loader requires `.js`).
- `cordis.patch.yml` — default plugin row (`id: dsh-opencode-patch`); header comments are the headless-config reference.
- `scripts/check.ts` — CI/release gate: lib freshness, peer ranges, harness surface contracts, secret scan, consumer install+load, workflow guards, identity/title consistency, client budget. `scripts/publish-scoped.ts` — publishes/mirrors the scoped aliases with idempotent skip-if-exists guards.
- `.github/workflows/` — `ci.yml` (push/PR: check+test+build), `release.yml` (tag `v*.*.*`: verify, guard tag==version, OIDC `npm publish` of the primary + both scoped aliases, then verify every target is readable).
- `README.md` consumer docs · `CONTRIBUTING.md` dev conventions + release · `CHANGELOG.md` per-version record (release-please-owned; do not hand-edit).

## Commands & policies

```sh
pnpm install     # install dependencies
pnpm run build   # vp pack -> lib/index.mjs + lib/index.d.mts + lib/client.js
pnpm run check   # zero *errors* required; zero warnings is the goal (no debt)
pnpm run test    # 139 deterministic tests, fully green required
```

- Host code needs a **restart**: the base bundle ships `hmr root: []` (config watches only) and a `link:` package resolves through `node_modules` (ignored), so the host never re-imports `lib/index.mjs` after boot — restart `dsh web` after every `pnpm run build`, or the profile runs the old module and `dsh-settings` serves a stale/absent config schema. `lib/client.js` is re-served per page load, so a browser refresh suffices for client-only changes.
- Release: conventional commits on `main` → release-please opens the version + `CHANGELOG.md` PR → merging it tags, and `release.yml` publishes via OIDC (primary + scoped aliases). Never hand-edit `CHANGELOG.md`.
- DSH Web profile wires the build: `~/.dsh/profiles/web/package.json` deps + `bundles` use `dsh-opencode-patch` (`link:../../../dev/dsh-opencode` only for local dev).
- Hygiene: never hardcode `ses_…`/keys in src/tests/git; `lib/` gitignored; `OPENCODE_SESSION_ID` env override only.
