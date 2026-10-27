# Redirect planes: the specification

> This is the specification; the implementation is in [`protocol-routing-and-merge.md`](./protocol-routing-and-merge.md).

The authority for how this plugin sends a model to the endpoint that serves it. `protocol-routing-and-merge.md` describes what the code does today; **this document says what it must do**, and the tests below are how the two are held together. Measured 2026-10-09 against `models.dev`.

## 1. Planes

A **plane** is one gateway base URL with its own catalog and its own credential. There are two.

| Plane | Route id | Base URL | Credential | Models |
| :-- | :-- | :-- | :-- | --: |
| Zen (pay-as-you-go, free tier) | `opencode` | the `endpoint` family's | the entry's `apiKeyEnv`; without one, pi's `OPENCODE_API_KEY` | 81 served / 127 listed |
| Go (subscription) | `opencode-go` | the `endpoint` family's | the entry's `apiKeyEnv` (name `OPENCODE_GO_API_KEY`); without one, pi's `OPENCODE_API_KEY` | 30 served / 34 listed |

**There is no longer one base URL per plane to quote.** The gateway answers on two endpoint families and the `endpoint` setting picks one: `auto`, the default, is an alias of `modern` (`AUTO_ENDPOINT_FAMILY` in `src/utils/plane-model.ts`), the per-protocol `…/inference/{openai,anthropic,google}/…` and `…/inference/go/…`; `legacy` pins the older `…/zen/v1` and `…/zen/go/v1`, except Go's Google, which has no legacy base and stays on `…/inference/go/google/v1beta`. Which families answer, keyless and with each plane's own key, is measured in CI (§13), not assumed. The dated measurement below was taken on the legacy family.

A plane is a property of the **account and the base URL**, never of a model. The same model id can exist on both planes and be served on a different shape in each.

**The two numbers per plane are two different questions**, and stating only one of them is how this table contradicted the section below it: _served_ is what the shim ships after the registry's deprecated rows are dropped, and _listed_ is everything the registry carries for that provider, including the deprecated ones. The per-shape counts below are the served ones.

## 2. Shapes

A **shape** is one wire protocol, named by the SDK a model declares in the catalog (`provider.npm`). A model naming no SDK speaks its route's own protocol, which is OpenAI Chat Completions.

| SDK in the catalog  | Protocol               | Zen |    Go |
| :------------------ | :--------------------- | --: | ----: |
| _(none)_            | `openai-completions`   |  24 |    19 |
| `@ai-sdk/openai`    | `openai-responses`     |  31 | **5** |
| `@ai-sdk/anthropic` | `anthropic-messages`   |  17 | **5** |
| `@ai-sdk/mistral`   | `openai-completions`   |   1 |     — |
| `@ai-sdk/google`    | `google-generative-ai` |   8 | **1** |

**Absence is the signal, and it is a real one.** Both planes set a provider-level `npm` of `@ai-sdk/openai-compatible` in `models.dev`, and **no model declares it explicitly**: 0 of 81 on Zen, 0 of 30 on Go. A model that speaks the completions shape simply omits `provider.npm` and inherits it. So "no SDK" does not mean "unknown"; it means _the provider default_, which is the protocol the route was itself registered with.

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
| I1 | Every offered model is routable | If a model appears in the picker, its plane's route serves it on the shape its SDK names. This is the plugin's headline promise; the Go gap broke it once, and one route per plane closed it for good. |
| I2 | A route carries one plane | Its base URLs, its catalog and its credential all come from the same plane. Mixing them resolves to "model not found" against the route's own endpoint. |
| I3 | The endpoint is chosen from (plane, SDK) | Never from the SDK alone: the same SDK appears on both planes, on each plane's own base. |
| I4 | No SDK means completions | A model naming no SDK speaks `openai-completions`, and so does an id no catalog describes (D15), unless the plane entry names an `api` for it. |
| I5 | Every SDK the catalog names maps to a protocol pi implements | `PROTOCOL_FOR_SDK` (`src/utils/protocols.ts`) covers every SDK either catalog names, and nothing is unserved; a new SDK fails the guard rather than dropping its models. |

## 5. Guards

| Guard | Holds | Fails when |
| :-- | :-- | :-- |
| `catalog.test.ts` · SDK coverage | I5 | the catalog names an SDK `PROTOCOL_FOR_SDK` does not map |
| `catalog.test.ts` · plane × SDK coverage | I1, I2 | a catalog model resolves to a protocol other than its SDK's, or to a base off its own plane |
| `plane-model.test.ts` · protocol and base tables | I2, I3, I4 | a protocol, a family or a route-level base resolves to the wrong endpoint for its plane |
| `protocol-routing.e2e.ts` · live probe | I1, I3 | a protocol is declared routable without a path and an auth convention that were really sent, on either plane |
| `test/mock/*.mock.ts` · offline gateway | §9's shape table | a plane × protocol × family sends a path, query or wire header its endpoint would refuse, or the mock answers a request the vendor would refuse |
| `test/mock/plane-dispatch.mock.ts` · the plane adapter | I1–I4 | a characterized model on either plane reaches a path, model or credential header other than its protocol's, through the real `LlmRuntime` |
| `keyless-matrix.e2e.ts` · live, keyless | I3 | a cell the default sends to answers 404, or a free model is not parsed on the default completions path |
| `keyed-probes.e2e.ts` · live, keyed | I1, I3 | a default-family cell answers path-gone, wrong-protocol or auth-refused with the plane's own key, a retired model another shape of the same protocol accepted, or nothing readable: `other`, a redirect, a refused session, `transport-error`, `no-model`. Flip evidence only when the cell `endpoint: legacy` dispatches to, a different one, accepted what the default cell refused (§13) |
| `endpoint-family.test.ts` | I3 | `auto` stops meaning the pinned family, or legacy stops mapping a protocol on a plane |
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
- `pnpm run test:e2e` with keys present. The probe now takes the plane, and one case sends a real request to the Go base with the Go credential, asserting only that the gateway PARSED the model - any answer but 404 or 500 - so the case does not bet on an entitlement. What spends a key is tiered by `OPENCODE_E2E_KEYED`: `none` spends no key, so only the keyless cases run (the keyless matrix, the free probe, and the keyless cases of protocol-routing and opencode-live), `probes` adds the minimal keyed probes (`keyed-probes.e2e.ts`), and `full` — the default when it is unset, and what CI runs nightly and on dispatch — adds the full keyed suites. CI runs `probes` on a pull request that touches `src/host/**`, `src/utils/protocols.ts` (the legacy URLs the probes send and the protocol each probe model speaks), `src/utils/plane-model.ts` (the family the plugin dispatches to, `AUTO_ENDPOINT_FAMILY`, which the probes must keep matching), `src/identity.ts` (the CLI version in the user agent the probes carry), `src/utils/request-shape.ts` (the `anthropic-version` every Messages probe sends) or the probes' own inputs, `full` nightly and on dispatch, and `none` otherwise. Nothing else arms them. Left out, and covered by the offline suite and the nightly run, which arms everything: the generated catalog (`src/catalog-data.ts`) and the live model choice (`src/models-catalog.ts`), which pick the probes' modern URLs and models and whose paths the keyless matrix checks on every pull request; and the `OPENCODE_UA` alias in `src/session.ts`, which a turn and a probe share, so `test/keyed-probes.test.ts` holds the probe's identity to the real fetch patch offline.
- The Zen plane compared before and after: route ids, mounted model ids and base URLs must be byte-identical.

## 8. The full path, front to back

One model, every stage. The left column is what a user can see; the right column is what makes it happen.

| # | The user sees | What runs | Where |
| --: | :-- | :-- | :-- |
| 1 | a model in the picker | the generated shim answers before any network call, `models.dev` refreshes it, and the gateway's own listing is merged in additively, so a row is only dropped when the registry marks it deprecated | `catalog-data.ts` → `models-catalog.ts` → `models-discovery.ts` |
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

**The session header reaches every protocol.** Wrapping each `api` before `createProvider` puts our `x-opencode-session`, `x-opencode-client` and `x-opencode-project` on all four, and pi's own session header defers when ours is already present.

**One detail left open:** the Google implementation sets its own `User-Agent` inside the protocol, so ours arrives appended rather than replacing it (`pi (darwin …), opencode/1.19.4 …`). Whether the gateway accepts the combined value or wants a single agent string is unverified.

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
- **A Gemini model's thinking control comes from the catalog, not its id (D16).** pi 1.1.0 sends Google's discrete `thinkingLevel` only to ids its own pattern names (`usesGoogleThinkingLevel`: `gemini-3[.N]-pro|flash`, `gemini-flash[-lite]-latest`, `gemma-4`) and a token `thinkingBudget` to every other id, which a level model refuses with 400 INVALID_ARGUMENT ("Thinking budget is not supported for this model. Use thinking level instead.", measured live on Go `gemini-4-argon`); so a Google model whose catalog effort list is all `minimal`/`low`/`medium`/`high` (`usesCatalogThinkingLevels`) is served by level, from pi's own public exports, with the level pi itself falls back to when no effort is chosen, and every other id stays on pi's path (`src/host/google-levels.ts`). A profile that declares Off for such a model gets pi's own disable, `thinkingBudget: 0`, as pi's own level ids do; a model that cannot turn thinking off (`gemini-4-argon`) refuses it, so declaring Off there is a profile error.

What is verified, and in what composition: the in-process characterization (`test/host-characterization.test.ts`) and the real-host suite (`test/host-planes.test.ts`) run the plugin on the real `llm` service and `llm-pi-ai` in both apply orders, and the binary e2e (`test/e2e/host-binary.e2e.ts`) runs the built bundle on a published host, asserting that both planes are the plugin's `PlaneAdapter` and that a Go Gemini turn is sent to `https://opencode.ai/inference/go/google/v1beta` with a `thinkingLevel` and no `thinkingBudget`.

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

- **Keyless** (no credential; one PAID model per plane and protocol): `path-gone` is a 404, the path does not exist; `path-exists` is a 401 or 403, or a 400 that is not about the model; `model-gone` is a 410 or a 400 "Model is unavailable"; `redirected` is a 3xx, which no probe follows, and its cell names the path it pointed at (`redirected (308 → /…)`); `other` is anything else; `no-model` means the live catalog had no paid model for the protocol, so nothing was sent.
- **Every table** (a probe is retried once after a 429, a 5xx or no answer): `rate-limited` is a 429 on the last attempt, or a 429 and then no answer — the gateway's measured rate-limit hang; `transport-error` is no answer on the last attempt, unless an earlier one was a 429 (no answer after a 5xx or a busy upstream is `transport-error` too: only the 429 hang is measured).
- **Free** (one free completions model, keyless, on the default completions path): `served` or `free-tier-gated` (a `403 FreeTierError`: the free tier parsed the request) pass; `rate-limited` skips; `wrong-format`, `auth-required`, `path-gone`, `redirected`, `other` (a 500 or 502 included) and `transport-error` fail; `model-gone` and `upstream-busy` (a 503, a 529 or a 5xx whose body names an overload: the free model is the one keyless request that reaches the upstream) move on to the next free model; when every candidate moved on, a busy one among them skips, and the line names that busy candidate's model and status; three retired ones fail; `not run` means the run never reached the probe.
- **Keyed** (the plane's own key, in the header the protocol reads, with the identity headers the fetch patch puts on a turn, its user agent included; on Go that is `OPENCODE_GO_API_KEY`, the key a Go entry naming `apiKeyEnv: OPENCODE_GO_API_KEY` sends — README step 3 — not the Zen key a Go entry without it sends, which these probes do not measure): `served` is a 2xx; `path-exists` a 400 about the content; `wrong-protocol` a `400 ModelProtocolUnsupported`; `auth-refused` a 401 or 403 with the key; `session-refused` the request's session refused (`MissingSessionID`, or a `FreeTierError` on a paid model); `account` no funds or a model the account may not use, which shows the key was read and the path exists, but nothing about whether the path serves the protocol or the model; `path-gone` a 404 whose body names no model, and `model-gone` a 410, a 400 "Model is unavailable" or a 404 whose body names a model — Anthropic's `not_found_error` with a `model: …` message, `model_not_found`, or Gemini's `models/<id> is not found`; Anthropic's bare `not_found_error`, which every Anthropic 404 carries, is `path-gone` (a keyed request can reach the upstream); `upstream-busy` a 503, a 529 or a 5xx whose body names an overload — the upstream was busy, or the gateway's front answered before reading the request, so like a rate limit it neither fails nor passes a plane, and never counts as a shape accepting the request; `redirected` and `other` as keyless, a 500 or 502 included; `no-key` means the run had no key for that plane.
- `*` marks a cell the default family dispatches to (`TODAY_DISPATCH`), `†` one `endpoint: legacy` dispatches to (`LEGACY_DISPATCH`), and `not sent` a cell the run did not reach.

The CI `e2e` job writes these tables to its run summary and to the `endpoint-families` artifact (`test/support/endpoint-record.ts` formats them). A run's tables are pasted here with their date and run link; they are never hand-written, and `test/endpoint-record.test.ts` holds this section to the formatter's columns and row order.

### Keyless · pending the first CI run

| Plane | Protocol | Model | `/zen(/go)/v1` (legacy) | `/inference(/go)/v1` (root) | `/inference(/go)/{openai,anthropic,google}/…` (modern) |
| :-- | :-- | :-- | :-- | :-- | :-- |
| `opencode` | `openai-completions` | pending | pending † | pending | pending * |
| `opencode` | `openai-responses` | pending | pending † | pending | pending * |
| `opencode` | `anthropic-messages` | pending | pending † | pending | pending * |
| `opencode` | `google-generative-ai` | pending | pending † | pending | pending * |
| `opencode-go` | `openai-completions` | pending | pending † | pending | pending * |
| `opencode-go` | `openai-responses` | pending | pending † | pending | pending * |
| `opencode-go` | `anthropic-messages` | pending | pending † | pending | pending * |
| `opencode-go` | `google-generative-ai` | pending | pending | pending | pending * † |

Free model on `/inference/openai/v1/chat/completions`: pending the first CI run.

### Keyed · pending the first CI run

| Plane | Protocol | Model | `/zen(/go)/v1` (legacy) | `/inference(/go)/v1` (root) | `/inference(/go)/{openai,anthropic,google}/…` (modern) |
| :-- | :-- | :-- | :-- | :-- | :-- |
| `opencode` | `openai-completions` | pending | pending † | pending | pending * |
| `opencode` | `openai-responses` | pending | pending † | pending | pending * |
| `opencode` | `anthropic-messages` | pending | pending † | pending | pending * |
| `opencode` | `google-generative-ai` | pending | pending † | pending | pending * |
| `opencode-go` | `openai-completions` | pending | pending † | pending | pending * |
| `opencode-go` | `openai-responses` | pending | pending † | pending | pending * |
| `opencode-go` | `anthropic-messages` | pending | pending † | pending | pending * |
| `opencode-go` | `google-generative-ai` | pending | pending | pending | pending * † |
