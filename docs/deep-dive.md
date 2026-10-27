# Deep dive: protocol specification

### 1. The header injection matrix

Decompiled from the official `opencode` CLI binary, the gateway enforces different headers for native OpenCode routes versus third-party relays:

```javascript
// Extracted from OpenCode CLI's HTTP request builder:
headers: {
  "x-opencode-session-id": e.sessionID,
  ...(e.parentSessionID ? { "x-opencode-parent-session-id": e.parentSessionID }: {}),
  ...(e.model.providerID.startsWith("opencode")
    ? {
        ...(k ? { "x-opencode-project": k }: {}),
        "x-opencode-session": e.sessionID,
        "x-opencode-request": e.user.id,
        "x-opencode-client": e.flags.client,
        "User-Agent": _i
      }
   : {
        "x-session-affinity": e.sessionID,
        "X-Session-Id": e.sessionID,
        "User-Agent": _i
      }),
  ...(e.parentSessionID ? { "x-parent-session-id": e.parentSessionID }: {})
}
```

The fetch patch satisfies every variant:

| Header | Value | Purpose |
| :-- | :-- | :-- |
| `x-opencode-session` | `ses_<12hex><14base62>` | Vendor conversation affinity; enables KV-cache prompt routing |
| `x-opencode-session-id` | `ses_<12hex><14base62>` | Required by OpenCode CLI v1.18+ gateways |
| `x-session-affinity` | `ses_<12hex><14base62>` | Generic proxy/relay affinity (Cloudflare AI Gateway, LiteLLM, Portkey) |
| `x-opencode-parent-session-id` | `ses_<parent_hash>` | Hierarchical lineage for DSH subagents (`subagent`, `subagent_fork`) |
| `x-parent-session-id` | `ses_<parent_hash>` | Generic proxy parent-session affinity |
| `User-Agent` | `opencode/1.19.4 …` | Prevents Cloudflare WAF Error 1010 challenges. The constant lives in `identity.ts`, aliased as `OPENCODE_UA` in `session.ts`; the patch version tracks the CLI |
| `x-opencode-client` | `cli` (configurable) | Identifies the client tier to the Zen gateway |
| `x-opencode-project` | dynamic / `global` | Workspace project attribution for the Console |

### 2. Hierarchical subagent & parent session lineage

When DSH spawns subagents (`subagent` / `subagent_fork`), each child runs in a separate session. The plugin inspects the host `SessionRegistry` for `session.header.parentSession`, and derives an id for each of them the way the vendor's own generator does. SHA-256 supplies the suffix bits and the counter; the twelve hex characters carry the session's real `createdAt`, because the vendor parses that field back as a timestamp and a hash there would hand it a random instant:

```
[Parent DSH Session: "session-abc"] ──> [ses_<12hex><14base62>]
           │
           ▼ spawns subagent
[Child DSH Session:  "session-xyz"] ──> [ses_<12hex><14base62>]

Outgoing subagent request:
  x-opencode-session:           ses_<child 12hex><14base62>
  x-opencode-session-id:        ses_<child 12hex><14base62>
  x-session-affinity:           ses_<child 12hex><14base62>
  x-opencode-parent-session-id: ses_<parent 12hex><14base62>
  x-parent-session-id:          ses_<parent 12hex><14base62>
```

This lineage lets upstream servers optimize prompt caching across agent teams and delegation workflows.

### 3. Dynamic workspace project attribution

OpenCode uses `x-opencode-project` to group token usage, requests and cost in the [OpenCode Console](https://opencode.ai/console).

1. Enabled (default): the plugin reads the active session's working directory (`session.header.cwd`) and sends its folder name: `/home/you/projects/my-app` → `x-opencode-project: my-app`. Outside a project it falls back to `global`.
2. Disabled: the header is omitted entirely, matching OpenCode CLI's standalone behavior.
3. Zero configuration: no project strings to type or manage: attribution follows your workspace naturally.

### 4. DSH experimental Auto Review compatibility

With the experimental **Auto Review** mode (`@deepseek-ai/dsh-experimental-auto-review`), every tool execution is audited by a background model call first:

```javascript
// @deepseek-ai/dsh-experimental-auto-review
async function classifyRisk(ctx, agent, exec, signal) {
  const snapshot = snapshotAutoReview(agent, exec);
  const options = deepFreeze({
    provider: snapshot.provider,
    model: snapshot.model,
    system: REVIEW_POLICY,
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: reviewUserText(snapshot) }],
      },
    ],
    temperature: 0,
    signal,
  });
  return readDecision(ctx.llm.stream(options));
}
```

Because these calls omit `options.sessionId`, earlier plugin versions short-circuited the stream hook, leaving the turn store empty and sending review requests out unpatched (`TRANSPORT: Connection error`). The plugin now generates a deterministic fallback turn state whenever `sessionId` is omitted, so Auto Review streams receive full header injection and the free-tier tool schemas.

**A pinned session header used to defeat that fallback, and the shape is the reason.** The resolver kept any existing `x-opencode-session` that started with `ses_`, and a deployment that pinned `ses_dsh_default` starts with `ses_` and is not a session id: the gateway answers it `401 Invalid API key`, which reads exactly like a bad credential. A request inside a tracked turn never touched that path — it uses the id derived from the turn — so the main session worked while every Auto Review pass failed. **That last clause used to read "on the same model", and it was wrong**: the session that worked was on `global:step-5-preview`, this host's own model and not in OpenCode's catalog at all, while the failures named `opencode/…-free` ids. One `-free` suffix apart and two different providers, which is why the failure was read as a plugin problem for as long as it was.

The resolver now checks the format (`ses_` + 12 hex + 14 base62) in both places a value can arrive from outside, an existing header and the configured env var, and replaces one the gateway would reject.

**And a second failure mode has nothing to do with any of this.** Auto Review also answers `429 RATE_LIMIT: Upstream request failed: Endpoint is unavailable` when the reviewer's own endpoint is rate-limited or down, and the tool call is refused before its body runs. That is not the model, the tier, or this plugin.

### 5. OpenCode API tiers: V1 vs V2, Zen vs Go

```
┌────────────────────────────────────────────────────────────────────────┐
│                        OpenCode API surfaces                           │
├───────────────────────────────────┬────────────────────────────────────┤
│   V1 inference gateway (data)     │    V2 control-plane API (manage)   │
├───────────────────────────────────┼────────────────────────────────────┤
│ • https://opencode.ai/zen/v1      │ • https://api.opencode.ai          │
│ • https://opencode.ai/zen/go/v1   │ • Local server: @opencode/client   │
│ • Static API keys:                │ • OAuth token pairs:               │
│     - Go:  sk-… (subscription)    │     { type: "oauth",               │
│     - Zen: oc_sk_… (pay-as-you-go)│       access: "…", refresh: "…" }  │
│ • Chat completions, models, quota │ • Sessions, tools, workspaces      │
└───────────────────────────────────┴────────────────────────────────────┘
```

Two endpoint levels, and two ways to authenticate. The endpoints above are not pinned in the CLI's source: they come from the catalog (`models.dev`), which defines a **provider default** (`api` on the provider (`https://opencode.ai/zen/v1` for Zen, `https://opencode.ai/zen/go/v1` for Go) and a per-model **inference** endpoint (`model.api.url`) that overrides it. `provider.ts` resolves `model.api.url ?? provider default`, so every model inherits the default today) but the mechanism is two-level, and a model that sets its own URL is served from it.

Authentication follows the **wire shape**, not the endpoint: the OpenAI planes (`/chat/completions`, `/responses`) send `Authorization: Bearer <key>`; the Anthropic plane (`/messages`) sends `x-api-key: <key>`. `extractApiKeyFromHeaders` reads `Authorization` first and falls back to `x-api-key` / `api-key`, which is what makes one credential usable no matter which plane the adapter routed the turn through.

Credential isolation (preventing `403 EntitlementError`). The Go quota endpoint (`https://opencode.ai/zen/go/v1/usage`) is what the subscription windows come from, and the plugin queries it only with the credential the composition already uses for the Go route. **A key prefix does not decide this.** An earlier guard refused `oc_sk_…` keys there on the belief that the prefix meant "Zen, no Go entitlement"; the same prefix answers `200` with real windows. What separates the tiers is the observed request, never the string: see [engineering-notes.md](./engineering-notes.md), "A credential prefix is not an entitlement".

```json
403 {"type":"error","error":{"type":"EntitlementError","message":"OpenCode Go subscription required."}}
```

The plugin isolates them: `resolveGoApiKey` excludes Zen keys from the Go usage query; if only a Zen key exists, usage discovery reports `configured: false` and the ring stays hidden instead of spamming 403s; an `EntitlementError` response is mapped to `configured: false` or to the Zen credit status.

Go plan overflow to Zen credits. At 100% of the monthly quota, requests only fall back to Zen balance if _Use balance_ is enabled in the [OpenCode Console](https://opencode.ai/console). OpenCode exposes **no public balance API** (open feature request [anomalyco/opencode#10448](https://github.com/anomalyco/opencode/issues/10448)); overflow is handled server-side:

```javascript
// OpenCode CLI rate limit handler:
if (e.data.responseBody?.includes("GoUsageLimitError")) {
  let y = `${f ? `${f} usage limit` : "Usage limit"} reached... To continue using this model now, enable usage from your available balance`,
    k = `https://opencode.ai/workspace/${d}/go`;
  return {
    message: `${y} - ${k}`,
    action: { label: "open settings", link: k },
  };
}
```

### 6. Comparison: `dsh-opencode-patch` vs `dsh-opencode-go`

How does this compare to Duskriver's [`dsh-opencode-go`](https://www.npmjs.com/package/dsh-opencode-go)?

| Capability | `dsh-opencode-go` | `dsh-opencode-patch` (this plugin) |
| :-- | :-- | :-- |
| **Role** | Standalone Go provider | Universal gateway patch & enhancement layer |
| **Intercepted routes** | Dedicated Go route only | Any claimed route: `opencode`, `opencode-go`, custom relays |
| **OpenCode Go models** | ✅ (`/zen/go/v1`) | ✅ (`/zen/go/v1`) |
| **OpenCode Zen models** | ❌ | ✅ (`/zen/v1` — Claude, GPT-5, Gemini, contributor) |
| **Multi-protocol gateway** | OpenAI Completions only | Responses + Completions + Anthropic + Mistral, from the SDK each model declares |
| **Free-tier tool fallback** | ❌ | ⚠️ Injects `read` + `bash` schemas automatically for the models that ARE served. The schemas are the CLI's own field names and sets (`path`/`offset`/`limit`, `command`/`workdir`/`timeout`/`background`), because the gateway validates the shape. **Zen's free tier is not served from here** — measured with this machine's session token, its active org and every header captured from the real client, a free-tier Zen model still answers `403 FreeTierError` on both endpoint families. The Go plane has no free tier to gate, so its free models are served by the subscription key; Zen's `-free` ids are offered as well and answer with the gateway's own refusal |
| **Hierarchical subagents** | ❌ | ✅ Parent-session headers injected |
| **Dynamic workspace project** | ❌ | ✅ Derived from `session.header.cwd` |
| **Auto Review support** | ❌ Fails without `sessionId` | ✅ Fallback turn capture in `AsyncLocalStorage`, so the stream hook does not short-circuit — **but Auto Review takes its route from the session**, so a session selected on a Zen free-tier model still fails, and a `429` from the reviewer's own endpoint is not this plugin's to fix |
| **Composer dock meter** | Text string | SVG ring + Zen pill, session spend, model rate |
| **Attached Zen credit** | ❌ | ✅ Credentials, env vars, auto-detection |
| **Model metadata** | `models.opencode.ai/api.json` (the registry `models.dev` publishes) | Standard DSH & OpenCode catalog specs |

`dsh-opencode-go` targets users who only need a standalone Go provider; `dsh-opencode-patch` is the all-in-one layer that fixes, enriches and meters both Zen and Go across every DSH operation mode. ([models.opencode.ai/api.json](https://models.opencode.ai/api.json) is the canonical catalog both draw from; it and `models.dev/api.json` serve the same object.)

### 7. Authoritative model catalogs: dual local shims + real-time SWR updates

OpenCode's gateway `GET …/models` endpoints frequently return a truncated subset: no display names, context windows, max tokens or input modalities. The plugin ships a **stale-while-revalidate** catalog for both planes:

1. Dual bundled shims (zero latency, offline): `OPENCODE_GO_CATALOG` carries every active Go subscription model with per-million-token rates, so session pricing works before the first refresh; `OPENCODE_ZEN_CATALOG` carries the flagships (`claude-sonnet-4-5`, `claude-opus-4-7`, `gpt-5.4`, `gemini-3.8-flash`, `qwen3.8-max`, `kimi-k3`). The counts are deliberately not restated here: they move with the vendor, they are visible in the generated file, and CI checks the shim for drift: a pull request that changes the generator (or what it loads) fails on a stale shim; any other pull request, and a push to main, warns, and the nightly run proposes the refresh. Retired models are excluded so a failed refresh can never resurrect a row the gateway no longer serves: the three Zen-route Muse Spark 1.2 ids are suppressed, while the paid Go 1.2 contributor entry stays (the CLI still lists it). Startup is instant: no cold-start delay, blocking network calls, or airplane-mode failures.
2. Background revalidation: both catalogs revalidate against [`https://models.opencode.ai/api.json`](https://models.opencode.ai/api.json) — the OpenCode catalog, which today serves the byte-identical object as `models.dev/api.json` — every **60 minutes** (the OpenCode CLI's canonical cycle), merging new models, deprecations and updated limits. Errors degrade gracefully and retain the active catalog.
3. Gateway models-endpoint enrichment: `patchFetch` intercepts `GET …/models` on OpenCode routes and merges the live Go or Zen catalog: human-friendly names (`DeepSeek V4.1 Flash`, `Qwen3.8 Flash`, `Grok 4.7`, `MiMo V2.6 Pro`), verified context windows (up to 1,000,000+ tokens) and max output tokens (up to 384,000), correct input modalities (`text`, `image`), with retired Muse Spark 1.2 rows omitted.
4. Settings “Fetch Available Models” decoration: DSH asks the route's own adapter first, and for an installed `opencode` route `llm-pi-ai` answers from its packaged catalog without calling the gateway. The plugin therefore decorates the hosted discovery result: adapter rows and order are preserved, their metadata enriched from the catalog, provider-retired rows removed, and **models whose protocol DSH cannot speak dropped** (offering one could only fail). It **does not append** catalog rows the adapter did not report: an earlier revision did, and that is how a deployment that had declared four models saw eighty-six in Settings. This is candidate metadata for the settings surface; it never rewrites saved route configuration. Widening a deployment's list is a separate, explicit action — the card's **Check catalog** row, which shows what the catalog offers and declares it only when asked.
5. Native model discovery registration: on the host runtime the plugin also registers with `ctx.llm.registerModelDiscovery` for `opencode-go` and `opencode`, which is what a _draft_ route's “discover” call answers from — not the picker, which reads the declared list. The gateway-listing enrichment, this registration, the discovery decoration and the model-info decoration all sit behind the **Enrich model metadata from models.dev** switch; the adapter decoration and the Responses-route hiding do not.

### 8. Session spend & model rate

Behind the **Enable Composer Usage Meter** switch (on by default):

- Per-turn accounting: every `llm/stream` usage event is priced with the executing model's input/output/cache-read rates from the catalog and accumulated on the host: the client receives only the figures, never the catalog.
- Scoped per conversation: the meter sends provider + conversation id, so two open sessions (or a subagent) never read each other's totals.
- Mid-session model switches: the active label and rate follow whatever model runs next, while cumulative spend and the used-model list are preserved.
- Free tiers and plan-included models report `Included in Go Plan` at `$0.00` rather than a misleading rate.
- Go plan spend is a rate-based _estimate_ of consumption, not an invoice: included usage is covered by the plan. The [OpenCode Console](https://opencode.ai/console) remains the billing source of truth.

### 9. Key resolution per routed model & overage behavior

Different models may route to different accounts (a corporate Go subscription alongside a personal Zen key). `discoverGoConfig(ctx, provider)` reads the loaded Cordis row for the `apiKeyEnv` / literal `apiKey` assigned to the route, `resolveGoApiKey` resolves it under this plugin's own `keySource` setting, and **the route decides which account is queried: not the shape of the key**. The prefix test that used to sit here was removed once it was measured: OpenCode issues `oc_sk_…` for Go credentials too, so the string says nothing about the route in use. The meter queries accordingly:

- OpenCode Go (`opencode-go`): fixed subscription quotas across three windows (5-hour rolling, weekly, monthly %). At 100% the gateway answers `GoUsageLimitError` (HTTP 402/429). Server-side overflow into Zen balance works only if that Go account has _Use balance_ enabled ([opencode.ai/workspace/go](https://opencode.ai/workspace/go)): a Zen key on a _separate_ account is never debited automatically.
- OpenCode Zen (`opencode`): per-token pay-as-you-go against the account balance; no rolling windows. At $0.00 the gateway returns `HTTP 402 Insufficient account funds`: top up via the Console link in the popover.

---
