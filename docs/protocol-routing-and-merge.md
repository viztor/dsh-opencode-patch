# Protocol routing, catalog merge, and the UI

How this plugin makes OpenCode's models speak the protocol each of them is actually served on, how the model catalog is assembled from several sources, and how the composer meter is built. For the meter's per-state behaviour see [`quota-meter.md`](./quota-meter.md); for the reasoning behind individual decisions see `AGENTS.md`.

## 1. Why routing exists

OpenCode serves its models on **four different API shapes**, and which one a model lives on is a property of the model, not of the account. Measured 2026-10-05 across the 116 `opencode` models:

| API shape | Wire endpoint | Which models | Signal in the catalog |
| :-- | :-- | :-- | :-- |
| OpenAI **Chat Completions** | `POST /zen/v1/chat/completions` | **the default** — 53 of 116 | the model names **no** SDK |
| OpenAI **Responses** | `POST /zen/v1/responses` | 32 of 116 | `@ai-sdk/openai` |
| Anthropic **Messages** | `POST /zen/v1/messages` | 23 of 116 | `@ai-sdk/anthropic` |
| Mistral **Conversations** | `POST /zen/v1/chat/completions` | `mistral-large-4` and whatever follows it | `@ai-sdk/mistral` |

**"OpenAI" is two of the three.** Chat Completions and Responses are different wire formats, and a model that needs Responses does not work on the completions endpoint. The default is not "OpenAI" either — it is whatever api the route itself was registered with, and a model that names no SDK speaks it.

DSH picks a transport from the provider row's protocol. If that protocol is not the one the model is served on, the gateway does not fall back — it answers `500`. So the plugin's job is to send each model to the endpoint its own SDK names, without asking the user to configure anything.

One SDK is deliberately **not** served: 8 models name `@ai-sdk/google`, and no protocol exists for it — not in `llm-pi-ai`, not here — so there is no route to dispatch them to, and they keep failing on the completions route rather than being sent somewhere invented. Every other SDK the catalog names is either mapped to a protocol or is a gap the catalog test refuses to let pass.

**Mistral shares the completions PATH but not its protocol.** `@ai-sdk/mistral` posts to `/chat/completions`, the same URL the completions models use, while speaking a different body and reading different responses. Path alone would therefore route it wrongly, which is why the route is chosen from the SDK and the protocol — and why the e2e probe has to send a real request before any of it counts as supported.

## 2. How the route is chosen

Three steps, all data-driven:

1. **The catalog carries the SDK.** Every model row in `src/catalog-data.ts` has a `provider_npm` field (`@ai-sdk/openai`, `@ai-sdk/anthropic`, …), generated from models.dev by `scripts/regenerate-catalog-shim.ts`.
2. **The SDK names a protocol.** `src/responses-routes.ts` holds the only table that maps one to the other:

   ```ts
   const PROTOCOL_FOR_SDK = {
     "@ai-sdk/openai": "openai-responses",
     "@ai-sdk/anthropic": "anthropic-messages",
     "@ai-sdk/mistral": "mistral-conversations",
   };
   ```

3. **The protocol names a route.** `internalRouteFor(provider, model, providerNpm)` answers which route serves that model (`opencode-responses`, `opencode-anthropic`, `opencode-mistral`), and only for providers in `COMPLETIONS_ROUTES` — the routes this plugin claims. Anything else returns `undefined` and is left alone.

`src/responses-provider.ts` then **mounts the host's own `llm-pi-ai`** under isolated auth scopes to serve those routes. That is the piece with four host contracts to survive; read its header before touching it. The plugin registers the routes, so the user configures nothing.

### Why it is a table and not a model list

An earlier version kept a hand-written list of which models redirect. A hand-patched field in that list once mis-routed nine models on every cold start. The SDK the vendor itself ships is the authority, and it arrives with the catalog.

### The end-to-end test is the only real check

`test/e2e/protocol-routing.e2e.ts` asks the gateway which endpoint recognises each shipped model. The unit tests read the same mapping they verify, so they cannot catch a stale mapping — only the live gateway can. A wrong-endpoint cell answering `500` is what pins the route; a `403 FreeTierError` only proves the gateway parsed the model.

### How we support API endpoints in different formats

The user sees a single OpenCode provider and a single model list. Nothing in the interface names a route, a protocol or an endpoint, and there is no per-model setting to get wrong — **that consistency is the product**, and everything below it exists to keep it.

What makes it possible is that the routing is **derived, never stored**:

- **One list** because the merge (§3) appends canonical rows to whatever the adapter returned. A model's route is not part of what the user picks, so it cannot fall out of sync with the picker.
- **Computed per turn** from the model id — `provider_npm` → protocol → route. Nothing caches the decision, so a catalog refresh changes routing with no migration and no stored state.
- **Registered by the plugin, not the profile.** `responses-provider.ts` mounts the host's own `llm-pi-ai` once per protocol under an isolated auth scope, so a profile that declares none of these routes still gets every endpoint.
- **One place adds the headers.** `fetch-patch.ts` writes the origin proof, the session id and the project attribution for every claimed route, so those do not vary by protocol.

Two guards keep the invisible half honest, because **a mechanism that silently drops a model looks exactly like a model that does not exist**:

- **`catalog.test.ts`** fails, naming the SDK, when the generated catalog names one that is neither mapped nor listed as deliberately unserved. What it prevents is a vendor addition reaching the picker as a _missing_ model — which is how `mistral-large-4` disappeared once.
- **`protocol-routing.e2e.ts`** refuses to call a protocol routable without a live probe: a path and an auth convention it really sends. Mapping `mistral-conversations` failed this test before it failed anything else, which is the intended order — the table cannot outrun the evidence.

## 3. The catalog merge

Four sources, in a fixed order, because they answer different questions:

| Source | Answers | When |
| :-- | :-- | :-- |
| `src/catalog-data.ts` (bundled shim) | "what can I offer before any network call?" | cold start, offline |
| models.dev | "what is this model's canonical spec, price and display name?" | SWR refresh |
| Gateway `/models` | "what does **this account** actually have?" | per listing request |
| `models-discovery.ts` | "what should `discoverModels` answer?" | per discovery call |

**The merge is additive, and it never drops a row it cannot explain.** Adapter rows are preserved; canonical rows are appended when a model is missing; a row is omitted only when the provider-scoped retirement list names it — a fact, not a guess. Display names and prices come from models.dev, because a gateway listing carries ids and little else.

Two properties matter more than completeness:

- **Cold start is never empty.** The bundled shim answers before the first refresh, so the picker has models immediately. A refresh replaces the set; it does not append to it twice.
- **A missing price is its own answer.** When models.dev has no row for a model, the meter shows the model's name and `—` for the rate rather than `Free`, and the panel never falls back to describing the _previous_ model.

Both generated files are checked in CI: `catalog:shim` and `limits:shim` exit non-zero when the vendor moved, which is the only way to notice that models.dev changed under you. Regenerating one is a three-step deploy — regenerate, rebuild the bundles, commit both — because the host loads `lib/index.mjs`, not `src/`.

## 4. The UI

Two surfaces, one reading. Both are pure views fed by `settings-page.tsx`, which owns the store, the slot registration and the Host remote calls.

### The composer meter

- `src/usage-pill.tsx` — state: gating by provider, the poll loop, hover/click dismissal, retry. It registers through `ctx.inject(['slots', 'modelDirectories'], …)`, the host's own idiom; reading those services off the root context fails **silently**, which is how the meter once shipped broken.
- `src/usage-panel.tsx` — `UsageTrigger` (the ring) and `UsagePanel` (the rows), both pure functions of their props with no hooks, so tests invoke them and walk the tree.
- `src/usage-ui.ts` — dependency-free logic and the stylesheet: window geometry, the affecting-window rule, `describeUsage` copy, `formatRelativeReset`.

**Which window the trigger shows.** A window that is _out_ (rate-limited, or at its cap) wins, widest first — monthly, then weekly, then 5-hour — because a monthly cap explains a refusal the 5-hour window does not. Otherwise the 5-hour window, which resets soonest. The bottleneck is not the largest number; it is the smallest window that can still refuse you.

**Two balances, never one.** A turn is attributed to the plane that _served_ it (`catalogPlaneForRoute`), and the accumulator keeps `costGo` / `costZen`. `attachSession` projects the reading's own plane onto the snapshot, so each panel answers for its own balance. A Zen route renders no Go figure at all: hollow ring, spend as the label, no Go-plan alert.

### The settings card

`src/settings-card.tsx` renders one control per `CARD_FIELDS` entry — a register, not JSX — and `src/settings-usage.tsx` adds the Go usage summary above them: one row per window with what is **left** on the right. "Left" is a percentage, never a dollar figure: `/usage` publishes a percent per window and no balance, and the plan tier is not discoverable. The ⓘ says so. A quota that cannot be read prints no numbers.

The card's `inject()` hands in `readUsage` and `getLocale` the same way the meter receives them, so one service owns credential resolution and the endpoint.

## 5. Where the code lives

| Concern | Module |
| :-- | :-- |
| Which endpoint a model is served on | `responses-routes.ts` |
| Serving that endpoint | `responses-provider.ts` |
| Catalog merge | `models-catalog.ts`, `models-discovery.ts`, `catalog-data.ts` |
| Allowance table | `go-limits-data.ts` (generated) |
| Credentials and the `/usage` endpoint | `go-discovery.ts`, `key-capture.ts` |
| The usage Host service | `usage.ts`, `usage-contract.ts` |
| Meter state / views / logic | `usage-pill.tsx`, `usage-panel.tsx`, `usage-ui.ts` |
| Settings card and its summary | `settings-card.tsx`, `settings-usage.tsx` |
