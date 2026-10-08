# Protocol routing, catalog merge, and the UI

How this plugin makes OpenCode's models speak the protocol each of them is actually served on, how the model catalog is assembled from several sources, and how the composer meter is built. For the meter's per-state behaviour see [`quota-meter.zh-CN.md`](./quota-meter.zh-CN.md); for the reasoning behind individual decisions see `AGENTS.md`.

## 1. Why routing exists

OpenCode serves its models on **two different APIs**, and which one a model lives on is a property of the model, not of the account:

| API       | Wire shape               | SDK the vendor's own client uses |
| :-------- | :----------------------- | :------------------------------- |
| Responses | `POST /zen/v1/responses` | `@ai-sdk/openai`                 |
| Messages  | `POST /zen/v1/messages`  | `@ai-sdk/anthropic`              |

DSH picks a transport from the provider row's protocol. If that protocol is not the one the model is served on, the gateway does not fall back — it answers `500`. So the plugin's job is to send each model to the endpoint its own SDK names, without asking the user to configure anything.

## 2. How the route is chosen

Three steps, all data-driven:

1. **The catalog carries the SDK.** Every model row in `src/catalog-data.ts` has a `provider_npm` field (`@ai-sdk/openai`, `@ai-sdk/anthropic`, …), generated from models.dev by `scripts/regenerate-catalog-shim.ts`.
2. **The SDK names a protocol.** `src/responses-routes.ts` holds the only table that maps one to the other:

   ```ts
   const PROTOCOL_FOR_SDK = {
     "@ai-sdk/openai": "openai-responses",
     "@ai-sdk/anthropic": "anthropic-messages",
   };
   ```

3. **The protocol names a route.** `internalRouteFor(provider, model, providerNpm)` answers which route serves that model (`opencode-responses`, `opencode-anthropic`), and only for providers in `COMPLETIONS_ROUTES` — the routes this plugin claims. Anything else returns `undefined` and is left alone.

`src/responses-provider.ts` then **mounts the host's own `llm-pi-ai`** under isolated auth scopes to serve those routes. That is the piece with four host contracts to survive; read its header before touching it. The plugin registers the routes, so the user configures nothing.

### Why it is a table and not a model list

An earlier version kept a hand-written list of which models redirect. A hand-patched field in that list once mis-routed nine models on every cold start. The SDK the vendor itself ships is the authority, and it arrives with the catalog.

### The end-to-end test is the only real check

`test/e2e/protocol-routing.e2e.ts` asks the gateway which endpoint recognises each shipped model. The unit tests read the same mapping they verify, so they cannot catch a stale mapping — only the live gateway can. A wrong-endpoint cell answering `500` is what pins the route; a `403 FreeTierError` only proves the gateway parsed the model.

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
