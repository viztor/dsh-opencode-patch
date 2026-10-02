---
tags:
  - dsh
  - plugin
  - opencode
  - cordis
status: note
aliases:
  - dsh-opencode
---

# `dsh-opencode` — OpenCode on DeepSeek Harness

> [!info] Summary DSH host plugin (`@viztor/dsh-opencode` on npm, repo `viztor/dsh-opencode`) that keeps OpenCode Zen free-tier models working inside DeepSeek Harness: deterministic `ses_…` session affinity, gateway origin-header restoration, and `read`/`bash` tool-schema fallback. Standards reference: [[OBSIDIAN]] (`~/dev/OBSIDIAN.md`).

## How it works

1. **Turn scope** — `apply()` hooks `llm/stream` for configured providers, derives a stable `ses_<12hex><14base62>` ID per DSH session (`openCodeSessionIdFor`, SHA-256), and carries it in `AsyncLocalStorage` across the streamed turn (`withStore`).
2. **Fetch patch** — `patchFetch()` intercepts only OpenCode traffic (`isOpenCodeRequest`: `opencode.ai/zen` URL or matching provider in turn state). It always sets `x-opencode-session`, optionally restores `User-Agent` / `x-opencode-client` / `x-opencode-project`, and injects fallback `read`+`bash` schemas into free-tier `/responses` bodies. Non-OpenCode requests return via the original fetch untouched.
3. **Settings UI** — `src/settings-page.tsx` builds `lib/client.js`, contributing the OpenCode Patch card under DSH Settings → Plugins: 17 fields covering every injection toggle, provider/gateway/session/origin overrides, and the usage markers that decide when the quota ring mounts.

## Package vs component (do not conflate)

- **npm package** `@viztor/dsh-opencode`: the installable unit (host `main` + `lib/client.js`). The host resolves a row to `node_modules/<row name>`, so the row's `name` must equal this exactly.
- **cordis row**: one _instance_ of the package. `id` (`dsh-opencode`) is the instance id and doubles as the settings namespace the client card binds. One package can back N rows with different ids/configs — the card currently binds the default `dsh-opencode` row (single-row assumption; a second row would need its own NS binding).
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
- `src/cordis-context.ts` · `src/debug.ts` — typed ctx/remote/slots interfaces and JSONL stream debug logging.

Web client bundle (`lib/client.js`):

- `src/settings-page.tsx` — bundle entry (`vp pack`): card wiring — `ClientContext`, `apply`, scope validation, dock injector, quota-pill props; re-exports `SPECS`. Guard unknown scope with `isSettingsFormScope`, never assert.
- `src/settings-copy.ts` — en/zh dictionaries + `Translate`; `zh` is typed against `en`'s keys, so a missing translation is a type error.
- `src/settings-fields.ts` — `FIELD` names, boolean/list/text draft conversions, and the 17-entry `SPECS` register in render order.
- `src/usage-pill.tsx` — quota ring + hover modal component; mounts only while an active provider/model matches a usage marker.
- `src/usage-ui.ts` — dependency-free meter pieces (geometry, action links, `matchesAny`, window helpers, stylesheet), exported so tests hit real logic.

Tests — 94 deterministic cases in 4 files; polling helper instead of sleeps; restores `globalThis.fetch`/env:

- `test/plugin.test.ts` (66) host hashing/patch/config/usage · `test/settings-page.test.tsx` (13) card + `apply` · `test/usage-pill.test.tsx` (11) meter gating + helper functions · `test/client-bundle.test.ts` (4) bundle boundary.
- `test/primitives-stub.tsx` — stand-in for the host UI kit; keep it behaviourally faithful to the real primitives (trimmed drafts, empty clears).

Supporting files:

- `scripts/name-client-bundle.ts` — renames `vp pack`'s `.cjs` output to `lib/client.js` (DSH loader requires `.js`).
- `cordis.patch.yml` — default plugin row (`id: dsh-opencode`); header comments are the headless-config reference.
- `.github/workflows/` — `ci.yml` (push/PR: check+test+build), `release.yml` (tag `v*.*.*`: verify, guard tag==version, OIDC `npm publish`).
- `README.md` consumer docs · `CONTRIBUTING.md` dev conventions + release · `CHANGELOG.md` per-version record (release-please-owned; do not hand-edit).

## Commands & policies

```sh
pnpm install     # install dependencies
pnpm run build   # vp pack -> lib/index.mjs + lib/index.d.mts + lib/client.js
pnpm run check   # zero *errors* required; zero warnings is the goal (no debt)
pnpm run test    # 94 deterministic tests, fully green required
```

- Release: bump `package.json` + `CHANGELOG.md`, commit, `git tag vX.Y.Z && git push origin vX.Y.Z` (OIDC publishes; no tokens).
- DSH Web profile wires the published build: `~/.dsh/profiles/web/package.json` deps + `bundles` use `@viztor/dsh-opencode` (`link:` only for local dev).
- Hygiene: never hardcode `ses_…`/keys in src/tests/git; `lib/` gitignored; `OPENCODE_SESSION_ID` env override only.
