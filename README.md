<div align="center">
  <img src="icon.svg" alt="OpenCode logo" width="120" />
  <h1>dsh-opencode-patch</h1>
  <p><strong>OpenCode on DeepSeek Harness — Gateway Origin Headers, Hierarchical Session Affinity, Dynamic Workspace Attribution, and Live Dual-Mode Quota Monitor.</strong><br />Seamlessly connect OpenCode Zen & Go models to DSH without connection errors, entitlement mismatches, or invisible limits.</p>

[![npm](https://img.shields.io/npm/v/dsh-opencode-patch.svg)](https://www.npmjs.com/package/dsh-opencode-patch) [![downloads](https://img.shields.io/npm/dm/dsh-opencode-patch.svg)](https://www.npmjs.com/package/dsh-opencode-patch) [![ci](https://github.com/viztor/dsh-opencode-patch/actions/workflows/ci.yml/badge.svg)](https://github.com/viztor/dsh-opencode-patch/actions/workflows/ci.yml) [![release](https://github.com/viztor/dsh-opencode-patch/actions/workflows/release.yml/badge.svg)](https://github.com/viztor/dsh-opencode-patch/actions/workflows/release.yml) [![license](https://img.shields.io/npm/l/dsh-opencode-patch.svg)](https://github.com/viztor/dsh-opencode-patch/blob/main/LICENSE) [![node](https://img.shields.io/node/v/dsh-opencode-patch.svg)](https://nodejs.org)

</div>

---

Connect OpenCode Zen models (`claude-sonnet-4-5`, `gpt-5.4`, `gemini-3.8-flash`, `muse-spark-1.3-contributor-free`) and OpenCode Go (`deepseek-v4.1-flash`, `qwen3.8-flash`) to DeepSeek Harness without network rejections, Cloudflare challenges, or silent failures.

OpenCode's gateways expect specific request traits that DSH does not send by default: a valid `x-opencode-session` on every turn, official CLI origin proof (`User-Agent`, client/project headers, `ses_…`-shaped IDs), and `read`/`bash` tool definitions on free-tier requests. Furthermore, DSH subagents, background evaluations, and experimental operational modes (like **Auto Review**) invoke the LLM in standalone sessions where `sessionId` is omitted or unlinked.

`dsh-opencode-patch` restores all missing protocol elements at the network layer strictly for OpenCode routes (`opencode` / `opencode-go`), including hierarchical subagent session lineage, dynamic workspace project attribution, multi-protocol completion support, and an automated dual-mode (Go quota & Zen credit) monitor. All other traffic (DeepSeek, OpenAI, Anthropic, GitHub) passes through untouched.

| Without Patch | With `dsh-opencode-patch` |
| :-- | :-- |
| Zen free models fail with `403 FreeTierError` | **100% gateway origin headers & tool fallbacks** restored automatically |
| Session IDs rejected with `400 MissingSessionID` | **Deterministic `ses_…` session hashing** and affinity across turns |
| Subagents lose conversation context | **Parent session tracking** (`x-opencode-parent-session-id`, `x-parent-session-id`) |
| Auto Review calls fail with `TRANSPORT: Connection error` | **Fallback session turn capture** preserving active turn state across eval calls |
| Quotas and balances are invisible | **Live dual-mode composer dock meter** showing Go quota or Zen balance |
| Zen keys cause `403 EntitlementError` on Go usage | **Strict credential isolation** preventing Zen keys from querying Go quota endpoints |
| Projects share a single `"global"` telemetry bucket | **Dynamic workspace project attribution** resolved from active `session.header.cwd` |

---

## 🧭 Supported Models & Multi-Protocol Gateway Routing

OpenCode provides inference across multiple upstream APIs through its unified gateway. `dsh-opencode-patch` seamlessly intercepts and patches all four protocol families:

### 1. OpenCode Zen (`provider: opencode`) — Pay-As-You-Go & Free Tier

- **Anthropic Messages Protocol** (`https://opencode.ai/zen/v1/messages`):
  - `claude-sonnet-4-5`, `claude-opus-4-7`, `claude-haiku-4-5`, `qwen3.8-flash`
- **OpenAI Responses Protocol** (`https://opencode.ai/zen/v1/responses`):
  - `gpt-5.4`, `gpt-5.2`, `gpt-5.1-codex-max`, `muse-spark-1.3`, `space-bunny-free`
  - Contributor free-tier model: `muse-spark-1.3-contributor-free`
- **OpenAI Chat Completions Protocol** (`https://opencode.ai/zen/v1/chat/completions`):
  - `deepseek-v4.1-flash`, `kimi-k2.5`, `kimi-k3`, `minimax-m2.5`, `glm-5.2`
  - Free-tier models: `nemotron-3-ultra-free`, `ling-3.0-flash-fin-free`, `mimo-v2.6-flash-free`
- **Google Generative AI Protocol** (`https://opencode.ai/zen/v1/models/*:streamGenerateContent`):
  - `gemini-3.8-flash`, `gemini-3.1-pro`, `gemini-3.5-flash-lite`

### 2. OpenCode Go (`provider: opencode-go`) — Subscription Quota

- **OpenAI Chat Completions Protocol** (`https://opencode.ai/zen/go/v1/chat/completions`):
  - `deepseek-v4.1-flash`, `deepseek-v4-pro`, `deepseek-v4-flash`, `deepseek-v4-flash-vision-exp`, `qwen3.8-flash`, `qwen3.8-max`, `qwen3.7-plus`, `kimi-k3`, `kimi-k2.7-code`, `glm-5.3`, `glm-5.3-flash`, `glm-5.2`, `grok-4.7`, `grok-4.6`, `minimax-m3`, `minimax-m2.7`, `mimo-v2.6-pro`, `mimo-v2.6-flash`, `gpt-5.6-luna`, `gpt-6-luna`
  - Monitored by the live 3-window quota meter (5-Hour Rolling, Weekly, Monthly limits). The full set ships in the bundled catalog — see [Authoritative Model Catalogs](#7-authoritative-model-catalogs-dual-local-shims--real-time-swr-updates).

### 3. Agent Execution Modes Supported

- **Interactive Multi-Turn Chat**: Normal human-to-agent turns with KV prompt-cache session affinity.
- **Subagents & Fork Lineage**: `subagent` and `subagent_fork` delegations carry parent session headers.
- **Agent Teams**: Multi-agent orchestration with preserved shared-workspace attribution.
- **DSH Experimental Auto-Review**: Background risk audit calls (`@deepseek-ai/dsh-experimental-auto-review`) are captured and patched with deterministic session IDs and origin headers.

---

## 🌐 Deep Dive: OpenCode Architecture & Protocol Specification

### 1. The Header Injection Matrix

Decompiled from the official `opencode` CLI binary, OpenCode's gateway enforces specific request headers depending on whether the route targets a native OpenCode gateway or a third-party proxy/relay:

```javascript
// Extracted from OpenCode CLI's HTTP request builder:
headers: {
  "x-opencode-session-id": e.sessionID,
  ...(e.parentSessionID ? { "x-opencode-parent-session-id": e.parentSessionID } : {}),
  ...(e.model.providerID.startsWith("opencode")
    ? {
        ...(k ? { "x-opencode-project": k } : {}),
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
  ...(e.parentSessionID ? { "x-parent-session-id": e.parentSessionID } : {})
}
```

Our fetch patch satisfies every header variant:

| Header | Value Derived | Purpose |
| :-- | :-- | :-- |
| `x-opencode-session` | `ses_<12hex><14base62>` | Vendor-specific conversation affinity; enables KV-cache prompt routing. |
| `x-opencode-session-id` | `ses_<12hex><14base62>` | Required by OpenCode CLI v1.18+ gateways. |
| `x-session-affinity` | `ses_<12hex><14base62>` | Generic proxy/relay affinity (Cloudflare AI Gateway, LiteLLM, Portkey). |
| `x-opencode-parent-session-id` | `ses_<parent_hash>` | Hierarchical lineage for DSH subagents (`subagent`, `subagent_fork`). |
| `x-parent-session-id` | `ses_<parent_hash>` | Generic proxy parent session affinity. |
| `User-Agent` | `opencode/1.18.34 ...` | Prevents Cloudflare WAF Error 1010 challenges on model endpoints. |
| `x-opencode-client` | `cli` (configurable) | Identifies the client tier to the Zen gateway. |
| `x-opencode-project` | Dynamic / `global` | Workspace project attribution for console analytics and KV isolation. |

---

### 2. Hierarchical Subagent & Parent Session Lineage

When DSH spawns subagents (via `subagent` or `subagent_fork`), each child agent operates in a separate session.

`dsh-opencode-patch` inspects DSH's host `SessionRegistry` (`ctx.sessions.get(...)`) to extract `session.header.parentSession`. Both the child session and parent session are deterministically mapped to OpenCode's `ses_<12hex><14base62>` format via SHA-256:

```
[Parent DSH Session: "session-abc"] ──(SHA-256)──> [ses_parent_12hex14base62]
           │
           ▼ spawns subagent
[Child DSH Session:  "session-xyz"] ──(SHA-256)──> [ses_child_12hex14base62]

Outgoing Subagent Request:
  x-opencode-session:           ses_child_12hex14base62
  x-opencode-session-id:        ses_child_12hex14base62
  x-session-affinity:           ses_child_12hex14base62
  x-opencode-parent-session-id: ses_parent_12hex14base62
  x-parent-session-id:          ses_parent_12hex14base62
```

This lineage allows upstream servers to optimize prompt-caching across agent teams and subagent delegation workflows.

---

### 3. Dynamic Workspace Project Attribution

OpenCode uses `x-opencode-project` to group token usage, requests, and costs in the [OpenCode Console](https://opencode.ai/console).

`dsh-opencode-patch` handles this automatically through a simple natural-language toggle:

1. **Enabled (Default on)**: The plugin inspects the active session's working directory (`session.header.cwd`) and extracts the folder name (e.g. `/home/you/projects/my-app` $\rightarrow$ `x-opencode-project: "dsh-opencode"`). If running outside any project directory, it falls back to `"global"`.
2. **Disabled (Toggled off)**: The `x-opencode-project` header is completely omitted, matching OpenCode CLI's standalone behavior.
3. **Zero Configuration**: Users do not need to type custom project strings or manually manage project overrides across different sessions. Everything tracks your active workspace folder naturally.

---

### 4. DSH Experimental Auto-Review Compatibility

In DeepSeek Harness Web, when the user enables the experimental **Auto Review** operational mode (`@deepseek-ai/dsh-experimental-auto-review`), every tool execution (such as `bash` or `read`) is audited by a background model call before execution:

```javascript
// @deepseek-ai/dsh-experimental-auto-review
async function classifyRisk(ctx, agent, exec, signal) {
  const snapshot = snapshotAutoReview(agent, exec);
  const options = deepFreeze({
    provider: snapshot.provider, // e.g. "opencode"
    model: snapshot.model, // active model
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

Because Auto Review calls omit `options.sessionId`, earlier plugin versions short-circuited the stream hook, leaving the turn store empty and causing review requests to bypass gateway patching with `TRANSPORT: Connection error`.

`dsh-opencode-patch` generates a deterministic fallback session state whenever `sessionId` is omitted, ensuring that:

- Turn state (`provider`, `model`, `sessionId`, `startedAt`) is established in `AsyncLocalStorage`.
- Auto Review streams to OpenCode models receive full header injection (`x-opencode-session`, `x-opencode-session-id`, `User-Agent`, origin headers).
- Multi-protocol tool definitions (`read`, `bash`) are injected when free-tier models are used.

> **Important Host Reload Rule**: DeepSeek Harness loads host plugins with `hmr root: []` (hot-reloading client plugins only). When host code (`lib/index.mjs`) is modified or updated, **`dsh web` must be restarted** so the Node process loads the new module into memory. Client UI bundle changes (`lib/client.js`) reload on page refresh.

---

### 5. OpenCode API Tiers: V1 vs. V2 & Zen vs. Go

OpenCode operates distinct API surfaces with different authentication requirements:

```
┌────────────────────────────────────────────────────────────────────────┐
│                        OpenCode API Surfaces                           │
├───────────────────────────────────┬────────────────────────────────────┤
│   V1 Inference Gateway (Data)     │    V2 Control-Plane API (Manage)   │
├───────────────────────────────────┼────────────────────────────────────┤
│ • https://opencode.ai/zen/v1      │ • https://api.opencode.ai          │
│ • https://opencode.ai/zen/go/v1   │ • Local server: @opencode/client   │
│ • Static API Keys:                │ • OAuth Token Pairs:               │
│     - Go:  sk-... (Subscription)  │     { type: "oauth",               │
│     - Zen: oc_sk_... (Pay-as-you-go)    access: "...",                 │
│ • Chat completions, models, quota │     refresh: "...", expires: ... } │
│                                   │ • Sessions, tools, workspaces      │
└───────────────────────────────────┴────────────────────────────────────┘
```

#### Credential Isolation (Preventing `403 EntitlementError`)

- **OpenCode Go Keys (`sk-...`)**: Carry an active Go subscription entitlement. They can query `https://opencode.ai/zen/go/v1/usage` to retrieve rolling, weekly, and monthly quota windows.
- **OpenCode Zen Keys (`oc_sk_...`)**: Pay-as-you-go tokens. They **cannot** access `/zen/go/v1/usage`. If a Zen key queries the Go usage endpoint, OpenCode rejects it with:
  ```json
  403 {"type":"error","error":{"type":"EntitlementError","message":"OpenCode Go subscription required."}}
  ```

`dsh-opencode-patch` isolates these credentials:

1. `resolveGoApiKey` excludes Zen keys (`oc_sk_...` / `OPENCODE_API_KEY`) from querying Go usage.
2. If only a Zen key is configured, Go usage discovery returns `configured: false`. The quota ring cleanly stays hidden rather than spamming 403 errors.
3. If an upstream call returns `EntitlementError`, it is caught and mapped to `configured: false` or returns the Zen credit status.

#### How Go Plan Overflow to Zen Credits Works

When a Go plan reaches 100% of its monthly quota, requests do not automatically fall back to Zen credits unless the user enables **"Use balance"** in the OpenCode Console ([opencode.ai/console](https://opencode.ai/console)).

As verified by decompiling the OpenCode CLI, OpenCode has **no public REST balance API** (see open feature request [anomalyco/opencode#10448](https://github.com/anomalyco/opencode/issues/10448)). Overflow is handled entirely server-side by OpenCode's billing router:

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

---

### 6. Architectural Comparison: `dsh-opencode-patch` vs. `dsh-opencode-go`

A common question is how `dsh-opencode-patch` compares to Duskriver's [`dsh-opencode-go`](https://www.npmjs.com/package/dsh-opencode-go):

| Feature / Capability | `dsh-opencode-go` | `dsh-opencode-patch` (This Plugin) |
| :-- | :-- | :-- |
| **Plugin Role** | Standalone LLM Provider (`dsh-opencode-go`) | Universal Gateway Patch & Enhancement Layer |
| **Intercepted Routes** | Dedicated Go provider only | Any route: `opencode`, `opencode-go`, custom relays |
| **OpenCode Go Models** | ✅ (`/zen/go/v1` DeepSeek, Qwen) | ✅ (`/zen/go/v1` DeepSeek, Qwen) |
| **OpenCode Zen Models** | ❌ Not supported | ✅ (`/zen/v1` Claude, GPT-5, Gemini, Contributor) |
| **Multi-Protocol Gateway** | OpenAI Completions only | OpenAI Responses + Completions + Anthropic + Google |
| **Free-Tier Tool Fallback** | ❌ Free models fail on missing tools | ✅ Injects dummy `read` + `bash` schemas automatically |
| **Hierarchical Subagents** | ❌ No parent tracking | ✅ Injects `x-opencode-parent-session-id` for subagents |
| **Dynamic Workspace Project** | ❌ Hardcoded / None | ✅ Automatically tags active folder from `session.header.cwd` |
| **DSH Auto Review Support** | ❌ Fails on missing `sessionId` | ✅ Fallback turn capture in `AsyncLocalStorage` |
| **Composer Dock Meter** | Text string (`Go · 5小时 42% · 周 18%`) | Dual-mode: SVG circular progress ring + Zen coin pill |
| **Attached Zen Credit** | ❌ None | ✅ DSH Credentials, env vars, and auto-detection |
| **Model Metadata** | Discovered from `models.dev/api.json` | Inherits standard DSH & OpenCode catalog specs |

#### Key Insights from `dsh-opencode-go`:

- **`https://models.dev/api.json`**: OpenCode publishes its canonical model catalog, deprecation status, context window sizes, and pricing metadata at `https://models.dev/api.json`.
- **Target Audience**: `dsh-opencode-go` is tailored specifically for users who only need a standalone OpenCode Go provider. In contrast, `dsh-opencode-patch` is an all-in-one gateway patch that transparently fixes, optimizes, and meters both Zen and Go traffic across every DSH operation mode.

---

### 7. Authoritative Model Catalogs: Dual Local Shims + Real-Time SWR Updates

A known limitation of OpenCode's default gateway endpoints is that `GET https://opencode.ai/zen/go/v1/models` and `/zen/v1/models` frequently return a truncated subset of models, omitting human-readable display names, context windows, max tokens, and input modalities.

To provide both **100% offline reliability** and **continuous real-time freshness**, `dsh-opencode-patch` implements a **Stale-While-Revalidate (SWR)** catalog architecture for both OpenCode Go and OpenCode Zen:

1. **Dual Local Bundled Shims (Zero Latency & Offline)**:
   - **OpenCode Go (`OPENCODE_GO_CATALOG`)**: Ships with an embedded baseline of all **29 active** OpenCode Go subscription models, each carrying its per-million-token rates so session pricing works before the first refresh.
   - **OpenCode Zen (`OPENCODE_ZEN_CATALOG`)**: Ships with an embedded baseline of the **10 active free-tier models** (`muse-spark-1.3-contributor-free`, `space-bunny-free`, `fledge-alpha-free`, `nemotron-3-ultra-free`, `nemotron-3.5-lightning-free`, `ling-3.0-flash-fin-free`, `ling-3.1-flash-free`, `longcat-2.5-preview-free`, `mimo-v2.6-flash-free`, `big-pickle`) plus active flagship models (`claude-sonnet-4-5`, `claude-opus-4-7`, `gpt-5.4`, `gemini-3.8-flash`, `qwen3.8-max`, `kimi-k3`).
   - **Deprecated models are excluded**, so a failed refresh can never resurrect a row the gateway no longer serves. Suppression follows the provider-specific OpenCode CLI listing: the three Zen-route Muse Spark 1.2 IDs (`muse-spark-1.2`, `muse-spark-1.2-contributor`, and `muse-spark-1.2-contributor-free`) are omitted from Zen enrichment and discovery, while the paid Go 1.2 contributor entry remains available because the CLI still lists it.
   - Guaranteed immediate startup with no cold-start delay, blocking network calls, or airplane-mode failures.
2. **Non-Blocking Background Revalidation**:
   - In the background, `getLiveGoCatalog()` and `getLiveZenCatalog()` revalidate against [`https://models.dev/api.json`](https://models.dev/api.json) every **60 minutes** (matching the OpenCode CLI's canonical refresh cycle).
   - Newly released models, deprecation notices, and updated token limits are seamlessly merged into the active catalog memory.
   - Network errors or timeouts degrade gracefully without throwing, silently retaining the active catalog.
3. **Gateway Models Endpoint Auto-Enrichment**:
   - When DSH or any client requests `GET .../models` on an OpenCode gateway (`/zen/go/v1/models` or `/zen/v1/models`), `patchFetch` intercepts the response:
     - If the URL targets OpenCode Go (`/zen/go/...`): merges with `getLiveGoCatalog()`.
     - If the URL targets OpenCode Zen (`/zen/...`): merges with `getLiveZenCatalog()`.
   - Populates human-friendly names (`DeepSeek V4.1 Flash`, `Qwen3.8 Flash`, `Grok 4.7`, `MiMo V2.6 Pro`).
   - Injects verified context windows (up to 1,000,000+ tokens) and max output tokens (up to 384,000 tokens).
   - Accurately declares input modalities (`text`, `image`) so vision models function out of the box.
   - Omits the provider-retired Muse Spark 1.2 rows listed below, even when the gateway still returns them.
4. **Settings “Fetch Available Models” Decoration**:
   - DSH asks the adapter that owns a route first. For an installed `opencode` route, `llm-pi-ai` answers from its packaged catalog without calling the gateway, so response enrichment alone cannot alter that answer.
   - The plugin therefore decorates the hosted discovery result for claimed OpenCode routes: it preserves the adapter’s rows and order, appends missing canonical rows such as `space-bunny-free`, and removes provider-retired rows such as Zen’s Muse Spark 1.2 entries.
   - Like response enrichment, this is candidate metadata for the settings surface to adopt; it does not rewrite already saved route configuration.
5. **Native DSH Model Discovery Registration**:
   - On the host runtime, `dsh-opencode-patch` also registers with DSH's native model discovery service (`ctx.llm.registerModelDiscovery`) for both `opencode-go` and `opencode`.
   - Gateway enrichment, discovery decoration, and these registrations sit behind the **Enrich Models from models.dev** switch, so turning it off leaves raw gateway listings, adapter discovery answers, and DSH's own catalog untouched.

### 8. Session Spend & Model Rate

The meter can also answer "what has this conversation cost me?" — behind the **Show Session Spend & Model Rate** switch (on by default):

- **Per-turn accounting**: every `llm/stream` usage event is priced with the executing model's rates (input, output, and cache-read) taken from the catalog, then accumulated on the Host. The client never receives the catalog, only the resulting figures.
- **Scoped per conversation**: the meter sends the provider and the conversation id, so two open sessions (or a subagent) never read one another's totals, and a Go/Zen split across different accounts is metered against the route actually on screen.
- **Mid-session model switches**: the _active_ model label and rate follow whatever model will run the next turn, while cumulative spend and the list of models used are preserved. Switching from a $0.15/M model to a $3/M model re-prices the label without losing what the cheap model already cost.
- **Free tiers and plan-included models** report `Included in Go Plan` at `$0.00` rather than a misleading rate.
- **Note on Go plan spend**: on a Go subscription, included usage is covered by the plan rather than billed per token, so this figure is a rate-based _estimate_ of consumption, not an invoice. OpenCode's Console remains the billing source of truth.

---

### 9. Key Resolution per Routed Model & Account Overage Differentiation

When working with multiple OpenCode models, different models may route to different providers and even different accounts (for example, a corporate OpenCode Go subscription key alongside a personal OpenCode Zen pay-as-you-go key).

`dsh-opencode-patch` differentiates these routes and their overage behaviors:

1. **How the Key is Resolved per Routed Model (`resolveRoutedKey`)**:
   - In DSH, each active turn carries the model's `provider` (e.g. `opencode-go` vs. `opencode`).
   - `resolveRoutedKey(ctx, provider)` inspects loaded Cordis entries (`dsh-llm-pi-ai` provider rows or standalone entries) to find the exact `apiKeyEnv` or literal `apiKey` assigned to that specific provider.
   - It determines the active account tier (`go` vs. `zen`) and extracts the key prefix (e.g. `sk-68klEy0...` vs. `oc_sk_ac6304...`) to identify the key family.
2. **Subscription Quota Overage vs. Credit Balance Overage**:
   - **OpenCode Go (`opencode-go`)**:
     - Billed on fixed subscription quotas across 3 windows (5h Rolling, Weekly, Monthly %).
     - **Limit Behavior**: When the monthly limit reaches 100%, requests will be blocked with `GoUsageLimitError` (HTTP 402/429).
     - **Account Overflow Rule**: Server-side overflow into Zen balance **only works if that specific Go plan's account has "Use balance" enabled in console** ([opencode.ai/workspace/go](https://opencode.ai/workspace/go)).
     - **Separate Accounts**: If your Zen key belongs to a separate account from your Go key, OpenCode Go's server will **not** automatically debit the other account's Zen wallet. Requests to the Go model remain limited until the quota reset window.
   - **OpenCode Zen (`opencode`)**:
     - Billed on per-token pay-as-you-go debits against your account balance.
     - **Limit Behavior**: There are no rolling quota windows. When account credits hit $0.00, OpenCode returns `HTTP 402 Insufficient account funds`.
     - **Resolution**: Click the direct Console link in the popover to top up your account wallet balance.

---

## ⭕ Live Dual-Mode Quota Monitor & Zen Credit Display

The plugin mounts an interactive meter in the composer dock (`conversation.composer.dock`), directly alongside DSH's native `ContextMeter`:

```
┌─────────────────────────────────────────────────────────────────┐
│ Type a message...                                               │
│                                                                 │
│ [+] Attach                            [DeepSeek V4.1 Flash ⌄] [⬆]│
└─────────────────────────────────────────────────────────────────┘
   [ ⭕ 73% Context ]   [ ⭕ 42% Go Quota ]  ← when OpenCode Go is active
   [ ⭕ 73% Context ]   [ 🪙 OpenCode Zen ]  ← when OpenCode Zen is active
```

### Visual Modes

#### Mode A: OpenCode Go (`opencode-go`)

- **Adaptive Bottleneck Ring**: Real-time SVG circular progress ring showing the currently limiting window percentage (`42%`, `80%`, or `100%` when rate-limited).
- **Semantic Color States**:
  - `var(--dsw-alias-state-success-primary)` (green): Normal operation (<80%).
  - `var(--dsw-alias-state-warn-primary)` (amber): Elevated usage (≥80%).
  - `var(--dsw-alias-state-error-primary)` (red): Limit reached (100% rate-limited).
- **Rich Hover Modal**:
  - **3-Window Breakdown Rows**: Dedicated progress meters for **5-Hour Rolling**, **Weekly**, and **Monthly** limits with live relative reset countdowns (`in 3h 12m`, `in 7d 17h`, `soon`).
  - **3 Quota Overview Cards**: High-level visual cards for quick status glancing.
  - **Session Spend Card** (behind **Show Session Spend & Model Rate**): Accumulated dollars for the current session, labelled with the **active model** and its per-million-token rate. A session that switches models re-prices the _active_ label while keeping the cumulative spend, and a free-tier model reads `Included in Go Plan` at `$0.00`.
  - **Attached Zen Overflow Card**: Shows whether Zen balance overflow is `Ready` to take over when Go limits are reached (or `Active` when currently overflowing).
  - **Rate-Limited Alert**: Alerts when the plan cap is hit and explains how "Use balance" routes overflow.
  - **Act-On-It Links**: [Upgrade plan](https://opencode.ai/go), [Console & balance](https://opencode.ai/console), and [Usage limits doc](https://opencode.ai/docs/go/).

```
┌──────────────────────────────────────────────┐
│  42% of 5-Hour quota used           [Go Plan]│
│  ████████████░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░ │
├──────────────────────────────────────────────┤
│  • 5 hours                               42% │
│    Resets in 3h 12m                          │
│  • Weekly                                18% │
│    Resets in 5d 8h                           │
│  • Monthly                               65% │
│    Resets in 22d 4h                          │
├──────────────────────────────────────────────┤
│  QUOTA OVERVIEW                              │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐      │
│  │ 5-Hour   │ │ Weekly   │ │ Monthly  │      │
│  │ 42%      │ │ 18%      │ │ 65%      │      │
│  │ in 3h 12m│ │ in 5d 8h │ │ in 22d 4h│      │
│  └──────────┘ └──────────┘ └──────────┘      │
│                                              │
│  SESSION SPEND                               │
│  deepseek-v4.1-flash · $0.15 / $0.6 per 1M   │
│                                        $0.42 │
│                                              │
│  ZEN BALANCE FALLBACK                        │
│  Zen balance ready for overflow        Ready │
├──────────────────────────────────────────────┤
│  Last updated 08:30              [ Retry ]   │
│  Upgrade plan · Console & balance · Doc      │
└──────────────────────────────────────────────┘
```

#### Mode B: OpenCode Zen (`opencode`)

- **Zen Pill**: Compact coin badge (`🪙 OpenCode Zen`) in the composer dock. With **Show Session Spend & Model Rate** on, it switches to the session's accumulated dollar figure once the first turn has been priced.
- **Pay-As-You-Go Panel**:
  - Header: **OpenCode Zen** with `Pay-as-you-go` badge.
  - Explains per-token pay-as-you-go billing directly from your OpenCode account balance.
  - **Session Spend Card** when the price switch is on, labelled with the active model and its rate.
  - Direct links to [OpenCode Console](https://opencode.ai/console) to inspect live credit balances and [Pricing](https://opencode.ai/pricing).

```
┌──────────────────────────────────────────────┐
│  OpenCode Zen                [Pay-as-you-go] │
│  Per-token pay-as-you-go inference           │
├──────────────────────────────────────────────┤
│  AVAILABLE ZEN BALANCE                       │
│  Per-token pay-as-you-go inference    Active │
├──────────────────────────────────────────────┤
│  Last updated 08:30              [ Retry ]   │
│  Upgrade plan · Console & balance · Doc      │
└──────────────────────────────────────────────┘
```

### Zen Account Balance & Overflow

OpenCode Zen operates on per-token pay-as-you-go billing:

1. **Automatic Zen Detection**: If an `OPENCODE_API_KEY` (or `oc_sk_...`) is configured in DSH Credentials or environment, the plugin automatically detects that Zen pay-as-you-go is active and marks Zen overflow as **Ready**.
2. **Live Balance Inspection**: Because credit balances change dynamically with every token generated, the popover provides a direct act-on-it link to the [OpenCode Console](https://opencode.ai/console), where users can view live wallet balances and top up credits without needing artificial static environment variables.

---

## ⚙️ Configuration Reference

### DSH Settings UI Card

Open DSH Web → **Settings → Plugins → OpenCode Patch** (设置 → 插件 → OpenCode 补丁设置). Boolean knobs render as interactive **Switch toggles** matching DSH design primitives:

| Setting | Type | Default | Description |
| :-- | :-: | :-- | :-- |
| **Inject User-Agent** | `Switch` | `on` | Restores official OpenCode CLI User-Agent to pass Cloudflare WAF checks. |
| **User-Agent Override** | `Text` | empty | Optional custom User-Agent string. Leave blank for canonical CLI string. |
| **Inject Origin Headers** | `Switch` | `on` | Injects official client origin headers (`x-opencode-client`). |
| **Origin Client** | `Text` | `cli` | Value sent as `x-opencode-client`. |
| **Attach Workspace Project** | `Switch` | `on` | Automatically tags requests with your active workspace folder name (or 'global' if outside a project). Turn off to omit. |
| **Inject Core Tools** | `Switch` | `on` | Injects dummy `read` + `bash` schemas on free-tier requests to satisfy gateway validation. |
| **Free Model Marker** | `Text` | `free` | Model-id marker triggering tool schema fallback (`*` = all models). |
| **Enrich Models from models.dev** | `Switch` | `on` | Merges canonical specs, active free models, and accurate limits from models.dev into OpenCode model listings **and** native DSH model discovery. Turn off to keep the raw gateway listing untouched. |
| **Providers** | `List` | `opencode, opencode-go` | Comma-separated provider route IDs intercepted by the patch. |
| **Gateway URLs** | `List` | `opencode.ai/zen` | Comma-separated URL substrings identified as OpenCode gateway traffic. |
| **Session ID Env Var** | `Text` | `OPENCODE_SESSION_ID` | Environment variable consulted for fallback session IDs outside a turn. |
| **Enable Go Quota Monitor** | `Switch` | `on` | Mounts the live quota & credit meter in the composer dock. |
| **Show Session Spend & Model Rate** | `Switch` | `on` | Shows accumulated session cost and the active model's per-million-token rate in the meter. Turn off for quota-only. |
| **Go Usage Base URL** | `Text` | `https://opencode.ai/zen/go/v1` | OpenCode Go quota statistics API endpoint. |
| **Go Key Env Var / Credential** | `Text` | `OPENCODE_GO_API_KEY` | Credential reference or env var holding the Go subscription key. |
| **Quota Meter Provider Markers** | `List` | `opencode-go, opencode` | Provider route substrings that activate the quota meter. |

---

### Config-File Level Options (`cordis.patch.yml`)

Developer diagnostics (`debug` and `debugFile`) are non-volatile and configured directly in `cordis.patch.yml` to keep the UI clean:

```yaml
- id: dsh-opencode-patch
  name: "dsh-opencode-patch"
  config:
    providers:
      - opencode
      - opencode-go
    gatewayUrls:
      - opencode.ai/zen
    sessionIdEnv: "OPENCODE_SESSION_ID"
    freeModelMarker: "free"
    usageEnabled: true
    usageBaseURL: "https://opencode.ai/zen/go/v1"
      - opencode-go
      - opencode
    injectUserAgent: true
    injectOriginHeaders: true
    originClient: "cli"
    injectProject: true # Attach workspace folder (or 'global'); false omits header
    injectCoreTools: true
    enrichModels: true # merge models.dev specs + active free models into listings
    showUsagePrice: true # show session spend + active model rate in the meter
    # File-level only debug options:
    debug: false
    debugFile: "/tmp/dsh-opencode-debug.jsonl"
```

---

## 🛠 Troubleshooting

| Symptom | Likely Cause | Solution |
| :-- | :-- | :-- |
| `403 FreeTierError` on free models | Gateway headers stripped or tool definitions missing | Keep **Inject User-Agent**, **Inject Origin Headers**, and **Inject Core Tools** toggled on. |
| `400 MissingSessionID` | No session header attached | Ensure `dsh-opencode-patch` is listed in your profile's `bundles` array. |
| Auto Review fails with `TRANSPORT: Connection error` | DSH Web host process has not been restarted since update | Stop and restart `dsh web` to load the updated `lib/index.mjs` module. |
| Quota ring never appears for a Go model | No OpenCode Go credential resolves, or active provider is not `opencode-go` | Store `OPENCODE_GO_API_KEY` in DSH Credentials and ensure the active model routes through `opencode-go`. |
| A documented catalog model is missing from settings Fetch, or a retired model persists there | The running host loaded an older built plugin module, enrichment is off, or the owning adapter answered from its packaged catalog | Rebuild with `pnpm run build`, restart `dsh web` (a browser refresh only reloads the client bundle), keep **Enrich Models from models.dev** on, fetch from the matching `opencode` or `opencode-go` route, and search for the exact model ID (for example, `space-bunny-free`). |
| Popover shows "Limit reached" in red | Account has reached 100% of rolling or monthly quota | Open [OpenCode Console](https://opencode.ai/console) and enable "Use balance" to fall back to Zen credits. |
| Non-OpenCode models misbehaving | Unrelated to this patch | Traffic to non-OpenCode providers (OpenAI, DeepSeek, Anthropic) passes through untouched. |

---

## 📜 Compatibility & Verification

**Verified on DeepSeek Harness 0.2.0-rc.2 (Node 24+)**

| Surface | Target |
| :-- | :-- |
| **Plugin Package** | `dsh-opencode-patch` (npm + GitHub Packages) |
| **Host Profile** | DSH Web profile (`patchReload: live`) |
| **Runtime Floor** | Node.js `>=24.0.0` |
| **Gateways** | `zen/v1` (`/responses`, `/chat/completions`, `/messages`, `:streamGenerateContent`), `zen/go/v1` (`/chat/completions`) |
| **Supported Models** | `claude-sonnet-4-5`, `gpt-5.4`, `gemini-3.8-flash`, `deepseek-v4.1-flash`, `muse-spark-1.3-contributor-free`, `qwen3.8-flash` |
| **Verification Gate** | `vp check` clean, 98 unit tests passing, full schema validation, consumer install+load (`scripts/check.ts`) |

---

## 👥 Attribution & License

Evolved from [**`nobu121/dsh-opencode-session`**](https://github.com/nobu121/dsh-opencode-session) by [@nobu121](https://github.com/nobu121), which pioneered session ID handling for OpenCode on DSH. Extended by [@viztor](https://github.com/viztor) to support Zen free-tier gateway compatibility, hierarchical subagent lineage, dynamic workspace project attribution, live dual-mode Go quota and Zen credit monitoring, and native Web UI integration.

Licensed under the [MIT License](LICENSE).
