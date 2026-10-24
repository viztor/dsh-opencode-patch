# Protocol routing, catalog merge, and the UI

How this plugin makes OpenCode's models speak the protocol each of them is actually served on, how the model catalog is assembled from several sources, and how the composer meter is built. For the meter's per-state behaviour see [`quota-meter.md`](./quota-meter.md); for the reasoning behind individual decisions see `AGENTS.md`.

## 1. Why routing exists

OpenCode serves its models on **four different API shapes**, and which one a model lives on is a property of the model, not of the account. The per-plane counts, and the tables that go with them, live in [`redirect-planes.md`](./redirect-planes.md) §2; what follows is why the plugin has to care. Measured 2026-10-17, shown on the default (modern) family:

| API shape | Wire endpoint (Zen) | Which models | Signal in the catalog |
| :-- | :-- | :-- | :-- |
| OpenAI **Chat Completions** | `POST /inference/openai/v1/chat/completions` | **the default**: 25 of 82 | the model names **no** SDK |
| OpenAI **Responses** | `POST /inference/openai/v1/responses` | 31 of 82 | `@ai-sdk/openai` |
| Anthropic **Messages** | `POST /inference/anthropic/v1/messages` | 17 of 82 | `@ai-sdk/anthropic` |
| Google **Generative AI** | `POST /inference/google/v1beta/models/<id>:streamGenerateContent` | 8 of 82 | `@ai-sdk/google` |
| OpenAI **Chat Completions** (as pi files it) | `POST /inference/openai/v1/chat/completions` | 1 of 82 | `@ai-sdk/mistral` |

Counts are the shipped catalog. They are asserted against this table by `catalog.test.ts`, because a count written into prose does not regenerate with the data it counts. Go's endpoints are the same paths under `/inference/go/…`; `endpoint: legacy` sends every protocol to `/zen/v1` (`/zen/go/v1` on Go), except Go's Google, which only the inference family serves.

**"OpenAI" is two of the four served shapes.** Chat Completions and Responses are different wire formats, and a model that needs Responses does not work on the completions endpoint. The gateway does not fall back; it answers `500`. So each model has to be sent to the endpoint its own SDK names, without asking the user to configure anything.

**Mistral is completions (D16).** `@ai-sdk/mistral` was once kept unserved for want of a measured dialect. pi's own installed data files `mistral-large-4` under `openai-completions`, so the plugin follows pi, and no SDK is withheld any more.

## 2. How a model is served: one route per plane (D13)

Since P-R1 the plugin serves `opencode` and `opencode-go` itself, with **one adapter for both planes**, and every protocol rides on the plane's own route. There is no hidden route, no redirect and no listing hide.

1. **The catalog carries the SDK.** Every model row in `src/catalog-data.ts` has a `provider_npm` field, generated from models.dev by `scripts/regenerate-catalog-shim.ts`.
2. **The SDK names a protocol.** `PROTOCOL_FOR_SDK` in `src/utils/protocols.ts` is the only table that maps one to the other, and a row naming no SDK speaks completions:

   ```ts
   const PROTOCOL_FOR_SDK = {
     "@ai-sdk/openai": "openai-responses",
     "@ai-sdk/anthropic": "anthropic-messages",
     "@ai-sdk/google": "google-generative-ai",
     "@ai-sdk/mistral": "openai-completions",
   };
   ```

3. **The plane builds the model.** `planeModelFor` (`src/utils/plane-model.ts`) folds one declared model into the pi model object the adapter serves: its protocol from the catalog, then pi's installed entry, then the plane entry's `api`, then completions (D16); its base per protocol on the chosen endpoint family; its name, window, limits, modalities and cost from the user's row first, then the catalog, then pi (D17); and its reasoning from the user's `reasoningEfforts`, then the catalog (D1). `planeProfileFor` (`src/utils/plane-profile.ts`) does the same for the whole plane entry, with `llm-pi-ai`'s own defaults and its own validation messages, and never throws.
4. **The plane adapter serves it.** `src/host/plane-provider.ts` builds `PlaneAdapter`, a subclass of the host's own `PiAiAdapter`, over a provider made with pi's own `createProvider` and all four of pi's protocol implementations, each wrapped with pi's session header. pi's provider dispatches per model (`model.api`), so one route speaks every protocol.
5. **The route claim keeps `llm-pi-ai` off the planes.** `src/host/route-claim.ts` prepends an `internal/config` listener that hands pi-ai's fiber a copy of its configuration without the two plane entries, so pi-ai never registers them; it then registers `PlaneAdapter` for exactly the planes the profile declares, and `handle.replace`s the set when it changes. An edit of a plane in Settings is validated with `llm-pi-ai`'s own checks before it is written, and `src/host/describe-graft.ts` grafts the committed plane entries back into `settings.describe()`, so _Settings → Models_ still reads and writes them where they always were (D18).

### Why a pi-ai route cannot serve mixed protocols, and why the plugin's can

Traced through `dsh-llm-pi-ai` and pi-ai, because "one provider, many protocols" keeps looking like it should work on pi-ai's own route and never does:

```
profile → PiAiProviderProfile
  → buildProvider (dsh-llm-pi-ai/lib/index.js:926)
      catalog route AND no route-level `api` → reuseCatalogProvider (:908)
      anything else                          → createProvider({ api: factory() })  (:931)
  → snapshot.models.streamSimple(model, …)              host :1987
  → dispatch                                            @earendil-works/pi-ai/dist/models.js:553
```

`createProvider` with a single `api` calls the ROUTE's implementation, so a route with an `api` speaks exactly one protocol. pi's own provider _does_ dispatch per model (`apiFor = single ?? byApi[model.api]`), and pi ships `opencode` with an api MAP of four protocols, so the reused-catalog path supports mixed protocols — for models the installed catalog describes.

**The wall is model materialization** (`lib/index.js:663-690`): a hand-written id resolves to `request.api ?? base?.api ?? routeApi`, and `routeApi` is the one protocol the route's shipped models agree on — `undefined` for `opencode`, because they do not agree — so a hand-written id with no `api` is `INVALID_CONFIG`.

The plane adapter goes around the wall rather than through it: it builds its own provider with the four-protocol api map (the shape pi's `opencode` provider has), and its own model objects, so a model's protocol comes from the catalog for every id, described or not. That is also why any saved id is served (D15): one the catalog does not describe is completions unless its row says otherwise.

### Why it is a table and not a model list

An earlier version kept a hand-written list of which models redirect. A hand-patched field in that list once mis-routed nine models on every cold start. The SDK the vendor itself ships is the authority, and it arrives with the catalog.

### The end-to-end test is the only real check

`test/e2e/protocol-routing.e2e.ts` asks the gateway which endpoint recognises each shipped model, and reads the protocol and base it expects from `planeModelFor`. The unit tests read the same mapping they verify, so they cannot catch a stale mapping. Only the live gateway can. A wrong-endpoint cell answering `500` is what pins the protocol; a `403 FreeTierError` only proves the gateway parsed the model.

### The base URL is per protocol, not per plane

pi builds each protocol's request differently. The OpenAI protocols append `/chat/completions` or `/responses` to a base that already carries `/v1`; the Anthropic one hands its base straight to the Anthropic SDK, which appends `/v1/messages` itself.

Measured both halves. Asking the SDK which URL a base produces:

| Base URL given to the SDK | URL it requests | Gateway answers |
| :-- | :-- | :-- |
| `https://opencode.ai/zen` | `…/zen/v1/messages` | `400`, upstream reached |
| `https://opencode.ai/zen/v1` | `…/zen/v1/v1/messages` | `404` |

So `baseUrlFor` strips a trailing `/v1` from every Anthropic base, on both families and on a foreign `baseURL` alike; pi's own catalog agrees (`…/zen` for `anthropic-messages`, `…/zen/v1` for the rest). The table is pinned cell by cell in `test/plane-model.test.ts`, and every cell is sent to the offline gateway mock by `test/mock/plane-dispatch.mock.ts`.

### What the layers of testing each prove

They are different checks, and none stands in for another:

- The **live suite** asks the gateway which endpoint recognises each shipped model, with a hand-written body per protocol. It proves the endpoint answers and what the gateway rejects.
- The **mock-gateway suite** runs `llm.stream` through the real `LlmRuntime` and the plane adapter, with the plugin's fetch patch, against a local gateway that refuses a request whose shape its endpoint would not accept. It proves the request the plugin builds is one the endpoint accepts, for every characterized model on both planes and both families.
- The **real-host suites** (`test/host-characterization.test.ts`, `test/host-planes.test.ts`) run the plugin beside `llm-pi-ai` on the real host, in both apply orders, and pin ownership, restarts, the Settings flow, credentials and isolation.

### How we support API endpoints in different formats

The user sees a single OpenCode provider per plane and a single model list. Nothing in the interface names a protocol or an endpoint, and there is no per-model setting to get wrong.

| Property | Why it holds |
| :-- | :-- |
| One list | A plane lists the models its entry declares, and the whole catalog when it declares none (D3). A model's protocol is not part of what the user picks, so it cannot fall out of sync with the picker. |
| Computed from data | `provider_npm` → protocol → base, rebuilt whenever the plane entry changes. Nothing is stored, so a catalog refresh changes routing with no migration. |
| Registered by the plugin, configured in pi-ai | The plane entries stay in `llm-pi-ai`'s `providers` block; the plugin claims the two routes and leaves every other route to pi-ai. |
| One place adds the headers | `fetch-patch.ts` writes the origin proof, the session id and the project attribution for every claimed route, so those do not vary by protocol. |

Two guards keep the invisible half honest, because **a mechanism that silently drops a model looks exactly like a model that does not exist**:

| Guard | What it catches |
| :-- | :-- |
| `catalog.test.ts` | A generated catalog that names an SDK `PROTOCOL_FOR_SDK` does not map, or a catalog model that resolves off its own plane. It fails and names the model. |
| `protocol-routing.e2e.ts` | A protocol called servable without a live probe: a path and an auth convention it really sends. |

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

Both generated files are checked in CI: `catalog:shim` and `limits:shim` exit non-zero when the vendor moved, which is the only way to notice that models.dev changed under you. Regenerating one is a three-step deploy: regenerate, rebuild the bundles, commit both. The host loads `lib/index.mjs`, not `src/`.

## 4. The UI

Two surfaces, one reading, and the composer meter is the one with per-state behaviour worth documenting: the trigger's three states, both panels, what every row answers, where each number comes from, and the three different kinds of "no number". That is [`quota-meter.md`](./quota-meter.md), state by state.

What belongs here is only the part that is a routing consequence: the meter is a pure view fed by `settings-page.tsx`, which owns the store, the slot registration and the Host remote calls. Nothing in it knows which route a turn took.

## 5. Where the code lives

| Concern | Module |
| :-- | :-- |
| Which protocol and endpoint a model is served on | `utils/protocols.ts`, `utils/plane-model.ts`, `utils/plane-profile.ts` |
| Serving the planes | `host/route-claim.ts`, `host/plane-provider.ts`, `host/describe-graft.ts` |
| Catalog merge | `models-catalog.ts`, `models-discovery.ts`, `catalog-data.ts` |
| Allowance table | `go-limits-data.ts` (generated) |
| Credentials and the `/usage` endpoint | `go-discovery.ts`, `key-capture.ts` |
| The usage Host service | `usage.ts`, `usage-contract.ts` |
| Meter state / views / logic | `usage-pill.tsx`, `usage-panel.tsx`, `usage-ui.ts` |
| Settings card and its summary | `settings-card.tsx`, `settings-usage.tsx` |
