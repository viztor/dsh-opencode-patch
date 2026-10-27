# Protocol routing, catalog merge, and the UI

How this plugin makes OpenCode's models speak the protocol each of them is actually served on, how the model catalog is assembled from several sources, and how the composer meter is built. For the meter's per-state behaviour see [`quota-meter.md`](./quota-meter.md); for the reasoning behind individual decisions see `AGENTS.md`.

## 1. Why routing exists

OpenCode serves its models on **four different API shapes**, and which one a model lives on is a property of the model, not of the account. The per-plane counts, and the tables that go with them, live in [`redirect-planes.md`](./redirect-planes.md) §2; what follows is why the plugin has to care. Measured 2026-10-17:

| API shape | Wire endpoint | Which models | Signal in the catalog |
| :-- | :-- | :-- | :-- |
| OpenAI **Chat Completions** | `POST /zen/v1/chat/completions` | **the default**: 24 of 81 | the model names **no** SDK |
| OpenAI **Responses** | `POST /zen/v1/responses` | 31 of 81 | `@ai-sdk/openai` |
| Anthropic **Messages** | `POST /zen/v1/messages` | 17 of 81 | `@ai-sdk/anthropic` |
| Google **Generative AI** | `POST /zen/v1/models/<id>:streamGenerateContent` | 8 of 81 | `@ai-sdk/google` |
| Mistral **Conversations** | `POST /zen/v1/chat/completions` | 1 of 81 | `@ai-sdk/mistral` |

Counts are the shipped catalog. They are asserted against this table by `catalog.test.ts`, because a count written into prose does not regenerate with the data it counts.

**The original route's own format is the case that does nothing.** A model that speaks the route's protocol names no SDK, because that protocol IS the default; the route the user configured already speaks it, so the call stays there. No hidden route, no redirect, no merge — which is why a deployment whose models are all completions mounts nothing at all, and why the whole apparatus below exists only for the models that are not.

**"OpenAI" is two of the four served shapes.** Chat Completions and Responses are different wire formats, and a model that needs Responses does not work on the completions endpoint. The default is not "OpenAI" either. It is whatever api the route itself was registered with, and a model that names no SDK speaks it.

DSH picks a transport from the provider row's protocol. If that protocol is not the one the model is served on, the gateway does not fall back. It answers `500`. So the plugin's job is to send each model to the endpoint its own SDK names, without asking the user to configure anything.

**One SDK is deliberately not served, and it is Mistral.** Its models post to the completions path while speaking a different body, so path alone would route them wrongly, and the dialect the gateway answers with has not been measured — an earlier probe could not observe the request it produces. They stay unoffered rather than being sent somewhere invented, and `UNSERVED_SDKS` records the decision.

`@ai-sdk/google` used to be in that position, and is not any more: pi implements `google-generative-ai`, the plugin serves it through its own adapter on the route `opencode-google`, and the live suite probes that path on every run. The two mechanisms that serve the four shapes are described below.

**Mistral shares the completions PATH but not its protocol.** `@ai-sdk/mistral` posts to `/chat/completions`, the same URL the completions models use, while speaking a different body and reading different responses. Path alone would therefore route it wrongly, which is why the route is chosen from the SDK and the protocol, and why the e2e probe has to send a real request before any of it counts as supported.

## 2. How the route is chosen

Three steps, all data-driven:

1. The catalog carries the SDK. Every model row in `src/catalog-data.ts` has a `provider_npm` field (`@ai-sdk/openai`, `@ai-sdk/anthropic`, …), generated from models.dev by `scripts/regenerate-catalog-shim.ts`.
2. The SDK names a protocol. `src/responses-routes.ts` holds the only table that maps one to the other:

   ```ts
   const PROTOCOL_FOR_SDK = {
     "@ai-sdk/openai": "openai-responses",
     "@ai-sdk/anthropic": "anthropic-messages",
     "@ai-sdk/google": "google-generative-ai",
   };
   ```

3. The protocol names a route. `internalRouteFor(provider, model, providerNpm)` answers which route serves that model (`opencode-responses`, `opencode-anthropic`, `opencode-google`), and only for providers in `COMPLETIONS_ROUTES`, the routes this plugin claims. Anything else returns `undefined` and is left alone.

`src/responses-provider.ts` then **mounts the host's own `llm-pi-ai`** under isolated auth scopes to serve those routes. That is the piece with four host contracts to survive; read its header before touching it. The plugin registers the routes, so the user configures nothing.

### Why a provider cannot serve mixed protocols, in the harness's own terms

Traced through `dsh-llm-pi-ai` and pi-ai, because "one provider, many protocols" keeps looking like it should work and never does:

```
profile → PiAiProviderProfile
  → buildProvider (dsh-llm-pi-ai/lib/index.js:926)
      catalog route AND no route-level `api` → reuseCatalogProvider (:908)
      anything else                          → createProvider({ api: factory() })  (:931)
  → snapshot.models.streamSimple(model, …)              host :1987
  → dispatch                                            @earendil-works/pi-ai/dist/models.js:553
```

`createProvider` calls `input.api.stream(model, …)` — the ROUTE's implementation, so a route with an `api` speaks exactly one protocol and `model.api` is ignored. pi's own provider _does_ dispatch per model (`apiFor = single ?? byApi[model.api]`), and pi ships `opencode` with an api MAP of four protocols (`providers/opencode.js`), so the reused-catalog path genuinely supports mixed protocols — for models the installed catalog describes.

**The wall is model materialization** (`lib/index.js:663-690`):

```js
const base = defaults.get(entry.id); // the installed catalog entry
const api = request.api ?? base?.api ?? routeApi;
if (api === void 0) invalid(provider, "… needs an api …");
```

with `routeApi = sharedCatalogApi(defaults)`, which answers the one protocol the route's shipped models agree on — **and `undefined` when they disagree**, which is always the case for `opencode`.

| declared model | protocol it gets | outcome |
| :-- | :-- | :-- |
| described by the installed catalog | `base.api` (its own) | per-model dispatch, no help needed |
| hand-written, not described | `request.api`, else `routeApi` | **INVALID_CONFIG** when both are absent |

So: a route that names `api` pins every model on it; a route that does not name one gives hand-written models no protocol at all. That is why this plugin's answer is the three steps it implements rather than a single mixed-protocol provider:

1. **declare the route again, hidden** — an internal route per protocol, with the right `api` and `baseURL` (`registerResponsesProvider`);
2. **hide the mount** — `hideResponsesRoute` drops it from every listing, including the configurable-provider set and the browser catalog;
3. **merge at the presentation layer** — discovery and `/models` enrichment describe the models on the route the user actually selected, never on the hidden ones.

### When the automatic path is enough, and when it never is

pi-ai's own `opencode` provider carries a four-protocol api map, so it dispatches per model natively. Reusing it instead of mounting routes needs three things at once, and a deployment loses the argument if it fails any of them:

| condition | note |
| :-- | :-- |
| every declared id is in pi's installed snapshot | a hand-written id has no `base.api` |
| the route declares no `api` | a declared `api` pins every model on the route |
| pi's per-model `baseUrl` is current | the installed snapshot still says `…/zen` |

The third is ours to fix and is fixed: the adapter decoration writes `baseUrl` (and `api`) on the model it answers, and pi passes that exact object down (`provider.streamSimple(requestModel, …)`), so the override reaches the wire.

The first two cannot be fixed from a plugin. A hand-written id resolves to `request.api ?? base?.api ?? routeApi`, and `routeApi` is `sharedCatalogApi` — the one protocol the route's shipped models agree on, which is `undefined` for `opencode` because they do not agree. A route that names `api` pins every model on it instead. So: **any deployment that hand-writes a model needs a route that speaks its protocol**, which is why the hidden-route mechanism is structural rather than a workaround, and why the mount narrows to the declared ids — a deployment whose ids all speak the route's protocol mounts nothing at all.

And the consequence for anything built on top: a model's protocol is not a property of the model object alone. It is the route's, chosen at profile resolution, so a model that needs a different protocol needs a route that speaks it.

### Why it is a table and not a model list

An earlier version kept a hand-written list of which models redirect. A hand-patched field in that list once mis-routed nine models on every cold start. The SDK the vendor itself ships is the authority, and it arrives with the catalog.

### The end-to-end test is the only real check

`test/e2e/protocol-routing.e2e.ts` asks the gateway which endpoint recognises each shipped model. The unit tests read the same mapping they verify, so they cannot catch a stale mapping. Only the live gateway can. A wrong-endpoint cell answering `500` is what pins the route; a `403 FreeTierError` only proves the gateway parsed the model.

### One base URL per plane is one base too many

pi builds each protocol's request differently. The OpenAI protocols append `/chat/completions` or `/responses` to a base that already carries `/v1`; the Anthropic one hands its base straight to the Anthropic SDK, which appends `/v1/messages` itself.

Measured both halves. Asking the SDK which URL a base produces:

| Base URL given to the SDK | URL it requests | Gateway answers |
| :-- | :-- | :-- |
| `https://opencode.ai/zen` | `…/zen/v1/messages` | `400`, upstream reached |
| `https://opencode.ai/zen/v1` | `…/zen/v1/v1/messages` | `404` |

So an internal route mounted on its plane's base asked for `/v1/v1/messages` and could not answer — which is every model whose protocol is `anthropic-messages`, the ids the two planes disagree about. The mount takes its base per protocol from the table that records this, and the test that guards it names the route, the protocol and both URLs when it fails.

pi's own catalog agrees, which is the reason a table of bases is worth keeping rather than deriving: for `opencode` it says `…/zen` for `anthropic-messages` and `…/zen/v1` for the rest.

### What the two layers of testing each prove

They are different checks, and neither stands in for the other:

- The **live suite** asks the gateway which endpoint recognises each shipped model, with a hand-written body per protocol. It proves the endpoint answers and what the gateway rejects. Its bodies are written by the test, not produced by the plugin — the first Google probe was missing a `role` the Gemini body needs, and the gateway's refusal of that probe was a fact about the probe.
- The **unit suite** runs the plugin's own request path with the network intercepted: the real `PiAiAdapter`, this plugin's profile, pi's protocol implementation and the resolved credential, asserting the URL, the auth header and the body. It proves the request the plugin builds is one the endpoint accepts.

Between them, a wrong endpoint and a wrong request are separate failures instead of one blurred claim.

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

**The merge is additive, and it never drops a row it cannot explain.** Adapter rows are preserved; canonical rows are appended when a model is missing; a row is omitted only when the registry itself marks it `status: "deprecated"`, a fact rather than a guess. Display names and prices come from models.dev, because a gateway listing carries ids and little else.

Two properties matter more than completeness:

Cold start is never empty: the bundled shim answers before the first refresh, so the picker has models immediately, and a refresh replaces the set rather than appending to it twice. A missing price is its own answer: when models.dev has no row for a model, the meter shows the model's name and `—` for the rate rather than `Free`, and the panel never falls back to describing the _previous_ model.

Both generated files are checked in CI: `catalog:shim` and `limits:shim` exit non-zero when the vendor moved, which is the only way to notice that models.dev changed under you. A pull request is gated on that only when its own diff touches the generator or a module the generator loads (`scripts/freshness-scope.ts` decides); any other pull request, and a push to main, warns, and the nightly job proposes the refresh. Regenerating one is a three-step deploy: regenerate, rebuild the bundles, commit both. The host loads `lib/index.mjs`, not `src/`.

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
