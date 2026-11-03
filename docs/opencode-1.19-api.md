# OpenCode 1.19.5: the API that moved

A specification of what this plugin talks to, what OpenCode 1.19.5 talks to instead, and what a migration would have to change. Written because the difference is not cosmetic: an API key that authenticates a paid model is refused for a free one, and the free tier is where this plugin's original reason for existing lives.

Everything below is measured. Where something is not, it says so.

## The pin, measured

`OPENCODE_CLI_VERSION` names 1.19.5 — the 1.x line's last release and the generation this plugin emulates. The 2.x line ships as `0.0.0-<channel>-*` snapshots under npm's `dev`, `next` and `beta` tags, and nothing in this tree claims it.

The emulated surface was compared tag to tag across the 1.19 line rather than assumed: `packages/opencode/src/session/` and `packages/opencode/src/tool/` are byte-identical at all four tags, and so is the affinity split in `provider.ts` — so the request shape, the session headers, the tool schemas and the body keys stand as measured. The patches in between touched only the CLI's own surfaces: session sharing discontinued, then the install/upgrade path, then how configured `reasoning_options` become model variants (`provider.ts`, `transform.ts`), plus generated SDK types.

## The short version

|  | An `oc_…` API key | An `st_…` session token |
| :-- | :-- | :-- |
| Paid models | served | served |
| Free-tier models | `403 FreeTierError` | `403 FreeTierError` — every credential class, header set and endpoint measured, keyless and keyed alike; the ids stay offered and the refusal names itself |
| Org context | not required | `x-opencode-org-id: wrk_…` |
| Per-request id | sent — minted per turn, same shape | `x-opencode-request: msg_…` |
| Where it comes from | a key a deployment pastes or exports | an account login |

**What decides a request is the credential, not the path.** Measured across both paths with one key: `grok-4.7` answers `400 ModelProtocolUnsupported` on `/zen/v1` and on `/inference/openai/v1` alike, and `qwen3.8-max` answers the same `403` upstream error on both. They are two paths into one gateway, and for a paid model the choice between them changes nothing.

The difference is in what a credential can reach — but **not the way this document first claimed.** It said a session token reaches free models because the free tier is gated on the token and the org that comes with it. Measured exhaustively since, and that is false: with the account's session token **and its org**, every Zen `-free` id answers `403 FreeTierError` while a paid model on the same request answers `200`. So does a bare API key, a CLI `User-Agent`, the client header, a valid session id, the `read`/`bash` tool schemas, both endpoints, and no credential at all. The free tier is not gated on anything a request can carry — and the console's own source says where the refusal comes from: for a model whose entry allows anonymous use it forwards the request keyless to the vendor's inference service, which is where `FreeTierError` is raised. So the ids are offered, never hidden, and the refusal is reported per request in the gateway's own words; the exhaustive tables are in `docs/credentials.md`.

So a deployment's API key keeps working exactly as it does today. **Logging in does not make the free tier reachable** — that was this document's claim and it is false, measured with the account's session token and its org. What a login buys is a credential for paid models; the free tier is not granted to anything sent from here.

## What OpenCode 1.19.5 resolves for itself

`opencode debug config` prints the configuration the running client actually uses. For the `opencode` provider, on this machine, with an account signed in:

```json
{
  "name": "Default / OpenCode",
  "npm": "@ai-sdk/openai-compatible",
  "api": "https://opencode.ai/inference/openai/v1",
  "env": ["OPENCODE_CONSOLE_TOKEN"],
  "options": {
    "apiKey": "…",
    "headers": { "x-opencode-org-id": "wrk_…" }
  },
  "models": 84,
  "whitelist": ["big-pickle", "claude-fable-5-1", …, "space-bunny-free", …]
}
```

Three facts, each load-bearing:

- **The endpoint is not `/zen/v1`.** It is `/inference/openai/v1`, spoken through the OpenAI-compatible SDK.
- **The credential is not an API key.** `OPENCODE_CONSOLE_TOKEN` is set from the signed-in account's access token, and `apiKey` in the provider options is that token.
- **The org is named on every request.** `x-opencode-org-id` carries the active workspace. It is what a session token needs to serve a **paid** model — measured `200` with it and `403` without — and it does not unlock the free tier, which nothing measured here does.

## The request, captured

Pointing the real client at a local server (`OPENCODE_CONFIG_CONTENT` overriding the provider's `baseURL`) captures exactly what it sends:

```
POST /v1/chat/completions
authorization:        Bearer st_3624847b-9048-4656-87ab-309f1516f6bb
user-agent:           opencode/1.19.5 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14
x-opencode-client:    cli
x-opencode-org-id:    wrk_01KWJYKNFF34P8F0JZDBX1WTB8
x-opencode-project:   global
x-opencode-request:   msg_129d5521b001jov4K0kGYl97tO
x-opencode-session:   ses_ed62aae61ffeA6UwzEFN9YNKk8
x-opencode-session-id: ses_ed62aae61ffeA6UzEFN9YNKk8
```

Against this plugin's headers, the additions were `x-opencode-org-id` and `x-opencode-request`. The org was injected from the start; the request id followed the source pass into `packages/opencode/src/session/llm/request.ts`, and the plugin now mints a `msg_…` id per turn (`newOpenCodeMessageId` in `src/session.ts`) and sends it in the same branch as the client and project headers. The credential differs in kind: `st_…` where we send `oc_…`.

One correction for the record: the `x-opencode-ticket` header this investigation first suspected is `PTY_CONNECT_TOKEN_HEADER` — a terminal websocket ticket, not a model credential. It was read from the binary's strings before the source was available, and the source says otherwise.

## Which credential unlocks which models

Measured, one request each, `space-bunny-free` on both endpoints:

| Credential sent | `/zen/v1` | `/inference/openai/v1` |
| :-- | :-- | :-- |
| the deployment's `oc_…` key | `403 FreeTierError` | `403 FreeTierError` |
| the same key plus `x-opencode-org-id` | `403 FreeTierError` | `403 FreeTierError` |
| the literal `public` | `403 FreeTierError` | `403 FreeTierError` |
| the real client's `st_…` token | — | **refused since** — see the note below |

The literal `public` is worth recording because the source suggests it: a provider with no credential keeps only zero-cost models and answers `options: { apiKey: "public" }`. That is a local placeholder for the SDK, not a credential the gateway accepts, and this measurement is what says so.

**That table is what this document originally concluded, and the last row is wrong.** The real client's session token served a free model _from inside the real client_ — the run it records is one where the client's own request was captured, and what the gateway accepted there is not reproducible from outside it. Measured since, with this account's session token **and its org**, every Zen `-free` id answers `403 FreeTierError` on both endpoints while a paid model on the same request answers `200`. So the gate is not the session token, and it is not the org: it is not anything a request can carry. See the exhaustive table in `docs/credentials.md`.

## What the free tier's gate is not

The error says the free tier "can only be used from within OpenCode". Everything a request can carry was excluded and the refusal did not move — and the console's own source says where the decision actually happens: it does not refuse these requests. For a model whose entry allows anonymous use it deletes the credential, adds its own access headers and forwards the request to the vendor's inference service, which is where `FreeTierError` is raised — the class exists in neither released tree, while the console's own errors name themselves from classes that do. So what remains is what the inference service can see for itself: the connection, and its own state.

| Excluded | How |
| :-- | :-- |
| mTLS | a plain request reaches the gateway and gets a JSON answer, so no client certificate is demanded |
| the credential | `/inference/openai/v1` answers `403 FreeTierError` where `/zen/v1` answers `401 Invalid API key` — the same token is AUTHENTICATED on the new path and refused on the old one |
| the org | sent, and it is the active org the client itself uses |
| the endpoint | the new path, which is the one the client uses |
| the visible headers | every header captured from the client's own request was replicated, including its session and request ids; and again on 2026-10-18 with the complete set, keyless with the literal `public` |
| the client library | Node's fetch, Python's urllib and Bun's fetch answer identically |
| the request body | bare bodies and bodies carrying the `read`/`bash` schemas the CLI sends are refused alike |

What is left is something the client's side of the connection carries that the request does not: a TLS or HTTP/2 fingerprint, a host-specific header the local capture could not have shown (it was taken against a local server, which is the one place such a header would not appear) — or state on the inference service's own side. Telling those apart needs code the vendor has not published.

**Testing the fingerprint from here is not possible, and the attempt is worth recording so nobody repeats it.** The plan was to read the client's TLS ClientHello and compare it with a plain client's: run a local listener, point the client at it with `HTTPS_PROXY`, and read the first bytes of the handshake. The client ignores `HTTPS_PROXY` — it answered a free-tier request normally while the listener received nothing — so the handshake cannot be observed without intercepting DNS or installing a trusted certificate, and both change the machine the client runs on rather than the question being asked.

So the honest statement, and the one the plugin is built to, is that the free tier is asked for and not granted. Nothing in this plugin promises it: the paid models work with a key, the account credential is stored with its owner, and whether the gateway ever grants the rest is the vendor's decision to make.

**A login is not pointless, though, and this is what it is for.** The same account token, on `/inference/openai/v1` with its org, serves a paid model that speaks the completions shape: `deepseek-v4.1-flash` answers `200` with a real completion. The models that answer `400 ModelProtocolUnsupported` there — `grok-4.7`, `claude-sonnet-5-5` — are refused by the protocol gate rather than by the credential, because they need `/responses` and `/messages`. So the account plane is a working credential for real traffic, and the free tier is the part that is not granted rather than the part that is broken.

That is what makes the login surface worth building, and it is why the routing is by credential rather than by endpoint: one gateway serves both kinds, and what each can reach is the whole difference.

## Where the session token comes from

`packages/opencode/src/account/account.ts` and `packages/opencode/src/config/config.ts` describe the flow, and it is a device flow this plugin already implements:

1. `POST {server}/auth/device/code` with `{ client_id: "opencode-cli" }` answers `{ device_code, user_code, verification_uri_complete, expires_in, interval }`. `verification_uri_complete` is resolved against `{server}/`, which is why it can be relative.
2. `POST {server}/auth/device/token` with the device grant answers `{ access_token, refresh_token, token_type: "Bearer", expires_in }`, or a discriminated error — the same shape this plugin's `console-auth.ts` reads.
3. The token is refreshed eagerly five minutes before expiry (`eagerRefreshThreshold`), not on a 401.
4. `GET {server}/api/config` with `Bearer {access_token}` and `x-org-id: {orgID}` answers **a whole OpenCode config** — providers, models, headers — which the client merges as a global config source.
5. The access token is exported as `OPENCODE_CONSOLE_TOKEN`, and the merged config's provider entry names it as its `apiKey`.

The consequence is the design: **the server tells the client where to send requests and what to send.** The endpoint, the models and the org header are not compiled into the client; they arrive with the login.

### Where the token actually lives, confirmed

The account is not a file. It is a row in the client's own SQLite database, and reading it closes the loop:

```
account        acc_01KWJYKM6GNVMY1EVB5ZC9H08G
               viztorix@gmail.com
               https://opencode.ai/console          <- the Console this plugin targets
               access_token  st_...(39)             <- the token the request carried
               refresh_token rt_...(39)
               token_expiry  1793948786727
account_state  active_account_id acc_...
               active_org_id     wrk_01KWJYKNFF34P8F0JZDBX1WTB8
                                                    <- the org the request carried
```

**So there is no exchange, and no second credential.** `st_...` IS the device flow's access token — the one this plugin's `console-auth.ts` already obtains, from the same `https://opencode.ai/console` base — and `rt_...` is its refresh token. The org is the one `/api/orgs` answered at login.

That reading of the free tier was wrong and is corrected here: measured, the account's own token **with** its own org is refused by the free tier exactly like a bare `oc_...` key. What the login actually buys is the account plane as a working credential for the PAID models — the token plus the org is what makes it usable (`200` with, `403` without) — and the free tier is granted to neither. The exhaustive table, and the console-source account of where the refusal is made, are further up this file.

## The design this implies: route by credential, not by table

The plugin derives an endpoint from a `(plane, protocol)` table and resolves one credential reference per plane. Both halves assume a credential is a credential. The measurement above says otherwise: what a credential can reach depends on its KIND, and the kind is visible in what a deployment configured.

So the shape that follows:

- **The credential decides the plane, not a hard-coded base URL.** A reference holding an `oc_…` key is the key plane; one holding an `st_…` token is the account plane, and the account plane carries an org with it.
- **A stored credential carries its owner.** The account, the email and the org are known AT LOGIN — the flow fetches `/api/user` and `/api/orgs` before it stores anything — so they belong in the same record as the token rather than being re-derived later. A session token without its org cannot serve a paid model (`200` with, `403` without), which is the failure this spec exists to explain; keeping the two in one record is what makes that impossible. It does not change the free tier, which is refused with or without the org.

  This plugin already has the shape for it: `token-store.ts` writes a `grant` whose payload is the owner's to define, and an account and an org are exactly that. What it must NOT do is infer the plane from the token's prefix — `st_...` is a useful confirmation, not a contract, and the login is where the answer is actually known.

- **A model's reachability follows from the plane it resolved on — and a refusal is reported, not hidden.** Zen refuses its free ids by the gateway's own decision; the Go plane has no free tier to gate and serves its free models by subscription key. The picker offers both, and a refusal comes back verbatim (`403 FreeTierError`, with the gateway's own message) rather than the row disappearing.
- **Zero configuration survives.** A deployment that pastes a key gets the key plane and today's behaviour; one that logs in gets the account plane as a working credential for paid models — the free tier is granted to neither. Neither names an endpoint.

The endpoint, notably, is NOT part of this. Both paths answer identically for a paid model, so the plane is a description of what a credential can reach — not a different address. The tables stay as the key plane's description; the account plane is described by what the login returns.

## What this plugin would have to change

Nothing, to keep serving paid models: `/zen/v1` with `OPENCODE_API_KEY` still answers, which the live suite exercises on every run.

For the free tier, four things:

1. **A login that stores what it learned.** The device flow this plugin already implements, extended by the two reads that follow it — `/api/user` and `/api/orgs` — and by writing the account, the email, the org and the token pair as ONE grant record. That is the whole difference between a credential that can reach the free tier and one that cannot.
2. **An org id per request, read from that record.** The plugin's header injection is the place; the value comes from the credential, so a deployment with several accounts needs no extra setting.
3. **A plane chosen by the credential's kind**, so a key deployment and a login deployment each route to what they can actually reach.
4. **A server-driven model list for the account plane**, whose models arrive with the login rather than from the dependency's catalog.

Step 3 is the reason this is a specification rather than a patch: routing currently derives an endpoint from a table, and the measurement says the endpoint is the same either way — so what changes is what the plugin thinks a credential IS.

## What this changes about the plan

- **The free tier is not reachable by adding a header.** Measured: the org id and the key together still answer `403`. Any plan that assumed a header fix is wrong.
- **The device-flow client already written is the right shape.** Its endpoints, its grant type, its client id and its reading of the discriminated error all match the source. Its refresh window is 120s where the client uses 300s, which is a number to reconcile rather than a design to change.
- **The paid path is unchanged in every respect**, endpoint included: both paths are one gateway and answer a paid model identically, so the bridge and the protocol table keep their value and their addresses. This is an addition, not a replacement.
- **The user-agent is a version behind.** We claim `provider-utils/4.0.40`; the captured request sends `4.0.23`. Worth reconciling when the rest is settled, since the gateway groups usage by it — and the same capture is where to check the claim rather than trusting the constant.
