<div align="center">
  <p><b>English</b> &nbsp;·&nbsp; <a href="./README.zh-CN.md">简体中文</a></p>

  <img src="icon.svg" alt="OpenCode on DeepSeek Harness" width="112" />
  <h1>dsh-opencode-patch</h1>
  <p><b>OpenCode on DeepSeek Harness</b><br />Gateway origin headers · Session affinity · Free-tier tool fallback · Live dual-mode quota meter</p>

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

**The problem.** OpenCode's gateways expect request traits DSH does not send by default: a valid `x-opencode-session` on every turn, official CLI origin proof (`User-Agent`, client/project headers, `ses_…`-shaped IDs), and `read`/`bash` tool definitions on free-tier requests. Subagents, background evaluations, and experimental modes like **Auto Review** also invoke the LLM in standalone sessions where `sessionId` is omitted or unlinked.

**What this does.** It restores every missing protocol element at the network layer — **strictly for OpenCode routes** (`opencode` / `opencode-go` / `opencode-responses` / `opencode-anthropic`). All other traffic (DeepSeek, OpenAI, Anthropic, GitHub) passes through untouched.

**What you get.** A picker listing the whole OpenCode catalog with real names, prices and context windows; every model sent to the endpoint it is actually served on; and a live meter for the quota or the spend — no configuration.

**Three things it is built around.**

1. **Minimal intrusion.** Nothing is patched globally: requests are intercepted only for the routes this plugin claims, and every other provider — DeepSeek, OpenAI, Anthropic, GitHub — passes through byte-identical. The composer meter is one switch away from being gone, not one screen away from being tolerated.
2. **A native DSH plugin.** One `apply()`, a settings card bound to its own namespace, services declared through `ctx.inject`, slots filled the way the host fills its own, and copy in both bundled languages. No private hooks, no patched host code.
3. **OpenCode API compatibility.** The traits the gateways actually check are restored at the network layer — a `ses_…` id shaped exactly like the CLI's own, official origin headers, parent-session lineage, and the free-tier `read`/`bash` schema fallback.

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
8. [Deep Dive](./docs/deep-dive.md) — the protocol internals, out of this README
9. [Attribution & License](#-attribution--license)

---

## 🚀 Quick Start

**1. Install** into your DSH Web profile (Node 24+):

```sh
cd ~/.dsh/profiles/web
npm install dsh-opencode-patch
```

The package is `dsh-opencode-patch` under every name it is used by: the dependency you install, the bundle entry in your profile, and the row the host resolves.

**2. Enable the bundle** — add the package to the profile's `dsh.profile.bundles` array:

```jsonc
// ~/.dsh/profiles/web/package.json
{
  "dependencies": {
    "dsh-opencode-patch": "^0.14.0",
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

**Both endpoints, and both credential shapes.** OpenCode's catalog defines an endpoint at two levels: a **provider default** — `https://opencode.ai/zen/v1` for Zen, `https://opencode.ai/zen/go/v1` for Go — and a per-model **inference** endpoint that overrides it when the catalog sets one (the CLI reads `model.api.url`, falling back to the provider default). The plugin pins neither: it matches the `opencode.ai/zen` marker, so a model served from the default and a model served from its own endpoint are both patched.

Those endpoints authenticate in **two ways**, because they speak three wire shapes: the OpenAI planes send `Authorization: Bearer <key>`, the Anthropic plane sends `x-api-key: <key>`. The plugin reads **both** — `Authorization` first, then `x-api-key` / `api-key` — so a credential is captured whichever plane carried it, and the Go quota read still finds a key.

The gateway serves four protocol families, and **OpenAI alone is two of them**: Chat Completions and Responses are different wire formats, not two names for one thing. A model that needs Responses does not work on the completions endpoint, and the gateway does not fall back — it answers `500`.

DSH can speak three of the four families, so the patch routes those three and **deliberately does not offer the fourth** (Google Generative AI). See the table below.

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
| _(absent)_ | 28 | OpenAI Chat Completions | the route you configured |
| `@ai-sdk/openai` | 30 | OpenAI Responses | `opencode-responses` |
| `@ai-sdk/anthropic` | 18 | Anthropic Messages | `opencode-anthropic` |
| `@ai-sdk/google` | 7 | _(no such protocol in DSH)_ | **not offered** |

Counts are the **83** active `opencode` models in `models.dev` as of 2026-10-09 — everything else the vendor lists is deprecated or retired, and the patch ships only what the gateway still serves. The same 83 are bundled offline in `src/catalog-data.ts`, so every one of them routes correctly before the first catalog refresh; regenerate that file with `pnpm run catalog:shim`.

The patch **keeps those two routes out of both the model picker and _Settings → Models_**. Three properties hold today, and one does not yet:

- **You keep choosing.** The picker shows exactly the models you listed, and each one is matched to the right protocol automatically. OpenCode serves models on three shapes — OpenAI Chat Completions (the default), OpenAI Responses, and Anthropic Messages — and a model that needs one of the other two is dispatched to the route that speaks it. No second route to declare by hand.
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

### 5. The catalog: what gets merged, and what wins

The model list is assembled from four sources, each answering a different question:

| Source | Answers |
| :-- | :-- |
| Bundled shim | what can be offered before any network call — cold start, offline |
| models.dev | the canonical spec, price and display name |
| The gateway's `/models` | what **this account** actually has |
| Discovery decoration | what `discoverModels` should answer |

Merging is **additive**: adapter rows are kept, canonical rows are appended when a model is missing, and a row is dropped only when the provider-scoped retirement list names it — a fact, not a guess. Display names and prices come from models.dev, because a gateway listing carries ids and little else.

Two things follow that you will notice in use. **Cold start is never empty** — the bundled shim answers before the first refresh, so the picker has models immediately. And **a model models.dev has no row for still appears**, with `—` where its rate would be: never a guess, and never the previous model's name.

Both generated files are checked in CI (`catalog:shim`, `limits:shim`); they exit non-zero when the vendor's data moved, which is the only way to notice models.dev changing under you.

→ Protocol routing, the merge and the UI in technical detail: [`docs/protocol-routing-and-merge.md`](./docs/protocol-routing-and-merge.md) · [中文](./docs/protocol-routing-and-merge.zh-CN.md)

## 🖥 The Interface

Two surfaces, one reading. Both are pure views over the same Host data.

| Surface | Where | What it shows |
| :-- | :-- | :-- |
| **Meter trigger** | composer dock, beside the model selector | Go: a ring plus the window's percent. Zen: the session spend, and no ring |
| **Meter panel** | click the trigger | The windows, the monthly allowance, the session spend, the Zen credit, the action links |
| **Settings card** | _Settings → Plugins → OpenCode Patch_ | Eight controls, plus a live Go usage summary above them |

Hovering the trigger explains its own number; clicking it opens the panel. The sections below show each surface, and [docs/quota-meter.zh-CN.md](./docs/quota-meter.zh-CN.md) documents every state it can be in.

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

The card also carries a **live Go usage summary** above the controls — the same reading the composer meter shows, in the layout the vendor's own console uses: one row per window, with what is **left** held out on the right.

```
Go usage                                           Healthy
● 5 hours    0% used · resets in 4h 58m           100% left
● Weekly    28% used · resets in 3d 2h             72% left
● Monthly   14% used · resets Nov 7, 8:55 AM       86% left
Monthly allowance  mimo-v2.6-pro · Go $60 · Plus $120         ⓘ
```

"Left" is a percentage, never a dollar figure: `/usage` publishes a percent per window and no balance at all, and the plan tier is not discoverable — so a dollar remainder would be a guess. The ⓘ states that. A quota that cannot be read says so and prints no numbers, rather than a row of zeroes that reads as a measurement.

### Composer dock meter

The meter mounts next to DSH's native `ContextMeter` in `conversation.composer.dock`:

Per-state behaviour — the trigger's three states, both panels, what every row answers, and the three different kinds of "no number" — is documented in [docs/quota-meter.zh-CN.md](./docs/quota-meter.zh-CN.md) (Chinese).

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

- **Adaptive ring**: a real-time SVG ring for the window that answers the question. A window that is **out** — rate-limited, or at its cap — is shown, widest first (monthly → weekly → 5-hour), because a monthly cap explains a refusal the 5-hour window does not. Otherwise it shows the **5-hour** window, which resets soonest and so is the one you can still act on. On a **free model** the ring renders hollow in the muted track colour — the plan's limit says nothing about a bill that cannot be charged, and red against `$0.00` would read as "you are out of money".
- **Semantic colors**: green below 80% (`--dsw-alias-state-success-primary`), amber at ≥80% (`--dsw-alias-state-warn-primary`), red at the cap (`--dsw-alias-state-error-primary`).
- **Click panel**: three window rows with live reset countdowns and a bar per window, a session-spend row naming the **currently selected** model, a Zen-overflow row, a rate-limited alert, and act-on-it links. Hovering the trigger shows a `Tooltip` listing **every** window (`5 hours 11% · Weekly 33% · Monthly 16%`), because the trigger can print only one of them and the next question is always "and the other two?".
- **A model the catalog has no price for reads `—`, not `Free`.** The panel names whatever the picker has selected, even when models.dev has no entry for it yet (it syncs on a schedule), because showing the previous model's name is worse than showing no price.

```
┌──────────────────────────────────────────────┐
│  OpenCode Go                          [Go Plan]│
├──────────────────────────────────────────────┤
│  • 5 hours        ███████░░░░░░░░░    42% │
│    Resets 3h 12m                             │
│  • Weekly         ███░░░░░░░░░░░░░    18% │
│    Resets 5d 8h                              │
│  • Monthly        █████████████░░░    65% │
│    Resets 22d 4h                             │
├──────────────────────────────────────────────┤
│  Monthly allowance                           │
│  mimo-v2.6-flash              Go $60 · Plus $120│
├──────────────────────────────────────────────┤
│  Session Spend                               │
│  deepseek-v4.1-flash · $0.15 / $0.6 per 1M   │
│                                        $0.42 │
│  Available Zen Balance                       │
│  Ready for overflow                   Ready  │
├──────────────────────────────────────────────┤
│  ⟳ Updated 08:30             Upgrade  Console › │
└──────────────────────────────────────────────┘
```

#### Mode B — OpenCode Zen (`opencode`)

A Zen route renders no Go figure anywhere: there is no ring at all (a gauge with no measurement is decoration), the label is the spend rather than a percentage, a rate-limited **Go** plan does not paint the **Zen** trigger as an alert, and hovering carries the price (`Session Spend $0.00 · Pay-as-you-go`). A Go window is a fact about a plan this route never bills against, so it does not appear here.

- **Zen trigger**: the spend as its label, and **no ring** — the ring is a gauge, and Zen has no window to measure (`$0.00` before anything has been priced, `$0.42` after). The figure is the only real number available — OpenCode exposes Zen balance through console server actions that require a browser session, so an API key cannot read it.
- **Pay-as-you-go panel**: header with a `Pay-as-you-go` badge, the session-spend row (when the price switch is on), and one link — [OpenCode Console](https://opencode.ai/console), labelled **Top up**, because top-up is what a pay-as-you-go user wants from that page and it has no URL of its own.

```
┌───────────────────────────────────────────────┐
│  OpenCode Zen                [Pay-as-you-go]  │
├───────────────────────────────────────────────┤
│  Session Spend                                │
│  Space Bunny Free · Free     $0.00│
├───────────────────────────────────────────────┤
│  ⟳ Updated 08:30                    Top up ›   │
└───────────────────────────────────────────────┘
```

**The monthly allowance, and why it is a total and not a balance.** The three windows are shares of a per-model monthly **dollar** allowance — the vendor's own words: _"Usage limits are defined as monthly dollar amounts… 5-hour — 20% of the monthly limit; weekly — 50%; and monthly — 100%."_ So the meter prints that allowance under the windows: for `mimo-v2.6-flash`, `Go $60 · Plus $120`. It is generated from the vendor's Go documentation (`pnpm run limits:shim`, checked on a schedule in CI) because the page states outright that _"usage limits may change"_ — a hand-typed table would be wrong within a release, and a stale dollar figure looks authoritative.

It shows **both tiers** rather than one, because the plan is not discoverable: `/limits`, `/plan`, `/subscription`, `/account` and `/credits` all return 404, and `/models` carries no limit. Guessing a tier would misstate the money by 2–3x.

It is deliberately **not** a remaining balance. `GET /zen/go/v1/usage` takes no model parameter, so its percentages describe the account rather than the model you are reading — multiplying an account-level percentage by a per-model allowance yields a number with no referent. The remaining balance is in the console, where it is exact.

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
        usageEnabled: true # off = no meter and no price row
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
| **Plugin package** | [`dsh-opencode-patch`](https://www.npmjs.com/package/dsh-opencode-patch) |
| **Host profile** | DSH Web profile (`patchReload: live`) |
| **Routes claimed** | `opencode`, `opencode-go`, `opencode-responses`, `opencode-anthropic` |
| **Gateways** | `opencode.ai/zen/v1` (`/responses`, `/chat/completions`, `/messages`, `:streamGenerateContent`), `zen/go/v1` (`/chat/completions`) |
| **Supported models** | `claude-sonnet-4-5`, `gpt-5.4`, `gemini-3.8-flash`, `deepseek-v4.1-flash`, `muse-spark-1.3-contributor-free`, `qwen3.8-flash` |
| **Verification gate** | `vp check` clean, **266** deterministic tests green, full schema validation, consumer install + load ([`scripts/check.ts`](./scripts/check.ts)) |

---

## 🔍 Deep Dive

The header-injection matrix, session lineage, workspace attribution, API tiers and catalog internals live in **[docs/deep-dive.md](./docs/deep-dive.md)**. This README stays at the level of what you see and what you configure.

## 👥 Attribution & License

Inspired by [**`nobu121/dsh-opencode-session`**](https://github.com/nobu121/dsh-opencode-session) by [@nobu121](https://github.com/nobu121), which pioneered session ID handling for OpenCode on DSH. This plugin is a **separate implementation** by [@viztor](https://github.com/viztor): it took the idea and wrote the rest — Zen free-tier gateway compatibility, hierarchical subagent lineage, dynamic workspace project attribution, live dual-mode Go quota and Zen credit monitoring, and native Web UI integration.

**Links:** [npm](https://www.npmjs.com/package/dsh-opencode-patch) · [Repository](https://github.com/viztor/dsh-opencode-patch) · [Issues](https://github.com/viztor/dsh-opencode-patch/issues) · [Changelog](./CHANGELOG.md) · [Contributing](./CONTRIBUTING.md) · [OpenCode](https://opencode.ai) · [models.dev](https://models.dev)

Licensed under the [MIT License](LICENSE).
