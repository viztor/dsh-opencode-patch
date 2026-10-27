# Improvement plan

## Context

The result of an architecture audit of the tree at 1.4.1, and the order in which to act on it. It rests on:

- six audits: routing, catalog, credentials, config/UI, tests/CI/docs, and the stream path;
- an adversarial review of the plan itself, then a nine-lens review (five reviewers, four investigators) in which two independent skeptics checked every finding: 78 of 82 were upheld and are folded in here;
- the host's own source and data (`deepseek-ai/deepseek-harness`, and the pi 1.1.0 catalog it pins). File references into the host are relative to that repository's `packages/`.

**Outcome:** a plugin that only uses host extension points the host supports; one source of truth per decision; a suite that pins behaviour before it moves; and the owner's product rules below.

**Each phase is one pull request**, and it updates this document: its row below moves to "merged", and its section is trimmed to what is left. A finding that does not survive its phase's first failing test is struck from here rather than forced.

## Status

Phases land as **stacked pull requests**. Each one is based on the previous phase's branch, and the first stacks on P0. Every phase is a 1.x release: there is no major (D6).

| Phase | Title                                         | State     |
| :---- | :-------------------------------------------- | :-------- |
| P0    | suite hardening, 12 defect fixes, this plan   | in review |
| P1a   | `fix:` shipped breakage                       | in review |
| P1b   | `chore:` hygiene                              | planned   |
| P2    | `feat:` a smaller public API                  | planned   |
| P-T1a | `build:` pin the host                         | planned   |
| P-T1b | `test:` a harness that is the real host       | planned   |
| P-H   | `refactor:` one way to patch a host method    | planned   |
| P-R1  | `feat:` the plugin owns the plane routes      | planned   |
| P-R2  | `fix:` the endpoint family, measured          | planned   |
| P3    | `feat:` Settings complements pi's list        | planned   |
| P-T2  | `test:` suite structure                       | planned   |
| P-T3  | `ci:` CI and scripts                          | planned   |
| P5    | `refactor:` installers                        | planned   |
| P6    | `refactor:` the fetch patch's credential fill | planned   |
| P7    | `refactor:` one source per table              | planned   |
| P8    | `refactor:` settings table                    | planned   |
| P9    | `refactor:` remote seam                       | planned   |
| P10a  | `refactor:` pure module moves                 | planned   |
| P10b  | `fix:` catalog state                          | planned   |
| P11   | `refactor:` UI on the primitives              | planned   |
| P12   | `ci:` lint warnings gating                    | planned   |

## Owner decisions

| # | Decision |
| :-- | :-- |
| D1 | A model whose reasoning is only on/off is offered as **Off / On**. Old saved Minimal/Xhigh/Max selections on such models break, and the release notes say so. It lands in P-R1, with the catalog-first precedence (D17). |
| D2 | Delete `internalRoutes`. |
| D3 | **The composer shows the user's declared models.** An absent or empty `models` list serves the plugin's servable, non-deprecated catalog for that plane. A plane with no entry at all is not registered. **Settings offers the whole catalog.** |
| D4 | Delete `resolveRoutedKey`. It was exported in dde9d6e and nothing in `src/` has ever called it. |
| D5 | **Serve every mode on the user's own route ids, with no hidden routes.** |
| D6 | **Shrink the public API in a 1.x minor.** There is no 2.0.0: nobody consumes the API. Titles are `feat:`, `fix:`, `refactor:` and so on, with no `!` and no `BREAKING CHANGE` footer. Behaviour changes are named in each PR body and in the README's "Changed in 1.x" notes. |
| D7 | Stacked pull requests: one phase per branch, each based on the previous one. |
| D8 | **The plugin never writes the user's profile on its own, and never overrides the user's configuration at dispatch.** The only write is the card's explicit purge action, which goes through `configEditor`. |
| D9 | Stop publishing `@viztor/dsh-opencode` in P2. The deprecation message already published ("Renamed to …") stays as the final one. |
| D10 | This document is the plan of record. Each phase PR updates its status row. |
| D11 | The adapter patch existed to merge modes. Once the plugin's provider serves every mode per model (D13), the merge is native and the patch is deleted. |
| D12 | **No upstream changes.** Everything is done inside the current host with the APIs it has. |
| D13 | **The plugin owns the `opencode`/`opencode-go` routes.** pi-ai is kept from claiming them through the config waterfall, and the plugin registers its own adapter under the same ids (F11–F14, run S0). It never deletes another plugin's registration, which the host forbids. |
| D14 | **Target pi 1.1.0, the version the harness pins.** Installs of the published host resolve `^1.1.0` to the newest 1.x (1.4.0 today), so CI runs both. |
| D15 | **Any model id saved on `opencode`/`opencode-go` is accepted and served**, including ids neither pi nor the live catalog knows. |
| D16 | **The protocol comes from the catalog, never from a guess at the model's name.** The order is: the catalog's SDK through `PROTOCOL_FOR_SDK`, then pi's own catalog entry, then the user's route-level `api`, then `openai-completions`. `protocolFromModelId` is deleted. |
| D17 | **Precedence is catalog first.** Metadata and reasoning levels come from the user's model row, then pi-ai's route-level `modelOverrides`, then the catalog, then pi, then the defaults. |
| D18 | **Settings keeps showing the planes.** One read-only wrapper on `settings.describe` puts the plane entries back into pi-ai's displayed value (F20). The user's config is never written: the Models page writes only through `settings.mutate` path edits (`client/ui-settings-models/src/client/operations.ts:87`). |
| D19 | **Plugin settings.** Delete `modelOverrides`, `maxContextWindow`, `modelRoutes` and `internalRoutes`, and the README's nonexistent `hiddenModels`. Keep `endpoint` (`legacy` or `modern`, with `auto` an alias of `modern`). Keep `providers`, redefined as the route ids whose turns the plugin decorates, with both planes always included. |
| D20 | **The plane adapter resolves keys by pi-ai's rule.** A named ref resolves through the credentials service, then the launch environment, then fails with `MISSING_CREDENTIAL` and sends no request. With no ref, pi's ambient key applies, plus the `readOpencodeStore` opt-in. Captured and literal keys never feed the adapter; they stay in the fetch patch's fill for an empty or placeholder wire key. |
| D21 | The keyless paid-model filter on listings is dropped (D3, D8). Without a key, dispatch fails loudly. |
| D22 | The `@deepseek-ai/*` dev dependencies move to the version the published `dsh` resolves (0.2.1-rc.2). It is named once, in `test/support/host-versions.ts`. |

## What the host supports (read from source)

- **Routes.**
  - `registerAdapter` is all-or-nothing against a `private adapters` map (`llm/src/index.ts:399-460`). Only a registration's owner moves its routes, through `handle.replace`.
  - `adapter-replacement.ts` deletes another plugin's entry, which is unsupported. Delete it.
- **Dispatch.**
  - The `llm/stream` waterfall allows a short-circuit (`index.ts:62-75`). `next()` takes no arguments, and loop requests are frozen.
  - Today's redirect, `llm.stream({ ...options, provider: hiddenRoute })` (`src/stream-hook.ts:251-266`), is supported but needs a registered hidden route. A route the plugin owns (F6, D13) keeps `adapterStream`'s validation, projection, replay filtering and failure normalization (`index.ts:1064-1150`) **without** one, so the redirect goes in P-R1.
- **Effort validation goes through the ADAPTER, not the public `resolveModelInfo`.**
  - The paths are `resolveCallConfig` → `resolveModelInfoFor` → `adapter.resolveModel`, `adapter.prepareCall`, and pi's private `modelOf` (`index.ts:769,894-905,964,1076`; `llm-pi-ai/src/adapter.ts:369-375`).
  - Today the adapter patch merges modes only for Go→Gemini, and through a hidden route (`models-discovery.ts:735-760`). Its catalog fill of context and levels for same-mode models (`:790-1010`) decorates the picker while dispatch validates against a different profile. Once the plugin owns the route (D13), one adapter answers both, in D17's order: the user's row, then the catalog, then pi.
- **Hiding.**
  - There is no visibility flag (`LlmProviderInfo = {id, name}`).
  - `listProviders()` is read by:
    - the composer (`session-controller/src/catalog.ts:24`) and `modelAvailable` (`:81`);
    - the Settings directory (`ui-settings-models/src/client/store.ts:233`);
    - the subagent tool (`tool-subagent/src/list-models.ts:20,50`);
    - ACP (`acp/acp/src/model-control.ts:158`);
    - the SDK server (`sdk/server/src/server.ts:423`);
    - the translator (`experimental/translator/src/deepseek.ts:69`).
  - With no hidden routes (P-R1), **no listing patch is needed**; today's exists only to hide them from these readers. (Instance patches do reach Remote calls, because the gateway resolves methods with `Reflect.get` at call time — `api/gateway/src/index.ts:841-843` — which the `discoverModels` wrapper relies on.)
- **Settings discovery is keyed by the pi-ai entry id** (`llm-pi-ai/src/index.ts:138,156`; `ProviderEditor.tsx:254`; `ModelListEditor.tsx:167,244`). The plugin's own `registerModelDiscovery` namespaces are never asked.
  - The host's normalization runs inside the original `discoverModels` (`index.ts:618-631`), so the wrapper must dedupe and whitelist the fields itself.
  - `LlmDiscoveredModel` carries only id, name, contextWindow, maxTokens and inputModalities, with no reasoning field.
- **D1 representation.** Effort ids must be pi levels (`adapter.ts:170-181`), and two vocabularies mean opposite things by `null`:
  - pi `thinkingLevelMap`: `{ minimal: null, low: null, medium: null, high: "high" }`, with **no `off` key**. `off: null` hides Off and suppresses the explicit disable (`openai-completions.js:674,690,712`; `anthropic-messages.js:917`).
  - profile `reasoningEfforts` dict: `{ off: null, high: "high" }`. Here null means "offered, send nothing" (`llm-pi-ai/src/catalog.ts:705-712`).
  - Picker: `{ efforts: [{ id: "off", name: "Off" }, { id: "high", name: "On" }] }`.
  - Offer Off only where the protocol can disable reasoning (`adapter.ts:184-196`).
  - Verify that `"high"` is what each protocol sends for "on" before relying on it. Today `"on"` goes out verbatim (`openai-completions.js:718`, `anthropic-messages.js:733-735`).

## Defects found in this audit, not yet fixed (all verified in code)

| Defect | Where |
| :-- | :-- |
| The deprecated wrapper re-exports a `default` that does not exist, an ESM link error. It is published every release. | `scripts/publish-scoped.ts:137`, `release.yml:124` |
| Settings shows pi's snapshot, not the catalog | `models-discovery.ts:142-198,532-539` |
| Mode merging is done only for Go→Gemini. For the other modes the picker shows catalog levels while dispatch validates against a different profile: toggle models show Minimal…Max with no Off, and Go `minimax-m3` + Xhigh/Max is refused on the internal Anthropic route. | `models-discovery.ts:607-616,735-760,1063-1203`; `pi-provider.ts:351-386`; `responses-provider.ts:111-150` |
| `isZenProvider("opencode-google")` is false | `utils/request-shape.ts:265-271` |
| `enrichModelsResponse` turns a 401/403/5xx into a 200 catalog. It must still fill the Go plane's 404. | `models-catalog.ts:800-804` |
| The warning token doesn't exist, so warnings render as caption text. The host's text token is `--dsw-alias-state-warn-label`. | `settings-card.tsx:159`, `settings-store-inspect.tsx:250` |
| The Settings spinner animates only if the meter is mounted | `settings-usage.tsx:248` → `usage-ui.ts:440` |
| The stream hook writes `debugFile` with `debug` off | `stream-hook.ts:327-340` vs `lifecycle.ts:361` |
| `settings-purge` reports `{ ok: false }` as "not a purge result" and casts instead of using the parser | `settings-purge.ts:47-55` |
| The stream hook's `prepared` handling is dead. The host never reads `options.prepared`. | `stream-hook.ts:44,200-203,258` |
| The partition test misses `debugFile` | `test/settings-page.test.tsx:1223` |
| `cordis.patch.yml`: phantom `showUsagePrice`, wrong `freeModelMarker: ''` text, incomplete field lists | `cordis.patch.yml:23,36,61` |
| `utils/retry.ts` uses `console` and global timers, against the purity gate | `utils/retry.ts:31,55` |
| `tool-fallback`: the Anthropic branch can't be reached, and the lookup is Go-first | `tool-fallback.ts:204,237-242` |
| Hard-coded catalog counts in tests, which the nightly refresh PR breaks by construction | `test/catalog.test.ts:94,200,208` |
| `.freebuff/project-id` is tracked | repo root |

## Routing: the problem, the measured facts, the design

**The problem, in the owner's words.** A provider defines one backend. Supporting every protocol and the newer catalog meant un-registering the original `opencode`/`opencode-go` provider and registering the plugin's own. Deleting another plugin's registration is unsupported, so the plugin mounted extra routes per protocol instead, merged their models back into the user's provider, and redirected dispatch. This section shows that the host **does** allow the original intent, through supported paths (F11–F13): keep pi-ai from claiming the two ids, and register the plugin's provider under them. A spike on the real host confirmed it (run S0).

**Facts from the host's own code and data.** F1–F5 and F10 are measured: the data files were counted and the resolver read. F6–F9 and F11–F13 are read from the code, and run S0 exercised F11–F13 end to end. P-T1's real-host harness pins them all, and a fact that fails there sends the design back to this section.

| # | Fact | Evidence |
| :-- | :-- | :-- |
| F1 | **One route already serves every mode, per model.** llm-pi-ai resolves `api` and `baseUrl` per model: `request.api ?? base?.api ?? routeApi` and `request.baseURL ?? base?.baseUrl ?? providerBaseUrl`, where `base` is pi's installed catalog entry. | `llm-pi-ai/src/catalog.ts:917-922` |
| F2 | **pi's installed `opencode` catalog spans four protocols, each with its own endpoint.** In pi 1.1.0, which the host pins and patches: Zen has 18 anthropic-messages (`/zen`) and 7 google, 28 completions and 30 responses (`/zen/v1`). Go has 5 anthropic (`/zen/go`) and 19 completions and 6 responses (`/zen/go/v1`), and **no google**. | `@earendil-works/pi-ai@1.1.0` `dist/providers/data/opencode*.json`; the harness's `pnpm-lock.yaml:13` |
| F3 | **A model pi's catalog does not know cannot get its own protocol.** A profile entry has no `api`/`baseURL` field (`PiAiModelProfile`); it takes the route's `api`, or `sharedCatalogApi`, which is undefined for a multi-protocol catalog. | `llm-pi-ai/src/catalog.ts:600-640,681-691,917-921` |
| F4 | **Such a model cannot be saved, listed or dispatched on a pi-ai route.** Writes are validated strictly (`assertServiceable`), so the save is rejected with "needs an api". Stored reads are deferred, so the id lands in `modelErrors`. `listModels` lists only resolved models, and `modelOf` throws `INVALID_CONFIG`. | `llm-pi-ai/src/config.ts:357-368,487`; `index.ts:171`; `adapter.ts:271-311` |
| F5 | **A route-level `api` or `baseURL` overrides every model**, collapsing the modes onto one protocol or endpoint. | `llm-pi-ai/src/catalog.ts:917,922` |
| F6 | **Dispatch reads the route's adapter.** `selectModel`, `prepareCall` and `llm.stream` all go through `registration.adapter.resolveModel`/`prepareCall`. The host requires only that the prepared model's `provider` equals the route id, and then dispatches through `adapterCall.stream`, with validation, projection, replay filtering and failure normalization intact. | `llm/src/index.ts:774-793,894-905,956-964,1064-1150` |
| F7 | **`registerAdapter` is all-or-nothing against a private map**, and only a registration's owner moves its routes (`handle.replace`). A route nobody holds is free to register. | `llm/src/index.ts:399-460` |
| F8 | **Config resolution is a public, synchronous waterfall.** Cordis runs `internal/config` listeners in order, each getting `(config, next)`; `prepend: true` puts a listener outside those registered before it. pi-ai's save check (`assertServiceable`) is one listener on it. | the harness's `vendor/cordis/src/events.ts:234-258`; `llm-pi-ai/src/index.ts:177-186` |
| F9 | **opencode's own client serves four protocols from one provider, per model.** It picks the SDK from `model.provider.npm` and the endpoint from `model.provider.api ?? provider.api`, both from the catalog. The plugin's catalog carries the same data (`catalog-data.ts` `OPENCODE_FAMILY_API`, a per-model SDK). | opencode's `packages/core/src/models-dev.ts:85-93` |
| F10 | **pi 1.1.0's `opencode-go` provider has no Google API.** Its api map is anthropic-messages, openai-completions and openai-responses only, each wrapped in `withOpenCodeSessionHeader`. pi exports each protocol separately (`api/*.lazy`: `anthropicMessagesApi`, `openAICompletionsApi`, `openAIResponsesApi`, `googleGenerativeAIApi`) plus `createProvider` (`models`), which is what `google-bridge.ts` `googleProviderFor` already composes from. | pi 1.1.0 `dist/providers/opencode-go.js`; its `package.json` `exports` |
| F11 | **pi-ai's routes are exactly the keys of its _resolved_ config.** It registers `[...profiles().keys()]`, and `profiles()` reads `config.providers.get()`, the value the fiber resolved. | `llm-pi-ai/src/index.ts:166-175,293-312` |
| F12 | **Every path to that resolved value goes through the `internal/config` waterfall, and the fiber keeps the waterfall's _return value_.** That covers the first load, `fiber.update`, the loader's volatile commit, and the config editor's validation. **The config editor writes the raw `next` to `cordis.patch.yml`, never the resolved value.** So an outermost listener that returns a copy without `providers.opencode`/`providers["opencode-go"]` keeps pi-ai from seeing or registering them, while the user's file keeps every entry. | the harness's `vendor/cordis/src/fiber.ts:641-643,736-752` and `vendor/loader/src/config/entry.ts:164-195`; `boot/config-editor/src/index.ts:101-123` |
| F13 | **The plugin can then register those ids through the public API.** With no pi-ai entry for them, `registerAdapter(["opencode", "opencode-go"], adapter)` passes the duplicate check. `PiAiAdapter` is a **public export** of `@deepseek-ai/dsh-llm-pi-ai`. pi-ai's Settings directory keeps listing both ids, because it lists every installed catalog provider regardless of profiles, with `settingsNs` = pi-ai and `settingsPath = ["providers", id]`. So Settings edits the same entries in the same file as today. | `llm/src/index.ts:399-460`; `llm-pi-ai/src/index.ts:77,128-150` |
| F14 | **A commit and a validation are told apart by identity.** The config editor runs the waterfall on a fresh candidate only to validate it, and can still reject the edit after that run. Every commit path passes the object stored in `fiber._config`, so `raw === this._config` holds for a commit and for nothing else. | `boot/config-editor/src/index.ts:101-148`; the harness's `vendor/cordis/src/fiber.ts:229,655,738,747` and `vendor/loader/src/config/entry.ts:149,171` |
| F15 | **An edit that changes only a plane entry emits nothing.** It raises no `loader/volatile-update` and does not restart pi-ai. The listener's commit run is the only signal it happened. | the harness's `vendor/loader/src/config/entry.ts:177-187` |
| F16 | **The outermost listener sees un-interpolated `{__jsExpr}` nodes.** The loader interpolates only the value `next()` returns. | the harness's `vendor/loader/src/index.ts:104-113` |
| F17 | **Ordering must be explicit.** `restart()` is swallowed while a fiber is loading or unloading, loader rows load in parallel, and cordis disposes effects concurrently. | the harness's `vendor/cordis/src/fiber.ts:625-639,665-686` and `vendor/loader/src/config/group.ts:56` |
| F18 | **`PiAiAdapter.listModels` answers `[]` on `MISSING_CREDENTIAL`.** | `llm-pi-ai/src/adapter.ts:295-311` |
| F19 | **`PiAiAdapterOptions.auth` is required.** pi-ai does not export its credential-store or auth-context builders; it does export `PiAiAdapter`, `Config` and `recordKeyFor`. | `llm-pi-ai/src/adapter.ts:98-106`; `index.ts:77-92` |
| F20 | **The Settings page reads pi-ai's resolved config.** `describe()` builds `value` from `fiber.config`, so once the claim strips the planes they read as unconfigured. The gateway resolves service methods per call (`Reflect.get`), so an instance wrapper on `describe` is seen by `settingsController.describe` and by `write()`. | `settings/settings/src/index.ts:319`; `api/gateway/src/index.ts:841-843`; `api/settings-controller/src/index.ts:98-103,217` |

Three corrections to the facts above:

- **F12, the mechanism.** Cordis passes listener arguments unwrapped (the harness's `vendor/cordis/src/utils.ts:118-125`). The first prototype's in-place trim failed because the fiber keeps the waterfall's return value, not because of a proxy.
- **F13, the read view.** Settings writes the same file, but its read view (`describe().value`) loses the plane entries. The plugin grafts them back (D18, F20).
- **Run S0's other routes.** `deepseek-official` and `deepseek-account` belong to the `llm-deepseek-*` plugins, not to pi-ai.

**What the plugin has to add, and nothing else:**

- **G1:** serve any declared model the host's pi cannot resolve (D15). That means models newer than pi 1.1.0's catalog (8 Zen and 4 Go, including every Gemini model on Go, F10), **and** ids the catalog doesn't know at all.
- **G2:** the endpoint family. pi 1.1.0 stores the legacy bases; the plugin sends the per-protocol `inference` bases, or the legacy ones when the `endpoint` setting says so.
- **G3:** a profile-level `api`/`baseURL` (F5). It is the user's explicit choice and is honoured as one (D8), without collapsing the modes.

### The design: the plugin owns the plane routes (D13)

#### `src/host/route-claim.ts`: pi-ai never claims the planes

- **Where the listener lives.** The plugin root declares `inject: []`; today it is `["llm"]`. The `internal/config` listener (`prepend: true`) and the stream and fetch hooks live on the root, and everything that needs `llm` runs inside `ctx.inject(["llm"], scope => …)`.
  - pi-ai is identified by `this.runtime?.name === "llm-pi-ai"`, never by `this.name`, which pi-ai's inject children inherit.
  - Its fibers are found through `ctx.registry` runtimes.
- **What the listener does.** It is a pure filter and never mutates its input:
  1. It strips the two plane keys from a fresh copy.
  2. It runs the nested waterfall on the copy and returns that result.
  3. On a commit (`raw === this._config`, F14), it schedules `reconcile` with `queueMicrotask`.
  4. On an editor candidate, it strictly validates the plane entries that changed. A malformed save is rejected in pi-ai's message style.

  It never throws on a commit run, because a throw there would fail pi-ai's fiber and every route it holds.

- **What `reconcile` does.** It reads the committed plane entries from `piFiber._config.providers`, memoized by object identity plus a JSON comparison. Then:
  1. It interpolates `{__jsExpr}` nodes with the loader's exported `interpolate` (F16). Without a loader, a node left over becomes a per-model `INVALID_CONFIG`.
  2. It normalizes the entries with pi-ai's exported `Config`, and builds the profiles.
  3. It reconciles the route set:
     - with no handle and at least one plane, it calls `registerAdapter(routes)`;
     - with a handle whose route set, `displayName` or `retryPolicy` changed, it calls `handle.replace(routes)`. `replace([])` is legal; `registerAdapter([])` is not.

  Only the planes the user declared are registered. `reconcile` also runs on a global `llm/adapters-updated`, and on `loader/partial-dispose` for pi-ai.

- **Mount.** It runs inside apply's returned promise, never from a timer:
  1. Register the teardown effect first.
  2. Install the listener.
  3. If pi-ai holds a plane, `await piFiber.await()`; a FAILED pi-ai is tolerated. Restart pi-ai only if it is ACTIVE and its resolved config still holds a plane, then check again.
  4. `registerAdapter` is wrapped in try/catch. On `DUPLICATE_ADAPTER` it logs and retries on the next `llm/adapters-updated`, after `piFiber.await()`.
- **Teardown.** A single effect, registered first so that it runs last:
  1. It calls the handle, then sets the listener inert, with no await between the two.
  2. Only on a real dispose (`ctx.fiber.uid === null`), with pi-ai ACTIVE and its parent not unloading, it awaits pi-ai, restarts it so it takes the routes back, and checks the result through `listProviders()`.

  Reloading the plugin's own configuration restarts pi-ai zero times.

#### `src/host/plane-provider.ts`, `src/utils/plane-profile.ts` and `src/utils/plane-model.ts`

- **Where the classes come from.** `PiAiAdapter` and `Config` come from the host's llm-pi-ai module, through the existing `loadPiAiModule`. The host's pi comes through `loadHostPi`. Both lookups sit behind one function in `cordis-context.ts`, which the harness can replace. The registry and `adapter.config` are never read.
- **`class PlaneAdapter extends PiAiAdapter`.** It overrides `listModels`: when `super` answers `[]` or throws `MISSING_CREDENTIAL` (F18), it answers with the declared ids. Dispatch still fails loudly.
- **Auth (F19).**
  - **Credentials.** A credential store over `ctx.credentials`, keyed by the exported `recordKeyFor(route)` and using pi-ai's record mapping, so a host Sign-in record under `llm-pi-ai/opencode` keeps working.
  - **Environment.** `authContext.env(name)` reads the credentials service first, then the launch environment.
  - **Provider auth.** The composite provider's `auth` is pi's own `opencodeProvider().auth` / `opencodeGoProvider().auth`.
  - **Keys.** `resolveApiKey` follows D20.
- **`utils/plane-profile.ts` is pure and never throws.** It builds a `ResolvedPiAiProviderProfile` from a raw entry. Every field comes from the entry or the plugin's constants, and none is copied from a sibling profile. It sets:
  - `Config`'s defaults and every `PiAiProviderProfile` field;
  - `configuredMaxTokens`;
  - `retryPolicy`, through dsh-llm's `resolveRetryPolicy`;
  - `modelErrors` and `catalogError`, from a mirror of pi-ai's semantic checks minus "needs an api" (D15);
  - `piProvider`, built with `createProvider({ id, auth, api, models })`. `api` maps all four protocols, each wrapped in `withOpenCodeSessionHeader(<protocol>Api())`, from the host pi's public exports.
- **`utils/plane-model.ts` `planeModelFor` is pure.** Each field takes the first source that has it:

  | field | rule |
  | :-- | :-- |
  | protocol | catalog SDK (`PROTOCOL_FOR_SDK`, with `@ai-sdk/mistral` → completions as pi's own data has it) > pi's entry > the user's route-level `api` (only for ids neither classifies) > `openai-completions` (D16) |
  | name, context, max tokens, modalities, cost | the user's row > pi-ai's route-level `modelOverrides` > catalog > pi > defaults (D17) |
  | reasoning levels | the user's `reasoningEfforts` > `reasoningFor(spec)` from the catalog (D1: a toggle model offers Off/On, in both vocabularies) > pi > none |
  | baseUrl | the route-level `baseURL` > the `endpoint` family table |

  The baseUrl row resolves as follows:
  - A route-level `baseURL` on a vendor root (`/zen…`, `/inference…/openai/v1`, `/inference(/go)/v1`) selects that family.
  - A foreign root is used as written, except that a trailing `/v1` is stripped for anthropic-messages, because pi's Anthropic SDK appends `/v1/messages`.
  - The family table defaults to `modern`; `auto` means `modern`.
  - `legacy` takes the base from pi's own entry, with the fixed table as the fallback. Go has no legacy Google base, so that cell uses `OPENCODE_FAMILY_API.go["@ai-sdk/google"]`.

- **`src/utils/protocols.ts`**, created in P-R1, holds the SDK constants, `PROTOCOL_FOR_SDK` and `isServableSdk`. `UNSERVED_*` goes.

#### `src/host/patch-method.ts`: the two host wrappers that remain

`patch-method.ts` restores a wrapper only if it is still the current one, deletes it when the original was inherited, and re-wraps on `llm/adapters-updated`. It installs two wrappers:

- **`settings.describe` (D18, F20).** It runs inside `ctx.inject(["settings"])`, and touches only the `llm-pi-ai` descriptor. When `value.providers[plane]` is missing, it sets it to the interpolated, `Config`-normalized committed entry; `base`, `user` and the revision are untouched. A contract test pins that no node under `providers` in pi-ai's `Config` carries `role("secret")`. Today only `apiKeyEnv` has a role, and it is `credential-ref`.
- **`discoverModels` (P3).** It answers pi's rows plus the catalog's missing ones, deduped and whitelisted. A `NO_DISCOVERY` while pi-ai restarts yields catalog-only rows.

#### Deleted

- the llm-pi-ai child mount and its `llmFacade`;
- `responses-routes.ts`, and the hidden ids in `DEFAULT_PROVIDERS` and `cordis.patch.yml`;
- the listing hide;
- the stream redirect and `isAvailable`;
- `decoratePlaneAdapters`, and the plane overrides in `decorateModelInfo`;
- the Gemini bridge registration;
- the Google replay translators, if replay stays on one provider label (a test decides);
- `protocolFromModelId`, `adapter-replacement.ts`, and the D19 settings.

#### Removing the plugin

pi-ai serves the models it knows again, from the same file. Ids pi can't serve drop out of the composer, and the next Settings edit of that provider is refused until they are removed. Three things cover this:

- a README section;
- a handback test that pins the behaviour;
- a card action that lists those ids and removes them (P10b).

### Measured on the real host

**Runs.**

- Runs A–D use the published `@deepseek-ai/dsh` 0.2.1-rc.2 with the pi 1.4.0 it installs, offline, with an instrumented fetch.
- Runs S0 and S0b swap pi for **1.1.0 plus the harness's own patch** (D14).
- The prototypes are throwaway, and are not in the repository.

| Run | Registered | Known models, 4 shapes × 2 planes | A model pi lacks | Saving a model pi lacks |
| :-- | :-- | :-- | :-- | :-- |
| A: plugin 1.4.1 as shipped | `opencode`, `opencode-go` + 6 hidden routes | served through the hidden routes, on the plugin's per-shape endpoints | **not listed, `INVALID_CONFIG`, never sent** | **rejected** ("needs an api") |
| B: pi alone | `opencode`, `opencode-go` (pi-ai) | served, each in its own protocol, on pi's endpoints | same failure | **rejected** |
| C: pi + a delegating prototype (save gate, unregistered catalog adapter, adapter patch) | `opencode`, `opencode-go` (pi-ai) | served by pi | listed, validates, sent | accepted for catalog models; **a catalog-unknown id still rejected (run D)** |
| **S0/S0b: pi 1.1.0 + route claim + plugin provider** | `opencode`, `opencode-go` → **the plugin's adapter**; pi-ai's `deepseek` route unchanged; no hidden routes | all listed and validated, and each sent in its own protocol: `/inference/openai/v1/chat/completions` and `/responses`, `/inference/anthropic/v1/messages`, `/inference/google/v1beta/models/…:streamGenerateContent`, and the same paths under `/inference/go/` on Go, **Gemini on Go included** | Zen `gpt-5.3-codex-spark` → `/responses`, with the user's `contextWindow` reaching `resolveModelInfo`; Go `minimax-m3.1-flash` → completions; Go `gemini-4-argon-contributor` → Google | **`not-a-real-model` accepted**: the file holds exactly the saved entry, which is then listed, validates and is sent as completions |

**What the runs did not settle.**

- **Handback.** S0's handback **failed**: both planes ended at `NO_ADAPTER`, because the prototype released them while its listener was still live. S0b, after that fix, handed both routes back, and pi-ai then listed what pi 1.1.0 knows.
- **What the spike exercised.** It claimed the routes 2 s after boot, against an ACTIVE pi-ai, and simulated the release rather than disposing a fiber. P-T1b and P-R1 measure the real lifecycle.
- **A Google failure code.** A 401 on a Google call surfaced as `PI_AI_ERROR` rather than `AUTH`, exactly as with pi alone (run B). That is pi's error mapping.
- **Endpoints.** The sandbox blocks `opencode.ai`, so P-R2 measures the endpoints in CI.

**Fallback, only if the P-T1b harness contradicts S0:** run C's shape. That shape has three parts:

- an unregistered catalog adapter per plane, serving the gap models;
- an adapter patch on pi-ai's route adapter, delegating those models to it;
- a save gate that validates a copy of the config without them, then absorbs only pi-ai's "needs an api" refusal for those ids.

## Target architecture

```
src/
  index.ts             apply, Config, inject, name + config types (D6)
  lifecycle.ts         apply(): installers only
  host/
    patch-method.ts    wrap a host method: restore only if still current; delete when the original
                       was inherited; re-wrap on llm/adapters-updated (settings.describe, discoverModels)
    discovery.ts       discoverModels: pi's answer + the catalog's missing models (D3, D8)
    route-claim.ts     prepended internal/config filter: pi-ai never claims the planes; reconcile on
                       commit; mount and teardown ordering (F14-F17)
    plane-provider.ts  PlaneAdapter (extends the host's PiAiAdapter), registered as the declared planes
    remote.ts          installRemoteService, markRemote
  request/             fetch patch stages: claim → credential → headers → body (body parsed once)
  credentials.ts       gathers values; utils/credential-policy decides; CaptureStore per root
  utils/               pure: protocols, plane-model, plane-profile, model-metadata (reasoning, both
                       vocabularies), credential-policy, request-shape, session-id, catalog-parse
  contracts/           defineRemote(namespace, methods) for usage, purge, store (client-safe)
  settings-table.ts    one field table → schema, resolver, types, card specs, copy, manifest
  ui/                  card, one ActionRow, meter, on the primitives
```

The target removes the workaround's moving parts. There are no hidden routes, no listing hide, no stream redirect and no child mount. There is no Gemini bridge registration, no patched host adapter and no `resolveModelInfo` override (D8).

What stays private is pinned by contract tests against the real host packages:

- the `ResolvedPiAiProviderProfile` shape;
- pi-ai's credential record mapping;
- parity with pi-ai's own profile resolution;
- the two wrapped host methods, `describe` and `discoverModels`.

## Phases

**How each phase opens:**

- **Behaviour phases open with a red test:** P1a, P1b's fixes, P2, P-R1, P-R2, P3, P6 and P10b.
- **Pinning phases open with a green pin**, which the PR shows unchanged: P-T1a/b, P-H, P5, P7, P8, P9, P10a and P-T2.
- **P-T3 and P12 are exempt.**

**Characterization rows are tagged when they are recorded**, so a later phase flips named rows:

- `KNOWN_DEFECT`:
  - Go Gemini answers `INVALID_CONFIG`;
  - an unknown id is rejected;
  - toggle models show Minimal/Xhigh/Max.
- `INTENDED_CHANGE`:
  - completions models move from `/zen(/go)/v1` to `/inference(/go)/openai/v1`;
  - `decoratePlaneAdapters`' baseUrl repair never reaches the wire.

1. **P1a `fix:` shipped breakage.**
   - The wrapper's broken `export { default }`.
   - `isZenProvider("opencode-google")` answers false.
   - `enrichModelsResponse` passes a 401/403/5xx through, and still fills the Go plane's 404.
   - The warning colour uses `--dsw-alias-state-warn-label`.
   - The spinner keyframes are in the settings styles.
   - One debug gate.
   - `settings-purge` uses `parsePurgeResult`.
   - The endpoint copy (`config.ts`, `config-values.ts`, README) names the per-protocol inference family for `modern`, with `auto` as its alias.
2. **P1b `chore:` hygiene.**
   - Delete `adapter-replacement.ts` and its test, with a note in the engineering notes on why the approach is unsupported.
   - Delete the dead `prepared` handling and `.freebuff/`.
   - The partition test walks `Config.dict`, and a manifest test checks `cordis.patch.yml` against it.
   - `retry.ts` takes its timer and logger as parameters. The architecture test bans `console` and timers in `utils/`, and walks the folder recursively.
   - Remove the dead branches in `tool-fallback`.
   - Add the `test/support/src.ts` indirection.
3. **P2 `feat:` a smaller public API.** It ships as a 1.x minor.
   - `index.ts` exports `apply`, `Config`, `inject`, `name` and the config types.
   - `./src/*` goes from `exports`, and `check.ts` asserts that every exports target is inside `files`.
   - Delete `resolveRoutedKey` and `internalRoutes`.
   - Stop publishing the wrapper. `publish-scoped.ts`'s `SCOPED_TARGETS` and `release.yml`'s verify list change together, and `check.ts` asserts that they agree.
4. **P-T1a `build:` pin the host.**
   - `pnpm-workspace.yaml` gains `overrides: { "@earendil-works/pi-ai": "1.1.0" }` and `patchedDependencies`, with a committed copy of the harness's patch. The lockfile is regenerated.
   - The `@deepseek-ai/*` packages move to rc.2, and the devDependencies gain `dsh-llm`, `dsh-app-boot`, `dsh-config-editor`, `dsh-settings` and `cordis-plugin-loader`.
   - Add `test/support/host-versions.ts`, with a version test: `loadHostPi().version` is 1.1.0, and the root pi is the same copy.
   - Rewrite `mount-protocols.test.ts` as "every catalog SDK maps to a protocol that pi's `api/*` exports implement", keeping the row that pi 1.1.0's Go provider lacks Google.
5. **P-T1b `test:` the real-host harness.** It is additive only. `test/support/host.ts` provides two tiers that run inside the test process:
   - **Tier A:** a cordis `Context`, `LlmRuntime`, and pi-ai mounted with `{ providers }`.
   - **Tier B:** dsh-app-boot's `boot()` with a temporary HOME, and a test bundle that names the loader builtins `llm`, `llm-pi-ai`, `ConfigEditor`, `Settings` and the plugin. It follows the harness's `experimental/speech-to-text/tests/configuration.spec.ts:7-33`, with a fake `credentials` service and a launch-environment snapshot.

   This phase lands:
   - the contract tests;
   - the tagged characterization rows;
   - the S0 assertions, including `settings.describe`, `hasProviderApiKey` and the Models store's join;
   - the CI additions below.

6. **P-H `refactor:` one way to patch a host method.** `host/patch-method.ts` and `test/reload.test.ts` (apply A → apply B → dispose A → B intact → dispose B → originals).
7. **P-R1 `feat:` the plugin owns the plane routes.**
   - **New:**
     - the design above;
     - D1, D16, D17, D19 and D20;
     - the `settings.describe` wrapper;
     - `utils/protocols.ts`.
   - **Deleted:** the hidden-route machinery and the D19 settings.
   - **Tests:**
     - retarget `protocol-routing.e2e.ts` and `dispatch-levels.e2e.ts` to the planes;
     - move the per-file coverage floors to the new modules, at 100 for the pure ones, and check that every floor's glob matches a file.
   - **Docs:**
     - the README, including "Removing or disabling the plugin" and "Changed in 1.x";
     - `docs/redirect-planes.md` §8-9 and `docs/protocol-routing-and-merge.md`;
     - AGENTS.md's repo map and CONTRIBUTING.md.
   - **The PR body** names every tagged row it flips.
8. **P-R2 `fix:` the endpoint family, measured.**
   - Probe 3 URL shapes × 4 protocols × 2 planes, keyless, plus keyed probes per family with the CI keys.
   - Set the default family and pin it with a test. If a `modern` cell fails, flip the default; `endpoint: legacy` still maps every protocol.
9. **P3 `feat:` Settings complements pi's list.**
   - The `discoverModels` wrapper answers servable, non-deprecated models, deduped and whitelisted.
   - Delete `installModelDiscovery` and `toDiscovered`.
   - Rewrite the "adds nothing" tests, and the docs that say the same.
10. **P-T2 `test:` suite structure.**
    - Move the mock-booting unit files into `test/mock/`.
    - Retire the ad-hoc contexts, `createMockContext` and `HarnessSimulator`.
    - Turn constants into invariants, and split the seven big files.
    - One shared e2e environment helper.
    - Cover `session-id` and `opencode-store-contract`.
11. **P-T3 `ci:` CI and scripts.**
    - **The test run:** one unit run; build before the tests that read `lib/`; type-check `test/**/*.tsx`.
    - **Setup:** one composite setup action.
    - **`check.ts`** keeps the lib freshness check, the consumer install and the size tripwire.
    - **Scripts:** the generators share helpers, and the `verify-*` scripts exit non-zero.
    - **`no-local-paths`** also covers `.github/` and `*.sh`.
12. **P5 `refactor:` installers.** `installRemoteService` replaces the three mount-once copies.
13. **P6 `refactor:` the fetch patch's credential fill.** The adapter path is already D20.
    - One resolver, for an empty or placeholder wire key only.
    - A parity test over the deciders, with the adapter path as its own row: a rotated key takes effect, and a service failure propagates.
    - A `CaptureStore` per root, evicting a key on 401.
14. **P7 `refactor:` one source per table.** One `planeForRoute` (four copies today), `formatUsd` and `specFor`; delete the duplicate `ALL_THINKING_LEVELS` and the capitalisation copies.
15. **P8 `refactor:` settings table.** It starts with a snapshot test of the derived `Config`. Then one field table drives the schema, resolver, types, card, copy and manifest.
16. **P9 `refactor:` remote seam.** `defineRemote`, `markRemote` and `callRemote`, with the parity test reading the contracts.
17. **P10a `refactor:` pure module moves.**
    - `models-discovery` → `host/*`;
    - `go-discovery` → `credentials.ts`;
    - split `usage-ui`;
    - `fetch-patch` → `request/`.
18. **P10b `fix:` catalog state.**
    - The parse is pure and returns `deprecated`, and a refresh replaces the maps.
    - The purge makes one edit per entry.
    - The card lists the ids pi can't serve, and removes them.
19. **P11 `refactor:` UI on the primitives.**
20. **P12 `ci:`** make lint warnings gating once `src/` is at zero.

## Order

```
P0 → P1a → P1b → P2 → P-T1a → P-T1b → P-H → P-R1 → P-R2 → P3 → P-T2 → P-T3 → P5 → P6 → P7 → P8 → P9 → P10a → P10b → P11 → P12
```

- **P1a first:** it fixes what already shipped broken.
- **P-T1a and P-T1b before any routing change:** the real-host harness records today's behaviour, and P-R1 must keep it except for the rows it names.
- **P-H before P-R1:** P-R1 needs the `describe` wrapper.
- **P10a only after P5–P9:** a module is moved only once tests pin what it does.

## Test matrix

**P1a–P2**

- **Unit:**
  - each shipped breakage, red before its fix;
  - the wrapper forwarder;
  - a snapshot of the endpoint copy;
  - the manifest is a subset of `Config.dict`;
  - the `src.ts` indirection;
  - the public API, pinned green and then shrunk;
  - `exports` targets are inside `files`;
  - the scoped publish list matches `release.yml`'s;
  - the deleted settings are gone everywhere.

**P-T1a**

- **Unit:**
  - the version pin, and a same-copy check on the realpath;
  - the rewritten `mount-protocols` test.

**P-T1b**

- **Real host, tier A:** `listProviders()` equals pi-ai's keys (F11).
- **Contracts:**
  - the listener fires for another plugin's fiber, and `prepend` puts it outermost;
  - `raw === _config` holds for `_reload`, `update` and `_commitVolatile`, and not for the editor's candidate (F14);
  - a deep-frozen input is never mutated, and the fiber keeps the return value (F12);
  - the profile shape, the `Config` defaults, the credential record mapping and `recordKeyFor`;
  - no secret-role nodes;
  - the loader's `interpolate`;
  - pi's public exports.
- **Real host, tier B:**
  - `configEditor.edit` writes the raw `next` to the YAML;
  - `_commitVolatile` re-resolves through a prepended listener;
  - baselines for `settings.describe` and `hasProviderApiKey`.
- **Characterization rows**, tagged, on pi 1.1.0.

**P-R1**

- **Unit:**
  - `planeModelFor`, one row per field × known or gap model × `modern` or `legacy` × vendor or foreign base, including the Go Google legacy cell and `auto` meaning `modern`;
  - `plane-profile`:
    - its field mapping and defaults;
    - a malformed-entry table: wrong types, an empty or duplicate id, an invalid header, a `null` effort on anything but off, removed keys;
    - it never throws;
    - `!!js` is interpolated first;
  - `withoutPlaneProviders` makes a fresh copy and never touches a frozen input;
  - the `protocols.ts` tripwire.
- **Real host, tiers A and B:**
  - **Ownership and restart counts:**
    - pi-ai first: one restart;
    - plugin first: none;
    - both registry orders in one batch, with no `DUPLICATE_ADAPTER` escaping;
    - pi-ai FAILED: nothing claimed;
    - `listProviders()` restored after every transition.
  - **Lifecycle:**
    - dispose, then apply again;
    - a config reload restarts pi-ai zero times;
    - an `llm` restart;
    - pi-ai restarting itself while claimed;
    - a stream in flight completes;
    - after dispose, the routes are handed back, and the next Settings edit of `opencode` is refused.
  - **Config flow:**
    - a save rejected by a home patch or by a sibling provider changes nothing;
    - a plane-only save is served without a restart;
    - a `displayName` edit goes through `replace`;
    - a purge edit is accepted;
    - a malformed candidate is refused;
    - a malformed stored entry leaves `deepseek` serving, with one `INVALID_CONFIG`.
  - **Route set:**
    - one plane only;
    - the first plane added at runtime;
    - the last plane removed, through `replace([])`;
    - a plane re-added;
    - booting with none.
  - **Credentials:**
    - the credentials service's environment and a Sign-in record both authenticate;
    - a missing named ref still lists the models, and dispatch fails with `MISSING_CREDENTIAL` without a request;
    - a service failure propagates;
    - a rotated key takes effect;
    - captured keys are never used.
  - **Isolation:** a sibling's headers, base, api, reasoning and retry never leak into a plane.
- **Contract:**
  - the `describe` graft deep-equals the file's entries;
  - the Models store's join shows the planes as configured, and a key typed in lands under the user's `apiKeyEnv`;
  - `hasProviderApiKey`;
  - parity with pi-ai's real `apply` on a route id that is not a plane.
- **Mock gateway:** `llm.stream` through the real `LlmRuntime` for every model × plane × protocol, including Go Gemini and a catalog-unknown id. It checks:
  - the path, the body shape, the credential header and `x-opencode-session`;
  - the `legacy` family;
  - the shaping of a route-level `baseURL`.
- **Binary e2e, offline:** the S0 matrix.
- **Live e2e:**
  - the retargeted `protocol-routing` and `dispatch-levels` suites;
  - the "on" wire value per protocol for one toggle model on each plane.

**P-R2**

- **Live e2e:** the keyless matrix, keyed probes per family, and one keyless free-model probe.
- **Unit:** the default family.

**P3**

- **Unit:**
  - the wrapper's merge;
  - `NO_DISCOVERY`.
- **Real host:**
  - discovery while pi-ai restarts;
  - a composer with no `models` list.
- **Contract:** the wrapper is seen through the gateway and survives a restart.
- **Binary e2e:** the Settings fetch action.

## End-to-end infrastructure

### The `e2e-host` job (`ci.yml`)

**When it runs:** on dispatch, nightly, and on PRs that touch `src/host/**`, `src/lifecycle.ts`, `src/identity.ts` or `cordis.patch.yml`.

**What it does:**

1. Installs `@deepseek-ai/dsh@$DSH_VERSION` into a throwaway prefix, cached by host version, with npm `overrides` forcing pi.
2. Asserts the pi version that resolved.
3. Builds, and boots a temporary HOME whose profile links the checkout through a relative `link:`.
4. Runs `test/e2e/host/probe-plugin.mjs` together with `test/e2e/host-binary.e2e.ts`, which runs only when `DSH_HOST_E2E=1`.

**Cells:**

- (a) pi 1.1.0, pinned and patched, on PRs;
- (b) whatever npm installs, nightly and on dispatch.

### The live gateway job (`OPENCODE_API_KEY` / `OPENCODE_GO_API_KEY`)

- **Every PR:** the keyless matrix. A 404 means the path is gone; a 400 "Model is unavailable" or a 410 means the model is gone.
- **PRs that touch `src/host/**`, and nightly:** minimal keyed probes, one per plane × protocol, with a small `max_tokens`.
- **Nightly and on dispatch:** the full keyed suites.

## How each phase is built

1. **A spec**, written from this document and the code. It names the files, the first tests and their exact assertions, and the verification commands.
2. **The implementation.** The first test goes red on the base, or green for a pin. Then the change is made, and the gate below runs.
3. **A review panel**, running three reviews in parallel:
   - correctness and the host's contracts;
   - whether the tests perform the behaviour, plus coverage;
   - the repository's rules, the docs and this plan.

   Two independent skeptics check each finding. Fixes repeat until no blocker or high finding survives.

4. **The PR.**
   - It is stacked on the previous phase, under a Conventional title.
   - It names the rows it flips, and ticks its status row here.
   - CI failures are fixed on that branch, then merged up the stack with a merge commit, never a rebase.

## Verification (every phase)

Run on Node 26 (`.node-version`):

- `pnpm run check`: 0 errors, and no more warnings than before;
- `pnpm run test`, `test:shuffle` on three or more seeds, and `test:mock`;
- `pnpm run build` + `node --experimental-strip-types scripts/check.ts`;
- `pnpm run test:coverage` at or above the ratchet.

Then on Node 24: `test:shuffle` + `test:mock`.

Before each commit:

- grep the diff and `lib/` for local paths;
- check that no secret or key value appears in a log, fixture or snapshot.

For P-R1 and P3, the binary e2e (both pi cells) and the live keyless matrix must be green. The PR body records:

- the measured endpoints;
- the `describe` graft;
- the handback;
- the save of a catalog-unknown id.
