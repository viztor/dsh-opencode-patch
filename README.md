# dsh-opencode

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) host plugin that manages session affinity, OpenCode Zen gateway origin verification, and free-tier compatibility for OpenCode, OpenCode Go, and OpenCode Zen routes.

## Origin & Attribution

This project is an evolution of [**`nobu121/dsh-opencode-session`**](https://github.com/nobu121/dsh-opencode-session) by [@nobu121](https://github.com/nobu121).

- **Original Foundation:** `dsh-opencode-session` solved the initial `400 MissingSessionID` issue on OpenCode's relay by attaching `x-opencode-session` headers during `llm/stream` waterfall events.
- **Expanded Capabilities in `dsh-opencode`:**
  1. **OpenCode Zen Free-Tier Compatibility (`403 FreeTierError` fix):** The OpenCode Zen gateway (`https://opencode.ai/zen/v1`) enforces client origin and tool validation for free community models (such as `muse-spark-1.3-contributor-free`).
  2. **DSH Header Stripping Bypass:** DeepSeek Harness's internal adapter (`dsh-llm-pi-ai`) classifies `user-agent` as a reserved header and strips it from outbound requests. `dsh-opencode` restores `User-Agent: opencode/1.18.33 ...`, `x-opencode-client: cli`, and `x-opencode-project: global` at the network layer.
  3. **Deterministic Session ID Hashing:** Converts DSH conversation UUIDs into OpenCode-compliant `ses_<12hex><14base62>` session IDs, preserving prompt cache routing and turn affinity without failing format validation.
  4. **Core Tool Schema Fallback:** Guarantees that free-tier `/responses` requests carry the required `read` (`filePath`) and `bash` (`command`) tool schemas so tool-less queries or subagent invocations pass origin verification.

---

## Contributing Upstream

We encourage upstream adoption! If you are maintaining or contributing to `nobu121/dsh-opencode-session`:

- The deterministic session mapping (`openCodeSessionIdFor`) and `patchFetch` gateway origin restoration in `src/index.ts` can be ported directly into the upstream repository.
- Upstream pull requests and issue discussions: [nobu121/dsh-opencode-session Issues](https://github.com/nobu121/dsh-opencode-session/issues).

---

## Stack & Target

- **Runtime Target:** Node 24+ (`>=24.0.0`, ES2024).
- **Language:** 100% TypeScript with strict typing.
- **Toolchain:** **Vite+** (`vp`) over tsdown, Vitest, Oxlint, and Oxfmt with [Ultracite](https://github.com/ultracite/ultracite).
- **Package Manager:** `pnpm`.

---

## Installation & Setup

### In DeepSeek Harness Profiles

1. **Link or install in your profile's `package.json`:**

   ```json
   {
     "dependencies": {
       "dsh-opencode": "link:../../../dev/dsh-opencode"
     },
     "dsh": {
       "profile": {
         "bundles": [
           "@deepseek-ai/dsh-base",
           "@deepseek-ai/dsh-web-app",
           "dsh-opencode"
         ]
       }
     }
   }
   ```

2. **Add to `cordis.patch.yml`:**

   ```yaml
   - insert:
       - id: opencode-go-session-header
         name: dsh-opencode
         config:
           providers: [opencode, opencode-go]
           mode: session-id
           debug: false
   ```

3. **Install with `pnpm`:**
   ```sh
   pnpm install
   ```

---

## Configuration

All configuration keys in `cordis.patch.yml` are optional:

| Option | Type | Default | Description |
| :-- | :-- | :-- | :-- |
| `providers` | `string[]` | `['opencode', 'opencode-go']` | Provider route keys to attach headers and patches to |
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
pnpm run build   # build library with tsdown (vp pack -> lib/index.mjs + lib/index.d.mts)
```

---

## License

[MIT](LICENSE) — Copyright (c) 2026 nobu121 & viztor.
