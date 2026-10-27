# Credentials: the resolution chain and the installation store

The plugin's default is the deployment's own credential: whatever `apiKeyEnv` the profile already declares keeps resolving exactly as it does today. The installation's own store is the fallback for a credential that is missing, placeholder or unnamed — a route that declares what it wants is never overridden by something the plugin found on its own.

**This build carries the API key path only.** The Console login — device flow, the token store, the session reader, the multi-key pool — is `v2` work and is deliberately not in `main`, together with the tests and the settings row that carried it. Nothing here depends on a login service existing, and no request path consults one.

**The login material below is kept as record, not as description.** Sections whose heading carries "(`v2` record)" describe an arrangement that this branch does not implement; they are kept because the measurements in them — an OAuth token is not an API key on the Zen endpoint, the free tier's refusals, the store's schema — remain true and cost real time to establish. Read them as history.

## Current request wiring

**The plane adapter resolves a plane's key by `llm-pi-ai`'s own rule (D20)**, in `planeApiKeyResolver` (`src/host/plane-provider.ts`), before any request is built:

    a named apiKeyEnv  →  the credentials service (the launch environment only when no service is mounted)
    no reference       →  pi's own lookup (a Sign-in record under llm-pi-ai/<plane>, then OPENCODE_API_KEY)  →  the installation's store (opt-in)

**pi's own lookup reads `OPENCODE_API_KEY` on both planes** (pi 1.1.0's `providers/opencode.js` and `providers/opencode-go.js` both name that one variable). So a Go entry that names no reference authenticates every Go turn with the Zen key, and a Go key stored in DSH Credentials reaches a Go turn only as the entry's `apiKeyEnv: OPENCODE_GO_API_KEY`. Before P-R1 the Go plane's Responses, Messages and Google turns defaulted to `OPENCODE_GO_API_KEY`; that default went with the hidden routes, and the README's "Changed in 1.x" names it. The meter inherits the consequence: the fetch interceptor files the bearer of a Go-plane request as a Go key, and the meter's `auto` order puts that captured key ahead of the configured `OPENCODE_GO_API_KEY`, so after the first Go turn of a no-reference Go entry the meter sends the Zen key to the Go usage endpoint, which refuses it. `test/host-planes.test.ts` pins both turn cases on the Go plane, and the meter's switch from the Go key to the captured Zen key.

A named reference that resolves nothing is `MISSING_CREDENTIAL`, and no request is sent; a credentials service that fails propagates its own error rather than reading as a missing key. A captured or literal key never answers for the adapter. The installation's store is read only when the deployment sets `readOpencodeStore`, only for a plane that names no reference, and only when pi's own lookup would find nothing: the resolver's answer is handed to pi as the request's explicit key, which pi lets win over its own lookup, so a store key returned any earlier would outrank a Sign-in record or an exported `OPENCODE_API_KEY`.

**The fetch interceptor's fallback is the second, narrower path.** It keeps real request auth untouched and fills only a missing or placeholder credential on gateway traffic, in this order:

    captured → declared environment key → installation key (opt-in) → nothing

The `configured` key-source policy skips the captured fallback; an API key already present in a request is never displaced. Two sources that are no longer in this branch — the DSH grant and the login session — are `v2` work.

Authentication follows the wire format: Bearer for OpenAI, `x-api-key` for Anthropic `/messages`, and `x-goog-api-key` for Google generation. Header extraction skips placeholders when another header carries a real key; placeholder detection is case-insensitive. The URL's pathname determines the plane, not query text or a conflicting turn provider.

**Absence permits fallback; refusal does not.** A missing grant may fall through to the other plane or opt-in installation account. An existing grant whose refresh is refused raises a secret-free `MISSING_CREDENTIAL` error and sends no model request, rather than silently selecting a different owner. The reader returns only the access token and org, not refresh tokens or owner metadata.

The login reader returns the token **and its own org**. The primary request uses that pair directly, not a cached org from another credential; a login without an org removes a stale org header. `credentialOrg` remains the explicit override. Unknown gateway planes do not consult logins. No grant is copied into the installation's database, and its account remains off unless `readOpencodeStore` is on.

One reader is shared by the lifecycle and bridge. It retains per-plane sessions but reads one grant snapshot per operation, so a login written after startup is visible and concurrent callers share one refresh. Refresh preserves the grant's account, owner, org list and selected org while replacing the token pair. Missing, nonnumeric or nonfinite expiry is stale, never an indefinitely current token. The Console client uses the original fetch: refreshing under an active OpenCode turn must not recursively enter the credential fallback.

**Concurrency limit:** refresh deduplication is per shared reader/session, not across independent readers or processes. The seam writes a pair atomically, but does not lock the network exchange; a pending refresh can still race a new login or sign-out. Cross-process coordination and conditional replacement are separate work, not guarantees made by this wiring.

These contracts are exercised with fixture grants and SQLite databases through `apply`, the fetch patch, and the bridge's reader. They verify credential selection and outgoing headers, **not** whether a live gateway accepts a session token on every model endpoint or grants free-tier access. The historical notes below describe earlier investigations; their attempted/reverted edits are not outstanding implementation work.

## The resolution chain

One reference resolves per route:

1. **The route's `apiKeyEnv`** — the reference the deployment declared, resolved through the credentials service when one is mounted and through the launch environment only when none is (a service miss does not fall through to the environment, as in `llm-pi-ai`). This is the zero-configuration default, and the whole behavior for a deployment that declares nothing else.
2. **A named reference that misses fails loud.** Never hand pi an `undefined` for a named ref: it would pick up an unrelated ambient key (`OPENAI_API_KEY` and friends) and bill another tenant.

Where a route names no reference at all, the chain continues into the login and the installation's store — "The handoff" below is where that order lives.

## The planes are separate, so their credentials are

Zen credentials serve Zen calls, Go credentials serve Go calls: the planes are different accounts with different keys, different endpoints and different catalogs. On a plane turn that holds when each entry names its own reference; an entry that names none takes pi's `OPENCODE_API_KEY` on either plane (above), which is why the Go entry should name `OPENCODE_GO_API_KEY`.

A route's credential is an **API key** — a reference in the credential store, or the environment — and that is a measured constraint rather than a first choice: the section below shows a login token is refused by the model endpoints the same way a wrong key is.

## An OAuth token is not an API key on the Zen model endpoint (measured)

The login flows produce an access token. Whether that token can authenticate a MODEL call is a separate question, and the gateway answers it plainly. Three requests to `/chat/completions` on the Zen base, differing only in the credential:

| Credential sent                  | Answer                            |
| :------------------------------- | :-------------------------------- |
| none                             | `401 AuthError: Missing API key.` |
| `Bearer not-a-real-token-abc123` | `401 AuthError: Invalid API key.` |
| `Bearer <a JWT-shaped string>`   | `401 AuthError: Invalid API key.` |

The last two are indistinguishable. The Bearer slot on that endpoint reads an API key and nothing else, so a token presented there is an invalid API key. **This is about `/chat/completions` on the Zen base and nothing wider** — measured later, the account's own token does authenticate on `/inference/openai/v1`, which is a different endpoint with a different credential slot. Read the two together: an API-key slot refuses a login token, and the account plane accepts it.

So the credential a model endpoint wants is an API key, and a login is not one of them. What a login IS good for is the Console's own API — the per-account catalog at `/api/config`, the account and organization context at `/api/user` and `/api/orgs` — and a deployment that wants a login's models needs the Console to exchange it for a key, which is the vendor's flow, not this plugin's.

Recording this because the alternative is wiring a login's token into a model request that answers "Invalid API key" for it, and debugging that as a routing fault.

## (`v2` record) What the logins are (measured from OpenCode's own source)

Both are device flows against the same Console, differing in what they store and what they unlock:

- `POST {console}/auth/device/code` with `client_id: "opencode-cli"` returns a `device_code`, a `user_code` and a `verification_uri_complete`.
- Polling `POST {console}/auth/device/token` with the device grant returns the `access_token`, `refresh_token` and `expires_in`.
- The refresh grant against the same endpoint returns a NEW refresh token with every access token — the stored pair must be replaced atomically, or the next refresh uses a token the server has already rotated away.
- `GET {console}/api/config` — the authoritative per-account model and price catalog — answers to a plain API key.

v1 (`console login`) additionally reads `/api/user` and `/api/orgs`, stores the account and org context, and can switch among them; v2 (`auth login opencode`) stores the provider credential with org metadata but no switching. The plugin implements the flows itself, from those measured endpoints, and stores the results in its own settings — never in the CLI's `auth.json`, which belongs to a program the plugin does not own.

## What the plugin never touches

- **Any route but its two planes.** Since 1.x the plugin mounts no route of its own: a Google model on either plane is served on `opencode` or `opencode-go`, so a real deployment's `google` route (Google AI Studio, say) is never touched.
- **The CLI's `auth.json`.** Reading it couples the plugin to another program's private file format; writing it collides with the program that owns it. The database that replaced it is read only when `readOpencodeStore` is on, and is never written.

## What the seam enforces about writes (verified, not assumed)

Run against the real `dsh-credentials-local` provider on a temporary document, so the measurement never touched a real `~/.dsh/.credentials.yaml`:

| Claim | Result |
| :-- | :-- |
| a fresh reference is writable | `set` then `resolve` returns the value, `source=file`; `describe` reports `configured` and `writable` |
| a write reaches the next operation | a second `set` makes the next `resolve` return the NEW value, with no restart |
| the deployment's own reference is protected | writing a name the launching environment supplies is REFUSED: "is supplied read-only by the launching environment, so set would be shadowed" |
| `unset` returns to unconfigured | yes |
| the store is the document the routes resolve from | the written file is `version: 1` with a `refs:` map — the same shape `~/.dsh/.credentials.yaml` already has |

The third row is the one that matters most: nothing this plugin writes can shadow a credential the deployment declared, because the seam refuses that write outright. The second row is why a grant written while the process runs is visible to the next request with no restart — which is what the org cache and the token reader both depend on.

## The credential the user already has, and this plugin does not read

**The core model is that a user never writes a credential into a DSH profile.** The plugin detects the key from the OpenCode installation and injects it, so a route needs no `apiKeyEnv` and a deployment needs no editing. Today it does not: every key source here is an environment variable name or the DSH credential store, and the one mention of the CLI's own file says it is deliberately **not** read.

That file is where the key is. Measured, keys and types only:

    ~/.local/share/opencode/auth.json
      opencode: { type: "api", key: <51 chars, oc_sk_…> }     ← the Zen key
      xai | openai: { type: "oauth", refresh, access, expires, accountId? }
      cf-coding | google | cloudflare-* | nvidia: { type: "api", key, metadata? }

So the shape is one object per provider, `type: "api"` with a `key`, or `type: "oauth"` with an access/refresh pair — the same two shapes the credential seam already stores, which is why this is a reader rather than a new concept.

**It is OPT-IN, and off by default.** That file is not an interface the vendor publishes; its shape can change with any CLI release, and a plugin that read it unasked would be one whose credential behaviour depends on another program's private state. So the rule is the opposite of convenient-by-default:

- **A key the user defined in their own DSH config is always first.** Until they choose otherwise, nothing here is consulted at all, and the resolution order is exactly what it was before this file was considered.
- **Reading the OpenCode installation is a choice the user makes**, exposed where they make their other choices rather than buried in config, and the file is consulted only after that choice is made.
- **When it is on, it is still last** — after `apiKeyEnv`, after the credential store, after a key captured from a live request — because everything the user said explicitly outranks anything inferred from another program's files.

**And `auth.json` is the LEGACY shape, which is the larger point.** Read from OpenCode 2.0.27's own source (`packages/core`): credentials there are rows in a database, migrated in by `import_legacy_credentials`, and the value is a union of **three** kinds, not the two `auth.json` carries:

    Credential.Key       an API key
    Credential.OAuth     an access/refresh pair
    Credential.External  a credential that lives OUTSIDE - the CLI's own store
                         holds it, and there is nothing here to read

    Credential.Info      { id, integrationID, label, value }

So a reader that only understood `auth.json` would cover the two shapes that file happens to hold and miss `External` entirely - and it would be reading a format the CLI has already moved on from. The opt-in, when it is built, has to read what 2.0 reads: the database, all three kinds, and `integrationID` rather than a provider name.

**And 2.0 already solves the priority problem this file is about.** Its auth model (`packages/ai/src/route/auth.ts`) is a small algebra, and the part that matters here is `orElse`:

    Credential { load, orElse(that), bearer(), header(name) }
    Secret     = string | Redacted | Config.Config<string>

A credential is LAZY (`load` is an effect that can fail), it can be combined with another as a fallback (`orElse`), and one of the things it can be built from is **config** — which is the user's own declaration. So "the user's key first, the installation's only if they asked" is not a rule to invent: it is the shape the vendor already uses, and `orElse` is where the order lives.

Two more details worth copying. Secrets are `Redacted`, so they are never stringified by accident. And a missing one raises a named `MissingCredentialError` rather than resolving to nothing — which is the difference between the failure this plugin spent a long time chasing and one that says what it is.

**The modes, enumerated from the source** (`packages/ai/src/route/auth.ts`), because "several auth modes" is the reason a reader for one file cannot be enough:

    value(secret)        a literal
    config(name)         read from configuration, and FAILS by name when unset
    optional(secret)     absent is allowed, and still reported as missing
    effect(load)         anything lazy that yields a secret
    none / headers / remove / custom / passthrough    header operations
    bearer / apiKey / header(name)                    how a secret is applied

`config(name)` is the one that matters for this plugin's model: a credential may come from the user's own configuration, and the vendor's own reader treats that as one source among several rather than as an afterthought. Which source wins is not encoded in the sources at all — it is `orElse`, applied by whoever assembles them.

So the shape to copy is two-layered, and both layers already exist here in some form: a source list (literal, config, installation, captured request) and an order that puts everything the user declared ahead of everything inferred. Reading a file is one entry in the first list, and the switch that turns it on belongs to the user, not to this plugin's default.

> **(`v2` record, from before 1.x.)** From here to the end of this section, the text describes the Google bridge (`google-bridge.ts`) and `responses-provider.ts`, both deleted in 1.x, and the tests that went with them. Plane credentials are resolved by `planeApiKeyResolver` in `src/host/plane-provider.ts` (D20, above); a login token would join that resolver's no-reference branch, where the opt-in store already sits. The measurements and the two obstacles below are kept as history.

**The two resolution paths, and which one is a gap.** `resolveGatewayKey` is deliberately two-faced, and the difference is tested:

- **A named reference that resolves nothing RAISES.** The message carries the reference and the route, and `MISSING_CREDENTIAL` is in it. The reason is in the test: `undefined` would tell the underlying adapter to "resolve ambient auth instead", and it would bill whatever key it found first.
- **No reference at all answers `undefined`.** That is not a silent failure; it is the instruction the adapter is built to take, and a route that means to authenticate some other way depends on it.

So the reported `401 Invalid API key` on a route with no reference is not this function going quiet — it is the adapter's ambient resolution finding nothing, or finding a key that is not the one the route wanted. Both are answered by naming a reference, and neither is answered by making this function throw.

**The gap that is real is the other one.** A login's token is not usable as a route's credential: `warmOrg` reads the stored grant for the plane's ORG and nothing else, so a deployment that has signed in still needs `apiKeyEnv` on every route. Wiring the grant's access token into the same resolution is what would make a login sufficient on its own, which is the point of having one — and it is the half of the core model that is still missing.

**Where that wiring goes, and in what order.** The bridge already assembles the resolution for every route it serves (`resolveApiKey` in `google-bridge.ts`): `resolveGatewayKey` for the route's own reference, and nothing else where one was named. The login's token belongs at the END of that chain, never the start:

    the route's named reference  →  the stored login

which is the user's rule stated as code — everything they declared explicitly outranks anything the plugin found on its own — and it is the same `orElse` shape 2.0 uses. `warmOrg` already reads the grant per plane and keeps the org; the same read yields the access token, so this is a return value that is currently discarded rather than a new lookup.

**Two files, one new input.** `warmOrg` lives in `lifecycle.ts` and reads the grant per plane; `resolveApiKey` lives in `google-bridge.ts` and resolves a route's key. The bridge already takes an `inputs` object, so the token arrives the same way: `lifecycle.ts` passes a `loginToken(plane)` in it, and the bridge calls it only where a reference was not named. That keeps the read in the module that already knows how to make it, and keeps the bridge from learning about the credential store.

**Attempted once and reverted, and the two obstacles are worth writing down** so the next attempt is a single pass rather than a lint loop:

**The edit itself is settled — 34 lines across two files, verified green before it was reverted.** What stopped it was the TEST, not the code: `vp check` passed, all 765 tests passed, and the coverage ratchet then failed on the two new lines. So the next attempt starts from this, not from the analysis:

    google-bridge.ts
      GoogleBridgeInputs gains:
        readonly loginToken?: (plane: string) => Promise<string | undefined>;
      resolveApiKey's tail becomes:
        const named = resolved.apiKeyEnv;
        if (typeof named === "string" && named.length > 0) {
          return resolveGatewayKey(ctx, named, String(route));
        }
        return inputs.loginToken?.(
          String(route).startsWith("opencode-go") ? "opencode-go" : "opencode"
        );

    responses-provider.ts
      imports: createTokenStore from "./token-store.ts", name from "./identity.ts"
      in the object the bridge is registered with:
        loginToken: async (plane) => {
          const store = createTokenStore({
            credentials: readCredentialsWriter(ctx), plane, scope: name,
          });
          const login = await store?.read();
          return login?.accessToken;
        },

No try/catch is needed: the store's `read` is documented to answer `undefined` when nothing is stored and does not throw, which is also what removed both obstacles above.

**And the test it needs** mirrors the one at `test/google-bridge.test.ts` that streams through the real adapter with `BRIDGE_STREAM_KEY` set: register the bridge with `apiKeyRef: ""` and a `loginToken` that returns a sentinel, intercept the request, and assert the `Authorization` header carries the sentinel. That is the whole of what is left.

**The one thing the first test attempt got wrong, measured.** `auth.apiKey.resolve` is not on the adapter instance. It is built in a closure and handed to the adapter's CONSTRUCTOR (`Reflect.construct(adapter, [{ auth: { apiKey: { name, resolve } } }])`), so reaching it means going through `adapter.stream(...)` — which is what the existing stream test already does. It is also SYNCHRONOUS: it returns `{ auth: { apiKey }, source }` rather than a promise, and the comment above it says so, because pi awaits the value.

**And the second attempt got one step further, which narrows the test precisely.** With the edit applied and a test that mirrors the stream test, `vp check` passed and 16 of 17 tests passed — the new one failed on `expected undefined to be 'Bearer st_from_login'`, meaning the captured headers were EMPTY: the request never reached the patched `fetch` at all, so the stream had already failed before the key mattered.

**And one hypothesis is ruled out for the next attempt.** `registerGoogleBridge` destructures `const { ctx, host, llm, specs } = inputs` and then reads the rest of `inputs` directly, so `inputs.loginToken` reaches `resolveApiKey` without being dropped — the edit needs no change on that account. The failure is in the test's route to `fetch`, not in the wiring.

**And one gap the wiring opens, which the next pass should close with it.** The grants are keyed per plane, and both sides derive the plane with the same rule — `opencode-go` for a Go route, `opencode` otherwise. But the sign-in card defaults to `opencode`, so a user who signs in once has a grant the Go routes never ask for, and those routes fall through to `undefined` exactly as before.

**And a second one, in the same shape: the org cache is warmed once, at startup.** `lifecycle.ts` reads the stored grant for both planes before the first request can need it, and `orgByPlane` is then consulted per request. But a LOGIN happens after that — the user signs in from the card, minutes or hours into the process — so the cache still holds whatever was true at startup, and the requests that follow carry no `x-opencode-org-id` even though the grant now has one.

**The shape of that fix, since the hook cannot await.** `patchFetch` asks for the org synchronously — `hooks.resolveOrg?.(plane)` — so the reader cannot go to the store itself; it has to be told. Two ways, and the second is smaller:

- the login, on completing, refreshes the cache for the plane it wrote; or
- the cache lives in its own small module that both `lifecycle.ts` and the login service import, so writing a grant updates what the next request reads.

The second is one new file and no plumbing, and it is the same answer as the token reader: the value is kept next to the thing that changes it.

**Applied, and this is the note that asked for it.** That one new file is `src/org-cache.ts`, and `orgByPlane` above names the shape it replaced: the cache is no longer read once at startup but written by the login service when a login completes, so a grant that appears minutes later is what the next request reads. The paragraph is left as written because it is the reasoning that produced the module, not a description of the tree.

Both gaps are the same mistake: a value that can change while the process runs, read once and kept. The token reader was the first; this is the second, and the fix is the same shape — read it where it is needed, or refresh it when the thing that feeds it changes. The login completing is exactly that event, and it already knows which plane it wrote.

Measured earlier in this file: the account token is not plane-specific. The same token serves `/inference/openai/v1` with its org, and the same key answers on both planes. So one sign-in should serve both, and the reader should try the plane it was asked for and then the other one before answering `undefined` — three lines in `loginTokenReader`, plus the case that pins it.

The existing stream test gets past that point by setting `process.env. BRIDGE_STREAM_KEY` before it registers. A test for this branch needs the same: give the route a resolvable key by some other means so the stream reaches the request, and let the assertion be about which of the sources supplied it. That is the only piece still missing, and it is one line in a test that already exists.

So the test is the stream test with two changes: register with an empty `apiKeyRef` and a `loginToken` returning a sentinel, then assert the request's `Authorization` header carries the sentinel. The interception boilerplate is already written there.

1. `responses-provider.ts` does not import `createTokenStore`, and its import block is ordered, so the new import has to go in the right place rather than appended.
2. The reader's `catch` cannot be `return undefined` (the lint calls it useless) and cannot be a bare `return` either (a useless return at the end of a function) — so the branch needs to return a value the function already has, or the reader needs a different shape. `undefined` is the right ANSWER here; the obstacle is how the lint config wants it expressed.

Everything else is in place: the bridge's `resolveApiKey` already has the exact branch to extend (it returns `resolveGatewayKey` for a named reference), and the plane is derivable from the route id the bridge already receives.

## Status

Built, in the order this file sets out:

- **The device-flow client.** `src/console-auth.ts`: one client serves both logins, written against the measured responses. `start` asks for a code, `poll` reads the Console's own error field rather than its status, and `awaitAuthorization` waits at the endpoint's interval — doubling it after a `slow_down`, which is what that error asks for. The verification URI is resolved against the Console, because the endpoint answers a relative path and opening that verbatim opens nothing. `refresh` returns the pair together, because the Console rotates the refresh token with every access token and the caller must write both halves at once. It also reads what the login must know before it stores anything: `GET /api/user` for the account and `GET /api/orgs` for its organizations, both with the session token as a bearer credential, which is the same pair the client itself reads. Verified against the live Console: this module's own client obtained a code, read the interval, and reported two pending polls.

- **A login in use.** `src/login-session.ts`: the store and the client are joined. A token inside the window is refreshed before it is handed out, so the call it authenticates is the one that succeeds; concurrent callers share one refresh, because a refresh rotates the refresh token and two of them would present one the server has already replaced. Nothing is invented: no login, no refresh token, and a refusal each report a failure rather than a credential that looks present and is not.

- **The flow that keeps what it learned.** `src/login-flow.ts`: ask for a code, wait for the approval, read the account and the orgs with the token just obtained, then write ONE grant — the pair, the account, the email, the orgs and the active org. If the owner cannot be read the login FAILS and stores nothing: a token stored without its org is a credential whose owner has been forgotten, and the org is half of what the gateway asks for. It looks like success and is a credential nobody can complete.

  **What a login buys is not the free tier, and the surface exists anyway.** The org is necessary and not sufficient: measured with this machine's own account — its session token, its active org, and every header captured from the real client — a free-tier model still answers `403 FreeTierError`, on both endpoints. The gate is not in the HTTP request, so it is either a client fingerprint or a signature sent only to the real host, and the error's own words may simply be true. A login is what the free tier is asked FOR; whether it is granted is a separate, unmeasured question. The first org is activated, matching the client.

- **The org on the request.** `fetch-patch.ts` sends `x-opencode-org-id` from a per-plane resolver — asked per request, because a login can arrive while the process runs — and invents no header when a plane's credential is a plain key, which is every key deployment. `credentialOrg` is the explicit fallback for a token that came from elsewhere.

Built, and the account plane it serves:

- **The login remote.** `src/login-contract.ts` is the three calls a settings card makes — `begin` answers the code and the URL to open, `poll` asks whether the human has approved, `state` answers what is stored — with codecs both sides read, so a card cannot disagree with the host about what an answer means. A credential never crosses: the parser is a whitelist, and a test sends a state carrying both tokens to assert they are dropped.

  `src/login-service.ts` is the host half, mounted by `apply` beside the meter's service. It holds one attempt at a time, because a device flow is a code a human is holding; a refusal ends it and a wait does not; and `state` re-reads the stored grant per call, so a card sees a login appear the moment the flow completes — including one the CLI completed.

  **And the card that calls them is built too.** `src/settings-login.tsx` is the sign-in row above the settings form: it says who is signed in, offers the action, and once a flow starts it shows the code, an openable URL and that it is waiting. It polls at the interval the Console asked for and ends on its own three ways — signed in, refused, expired — so a page left open does not ask forever. A host that mounted no login service **renders the row anyway, and the row reports it** — deliberately the opposite of the meter's choice, which hides itself. Resolving the remote once at inject time raced the asynchronous mount and left the row absent with no retry, so the calls are now handed over unconditionally and each resolves the service when it is invoked. "No row" and "no service" no longer look identical.

The page hands it the remote by reading `ctx.remote` rather than declaring `remote.opencodeLogin` as an inject key, because a declared key is a HARD dependency: it would hold the whole plugin waiting for a service a host may not mount.

What a login is FOR is measured, not assumed: the account's session token, on `/inference/openai/v1` with its org, serves a paid model — `deepseek-v4.1-flash` answers `200` — while the free tier refuses it. So the account plane is a working credential for real traffic, and the free tier is the part that is not granted rather than the part that is broken.

Built, and the opt-in reader it prepared for:

- **The installation's own store, read only when asked.** `readOpencodeStore` is a config field, default `false`, with a card control beside the credential-source select. When it is on, `resolveOpencodeStoreKey` reads the credential OpenCode itself holds for the plane in hand and the step sits LAST in all three key-source policies — after a literal, after a captured request, after the named reference and the environment — so a credential declared in DSH always wins. Both paths that resolve a request's key consult it: the fetch interceptor's Authorization fallback, and the plane adapter's resolver (`planeApiKeyResolver`) for a plane that names no reference. Nothing logs a value from it, and `node:sqlite` keeps the module on the host side of the bundle rule.

## Reading the installation's own credential store needs no dependency

The opt-in reader was parked on a dependency question: OpenCode 2.0 keeps its credentials in a database rather than a JSON file, so reading it needs SQLite, and adding a driver to a plugin this small is a decision rather than a detail.

That decision is now measured rather than open. `node:sqlite` is a built-in on the Node this host runs (26.x), exporting `DatabaseSync`, `StatementSync` and `backup`, so the reader can open `~/.local/share/opencode/opencode.db` with no new dependency at all. The constraint it inherits is the bundle rule: `node:sqlite` is a host-only import, so the reader lives on the host side and the client never reaches it — which is what `scripts/check.ts` enforces rather than what anyone has to remember.

**And the path is not a constant, which is the part worth knowing before writing it.** Two files in `~/dev/opencode` decide it, and neither branches on the operating system:

- `packages/util/src/global-roots.ts` resolves the directory as `$XDG_DATA_HOME || ~/.local/share`, then joins `opencode`. So macOS and Windows use the same XDG layout as Linux — no `~/Library/Application Support`, no `%APPDATA%` — and on Windows that means `%USERPROFILE%\.local\share\opencode`. `os.homedir()` is the only platform-dependent call.
- `packages/cli/src/database-path.ts` resolves the filename as `$OPENCODE_DB`, else `opencode.db` when the channel is one of `latest | dev | beta | next | prod` or `$OPENCODE_DISABLE_CHANNEL_DB` is `1`/`true`, else `opencode-<channel>.db`. It also honours `:memory:` verbatim, which is not a path at all.

Underneath both is `packages/util/src/global.ts`, which resolves FIVE roots through `roots(app)` — `data`, `cache`, `config`, `state` and `tmp` — each from its own `$XDG_*` variable with a `~/.local/share`, `~/.cache`, `~/.config`, `~/.local/state` and `os.tmpdir()` fallback. `home` is separate and is `$OPENCODE_TEST_HOME ?? os.homedir()`. Two consequences for a reader: the database is under **data** while the config is under **config**, so they are different directories and one root cannot serve both; and a test-home override moves where `~/.agents` and `~/.claude` resolve, so "the user's home" is not always `os.homedir()` either.

So a reader that hardcodes `~/.local/share/opencode/opencode.db` is right on a stable channel and wrong on every other one, wrong again when `$OPENCODE_DB` points elsewhere, and wrong a third time under a moved `$XDG_DATA_HOME`. It should ask the same questions in the same order, and treat "no file at the resolved path" as the ordinary case rather than an error.

The shape it would read, taken from the schema rather than guessed: `credential(id, integration_id, label, value, connector_id, method_id, active, time_created, time_updated)` and `account(id, email, url, access_token, refresh_token, token_expiry, time_created, time_updated)`. That is the same three kinds `~/dev/opencode`'s `Credential.Key | OAuth | External` describes — an API key lives in `credential.value` with its `integration_id` naming the provider, and a login lives in `account` with the token pair and its expiry. So the reader is two queries and a whitelist, and the login one is an alternative to the device flow rather than a second thing to invent.

**It stays opt-in and off by default.** A declared DSH credential is always the first answer, and reading another tool's store is something a user turns on, not something that happens to them.

## (`v2` record) The wiring, which is now built

The two modules existed and were tested before anything called them. The wiring below is built: a config field with no reader is an empty switch, which this repository has already been audited for once, and the edits went together.

1. `src/config.ts` — `readOpencodeStore: false` in `CONFIG_DEFAULTS` (the object is alphabetical, so between `providers` and `sessionIdEnv`), the matching optional field on `PluginConfig`, and a `z.boolean().default(...).volatile()` row in the schema with a description that says what it reads and that it is off by default.
2. `src/go-discovery.ts` — one more entry in the step map `firstResolved` takes, and **last in every policy**, because the user's own declaration wins: `opencodeStore: () => readFromStore(ctx, plane)`. It resolves the path with `opencodeDatabasePath({ channel: process.env.OPENCODE_CHANNEL, env: process.env, home: os.homedir() }, os.tmpdir())`, reads with `readOpencodeCredentials`, picks the entry whose `integrationId` matches the plane, and answers `undefined` for everything else — a missing file included.
3. `src/settings-fields.ts` — one `CARD_FIELDS` control, which is what makes the switch reachable.
4. **Which of the two mechanisms to use, now that both have been read.** `discoverGoConfig` walks `ctx.loader.entries()` and reads `entry.options.config`, but that is the PROVIDER REGISTRY — the rows that describe `opencode-go` and `opencode` — not this plugin's own configuration. This plugin's own config arrives as a VALUE: `fetch-patch.ts` receives `config: ResolvedPluginConfig` as a parameter, and `lifecycle.ts` is what passes it. So the new step should take the flag as an argument threaded from `lifecycle` rather than dig for it in the loader, and that means `resolveGoApiKey` needs one more parameter (it currently takes `ctx`, `targetProvider` and `policy`).
5. The config travels as VALUES rather than as a config object: `lifecycle.ts` resolves it with `resolveConfig` and passes fields down. `usage.ts:285` calls `resolveGoApiKey(...)` for the meter and `fetch-patch.ts:253` reads `config.keySource` directly for the headers, which is the precedent for how a field arrives. **The model-call path is now traced, and it is `fetch-patch.ts`**: the interceptor's Authorization fallback is what fills the `Bearer unused` sentinel the internal routes carry, so that is where a request's own key is resolved. The other one is `google-bridge.ts`'s `resolveApiKey`, the per-request resolver for the `opencode-google` route specifically — `responses-provider.ts` calls neither `resolveRoutedKey` (since deleted in 1.x: it was exported and never called from `src/`) nor `resolveApiKey`, as the grep said; it hands the bridge its inputs, and the flag travels that way. Both consult the store only after the captured key and the declared environment, so they agree with the meter.
6. Tests: the step answers a key from a store this suite builds, answers `undefined` with the switch off, and still loses to a declared credential and to a captured one; the fetch patch fills its Authorization header from the store, per plane; and the bridge carries a stored login over the store.

**One bug the wiring found, worth recording because the login reader masked it.** `google-bridge.ts` derived the plane with `String(route).startsWith("opencode-go")`, and `"opencode-google"` starts with `"opencode-go"` — so the Zen route was read as the Go one. `loginTokenReader` hid that by falling back to the other plane; an integration-id lookup does not, so the derivation is now an exact route comparison.

The login half is separate and smaller: `readOpencodeAccount` is an alternative to the device flow, so it belongs wherever a stored grant is read, and it needs the same opt-in rather than its own.

**And it is wired, so a user who has already signed in to OpenCode does not have to run the device flow again.** The bridge's tail now resolves in this order:

    the DSH grant (refreshed through `createLoginSession`)
      → the installation's stored account, when `readOpencodeStore` is on
      → the installation's stored key, when it is on
      → nothing

Four things about that are decisions rather than details.

**One switch, not two.** The account shares `readOpencodeStore`, because the question the switch answers is one question — may this plugin read another program's store at all — and a second switch would be a second way to say the same thing. A switch whose effect only exists inside another switch's surface is a state, not a decision.

**The account never displaces a DSH grant, and the grant's org is never replaced by the account's.** They are different credentials: another program's store, another owner, possibly another account. So the account is consulted only after the grant, it is read and used and left alone — nothing writes it into the DSH seam — and the org that travels with it is recorded only on the path where the account's token is the one being used. Pairing one credential's token with another's org is worse than sending no org at all.

**Where the org comes from, and that it CAN be known.** A session token is half a credential: the gateway answers one sent without its org as though it were a plain key. The org is not in the `account` row — the migration `20260309230000_move_org_to_state` moved it out of `account.selected_org_id` and into `account_state.active_org_id`, which is why the reader asks that table rather than the account's own columns. So an account read this way can carry an org, and it does: `readOpencodeAccount` joins `account_state` on `active_account_id` and returns `active_org_id` beside the token, taking the account the state row names as active rather than whichever row happens to be first. Both tables come from the same migration, so a database that has `account` at all has `account_state` next to it.

**An expired stored token is used anyway.** Nothing here can refresh an OpenCode account — that would mean writing to their store or calling their refresh endpoint — so `token_expiry` is deliberately not consulted. The gateway's answer is the truth about a token, and the alternative, treating it as absent, would tell a signed-in user they have no credential when they have one that is merely old. The test pins it with an expiry in 1970.

One consequence worth stating plainly rather than discovering later: on an endpoint whose credential slot reads an API key, an account token is refused — measured for `/chat/completions` at the top of this file. A deployment that has BOTH a session in the installation's `account` table and a key in its `credential` table therefore now prefers the account token on this route, where before it used the key. That is the precedence this file sets out, and it matches OpenCode's own behaviour — when it is signed in, the session credential is the one it sends — but it is a behaviour change on a machine that has both, and it is not measured for the Google endpoint this bridge serves.

## (`v2` record) The handoff: free and paid authentication, stated plainly

Everything below is measured against the live gateway and a real installation, or is marked as not measured. It is written for whoever picks this up next, so the parts that were wrong once are called out rather than quietly dropped.

### The two planes

|  | Zen — the OLD api | Go — the NEW api |
| :-- | :-- | :-- |
| base URL | the catalog's `opencode.api` | the catalog's `opencode-go.api` |
| env var | `OPENCODE_API_KEY` | `OPENCODE_GO_API_KEY` |
| the catalog's value today | `…/inference/v1` | `…/inference/go/v1` |
| key shape | `oc_sk_…`, 51 chars | `sk-…` |
| org on the request | **not needed** | **needed** — `x-opencode-org-id` |
| session header | accepted, not required | **required** (`400 MissingSessionID` without) |

The org distinction is the one that matters most and was got wrong twice: it belongs to the **Go** plane only. `src/fetch-patch.ts` already scopes it per plane through `hooks.resolveOrg?.(gatewayPlaneFor(url))`.

### The two sources, and which is which

1. **DSH's own credential seam** — what the plugin reads through `readCredentialsWriter`, and what the host resolves from a provider row's `apiKeyEnv`.
2. **OpenCode's own installation** — a SQLite database, opt-in, read-only, off by default. `src/opencode-paths.ts` finds it; `src/opencode-store.ts` reads two tables.

Two facts about the second one that cost real time:

- **Every `credential.value` is a JSON document, not a bare key.** `{type, key, metadata?}` for `opencode`, `google`, `cf-coding`, `nvidia` and the two Cloudflare integrations; `{type, methodID, refresh, access, expires}` for `xai`. `readOpencodeCredentials` extracts `key` or `access` and answers `undefined` for any other shape. Sending the raw document earns `Invalid credential` — or, on a free model, a refusal that reads as though the MODEL were unusable. It is not.
- **`account` is a different shape and a different question.** `access_token` and `refresh_token` are bare 39-char strings, `token_expiry` is ms. The org is NOT in that table: it is `account_state.active_org_id`, joined on `active_account_id = account.id`.

### The Zen free tier is refused, exhaustively

Every combination below was sent to `https://opencode.ai/zen/v1` against a Zen `-free` id, and every one answered `403 FreeTierError` while a paid model on the same request answered `200`:

| What was varied | Tried |
| :-- | :-- |
| credential | bare API key (`oc_sk_…`, 51 chars) · account session token (`st_…`, 39 chars) · the token **with** its org (`wrk_…`) · **no credential at all** · the literal `public`, the client's own keyless value |
| structure | bare body · with the `read` and `bash` tool schemas the fallback injects |
| headers | `x-opencode-client: cli` · `user-agent: opencode/1.19.4` · a valid `x-opencode-session-id` (`ses_…`) · **the complete set captured from the client**, `x-opencode-request` included |
| endpoint | `/chat/completions` · `/responses` · `/inference/openai/v1` |
| runtime | Node's fetch · Python's urllib · **Bun**, the runtime the real client ships on |

So the refusal is not about structure, data, headers, route, credential class or runtime. It is per-model, it is not in the request, and no patch reaches it.

**The observation that made this look wrong is worth stating**, because it is the reason this was got wrong twice: a session appears to run on free models. It does not. The model-change notices name `global:step-5-preview` — this host's own model, **not in OpenCode's catalog at all** — while the failures name `opencode/step-5-preview-free`, `opencode/space-bunny-free` and `opencode/muse-spark-1.3-contributor-free`. The names differ by one `-free` suffix and the providers are entirely different.

**Plane matters, and that is why the hide was scoped to Zen in the rounds it existed.** `step-5-preview-free` and `longcat-2.5-preview-free` appear on BOTH planes; `space-bunny` and `muse-spark-1.3-contributor` are Go's. So the exclusion was `provider === "zen" && id.endsWith("-free")` — never an id list and never global.

**That rule broke eleven tests, and they were not mechanical.** Several encode deliberate behaviour about which models are offered (`adds Space Bunny and removes retired 1.2`, `preserves Space Bunny while removing retired Muse 1.2 rows`), and `muse-spark-1.3-contributor-free` is the fixture six suites use for a responses-format model. Changing them is a design decision about what this plugin offers, not a rename; it was attempted and reverted rather than half-applied. The decision that followed — and stands — is to offer the ids and report the refusal per request, so no such rule exists in `src/models-discovery.ts` today.

### What is measured about the free tier

With the real key, sent by a bare HTTP client to `/zen/v1/chat/completions`: `space-bunny-free`, `step-5-preview-free` and `muse-spark-1.3-contributor-free` each answer `403 FreeTierError` ("OpenCode's free tier can only be used from within OpenCode"), while `deepseek-v4.1-flash` answers `200`. Both `/chat/completions` and `/responses` refuse identically, so the response format is not the discriminator.

**Corrected twice, and the second correction is the one that matters.** A paragraph here once said the refusal was true only of bare HTTP clients and that "this plugin, which reaches the gateway through the host's own `llm-pi-ai` adapter, serves these models". That was wrong, and the run that would have shown it was made later: with the account's session token, its active org and the complete header set the client sends, a free-tier Zen model answers `403 FreeTierError` on both endpoints while a paid model on the same request answers `200`. The adapter clears the PROTOCOL — a `/responses` model reaches the right shape — and it does not clear this gate, which nothing sent from a request does.

**A note on a claim that stood here and was wrong.** This section used to say that a session running on a free model works, that the key the plugin captures from a live request is therefore accepted by the free tier, and that the refusal is about a bare API key rather than the tier — and it concluded that excluding free models was the wrong fix. All of it was withdrawn. The session that appeared to run on a free model was running on `global:step-5-preview`, **this host's own model and not in OpenCode's catalog at all**; the free tier had never served anything here. The exclusion was reinstated once after that correction and withdrawn again — the models are offered today, and the refusal is reported per request in the gateway's own words (the gateway's own `403 FreeTierError`), because hiding a row the vendor may serve is the worse failure. The source-confirmed account of where the refusal is decided is in `docs/opencode-1.19-api.md`.

The lesson is recorded rather than deleted, because the same two moves produced it twice: a credential that failed was read as evidence about the tier, and a model whose name differed by one `-free` suffix was read as the same model.

### The order, which is the spec and was inverted once

```
captured        ← the credential a user already connected with, and that works
declared        ← apiKeyEnv; "almost always", and overridden when a working oauth exists
store           ← the local OpenCode CLI's database, only when neither is configured
```

`src/fetch-patch.ts` implements exactly this. Do not invert it: a test named "fills the Authorization header from the installation's store, last" exists for that reason.

### What is open, and what is no longer

- **The free tier is refused on Zen for every shape this plugin can assemble, and the ids are offered anyway.** The plugin does not use a bare client — it reaches the gateway through the host's `llm-pi-ai` adapter — and that is what produced the claim this line used to make: that a session running on `opencode/step-5-preview-free` produces turns normally, so the adapter clears the gate. **It does not, and the run was made.** With this machine's session token, its active org and the complete header set the client sends, a free-tier Zen model answers `403 FreeTierError` on both endpoints — the measurement in the login section above, which postdates this one and contradicts it. What the adapter does clear is the PROTOCOL: the session that appeared to run on a free model was running on `global:step-5-preview`, this host's own model, not in OpenCode's catalog at all. `step-5-preview-free` produces turns **on the Go plane**, which has no free tier to gate and serves it by the subscription key — and Go's three are not the exception that proves a rule: Zen's free ids are offered too. The console's source shows the refusal is made by the vendor's inference service, which receives these requests keyless and answers for them; a refusal that names itself per request is what a reader should be given instead of an empty picker, so `src/models-discovery.ts` offers the ids and `fetch-patch.ts` passes the refusal through as `403 FreeTierError`, in the gateway's own words.
- **`auto-review` needs no change of its own.** It builds a bare options object and takes its route from `session.requestHeader()`, so it inherits whatever the session selected — which is why it failed on a free model the chat appeared to be using. Free models are offered, so a new selection can land there; the turn then stops with the gateway's own refusal, passed through verbatim rather than rewritten. **A session already on one keeps failing until the model is changed**, which is the same statement for the picker as for an existing selection.
- **`readOpencodeAccount` is wired into both request paths through the shared login reader**, and the account token with its org was measured to serve a paid model (`200`). It does not help the free tier, which nothing does.
- **The store is read per request with no cache**, deliberately: a rotation inside OpenCode should be picked up. It is also a SQLite open per keyless request.
- **The id collision is addressed the only way it can be**: `muse-spark-1.3-contributor-free` is no longer offered, so the host's own model of nearly the same name cannot be confused with it in the picker.

### The two keys and the two endpoints are not a constraint, measured

Four combinations, one paid model and one free model, all with the same client headers:

| credential | endpoint | `deepseek-v4.1-flash` | `step-5-preview-free` |
| :-- | :-- | :-- | :-- |
| the deployment's `OPENCODE_API_KEY` | `…/zen/v1` | **200** | `403 FreeTierError` |
| the deployment's `OPENCODE_API_KEY` | `…/inference/v1` | **200** | `403 FreeTierError` |
| the installation's `auth.json` key | `…/zen/v1` | **200** | `403 FreeTierError` |
| the installation's `auth.json` key | `…/inference/v1` | **200** | `403 FreeTierError` |

**So neither key is bound to either endpoint.** They are two paths into one gateway, which is what `opencode-1.19-api.md` said before any of this, and a plugin does not have to pick between them for the credential's sake. A route that was built to move a request from one family to the other on the strength of the key's format was withdrawn for exactly this reason.

**And the free tier is refused to all four**, while the same plugin serves `opencode/step-5-preview-free` normally **on the Go plane**. That is the shape of the gate: it is not the credential, the endpoint, the headers or the body — every one of those has been varied to exhaustion, and the last two shapes to be closed (the complete client header set with the message id, and keyless `public` from Bun) went the same way on 2026-10-18 — and it is a gate the plugin never cleared, on Zen or anywhere else. The Go plane is a different question rather than a different answer to this one: it has no free tier at all, so the subscription key serves its free models exactly as it serves its paid ones. The two keys are also different values - the installation's is the one OpenCode 2.x minted, the deployment's is the one the profile declares - and the deployment's two environment variables hold the _same_ key, so they do not distinguish the planes. The entry name does, in both stores.
