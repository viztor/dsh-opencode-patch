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
3. **Settings UI** — `src/settings-page.tsx` builds `lib/client.js`, contributing the OpenCode Patch card under DSH Settings → Plugins: **8 fields in 3 sections** (Gateway Requests / Models & Free Tier / Quota Meter) — the behaviour toggles plus the `keySource` credential policy. The other 8 schema knobs are **config-only** (see `CONFIG_ONLY_FIELDS`), and the row config (`cordis.patch.yml`) is their reference.

## Package vs component (do not conflate)

- **npm package** `dsh-opencode-patch`: the installable unit (host `main` + `lib/client.js`); the `@viztor/dsh-opencode-patch` and `@viztor/dsh-opencode` scoped aliases are published from the same tree. The host resolves a row to `node_modules/<row name>`, so the row's `name` must equal `dsh-opencode-patch` exactly.
- **cordis row**: one _instance_ of the package. `id` (`dsh-opencode-patch`) is the instance id and doubles as the settings namespace the client card binds (with a fallback to the legacy namespace `dsh-opencode`). One package can back N rows with different ids/configs — the card binds the default `dsh-opencode-patch` row (single-row assumption; a second row would need its own NS binding).
- **plugin `name` export** (`src/index.ts`): the component identity (log lines, service scoping). Matches the default row id by convention only.
- **client slot key** (`PKG` in `src/settings-page.tsx`): bundle-level page key, always the npm package name.

## Why the gateway markers and the free-tier marker exist

Two knobs look redundant until you know what they cover — both are config-only for that reason. A third, `usageProviderMarkers`, _was_ redundant and has been removed: see below.

**`gatewayUrls`** is consulted in exactly one place (`isOpenCodeRequest`) and is checked _before_ the turn state. Two kinds of request need it: one that arrives with **no active turn state** (the patch runs deep in the adapter path, and not every gateway call happens inside a turn) and one whose **provider id we do not list** (a custom relay, mirror, or self-hosted gateway). The provider list cannot cover either, because it is matched against turn state that may not exist.

Known gap: `isModelsListingUrl` still hardcodes `opencode.ai/zen`, so a custom gateway gets header injection but **not** model enrichment. Fixing it means threading `gatewayUrls` into that predicate — it is called from `patchFetch`, where the config is already in hand.

**`freeModelMarker`** exists because **the gateway really does treat free tier differently**. `tool-fallback.ts`: "The OpenCode Zen gateway rejects free-tier `/responses` bodies that lack `read` and `bash` in `tools`, while DSH deliberately does not send them." The plugin rewrites the body to carry both schemas — and only when they are genuinely missing, so a body that already declares them passes through byte-identical. The marker (default `"free"`, `"*"` for every model) is how we detect "free tier", because a model row carries **no capability flag** — the only signal is the model id. It is config-only because `"free"` tracks the vendor's ids and `"*"` is the escape hatch if the rule ever widens to paid models.

### The meter's registration: declare services with `ctx.inject`

The composer-dock meter depends on two cross-plugin services: `slots` (to register the entry) and `modelDirectories` (to know the active provider). **They must be declared with `ctx.inject([...], scope => …)`**, which is the host's own idiom — `ui-model-selection` does exactly this for the same pair:

```ts
ctx.inject(['slots', 'modelDirectories'], (scope: ClientContext) => { … })
```

Reading `ctx.modelDirectories` straight off the **root** context is not guaranteed, and because every access in that path is optional (`?.`) the failure is **silent**: `directoryFor` never resolved, the injector returned `null`, and the meter simply never mounted — with no error anywhere. That is how it shipped broken. `settings-page.tsx` now registers through `ctx.inject` and falls back to the root context only when the assembly has no `inject` at all. A regression test pins it: a root context carrying _neither_ service must still produce a working injector, because both arrive on the injected scope.

General rule: when reaching for another plugin's service, declare it. An optional read off the root context turns a wiring mistake into a missing feature.

It gated _whether the meter renders_ for the active provider, and its default was `["opencode-go", "opencode"]` — the same list as `providers`, reversed. They are the same set by construction: a route we do not claim carries no OpenCode headers, so it has no quota to report either. The meter now reads **`providers`** (client-side, from the served settings snapshot, falling back to `DEFAULT_PROVIDERS`), and the pill's prop is named `meterProviders` so the source is obvious.

`DEFAULT_PROVIDERS` therefore moved to `config-values.ts` — the client bundle needs the default and may not import `config.ts` (schemastery). This is the same pattern as `usageKeyEnv`: a row setting that asked the user to restate a decision the composition already owns. Both are gone; prefer removing such a knob over documenting it.

## Repo map

Host bundle (`lib/index.mjs`) — a thin `apply` barrel over small modules:

- `src/index.ts` — public barrel: re-exports identity, `apply`, and every module's surface. No `as`, arrow consts, sync Promise wrappers (ALS-safe by design).
- `src/identity.ts` · `src/lifecycle.ts` — the component/package name constants, and the `apply()` composition: one installer per side effect (rename notice, usage service, fetch patch, stream hook, model discovery) in load-bearing order.
- `src/config.ts` — schemastery `Config` schema + `resolveConfig`; every default lives once in `CONFIG_DEFAULTS`.
- `src/config-values.ts` · `src/guards.ts` — dependency-free readers and type guards. **The only host modules the client bundle may import** (never `config.ts`/schemastery).
- `src/session.ts` · `src/turn-store.ts` — `ses_<12hex><14base62>` hashing (`OPENCODE_SESSION_ID` override) and the ALS turn store.
- `src/stream-hook.ts` · `src/fetch-patch.ts` · `src/tool-fallback.ts` — the `llm/stream` hook, the fetch interceptor, and the free-tier `read`/`bash` fallback.
- `src/key-capture.ts` — what a credential _is_: header extraction, placeholder rejection, tier classification and the capture store. Split from `go-discovery.ts`, which keeps the plan side (endpoint, credential reference, and the policy ordering the two sources against each other).
- `src/go-discovery.ts` · `src/usage.ts` · `src/usage-contract.ts` — credential/base-URL precedence, the usage Host service, and the shared `GoUsage` shape.
- `src/catalog-data.ts` — the static Go/Zen model shim: per-model specs, per-million-token rates, and the provider-scoped retirement list. Pure data, no behavior.
- `src/models-catalog.ts` — parses `models.dev`, revalidates the catalog (SWR), and enriches gateway `/models` listings and discovery feeds. Re-exports the `catalog-data.ts` surface. Both sit behind `enrichModels`.
- `src/models-discovery.ts` — provider-aware decoration for `ctx.llm.discoverModels` answers on claimed OpenCode routes. It preserves adapter rows, appends missing canonical rows, and omits provider-retired rows when `enrichModels` is on.
- `src/session-cost.ts` — per-turn token/dollar accounting from `llm/stream` usage events, priced with catalog rates. Tracks the ACTIVE model so a mid-session switch reprices without discarding spend.
- `src/cordis-context.ts` · `src/debug.ts` — typed ctx/remote/slots interfaces and JSONL stream debug logging.

Web client bundle (`lib/client.js`):

- `src/settings-page.tsx` — bundle entry (`vp pack`): wiring only — `ClientContext`, `apply`, scope validation, the settings store, slot registration, quota-pill props; re-exports `SPECS`. Guard unknown scope with `isSettingsFormScope`, never assert.
- `src/settings-card.tsx` · `src/settings-field-shell.tsx` · `src/settings-boolean-field.tsx` · `src/settings-choice-field.tsx` — the configuration card (one control per `CARD_FIELDS` entry) and its controls: one shared row shell (label / override badge / reset / message) plus a boolean toggle and an enum `<select>`. Pure views fed by the store `settings-page.tsx` owns.
- `src/settings-copy.ts` — en/zh dictionaries + `Translate`; `zh` is typed against `en`'s keys, so a missing translation is a type error.
- `src/settings-fields.ts` — the `CARD_FIELDS` register: the single source of truth for which knobs the card edits (knob, **section**, control kind, copy keys). `SPECS` (the draft conversions the form model binds) and the card's JSX are both derived from it, so a field can no longer be bound but never rendered. Kinds are `boolean` / `select` only — the card renders toggles and one enum, so a `text`/`list` kind would be unreachable vocabulary. A new kind must be added to `COMPONENT_BY_KIND` in `test/settings-page.test.tsx`, which is a total record over the union. Each entry names a `GROUP`, and the card renders a heading wherever the group changes — so **a group's entries must stay contiguous** (a test pins that).
- **`CONFIG_ONLY_FIELDS`** (same file) is the other half of the register: the schema knobs that deliberately render no control, each with its reason. The card shows the decisions a user makes (toggles, the credential policy); everything there is an _override_ — a literal (UA string, header value, endpoint), a marker (model-id or URL substring) or a reference (env-var name, credential ref, route list) whose default fits every documented setup. Exposing them only invited someone to break their own routing, and hiding them is what took the card from 17 rows to 8. A test pins that `CARD_FIELDS` and `CONFIG_ONLY_FIELDS` **partition the schema exactly** — no knob in both, none in neither — so a new schema field cannot silently become unreachable.
- `src/usage-pill.tsx` — the meter's state: gating, polling, hover/click dismissal, retry. Renders `usage-panel.tsx`; all wording comes from `usage-ui.ts`.
- `src/usage-panel.tsx` — `UsageTrigger` (ring / Zen pill) and `UsagePanel` (breakdown, spend, Zen card, actions): pure presentational components, no hooks, so tests invoke them directly and walk the element tree.
- `src/usage-ui.ts` — dependency-free meter logic: geometry, action links, window/affinity helpers, `isZenProvider`, `describeUsage`, `parseFailure`, `ringGeometry`, and the stylesheet — exported so tests hit real logic.

### Why the card owns its boolean/list fields

The host UI kit ships **no** boolean control and no boolean/list/enum spec, so the card composes its controls from the primitives it does ship. Re-verified against `@deepseek-ai/dsh-client-ui-primitives` (`0.2.1-alpha.1`, source at `packages/client/ui-primitives/src`):

**Relied on from the platform:**

- `Switch` — the two-state toggle (`role="switch"`, `label` required, fully controlled). `settings-boolean-field.tsx` renders it, so the toggles in the card are the host's own control, not a look-alike.
- `Tag` — the "Overridden" badge.
- `Button` (`variant="ghost" size="sm"`) — the reset control, which buys the `--dsw-alias-button-*` tokens plus hover / focus-visible / disabled states that an inline-styled `<button>` did not have.
- `SettingsForm`, `SettingsFormModel`, `settingsTextField`, `settingsNumberField` — the form shell, the staging model, and the text/number draft specs.

**Ours, and why:**

- The field _frame_ (label + badge + reset + hint/message). `SettingsFieldProps` documents the shape, but `SettingsValueField` renders an `<input>` and its `fields.module.css` classes (`css.field`, `css.reset`, `css.hint`, `css.invalid`, …) are private to `ui-primitives`. `settings-field-shell.tsx` is therefore a structural clone in inline styles, mirroring `SettingsValueField`'s markup and its "an invalid draft replaces the hint" rule.
- The enum control — a native `<select>`. `SegmentedControl` is **not** a substitute: it is a `role="tab"` tablist whose every tab names the panel it controls, i.e. for switching modes (its only non-primitive use is `ui-settings-models`'s add-mode switch), not for editing a stored value. `Menu`/`MenuItemButton` is for actions (`ui-workspace`'s Fork/Rename/Archive/Pin). The platform's own settings pages use `SettingsValueField` for everything non-secret — and for a _stored enum_ the harness itself renders a **native `<select>`** (`ui-settings-models`'s `ProviderEditor` protocol picker), down to naming the empty option so a screen reader does not announce a choice with no identity. `settings-choice-field.tsx` mirrors that.

**Styling rule — use the host's tokens, never invent one.** The host's only variable family is `--dsw-*` (`--dsw-alias-label-*`, `--dsw-alias-state-*`, `--dsw-alias-border-l1…l4`, `--dsw-alias-bg-layer-*`, `--dsw-radius-*`). An invented name such as `--color-fg-subtle` resolves to nothing, so its hard-coded fallback renders instead and the control ignores the theme entirely — dark-theme greys inside a light theme. That is exactly how the enum control first shipped, reading as a bare OS dropdown in the middle of the design system. `fields.module.css` is the reference for the frame, and the metrics matter as much as the colours: a select sitting beside `SettingsValueField` rows must match `.input` (34px, `--dsw-alias-bg-layer-3`, 13px, `0.5px solid --dsw-alias-border-l4`), not a text field's own look. Tests in `settings-choice-field.test.tsx` and `settings-field-shell.test.tsx` assert `--dsw-alias-` is present and `--color-` absent, so it cannot silently regress.

- The list draft conversion — the platform ships no list spec, so `settings-fields.ts` supplies one.

`plugins.bundle.config` is rendered with `{ view }` only — the host-owned `form` (state + mutate) is passed to `plugins.item` and `plugins.row.config`, **not** to bundle config — so the card owns its scope and `SettingsFormModel` itself. If the host ever ships a boolean or enum field, delete the matching file here and render that instead.

Tests — 266 deterministic cases in 20 files; polling helper instead of sleeps; each file restores `globalThis.fetch`/env in `afterEach` (the hook must live in every file, not just the old monolith):

- Host behavior split by concern: `session` · `config` · `fetch-patch` · `lifecycle` · `manifest` · `usage` · `catalog` (23) · `session-cost` · `models-discovery`.
- Host units asserted directly, because every other module narrows through them: `guards` (12) · `config-values` (15) · `cordis-context` (11) · `debug` (5). Each case pins the shapes the unit must REJECT as well as the ones it accepts — an over-accepting guard mis-shapes a host object silently.
- Client: `settings-page` (21) card + register · `settings-field-shell` (6) row chrome · `settings-boolean-field` (3) toggle · `settings-choice-field` (6) enum · `usage-pill` (19) gating + copy/failure parsing · `usage-panel` (13) trigger + panel · `client-bundle` (4) bundle boundary.
- `test/test-helpers.ts` — shared fixtures: mock streams, capture fetch, predicates, `createMockContext`.
- `test/primitives-stub.tsx` — stand-in for the host UI kit; keep it behaviourally faithful to the real primitives (trimmed drafts, empty clears).

Supporting files:

- `scripts/name-client-bundle.ts` — renames `vp pack`'s `.cjs` output to `lib/client.js` (DSH loader requires `.js`).
- `vitest.e2e.config.ts` · `test/e2e/` — the opt-in end-to-end suite (`pnpm run test:e2e`), collected only by that config so `pnpm test` stays offline and deterministic. `opencode-live.e2e.ts` asserts the live `/models` enrichment and `/usage` payload shapes (the vendor changing either is the failure a stub cannot catch); `patched-fetch-headers.e2e.ts` proves the outgoing header set over a real socket. Both gated on `OPENCODE_E2E=1`, and each keyed block skips without its key — which is why the CI `e2e` job is green on fork PRs.
- `cordis.patch.yml` — default plugin row (`id: dsh-opencode-patch`); header comments are the headless-config reference.
- `scripts/check.ts` — CI/release gate: lib freshness, peer ranges, harness surface contracts, secret scan, consumer install+load, workflow guards, identity/title consistency, client budget. `scripts/publish-scoped.ts` — publishes/mirrors the scoped aliases with idempotent skip-if-exists guards.
- `.github/workflows/` — `ci.yml` (push/PR: check+test+build), `release.yml` (tag `v*.*.*`: verify, guard tag==version, OIDC `npm publish` of the primary + both scoped aliases, then verify every target is readable).
- `README.md` consumer docs · `CONTRIBUTING.md` dev conventions + release · `CHANGELOG.md` per-version record (release-please-owned; do not hand-edit).

## Commands & policies

```sh
pnpm install     # install dependencies
pnpm run build   # vp pack -> lib/index.mjs + lib/index.d.mts + lib/client.js
pnpm run check   # zero *errors* required; zero warnings is the goal (no debt)
pnpm run test    # 266 deterministic tests, fully green required
pnpm run test:e2e   # opt-in live gateway suite; no-op unless OPENCODE_E2E=1
```

- Host code needs a **restart**: the base bundle ships `hmr root: []` (config watches only) and a `link:` package resolves through `node_modules` (ignored), so the host never re-imports `lib/index.mjs` after boot — restart `dsh web` after every `pnpm run build`, or the profile runs the old module and `dsh-settings` serves a stale/absent config schema. `lib/client.js` is re-served per page load, so a browser refresh suffices for client-only changes.
- Release: conventional commits on `main` → release-please opens the version + `CHANGELOG.md` PR → merging it tags, and `release.yml` publishes via OIDC (primary + scoped aliases). Never hand-edit `CHANGELOG.md`.
- DSH Web profile wires the build: `~/.dsh/profiles/web/package.json` deps + `bundles` use `dsh-opencode-patch` (`link:../../../dev/dsh-opencode` only for local dev).
- Hygiene: never hardcode `ses_…`/keys in src/tests/git; `lib/` gitignored; `OPENCODE_SESSION_ID` env override only.
- **Client bundle budget**: `lib/client.js` must stay under 64 KiB (`scripts/check.ts`); it currently sits at ~58.5 KB with **~7 KB of headroom**, so the gate is no longer a live constraint — it went from 604 bytes to 7 KB the moment the config-only knobs stopped shipping their copy. Prefer platform primitives over hand-rolled controls (swapping our inline-styled reset `<button>` for the platform's `Button` atom _shrank_ the bundle by 160 bytes), and ask whether a knob belongs in the UI at all before writing copy for it. **Comments ship in the bundle** — long rationale belongs here, not in client modules. Empirically the bundler keeps comments from _imported_ modules but drops the entry's own (`settings-page.tsx`), so trimming that file reclaims nothing; measure with `wc -c lib/client.js` before and after.

## Key resolution: two methods, and which one wins

The plugin can learn a credential two ways, and both exist on purpose:

1. **Captured from a live request** (`patchFetch` → `extractApiKeyFromHeaders` → `recordCapturedApiKey`). This is the rotation-proof source: whatever the adapter actually sent is, by definition, the key that works. Stored three ways — by provider id, by **tier** (`go`/`zen`), and as the most recent.
2. **Resolved from declared configuration** (`discoverGoConfig` reading other rows' `apiKeyEnv`/`apiKey`/`headers`, then `ctx.get("credentials").resolve(ref)`, then `process.env[ref]`). This is the cold-start source: nothing is captured until a turn has actually gone out, so the first `/usage` poll of a fresh boot has only this.

Rules that keep the two from fighting:

- **The credential reference is never a row setting.** `effectiveGoKeyRef` reads the composition's `apiKeyEnv` and falls back to `OPENCODE_GO_API_KEY`. A `usageKeyEnv` knob used to exist and was removed: it duplicated the provider row's own `apiKeyEnv`, i.e. asked the user to re-state a decision they had already made in the place that owns it. The capture path makes that duplication unnecessary anyway. The schema is permissive, so a row that still sets it is ignored rather than rejected — but it does nothing.
- **The tier is derived from the key prefix first, then the URL, and only last the provider id** (`tierForRequest`). The prefix is intrinsic to the credential; the URL is observed; the provider id is _user-defined config_ and may be named anything — so it must never be the sole reason a lookup succeeds.
- **Every capture lookup falls back to the tier**, so a renamed provider route cannot hide a key that is already known to work.
- **A placeholder is never captured.** The DSH adapter emits `Bearer unused` / `undefined` / `null`; recording one would overwrite a working key and every later lookup would re-inject the dummy (`isPlaceholderApiKey`).
- The Go `/usage` endpoint **rejects Zen keys** (`oc_sk_…`), which is why the tier filter exists at all: never hand the Go endpoint whatever key happens to be newest.
- **Which source wins is the user's choice** (`keySource`), because there is no single correct answer: `auto` (composition → captured → credentials → any captured) suits most setups and is byte-for-byte the original precedence; `request` promotes both captured steps, for setups that rotate keys; `configured` demotes them, for pinned/CI setups. `KEY_SOURCE_ORDER` is the whole policy — a `Record<KeySourcePolicy, readonly KeySourceStep[]>`, so a new policy is one line and a new step is a type error. The policy reaches **both** consumers: `patchFetch`'s Authorization fallback and the meter's `resolveGoApiKey` (via `UsageOptions.keySource`).

## OpenCode endpoints (probed, not guessed)

**Zen serves four classes of model, and they fail differently.** Probe any model with a keyless POST — the response identifies its class:

| response | class | meaning |
| --- | --- | --- |
| `401 AuthError` "Missing API key." | **paid** | recognised, needs a key (`claude-*`, `gpt-*`, …) |
| `403 FreeTierError` "…can only be used from within OpenCode" | **free-tier gated** | needs the OpenCode identity — _what the plugin exists for_ |
| a real completion | **unmetered** | needs nothing at all (`space-bunny-free`) |
| `401 ModelError` "…is not supported" | unknown | not a model on that route |
| `500 Internal server error` | **wrong format** | served on the other endpoint (next section) |

`space-bunny-free` is the unmetered class: it returns a full `chat.completion` with **no key, no `x-opencode-client`, no User-Agent**, and it still succeeds with the whole header set injected. **Our header restoration is additive, not a gate**, so nothing has to special-case a model that needs no auth — verified both ways. Worth knowing though: `fetch-patch.ts` sets `Authorization` whenever the caller omitted it or sent a dummy (`Bearer unused`/`undefined`/`null`). On an unmetered model that is unnecessary — the call would have worked without it — but it is what rescues the adapter's placeholder for the gated class, so it stays.

**The free tier is split across TWO protocols, and the protocol is route-level.** `ModelProtocolUnsupported` (a vendor 400) means the request reached the gateway on an endpoint that does not serve that model. Probe each model with a keyless POST: the endpoint that _recognises_ it answers `403 FreeTierError` ("OpenCode's free tier can only be used from within OpenCode" — the rule the header restoration exists to satisfy), while the endpoint that does not answers `500 Internal server error`. Measured 2026-10-04 against `https://opencode.ai/zen/v1`:

| endpoint | models |
| --- | --- |
| `/chat/completions` (`openai-completions`) | fledge-alpha-free · ling-3.0-flash-fin-free · ling-3.1-flash-free · longcat-2.5-preview-free · **mimo-v2.6-flash-free** · nemotron-3-ultra-free · nemotron-3.5-lightning-free · **space-bunny-free** (unmetered) |
| `/responses` (`openai-responses`) | **muse-spark-1.3-contributor-free** — the only one |

Because `llm-pi-ai`'s `modelFields` is `{name, contextWindow, maxTokens, input, reasoningEfforts, compat}` — **no per-model `api`** — a route carries ONE protocol for all its models. Muse therefore **cannot** share the `opencode` route with the other free models: it needs its own route (`opencode-responses`, `api: openai-responses`) and that route must be listed in the plugin's `providers` or the free-tier headers never get injected and the 403 persists. The same applies to any future model that lands on `/responses`.

**Checked twice, because "surely a provider can mix formats" is the natural assumption.** It can mix _routes_ — `llm-pi-ai`'s `providers` is `z.dict(profile)`, so one row declares N routes each with its own `api`. That is what `opencode` + `opencode-responses` are: two routes on the SAME provider row, not a new provider. But a single _route_ cannot mix formats: `modelProfile = z.object({ id, ...modelFields })` and `modelOverride = z.object(modelFields)` both exclude `api`. OpenCode itself is under the same constraint — models.dev's `opencode` provider declares `npm: @ai-sdk/openai-compatible` + `api: https://opencode.ai/zen/v1` for all **116** models, and no model entry carries a format field. There is no per-model mechanism to copy; route-level is the only lever either side has.

**Keyless probing under-reports the error.** A keyless POST to the wrong format gives `500 Internal server error`; the same request with a real credential gives the true `400 ModelProtocolUnsupported`. Both point at the same endpoint, but do not read a `500` as "the model isn't there".

**How OpenCode itself does it** (read from `sst/opencode`'s `packages/opencode/src/provider/provider.ts`) — it is **one provider with a per-model endpoint**, which is the shape DSH lacks:

```ts
// one npm for the whole Zen provider…
npm: model.provider?.npm ?? provider.npm ?? "@ai-sdk/openai-compatible"
// …and the ENDPOINT is picked per model at the SDK-call layer:
if ("endpoint" in model.api) {                     // github-copilot loader
  if (model.api.endpoint === "responses" && sdk.responses) return sdk.responses(modelID)
  if (model.api.endpoint === "chat" && sdk.chat) return sdk.chat(modelID)
}
async getModel(sdk, modelID) { return sdk.responses(modelID) }   // openai / meta / xai: always Responses
```

So `createOpenAICompatible` exposes both `.chat()` and `.responses()`, and opencode chooses between them per model — keyed by `api.endpoint` or the provider's own loader. `cloudflareGatewayNpm` shows the same pattern for npm (model-id prefix → native SDK). **The protocol is a per-model decision there; in `llm-pi-ai` it is a per-route decision**, and that is the whole gap.

Consequence: the same `llm-pi-ai` row carrying `opencode` + `opencode-responses` is the closest DSH equivalent — two _routes_ on ONE provider row (`providers` is `z.dict(profile)`), not a second provider.

**The plugin declares that route itself, in its own layer.** `cordis.patch.yml` inserts a SECOND `@deepseek-ai/dsh-llm-pi-ai` row (`opencode-patch-responses`) carrying only the Responses route, so the user configures nothing and their own `llm-pi-ai` row is untouched. Two facts force this shape:

- **A patch replaces a row's whole `config`**; it does not merge. `vendor/include/src/index.ts`'s `applyEntryPatches` does `target[key] = value`. So the route cannot live on the profile's `llm-pi-ai` row and survive the profile's own `providers:` block, and the plugin's own row config is replaced if the profile names that row. Separate rows are the only composition that holds.
- **The plugin must CLAIM the route it declares.** `DEFAULT_PROVIDERS` therefore carries `opencode-responses`: an unclaimed route gets no session header, no origin headers and no key injection, and the request then fails 403 looking like a model problem. `test/config-values.test.ts` asserts every route the layer declares is claimed — that seam is otherwise silent.

**What is NOT possible, and why "one provider id, two formats" is not a thing here.** `llm.registerAdapter(providers, adapter)` throws `DUPLICATE_ADAPTER` for any route that already has one, so a plugin cannot take over `opencode` to dispatch per model. And nothing in `llm` carries a per-model protocol: `LlmModelInfo` is `{provider, id, name, description?, inputModalities?}`, `LlmModelDiscoveryRequest`'s `protocol` describes the _endpoint being interrogated_, and `modelFields` has no `api`. The format is a property of the route, full stop. Dispatch-per-model exists only inside OpenCode's own SDK layer (above) — precisely the layer `llm-pi-ai` does not expose.

### How the split is actually bridged: re-dispatch, not translation

`llm.stream` is a **waterfall** — `streamWithRegistration` calls `ctx.waterfall(this, 'llm/stream', options, () => this.adapterStream(options, prepared))`, and its doc says "`options.provider` selects the adapter". So a listener can take the call over (that is how `llm-replay` works: `ctx.on('llm/stream', (options, _next) => replay(options))`).

Note the fallback **closes over the original `options`** (`() => this.adapterStream(options, prepared)`), so `next(modifiedOptions)` would NOT reach the adapter — the only lever is to skip `next()` and dispatch again yourself:

```ts
const redirect = responsesRouteFor(providerKey, options.model);
if (redirect !== undefined)
  return ctx.llm.stream({ ...options, provider: redirect });
```

`stream-hook.ts` does exactly this; `responses-routes.ts` holds the table. The redirected call re-enters the same hook with the target route already set, so `responsesRouteFor` is **guarded on the source route** — without that it recurses until the stack runs out. Returning immediately also keeps the session/debug/turn-state work to exactly one pass (the redirected call's own).

This is the shape to reach for: **re-dispatch to a route whose `api` already names the format**, so DSH's own adapter speaks it and nothing about the response is rewritten. A transport-level protocol bridge (rewriting `/chat/completions` → `/responses` and translating the SSE back) was the alternative and is strictly worse — the response side cannot be verified without a live credential, so every fixture would be a guess.

**A second `llm-pi-ai` ROW does not work — `DUPLICATE_FLOW`.** The tempting way to make the plugin own the route is to insert a second row of the same package in this layer. It fails: `apply()` in `llm-pi-ai` calls `ctx.inject(['authorization'], (authorized) => registerPiAiFlows(authorized, auth))`, and `registerPiAiFlows` loops over `catalogProviderIds()` — the **installed** catalog, identical for both instances — calling `authorization.registerFlow({ key: recordKeyFor(providerId), … })` for each. That service throws:

```ts
if (this.flows.has(flow.key)) {
  throw new AuthorizationError(
    `an authorization flow for "${flow.key}" is already registered`,
    "DUPLICATE_FLOW"
  );
}
```

Its own API docs state the rule: "One flow per key: two plugins claiming the same key would each write a record in their own format." Everything else about a second instance is fine — `settingsNs = ctx.fiber.entry?.options.id ?? NS` namespaces it by ROW ID, so the routes and settings do not collide — but the auth flows do, and they are registered unconditionally.

**So the plugin registers the route itself** (`responses-provider.ts`) — **but it cannot activate, and this is the honest state.** Two blockers, both measured against the installed copy:

1. **The package is not resolvable from the plugin's location.** The plugin is symlinked into the profile but lives in this repo, and Node resolves from the real path, so `import('@deepseek-ai/dsh-llm-pi-ai')` raises `ERR_MODULE_NOT_FOUND`. Declaring it as a dependency fixes this one.
2. **`resolveProfiles` is unreachable even then.** The published package ships only `lib/` (no `src/`), so the `"./src/*"` exports entry names a path that does not exist in an installed copy; and the root export list is `Config, PiAiAdapter, apply, inject, name, recordKeyFor, supportedProtocols` — no resolver. `PiAiAdapter`'s `profiles()` needs a `ResolvedPiAiProviderProfile`, and hand-building one means reproducing the resolver's defaults, which is the duplication this design exists to avoid.

So the code is the right shape and stays, self-healing the day `resolveProfiles` is exported from the package root. **Until then it registers nothing**, logs why, and the route must be declared in the profile — **do not remove it from a profile on the assumption that the plugin owns it.**

When it does activate, two behaviours matter: the route's model list is read from the catalog's `provider_npm`, so it covers **every** Responses model rather than the one a hand-written list named; and registration **defers** per route when the profile already declares it, so a deployment that hand-declares one keeps its own model list. It never throws.

**`opencode-responses` names no `apiKeyEnv` — but a keyless route ALONE throws.** This is a trap: `provider.ts` says a route naming no credential is "deliberately unauthenticated", which reads as "it will just send no key". It does not. pi-ai's implementations resolve the key like this (`dist/api/openai-responses.js`):

```js
function getClientApiKey(provider, apiKey, headers) {
  if (apiKey) return apiKey;
  if (
    hasHeader(headers, "authorization") ||
    hasHeader(headers, "cf-aig-authorization")
  )
    return "unused";
  throw new Error(`No API key for provider: ${provider}`); // ← before fetch
}
```

The `headers` here are the **route's own** `headers` config, not the outgoing request's — and the throw happens **before `fetch`**, so `patchFetch` never gets a chance to inject anything. The route must therefore declare the sentinel:

```yaml
headers:
  authorization: Bearer unused
```

`createClient` merges the route's headers **last** (`Object.assign(headers, optionsHeaders)` — "so they can override defaults"), so the value must be the literal `Bearer unused`, not `unused`: whatever the SDK would have sent, this is what goes out. `fetch-patch.ts` then swaps that sentinel for the credential it captured from `opencode` — a path that is unit-tested in `fetch-patch.test.ts` — so the key stays configured exactly once. (`hasHeader` is case-insensitive and ignores empty values.)

The alternative is `apiKeyEnv: OPENCODE_API_KEY` on both routes. It is more robust — no sentinel, no dependence on `patchFetch` — and it is _not_ the same secret twice: both routes name one ref, so the credentials service still holds one record and the Models page shows one entry. Choose it if the sentinel path ever proves fragile.

Two things that would be nicer, and are **not possible** — checked so nobody retries them:

- **A custom `api` id that dispatches per model.** pi-ai has exactly this machinery: `stream(model)` dispatches on `model.api` through `getApiProvider(api)`, and `registerApiProvider({api, stream, streamSimple}, sourceId)` adds implementations. But `llm-pi-ai`'s `supportedProtocols()` is `Object.keys(PROTOCOLS)` — a hardcoded table — so a route naming any other protocol is rejected by the config schema.
- **Taking over the `opencode` route's adapter.** `llm.registerAdapter` throws `DUPLICATE_ADAPTER` for a route that already has one.

**Keeping the internal route out of every listing a user sees — two patches, not three.** DSH has **no "internal provider" concept**: a route registered with the LLM service is surfaced by every listing, with no flag to mark it hidden. Two listings enumerate providers, and the route must be absent from both:

- `buildModelCatalog` (`packages/api/session-controller/src/catalog.ts`) turns every registered route into a group and drops the groups whose model list is empty.
- `joinProviderDirectory` (`packages/client/ui-settings-models/src/client/store.ts`) maps `listConfigurableProviders`, then pushes a row for **every remaining registered provider**:

  ```ts
  const rows = directory.map(…)
  for (const provider of registered) {
    if (declared.has(provider.id)) continue
    rows.push({ provider: provider.id, displayName: provider.name, settingsNs: '', active: true })
  }
  ```

  So filtering only the configurable directory leaves the route on screen — **`listProviders` is the one that matters**.

- `modelAvailable` resolves through the same registry.

`hideResponsesRoute` (`models-discovery.ts`) therefore patches exactly those two, inside the fiber effect so unloading restores both. **`listModels` is deliberately NOT patched**: every Host consumer of it iterates `listProviders()` first — `buildModelCatalog` (`session-controller/src/catalog.ts:27`), `modelAvailable` (`:83`, after a `listProviders().some(…)` check) and `acp`'s model control (`model-control.ts:158`) — so once the registry omits the route, nothing reaches its model list. Patching it too would be a third wrapper guarding nothing.

**The catch: the redirect must not read the filtered listing.** `isResponsesRouteRegistered()` reads the ORIGINAL `listProviders`, captured at install. Asking the patched method would always answer "no" and the re-dispatch would never fire. `stream-hook.ts` uses that helper, not `ctx.llm.listProviders`.

Nothing in dispatch reads either method: the adapter registry resolves a route internally, so hiding it from the UI cannot break serving it. The one alternative needing fewer patches — the plugin registering its own adapter via `llm.registerAdapter` — means implementing the Responses protocol client ourselves, which is the untestable work this design exists to avoid.

```ts
const providers = ctx.llm.listProviders()
const models = await ctx.llm.listModels(provider.id)
const groups = catalog.flatMap(…).filter(group => group.models.length > 0)
```

`routableProviders` is derived _from_ the groups, not a filter over them, so the empty-group rule is the only lever on that surface — but it is not the only surface. Hiding is deliberately **not** behind `enrichModels`: it is what makes the re-dispatch read as a single provider, not a catalog preference.

Two seams the tests pin, both silent failures otherwise: the redirect target must be claimed by the layer (`responses-routes.test.ts`), and the redirect must consult the **unfiltered** registry (`lifecycle.test.ts` — a test whose `effect` is a no-op would silently stop covering it).

**Where the split comes from — the vendor's per-model SDK, not a list.** models.dev names `provider.npm` **only as an override** of the provider's default, so its PRESENCE is the signal. `opencode`'s provider-level value is `@ai-sdk/openai-compatible`; measured 2026-10-05 across its 116 models: 53 name nothing (the default), **32 name `@ai-sdk/openai`**, 23 name `@ai-sdk/anthropic`, 8 name `@ai-sdk/google`. `@ai-sdk/openai` is the OpenAI SDK proper, which speaks the Responses API — the same mapping OpenCode's own adapter applies. So `responsesRouteFor(provider, model, providerNpm)` reads `PROTOCOL_FOR_SDK`, and the catalog carries `provider_npm` on each spec (`extractSpecs`), read back through `findModelSpec`.

The hand-written list this replaced named ONE model — `muse-spark-1.3-contributor-free` — and **31 more were already on the wrong side of it**. `gpt-5`, `gpt-5.1`, `gpt-5-codex` and the rest of the `@ai-sdk/openai` set would have been dispatched to the completions route and failed.

**Two things this does NOT solve.** `@ai-sdk/anthropic` (23 models) and `@ai-sdk/google` (8) map to no route we declare, so they still go to completions and fail — deliberately: `supportedProtocols()` is `openai-completions`, `openai-responses` and `anthropic-messages`, and guessing a target would be worse than the honest failure. And the redirect is not bounded by what `opencode-responses` actually lists: a second `@ai-sdk/openai` model added to the `opencode` route would redirect to a route that does not serve it and fail as "model not found". Add it to both routes when you add one.

**The bundled shim must carry `provider_npm` too.** It answers before the first live refresh, so a cold start with the field missing would dispatch muse to the completions route — with nothing pointing at the cause. `responses-routes.test.ts` pins it.

Two planes on one host: **Zen** `https://opencode.ai/zen/v1` (pay-as-you-go + free tier) and **Go** `https://opencode.ai/zen/go/v1` (subscription). `toGoBaseURL` rewrites a Zen base into a Go one because they share a host.

What exists: `GET {base}/models` (both planes; **200 even with a bogus key**, so it is not auth-gated), `GET {go}/usage`, `POST {base}/chat/completions`, `POST {zen}/v1/messages`, and the free-tier `…/responses` path the tool fallback targets.

What does **not** exist: `balance`, `credits`, `billing`, `account`, `me`, `key`, `limits`, `plan`, `subscription` — all 404 under both planes, while `/models` returns 200 on the same key, so those are real absences rather than an auth problem. **There is no credit endpoint and no dedicated overage endpoint.**

`GET {go}/usage` returns `{ usage: { rolling, weekly, monthly } }` (or unwrapped), each window exactly `{ status: "ok" | "rate-limited", percent: 0–100, resetsAt: ISO }` — percentages only, no currency, and **no hourly window**: `rolling` is the short one. Request headers: `Authorization: Bearer <go key>`, `Accept: application/json`, `User-Agent: opencode/1.18.33 dsh-opencode-patch`, `x-opencode-client: cli`, `x-opencode-project: global`, 10 s timeout, `redirect: error`, 1 MiB cap.

Overage is **inferred, never queried**: a `403` carrying `EntitlementError` plus a configured Zen key yields `zenOverflowUsage()` (`zenOverflow: true`, all windows 0%). `resolveZenCreditInfo` therefore answers "can Go overflow into Zen credit?", not "how much is left" — it makes no HTTP call, because there is nothing to call. No balance number is possible either: the monthly cap is per _model_ ($15/$30/$60 Go, $60–$240 Go Plus) while usage accrues _across_ models, so a dollar figure cannot be derived from a percentage. The console is the only place it shows.
