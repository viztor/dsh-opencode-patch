# OpenCode on DeepSeek Harness

[![npm version](https://img.shields.io/npm/v/@viztor/dsh-opencode)](https://www.npmjs.com/package/@viztor/dsh-opencode) [![CI](https://github.com/viztor/dsh-opencode/actions/workflows/ci.yml/badge.svg)](https://github.com/viztor/dsh-opencode/actions/workflows/ci.yml) [![Release](https://github.com/viztor/dsh-opencode/actions/workflows/release.yml/badge.svg)](https://github.com/viztor/dsh-opencode/actions/workflows/release.yml) [![License: MIT](https://img.shields.io/npm/l/@viztor/dsh-opencode)](LICENSE) [![Node >= 24](https://img.shields.io/node/v/@viztor/dsh-opencode)](https://nodejs.org) [![Last commit](https://img.shields.io/github/last-commit/viztor/dsh-opencode)](https://github.com/viztor/dsh-opencode/commits/main)

Run free OpenCode Zen models (like `muse-spark-1.3-contributor-free`) inside [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) without `403 FreeTierError` or `400 MissingSessionID` errors.

**Why this exists:** OpenCode's gateway only serves free-tier models to requests that look like the OpenCode CLI (specific `User-Agent`, client headers, and `ses_…` session IDs) and carry `read`/`bash` tool definitions. DeepSeek Harness strips the user agent, uses UUID session IDs the gateway rejects, and can send tool-less requests — so free-tier calls fail. This plugin restores what's needed at the network layer, **only for OpenCode traffic**. Everything else (DeepSeek, OpenAI, GitHub, tools) passes through byte-for-byte untouched.

## Install

Recommended — from npm:

```sh
dsh plugin --profile web add @viztor/dsh-opencode
```

Or declare it in your profile's `package.json`:

```json
{
  "dependencies": {
    "@viztor/dsh-opencode": "^0.2.1"
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

Then run `pnpm install` in your profile directory.

## Configure (no YAML needed)

Open DSH Web → **Settings → Plugins → OpenCode Integration**, flip toggles, hit **Save**:

| Setting | Default | What it does |
| :-- | :-- | :-- |
| Inject User-Agent | on | Restores the OpenCode CLI `User-Agent` DSH strips |
| User-Agent Override | empty | Custom string instead of the canonical CLI one |
| Inject Origin Headers | on | Adds `x-opencode-client: cli` + `x-opencode-project: global` |
| Inject Core Tools | on | Adds fallback `read`/`bash` schemas to free-tier `/responses` calls |
| Providers | `opencode, opencode-go` | Which route IDs get the treatment |

## Headless / declarative config

For servers or `cordis.patch.yml` overlays:

```yaml
- id: dsh-opencode
  name: dsh-opencode
  config:
    providers: [opencode, opencode-go]
    injectUserAgent: true
    userAgent: ""
    injectOriginHeaders: true
    injectCoreTools: true
    mode: session-id
    debug: false
```

Full option reference (types, `debug`/`debugFile`, `mode`): see [cordis.patch.yml](cordis.patch.yml) header comments.

## Troubleshooting

| Symptom | Likely cause | Fix |
| :-- | :-- | :-- |
| `403 FreeTierError` on free models | Headers stripped or tools missing | Keep all three inject toggles on |
| `400 MissingSessionID` | No session header attached | Plugin must be in `bundles`; check it loaded |
| Paid/other providers misbehaving | Shouldn't happen — they're never touched | File an issue with a redacted log |

## Compatibility

**Last verified: 2026-10-01** — refreshed on every release (see [Contributing](CONTRIBUTING.md)).

| Component | Verified version |
| :-- | :-- |
| Plugin | `@viztor/dsh-opencode@0.2.1` (npm + GitHub Packages) |
| Host | DSH Web profile (`dsh-profile-web`, `patchReload: live`) |
| Runtime | Node 24+ |
| Gateway | `https://opencode.ai/zen/v1` (`/responses` + chat completions) |
| Model | `muse-spark-1.3-contributor-free` |
| Checks | `vp check` clean, 44/44 deterministic tests, registry install resolves |

## Links

- [Contributing](CONTRIBUTING.md) — dev setup, conventions, release process
- [Changelog](CHANGELOG.md) — what changed in each version
- [License](LICENSE) — MIT (nobu121 & viztor)

## Attribution

Evolved from [`nobu121/dsh-opencode-session`](https://github.com/nobu121/dsh-opencode-session) by [@nobu121](https://github.com/nobu121), which pioneered the `x-opencode-session` approach for OpenCode Go. This project extends it to OpenCode Zen free-tier compatibility, deterministic session hashing, configurable headers, and a Web settings UI.
