# Redirect planes: the specification

> This is the specification; the implementation is in [`protocol-routing-and-merge.md`](./protocol-routing-and-merge.md).

The authority for how this plugin sends a model to the endpoint that serves it. `protocol-routing-and-merge.md` describes what the code does today; **this document says what it must do**, and the tests below are how the two are held together. Measured 2026-10-09 against `models.dev`.

## 1. Planes

A **plane** is one gateway base URL with its own catalog and its own credential. There are two.

| Plane | Route id | Base URL | Credential | Models |
| :-- | :-- | :-- | :-- | --: |
| Zen (pay-as-you-go, free tier) | `opencode` | the `endpoint` family's | the entry's `apiKeyEnv`; without one, pi's `OPENCODE_API_KEY` | 88 served / 132 listed |
| Go (subscription) | `opencode-go` | the `endpoint` family's | the entry's `apiKeyEnv` (name `OPENCODE_GO_API_KEY`); without one, pi's `OPENCODE_API_KEY` | 32 served / 38 listed |

Counts as of 2026-11-13 (the shipped shim, regenerated in #132, refreshed in #156, in #159, which added seven Zen models and one Go model and retired `crouton-alpha-free` and `pulse-alpha-free`, and in #171, which added the Zen model `gemini-4-hydrogen`); the document's 2026-10-09 stamp is for its measurements. Only the served halves were refreshed in #159 and #171: the shim carries no deprecated rows and the registry was not re-read, so the listed halves are the ones #156 recorded, carried forward unchanged rather than inferred from the served side.

**There is no longer one base URL per plane to quote.** The gateway answers on two endpoint families and the `endpoint` setting picks one: `auto`, the default, is an alias of `modern` (`AUTO_ENDPOINT_FAMILY` in `src/utils/plane-model.ts`), the per-protocol `…/inference/{openai,anthropic,google}/…` and `…/inference/go/…`; `legacy` pins the older `…/zen/v1` and `…/zen/go/v1`, except Go's Google, which has no legacy base and stays on `…/inference/go/google/v1beta`. The setting moves only the planes the route claim takes: a plane entry another plugin owns (D27) is pi-ai's, and leaves at the base pi-ai alone sends it to under every setting (`test/endpoint-family.test.ts`). Which families answer, keyless and with each plane's own key, is measured in CI (§13), not assumed. The dated measurement below was taken on the legacy family.

A plane is a property of the **account and the base URL**, never of a model. The same model id can exist on both planes and be served on a different shape in each.

**The two numbers per plane are two different questions**, and stating only one of them is how this table contradicted the section below it: _served_ is what the shim ships after the registry's deprecated rows are dropped, and _listed_ is everything the registry carries for that provider, including the deprecated ones. The per-shape counts below are the served ones.

## 2. Shapes

A **shape** is one wire protocol, named by the SDK a model declares in the catalog (`provider.npm`). A model naming no SDK speaks its route's own protocol, which is OpenAI Chat Completions. Counts as of 2026-11-13 (the shipped shim, regenerated in #132, refreshed in #156, in #159, which added seven Zen models and one Go model and retired `crouton-alpha-free` and `pulse-alpha-free`, and in #171, which added the Zen model `gemini-4-hydrogen`).

| SDK in the catalog  | Protocol               | Zen |    Go |
| :------------------ | :--------------------- | --: | ----: |
| _(none)_            | `openai-completions`   |  27 |    21 |
| `@ai-sdk/openai`    | `openai-responses`     |  32 | **5** |
| `@ai-sdk/anthropic` | `anthropic-messages`   |  18 | **5** |
| `@ai-sdk/mistral`   | `openai-completions`   |   1 |     — |
| `@ai-sdk/google`    | `google-generative-ai` |  10 | **1** |

**Absence is the signal, and it is a real one.** Both planes set a provider-level `npm` of `@ai-sdk/openai-compatible` in `models.dev`, and **no model declares it explicitly**: 0 of 88 on Zen, 0 of 32 on Go. A model that speaks the completions shape simply omits `provider.npm` and inherits it. So "no SDK" does not mean "unknown"; it means _the provider default_, which is the protocol the route was itself registered with.

That is why the servability check treats `undefined` as servable, and why `@ai-sdk/openai-compatible` is deliberately **not** in `PROTOCOL_FOR_SDK`: listing it would record the default as though it were an override. The coverage guard still covers the case where a model declares it explicitly. None do today, and if one did, the test would name it rather than drop the model.

**The two bold cells were the gap, and they are closed.** The Go plane serves 11 models on shapes other than completions; both planes now serve every shape either one carries, on the plane's own route (§3).

**`@ai-sdk/mistral` is completions (D16).** pi's own data files `mistral-large-4` under `openai-completions`, so the plugin follows it rather than keeping the SDK unserved; nothing is withheld for its protocol any more.

## 3. Routes

A route is a name the host can dispatch to. Since P-R1 (D13) there is **one route per plane**, and it serves every protocol that plane carries: the plugin registers its own adapter — a subclass of the host's `PiAiAdapter` — for exactly the planes the profile declares, through the host's own `registerAdapter`, and `llm-pi-ai` keeps every other route.

| Route | Plane | Protocols | Base URL |
| :-- | :-- | :-- | :-- |
| `opencode` | Zen | all four, per model, from the catalog (§2) | per protocol, on the `endpoint` family |
| `opencode-go` | Go | all four, per model, from the catalog (§2) | per protocol, on the `endpoint` family |

The per-protocol hidden routes this section used to list (`opencode-responses`, `opencode-anthropic`, `opencode-google` and their `opencode-go-*` twins) are gone, and so is the stream redirect that dispatched to them: a model's protocol and base are fields of the model object the plane adapter builds (`src/utils/plane-model.ts`), so there is nothing left to re-dispatch.

## 4. Invariants

These are the rules a correct implementation satisfies. Each one has a test in §5.

|  | Invariant | What it requires |
| :-- | :-- | :-- |
| I1 | Every offered model is routable | If a model appears in the picker, or in Settings → Models' fetch on a plane, its plane's route serves it on the shape its SDK names. This is the plugin's headline promise; the Go gap broke it once, and one route per plane closed it for good. |
| I2 | A route carries one plane | Its base URLs, its catalog and its credential all come from the same plane. Mixing them resolves to "model not found" against the route's own endpoint. |
| I3 | The endpoint is chosen from (plane, SDK) | Never from the SDK alone: the same SDK appears on both planes, on each plane's own base. |
| I4 | No SDK means completions | A model naming no SDK speaks `openai-completions`, and so does an id no catalog describes (D15), unless the plane entry names an `api` for it. |
| I5 | Every SDK the catalog names maps to a protocol pi implements | `PROTOCOL_FOR_SDK` (`src/utils/protocols.ts`) covers every SDK either catalog names, and nothing is unserved; a new SDK fails the guard rather than dropping its models. |

## 5. Guards

| Guard | Holds | Fails when |
| :-- | :-- | :-- |
| `catalog-routing.test.ts` · SDK coverage | I5 | the catalog names an SDK `PROTOCOL_FOR_SDK` does not map |
| `catalog-routing.test.ts` · plane × SDK coverage | I1, I2 | a catalog model resolves to a protocol other than its SDK's, or to a base off its own plane |
| `plane-model.test.ts` · protocol and base tables | I2, I3, I4 | a protocol, a family or a route-level base resolves to the wrong endpoint for its plane |
| `protocol-routing.e2e.ts` · live probe | I1, I3 | a protocol is declared routable without a path and an auth convention that were really sent, on either plane |
| `test/mock/*.mock.ts` · offline gateway | §9's shape table | a plane × protocol × family sends a path, query or wire header its endpoint would refuse, or the mock answers a request the vendor would refuse |
| `test/mock/plane-dispatch.mock.ts` · the plane adapter | I1–I4 | a characterized model on either plane reaches a path, model or credential header other than its protocol's, through the real `LlmRuntime` |
| `keyless-matrix.e2e.ts` · live, keyless | I3 | a cell the default sends to answers 404, or a free model is not parsed on the default completions path |
| `keyed-probes.e2e.ts` · live, keyed | I1, I3 | a default-family cell answers path-gone, wrong-protocol or auth-refused with the plane's own key, a retired model another shape of the same protocol accepted, or nothing readable: `other`, a redirect, a refused session, `transport-error`, `no-model`. Flip evidence only when the cell `endpoint: legacy` dispatches to, a different one, accepted what the default cell refused (§13) |
| `endpoint-family.test.ts` | I3 | `auto` stops meaning the pinned family, legacy stops mapping a protocol on a plane, or a setting moves a plane entry another plugin owns (D27) |
| `host-discovery.test.ts` · Settings' fetch on the real host | I1 | a plane's fetch misses a servable catalog model, or offers one the plane adapter does not list, validate and send once saved |
| coverage ratchet | — | a new branch of the plane model or profile is added without a test (both are held at 100%) |

## 6. Refactor (done, then superseded)

> Superseded by P-R1 (§3): the (plane, protocol) route table this section built is gone, because one route per plane now serves every protocol. Kept as the record of why the plane had to be a key.

The gap was structural, not a missing branch: **the plane was not part of a route's definition.** `responses-provider.ts` held one base URL for every route it mounted, and `responses-routes.ts` keyed its table by protocol alone, so a Go model could not be described at all. The fix was to make the plane a key rather than a constant — `ROUTE_FOR_PLANE_PROTOCOL` now carries a base URL per plane, and the mount reads the catalog and the credential from the same one.

1. Key the route table by (plane, protocol). `ROUTE_FOR_PLANE_PROTOCOL[plane][protocol] → route`, replacing `ROUTE_FOR_PROTOCOL`. The Zen rows keep their current ids; the Go rows are new.
2. Give every route its plane. A route descriptor carries `{ id, plane, protocol }`, and the mount reads the base URL, catalog and credential **from the plane** rather than from a module constant.
3. Make `internalRouteFor` plane-aware. It currently returns `undefined` for any provider but `opencode`; it must resolve both planes, and still return `undefined` for a model with no mapped protocol.
4. Register the Go routes and add them to `DEFAULT_PROVIDERS`.
5. No behaviour change for Zen. Verified by the suite rather than by inspection: the Zen route ids, the models mounted on each and the base URL they carry are all asserted, and the refactor changed no test that covers them.

## 7. Verification

- The §5 guards. The plane × SDK case was written first and **failed against the code as it was** - `opencode-go + @ai-sdk/openai` and `+ @ai-sdk/anthropic` - then passed once the Go routes landed, which is what makes it a check rather than a restatement.
- `pnpm run test:mock` — the offline gateway mock (`test/mock/`): a Vite dev server that answers every endpoint in its own wire format and refuses a request whose shape its endpoint does not accept — an unknown path, a model sent to an endpoint that cannot speak its format, a missing session header, a placeholder credential. It drives the real path (pi's protocol implementation → `patchFetch` → the mock) across both planes, all four protocols and both endpoint families, so §9's table is exercised rather than quoted. No key and no network, so it gates every push.
- `pnpm run test:e2e` with keys present. The probe now takes the plane, and one case sends a real request to the Go base with the Go credential, asserting only that the gateway PARSED the model - any answer but 404 or 500 - so the case does not bet on an entitlement. What spends a key is tiered by `OPENCODE_E2E_KEYED`: `none` spends no key, so only the keyless cases run (the keyless matrix, the free probe, and the keyless cases of protocol-routing and opencode-live), `probes` adds the minimal keyed probes (`keyed-probes.e2e.ts`), and `full` — the default when it is unset, what CI runs nightly, and what a dispatch runs unless its `keyed` input says otherwise (the nightly bump proposal's floor-cell dispatch passes `none`) — adds the full keyed suites. CI runs `probes` on a pull request that touches `src/host/**`, `src/utils/protocols.ts` (the legacy URLs the probes send and the protocol each probe model speaks), `src/utils/plane-model.ts` (the family the plugin dispatches to, `AUTO_ENDPOINT_FAMILY`, which the probes must keep matching), `src/identity.ts` (the CLI version in the user agent the probes carry), `src/utils/request-shape.ts` (the `anthropic-version` every Messages probe sends) or the probes' own inputs (the composite setup action under `.github/actions/` among them), `full` nightly, a dispatch's `keyed` input (`full` when empty) on a dispatch, and `none` otherwise. Nothing else arms them. Left out, and covered by the offline suite and the nightly run, which arms everything: the generated catalog (`src/catalog-data.ts`) and the live model choice (`src/models-catalog.ts`), which pick the probes' modern URLs and models and whose paths the keyless matrix checks on every pull request; and the `OPENCODE_UA` alias in `src/session.ts`, which a turn and a probe share, so `test/keyed-probes.test.ts` holds the probe's identity to the real fetch patch offline.
- The Zen plane compared before and after: route ids, mounted model ids and base URLs must be byte-identical.

## 8. The full path, front to back

One model, every stage. The left column is what a user can see; the right column is what makes it happen.

| # | The user sees | What runs | Where |
| --: | :-- | :-- | :-- |
| 1 | a model in the picker | the picker lists the plane's declared models, or its servable catalog when the entry declares none (D3), with the generated shim answering cold and `models.opencode.ai` refreshing it. Settings' fetch offers pi's list plus the catalog models pi lacks | `catalog-data.ts` → `models-catalog.ts` → `utils/plane-profile.ts` (picker) · `models-discovery.ts` (Settings' fetch) |
| 2 | _(invisible)_ | each row carries the SDK the vendor ships (`provider_npm`). Nothing in the UI names it, and nothing the user sets can contradict it | the catalog |
| 3 | one model selected | the composer sets `provider` + `model`; no route, protocol or endpoint appears anywhere in the interface | the host |
| 4 | a turn starts | `llm/stream` fires; the hook claims the turn only for the routes this plugin declares, and leaves every other provider alone | `stream-hook.ts` |
| 5 | _(invisible)_ | the session id is derived from `ses_` + the session's real `createdAt` + a hash suffix, and the session's `cwd` becomes the project name | `session.ts` · `cordis-context.ts` |
| 6 | _(invisible)_ | **the model object is built**: `(plane, SDK) → protocol → base`, with metadata from the user's row first, then the catalog, then pi (D16, D17) | `utils/plane-profile.ts` → `utils/plane-model.ts` |
| 7 | _(invisible)_ | the plane's adapter is the plugin's own subclass of the host's `PiAiAdapter`, registered for the plane route, with that plane's catalog and the credential pi-ai's own rule resolves (D20) | `host/route-claim.ts` → `host/plane-provider.ts` |
| 8 | _(invisible)_ | the request is intercepted and given what the gateway expects: origin proof (the client, the project, and the turn's message id), `x-opencode-session` always, parent-session lineage, and the free-tier `read`/`bash` schemas when the body lacks them | `fetch-patch.ts` · `tool-fallback.ts` |
| 9 | the reply streams in | the gateway answers; the plugin has changed nothing about the response | — |
| 10 | a spend figure | the turn's usage event is priced per **plane**, so a Go turn and a Zen turn never share one number | `session-cost.ts` · `usage.ts` |
| 11 | a quota ring or a spend pill | the meter polls the host service and renders the affecting window, or the session spend | `usage-pill.tsx` · `usage-panel.tsx` · `usage-ui.ts` |
| 12 | a settings card | the same store feeds the configuration card; the meter's own switch is the only control that turns it off | `settings-page.tsx` · `settings-card.tsx` |

Read the table as a chain of guarantees. Steps 1–3 are why the front end is one list; 4–8 are why it works without configuration; 9–12 are why the result is legible. Break any link and the failure surfaces somewhere far from its cause:

| Broken link | What the user sees |
| :-- | :-- |
| Step 2 without step 6 | The row is offered on a shape nothing serves. A Go responses model sent to completions answers `500`, and the row that caused it looks exactly like a working one. This is the gap in §2. |
| Step 6 without step 7 | The model object is right and nothing serves it: the plane stays pi-ai's, and a model pi does not carry answers "model not found" at dispatch. |
| Step 7 without step 8 | A correct endpoint answers `403 FreeTierError` or `400 MissingSessionID`, which reads as an account problem rather than a missing header. |
| Step 8 without step 10 | The meter prices a plan-included turn as if it were paid, because the plane never reached the accumulator. |
| Step 10 without step 11 | The number is right and invisible, which is indistinguishable from not tracking it at all. |

The whole design follows from one sentence: the user picks a _model_, and everything else (plane, protocol, endpoint, credential, headers) is derived from facts the vendor ships, so that no part of it can be configured into disagreement with another part.

## 9. What a self-built provider must carry

Measured 2026-10-10 by building one with pi's own protocol implementations and intercepting the request it produced. Four protocols, four URLs, no rewrite of any wire format:

| Model's `api` | URL the gateway receives | Auth |
| :-- | :-- | :-- |
| `openai-responses` | `…/{family}/responses` | `Authorization: Bearer` |
| `openai-completions` | `…/{family}/chat/completions` | `Authorization: Bearer` |
| `anthropic-messages` | `…/{family}/messages?beta=true` | `x-api-key` |
| `google-generative-ai` | `…/{family}/models/<id>:streamGenerateContent?alt=sse` | `x-goog-api-key` |

`{family}` stands for the family root from §1 — `…/zen/v1` on the legacy endpoint, `…/inference/openai/v1` on the modern one — and the paths are the same on both. **The base URL is per protocol, not per plane.** The Anthropic SDK appends its own `/v1/messages`, so its base is one level shorter than the others — the family root without its `/v1`. That is not derivable from the protocol name; it is a property of each SDK, and pi's own `opencode` provider records it per model.

**The Google path is the one a hand-declared route cannot reach.** Its protocol name is not in the wrapper's three-entry table, so no route may name it; a self-built provider dispatches to it without any special case — which is what the plane adapter is (`buildPlaneProvider`, P-R1).

**The session header reaches every protocol, and the rest of the gateway headers do not come from the provider.** `buildPlaneProvider` wraps each `api` with pi's own `withOpenCodeSessionHeader` before `createProvider`, and that is all it adds per call: pi's wrapper sets `x-opencode-session` from the turn's session id on all four protocols, and steps aside when the request already carries one. `x-opencode-client`, `x-opencode-project`, the derived `ses_` id and the User-Agent are set by the global fetch patch on the request the protocol sends, not on the call's options; moving them into each call (`options.headers`) is P10a's first move.

**The User-Agent is one value on every protocol, Google's included.** The Google implementation sets an agent string of its own inside the protocol, but the fetch patch sets `User-Agent` on the request that protocol sends, which replaces whatever pi and the Google SDK put there rather than appending to it. The offline mock pins the wire value to `OPENCODE_UA` for the Google protocol on both planes (`test/mock/protocol-compat.mock.ts`), so the gateway never sees a combined value, and §13's keyed Google cells measure the agent string a turn actually sends. The question reopens only if P10a moves the agent into each call's options instead of the fetch patch.

## 10. A catalog route serves every protocol already

Measured 2026-10-10 by reproducing what `reuseCatalogProvider` builds — the catalog provider's `stream`, our model list — and intercepting the request.

A route that names a catalog provider and declares **neither `api` nor `baseURL`** keeps each model's own protocol and its own endpoint:

| Model | Protocol resolved | URL |
| :-- | :-- | :-- |
| `gemini-3.8-flash` | `google-generative-ai` | `…/zen/v1/models/…:streamGenerateContent?alt=sse` |
| `claude-opus-5` | `anthropic-messages` | `…/zen/v1/messages?beta=true` |
| `gpt-5.4` | `openai-responses` | `…/zen/v1/responses` |
| `big-pickle` | `openai-completions` | `…/zen/v1/chat/completions` |

The resolution is three lines of the wrapper's own model materialization: `api` falls back `route.api` → the model's catalog entry → the route's shared protocol, and `baseURL` falls back the same way. Because the entry is spread rather than enumerated, the model also inherits pi's compatibility quirks, model headers and reasoning spellings.

**So the fix is smaller than a takeover.** A route declaring an `api` pins every model on it to one protocol, which is why `@ai-sdk/google` had nowhere to go; leaving `api` and `baseURL` off the route lets each model speak for itself. One catalog route per plane covers every model pi knows, and the hand-declared routes are needed only for models the installed catalog does not describe.

**Declaring `baseURL` on that route would break it.** It overrides every model's endpoint, and the Anthropic SDK appends its own `/v1/messages` — the route would send every Messages model to `…/v1/v1/messages`.

## 11. Why the protocol table is narrow, and who unblocks Google

Two constraints meet at `@ai-sdk/google`, and both are now measured.

**A hand-declared route may only name a protocol in the wrapper's table.** That table holds three entries. Its own comment says why the rest are absent:

> The remainder are absent for want of a consumer rather than a blocker: each is one line here once a deployment needs it. Catalog routes still reach every protocol through their own provider; only an explicit override is refused.

The narrow part is deliberate and correct: Bedrock signs with SigV4, Vertex needs a project and a location, Azure needs an api-version, Codex authenticates through OAuth. None of those fit a route described by a key, an endpoint and headers. `google-generative-ai` is not in that group — it needs an API key and a base URL, both of which a route already carries, and its key travels in `x-goog-api-key`, which this plugin has measured end to end.

**A catalog route reaches every protocol, but only under the catalog's own name.** `catalogProvider(provider)` is a map lookup by route key, so a route reusing the `opencode` catalog must itself be called `opencode`. That name is already taken by whatever the deployment declared, and `registerAdapter` refuses a second registration for a provider another registration owns. So a plugin loading after the wrapper cannot claim the name: it never sees that registration's handle, and `handle.replace` — the documented way to give a route back — needs the handle it never got.

**So the unblock is upstream, and it is one line.** Adding `'google-generative-ai': googleGenerativeAIApi` to the wrapper's table is the change its own comment anticipates, and it makes the seven Google models servable through the hand-declared route mechanism this plugin already has. Until then they stayed in `UNSERVED_SDKS`, a decision the code stated rather than a model that silently disappeared; §12 is how they were served without it, and the set is gone.

## 12. The bridge that shipped, and what replaced it

Section 11 ended on "the unblock is upstream, and it is one line." Upstream could not be waited on, and the same measurement that closed the other doors opened one more: a plugin may register its own adapter on the real `llm` service. `google-bridge.ts` was that adapter, under the hidden route `opencode-google`, and it served the Gemini models until P-R1.

P-R1 (D13) took the bridge's construction and applied it to the whole plane. The plugin's adapter is a subclass of the wrapper's own `PiAiAdapter` — so the request translation, the snapshot discipline and the retry handling are still the wrapper's — and its provider is built with pi's own `createProvider` over all four of pi's protocol implementations, each wrapped with pi's own session header. It is registered for `opencode` and `opencode-go` themselves, which §11 said a later plugin could not claim; it can, because an `internal/config` listener hands `llm-pi-ai` a copy of its configuration without the two planes, so pi-ai never registers them and their names are free. Settings still reads and writes the planes in pi-ai's own `providers` block (one read-only `settings.describe` wrapper grafts the committed entries back, D18).

What carried over from the bridge, and why:

- **The credential is the deployment's own**, resolved by pi-ai's exact rule (D20): a named reference through the credentials service when one is mounted, the launch environment only when none is, and a miss that fails loud with `MISSING_CREDENTIAL` before any request.
- **The route names stay the vendor's.** No `google` route is taken; there are no hidden routes at all.
- **A Go Gemini turn's replay state carries `provider: "opencode-go"`**, the label it is replayed under, so a signed tool call replays natively and the translators that bridged two labels (`utils/google-replay.ts`) are gone — decided by a mock-gateway replay test (`test/mock/plane-dispatch.mock.ts`).
- **A Gemini model's thinking control is pi's own (D26).** Google has two thinking controls and a model accepts only its own: a level model refuses a token `thinkingBudget` with 400 INVALID_ARGUMENT ("Thinking budget is not supported for this model. Use thinking level instead.", measured live on Go `gemini-4-argon`). pi decides which control a request carries by its own rule (`usesGoogleThinkingLevel`), which names Gemini 4 from pi `1.3.0` on; the plugin sends what the host's pi builds and re-derives nothing. pi `1.1.0`, the `rc` channel's floor and its desktop app's pi, does not name it, so every `gemini-4-argon` turn there carries a thinking budget on either plane, a token budget for a chosen effort and `thinkingBudget: 0` (pi's disable) when none is chosen, which that model cannot honour since it cannot turn thinking off (the rule reads the model id, not the plane; the refusal is measured live on Go, and Zen's, expected under the same rule, is not yet measured): a `[HOST_LIMITATION]` row (`test/host-characterization.test.ts`, and the binary e2e's floor cell), reported upstream, with the mock and live cases that need the level skipping by pi's own predicate. A profile that declares Off for a level model gets pi's own disable, `thinkingBudget: 0`; a model that cannot turn thinking off (`gemini-4-argon`) refuses it, so declaring Off there is a profile error.

What is verified, and in what composition: the in-process characterization (`test/host-characterization.test.ts`) and the real-host suite (the `test/host-planes*.test.ts` files) run the plugin on the real `llm` service and `llm-pi-ai` in both apply orders, and the binary e2e (`test/e2e/host-binary.e2e.ts`) runs the built bundle on a published host, asserting, in every cell, that both planes are the plugin's `PlaneAdapter` and that a Go Gemini turn is sent to `https://opencode.ai/inference/go/google/v1beta`, with a `thinkingLevel` and no `thinkingBudget` wherever the host's pi names the model (the `[HOST_LIMITATION]` row above elsewhere). The route claim engages on both cordis cores: the OLD one (`4.0.5`, the `0.2.1` builds) binds the fiber as the `internal/config` listener's `this`, the NEW one (`4.0.6-alpha.2`, `4.1.0`, every cell of both channels' newest builds) passes it first with `this` null, and the claim reads either from the call (`src/utils/config-run.ts`). The probe counts the shape of every dispatch, and a `[BASELINE]` row asserts one known shape and both planes on the plugin's `PlaneAdapter`; it was a `[KNOWN_DEFECT]` row, pi-ai serving both planes on the NEW core, until the claim spoke that shape.

## 13. Measured: which endpoint families the gateway serves

P-R2 probes three URL shapes on both planes, for all four protocols:

| Shape | Zen | Go | Sent to by |
| :-- | :-- | :-- | :-- |
| legacy | `/zen/v1/…` | `/zen/go/v1/…` | `endpoint: legacy`, except Go's Google |
| root | `/inference/v1/…` | `/inference/go/v1/…` | nobody; measured only. A route-level `baseURL` on it selects modern |
| modern | `/inference/{openai,anthropic,google}/…` | `/inference/go/{openai,anthropic,google}/…` | `auto`, `modern`, and Go's Google under every setting |

The root shape is the provider-level base `models.opencode.ai` declared for each plane until the catalog regeneration of 2026-10-16 ([engineering notes, "The endpoint chain"](./engineering-notes.md#the-endpoint-chain-read-out-of-the-client-instead-of-inferred)); the catalog now declares the modern completions base (`OPENCODE_PLANE_API` in `src/catalog-data.ts`). Nothing the plugin sends goes there, so its cells are recorded and never asserted on their own: a root path that moves cannot fail a pull request.

**The default is `modern`, and P-R2 keeps it.** `auto` resolves to `AUTO_ENDPOINT_FAMILY`, and `test/endpoint-family.test.ts` pins it. The flip rule: a keyed modern cell (`*` below) that answers `path-gone`, `wrong-protocol` or `auth-refused` with the plane's own key turns the live job red. Each modern cell is read beside the legacy and root cells of the same plane and protocol, which carry the same model and key, and the run is flip evidence — the evidence for P-R2b, the `fix:` that flips the default, one value, with the copy, `TODAY_DISPATCH` and the re-tagged wire facets in the same change — when the modern cell answers `wrong-protocol`, `path-gone`, `auth-refused` or `model-gone` while the cell a flip would send the same plane and protocol to (the `†` cell, when it is not the modern cell itself) accepted the request (`served` or `path-exists`; beside a refused key or a gone path `account` counts too, since it shows the key was read and the path exists, but not beside a refused protocol or model, since the account's gate answers before the format check and the model's routing). A modern `model-gone` beside any shape that accepted the model (`served` or `path-exists`) turns the job red too: the gateway answers "Model is unavailable" for an id sent where it is not served, so a model another shape accepts is the modern family refusing it. A refusal that only the root, or the `/zen/go` cell of Go's Google (which stays modern under every family), accepted turns the job red but is not flip evidence: no flip reaches that shape. Nor is a refusal no other shape accepted, and each other shape counts only for what it measured: a key refused on every shape that read it is the CI secret, a key no other shape read measured nothing else (a gone path answers before the key is read; a rate limit or a busy upstream may too), a protocol or a path the `†` cell refused too is one a flip would not serve (and Go's Google, which no flip moves, is always that), and a protocol or a path the `†` cell measured nothing about (a rate limit, a busy upstream, the account's gate, no answer, an unreadable one) asks for a re-run — all red, none flip evidence. A keyed modern cell that answers nothing readable — `other`, `redirected`, `session-refused`, `transport-error`, `no-model` — also turns the job red, but says nothing about the family; and a plane none of whose modern cells was `served` (the account's answer, a rate limit, a busy upstream, a retired model no other shape accepted, a parsed but refused body) skips, since it measured nothing.

**`endpoint: legacy` is recorded, not guarded.** Its cells (`†` below) are probed keyless and keyed and their verdicts printed; the keyless matrix requires a legacy answer to be readable (an unreadable one, or none, is a matrix that measured nothing), but no live assertion reads a `†` cell's path-gone — except Go's Google, which is also a default cell (`* †`) and is guarded as one; what guards the configuration is the offline pin that it maps every protocol on both planes (`test/endpoint-family.test.ts`).

How to read a cell. Each is the verdict, then the HTTP status:

- **Keyless** (no credential; one PAID model per plane and protocol): `path-gone` is a 404, the path does not exist; `path-exists` is a 401 or 403, or a 400 that is not about the model; `model-gone` is a 410, a 400 "Model is unavailable", or a refusal of type `ModelDeprecated` at any status (read before the 404, so a withdrawn model never reads as a gone path); `redirected` is a 3xx, which no probe follows, and its cell names the path it pointed at (`redirected (308 → /…)`); `other` is anything else; `no-model` means the live catalog had no paid model for the protocol, so nothing was sent.
- **Every table** (a probe is retried once after a 429 other than the usage cap, a 5xx or no answer): `rate-limited` is a rate-limit 429 on the last attempt, or a 429 and then no answer — the gateway's measured rate-limit hang; `transport-error` is no answer on the last attempt, unless an earlier one was a 429 (no answer after a 5xx or a busy upstream is `transport-error` too: only the 429 hang is measured); the free tier's usage cap, a `429 FreeUsageLimitError`, is `free-usage-limited` on every table, never retried and never `rate-limited`.
- **Free** (one free completions model, keyless, on the default completions path): `served` or `free-tier-gated` (a `403 FreeTierError`: the free tier parsed the request) pass; `rate-limited` skips, and so does `free-usage-limited`, a `429 FreeUsageLimitError` — the tier's usage cap refusing the caller, which is the gate's decision rather than a rate limit, so it is neither retried nor read as served (L3 in the plan's lessons); `wrong-format`, `auth-required`, `path-gone`, `redirected`, `other` (a 500 or 502 included) and `transport-error` fail; `model-gone` and `upstream-busy` (a 503, a 529 or a 5xx whose body names an overload: the free model is the one keyless request that reaches the upstream) move on to the next free model — `model-gone` being a 410, a 400 "Model is unavailable", or a refusal of type `ModelDeprecated` at any status (measured as a 400 for a model the catalog still listed); when every candidate moved on, a busy one among them skips, and the line names that busy candidate's model and status; three retired ones fail; `not run` means the run never reached the probe.
- **Keyed** (the plane's own key, in the header the protocol reads, with the identity headers the fetch patch puts on a turn, its user agent included; on Go that is `OPENCODE_GO_API_KEY`, the key a Go entry naming `apiKeyEnv: OPENCODE_GO_API_KEY` sends — README step 3 — not the Zen key a Go entry without it sends, which these probes do not measure, nor a plane entry another plugin owns, D27, which pi-ai sends with that plugin's credential and none of these headers): `served` is a 2xx; `path-exists` a 400 about the content; `wrong-protocol` a `400 ModelProtocolUnsupported`; `auth-refused` a 401 or 403 with the key; `session-refused` the request's session refused (`MissingSessionID`, or a `FreeTierError` on a paid model); `free-usage-limited` a `429 FreeUsageLimitError`, the free tier's usage cap, which only a keyless free row meets and which, like a rate limit, neither fails nor passes a plane (L3); `account` no funds or a model the account may not use, which shows the key was read and the path exists, but nothing about whether the path serves the protocol or the model; `path-gone` a 404 whose body names no model, and `model-gone` a refusal of type `ModelDeprecated` at any status, a 410, a 400 "Model is unavailable" or a 404 whose body names a model — Anthropic's `not_found_error` with a `model: …` message, `model_not_found`, or Gemini's `models/<id> is not found`; Anthropic's bare `not_found_error`, which every Anthropic 404 carries, is `path-gone` (a keyed request can reach the upstream); `upstream-busy` a 503, a 529 or a 5xx whose body names an overload — the upstream was busy, or the gateway's front answered before reading the request, so like a rate limit it neither fails nor passes a plane, and never counts as a shape accepting the request; `redirected` and `other` as keyless, a 500 or 502 included; `no-key` means the run had no key for that plane.
- `*` marks a cell the default family dispatches to (`TODAY_DISPATCH`), `†` one `endpoint: legacy` dispatches to (`LEGACY_DISPATCH`), and `not sent` a cell the run did not reach.

Three records sit beside the tables, each measured and never asserted (the plan's lessons L4, L5, L9, L10 and L13, and the console study's OC6, OC8 and OC9, whose rows feed an owner's OC6 decision, the session derivation's OC9 and P6's OC8):

- **System One** (keyless, the Zen plane only, no model named): TypeSafe's classification protocol on its three shapes, `/zen/v1/systemone`, `/inference/v1/systemone` and `/inference/systemone/v1/systemone`, read as the keyless matrix reads a cell. The plugin serves no classifier, so nothing dispatches there.
- **Keyed variants** (each plane's default completions cell with its own key): the probe identity (no `x-opencode-request`, `x-opencode-project: global`) beside one change each — a minted `x-opencode-request` in the client's `msg_` shape, `x-opencode-project` as a folder name and as a 40-hex digest — and a paid completions model that reasons, sent with no `reasoning_effort` and with `"none"`. Beside them, the console study's rows: a raw session id (the host's own `session-<uuid>`, with a tail outside the `ses_` band, not a `ses_` id) under both session headers (OC9), the session-only header set, `x-opencode-session` without `x-opencode-client`, `x-opencode-project` or `x-opencode-session-id` (OC8), and the harness's own `User-Agent` in place of the CLI's (OC6); and a free completions model sent with NO key and the body the plugin's free turn sends (`read`, `bash`, `tool_choice: "none"`), as the probe identity, with a raw session id, and with the harness's `User-Agent` — the only keyless requests in the keyed tier. Each answer is read as a keyed cell, recorded and never asserted. On a keyless row, `auth-refused` means the gateway's key gate answered a request that carried no key (L8's `401` "Invalid API key" for a session id it reads as malformed among them), not that a key was refused, `session-refused` is the free tier's `FreeTierError`, and `free-usage-limited` is the tier's usage cap: a row that answers `free-usage-limited` reached the usage gate only, so it measured nothing about OC6, OC9 or L7, and a `session-refused` on the raw-session or harness-`User-Agent` free row is OC9's or OC6's answer only when the free baseline beside it answered otherwise. The free baseline is also L7's live evidence for `tool_choice: "none"`, which the mock gateway does not judge: a `path-exists` (a 400 about the body) or `other` there, on a plane with a free model, points at it first. `auth-refused`, `free-usage-limited` or `rate-limited` mean the gateway answered before it judged the field, and a `session-refused` cannot tell a gate that stopped counting the tools from one that refuses the request outright (the README records the free tier refusing even the official client's full request), so after any of them L7 is still unmeasured. The row's body is in the job log's console table, not here.
- **`Retry-After`**: the header of every keyed 429, matrix and variants alike, or `absent`. The keyless free rows and the free tier's usage cap are left out: neither is a keyed rate limit.

The CI `e2e` job writes these tables to its run summary and to the `endpoint-families` artifact (`test/support/endpoint-record.ts` formats them). A run's tables are pasted here with their date and run link; they are never hand-written, and `test/endpoint-record.test.ts` holds this section to the formatter's columns and row order.

### Keyless · measured 2026-11-14 (UTC) · [run 43542273415](https://github.com/viztor/dsh-opencode-patch/actions/runs/43542273415)

| Plane | Protocol | Model | `/zen(/go)/v1` (legacy) | `/inference(/go)/v1` (root) | `/inference(/go)/{openai,anthropic,google}/…` (modern) |
| :-- | :-- | :-- | :-- | :-- | :-- |
| `opencode` | `openai-completions` | `minimax-m3` | path-exists (401) † | path-exists (401) | path-exists (401) * |
| `opencode` | `openai-responses` | `gpt-5.3-codex-spark` | path-exists (401) † | path-exists (401) | path-exists (401) * |
| `opencode` | `anthropic-messages` | `claude-opus-4-5` | path-exists (401) † | path-exists (401) | path-exists (401) * |
| `opencode` | `google-generative-ai` | `gemini-3.7-flash` | path-exists (401) † | path-exists (401) | path-exists (401) * |
| `opencode-go` | `openai-completions` | `mimo-v2.5-pro` | path-exists (400) † | path-exists (400) | path-exists (400) * |
| `opencode-go` | `openai-responses` | `muse-spark-1.3-contributor` | path-exists (400) † | path-exists (400) | path-exists (400) * |
| `opencode-go` | `anthropic-messages` | `minimax-m3` | path-exists (400) † | path-exists (400) | path-exists (400) * |
| `opencode-go` | `google-generative-ai` | `gemini-4-argon` | path-gone (404) | path-exists (400) | path-exists (400) * † |

Free model on `/inference/openai/v1/chat/completions`: `flint-40b-free` → free-usage-limited (429).

System One on the Zen plane, keyless (nothing dispatches there): `/zen/v1/systemone` (legacy) → path-exists (400); `/inference/v1/systemone` (root) → path-exists (400); `/inference/systemone/v1/systemone` (modern) → path-exists (400).

### Keyed · measured 2026-11-14 (UTC) · [run 43542273415](https://github.com/viztor/dsh-opencode-patch/actions/runs/43542273415)

| Plane | Protocol | Model | `/zen(/go)/v1` (legacy) | `/inference(/go)/v1` (root) | `/inference(/go)/{openai,anthropic,google}/…` (modern) |
| :-- | :-- | :-- | :-- | :-- | :-- |
| `opencode` | `openai-completions` | `minimax-m3` | account (403) † | account (403) | account (403) * |
| `opencode` | `openai-responses` | `gpt-5.3-codex-spark` | account (403) † | account (403) | account (403) * |
| `opencode` | `anthropic-messages` | `claude-opus-4-5` | account (403) † | account (403) | account (403) * |
| `opencode` | `google-generative-ai` | `gemini-3.7-flash` | account (403) † | account (403) | account (403) * |
| `opencode-go` | `openai-completions` | `mimo-v2.5-pro` | model-gone (410) † | model-gone (410) | model-gone (410) * |
| `opencode-go` | `openai-responses` | `muse-spark-1.3-contributor` | served (200) † | served (200) | served (200) * |
| `opencode-go` | `anthropic-messages` | `minimax-m3` | served (200) † | served (200) | served (200) * |
| `opencode-go` | `google-generative-ai` | `gemini-4-argon` | path-gone (404) | served (200) | served (200) * † |

### Keyed variants · pending the first CI run

| Plane | Probe | Lesson | Model | `/inference(/go)/openai/v1/chat/completions` |
| :-- | :-- | :-- | :-- | :-- |
| `opencode` | the probe identity: no `x-opencode-request`, `x-opencode-project: global` | L4, L5 | pending | pending |
| `opencode` | `x-opencode-request: msg_…` | L4 | pending | pending |
| `opencode` | `x-opencode-project: <folder name>` | L5 | pending | pending |
| `opencode` | `x-opencode-project: <40 hex>` | L5 | pending | pending |
| `opencode` | a reasoning model, no `reasoning_effort` | L10 | pending | pending |
| `opencode` | `reasoning_effort: "none"` | L10 | pending | pending |
| `opencode` | a raw session id (the host's `session-<uuid>`, not `ses_…`) | OC9 | pending | pending |
| `opencode` | `x-opencode-session` only: no `x-opencode-client`, `x-opencode-project` or `x-opencode-session-id` | OC8 | pending | pending |
| `opencode` | the harness's `User-Agent` | OC6 | pending | pending |
| `opencode` | a free model, no key: the probe identity and the free turn's body | OC6, OC9 | pending | pending |
| `opencode` | a free model, no key: a raw session id | OC9 | pending | pending |
| `opencode` | a free model, no key: the harness's `User-Agent` | OC6 | pending | pending |
| `opencode-go` | the probe identity: no `x-opencode-request`, `x-opencode-project: global` | L4, L5 | pending | pending |
| `opencode-go` | `x-opencode-request: msg_…` | L4 | pending | pending |
| `opencode-go` | `x-opencode-project: <folder name>` | L5 | pending | pending |
| `opencode-go` | `x-opencode-project: <40 hex>` | L5 | pending | pending |
| `opencode-go` | a reasoning model, no `reasoning_effort` | L10 | pending | pending |
| `opencode-go` | `reasoning_effort: "none"` | L10 | pending | pending |
| `opencode-go` | a raw session id (the host's `session-<uuid>`, not `ses_…`) | OC9 | pending | pending |
| `opencode-go` | `x-opencode-session` only: no `x-opencode-client`, `x-opencode-project` or `x-opencode-session-id` | OC8 | pending | pending |
| `opencode-go` | the harness's `User-Agent` | OC6 | pending | pending |
| `opencode-go` | a free model, no key: the probe identity and the free turn's body | OC6, OC9 | pending | pending |
| `opencode-go` | a free model, no key: a raw session id | OC9 | pending | pending |
| `opencode-go` | a free model, no key: the harness's `User-Agent` | OC6 | pending | pending |

The variants table waits for the first run on the formatter that carries the console study's rows. [Run 43542273415](https://github.com/viztor/dsh-opencode-patch/actions/runs/43542273415) measured the twelve lesson rows under the formatter before them, so its variants table is not pasted here; the plan's P-R3 entry quotes its L10 pair. Its `Retry-After` line, which covers its keyed table and those twelve rows:

`Retry-After` on a keyed 429: no 429 was answered.
