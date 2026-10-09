# Redirect planes: the specification

> This is the specification; the implementation is in [`protocol-routing-and-merge.md`](./protocol-routing-and-merge.md).

The authority for how this plugin sends a model to the endpoint that serves it. `protocol-routing-and-merge.md` describes what the code does today; **this document says what it must do**, and the tests below are how the two are held together. Measured 2026-10-09 against `models.dev`.

## 1. Planes

A **plane** is one gateway base URL with its own catalog and its own credential. There are two.

| Plane | Route id | Base URL | Credential | Models |
| :-- | :-- | :-- | :-- | --: |
| Zen (pay-as-you-go, free tier) | `opencode` | `https://opencode.ai/zen/v1` | `OPENCODE_API_KEY` | 120 |
| Go (subscription) | `opencode-go` | `https://opencode.ai/zen/go/v1` | `OPENCODE_GO_API_KEY` | 36 |

A plane is a property of the **account and the base URL**, never of a model. The same model id can exist on both planes and be served on a different shape in each.

## 2. Shapes

A **shape** is one wire protocol, named by the SDK a model declares in the catalog (`provider.npm`). A model naming no SDK speaks its route's own protocol, which is OpenAI Chat Completions.

| SDK in the catalog  | Protocol                | Zen |    Go |
| :------------------ | :---------------------- | --: | ----: |
| _(none)_            | `openai-completions`    |  55 |    23 |
| `@ai-sdk/openai`    | `openai-responses`      |  32 | **7** |
| `@ai-sdk/anthropic` | `anthropic-messages`    |  24 | **6** |
| `@ai-sdk/mistral`   | `mistral-conversations` |   1 |     — |
| `@ai-sdk/google`    | _(none exists)_         |   8 |     — |

**Absence is the signal, and it is a real one.** Both planes set a provider-level `npm` of `@ai-sdk/openai-compatible` in `models.dev`, and **no model declares it explicitly** — 0 of 120 on Zen, 0 of 36 on Go. A model that speaks the completions shape simply omits `provider.npm` and inherits it. So "no SDK" does not mean "unknown"; it means _the provider default_, which is the protocol the route was itself registered with.

That is why the servability check treats `undefined` as servable, and why `@ai-sdk/openai-compatible` is deliberately **not** in `PROTOCOL_FOR_SDK`: listing it would record the default as though it were an override. The coverage guard still covers the case where a model declares it explicitly — none do today, and if one did, the test would fail and name it rather than dropping the model.

**The two bold cells were the gap, and they are closed.** The Go plane serves 13 models on shapes other than completions; both planes now have a route for every shape either one carries. What made them work was making the plane part of a route's definition, below.

## 3. Routes

A route is a name the host can dispatch to, carrying exactly one plane's base URL and one protocol. The plugin registers them in-process, so a profile that declares none still gets every endpoint.

| Route                       | Plane | Protocol                | Base URL |
| :-------------------------- | :---- | :---------------------- | :------- |
| `opencode`                  | Zen   | `openai-completions`    | Zen      |
| `opencode-go`               | Go    | `openai-completions`    | Go       |
| `opencode-responses`        | Zen   | `openai-responses`      | Zen      |
| `opencode-anthropic`        | Zen   | `anthropic-messages`    | Zen      |
| `opencode-mistral`          | Zen   | `mistral-conversations` | Zen      |
| **`opencode-go-responses`** | Go    | `openai-responses`      | Go       |
| **`opencode-go-anthropic`** | Go    | `anthropic-messages`    | Go       |

The last two do not exist yet. Their absence is why 13 offered Go models cannot work.

## 4. Invariants

These are the rules a correct implementation satisfies. Each one has a test in §5.

- **I1 — Every offered model is routable.** If a model appears in the picker, a route exists that serves it on the shape its SDK names. A model that cannot work is not offered. This is the plugin's headline promise, and the Go gap breaks it.
- **I2 — A route carries one plane.** Its base URL, its catalog and its credential all come from the same plane. Mixing them resolves to "model not found" against the route's own endpoint — the failure `responses-provider.ts` documents and works around by passing the Zen catalog explicitly.
- **I3 — The route is chosen from (plane, SDK).** Never from the SDK alone: `@ai-sdk/mistral` shares the completions _path_ but not its protocol, and the same SDK appears on both planes.
- **I4 — No SDK means the plane's base route.** A model naming no SDK stays where it is, on `openai-completions`.
- **I5 — An SDK with no protocol is not offered.** `@ai-sdk/google` is the only such SDK, and it is a **decision**, recorded in `UNSERVED_SDKS` — not a gap. The distinction matters: both look identical at runtime.

## 5. Guards

| Guard | Holds | Fails when |
| :-- | :-- | :-- |
| `catalog.test.ts` · SDK coverage | I5 | the catalog names an SDK that is neither mapped nor knowingly unserved |
| `catalog.test.ts` · plane × SDK coverage | I1 | the catalog contains a (plane, SDK) pair with no route |
| `responses-routes.test.ts` · route table | I2, I3 | a route's plane or protocol is ambiguous, or the table names a base that is not its plane's |
| `protocol-routing.e2e.ts` · live probe | I1, I3 | a protocol is declared routable without a path and an auth convention that were really sent, on either plane |
| coverage ratchet | — | a new route is added without a test that mounts it |

## 6. Refactor — done

The gap was structural, not a missing branch: **the plane is not part of a route's definition.** `responses-provider.ts` holds one `DEFAULT_BASE_URL` for every route it mounts, and `responses-routes.ts` keys its table by protocol alone, so a Go model cannot be described at all.

1. **Key the route table by (plane, protocol).** `ROUTE_FOR_PLANE_PROTOCOL[plane][protocol] → route`, replacing `ROUTE_FOR_PROTOCOL`. The Zen rows keep their current ids; the Go rows are new.
2. **Give every route its plane.** A route descriptor carries `{ id, plane, protocol }`, and the mount reads the base URL, catalog and credential **from the plane** rather than from a module constant.
3. **Make `internalRouteFor` plane-aware.** It currently returns `undefined` for any provider but `opencode`; it must resolve both planes, and still return `undefined` for a model with no mapped protocol.
4. **Register the Go routes** and add them to `DEFAULT_PROVIDERS`.
5. **No behaviour change for Zen.** Verified by the suite rather than by inspection: the Zen route ids, the models mounted on each and the base URL they carry are all asserted, and the refactor changed no test that covers them.

## 7. Verification

- The four guards in §5. The plane × SDK case was written first and **failed against the code as it was** - `opencode-go + @ai-sdk/openai` and `+ @ai-sdk/anthropic` - then passed once the Go routes landed, which is what makes it a check rather than a restatement.
- `pnpm run test:e2e` with keys present. The probe now takes the plane, and one case sends a real request to the Go base with the Go credential, asserting only that the gateway PARSED the model - any answer but 404 or 500 - so the case does not bet on an entitlement.
- The Zen plane compared before and after: route ids, mounted model ids and base URLs must be byte-identical.

## 8. The full path, front to back

One model, every stage. The left column is what a user can see; the right column is what makes it happen.

| # | The user sees | What runs | Where |
| --: | :-- | :-- | :-- |
| 1 | a model in the picker | the generated shim answers before any network call, `models.dev` refreshes it, and the gateway's own listing is merged in — **additively**, so a row is only dropped when the retirement list names it | `catalog-data.ts` → `models-catalog.ts` → `models-discovery.ts` |
| 2 | _(invisible)_ | each row carries the SDK the vendor ships (`provider_npm`). Nothing in the UI names it, and nothing the user sets can contradict it | the catalog |
| 3 | one model selected | the composer sets `provider` + `model`; no route, protocol or endpoint appears anywhere in the interface | the host |
| 4 | a turn starts | `llm/stream` fires; the hook claims the turn only for the routes this plugin declares, and leaves every other provider alone | `stream-hook.ts` |
| 5 | _(invisible)_ | the session id is derived — `ses_` + the session's real `createdAt` + a hash suffix — and the session's `cwd` becomes the project name | `session.ts` · `cordis-context.ts` |
| 6 | _(invisible)_ | **the redirect is decided**: `(plane, SDK) → protocol → route`. A model needing a shape other than its route's is re-dispatched to the route that speaks it | `responses-routes.ts` → `stream-hook.ts` |
| 7 | _(invisible)_ | the route's adapter is the host's own `llm-pi-ai`, mounted by the plugin per route, with that plane's base URL, catalog and credential | `responses-provider.ts` |
| 8 | _(invisible)_ | the request is intercepted and given what the gateway expects: origin proof, `x-opencode-session` always, parent-session lineage, and the free-tier `read`/`bash` schemas when the body lacks them | `fetch-patch.ts` · `tool-fallback.ts` |
| 9 | the reply streams in | the gateway answers; the plugin has changed nothing about the response | — |
| 10 | a spend figure | the turn's usage event is priced per **plane**, so a Go turn and a Zen turn never share one number | `session-cost.ts` · `usage.ts` |
| 11 | a quota ring or a spend pill | the meter polls the host service and renders the affecting window, or the session spend | `usage-pill.tsx` · `usage-panel.tsx` · `usage-ui.ts` |
| 12 | a settings card | the same store feeds the configuration card; the meter's own switch is the only control that turns it off | `settings-page.tsx` · `settings-card.tsx` |

**Read the table as a chain of guarantees.** Steps 1–3 are why the front end is one list; 4–8 are why it works without configuration; 9–12 are why the result is legible. Break any link and the failure surfaces somewhere far from its cause:

- **Step 2 without step 6** — the row is offered on a shape nothing routes: a Go responses model sent to completions answers `500`, and the row that caused it looks exactly like a working one. _(This is the gap in §2.)_
- **Step 6 without step 7** — the redirect names a route the host has never heard of, and the turn dies with "model not found" against an endpoint the user never chose.
- **Step 7 without step 8** — a correct endpoint answers `403 FreeTierError` or `400 MissingSessionID`, which reads as an account problem rather than a missing header.
- **Step 8 without step 10** — the meter prices a free turn as if it were paid, because the plane never reached the accumulator.
- **Step 10 without step 11** — the number is right and invisible, which is indistinguishable from not tracking it at all.

**The whole design follows from one sentence:** the user picks a _model_, and everything else — plane, protocol, endpoint, credential, headers — is derived from facts the vendor ships, so that no part of it can be configured into disagreement with another part.
