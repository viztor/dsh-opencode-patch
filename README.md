<div align="center">
  <img src="icon.svg" alt="OpenCode on DeepSeek Harness" width="112" />
  <h1>dsh-opencode-patch</h1>
  <p><b>OpenCode on DeepSeek Harness</b><br />Gateway origin headers · Session affinity · Free-tier tool fallback · Live dual-mode quota meter</p>

  <p>🇬🇧 <a href="./README.md"><b>English</b></a> &nbsp;·&nbsp; 🇨🇳 <a href="./README.zh-CN.md">简体中文</a></p>

  <p>
    <a href="https://www.npmjs.com/package/dsh-opencode-patch"><img src="https://img.shields.io/npm/v/dsh-opencode-patch.svg" alt="npm version" /></a>
    <a href="https://www.npmjs.com/package/dsh-opencode-patch"><img src="https://img.shields.io/npm/dm/dsh-opencode-patch.svg" alt="npm downloads" /></a>
    <a href="https://github.com/viztor/dsh-opencode-patch/actions/workflows/ci.yml"><img src="https://github.com/viztor/dsh-opencode-patch/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
    <a href="https://github.com/viztor/dsh-opencode-patch/actions/workflows/release.yml"><img src="https://github.com/viztor/dsh-opencode-patch/actions/workflows/release.yml/badge.svg" alt="Release" /></a>
    <a href="https://github.com/viztor/dsh-opencode-patch/blob/main/LICENSE"><img src="https://img.shields.io/npm/l/dsh-opencode-patch.svg" alt="license" /></a>
    <a href="https://nodejs.org"><img src="https://img.shields.io/node/v/dsh-opencode-patch.svg" alt="node" /></a>
    <a href="https://www.typescriptlang.org"><img src="https://img.shields.io/badge/TypeScript-strict-3178C6.svg" alt="TypeScript" /></a>
    <a href="#-quick-start"><img src="https://img.shields.io/badge/DSH-host%20plugin-4D6BFE.svg" alt="DSH host plugin" /></a>
    <a href="#-quick-start"><img src="https://img.shields.io/badge/config-zero-8B5CF6.svg" alt="zero-config" /></a>
    <a href="./CONTRIBUTING.md"><img src="https://img.shields.io/badge/PRs-welcome-brightgreen.svg" alt="PRs welcome" /></a>
  </p>

  <p>
    <a href="#-quick-start">Quick Start</a> ·
    <a href="#-what-this-fixes">What this fixes</a> ·
    <a href="#-the-interface">Interface</a> ·
    <a href="#-configuration-reference">Configuration</a> ·
    <a href="#-troubleshooting">Troubleshooting</a> ·
    <a href="./CHANGELOG.md">Changelog</a> ·
    <a href="./CONTRIBUTING.md">Contributing</a>
  </p>
</div>

---

`dsh-opencode-patch` is a DeepSeek Harness host plugin that keeps **OpenCode Zen & Go** models working inside DSH. Connect `claude-sonnet-4-5`, `gpt-5.4`, `gemini-3.8-flash`, `deepseek-v4.1-flash`, `muse-spark-1.3-contributor-free`, `qwen3.8-flash` and the rest of the OpenCode catalog without network rejections, Cloudflare challenges, entitlement mismatches, or invisible limits.

OpenCode's gateways expect request traits DSH does not send by default: a valid `x-opencode-session` on every turn, official CLI origin proof (`User-Agent`, client/project headers, `ses_…`-shaped IDs), and `read`/`bash` tool definitions on free-tier requests. DSH subagents, background evaluations, and experimental modes like **Auto Review** also invoke the LLM in standalone sessions where `sessionId` is omitted or unlinked.

The plugin restores every missing protocol element at the network layer — **strictly for OpenCode routes** (`opencode` / `opencode-go` / `opencode-responses` / `opencode-anthropic`). All other traffic (DeepSeek, OpenAI, Anthropic, GitHub) passes through untouched.

**Highlights**

- 🔑 Deterministic `ses_<12hex><14base62>` session hashing with KV-cache affinity across turns, subagents and forks
- 🌐 Gateway origin restoration — `User-Agent`, `x-opencode-client`, `x-opencode-project`, parent-session lineage
- 🧰 Free-tier `read` + `bash` tool-schema fallback so Zen free models stop failing with `403 FreeTierError`
- 📇 models.dev-backed catalog with offline shims and background SWR refresh — names, context windows, prices
- ⭕ Live dual-mode composer meter — Go quota ring (5-hour / weekly / monthly) or Zen pay-as-you-go pill, plus session spend and model rate
- 🕵️ Strict credential isolation — Zen keys (`oc_sk_…`) never query the Go quota endpoint

**Contents**

1. [Quick Start](#-quick-start)
2. [What This Fixes](#-what-this-fixes)
3. [Supported Models & Protocols](#-supported-models--multi-protocol-routing)
4. [The Interface](#-the-interface)
5. [Configuration Reference](#-configuration-reference)
6. [Troubleshooting](#-troubleshooting)
7. [Compatibility & Verification](#-compatibility--verification)
8. [Deep Dive: Protocol Specification](#-deep-dive-protocol-specification)
9. [Attribution & License](#-attribution--license)

---

## 🚀 Quick Start

**1. Install** into your DSH Web profile (Node 24+):

```sh
cd ~/.dsh/profiles/web
npm install dsh-opencode-patch
```

The same tree also publishes the scoped aliases [`@viztor/dsh-opencode-patch`](https://www.npmjs.com/package/@viztor/dsh-opencode-patch) and [`@viztor/dsh-opencode`](https://www.npmjs.com/package/@viztor/dsh-opencode) — install any one of them, the row name stays `dsh-opencode-patch`.

**2. Enable the bundle** — add the package to the profile's `dsh.profile.bundles` array:

```jsonc
// ~/.dsh/profiles/web/package.json
{
  "dependencies": {
    "dsh-opencode-patch": "^0.12.0",
  },
  "dsh": {
    "profile": {
      "bundles": ["dsh-opencode-patch"],
      "patchReload": "live",
    },
  },
}
```

**3. Add a credential** so the quota meter can resolve a key — store `OPENCODE_GO_API_KEY` (Go subscription, `sk-…`) and/or `OPENCODE_API_KEY` (Zen pay-as-you-go, `oc_sk_…`) in DSH Credentials or your environment.

**4. Restart `dsh web`.** The host bundle is only imported at boot (`hmr root: []`), so a restart is what loads `lib/index.mjs`; client UI changes (`lib/client.js`) only need a browser refresh.

Done — the **OpenCode Patch** card appears under _Settings → Plugins_, and the meter mounts in the composer dock as soon as an OpenCode model is active.

---

## 🔌 What This Fixes

| Without the patch | With `dsh-opencode-patch` |
| :-- | :-- |
| Zen free models fail with `403 FreeTierError` | **Gateway origin headers & tool fallbacks** restored automatically |
| Session IDs rejected with `400 MissingSessionID` | **Deterministic `ses_…` session hashing** and affinity across turns |
| Subagents lose conversation context | **Parent session tracking** (`x-opencode-parent-session-id`, `x-parent-session-id`) |
| Auto Review calls fail with `TRANSPORT: Connection error` | **Fallback session turn capture** preserving turn state across eval calls |
| Quotas and balances are invisible | **Live dual-mode composer meter** showing Go quota or Zen pay-as-you-go |
| Zen keys cause `403 EntitlementError` on Go usage | **Strict credential isolation** keeping Zen keys away from the Go endpoint |
| Projects share a single `"global"` telemetry bucket | **Dynamic workspace attribution** resolved from the active `session.header.cwd` |
| Gateway `/models` returns a truncated, unnamed list | **models.dev enrichment** with display names, context windows and prices |

---

## 🧭 Supported Models & Multi-Protocol Routing

OpenCode serves inference across multiple upstream protocols through one gateway, and the patch covers all four families.

### 1. OpenCode Zen (`provider: opencode`) — pay-as-you-go & free tier

- **Anthropic Messages** (`https://opencode.ai/zen/v1/messages`): `claude-sonnet-4-5`, `claude-opus-4-7`, `claude-haiku-4-5`, `qwen3.8-flash`
- **OpenAI Responses** (`https://opencode.ai/zen/v1/responses`): `gpt-5.4`, `gpt-5.2`, `gpt-5.1-codex-max`, `muse-spark-1.3`, `space-bunny-free`, and the free-tier `muse-spark-1.3-contributor-free`
- **OpenAI Chat Completions** (`https://opencode.ai/zen/v1/chat/completions`): `deepseek-v4.1-flash`, `kimi-k2.5`, `kimi-k3`, `minimax-m2.5`, `glm-5.2`, plus free-tier `nemotron-3-ultra-free`, `ling-3.0-flash-fin-free`, `mimo-v2.6-flash-free`
- **Google Generative AI** (`https://opencode.ai/zen/v1/models/*:streamGenerateContent`): `gemini-3.8-flash`, `gemini-3.1-pro`, `gemini-3.5-flash-lite`

### 2. OpenCode Go (`provider: opencode-go`) — subscription quota

- **OpenAI Chat Completions** (`https://opencode.ai/zen/go/v1/chat/completions`): `deepseek-v4.1-flash`, `deepseek-v4-pro`, `deepseek-v4-flash`, `deepseek-v4-flash-vision-exp`, `qwen3.8-flash`, `qwen3.8-max`, `qwen3.7-plus`, `kimi-k3`, `kimi-k2.7-code`, `glm-5.3`, `glm-5.3-flash`, `glm-5.2`, `grok-4.7`, `grok-4.6`, `minimax-m3`, `minimax-m2.7`, `mimo-v2.6-pro`, `mimo-v2.6-flash`, `gpt-5.6-luna`, `gpt-6-luna`
- Monitored by the live 3-window quota meter (5-hour rolling, weekly, monthly). The full set ships in the bundled catalog — see [Authoritative Model Catalogs](#7-authoritative-model-catalogs-dual-local-shims--real-time-swr-updates).

### 3. How a model's protocol is chosen — and why you configure nothing

Zen's provider-level SDK is `@ai-sdk/openai-compatible`. models.dev names a **different** SDK per model only when that model needs one, so the presence of `provider.npm` is the signal — and it is what decides the wire protocol. Nothing is matched by hand:

| models.dev `provider.npm` | models | protocol | served from |
| :-- | --: | :-- | :-- |
| _(absent)_ | 26 | OpenAI Chat Completions | the route you configured |
| `@ai-sdk/openai` | 30 | OpenAI Responses | `opencode-responses` |
| `@ai-sdk/anthropic` | 17 | Anthropic Messages | `opencode-anthropic` |
| `@ai-sdk/google` | 7 | _(no such protocol in DSH)_ | **not offered** |

Counts are the 80 **active** `opencode` models in `models.dev` as of 2026-10-05, measured 2026-10-05 — the remaining 36 of the 116 listed are deprecated or retired, and the patch ships only what the gateway still serves. The same 80 are bundled offline in `src/catalog-data.ts`, so every one of them routes correctly before the first catalog refresh; regenerate that file with `pnpm run catalog:shim`.

The patch **keeps those two routes out of both the model picker and _Settings → Models_**. Three properties hold today, and one does not yet:

- **You keep choosing.** The picker shows exactly the models you listed. Selecting one is matched to the right protocol automatically, so adding any Responses or Messages model to your list is enough — no second route to declare by hand.
- **You are never offered a model that cannot work.** The 8 `@ai-sdk/google` models are dropped from the discovery list _and_ from what the `opencode` route reports, because DSH implements no such protocol and selecting one could only fail — with nothing in the row to say why.
- **One credential.** Every routed model authenticates with the `opencode` key you already configured, resolved through the credentials service and never re-asked for.

**The route, if you would rather declare it yourself:** `opencode-responses` — and `opencode-anthropic`, once you use an Anthropic-plane model — can live in your profile's `llm-pi-ai` `providers` block, listing the models it serves. Declaring it is a choice, not a requirement:

```yaml
opencode-responses:
  api: openai-responses
  baseURL: https://opencode.ai/zen/v1
  headers:
    authorization: Bearer unused # swapped for your key by the fetch patch
  models:
    - id: muse-spark-1.3-contributor-free
      name: Muse Spark 1.3 Free
      contextWindow: 1048576
      maxTokens: 131072
      input: [text, image]
```

**The plugin registers that route for you**, so the block above is optional. `responses-provider.ts` mounts the host's own `llm-pi-ai` in-process, isolated from the authorization and settings seams and behind an `llm` facade that forwards only the adapter registration — so the route lands without duplicating the catalog directory, the settings namespace, or a single sign-in flow. This is verified against the real harness, not a stub: the route registers, the host's 41 catalog entries and 41 sign-in flows are untouched, and unloading withdraws the route again.

The routes inherit **your** credential: each one names the same `apiKeyEnv` your `opencode` route already declares, so a custom key reference is never asked for twice. Routes your profile already declares are left alone — the plugin defers to your model list rather than overriding it.

If your host has no loaded `llm-pi-ai` entry, the plugin registers nothing and says so in the log; declare the route in your profile in that case.

### 4. Execution modes covered

| Mode | What the patch does |
| :-- | :-- |
| **Interactive multi-turn chat** | KV prompt-cache affinity via a stable per-session `ses_…` id |
| **Subagents & forks** | Child and parent sessions both hashed; lineage carried in parent headers |
| **Agent teams** | Shared-workspace attribution preserved across orchestration turns |
| **Experimental Auto Review** | Background audit calls with an omitted `sessionId` still get a deterministic turn state, headers and tool fallback |

---

## 🖥 The Interface

### Settings card — _Settings → Plugins → OpenCode Patch_

Eight controls in three sections — the decisions a user actually makes. Everything renders from the platform's own primitives (`Switch`, `Tag`, `Button`, host tokens), and every knob carries a hint plus a reset-to-default affordance.

| Section | Control | Default | What it does |
| :-- | :-- | :-: | :-- |
| **Gateway Requests** | Inject User-Agent | `on` | Restores the official OpenCode CLI `User-Agent` so Cloudflare WAF checks pass |
| **Gateway Requests** | Inject Origin Headers | `on` | Injects `x-opencode-client` (and the origin header set) on gateway traffic |
| **Gateway Requests** | Attach Workspace Project | `on` | Tags `x-opencode-project` with the active folder name; off omits the header |
| **Models & Free Tier** | Enrich Models from Models.dev | `on` | Merges canonical specs, display names, prices and active free models into listings **and** native DSH discovery |
| **Models & Free Tier** | Inject Core Tools | `on` | Adds the `read` + `bash` schemas free-tier `/responses` bodies require |
| **Quota Meter** | Enable Go Quota Monitor | `on` | Mounts the live quota / credit meter in the composer dock |
| **Quota Meter** | Show Session Spend & Model Rate | `on` | Adds the session's accumulated cost and the active model's per-million-token rate |
| **Quota Meter** | Credential Source | `auto` | Which key wins when several are known: **Automatic** · **Live request first** · **Declared key first** |

Override-style knobs (literal strings, markers, route lists) are deliberately **config-only** so a default fits every documented setup — see [Configuration Reference](#-configuration-reference).

### Composer dock meter

The meter mounts next to DSH's native `ContextMeter` in `conversation.composer.dock`:

```
┌─────────────────────────────────────────────────────────────────┐
│ Type a message...                                               │
│                                                                 │
│ [+] Attach                            [DeepSeek V4.1 Flash ⌄] [⬆]│
└─────────────────────────────────────────────────────────────────┘
   [ ⭕ 73% Context ]   [ ⭕ 42% Go Quota ]   ← when OpenCode Go is active
   [ ⭕ 73% Context ]   [ ⭕ $0.00 ]            ← when OpenCode Zen is active
```

#### Mode A — OpenCode Go (`opencode-go`)

- **Adaptive bottleneck ring**: a real-time SVG ring showing the currently _limiting_ window (`42%`, `80%`, or `100%` when rate-limited).
- **Semantic colors**: green below 80% (`--dsw-alias-state-success-primary`), amber at ≥80% (`--dsw-alias-state-warn-primary`), red at the cap (`--dsw-alias-state-error-primary`).
- **Click panel**: three window rows with live reset countdowns, a session-spend row, a Zen-overflow row, a rate-limited alert, and act-on-it links. Hovering the trigger shows a `Tooltip` with the headline instead of opening the panel.

```
┌──────────────────────────────────────────────┐
│  42% of 5-Hour quota used           [Go Plan]│
├──────────────────────────────────────────────┤
│  • 5 hours                               42% │
│    Resets 3h 12m                             │
│  • Weekly                                18% │
│    Resets 5d 8h                              │
│  • Monthly                               65% │
│    Resets 22d 4h                             │
├──────────────────────────────────────────────┤
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

#### Mode B — OpenCode Zen (`opencode`)

- **Zen trigger**: the same ring, carrying the session's accumulated spend as its label (`$0.00` before anything has been priced, `$0.42` after). The figure is the only real number available — OpenCode exposes Zen balance through console server actions that require a browser session, so an API key cannot read it.
- **Pay-as-you-go panel**: header with a `Pay-as-you-go` badge, the session-spend card (when the price switch is on), and direct links to the [OpenCode Console](https://opencode.ai/console) and [Pricing](https://opencode.ai/pricing).

```
┌───────────────────────────────────────────────┐
│  OpenCode Zen                [Pay-as-you-go]  │
├───────────────────────────────────────────────┤
│  SESSION SPEND                                │
│  Space Bunny Free · no extra charge     $0.00│
├───────────────────────────────────────────────┤
│  ⟳ Updated 08:30                    Top up ›   │
└───────────────────────────────────────────────┘
```

**Zen balance & overflow.** If an `OPENCODE_API_KEY` (or `oc_sk_...`) is configured, Zen pay-as-you-go is detected automatically. The Zen panel carries **no balance row**: OpenCode exposes that balance only through console server actions that need a browser session, so the panel links straight to the [OpenCode Console](https://opencode.ai/console) rather than freeze a number it cannot keep current. The balance row lives on the **Go** panel instead, where it answers a question the panel can answer — whether an over-limit Go request will really be billed to that balance.

---

## ⚙ Configuration Reference

### Config-only knobs (`cordis.patch.yml`)

These exist in the schema but render no control — each is a literal, a marker, or a reference whose default fits every documented setup. They remain editable in the row's `config`; [`cordis.patch.yml`](./cordis.patch.yml) is the reference.

| Knob | Default | Why it stays in config |
| :-- | :-- | :-- |
| `providers` | `opencode`, `opencode-go`, `opencode-responses`, `opencode-anthropic` | Route ids to intercept; must cover every route this layer declares |
| `gatewayUrls` | `opencode.ai/zen` | URL substrings marking gateway traffic; only a mirror or relay changes them |
| `userAgent` | empty (= canonical CLI UA) | Literal override; the default is what the gateway expects |
| `originClient` | `cli` | Literal `x-opencode-client` value |
| `sessionIdEnv` | `OPENCODE_SESSION_ID` | Names an env var only a caller-supplied session id uses |
| `freeModelMarker` | `free` | Model-id substring; `*` forces the fallback, `''` disables it |
| `usageBaseURL` | `https://opencode.ai/zen/go/v1` | Endpoint override; auto-discovered from the composition |
| `debug` / `debugFile` | `false` / — | Diagnostic JSONL logging, not a behaviour anyone tunes in the UI |

```yaml
# cordis.patch.yml — the plugin's row; every key is optional.
- insert:
    - id: dsh-opencode-patch
      name: "dsh-opencode-patch"
      config:
        providers:
          - opencode
          - opencode-go
          - opencode-responses
          - opencode-anthropic
        gatewayUrls:
          - opencode.ai/zen
        sessionIdEnv: "OPENCODE_SESSION_ID"
        freeModelMarker: "free"
        usageBaseURL: "https://opencode.ai/zen/go/v1"
        keySource: "auto" # auto | request | configured
        injectUserAgent: true
        injectOriginHeaders: true
        originClient: "cli"
        injectProject: true # attach workspace folder (or 'global'); false omits the header
        injectCoreTools: true
        enrichModels: true # merge models.dev specs + active free models into listings
        usageEnabled: true
        showUsagePrice: true # session spend + active model rate in the meter
        # File-level only debug options:
        debug: false
        debugFile: "/tmp/dsh-opencode-debug.jsonl"
```

> **Host reload rule:** restart `dsh web` after any host change (`lib/index.mjs`); a browser refresh is enough for client UI changes (`lib/client.js`).

---

## 🛠 Troubleshooting

| Symptom | Likely cause | Fix |
| :-- | :-- | :-- |
| `403 FreeTierError` on free models | Gateway headers stripped or tool definitions missing | Keep **Inject User-Agent**, **Inject Origin Headers** and **Inject Core Tools** on |
| `400 MissingSessionID` | No session header attached | Ensure `dsh-opencode-patch` is listed in the profile's `dsh.profile.bundles` |
| Auto Review fails with `TRANSPORT: Connection error` | Host process not restarted since the update | Stop and restart `dsh web` so the new `lib/index.mjs` loads |
| Quota ring never appears for a Go model | No Go credential resolves, or the active provider is not `opencode-go` | Store `OPENCODE_GO_API_KEY` in DSH Credentials and route through `opencode-go` |
| A catalog model is missing from Settings → Fetch, or a retired one persists | Stale host module, enrichment off, or the adapter answered from its packaged catalog | `pnpm run build`, restart `dsh web`, keep **Enrich Models** on, fetch from the matching route, search the exact id (e.g. `space-bunny-free`) |
| Popover shows “Limit reached” in red | 100% of a rolling/monthly window reached | Open the [OpenCode Console](https://opencode.ai/console) and enable _Use balance_ to overflow into Zen credits |
| Non-OpenCode models misbehaving | Unrelated to this patch | Traffic to other providers passes through untouched |

---

## 📜 Compatibility & Verification

**Verified on DeepSeek Harness 0.2.0-rc.2 (Node 24+)**

| Surface | Target |
| :-- | :-- |
| **Plugin package** | `dsh-opencode-patch` on npm + the [`@viztor/dsh-opencode-patch`](https://www.npmjs.com/package/@viztor/dsh-opencode-patch) / [`@viztor/dsh-opencode`](https://www.npmjs.com/package/@viztor/dsh-opencode) scoped aliases |
| **Host profile** | DSH Web profile (`patchReload: live`) |
| **Routes claimed** | `opencode`, `opencode-go`, `opencode-responses`, `opencode-anthropic` |
| **Gateways** | `opencode.ai/zen/v1` (`/responses`, `/chat/completions`, `/messages`, `:streamGenerateContent`), `zen/go/v1` (`/chat/completions`) |
| **Supported models** | `claude-sonnet-4-5`, `gpt-5.4`, `gemini-3.8-flash`, `deepseek-v4.1-flash`, `muse-spark-1.3-contributor-free`, `qwen3.8-flash` |
| **Verification gate** | `vp check` clean, **266** deterministic tests green, full schema validation, consumer install + load ([`scripts/check.ts`](./scripts/check.ts)) |

---

## 🔍 Deep Dive: Protocol Specification

### 1. The header injection matrix

Decompiled from the official `opencode` CLI binary, the gateway enforces different headers for native OpenCode routes versus third-party relays:

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

The fetch patch satisfies every variant:

| Header | Value | Purpose |
| :-- | :-- | :-- |
| `x-opencode-session` | `ses_<12hex><14base62>` | Vendor conversation affinity; enables KV-cache prompt routing |
| `x-opencode-session-id` | `ses_<12hex><14base62>` | Required by OpenCode CLI v1.18+ gateways |
| `x-session-affinity` | `ses_<12hex><14base62>` | Generic proxy/relay affinity (Cloudflare AI Gateway, LiteLLM, Portkey) |
| `x-opencode-parent-session-id` | `ses_<parent_hash>` | Hierarchical lineage for DSH subagents (`subagent`, `subagent_fork`) |
| `x-parent-session-id` | `ses_<parent_hash>` | Generic proxy parent-session affinity |
| `User-Agent` | `opencode/1.18.34 …` | Prevents Cloudflare WAF Error 1010 challenges |
| `x-opencode-client` | `cli` (configurable) | Identifies the client tier to the Zen gateway |
| `x-opencode-project` | dynamic / `global` | Workspace project attribution for the Console |

### 2. Hierarchical subagent & parent session lineage

When DSH spawns subagents (`subagent` / `subagent_fork`), each child runs in a separate session. The plugin inspects the host `SessionRegistry` for `session.header.parentSession`, and maps both sessions deterministically through SHA-256:

```
[Parent DSH Session: "session-abc"] ──(SHA-256)──> [ses_parent_12hex14base62]
           │
           ▼ spawns subagent
[Child DSH Session:  "session-xyz"] ──(SHA-256)──> [ses_child_12hex14base62]

Outgoing subagent request:
  x-opencode-session:           ses_child_12hex14base62
  x-opencode-session-id:        ses_child_12hex14base62
  x-session-affinity:           ses_child_12hex14base62
  x-opencode-parent-session-id: ses_parent_12hex14base62
  x-parent-session-id:          ses_parent_12hex14base62
```

This lineage lets upstream servers optimize prompt caching across agent teams and delegation workflows.

### 3. Dynamic workspace project attribution

OpenCode uses `x-opencode-project` to group token usage, requests and cost in the [OpenCode Console](https://opencode.ai/console).

1. **Enabled (default):** the plugin reads the active session's working directory (`session.header.cwd`) and sends its folder name — `/home/you/projects/my-app` → `x-opencode-project: dsh-opencode`. Outside a project it falls back to `global`.
2. **Disabled:** the header is omitted entirely, matching OpenCode CLI's standalone behavior.
3. **Zero configuration:** no project strings to type or manage — attribution follows your workspace naturally.

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

**Credential isolation (preventing `403 EntitlementError`).** Go keys (`sk-…`) carry the subscription entitlement and can query `https://opencode.ai/zen/go/v1/usage` for rolling, weekly and monthly windows. Zen keys (`oc_sk_…`) cannot — the Go endpoint answers:

```json
403 {"type":"error","error":{"type":"EntitlementError","message":"OpenCode Go subscription required."}}
```

The plugin isolates them: `resolveGoApiKey` excludes Zen keys from the Go usage query; if only a Zen key exists, usage discovery reports `configured: false` and the ring stays hidden instead of spamming 403s; an `EntitlementError` response is mapped to `configured: false` or to the Zen credit status.

**Go plan overflow to Zen credits.** At 100% of the monthly quota, requests only fall back to Zen balance if _Use balance_ is enabled in the [OpenCode Console](https://opencode.ai/console). OpenCode exposes **no public balance API** (open feature request [anomalyco/opencode#10448](https://github.com/anomalyco/opencode/issues/10448)); overflow is handled server-side:

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
| **Multi-protocol gateway** | OpenAI Completions only | Responses + Completions + Anthropic + Google |
| **Free-tier tool fallback** | ❌ | ✅ Injects `read` + `bash` schemas automatically |
| **Hierarchical subagents** | ❌ | ✅ Parent-session headers injected |
| **Dynamic workspace project** | ❌ | ✅ Derived from `session.header.cwd` |
| **Auto Review support** | ❌ Fails without `sessionId` | ✅ Fallback turn capture in `AsyncLocalStorage` |
| **Composer dock meter** | Text string | SVG ring + Zen pill, session spend, model rate |
| **Attached Zen credit** | ❌ | ✅ Credentials, env vars, auto-detection |
| **Model metadata** | `models.dev/api.json` | Standard DSH & OpenCode catalog specs |

`dsh-opencode-go` targets users who only need a standalone Go provider; `dsh-opencode-patch` is the all-in-one layer that fixes, enriches and meters both Zen and Go across every DSH operation mode. ([models.dev](https://models.dev/api.json) is the canonical catalog both draw from.)

### 7. Authoritative model catalogs: dual local shims + real-time SWR updates

OpenCode's gateway `GET …/models` endpoints frequently return a truncated subset — no display names, context windows, max tokens or input modalities. The plugin ships a **stale-while-revalidate** catalog for both planes:

1. **Dual bundled shims (zero latency, offline):** `OPENCODE_GO_CATALOG` carries all **29 active** Go subscription models with per-million-token rates, so session pricing works before the first refresh; `OPENCODE_ZEN_CATALOG` carries the **10 active free-tier models** (`muse-spark-1.3-contributor-free`, `space-bunny-free`, `fledge-alpha-free`, `nemotron-3-ultra-free`, `nemotron-3.5-lightning-free`, `ling-3.0-flash-fin-free`, `ling-3.1-flash-free`, `longcat-2.5-preview-free`, `mimo-v2.6-flash-free`, `big-pickle`) plus flagships (`claude-sonnet-4-5`, `claude-opus-4-7`, `gpt-5.4`, `gemini-3.8-flash`, `qwen3.8-max`, `kimi-k3`). Retired models are excluded so a failed refresh can never resurrect a row the gateway no longer serves — the three Zen-route Muse Spark 1.2 ids are suppressed, while the paid Go 1.2 contributor entry stays (the CLI still lists it). Startup is instant: no cold-start delay, blocking network calls, or airplane-mode failures.
2. **Background revalidation:** both catalogs revalidate against [`https://models.dev/api.json`](https://models.dev/api.json) every **60 minutes** (the OpenCode CLI's canonical cycle), merging new models, deprecations and updated limits. Errors degrade gracefully and retain the active catalog.
3. **Gateway models-endpoint enrichment:** `patchFetch` intercepts `GET …/models` on OpenCode routes and merges the live Go or Zen catalog — human-friendly names (`DeepSeek V4.1 Flash`, `Qwen3.8 Flash`, `Grok 4.7`, `MiMo V2.6 Pro`), verified context windows (up to 1,000,000+ tokens) and max output tokens (up to 384,000), correct input modalities (`text`, `image`), with retired Muse Spark 1.2 rows omitted.
4. **Settings “Fetch Available Models” decoration:** DSH asks the route's own adapter first, and for an installed `opencode` route `llm-pi-ai` answers from its packaged catalog without calling the gateway. The plugin therefore decorates the hosted discovery result: adapter rows and order are preserved, missing canonical rows (e.g. `space-bunny-free`) appended, provider-retired rows removed, and **models whose protocol DSH cannot speak dropped** — offering one could only fail. This is candidate metadata for the settings surface — it never rewrites saved route configuration.
5. **Native model discovery registration:** on the host runtime the plugin also registers with `ctx.llm.registerModelDiscovery` for `opencode-go` and `opencode`. All three enrichments sit behind the **Enrich Models from Models.dev** switch.

### 8. Session spend & model rate

Behind the **Show Session Spend & Model Rate** switch (on by default):

- **Per-turn accounting:** every `llm/stream` usage event is priced with the executing model's input/output/cache-read rates from the catalog and accumulated on the host — the client receives only the figures, never the catalog.
- **Scoped per conversation:** the meter sends provider + conversation id, so two open sessions (or a subagent) never read each other's totals.
- **Mid-session model switches:** the active label and rate follow whatever model runs next, while cumulative spend and the used-model list are preserved.
- **Free tiers and plan-included models** report `Included in Go Plan` at `$0.00` rather than a misleading rate.
- **Go plan spend** is a rate-based _estimate_ of consumption, not an invoice — included usage is covered by the plan. The [OpenCode Console](https://opencode.ai/console) remains the billing source of truth.

### 9. Key resolution per routed model & overage behavior

Different models may route to different accounts (a corporate Go subscription alongside a personal Zen key). `resolveRoutedKey(ctx, provider)` inspects the loaded Cordis rows for the `apiKeyEnv` / literal `apiKey` assigned to each route, derives the account tier (`go` vs `zen`) from the key prefix (`sk-…` vs `oc_sk_…`), and the meter queries accordingly:

- **OpenCode Go (`opencode-go`):** fixed subscription quotas across three windows (5-hour rolling, weekly, monthly %). At 100% the gateway answers `GoUsageLimitError` (HTTP 402/429). Server-side overflow into Zen balance works only if that Go account has _Use balance_ enabled ([opencode.ai/workspace/go](https://opencode.ai/workspace/go)) — a Zen key on a _separate_ account is never debited automatically.
- **OpenCode Zen (`opencode`):** per-token pay-as-you-go against the account balance; no rolling windows. At $0.00 the gateway returns `HTTP 402 Insufficient account funds` — top up via the Console link in the popover.

---

## 👥 Attribution & License

Evolved from [**`nobu121/dsh-opencode-session`**](https://github.com/nobu121/dsh-opencode-session) by [@nobu121](https://github.com/nobu121), which pioneered session ID handling for OpenCode on DSH. Extended by [@viztor](https://github.com/viztor) to support Zen free-tier gateway compatibility, hierarchical subagent lineage, dynamic workspace project attribution, live dual-mode Go quota and Zen credit monitoring, and native Web UI integration.

**Links:** [npm](https://www.npmjs.com/package/dsh-opencode-patch) · [Repository](https://github.com/viztor/dsh-opencode-patch) · [Issues](https://github.com/viztor/dsh-opencode-patch/issues) · [Changelog](./CHANGELOG.md) · [Contributing](./CONTRIBUTING.md) · [OpenCode](https://opencode.ai) · [models.dev](https://models.dev)

Licensed under the [MIT License](LICENSE).
