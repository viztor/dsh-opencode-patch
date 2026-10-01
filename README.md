# OpenCode on DeepSeek Harness

[![npm version](https://img.shields.io/npm/v/@viztor/dsh-opencode)](https://www.npmjs.com/package/@viztor/dsh-opencode) [![CI](https://github.com/viztor/dsh-opencode/actions/workflows/ci.yml/badge.svg)](https://github.com/viztor/dsh-opencode/actions/workflows/ci.yml) [![Release](https://github.com/viztor/dsh-opencode/actions/workflows/release.yml/badge.svg)](https://github.com/viztor/dsh-opencode/actions/workflows/release.yml) [![License: MIT](https://img.shields.io/npm/l/@viztor/dsh-opencode)](LICENSE) [![Node >= 24](https://img.shields.io/node/v/@viztor/dsh-opencode)](https://nodejs.org) [![Last commit](https://img.shields.io/github/last-commit/viztor/dsh-opencode)](https://github.com/viztor/dsh-opencode/commits/main)

Free OpenCode models, working inside DeepSeek Harness. Zen (`muse-spark-1.3-contributor-free`, `space-bunny-free`) and Go (`deepseek-v4.1-flash`) — no `403 FreeTierError`, no `400 MissingSessionID`.

OpenCode's gateways expect three things DSH doesn't send by default: a valid `x-opencode-session` on every call, CLI origin proof on Zen (`User-Agent`, client headers, `ses_…`-shaped IDs), and `read`/`bash` tool definitions on free-tier calls. DSH strips the user agent, identifies sessions with UUIDs the gateways reject, and can send tool-less requests — so the calls fail. This plugin restores exactly what's missing at the network layer, and only for OpenCode traffic (`opencode` / `opencode-go` routes, `zen/v1` / `zen/go/v1` URLs). DeepSeek, OpenAI, GitHub, and every other request pass through byte-for-byte untouched.

## Install

From npm:

```sh
dsh plugin --profile web add @viztor/dsh-opencode
```

Or pin it in your profile's `package.json`:

```json
{
  "dependencies": {
    "@viztor/dsh-opencode": "^0.5.0"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "@viztor/dsh-opencode"
      ]
    }
  }
}
```

Then `pnpm install` in the profile directory.

## Configure

DSH Web → **Settings → Plugins → OpenCode Integration**. Flip toggles, **Save**:

| Setting | Default | Effect |
| :-- | :-- | :-- |
| Inject User-Agent | on | Restores the OpenCode CLI `User-Agent` DSH strips |
| User-Agent Override | empty | Custom string instead of the canonical CLI one |
| Inject Origin Headers | on | Adds `x-opencode-client: cli` + `x-opencode-project: global` |
| Inject Core Tools | on | Adds fallback `read`/`bash` schemas to free-tier `/responses` calls |
| Providers | `opencode, opencode-go` | Which route IDs get the treatment |
| Debug Logging | off | Logs each header-injected call via `ctx.logger` |
| Debug File | empty | Appends JSONL stream-debug entries to a server-side path |

Defaults live in code and show in the labels, so an empty field always means "the default". Settings resolve in layers — built-in defaults, then `cordis.patch.yml`, then anything saved here — and saving writes only what you edited. The `Overridden` badge marks UI-saved fields; **Reset** drops a field back to the file value.

## Headless config

For servers or `cordis.patch.yml` overlays (all optional — omitting everything yields the defaults above):

```yaml
- id: dsh-opencode
  name: "@viztor/dsh-opencode"
  config:
    providers: [opencode, opencode-go]
    injectUserAgent: true
    userAgent: ""
    injectOriginHeaders: true
    injectCoreTools: true
    debug: false
```

Types and `debugFile` are documented in [cordis.patch.yml](cordis.patch.yml).

## Troubleshooting

| Symptom | Likely cause | Fix |
| :-- | :-- | :-- |
| `403 FreeTierError` on free models | Headers stripped or tools missing | Keep the three inject toggles on |
| `400 MissingSessionID` | No session header attached | Plugin must be in `bundles` and activated — check boot logs |
| Anything else misbehaving | Shouldn't be us — non-OpenCode traffic is never touched | File an issue with a redacted log |

## Compatibility

**Last verified: 2026-10-01** — refreshed on every release (see [Contributing](CONTRIBUTING.md)).

| Component | Verified version |
| :-- | :-- |
| Plugin | `@viztor/dsh-opencode@0.5.1` (npm + GitHub Packages) |
| Host | DSH Web profile (`dsh-profile-web`, `patchReload: live`) |
| Runtime | Node 26+ |
| Gateways | `zen/v1` (`/responses` + chat completions), `zen/go/v1` (chat completions) |
| Models | `muse-spark-1.3-contributor-free`, `space-bunny-free`, `deepseek-v4.1-flash` (Go) |
| Gates | `vp check` clean, 49 deterministic tests green, registry install resolves |

## Links

- [Contributing](CONTRIBUTING.md) — setup, conventions, release process
- [Changelog](CHANGELOG.md) — per-version record
- [License](LICENSE) — MIT (nobu121 & viztor)

## Attribution

Evolved from [`nobu121/dsh-opencode-session`](https://github.com/nobu121/dsh-opencode-session) by [@nobu121](https://github.com/nobu121), which pioneered the `x-opencode-session` approach for OpenCode Go. This project extends it to Zen free-tier compatibility, deterministic session hashing, configurable headers, and a Web settings UI.
