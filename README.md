<div align="center">
  <img src="icon.svg" alt="OpenCode logo" width="120" />
  <h1>dsh-opencode-patch</h1>
  <p><strong>OpenCode on DeepSeek Harness — Gateway Origin Headers, Hierarchical Session Affinity, Dynamic Workspace Attribution, and Live Quota Monitor.</strong><br />Seamlessly connect OpenCode Zen & Go models to DSH without connection errors, entitlement mismatches, or invisible limits.</p>

[![npm](https://img.shields.io/npm/v/dsh-opencode-patch.svg)](https://www.npmjs.com/package/dsh-opencode-patch) [![downloads](https://img.shields.io/npm/dm/dsh-opencode-patch.svg)](https://www.npmjs.com/package/dsh-opencode-patch) [![ci](https://github.com/viztor/dsh-opencode-patch/actions/workflows/ci.yml/badge.svg)](https://github.com/viztor/dsh-opencode-patch/actions/workflows/ci.yml) [![release](https://github.com/viztor/dsh-opencode-patch/actions/workflows/release.yml/badge.svg)](https://github.com/viztor/dsh-opencode-patch/actions/workflows/release.yml) [![license](https://img.shields.io/npm/l/dsh-opencode-patch.svg)](https://github.com/viztor/dsh-opencode-patch/blob/main/LICENSE) [![node](https://img.shields.io/node/v/dsh-opencode-patch.svg)](https://nodejs.org)

</div>

---

Connect OpenCode Zen models (`muse-spark-1.3-contributor-free`, `space-bunny-free`) and OpenCode Go (`deepseek-v4.1-flash`, `qwen3.8-flash`) to DeepSeek Harness without network rejections, Cloudflare challenges, or silent failures.

OpenCode's gateways expect specific request traits that DSH does not send by default: a valid `x-opencode-session` on every turn, official CLI origin proof (`User-Agent`, client/project headers, `ses_…`-shaped IDs), and `read`/`bash` tool definitions on free-tier requests. Furthermore, DSH subagents, background evaluations, and experimental operational modes (like **Auto Review**) invoke the LLM in standalone sessions where `sessionId` is omitted or unlinked.

`dsh-opencode-patch` restores all missing protocol elements at the network layer strictly for OpenCode routes (`opencode` / `opencode-go`), including hierarchical subagent session lineage, dynamic workspace project attribution, and automated Go quota monitoring. All other traffic (DeepSeek, OpenAI, Anthropic, GitHub) passes through untouched.

| Without Patch | With `dsh-opencode-patch` |
| :-- | :-- |
| Zen free models fail with `403 FreeTierError` | **100% gateway origin headers & tool fallbacks** restored automatically |
| Session IDs rejected with `400 MissingSessionID` | **Deterministic `ses_…` session hashing** and affinity across turns |
| Subagents lose conversation context | **Parent session tracking** (`x-opencode-parent-session-id`, `x-parent-session-id`) |
| Auto Review calls fail with 403 or missing session | **Fallback session turn capture** preserving active turn state across eval calls |
| Quotas run out silently mid-conversation | **Live SVG quota ring & hover modal** mounted beside native `ContextMeter` |
| Zen keys cause `403 EntitlementError` on Go usage | **Strict credential isolation** preventing Zen keys from querying Go quota endpoints |
| Projects share a single `"global"` telemetry bucket | **Dynamic workspace project attribution** resolved from active `session.header.cwd` |

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

While live probes confirm the gateway accepts requests regardless of whether the project exists in your OpenCode account (even omitting the header returns `200 OK`), hardcoding `"global"` causes all work across different repositories to merge into a single analytics bucket.

`dsh-opencode-patch` resolves the project dynamically:

1. **Automatic Directory Detection (Default)**: When `originProject` is left at `"global"`, the plugin inspects the active session's working directory (`session.header.cwd`) and extracts the folder name (e.g. `/home/you/projects/my-app` $\rightarrow$ `x-opencode-project: "dsh-opencode"`).
2. **Explicit Override**: If you set an explicit project in Settings (e.g. `originProject: "production-app"`), that value is sent verbatim across all requests.
3. **Header Omission (`"none"` / `"off"`)**: If you set `originProject` to `"none"` or `"off"`, the `x-opencode-project` header is completely omitted, matching OpenCode CLI's standalone behavior.

---

### 4. DSH Experimental Auto-Review Compatibility

In DeepSeek Harness Web, when the user enables the experimental **Auto Review** operational mode (`@deepseek-ai/dsh-experimental-auto-review`), every tool execution (such as `bash` or `edit`) is audited by a background model call before execution:

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

Because Auto Review calls omit `options.sessionId`, earlier plugin versions short-circuited the stream hook, leaving the turn store empty and causing review requests to bypass gateway patching.

`dsh-opencode-patch` generates a deterministic fallback session state whenever `sessionId` is omitted, ensuring that:

- Turn state (`provider`, `model`, `sessionId`, `startedAt`) is established in `AsyncLocalStorage`.
- Auto Review streams to OpenCode models receive full header injection (`x-opencode-session`, `x-opencode-session-id`, `User-Agent`, origin headers).
- Tool definitions (`read`, `bash`) are injected when free-tier models are used.

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
3. If an upstream call returns `EntitlementError`, it is caught and mapped to `configured: false`.

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

When quota limits are reached, our dock popup presents this exact guidance along with direct links to the Console.

---

## 🚀 Quick Start

### Method 1: Direct from Web UI (Recommended)

DeepSeek Harness allows installing plugins directly through the Web interface:

1. Open DSH Web → **Settings → Plugins** (设置 → 插件).
2. Click **Install Plugin** (添加插件).
3. Search or enter `dsh-opencode-patch` (or `@viztor/dsh-opencode`).
4. Click **Install** — DSH automatically fetches the package from npm, builds the bundle patch, and activates it live without restarting!
5. OpenCode free-tier models and your live Go quota ring in the chat composer dock are active right away.

---

### Method 2: Terminal / Profile `package.json`

For headless environments, servers, or version-controlled dotfiles:

```sh
cd ~/.dsh/profiles/web
npm install dsh-opencode-patch   # or: npm install @viztor/dsh-opencode-patch
```

Add the bundle to your profile's `package.json`:

```jsonc
{
  "dependencies": {
    "dsh-opencode-patch": "^0.11.0",
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "dsh-opencode-patch",
      ],
    },
  },
}
```

Then `pnpm install` in the profile directory and restart DSH.

---

## ⭕ Live OpenCode Go Quota Ring & Hover Modal

When an OpenCode Go provider route (`opencode-go`) is active, an interactive SVG circular progress meter mounts in the composer dock (`conversation.composer.dock`), directly alongside DSH's native `ContextMeter`:

```
┌─────────────────────────────────────────────────────────────────┐
│ Type a message...                                               │
│                                                                 │
│ [+] Attach                            [DeepSeek V4.1 Flash ⌄] [⬆]│
└─────────────────────────────────────────────────────────────────┘
   [ ⭕ 73% Context ]   [ ⭕ 100% Go Quota ]  ← conversation.composer.dock
```

### Visual Features

- **Adaptive Bottleneck Indicator**: Always displays the currently limiting window percentage (e.g. `100%` when rate-limited, or your 5h rolling usage).
- **Dynamic Color States**, drawn from host semantic tokens for light and dark modes:
  - `--dsw-alias-state-success-primary` (green): Normal operation (<80%).
  - `--dsw-alias-state-warn-primary` (amber): Elevated usage (≥80%).
  - `--dsw-alias-state-error-primary` (red): Limit reached (100% rate-limited).
- **Rich Hover Modal**:
  - **3-Window Breakdown Rows**: Dedicated progress meters for **5-Hour Rolling**, **Weekly**, and **Monthly** limits.
  - **Human-Friendly Countdowns**: Live relative timers (`in 3h 12m`, `in 7d 17h`, or `soon`).
  - **Zen Balance Fallback Notice**: When rate-limited, explains how to enable "Use balance" in the OpenCode Console to fall back to Zen credits.
  - **Diagnostics & Refresh**: Displays last updated timestamp with a manual retry button.
  - **Act-on-it links**: [Upgrade plan](https://opencode.ai/go), [Console & balance](https://opencode.ai/console), and [Usage limits doc](https://opencode.ai/docs/go/).

---

## ⚙️ Configuration Reference

### DSH Settings UI

Open DSH Web → **Settings → Plugins → OpenCode Patch** (设置 → 插件 → OpenCode 补丁设置). Boolean knobs render as interactive **Switch toggles** matching DSH design primitives:

| Setting | Type | Default | Description |
| :-- | :-: | :-- | :-- |
| **Inject User-Agent** | `Switch` | `on` | Restores official OpenCode CLI User-Agent to pass Cloudflare WAF checks. |
| **User-Agent Override** | `Text` | empty | Optional custom User-Agent string. |
| **Inject Origin Headers** | `Switch` | `on` | Injects `x-opencode-client` and `x-opencode-project`. |
| **Origin Client** | `Text` | `cli` | Value sent as `x-opencode-client`. |
| **Origin Project** | `Text` | `global` | Default project tag; automatically resolves workspace folder when `"global"`. Set `"none"` to omit. |
| **Inject Core Tools** | `Switch` | `on` | Injects dummy `read` + `bash` schemas on free-tier requests to satisfy gateway validation. |
| **Free Model Marker** | `Text` | `free` | Model-id marker triggering tool schema fallback (`*` = all models). |
| **Providers** | `List` | `opencode, opencode-go` | Comma-separated provider route IDs intercepted by the patch. |
| **Gateway URLs** | `List` | `opencode.ai/zen` | Comma-separated URL substrings identified as OpenCode gateway traffic. |
| **Session ID Env Var** | `Text` | `OPENCODE_SESSION_ID` | Environment variable consulted for fallback session IDs outside a turn. |
| **Enable Go Quota Monitor** | `Switch` | `on` | Mounts the live quota ring in the composer dock. |
| **Go Usage Base URL** | `Text` | `https://opencode.ai/zen/go/v1` | OpenCode Go quota statistics API endpoint. |
| **Go Key Env Var / Credential** | `Text` | `OPENCODE_GO_API_KEY` | Credential reference or env var holding the Go subscription key. |
| **Quota Meter Provider Markers** | `List` | `opencode-go` | Provider route substrings that activate the quota meter. |

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
    injectUserAgent: true
    injectOriginHeaders: true
    originClient: "cli"
    originProject: "global" # Or "none" to omit, or specific project string
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
| Auto Review calls fail with 403 | Missing session or origin headers | Update to `dsh-opencode-patch >= 0.11.0`, which captures review calls in the turn store. |
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
| **Gateways** | `zen/v1` (`/responses` & chat completions), `zen/go/v1` (chat completions) |
| **Supported Models** | `muse-spark-1.3-contributor-free`, `space-bunny-free`, `deepseek-v4.1-flash`, `qwen3.8-flash` |
| **Verification Gate** | `vp check` clean, 98 unit tests passing, full schema validation, consumer install+load (`scripts/check.ts`) |

---

## 👥 Attribution & License

Evolved from [**`nobu121/dsh-opencode-session`**](https://github.com/nobu121/dsh-opencode-session) by [@nobu121](https://github.com/nobu121), which pioneered session ID handling for OpenCode on DSH. Extended by [@viztor](https://github.com/viztor) to support Zen free-tier gateway compatibility, hierarchical subagent lineage, dynamic workspace project attribution, live OpenCode Go quota monitoring, and native Web UI integration.

Licensed under the [MIT License](LICENSE).
