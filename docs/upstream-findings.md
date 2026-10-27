# Upstream findings & issue tracking

Three audiences: what the **OpenCode upstream** does that we must track, what the **DSH host** needs to change for us to do it, and what we **verified against upstream source** — because a measurement cited in a comment is a fact that goes stale and nobody re-reads it.

Every claim names the file it was checked against. A claim not checked is marked **unverified** rather than repeated as fact.

---

## 0. Version targets — 1.19 is primary, 2.* tracked for divergence

The payload we send is negotiated with whatever gateway the account is on, and both lines are still served, so we support both. **1.19.x is the target we implement against**; 2.x is tracked because it has already moved several contracts.

|  | 1.19.x (primary) | 2.0.x (tracked) |
| :-- | :-- | :-- |
| Latest at time of writing | 1.19.4 | 2.0.32 |
| Session id generator | `packages/opencode/src/id/id.ts` **and** `packages/schema/src/identifier.ts` | `packages/schema/src/identifier.ts` only (`packages/opencode/` is gone) |
| Header assembly | `packages/core/src/session/runner/llm.ts` | `packages/core/src/session/model-request.ts` |
| Gateway shape | `opencode.ai/zen/v1/…` | `opencode.ai/inference/<proto>/v1/…` |
| Free-tier gate | `allowAnonymous` on the model entry | not present in the snapshot (see §1.5) |

### 0.1 How to refresh the refs

The sibling checkout cannot `git fetch` under the DSH sandbox: git writes `.git/FETCH_HEAD` on every fetch, and the workspace-write sandbox refuses it. A shallow clone works and is the documented path:

```sh
git clone --filter=blob:none --no-checkout --single-branch --branch dev --depth 40 \
  https://github.com/anomalyco/opencode.git
# then, for a specific version's file:
git fetch --depth 1 origin tag v1.19.4
```

Note the remote is `anomalyco/opencode`, **not** `opencode-ai/opencode`.

---

## 1. OpenCode upstream

### 1.1 The session id generator — unchanged across both lines

Read in full from both `packages/schema/src/identifier.ts` (present in 1.19.4 and 2.0.32, byte-identical) and `packages/opencode/src/id/id.ts` (1.19.4 only, same arithmetic):

```ts
let lastTimestamp = 0;
let counter = 0;

export function create(descending: boolean, timestamp = Date.now()) {
  if (timestamp !== lastTimestamp) {
    lastTimestamp = timestamp;
    counter = 0;
  }
  counter++;

  const current = BigInt(timestamp) * 0x1000n + BigInt(counter);
  const value = descending ? ~current : current;
  const time = Array.from({ length: 6 }, (_, index) =>
    Number((value >> BigInt(40 - 8 * index)) & 0xffn)
      .toString(16)
      .padStart(2, "0")
  ).join("");
  const bytes = crypto.getRandomValues(new Uint8Array(length - 12));
  return time + Array.from(bytes, (byte) => chars[byte % 62]).join("");
}
```

Three facts, each of which contradicts something this plugin once assumed:

1. **`counter` starts at 1 per millisecond** and increments per id. It is a _within-millisecond_ disambiguator.
2. **The low twelve bits are NOT constrained by upstream.** They walk `0x001`, `0x002`, `0x003`, … and are only bounded by the counter's wrap. Nothing reserves a band.
3. **The id is 26 characters: 12 hex timestamp + 14 base62.** The prefix (`ses_`) is added by a caller; `create()` returns the bare 26 characters.

**Implication for the rate-limit claim** — see §3.1.

### 1.2 The header contract — 1.19.4

`packages/core/src/session/runner/llm.ts`, the authoritative assembly:

```ts
const promptCacheKey = /^ses_[0-9a-f]{64}$/.test(session.id) ? session.id.slice(4) : session.id
const request = LLM.request({
  model,
  http: {
    headers: {
      "x-opencode-session-id": session.id,
      ...(session.parentID ? { "x-opencode-parent-session-id": session.parentID } : {}),
      "x-session-affinity": session.id,
      "X-Session-Id": session.id,
      ...(session.parentID ? { "x-parent-session-id": session.parentID } : {}),
    },
  },
  providerOptions: { openai: { promptCacheKey } },
  …
```

Five headers, all carrying **`session.id`** — the plain session id, with no derivation, no hash and no band. 1.19.4 does **not** send `x-opencode-session`, `x-opencode-client`, `x-opencode-project` or `User-Agent` from this path.

### 1.3 The header contract — 2.0.32

`packages/core/src/session/model-request.ts`, and it is materially different:

```ts
const affinity = SessionAffinity.get(session)
const base = LLM.request({
  model: model.model,
  http: {
    headers: {
      "x-opencode-session-id": session.id,
      ...(session.parentID ? { "x-opencode-parent-session-id": session.parentID } : {}),
      "x-session-affinity": affinity,
      "X-Session-Id": affinity,
      ...(session.parentID ? { "x-parent-session-id": session.parentID } : {}),
      "User-Agent": App.useragent(app),
      "x-opencode-project": session.projectID,
      "x-opencode-session": affinity,
      "x-opencode-client": app.name,
    },
  },
  promptCacheKey: /^ses_[0-9a-f]{64}$/.test(affinity) ? affinity.slice(4) : affinity,
  …
```

Differences that matter to us:

1. **A new `SessionAffinity` value** (`packages/core/src/session/affinity.ts`): `session.parentID ?? session.fork?.sessionID ?? session.id`. So `x-session-affinity`, `X-Session-Id` and `x-opencode-session` carry the **affinity id**, which is the PARENT's id for a subagent, while `x-opencode-session-id` still carries the plain `session.id`. They are different values in general.
2. **Three headers 1.19 does not send**: `User-Agent`, `x-opencode-project`, `x-opencode-client` (value `app.name`).
3. `x-opencode-session` exists in both lines but carries different things.

**Consequence.** Our plugin sends `session.id` in all five of 1.19's headers. That is exactly 1.19's contract and correct for a 1.19 account. For a 2.x account the gateway expects the affinity-derived value in three of them, so a 2.x account sees a session that does not group as the client intended. Whether the 2.x gateway _enforces_ this is **unverified** — it may happily accept `session.id`.

### 1.4 The gateway path table — identical in both lines

`packages/console/app/src/lib/inference-proxy.ts`, present and identical in 1.19.4 and 2.0.32:

| Zen path                                   | Inference path                 |
| :----------------------------------------- | :----------------------------- |
| `POST /zen/v1/chat/completions`            | `/openai/v1/chat/completions`  |
| `POST /zen/v1/responses`                   | `/openai/v1/responses`         |
| `POST /zen/v1/messages`                    | `/anthropic/v1/messages`       |
| `POST /zen/v1/systemone`                   | `/systemone/v1/systemone`      |
| `POST /zen/go/v1/...`                      | `/go/...` (all four)           |
| `GET /zen/v1/models`                       | `/v1/models`                   |
| `GET /zen/go/v1/models`                    | `/go/v1/models`                |
| `GET /zen/go/v1/usage`                     | `/go/v1/usage`                 |
| `POST /zen/v1/models/<id>:generateContent` | `/google/v1beta/models/<id>:…` |

**This is the mapping our plane routes exist to serve, and it is stable across both major versions.** The `zen/v1` shape is still accepted by 2.x — the migration is server-side, so 1.19 clients keep working against 2.x gateways. That is the good news: our 1.19-target implementation does not need to change shape to talk to a 2.x account.

### 1.5 Free-tier access — `allowAnonymous`, and it does NOT gate on a session band

1.19.4, `packages/console/app/src/routes/zen/util/handler.ts`:

```ts
const zenApiKey = rawZenApiKey === "public" ? undefined : rawZenApiKey
…
anonymous: opts.modelList === "full" && entry?.allowAnonymous === true,
…
async function authenticate(modelInfo: ModelInfo, zenApiKey?: string) {
  if (!zenApiKey) {
    if (modelInfo.allowAnonymous) return        // <-- free model, no key: allowed
    throw new AuthError(t("zen.api.error.missingApiKey"))
  }
  …
  if (modelInfo.allowAnonymous) return "free"    // billingSource
}
```

and the schema that declares it, `packages/console/core/src/model.ts`:

```ts
const ModelSchema = z.object({
  name: z.string(),
  cost: ModelCostSchema,
  …
  allowAnonymous: z.boolean().optional(),
  …
})
```

**What this establishes:**

- A free model is admitted with **no key at all**, or with the literal key `public`. (Admitted into the proxy's forwarding path — not the same as served: see `docs/credentials.md` for what the Zen free tier actually answers.)
- The gate is a **per-model boolean in the vendor's own model registry**, not a property of the session id, the request headers, or the endpoint family.
- With `anonymous`, the proxy strips `authorization`, `x-api-key` and `x-goog-api-key` and forwards keyless; 1.19.4 has an extra rule 2.x drops — `if (anonymous && !generation?.anonymous) return undefined` — so **1.19.4 requires the gateway's own generation path to declare the model anonymous**, while 2.x forwards any keyless request straight through.
- `billingSource` is `"anonymous"`, `"free"`, `"byok"`, `"subscription"`, `"lite"` or `"balance"`, and `"anonymous"` skips accounting entirely.

**The session id's low bits are not part of the `allowAnonymous` rule** — that gate is per model and says nothing about sessions. It is a SEPARATE rule, and §3.1 records it: the gateway does enforce a band on the session id's low twelve bits, and it is enforced independently of what the body carries and of which credential is present.

`allowAnonymous` is **not present in the 2.x snapshot** (`packages/core/src/models-dev/snapshot.txt` carries no such flag, and the 2.x handler file no longer has the key). How a 2.x account decides free access is **unverified**; the 1.19.4 rule is the one we implement against.

---

## 2. DSH host

### 2.1 A per-turn message id — `x-opencode-request` is sent again (2026-10-18)

Recorded in [`docs/engineering-notes.md`](./engineering-notes.md). OpenCode 1.19.4 sent `x-opencode-request` carrying the user message's id (`input.user.id` in `packages/opencode/src/session/llm/request.ts`, in the same branch as `x-opencode-client` and `x-opencode-project`); 2.x dropped it. This was blocked for a round because the turn state carries no message id — `value` is the session's derived id, a different object — and the hook's options carry none either, because the adapter builds the body after the hook returns.

**Lifted by minting rather than by plumbing a host value**: `newOpenCodeMessageId` in `src/session.ts` produces a fresh `msg_` + 12 hex + 14 base62 value per turn (clock + counter in the hex field, `randomBytes` in the suffix), `stream-hook.ts` stores it as `requestValue` in the turn state, and `fetch-patch.ts` sends it beside the client and project headers. A minted id is not literally the user's message id, and the trade is deliberate: nothing in either released tree reads the value back the way session affinity reads a session id — the console forwards it to the inference service as `x-opencode-request-id` for per-request accounting — so a well-formed value with the client's own lifecycle is as much as a request can honestly carry. Deriving it from message content was rejected rather than overlooked: a digest of the user's own text travelling in a header is a guessable fingerprint, and the vendor's ids are random.

One divergence worth recording: the client sends ONE id per user message, so a multi-step tool turn repeats the same value; this plugin mints per streamed turn, because nothing on this side of the adapter offers a DSH message id that would make the larger unit reachable. The header is therefore present and well-formed, but its grouping is the turn's rather than the message's.

### 2.2 Session affinity for subagents — needs a parent-session notion

1.19 sends the plain session id everywhere, so our derivation is correct. 2.x sends `parentID ?? fork?.sessionID ?? id` in three headers. To match 2.x we would need the parent session id, which the turn state carries as `parentValue`. Whether the 2.x gateway enforces the affinity grouping is **unverified**.

### 2.3 Restart semantics

Not a bug, but the cost of every item above: `lib/index.mjs` is read once at process start, and this package is installed through a `link:` so nothing notices a newer file. A change is not deployed until `pnpm run build` runs **and** the process restarts.

---

## 3. Claims verified against upstream

### 3.1 "The gateway passes only sessions whose low twelve bits are in `f[c-f]x`" — CONFIRMED

**The claim** (`src/session.ts`, PR #37, live-probe OmniRoute #16571): the gateway refuses any session id whose low twelve hex bits are outside `[0xFC0, 0xFFE]`, answering `403 FreeTierError`. A uniform counter therefore passes ~1.5% of sessions and dooms the rest at mint.

**This section used to say REFUTED, and that was the error. Two mistakes, one each.**

_The simulation modelled the wrong direction._ `packages/opencode/src/id/id.ts` mints

```
now = BigInt(Date.now()) * 4096n + BigInt(++counter)   // counter resets每毫秒
now = direction === "descending" ? ~now : now
```

and **sessions use `descending`**. The port in `scripts/verify-session-band.ts` reproduced `create()` without that step, so it reported the ASCENDING residue — `0x001`, outside the band — and concluded the band could not be a rule. With the inversion, the low twelve bits are `0xFFF - counter`: `0xFFE` for the first id of a millisecond, and still in band for any client minting fewer than 64 in one millisecond. The script now reports both directions side by side.

_The live probe could not have observed the thing it claimed to test._ All five ids — `0xfc5`, `0x001`, `0xffe`, `0x000`, `0xfff` — answered identically:

```
401  Go requires a credential
```

That is the CREDENTIAL check, on a Go-plane request with no Go credential. Every probe was refused before the session was ever considered, so the table proved nothing about sessions; the one variable that mattered was held constant at "missing".

**What the gateway actually does — measured.** Replaying the vendor client's own captured request body (179,166 bytes) through the same runtime, changing nothing but the session header:

| session id | low twelve bits | answer |
| --- | --- | --- |
| captured from the real client | in band | `200` |
| freshly minted, vendor descending | `0xFFE` | `200` |
| freshly minted, vendor ascending | `0x001` | `500` |
| this plugin's old hash-derived id | arbitrary | `500` |
| ascending, low twelve forced to `0xFFE` | `0xFFE` | `200` |
| ascending, low twelve forced to `0xFC0` | `0xFC0` | `200` |
| ascending, low twelve `0x001` | `0x001` | `403 FreeTierError` |
| descending, `counter=3000` | `0x447` | `500` |

Only the low twelve bits decide. Direction is not checked; both a descending id and an ascending one whose residue is in the band are admitted.

**Where the band comes from.** It is a consequence, not a rule the vendor enforces on itself: minting descending puts the residue at `0xFFF - counter`, and a real client's counter is a small number inside one millisecond.

**What this plugin does now.** `counter = 1`, because exactly one id is minted per session — the vendor's own value for the first id of a millisecond. Inverting `(ms << 12) + 1` lands on `0xFFE` with no clamp: `src/session.ts` mentions no band at all. The clamp PR #37 introduced was a correct reading of the gateway and is no longer needed; keeping it would have been the wrong shape to ship, not the wrong answer.

**What the wrong version cost.** A refutation that reads clean, a section of this document asserting it three times, and a clamp removed as "disproven" — and then rediscovered by replaying the real client. The lesson is the one in "the general method" below: a probe that cannot see past the credential check is not a probe of the session.

### 3.2 "`init.body` is undefined on DSH's dispatch path, so injection was skipped" — VERIFIED

DSH sends inference as `fetch(new Request(url, { body }))`, so `init.body` is `undefined`, and the old `if (init?.body !== undefined)` guard skipped the core-tool injection on exactly that path. Reading the body off `input` via `input.clone().text()` and re-issuing a `Request` is the correct fix, and the tests cover all four sources (string `init`, `Request` input, absent body, non-JSON body). **Correct, adopted, tested.**

### 3.3 "The gateway checks `read`+`bash` on `/chat/completions` as well as `/responses`" — PARTIALLY VERIFIED

The contract test covers both routes. Whether a _paid_ completions body without tools is also refused is **unverified** — the probe described a free-tier body. The injection is harmless when unneeded (tools are additive), so extending it to both routes is a safe default.

### 3.4 "Free-tier ids carry no `-free` marker" — VERIFIED

`big-pickle` is flagged free in the catalog with no `-free` suffix, so a marker test misses it. Reading `findModelSpec(modelId)?.is_free` is the authority. **Correct and adopted.**

---

## 3.5 The registry's `deprecated` flag vs the adapter's installed snapshot — MEASURED DRIFT

Checked 2026-10-17 against `https://models.opencode.ai/api.json` and against pi's installed catalog at `@earendil-works/pi-ai/dist/providers/data/opencode.json`.

|  | count |
| :-- | :-- |
| live `opencode` models | 127 |
| of those `status: "deprecated"` | 43 |
| live active | 84 |
| pi's installed `opencode` ids | 85 |
| pi ids the live catalog has since retired | **5** (`exo-free`, `ling-3.0-flash-fin-free`, `ling-3.1-flash-free`, `step-5-preview-free`, `muse-spark-1.3-contributor-free`) |
| live-active ids pi does not have | **6** (`gpt-5.3-codex-spark`, `glm-5.3-flash-free`, `nemotron-3.5-super-vl-free`, `deepseek-v4.1-flash-free`, `beam-free`, `gemini-4-argon`) |

**Why this matters.** `mergeDiscoveredModels` merges the ADAPTER's rows first and appends catalog rows after. Our parser already drops `status: "deprecated"`, but the adapter's snapshot still lists those ids — so the merge put all 5 back, and the picker led with models the vendor has retired while the 6 current ones sat at the bottom.

**Fixed** by recording retired ids during parse (`isDeprecatedModelOn`) and having the merge drop an adapter row the registry has retired. A model ABSENT from the catalog is still kept: absent is not the same as retired, and the adapter's own row is its answer for a model the catalog does not describe.

Note the pi snapshot is keyed by PROTOCOL bucket (`openai-completions`, `openai-responses`, `anthropic-messages`, `google-generative-ai`, `typesafe-system-one`) with `chat:` / `classifier:` prefixes on each id — not a flat model map.

## 3.6 The composer meter's registration guard was per-`apply` — VERIFIED DEFECT

`lib/client.js` registered the meter under a `let registered = false` declared **inside** `apply`. The host may run a plugin's client entry more than once in a page's life, so the second run started from `false`, called `slots.register` with the same id, and threw:

```
list slot "conversation.input.right" already has an entry with id "dsh-opencode-patch-usage"
```

A throw out of the entry is a meter that disappears with no message. The guard is now keyed on the slot REGISTRY (`WeakSet`), so a re-activation against the same registry is a no-op while a genuinely fresh registry still registers, and the registration itself is wrapped so a duplicate can never become an exception.

## 3.7 The Go quota endpoint has exactly one public route — VERIFIED

`packages/console/app/src/routes/zen/go/v1/usage.ts` is the **only** quota route in either major version (checked 1.19.4 and 2.0.32), and the inference proxy's path table (`packages/console/app/src/lib/inference-proxy.ts`) lists `"GET /zen/go/v1/usage": "/go/v1/usage"` with **no** `/inference/.../usage` counterpart.

That matters because the live catalog names the INFERENCE family for the `opencode` provider (`api: https://opencode.ai/inference/openai/v1`). `toGoBaseURL` rewrote only the `zen/v1` form, so a base discovered from a provider row passed through untouched and the meter asked `…/inference/openai/v1/usage` — a path that does not exist, which is an unavailable meter with no explanation. Both families now resolve to `https://opencode.ai/zen/go/v1`.

Confirmed by probing each candidate unauthenticated on 2026-10-17:

```
https://opencode.ai/zen/go/v1/usage                 401  {"type":"error","error":{"type":"AuthError","message":"Unauthorized"}}
https://opencode.ai/inference/openai/v1/usage       404
https://opencode.ai/inference/go/openai/v1/usage    404
```

401 is "the route is there, bring a credential"; 404 is "no such route". The middle one is the URL the meter used to ask, so every quota read was a 404 — an unavailable meter with nothing on screen to explain it.

### 3.7.1 The vendor's own client never calls it — VERIFIED

Reading the source for the answer to "which endpoint does OpenCode use for usage" turns up something the plugin should record, because it changes what the endpoint _is_.

**Nothing in the vendor's client fetches it.** A full-text sweep of the 1.19.4 tree for `usage` finds exactly one reference to the path, and it is the SERVER side:

```
packages/console/app/src/routes/zen/go/v1/usage.ts:18   "GET /zen/go/v1/usage": "/go/v1/usage"
```

The console's dashboard does not go through the gateway for this number either — it reads its own tables (`LiteTable.rollingUsage` / `weeklyUsage` / `monthlyUsage` plus `BillingTable`) with a **session cookie**, in `packages/console/app/src/routes/workspace/[id]/go/lite-section.tsx`. The CLI and TUI have no usage fetch at all; `packages/opencode/src/acp/usage.ts` is about a session's token count, not the plan's quota.

So the route is not "how the client asks for usage". It is a **key-facing** endpoint: the route authenticates with `authorization: Bearer <key>`, looks the key up in the key table, and answers `403 EntitlementError` ("OpenCode Go subscription required.") when its workspace has no Go subscription. That is exactly the shape this plugin uses — a key in hand, the windows in hand — and it is why the endpoint is so sparse: it exists for key holders, not for the dashboard.

The two versions differ in where the number comes from, and the shape does not change: 1.19.4 tries the inference proxy first and falls back to its own database when the proxy is unavailable (`.catch(inferenceUnavailable)`), while 2.0.32 forwards the request outright (`return proxyInference(input.request)`).

The answer, in one line: **`GET https://opencode.ai/zen/go/v1/usage`**, and it is the only such endpoint on the gateway — the Zen plane has no counterpart, because the Zen plan's credits are a console concept and the dashboard reads them with a cookie.

## 3.8 Probing the gateway: 401/403 means SERVED, 400 means GONE — MEASURED

`POST /zen/v1/chat/completions` with one token and no credential answers distinctly enough to classify every id:

| answer | meaning |
| :-- | :-- |
| `401 AuthError "Missing API key."` | the model EXISTS, the credential is missing |
| `403 FreeTierError` | the model EXISTS and is free |
| `400 "Model is unavailable."` | the model is GONE |
| `410 Gone` | the model is GONE |
| `400 "Request is missing x-opencode-session…"` | Go plane needs the session header first |

That is the "kept until it stops ANSWERING" probe the source comments kept asking for and never ran. Run 2026-10-17 over the 43 zen ids the registry marks `deprecated`:

- **36 answered `400`, 4 answered `410`** — genuinely gone. The `deprecated` flag is right for these.
- **3 still answered**: `exo-free` (`403`), `cat-jam-free` (`403`), `muse-spark-1.2-contributor-free` (`403`). The flag is wrong for these, and dropping them hid working models.
- `step-5-preview-free`, which `RETAINED_MODEL_IDS` was pinning by hand, answered **`400` — it is gone**. The pin had outlived the model.

`GET /zen/v1/models` is also incomplete: it omits `deepseek-v4-flash-vision-exp` (`401`) and `nemotron-3-ultra-free` (`403`), both of which answer. So neither the registry's flag nor the gateway's own listing is authoritative — only a probe is.

### What that changed

- `RETAINED_MODEL_IDS` → `cat-jam-free`, `exo-free`, `muse-spark-1.2-contributor-free`; `step-5-preview-free` removed.
- `RETIRED_ZEN_MODEL_IDS` → `muse-spark-1.2-contributor` only. `muse-spark-1.2` answered `401` on zen and `muse-spark-1.2-contributor-free` answered `403`, so both were being hidden while being served.

### The session band, measured LIVE — CONFIRMED

The earlier version of this section recorded the opposite. It sent five ids to `POST /zen/go/v1/chat/completions` on a Go plane with no Go credential, and all five answered `401 Go requires a credential` — the credential check, never the session. Refused before the session was read, the probe could not distinguish a good id from a bad one.

Repeated properly — the vendor client's captured body, its own credential, only the session changed — the band is enforced, and the table is in §3.1.

## 3.9 The bundled shim was stale — RESOLVED

The gateway answers `410 ModelDeprecated` for retired models, with the reason in the body:

```
ll-alpha-free                   410 {"type":"error","error":{"type":"ModelDeprecated","message":"Model ll-alpha-free has been deprecated."}}
muse-spark-1.3-contributor-free 410 {"type":"error","error":{"type":"ModelDeprecated","message":"Model muse-spark-1.3-contributor-free has been deprecated."}}
step-5-preview-free             400 "Model is unavailable."
space-bunny-free                403 FreeTierError   <- served
```

All three dead ids were still in `src/catalog-data.ts`, generated while they were active, so a cold start offered three models that could not answer.

**Regenerated 2026-10-17** (`scripts/regenerate-catalog-shim.ts --write`). The diff was four ids out and four in per plane, counts unchanged at 86 / 30:

```
opencode-go: 30 -> 30   + cat-jam-free            - step-5-preview-free
opencode   : 86 -> 86   + muse-spark-1.2, muse-spark-1.2-contributor-free, exo-free, cat-jam-free
                        - ll-alpha-free, claude-sonnet-4, step-5-preview-free, muse-spark-1.3-contributor-free
```

Verified after: **0 offered models are measured dead**, and the generator reports `shim is current`. The SDK split moved with it — Zen is now 31 `@ai-sdk/openai` / 17 `@ai-sdk/anthropic` / 29 no-SDK / 1 Mistral / 8 Google — and `README.md`, `docs/redirect-planes.md` and `docs/protocol-routing-and-merge.md` were updated to match, because `catalog-docs.test.ts` holds all three tables to the catalog.

Fixture ids that pointed at now-dead models were retargeted to served ones: `step-5-preview-free` → `space-bunny-free` (or `cat-jam-free` where both planes are needed), `muse-spark-1.3-contributor-free` → `muse-spark-1.2-contributor-free` (still `@ai-sdk/openai`, still free, still answers `403`).

## 3.10 The picker and the protocol-routed models — the fix was withdrawn

> **Superseded by P-R1 (D13).** There is one route per plane now, and no `internalRouteFor`: the plane adapter serves every protocol a plane carries on the plane's own route, and lists exactly the declared ids. The invariants this section describes are held by `test/mock/plane-dispatch.mock.ts` (every declared id dispatches on its protocol's path) and the declared-listing cases in `test/host-planes.test.ts` ("lists every declared id on both planes, keyless or not"); `test/picker-integration.test.ts` went with the hidden routes. The section is kept as the record of why a route's list is not ours to widen, which still holds.

`buildModelCatalog` (the composer's list) is `listProviders()` × `listModels(id)`, read from the host's own `@deepseek-ai/dsh-api-session-controller/lib/types/catalog.js`. The internal protocol routes are hidden from `listProviders`, and each carries only its own protocol's models, because `registerResponsesProvider` builds every route with `sdksForProtocol(protocol).flatMap(sdk => modelsForSdk(sdk, catalog))`.

So enumerating a parent route returns that route's own models, and a Responses / Messages / Google model is only listed if the deployment declared it:

|                              |   rows |
| :--------------------------- | -----: |
| adapter's completions bucket |     28 |
| a declared list of one id    |      1 |
| after the (withdrawn) join   | **87** |

**A join was added here and then withdrawn.** It merged the plane's whole catalog into `listModels` so that models on the hidden routes would be reachable. It did make them reachable — and it silently overrode every explicit `models:` array, which is a configuration decision this plugin is in no position to answer for. The failure was invisible on screen: nobody can tell 27 rows from 87 without counting the config. What surfaced was a user picking a model their deployment never offered, and that model failing for reasons that had nothing to do with the plugin.

The rule that replaced it: **a route's list is not ours to widen.** `listModels` filters (a model the plane cannot serve is dropped, because offering one produces a failure with nothing in the row to explain it) and otherwise returns exactly what the deployment declared. `internalRouteFor` still redirects a _declared_ model whose protocol differs, so a Responses / Messages / Google id keeps working — it just has to be listed. `test/picker-integration.test.ts` holds the picker to the declaration, and `models-discovery.test.ts` asserts that a servable catalogued model which was not declared stays out.

## 3.11 The provider list was wrong in both directions — FIXED

> **Superseded by P-R1 (D19).** There are no mounted routes, no Google bridge and no `SELF_MOUNTED_ROUTES` any more. `DEFAULT_PROVIDERS` is the two planes, and `providers` always includes both, whatever the row says (`src/config.ts`); `test/config.test.ts` ("always claims both planes, whatever the row lists") and `test/deleted-settings.test.ts` ("the shipped row claims exactly the two planes") hold that. The section is kept as the record of the drift.

`DEFAULT_PROVIDERS` exists to cover every route this layer mounts; an unclaimed route gets no session header, no origin headers and no key injection, silently and only on the requests that reach it. It was wrong twice:

- **missing `opencode-google`**, which the Google bridge mounts rather than the wrapper (`SELF_MOUNTED_ROUTES` excludes it from the mount loop, which is why it was easy to miss). It matters because a deployment that declares a Google-protocol model gets it dispatched to this route, and an unclaimed route would send it without the gateway headers.
- **`cordis.patch.yml` claimed `opencode-mistral`**, a route this layer does not mount at all — Mistral is deliberately unserved.

The row's `providers` list REPLACES the code default, so the two drifting apart is exactly how this survived. A manifest test now requires them to be equal.

## 4. How to re-check any of this

Most of this document exists because four separate bugs had the same invisible shape: a model that is dropped is not filtered, not deprecated and not erroring — it is simply absent. Each was found with a hand-written script that was then thrown away. That script is now kept:

```sh
pnpm run catalog:verify        # offline: shim, declared list, routing, free-tier tools
pnpm run catalog:verify:probe  # adds a live probe of every offered model
```

It checks, and exits non-zero on any failure:

1. **Shim freshness** — the bundled `catalog-data.ts` equals the live registry exactly (both come from the same parser over the same payload). What the registry should have flagged but did not is the probe's business, not this check's.
2. **Dead rows** (`--probe`) — no offered model answers `400 Model is unavailable` or `410 ModelDeprecated`.
3. **The declared list** — the composer's source (`planeProfileFor`) publishes exactly the ids a plane declares: nothing added and nothing missing. Settings' fetch offers the catalog; the composer never widens.
4. **Routing** — every servable model resolves to a route this plugin mounts.
5. **Free-tier tools** — every free model gets the core-tool fallback.

### The general method

1. Find the upstream source that **produces** the value, not a client that consumes it.
2. Simulate the upstream algorithm directly, over the range that matters.
3. Compare the distribution against the claimed constraint. A constraint the upstream violates in its common case is not a constraint.
4. When a claim is about what the GATEWAY does, probe the gateway. `401`/`403` means the model exists and the credential is missing; `400`/`410` means it is gone. That one table settled the free-tier, deprecation and retirement questions at once.

For the session id specifically, `scripts/verify-session-band.ts` runs a byte-for-byte port of the vendor's generator in BOTH directions, which is what makes the source of the band visible: ascending never lands in it, descending always does.
