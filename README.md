<div align="center">
  <img src="icon.svg" alt="OpenCode logo" width="120" />
  <h1>dsh-opencode-patch</h1>
  <p><strong>OpenCode on DeepSeek Harness — Gateway Origin Headers, Session Affinity, and Live Quota Monitor.</strong><br />Seamlessly connect OpenCode Zen & Go models to DSH without connection errors or invisible limits.</p>

[![npm](https://img.shields.io/npm/v/dsh-opencode-patch.svg)](https://www.npmjs.com/package/dsh-opencode-patch) [![downloads](https://img.shields.io/npm/dm/dsh-opencode-patch.svg)](https://www.npmjs.com/package/dsh-opencode-patch) [![ci](https://github.com/viztor/dsh-opencode-patch/actions/workflows/ci.yml/badge.svg)](https://github.com/viztor/dsh-opencode-patch/actions/workflows/ci.yml) [![release](https://github.com/viztor/dsh-opencode-patch/actions/workflows/release.yml/badge.svg)](https://github.com/viztor/dsh-opencode-patch/actions/workflows/release.yml) [![license](https://img.shields.io/npm/l/dsh-opencode-patch.svg)](https://github.com/viztor/dsh-opencode-patch/blob/main/LICENSE) [![node](https://img.shields.io/node/v/dsh-opencode-patch.svg)](https://nodejs.org)

</div>

---

Connect OpenCode Zen models (`muse-spark-1.3-contributor-free`, `space-bunny-free`) and OpenCode Go (`deepseek-v4.1-flash`) to DeepSeek Harness without network rejections or silent failures.

OpenCode's gateways expect three things DSH does not send by default: a valid `x-opencode-session` on every turn, CLI origin proof on Zen (`User-Agent`, client headers, `ses_…`-shaped IDs), and `read`/`bash` tool definitions on free-tier requests. DSH strips the user agent, identifies sessions with raw UUIDs the gateway rejects, and can emit tool-less requests — causing `403 FreeTierError` or `400 MissingSessionID`.

`dsh-opencode-patch` restores missing elements at the network layer strictly for OpenCode routes (`opencode` / `opencode-go`). All other traffic (DeepSeek, OpenAI, Anthropic, GitHub) passes through untouched.

| Without Patch | With `dsh-opencode-patch` |
| :-- | :-- |
| Zen free models fail with `403 FreeTierError` | **100% gateway origin headers & tool fallbacks** restored automatically |
| Session IDs rejected with `400 MissingSessionID` | **Deterministic `ses_…` session hashing** and affinity across turns |
| Quotas run out silently mid-conversation | **Live SVG quota ring & hover modal** mounted beside native `ContextMeter` |
| Switching package names breaks profile configs | **Universal multi-alias engine** (`dsh-opencode-patch`, `@viztor/*`) |

---

## 🚀 Quick start

### Method 1: Direct from Web UI (Recommended)

DeepSeek Harness allows installing plugins directly through the Web interface without touching a terminal:

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
    "dsh-opencode-patch": "^0.9.1",
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

<details>
<summary><strong>📦 Installing from GitHub Packages instead</strong></summary>

<br />

Every release mirrors `@viztor/dsh-opencode-patch` to GitHub Packages — an alternative source if npmjs.org is unreachable. GitHub Packages requires authentication even for public packages:

```ini
# project-local .npmrc
@viztor:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=ghp_xxx
```

Then `npm install @viztor/dsh-opencode-patch` resolves from the mirror.

</details>

---

## ⭕ Live OpenCode Go Quota Ring & Hover Modal

When an OpenCode Go model (`deepseek-v4.1-flash`) is active, an interactive SVG circular progress meter mounts in the composer dock (`conversation.composer.dock`), directly alongside DSH's native `ContextMeter`:

```
┌─────────────────────────────────────────────────────────────────┐
│ Type a message...                                               │
│                                                                 │
│ [+] Attach                            [DeepSeek V4.1 Flash ⌄] [⬆]│
└─────────────────────────────────────────────────────────────────┘
   [ ⭕ 73% Context ]   [ ⭕ 100% Go Quota ]  ← conversation.composer.dock
```

It registers in **one** slot only. Both the composer dock and the input tray render, so a second registration would draw the meter twice.

### When it appears

The meter is deliberately absent rather than wrong:

| State | What you see |
| :-- | :-- |
| A key resolves and the active provider/model matches a **Usage Marker** (default: OpenCode Go) | The quota ring |
| No configured marker matches the active provider/model — any route id or model name works, not just `opencode-go` | Nothing |
| **Enable Go Quota Monitor** is off | Nothing |
| No OpenCode Go credential is configured | Nothing — toggle it on in Settings once you add a key |
| A transient fetch failure | The ring with a stale/error state and a retry button |

"Nothing" means the slot renders no element at all: an unactionable "unavailable" chip sitting in the composer for every non-Go user is worse than an absent meter.

### Visual Features

- **Adaptive Bottleneck Indicator**: Always displays the currently limiting window percentage (e.g. `100%` when rate-limited, or your 5h rolling usage).
- **Dynamic Color States**, drawn from the host's own semantic theme tokens so they are correct in light and dark mode:
  - `--dsw-alias-state-success-primary` (green): Normal operation (<80%).
  - `--dsw-alias-state-warn-primary` (amber): Elevated usage (≥80%).
  - `--dsw-alias-state-error-primary` (red): Limit reached (100% rate-limited).
- **Rich Hover Modal**:
  - **Bottleneck Accent Bar**: Visual gauge of active quota pressure.
  - **3-Window Breakdown Rows**: Dedicated progress meters for **5-Hour Rolling**, **Weekly**, and **Monthly** limits.
  - **Human-Friendly Countdowns**: Live relative timers (`in 3h 12m`, `in 7d 17h`, or `soon`).
  - **3-Column Balance Cards**: Overview cards for quick visual reference.
  - **Diagnostics & Refresh**: Displays last updated timestamp with a manual retry button.
  - **Act-on-it links**: [raise the limit](https://opencode.ai/go), the [console](https://opencode.ai/console) for usage and balance, and the [limits reference](https://opencode.ai/docs/go/), so a hit cap has an answer next to it.

### Why there is no "$ left" figure

You may expect the meter to show remaining credit as money. It cannot, and this is not an omission:

- **No balance endpoint exists.** Of every plausible route under `opencode.ai/zen/v1` and `/zen/go/v1` — `balance`, `credits`, `billing`, `account`, `me`, `key`, `limits`, `plan`, `subscription` — only `/models` and `/zen/go/v1/usage` exist. Everything else 404s, and `/models` returns 200 on the same key, so those 404s are real absences rather than an auth problem.
- **The usage payload carries no currency.** Each window returns only `status`, `percent`, and `resetsAt`.
- **A percentage cannot be converted to dollars.** The monthly cap is per _model_ ($15 / $30 / $60 on Go, $60–$240 on Go Plus), while usage accrues across whatever models you used. That mix is not in the response, so any single "monthly cap" applied to it would be a guess.

The console is the only place OpenCode shows the balance, so the meter links there rather than inventing a number.

---

## 🔑 Zero-Config Credential Discovery

You do not need to duplicate your API key into this plugin's settings. The host-side service automatically scans:

1. `cordis.patch.yml` under `llm-pi-ai.providers["opencode-go"]` (`apiKeyEnv`, inline `apiKey`, or custom `baseURL`)
2. Standalone adapter rows (`id: opencode-go` / `name: dsh-opencode-go`)
3. DSH Credentials Service (`~/.dsh/.credentials.yaml`)
4. System environment variables (`OPENCODE_GO_API_KEY`, `OPENCODE_API_KEY`)

Credentials never reach the browser; the host queries `https://opencode.ai/zen/go/v1/usage` and pushes sanitized status via DSH Remote IPC.

---

## ⚙️ Configuration

DSH Web → **Settings → Plugins → OpenCode Patch** (设置 → 插件 → OpenCode 补丁设置). Edit values and click **Save**:

| Setting | Default | Effect |
| :-- | :-- | :-- |
| **Enable Go Quota Monitor** | `on` | Shows live quota ring in the composer dock beside context usage |
| **Go Usage Base URL** | `https://opencode.ai/zen/go/v1` | Custom quota endpoint for enterprise proxies or mirrors |
| **Go Key Env Var / Credential** | `OPENCODE_GO_API_KEY` | Custom environment variable or DSH Credential reference |
| **Go Usage Provider Markers** | `opencode-go` | Comma-separated provider substrings the ring reports on — covers proxy route ids |
| **Go Usage Model Markers** | `deepseek-v4.1-flash` | Comma-separated model substrings the ring reports on |
| **Inject User-Agent** | `on` | Restores canonical OpenCode CLI `User-Agent` stripped by DSH |
| **User-Agent Override** | empty | Custom string instead of canonical OpenCode CLI string |
| **Inject Origin Headers** | `on` | Injects `x-opencode-client` and `x-opencode-project` |
| **Origin Client** | `cli` | Value sent as `x-opencode-client` |
| **Origin Project** | `global` | Value sent as `x-opencode-project` |
| **Inject Core Tools** | `on` | Fallback `read`/`bash` schemas on free-tier requests |
| **Free Model Marker** | `free` | Model-id substring treated as free-tier (`*` = every model, empty = never) |
| **Providers** | `opencode, opencode-go` | Comma-separated list of route IDs to intercept |
| **Gateway URLs** | `opencode.ai/zen` | Comma-separated URL substrings treated as OpenCode gateway traffic |
| **Session ID Env Var** | `OPENCODE_SESSION_ID` | Env var consulted before the derived `ses_…` id |
| **Debug Logging** | `off` | Logs each header-injected call via `ctx.logger` |
| **Debug File** | empty | Appends JSONL stream-debug entries to a server-side path |

Settings resolve in layers: **built-in defaults → `cordis.patch.yml` → UI overrides**. Saving writes only modified fields. Click **Reset** on any field to return to the underlying configuration.

### Headless Server Configuration

For servers, headless profiles, or version-controlled `cordis.patch.yml` overlays:

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
    usageModelMarkers:
      - deepseek-v4.1-flash
    injectUserAgent: true
    injectOriginHeaders: true
    originClient: "cli"
    originProject: "global"
    injectCoreTools: true
    debug: false
```

---

## 🔄 Universal Backwards Compatibility

To ensure existing profiles and dependencies continue working without breaking changes, three package identifiers are supported across all runtime layers:

```
                            User Installation
                                    │
       ┌────────────────────────────┼────────────────────────────┐
       ▼                            ▼                            ▼
"dsh-opencode-patch"   "@viztor/dsh-opencode-patch"     "@viztor/dsh-opencode"
(Canonical package)         (Scoped mirror)              (Legacy thin wrapper)
       │                            │                            │
       └────────────────────────────┼────────────────────────────┘
                                    │
                                    ▼
                 [window.__ModuleLoader__.load Engine]
                    Registers all 4 aliases to factory
                                    │
                                    ▼
                 [plugins.bundle.config UI Slot]
                    Binds cards for all package aliases
```

1. **`dsh-opencode-patch`**: Primary canonical package on npmjs.org.
2. **`@viztor/dsh-opencode-patch`**: Scoped mirror for GitHub Packages and enterprise registries requiring scope.
3. **`@viztor/dsh-opencode`**: Thin compatibility wrapper with manifest deprecation notice that declares `dsh-opencode-patch` as a direct dependency and re-exports all runtime APIs and Cordis patches.

---

## 🛠 Troubleshooting

| Symptom | Likely Cause | Solution |
| :-- | :-- | :-- |
| `403 FreeTierError` on free models | Gateway headers stripped or tool definitions missing | Keep **Inject User-Agent**, **Inject Origin Headers**, and **Inject Core Tools** toggled on. |
| `400 MissingSessionID` | No session header attached | Ensure `dsh-opencode-patch` is listed in your profile's `bundles` array. |
| Quota ring never appears for a Go model | No OpenCode Go credential resolves, or **Enable Go Quota Monitor** is off | Store `OPENCODE_GO_API_KEY` in DSH Credentials or export it in your shell environment, and check the toggle in Settings. |
| Two identical quota rings side by side | A stale bundle from before the meter was reduced to one slot | Reload the page, and confirm the plugin version in Settings → Plugins. |
| Popover shows "Limit reached" in red | Account has reached 100% of rolling or monthly quota | Check the hover popover for the exact reset countdown (`Resets in Xh Ym`). |
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
| **Supported Models** | `muse-spark-1.3-contributor-free`, `space-bunny-free`, `deepseek-v4.1-flash` |
| **Verification Gate** | `vp check` clean, 94 unit tests passing, full schema validation, consumer install+load (`scripts/check.ts`) |

---

## 👥 Attribution & License

Evolved from [**`nobu121/dsh-opencode-session`**](https://github.com/nobu121/dsh-opencode-session) by [@nobu121](https://github.com/nobu121), which pioneered session ID handling for OpenCode on DSH. Extended by [@viztor](https://github.com/viztor) to support Zen free-tier gateway compatibility, deterministic session hashing, live OpenCode Go quota monitoring, and native Web UI integration.

Licensed under the [MIT License](LICENSE).
