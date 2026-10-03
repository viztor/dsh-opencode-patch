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
  - Contributor free-tier models: `muse-spark-1.3-contributor-free`, `muse-spark-1.2-contributor-free`
- **OpenAI Chat Completions Protocol** (`https://opencode.ai/zen/v1/chat/completions`):
  - `deepseek-v4.1-flash`, `kimi-k2.5`, `kimi-k3`, `minimax-m2.5`, `glm-5.2`
  - Free-tier models: `nemotron-3-ultra-free`, `ling-3.0-flash-fin-free`, `mimo-v2.6-flash-free`
- **Google Generative AI Protocol** (`https://opencode.ai/zen/v1/models/*:streamGenerateContent`):
  - `gemini-3.8-flash`, `gemini-3.1-pro`, `gemini-3.5-flash-lite`

### 2. OpenCode Go (`provider: opencode-go`) — Subscription Quota

- **OpenAI Chat Completions Protocol** (`https://opencode.ai/zen/go/v1/chat/completions`):
  - `deepseek-v4.1-flash`, `deepseek-v4-pro`, `deepseek-v4-flash`, `qwen3.8-flash`, `qwen3.7-max`, `qwen3.6-plus`
  - Monitored by the live 3-window quota meter (5-Hour Rolling, Weekly, Monthly limits).

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

### 7. Authoritative Model Catalog Auto-Enrichment & Discovery

A known limitation of OpenCode Go's default gateway is that `GET https://opencode.ai/zen/go/v1/models` frequently returns a truncated subset of models (often only 10 models), omitting human-readable display names, context windows, max tokens, and input modalities.

`dsh-opencode-patch` resolves this at two distinct layers:

1. **Gateway Models Endpoint Auto-Enrichment**: When DSH or any client requests `GET .../models` on an OpenCode gateway (`/zen/go/v1/models` or `/zen/v1/models`), `patchFetch` intercepts the response and merges it with the canonical 33-model catalog sourced from [`models.dev/api.json`](https://models.dev/api.json).
   - Every model is populated with its human-friendly `name` (`DeepSeek V4.1 Flash`, `Qwen3.8 Flash`, `Grok 4.7`, `MiMo V2.6 Pro`).
   - Every model receives its verified `context_window` (up to 1,000,000+ tokens) and `max_output_tokens` (up to 384,000 tokens).
   - Input modalities (`text`, `image`) are accurately declared so vision-capable models work out of the box.
   - If the upstream gateway suffers a temporary outage or truncates the listing, the full 33-model catalog is seamlessly served so model discovery never breaks.

2. **Native DSH Model Discovery Registration**: On the host runtime, `dsh-opencode-patch` registers with DSH's native model discovery service (`ctx.llm.registerModelDiscovery`). When DSH's model picker enumerates models for OpenCode Go, it immediately surfaces the full list of all 33+ subscription models.

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
   [ ⭕ 73% Context ]   [ 🪙 Zen: $25.00 ]    ← when OpenCode Zen is active
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
  - **Attached Zen Credit Card**: Displays your attached available Zen balance (e.g. `$25.00` or `Ready`), showing whether Zen overflow is ready to take over when Go limits are reached.
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
│  AVAILABLE ZEN BALANCE                       │
│  Zen balance ready for overflow      $25.00  │
├──────────────────────────────────────────────┤
│  Last updated 08:30              [ Retry ]   │
│  Upgrade plan · Console & balance · Doc      │
└──────────────────────────────────────────────┘
```

#### Mode B: OpenCode Zen (`opencode`)

- **Zen Credit Pill**: Compact coin badge (`🪙 Zen: $25.00` or `🪙 OpenCode Zen`) in the dock.
- **Pay-As-You-Go Panel**:
  - Explains per-token pay-as-you-go billing.
  - Displays attached available balance card.
  - Links directly to [OpenCode Console](https://opencode.ai/console) and [Pricing](https://opencode.ai/pricing).

```
┌──────────────────────────────────────────────┐
│  OpenCode Zen                [Pay-as-you-go] │
│  Per-token pay-as-you-go inference           │
├──────────────────────────────────────────────┤
│  AVAILABLE ZEN BALANCE                       │
│  Zen balance ready for overflow      $25.00  │
├──────────────────────────────────────────────┤
│  Last updated 08:30              [ Retry ]   │
│  Upgrade plan · Console & balance · Doc      │
└──────────────────────────────────────────────┘
```

### Attaching Zen Available Credit

OpenCode does not offer a public REST balance endpoint, so the plugin allows attaching your Zen credit via multiple seamless layers:

1. **DSH Credentials (Recommended)**: Store `OPENCODE_ZEN_CREDIT` or `OPENCODE_ZEN_BALANCE` in `~/.dsh/.credentials.yaml` (e.g. `"$25.00"`).
2. **Environment Variables**: Set `OPENCODE_ZEN_BALANCE="$25.00"` or `OPENCODE_ZEN_CREDIT="$25.00"` in your shell profile.
3. **Automatic Zen Detection**: If an `OPENCODE_API_KEY` is present, the plugin automatically detects that Zen pay-as-you-go is configured and displays overflow as **Ready**.

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
| **Providers** | `List` | `opencode, opencode-go` | Comma-separated provider route IDs intercepted by the patch. |
| **Gateway URLs** | `List` | `opencode.ai/zen` | Comma-separated URL substrings identified as OpenCode gateway traffic. |
| **Session ID Env Var** | `Text` | `OPENCODE_SESSION_ID` | Environment variable consulted for fallback session IDs outside a turn. |
| **Enable Go Quota Monitor** | `Switch` | `on` | Mounts the live quota & credit meter in the composer dock. |
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
    usageKeyEnv: "OPENCODE_GO_API_KEY"
    usageProviderMarkers:
      - opencode-go
      - opencode
    injectUserAgent: true
    injectOriginHeaders: true
    originClient: "cli"
    injectProject: true # Attach workspace folder (or 'global'); false omits header
    injectCoreTools: true
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
