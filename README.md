# dsh-opencode-patch

[![npm version](https://img.shields.io/npm/v/dsh-opencode-patch)](https://www.npmjs.com/package/dsh-opencode-patch) [![CI](https://github.com/viztor/dsh-opencode-patch/actions/workflows/ci.yml/badge.svg)](https://github.com/viztor/dsh-opencode-patch/actions/workflows/ci.yml) [![Release](https://github.com/viztor/dsh-opencode-patch/actions/workflows/release.yml/badge.svg)](https://github.com/viztor/dsh-opencode-patch/actions/workflows/release.yml) [![License: MIT](https://img.shields.io/npm/l/dsh-opencode-patch)](LICENSE) [![Node >= 24](https://img.shields.io/node/v/dsh-opencode-patch)](https://nodejs.org)

Free OpenCode models and live Go quota display inside DeepSeek Harness. Zen (`muse-spark-1.3-contributor-free`, `space-bunny-free`) and Go (`deepseek-v4.1-flash`) — no `403 FreeTierError`, no `400 MissingSessionID`.

OpenCode's gateways expect three things DSH doesn't send by default: a valid `x-opencode-session` on every call, CLI origin proof on Zen (`User-Agent`, client headers, `ses_…`-shaped IDs), and `read`/`bash` tool definitions on free-tier calls. DSH strips the user agent, identifies sessions with UUIDs the gateways reject, and can send tool-less requests — so the calls fail.

This plugin restores exactly what's missing at the network layer, and only for OpenCode traffic (`opencode` / `opencode-go` routes, `zen/v1` / `zen/go/v1` URLs). In addition, it tracks live OpenCode Go quota limits (5h rolling, weekly, and monthly rates) with a native pill in the chat input tray so you never wonder why a call stopped responding. DeepSeek, OpenAI, GitHub, and every other request pass through byte-for-byte untouched.

## Install

From npm:

```sh
cd ~/.dsh/profiles/web
npm install dsh-opencode-patch
```

Add the bundle to your profile's `package.json`:

```json
{
  "dependencies": {
    "dsh-opencode-patch": "^0.5.1"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "dsh-opencode-patch"
      ]
    }
  }
}
```

Then `pnpm install` in the profile directory and restart DSH.

## Configure

DSH Web → **Settings → Plugins → OpenCode Integration**. Flip toggles, **Save**:

| Setting | Default | Effect |
| :-- | :-- | :-- |
| Inject User-Agent | on | Restores the OpenCode CLI `User-Agent` DSH strips |
| User-Agent Override | empty | Custom string instead of the canonical CLI one |
| Inject Origin Headers | on | Adds `x-opencode-client: cli` + `x-opencode-project: global` |
| Inject Core Tools | on | Adds fallback `read`/`bash` schemas to free-tier `/responses` calls |
| Providers | `opencode, opencode-go` | Which route IDs get the treatment |
| Usage Quota Tracking | on | Live 5h, weekly, and monthly limit tracking in chat input tray |
| Debug Logging | off | Logs each header-injected call via `ctx.logger` |
| Debug File | empty | Appends JSONL stream-debug entries to a server-side path |

Defaults live in code and show in the labels, so an empty field always means "the default". Settings resolve in layers — built-in defaults, then `cordis.patch.yml`, then anything saved here — and saving writes only what you edited. The `Overridden` badge marks UI-saved fields; **Reset** drops a field back to the file value.

## Headless config

For servers or `cordis.patch.yml` overlays (all optional — omitting everything yields the defaults above):

```yaml
- id: dsh-opencode-patch
  name: "dsh-opencode-patch"
  config:
    providers: [opencode, opencode-go]
    injectUserAgent: true
    userAgent: ""
    injectOriginHeaders: true
    injectCoreTools: true
    usageEnabled: true
    debug: false
```

Types and `debugFile` are documented in [cordis.patch.yml](cordis.patch.yml).

## Live OpenCode Go Quota Pill

When an OpenCode Go model (`deepseek-v4.1-flash`) is selected in chat, an interactive quota pill mounts in the right-hand corner of the message input box:

- Displays real-time rolling 5-hour, weekly, and monthly utilization percentages
- Highlights in amber (≥80%) and alerts in red when rate-limited (100%)
- Clicking opens a popover detailing exact progress bars and reset timestamps
- Credentials never reach the browser; the host fetches stats using `OPENCODE_GO_API_KEY` via DSH Typert IPC

## Troubleshooting

| Symptom | Likely cause | Fix |
| :-- | :-- | :-- |
| `403 FreeTierError` on free models | Headers stripped or tools missing | Keep the three inject toggles on |
| `400 MissingSessionID` | No session header attached | Plugin must be in `bundles` and activated — check boot logs |
| Go Quota says "Unavailable" | Missing API key | Store `OPENCODE_GO_API_KEY` in DSH Credentials or environment |
| Anything else misbehaving | Shouldn't be us — non-OpenCode traffic is never touched | File an issue with a redacted log |

## Compatibility

**Last verified: 2026-10-01** — refreshed on every release (see [Contributing](CONTRIBUTING.md)).

| Component | Verified version |
| :-- | :-- |
| Plugin | `dsh-opencode-patch` (npm + GitHub Packages) |
| Host | DSH Web profile (`dsh-profile-web`, `patchReload: live`) |
| Runtime | Node 24+ |
| Gateways | `zen/v1` (`/responses` + chat completions), `zen/go/v1` (chat completions) |
| Models | `muse-spark-1.3-contributor-free`, `space-bunny-free`, `deepseek-v4.1-flash` (Go) |
| Gates | `vp check` clean, 57 deterministic tests green, registry install resolves |

## Links

- [Contributing](CONTRIBUTING.md) — setup, conventions, release process
- [Changelog](CHANGELOG.md) — per-version record
- [License](LICENSE) — MIT (nobu121 & viztor)

## Attribution

Evolved from [`nobu121/dsh-opencode-session`](https://github.com/nobu121/dsh-opencode-session) by [@nobu121](https://github.com/nobu121), which pioneered the `x-opencode-session` approach for OpenCode Go. This project extends it to Zen free-tier compatibility, deterministic session hashing, configurable headers, live Go quota tracking, and a Web settings UI.
