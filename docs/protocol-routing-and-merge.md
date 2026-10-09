# Protocol routing, catalog merge, and the UI

How this plugin makes OpenCode's models speak the protocol each of them is actually served on, how the model catalog is assembled from several sources, and how the composer meter is built. For the meter's per-state behaviour see [`quota-meter.md`](./quota-meter.md); for the reasoning behind individual decisions see `AGENTS.md`.

## 1. Why routing exists

OpenCode serves its models on **four different API shapes**, and which one a model lives on is a property of the model, not of the account. The per-plane counts, and the tables that go with them, live in [`redirect-planes.md`](./redirect-planes.md) §2; what follows is why the plugin has to care. Measured 2026-10-05:

| API shape | Wire endpoint | Which models | Signal in the catalog |
| :-- | :-- | :-- | :-- |
| OpenAI **Chat Completions** | `POST /zen/v1/chat/completions` | **the default**: 53 of 116 | the model names **no** SDK |
| OpenAI **Responses** | `POST /zen/v1/responses` | 32 of 116 | `@ai-sdk/openai` |
| Anthropic **Messages** | `POST /zen/v1/messages` | 23 of 116 | `@ai-sdk/anthropic` |
| Mistral **Conversations** | `POST /zen/v1/chat/completions` | `mistral-large-4` and whatever follows it | `@ai-sdk/mistral` |

**"OpenAI" is two of the three.** Chat Completions and Responses are different wire formats, and a model that needs Responses does not work on the completions endpoint. The default is not "OpenAI" either. It is whatever api the route itself was registered with, and a model that names no SDK speaks it.

DSH picks a transport from the provider row's protocol. If that protocol is not the one the model is served on, the gateway does not fall back. It answers `500`. So the plugin's job is to send each model to the endpoint its own SDK names, without asking the user to configure anything.

One SDK is deliberately **not** served: 8 models name `@ai-sdk/google`, and no protocol exists for it, in `llm-pi-ai` or here, so there is no route to dispatch them to, and they keep failing on the completions route rather than being sent somewhere invented. Every other SDK the catalog names is either mapped to a protocol or is a gap the catalog test refuses to let pass.

**Mistral shares the completions PATH but not its protocol.** `@ai-sdk/mistral` posts to `/chat/completions`, the same URL the completions models use, while speaking a different body and reading different responses. Path alone would therefore route it wrongly, which is why the route is chosen from the SDK and the protocol, and why the e2e probe has to send a real request before any of it counts as supported.

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

3. **The protocol names a route.** `internalRouteFor(provider, model, providerNpm)` answers which route serves that model (`opencode-responses`, `opencode-anthropic`, `opencode-mistral`), and only for providers in `COMPLETIONS_ROUTES`, the routes this plugin claims. Anything else returns `undefined` and is left alone.

`src/responses-provider.ts` then **mounts the host's own `llm-pi-ai`** under isolated auth scopes to serve those routes. That is the piece with four host contracts to survive; read its header before touching it. The plugin registers the routes, so the user configures nothing.

### Why it is a table and not a model list

An earlier version kept a hand-written list of which models redirect. A hand-patched field in that list once mis-routed nine models on every cold start. The SDK the vendor itself ships is the authority, and it arrives with the catalog.

### The end-to-end test is the only real check

`test/e2e/protocol-routing.e2e.ts` asks the gateway which endpoint recognises each shipped model. The unit tests read the same mapping they verify, so they cannot catch a stale mapping. Only the live gateway can. A wrong-endpoint cell answering `500` is what pins the route; a `403 FreeTierError` only proves the gateway parsed the model.

### How we support API endpoints in different formats

The user sees a single OpenCode provider and a single model list. Nothing in the interface names a route, a protocol or an endpoint, and there is no per-model setting to get wrong. That consistency is the product, and everything below it exists to keep it.

What makes it possible is that the routing is **derived, never stored**:

| Property | Why it holds |
| :-- | :-- |
| One list | The merge (§3) appends canonical rows to whatever the adapter returned. A model's route is not part of what the user picks, so it cannot fall out of sync with the picker. |
| Computed per turn | From the model id: `provider_npm` → protocol → route. Nothing caches the decision, so a catalog refresh changes routing with no migration and no stored state. |
| Registered by the plugin, not the profile | `responses-provider.ts` mounts the host's own `llm-pi-ai` once per protocol under an isolated auth scope, so a profile that declares none of these routes still gets every endpoint. |
| One place adds the headers | `fetch-patch.ts` writes the origin proof, the session id and the project attribution for every claimed route, so those do not vary by protocol. |

Two guards keep the invisible half honest, because **a mechanism that silently drops a model looks exactly like a model that does not exist**:

| Guard | What it catches |
| :-- | :-- |
| `catalog.test.ts` | A generated catalog that names an SDK which is neither mapped nor listed as deliberately unserved. It fails and names the SDK. What it prevents is a vendor addition reaching the picker as a _missing_ model, which is how `mistral-large-4` disappeared once. |
| `protocol-routing.e2e.ts` | A protocol called routable without a live probe: a path and an auth convention it really sends. Mapping `mistral-conversations` failed this test before it failed anything else, which is the intended order: the table cannot outrun the evidence. |

## 3. The catalog merge

Four sources, in a fixed order, because they answer different questions:

| Source | Answers | When |
| :-- | :-- | :-- |
| `src/catalog-data.ts` (bundled shim) | "what can I offer before any network call?" | cold start, offline |
| models.dev | "what is this model's canonical spec, price and display name?" | SWR refresh |
| Gateway `/models` | "what does **this account** actually have?" | per listing request |
| `models-discovery.ts` | "what should `discoverModels` answer?" | per discovery call |

**The merge is additive, and it never drops a row it cannot explain.** Adapter rows are preserved; canonical rows are appended when a model is missing; a row is omitted only when the provider-scoped retirement list names it, a fact rather than a guess. Display names and prices come from models.dev, because a gateway listing carries ids and little else.

Two properties matter more than completeness:

Cold start is never empty: the bundled shim answers before the first refresh, so the picker has models immediately, and a refresh replaces the set rather than appending to it twice. A missing price is its own answer: when models.dev has no row for a model, the meter shows the model's name and `—` for the rate rather than `Free`, and the panel never falls back to describing the _previous_ model.

Both generated files are checked in CI: `catalog:shim` and `limits:shim` exit non-zero when the vendor moved, which is the only way to notice that models.dev changed under you. Regenerating one is a three-step deploy: regenerate, rebuild the bundles, commit both. The host loads `lib/index.mjs`, not `src/`.

## 4. The UI

Two surfaces, one reading, and the composer meter is the one with per-state behaviour worth documenting: the trigger's three states, both panels, what every row answers, where each number comes from, and the three different kinds of "no number". That is [`quota-meter.md`](./quota-meter.md), state by state.

What belongs here is only the part that is a routing consequence: the meter is a pure view fed by `settings-page.tsx`, which owns the store, the slot registration and the Host remote calls. Nothing in it knows which route a turn took.

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
