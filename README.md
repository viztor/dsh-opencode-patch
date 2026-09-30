# dsh-opencode

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) host plugin and Web settings UI that manages session affinity, OpenCode Zen gateway origin verification, and free-tier compatibility for OpenCode, OpenCode Go, and OpenCode Zen routes.

## Origin & Attribution

This project is an evolution of [**`nobu121/dsh-opencode-session`**](https://github.com/nobu121/dsh-opencode-session) by [@nobu121](https://github.com/nobu121).

- **Original Foundation:** `dsh-opencode-session` solved the initial `400 MissingSessionID` issue on OpenCode's relay by attaching `x-opencode-session` headers during `llm/stream` waterfall events.
- **Expanded Capabilities in `dsh-opencode`:**
  1. **OpenCode Zen Free-Tier Compatibility (`403 FreeTierError` fix):** The OpenCode Zen gateway (`https://opencode.ai/zen/v1`) enforces client origin and tool validation for free community models (such as `muse-spark-1.3-contributor-free` and `space-bunny-free`).
  2. **DSH Header Stripping Bypass:** DeepSeek Harness's internal adapter (`dsh-llm-pi-ai`) classifies `user-agent` as a reserved header and strips it from outbound requests. `dsh-opencode` restores `User-Agent: opencode/1.18.33 ...`, `x-opencode-client: cli`, and `x-opencode-project: global` at the network layer.
  3. **Deterministic Session ID Hashing:** Converts DSH conversation UUIDs into OpenCode-compliant `ses_<12hex><14base62>` session IDs, preserving prompt cache routing and turn affinity without failing format validation.
  4. **Core Tool Schema Fallback:** Guarantees that free-tier `/responses` requests carry the required `read` (`filePath`) and `bash` (`command`) tool schemas so tool-less queries or subagent invocations pass origin verification.
  5. **Native Web Client Settings UI:** Contributes a settings card under **Settings → Plugins** in the DSH Web interface for graphical configuration.

---

## Stack & Target

- **Runtime Target:** Node 24+ (`>=24.0.0`, ES2024).
- **Language:** 100% TypeScript with strict typing.
- **Toolchain:** **Vite+** (`vp`) over tsdown, Vitest, Oxlint, and Oxfmt with [Ultracite](https://github.com/ultracite/ultracite).
- **Package Manager:** `pnpm`.

---

## Installation & Setup

### 1. In DeepSeek Harness Profile

From npm (recommended):

```sh
dsh plugin --profile web add @viztor/dsh-opencode
```

Or declare it directly in your profile's `package.json`:

```json
{
  "dependencies": {
    "@viztor/dsh-opencode": "^0.2.0"
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

For local development, link the checkout instead:

```json
{
  "dependencies": {
    "@viztor/dsh-opencode": "link:../../../dev/dsh-opencode"
  }
}
```

Run `pnpm install` in your profile directory.

### 2. Graphical Configuration (No Manual YAML Required)

Because `dsh-opencode` is a self-contained bundle, its configuration layer is **automatically mounted at startup**. You do not need to manually edit `cordis.patch.yml`.

Open the DSH Web UI and navigate to **Settings → Plugins → OpenCode Integration**:

- **Inject User-Agent**: Toggle whether the OpenCode CLI User-Agent is restored (default: `true`).
- **User-Agent Override**: Specify a custom User-Agent string if desired (leave empty to use default).
- **Inject Origin Headers**: Toggle injection of `x-opencode-client` and `x-opencode-project` (default: `true`).
- **Inject Core Tools**: Toggle fallback injection of standard `read` & `bash` tool schemas on free-tier `/responses` requests (default: `true`).
- **Providers**: Comma-separated list of route IDs to intercept (default: `opencode, opencode-go`).

Click **Save** — DSH persists your preferences through its built-in configuration form service.

---

## Configuration Reference

For headless deployments or declarative overlays in `cordis.patch.yml`:

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

| Option | Type | Default | Description |
| :-- | :-- | :-- | :-- |
| `providers` | `string[]` | `['opencode', 'opencode-go']` | Provider route keys to intercept |
| `injectUserAgent` | `boolean` | `true` | Restore OpenCode User-Agent stripped by DSH transport |
| `userAgent` | `string` | `""` | Optional User-Agent override; empty uses canonical OpenCode CLI string |
| `injectOriginHeaders` | `boolean` | `true` | Inject `x-opencode-client: cli` and `x-opencode-project: global` |
| `injectCoreTools` | `boolean` | `true` | Auto-inject fallback `read` and `bash` schemas on free `/responses` |
| `mode` | `'session-id' \| 'uuid'` | `'session-id'` | Session derivation mode (deterministic hash of DSH session ID) |
| `debug` | `boolean` | `false` | Log streaming calls receiving session headers to `ctx.logger` |
| `debugFile` | `string` | `undefined` | Optional absolute path to append NDJSON stream debug entries |

---

## Development

Use `pnpm` for all tasks:

```sh
pnpm install     # install dependencies
pnpm run check   # format, lint, and type check in one pass (vp check)
pnpm run test    # run unit test suite with Vitest (vp test)
pnpm run build   # build library with tsdown (vp pack -> lib/index.mjs + lib/index.d.mts + lib/client.js)
```

---

## License

[MIT](LICENSE) — Copyright (c) 2026 nobu121 & viztor.
