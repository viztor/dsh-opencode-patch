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

**The default state.** Point DSH at OpenCode with no plugin and the models do not work at all — not on one shape, on any of them:

- **The request is not recognised as coming from a coding agent.** DSH sends its own `User-Agent`, and no `x-opencode-client`, `x-opencode-project` or `x-opencode-session` at all, so the gateway sees an anonymous SDK call and the traffic falls under the abuse rules the vendor documents for clients that do not identify themselves. **The free tier is a separate matter and this is not its cause**: with every one of those headers restored, a CLI `User-Agent`, a valid session id and the `read`/`bash` tool schemas the fallback injects, a Zen `-free` model still answers `403 FreeTierError` from outside OpenCode while a paid model on the same request answers `200`. The ids are still offered — the refusal names itself, and hiding a row the vendor may serve is the worse failure — and the headers it restores are for the paid routes and the vendor's stated client rules.
- **A turn without a session id is rejected or left unlinked.** Every turn has to carry a stable `ses_…`-shaped id, and DSH omits `sessionId` entirely for subagents, background evaluations and modes like **Auto Review**.
- **Free-tier `/responses` bodies are refused without `read` and `bash` in `tools`**, and DSH deliberately does not send them.
- **The catalog is thin.** A bare `/models` listing carries ids and little else, so the picker shows unnamed rows with no prices and no context windows.

**What is left once those work is a different problem, and it is not about the account.** OpenCode serves its models on **four different API shapes**, while DSH picks a transport from the provider row — one route can speak one shape. So a model served on Responses, Messages or Mistral answers `500` the moment the basics are restored, which is why this plugin routes per **model** rather than per provider.

**What this does.** It restores every missing protocol element at the network layer — **strictly for OpenCode routes** (`opencode` / `opencode-go` / `opencode-responses` / `opencode-anthropic` / `opencode-google`). All other traffic (DeepSeek, OpenAI, Anthropic, GitHub) passes through untouched.

**What you get.** A picker listing the whole OpenCode catalog with real names, prices and context windows; every model sent to the endpoint it is actually served on; and a live meter for the quota or the spend — no configuration.

**Three things it is built around.**

1. **Minimal intrusion.** Nothing is patched globally: requests are intercepted only for the routes this plugin claims, and every other provider — DeepSeek, OpenAI, Anthropic, GitHub — passes through byte-identical. The composer meter is one switch away from being gone, not one screen away from being tolerated.
2. **A native DSH plugin.** One `apply()`, a settings card bound to its own namespace, services declared through `ctx.inject`, slots filled the way the host fills its own, and copy in both bundled languages. No private hooks, no patched host code.
3. **OpenCode API compatibility.** The traits the gateways actually check are restored at the network layer — a `ses_…` id shaped exactly like the CLI's own, official origin headers, parent-session lineage, and the free-tier `read`/`bash` schema fallback.

**Highlights**

- 🔑 Deterministic `ses_<12hex><14base62>` session hashing with KV-cache affinity across turns, subagents and forks
- 🌐 Gateway origin restoration — `User-Agent`, `x-opencode-client`, `x-opencode-project`, parent-session lineage
- 🧰 Free-tier `read` + `bash` tool-schema fallback, so a free-tier body carries the tool definitions its endpoint requires — one cause of a `403` removed, and not the whole of it: the gateway's gate is not in the request, measured
- 📇 OpenCode-catalog-backed (`models.opencode.ai`, the registry models.dev publishes) with offline shims and background SWR refresh — names, context windows, prices
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
| Zen free models fail with `403 FreeTierError` | **Offered, and refused in the gateway's own words.** The headers and tool fallbacks are restored for the paid routes, but they are not this error's cause — measured with all of them in place, a Zen `-free` id still answers `403` while a paid model answers `200`, and the refusal comes from the service behind the console rather than from anything a request carries. So the ids stay in the picker and the refusal surfaces as `400 free_tier_restricted` instead of a hidden row |
| Only one API shape can be served per route — the rest answer `500` once the basics work | **Per-model routing** — each model dispatched to the endpoint its own SDK names, read from the catalog |
| Session IDs rejected with `400 MissingSessionID` | **Deterministic `ses_…` session hashing** and affinity across turns |
| Subagents lose conversation context | **Parent session tracking** (`x-opencode-parent-session-id`, `x-parent-session-id`) |
| Auto Review calls fail with `TRANSPORT: Connection error` | **Fallback session turn capture** preserving turn state across eval calls |
| Quotas and balances are invisible | **Live dual-mode composer meter** showing Go quota or Zen pay-as-you-go |
| Zen keys cause `403 EntitlementError` on Go usage | **Strict credential isolation** keeping Zen keys away from the Go endpoint |
| Projects share a single `"global"` telemetry bucket | **Dynamic workspace attribution** resolved from the active `session.header.cwd` |
| Gateway `/models` returns a truncated, unnamed list | **Catalog enrichment** (`models.opencode.ai`) with display names, context windows and prices |

---

## 🧭 Supported Models & Multi-Protocol Routing

**Both endpoints, and both credential shapes.** OpenCode's catalog defines an endpoint at two levels: a **provider default** — `https://opencode.ai/zen/v1` for Zen, `https://opencode.ai/zen/go/v1` for Go — and a per-model **inference** endpoint that overrides it when the catalog sets one (the CLI reads `model.api.url`, falling back to the provider default). The plugin pins neither: it matches the `opencode.ai/zen` marker, so a model served from the default and a model served from its own endpoint are both patched.

Those endpoints authenticate in **two ways**, because they speak three wire shapes: the OpenAI planes send `Authorization: Bearer <key>`, the Anthropic plane sends `x-api-key: <key>`. The plugin reads **both** — `Authorization` first, then `x-api-key` / `api-key` — so a credential is captured whichever plane carried it, and the Go quota read still finds a key.

The gateway serves four protocol families, and **OpenAI alone is two of them**: Chat Completions and Responses are different wire formats, not two names for one thing. A model that needs Responses does not work on the completions endpoint, and the gateway does not fall back — it answers `500`.

DSH speaks three of the four families itself. The fourth — Google Generative AI — is served by **this patch's own adapter**, registered on the host's `llm` service under the route `opencode-google`, so all four are routed. See the table below.

### 1. OpenCode Zen (`provider: opencode`) — pay-as-you-go & free tier

- **Anthropic Messages** (`https://opencode.ai/zen/v1/messages`): `claude-sonnet-4-5`, `claude-opus-4-7`, `claude-haiku-4-5`, `qwen3.8-flash`
- **OpenAI Responses** (`https://opencode.ai/zen/v1/responses`): `gpt-5.4`, `gpt-5.2`, `gpt-5.1-codex-max`, `muse-spark-1.3`, `space-bunny-free`, and the free-tier `muse-spark-1.3-contributor-free`
- **OpenAI Chat Completions** (`https://opencode.ai/zen/v1/chat/completions`): `deepseek-v4.1-flash`, `kimi-k2.5`, `kimi-k3`, `minimax-m2.5`, `glm-5.2`, plus free-tier `nemotron-3-ultra-free`, `ling-3.0-flash-fin-free`, `mimo-v2.6-flash-free`
- **Google Generative AI** (`https://opencode.ai/zen/v1/models/*:streamGenerateContent`), served by this patch's adapter as `opencode-google`: `gemini-3.8-flash`, `gemini-3.1-pro`, `gemini-3.5-flash-lite`

### 2. OpenCode Go (`provider: opencode-go`) — subscription quota

- **Google Generative AI** (`https://opencode.ai/inference/go/google/v1beta/models/*:streamGenerateContent`): `gemini-4-argon-contributor`, served by the internal `opencode-go-google` adapter. Add the model under your existing `opencode-go` provider; the bridge inherits that provider's API key reference (default `OPENCODE_GO_API_KEY`). It supports image attachments and signed tool-call replay. Only configured models are mounted; access still depends on your Go plan. This endpoint is also used with `endpoint: legacy`, because Go has no legacy Google endpoint.

- **OpenAI Chat Completions** (`https://opencode.ai/zen/go/v1/chat/completions`): `deepseek-v4-flash`, `deepseek-v4-flash-vision-exp`, `deepseek-v4-pro`, `deepseek-v4.1-flash`, `glm-5.2`, `glm-5.3`, `glm-5.3-flash`, `hy3`, `hy4-preview`, `kimi-k2.6`, `kimi-k2.7-code`, `kimi-k3`, `kimi-k3.1-pro`, `longcat-2.0`, `mimo-v2.5`, `mimo-v2.5-pro`, `mimo-v2.6-flash`, `mimo-v2.6-pro`, `qwen3.6-plus`, `qwen3.7-max`, `space-bunny`, `space-bunny-free`, `step-5-preview-free`
- **OpenAI Responses** (`https://opencode.ai/zen/go/v1/responses`): `gpt-5.6-luna`, `gpt-6-luna`, `grok-4.5`, `grok-4.6`, `grok-4.7`, `muse-spark-1.2-contributor`, `muse-spark-1.3-contributor`
- **Anthropic Messages** (`https://opencode.ai/zen/go/v1/messages`): `claude-haiku-5-5`, `minimax-m2.7`, `minimax-m3`, `qwen3.7-plus`, `qwen3.8-flash`, `qwen3.8-max`
- Monitored by the live 3-window quota meter (5-hour rolling, weekly, monthly). The full set ships in the bundled catalog — see [Authoritative Model Catalogs](#7-authoritative-model-catalogs-dual-local-shims--real-time-swr-updates).

### 3. How a model's protocol is chosen — and why you configure nothing

Zen's provider-level SDK is `@ai-sdk/openai-compatible`. models.dev names a **different** SDK per model only when that model needs one, so the presence of `provider.npm` is the signal — and it is what decides the wire protocol. Nothing is matched by hand:

| models.dev `provider.npm` | models | protocol | served from |
| :-- | --: | :-- | :-- |
| _(absent)_ | 25 | OpenAI Chat Completions | the route you configured |
| `@ai-sdk/openai` | 31 | OpenAI Responses | `opencode-responses` |
| `@ai-sdk/anthropic` | 17 | Anthropic Messages | `opencode-anthropic` |
| `@ai-sdk/google` | 8 | Google Generative AI | `opencode-google` |
| `@ai-sdk/mistral` | 1 | _(a dialect this plugin does not serve)_ | **not offered** |

Counts are the **82** active `opencode` models in `models.opencode.ai` as of 2026-10-23 — everything else the vendor lists is deprecated or retired, and the patch ships only what the gateway still serves. The same 82 are bundled offline in `src/catalog-data.ts`, so every one of them routes correctly before the first catalog refresh; regenerate that file with `pnpm run catalog:shim`.

The patch **keeps those two routes out of both the model picker and _Settings → Models_**. Three properties hold today, and one does not yet:

- **You keep choosing.** The picker shows exactly the models you listed, and each one is matched to the right protocol automatically. OpenCode serves models on three shapes — OpenAI Chat Completions (the default), OpenAI Responses, and Anthropic Messages — and a model that needs one of the other two is dispatched to the route that speaks it. No second route to declare by hand.
- **You are never offered a model that cannot work.** Every one of the four families is reachable, so no model is dropped for want of a protocol: the `@ai-sdk/google` models are served through the patch's own adapter, and the three DSH already speaks are dispatched to the route that speaks them. That holds for models you list by hand as well — one the catalog does not describe is routed by the family its id names (`gemini-*` to the Generative AI path, `claude-*` to Messages), and if the route you put it on cannot serve that protocol it is not offered there at all, rather than answering `400 ModelProtocolUnsupported` when you pick it.
- **One credential, from wherever you already have one.** A routed model authenticates with the key you configured, resolved through the credentials service and never re-asked for — and if a route names no key at all, the installation's own OpenCode store answers, when the deployment opts into reading it. Your own configuration always wins: the order is the route's own reference, then the store, and nothing is consulted before the thing you declared.

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
| **Experimental Auto Review** | Background audit calls with an omitted `sessionId` still get a deterministic turn state, headers and tool fallback — and they take their route from the session, so the model the session is on is the model they run |

---

### 5. The catalog: what gets merged, and what wins

The model list is assembled from four sources, each answering a different question:

| Source | Answers |
| :-- | :-- |
| Bundled shim | what can be offered before any network call — cold start, offline |
| `models.opencode.ai` | the canonical spec, price and display name |
| The gateway's `/models` | what **this account** actually has |
| Discovery decoration | what `discoverModels` should answer |

Merging is **additive**: adapter rows are kept, canonical rows are appended when a model is missing, and a row is dropped only when the registry marks it `status: "deprecated"` — a fact, not a guess. Display names and prices come from the catalog (`models.opencode.ai`), because a gateway listing carries ids and little else.

Two things follow that you will notice in use. **Cold start is never empty** — the bundled shim answers before the first refresh, so the picker has models immediately. And **a model the catalog has no row for still appears**, with `—` where its rate would be: never a guess, and never the previous model's name.

Both generated files are checked in CI (`catalog:shim`, `limits:shim`); they exit non-zero when the vendor's data moved, which is the only way to notice the vendor's registry changing under you.

→ Protocol routing, the merge and the UI in technical detail: [`docs/protocol-routing-and-merge.md`](./docs/protocol-routing-and-merge.md) · [中文](./docs/protocol-routing-and-merge.md)

## 🖥 The Interface

Two surfaces, one reading. Both are pure views over the same Host data.

| Surface | Where | What it shows |
| :-- | :-- | :-- |
| **Meter trigger** | composer dock, beside the model selector | Go: a ring plus the window's percent. Zen: the session spend, and no ring |
| **Meter panel** | click the trigger | The windows, the monthly allowance, the session spend, the Zen credit, the action links |
| **Settings card** | _Settings → Plugins → OpenCode Patch_ | Nine controls, plus a live Go usage summary above them |

Hovering the trigger explains its own number; clicking it opens the panel. The sections below show each surface, and [docs/quota-meter.md](./docs/quota-meter.md) documents every state it can be in.

### Settings card — _Settings → Plugins → OpenCode Patch_

Nine controls in four sections — the decisions a user actually makes. Everything renders from the platform's own primitives (`Switch`, `Tag`, `Button`, host tokens), and every knob carries a hint plus a reset-to-default affordance.

| Section | Control | Default | What it does |
| :-- | :-- | :-: | :-- |
| **Gateway Requests** | Inject User-Agent | `on` | Restores the official OpenCode CLI `User-Agent` so Cloudflare WAF checks pass |
| **Gateway Requests** | Inject Origin Headers | `on` | Injects `x-opencode-client` (and the origin header set) on gateway traffic |
| **Gateway Requests** | Attach Workspace Project | `on` | Tags `x-opencode-project` with the active folder name; off omits the header |
| **Models & Free Tier** | Enrich model metadata from the OpenCode catalog | `on` | Fills catalog context limits, modalities and thinking levels into model info, and lets the gateway `/models` listing carry the full catalog. Does **not** add models to the picker — the picker shows declared models only; use the card's **Check catalog** row to declare more |
| **Models & Free Tier** | Inject Core Tools | `on` | Adds the `read` + `bash` schemas free-tier `/responses` bodies require |
| **Quota Meter** | Enable Composer Usage Meter | `on` | Mounts the live meter in the composer dock — the Go quota ring, or the Zen session spend |
| **Account & Endpoint** | API Endpoint | `auto` | Which endpoint family requests go to: **Automatic** (same as Modern) · **Legacy** (`zen/v1`, `zen/go/v1`) · **Modern** (per-protocol `inference/{openai,anthropic,google}/…`, `inference/go/…` on Go) |
| **Account & Endpoint** | Credential Source | `auto` | Which key wins when several are known: **Automatic** · **Live request first** · **Declared key first** |
| **Account & Endpoint** | Read the OpenCode installation's key | `off` | Lets the plugin read the credential OpenCode itself stored, as the LAST resort — off by default |

### Choosing the endpoint and the credential

Two questions decide where a request goes, and the **Account & Endpoint** section is where you answer them.

**Which endpoint family.** The gateway answers on two families — the older `/zen/v1` (`/zen/go/v1` on Go), one base for every protocol, and the newer per-protocol `inference` family (`/inference/openai/v1`, `/inference/anthropic/v1`, `/inference/google/v1beta`, with `/inference/go/…` on Go) — and they are entitled **separately**: an account that works on one is not guaranteed to work on the other. `modern` sends each protocol to its own inference path; `auto`, the default, is an alias of `modern`; `legacy` pins the older family, which is what you want when your account only works there.

**Which credential wins.** `keySource` orders the sources the plugin can see — `auto` prefers a key you declared, then one captured from a live request, then the declared reference; `request` promotes a captured key first; `configured` does the reverse. Below it, `readOpencodeStore` lets the plugin read the credential OpenCode itself stored, as the **last** resort only. Both are `off`/`auto` by default, so nothing changes until you say so.

Override-style knobs (literal strings, markers, route lists) are deliberately **config-only** so a default fits every documented setup — see [Configuration Reference](#-configuration-reference).

The composer panel also shows the **session's accumulated cost and the active model's per-million-token rate**, and there is no switch for it: it is part of the panel rather than an option, so it is on whenever the panel is.

The card also carries a **live Go usage summary** above the controls — the same reading the composer meter shows, in the layout the vendor's own console uses: one row per window, with what is **left** held out on the right.

```
Go usage                                           Healthy
● 5 hours    0% used · resets in 4h 58m           100% left
● Weekly    28% used · resets in 3d 2h             72% left
● Monthly   14% used · resets Nov 7, 8:55 AM       86% left
Monthly allowance  mimo-v2.6-pro · Go $60 · Plus $120         ⓘ
```

**This build carries the API key path only.** There is no sign-in row and no device flow: a credential comes from the deployment's configuration, from a key captured on a live request, or — when `readOpencodeStore` is on — from the OpenCode installation's own store. The Console login (device flow, session store, credential pool) lives on the `v2` line and is deliberately not in `main`, so nothing here depends on a service the host may not mount.

**If the card looks like the previous build after updating, the host process has not restarted.** The host bundle is read once at process start, so a browser reload keeps running the previous `lib/index.mjs`; stop and restart `dsh web`. The row is the quickest way to tell, because it is new in the same build as everything else.

"Left" is a percentage, never a dollar figure: `/usage` publishes a percent per window and no balance at all, and the plan tier is not discoverable — so a dollar remainder would be a guess. The ⓘ states that. A quota that cannot be read says so and prints no numbers, rather than a row of zeroes that reads as a measurement.

### Composer dock meter

The meter mounts next to DSH's native `ContextMeter` in `conversation.composer.dock`:

Per-state behaviour — the trigger's three states, both panels, what every row answers, and the three different kinds of "no number" — is documented in [docs/quota-meter.md](./docs/quota-meter.md).

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
- **A model the catalog has no price for reads `—`, not `Free`.** The panel names whatever the picker has selected, even when the catalog has no entry for it yet (it syncs on a schedule), because showing the previous model's name is worse than showing no price.

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
| `credentialOrg` | — | The org id an account credential belongs to, when the deployment supplies one out of band |
| `debug` / `debugFile` | `false` / — | Diagnostic JSONL logging, not a behaviour anyone tunes in the UI; the file is written only while `debug` is on |

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
        hiddenModels: [] # ids withheld from every listing
        sessionIdEnv: "OPENCODE_SESSION_ID"
        freeModelMarker: "free"
        usageBaseURL: "https://opencode.ai/zen/go/v1"
        endpoint: "auto" # auto | legacy | modern
        keySource: "auto" # auto | request | configured
        injectUserAgent: true
        injectOriginHeaders: true
        originClient: "cli"
        injectProject: true # attach workspace folder (or 'global'); false omits the header
        injectCoreTools: true
        enrichModels: true # merge catalog specs into model info + gateway /models listings
        usageEnabled: true # off = no meter and no price row
        # File-level only debug options:
        debug: false # debugFile is written only while this is true
        debugFile: "/tmp/dsh-opencode-debug.jsonl"
```

> **Host reload rule:** restart `dsh web` after any host change (`lib/index.mjs`); a browser refresh is enough for client UI changes (`lib/client.js`).

---

## 🛠 Troubleshooting

| Symptom | Likely cause | Fix |
| :-- | :-- | :-- |
| `403 FreeTierError` on free models | The gateway's gate is not in the request: measured with a real account, its session token, its active org and every header the official client sends, a free-tier model still answers `403` | The three injection switches above are still worth keeping on — they are what makes the traffic identifiable and they restore the tool schemas — but they do not open the free tier on their own. The paid models work with a key; see [docs/opencode-1.19-api.md](./docs/opencode-1.19-api.md) for what was excluded and how |
| `400 MissingSessionID` | No session header attached | Ensure `dsh-opencode-patch` is listed in the profile's `dsh.profile.bundles` |
| Auto Review fails with `TRANSPORT: Connection error` | Host process not restarted since the update | Stop and restart `dsh web` so the new `lib/index.mjs` loads |
| Quota ring never appears for a Go model | **Restart `dsh web`, then read the browser console** — the plugin is loaded through a `link:`, so `lib/index.mjs` is read once at process start and a page reload alone keeps the old host code; the meter reports which of its paths returned nothing | The console names the cause: `no remote to mount on`, `did not mount` with the exception, `still waiting for remote.opencodeGoUsage`, `no opencodeGoUsage service on the remote` with the keys it does expose, or `the answer is not a usage shape` with what came back. A missing or unroutable credential is one cause of several, not the only one |
| A catalog model is missing from Settings → Fetch, or a retired one persists | Stale host module, enrichment off, or the adapter answered from its packaged catalog | `pnpm run build`, restart `dsh web`, keep **Enrich model metadata** on, fetch from the matching route, search the exact id (e.g. `space-bunny-free`) |
| Popover shows “Limit reached” in red | 100% of a rolling/monthly window reached | Open the [OpenCode Console](https://opencode.ai/console) and enable _Use balance_ to overflow into Zen credits |
| Non-OpenCode models misbehaving | Unrelated to this patch | Traffic to other providers passes through untouched |

---

## 📜 Compatibility & Verification

**Verified on DeepSeek Harness `0.2.1` — both the `alpha` and `rc` channels (Node 24+)**

The harness publishes two **channels**, `alpha` and `rc`, and they are parallel tracks rather than a version ordering: semver sorts `0.2.1-rc.2` _above_ `0.2.1-alpha.5`. Both channels' latest is **`0.2.1`**, and that line is this plugin's target — it is tested against every published `0.2.1` build in both channels, and the `@deepseek-ai/dsh-typert-protocol` peer range says so exactly:

```
>=0.2.1-alpha.1 <0.2.2
```

One range covers the whole line on both channels: its lower bound (`alpha.1`) sorts below every `rc` of the same line, so rc needs no separate entry. A plain `<0.2.2` would **not** work — semver excludes prereleases unless a comparator in the same `major.minor.patch` tuple carries one, which is how a range written against one channel silently excludes the other.

| Surface | Target |
| :-- | :-- |
| **Harness line** | **`0.2.1`**, `alpha` and `rc` channels alike (peer: `>=0.2.1-alpha.1 <0.2.2`) |
| **Plugin package** | [`dsh-opencode-patch`](https://www.npmjs.com/package/dsh-opencode-patch) |
| **Host profile** | DSH Web profile (`patchReload: live`) |
| **Routes claimed** | `opencode`, `opencode-go`, `opencode-responses`, `opencode-anthropic` |
| **Gateways** | `opencode.ai/zen/v1` (`/responses`, `/chat/completions`, `/messages`, `:streamGenerateContent`), `zen/go/v1` (`/chat/completions`) |
| **Catalog** | Generated from `models.opencode.ai/api.json`; retirement follows the registry's own `status: "deprecated"` flag, with no hand-maintained id list |
| **Upstream pi** | **Not bundled.** The bridge loads whatever `@earendil-works/pi-ai` the harness installed, so a harness bump never skews a pinned copy |
| **Verification gate** | `vp check` clean, **961** deterministic tests green (unit + offline gateway mock), full schema validation, consumer install + load ([`scripts/check.ts`](./scripts/check.ts)) |

---

## 🔍 Deep Dive

The header-injection matrix, session lineage, workspace attribution, API tiers and catalog internals live in **[docs/deep-dive.md](./docs/deep-dive.md)**. This README stays at the level of what you see and what you configure.

## 👥 Attribution & License

Inspired by [**`nobu121/dsh-opencode-session`**](https://github.com/nobu121/dsh-opencode-session) by [@nobu121](https://github.com/nobu121), which pioneered session ID handling for OpenCode on DSH. This plugin is a **separate implementation** by [@viztor](https://github.com/viztor): it took the idea and wrote the rest — Zen free-tier gateway compatibility, hierarchical subagent lineage, dynamic workspace project attribution, live dual-mode Go quota and Zen credit monitoring, and native Web UI integration.

**Links:** [npm](https://www.npmjs.com/package/dsh-opencode-patch) · [Repository](https://github.com/viztor/dsh-opencode-patch) · [Issues](https://github.com/viztor/dsh-opencode-patch/issues) · [Changelog](./CHANGELOG.md) · [Contributing](./CONTRIBUTING.md) · [OpenCode](https://opencode.ai) · [models.dev](https://models.dev)

Licensed under the [MIT License](LICENSE).
