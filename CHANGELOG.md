# Changelog

All notable changes to `dsh-opencode` are documented in this file.

This project is an evolution of [**`nobu121/dsh-opencode-session`**](https://github.com/nobu121/dsh-opencode-session) by [@nobu121](https://github.com/nobu121).

---

## [0.6.0](https://github.com/viztor/dsh-opencode-patch/compare/v0.5.1...v0.6.0) (2026-10-01)


### Features

* rename to dsh-opencode-patch and add live OpenCode Go quota pill ([e3eb48d](https://github.com/viztor/dsh-opencode-patch/commit/e3eb48d5b716bfa7fd8184ead823232a8ce4aa01))
* restyle the icon into the Harness icon family ([eeb1fd8](https://github.com/viztor/dsh-opencode-patch/commit/eeb1fd8a21babdb273969cf82e9f91db0a1a380a))

## [0.5.1](https://github.com/viztor/dsh-opencode/compare/v0.5.0...v0.5.1) (2026-10-01)


### Bug Fixes

* remove session mode option, always derive gateway IDs ([5ef6fca](https://github.com/viztor/dsh-opencode/commit/5ef6fca60cefda0c768059d73185d44f24d404dd))

## [0.5.0](https://github.com/viztor/dsh-opencode/compare/v0.4.0...v0.5.0) (2026-09-30)


### Features

* complete settings UI coverage and drop session cache table ([7ac8b3c](https://github.com/viztor/dsh-opencode/commit/7ac8b3c2cf32148d80a593d638489432ca931249))

## [0.4.0](https://github.com/viztor/dsh-opencode/compare/v0.3.4...v0.4.0) (2026-09-30)


### Features

* bundle icon for plugin display surfaces ([9882c0e](https://github.com/viztor/dsh-opencode/commit/9882c0edf03665d753f783ac2a47c303c40f030b))

## [0.3.4](https://github.com/viztor/dsh-opencode/compare/v0.3.3...v0.3.4) (2026-09-30)


### Bug Fixes

* register client bundle under npm package name ([d052c84](https://github.com/viztor/dsh-opencode/commit/d052c84f840c6af662deede084439cc699a1058b))

## [0.3.3](https://github.com/viztor/dsh-opencode/compare/v0.3.2...v0.3.3) (2026-09-30)


### Bug Fixes

* cordis row name must equal npm package name ([4907117](https://github.com/viztor/dsh-opencode/commit/49071171703f0a7e025beb5319b6ebac37077240))

## [0.3.2](https://github.com/viztor/dsh-opencode/compare/v0.3.1...v0.3.2) (2026-09-30)


### Bug Fixes

* register settings card on plugins.bundle.config keyed by package name ([9409a30](https://github.com/viztor/dsh-opencode/commit/9409a30917f3408f345a260375396d95182426fb))

## [0.3.1](https://github.com/viztor/dsh-opencode/compare/v0.3.0...v0.3.1) (2026-09-30)


### Bug Fixes

* surface effective defaults in settings UI labels and hints ([76d768d](https://github.com/viztor/dsh-opencode/commit/76d768d2755ce24c8367e6103f05d067bc3f4c43))

## [0.3.0](https://github.com/viztor/dsh-opencode/compare/v0.2.1...v0.3.0) (2026-09-30)


### Features

* auto releases, GitHub Packages mirror, and verified-compat docs ([e42b427](https://github.com/viztor/dsh-opencode/commit/e42b427365c63a35c5ed1c419c71a55d76c3b72f))

## [0.2.1] - 2026-10-01

### Changed

- **Published to npm as `@viztor/dsh-opencode`** (unscoped name is squatted; scopes need no org).
- **OIDC trusted publishing**: tag-triggered `release` workflow publishes with provenance, no tokens.
- **Continuous integration**: `ci.yml` runs check + tests + build on every push to `main` and every PR.
- **Docs restructure**: consumer-friendly README titled "OpenCode on DeepSeek Harness" with badges and troubleshooting; contributor guide split into `CONTRIBUTING.md`; project-specific `AGENTS.md`.

### Fixed

- Debug-file race in the session-affinity test: waits for the expected line count instead of first non-empty read.

---

## [0.2.0] - 2026-10-01

### Added

- **OpenCode Zen Free-Tier Gateway Support (`403 FreeTierError` fix)**:
  - OpenCode's gateway (`https://opencode.ai/zen/v1`) enforces client origin and tool validation on free community models (such as `muse-spark-1.3-contributor-free` and `space-bunny-free`).
  - DSH's internal LLM adapter (`dsh-llm-pi-ai`) classifies `user-agent` as a reserved header and strips it from outgoing requests.
  - `dsh-opencode` restores `User-Agent: opencode/1.18.33 ...`, `x-opencode-client: cli`, and `x-opencode-project: global` at the network fetch layer.
- **Configurable Header Controls & User-Agent Override**:
  - `injectUserAgent` (boolean, default `true`): Toggle User-Agent restoration on/off.
  - `userAgent` (string, default empty): Allows specifying a custom User-Agent override string. When left empty, uses the canonical OpenCode CLI User-Agent.
  - `injectOriginHeaders` (boolean, default `true`): Toggle injection of `x-opencode-client: cli` and `x-opencode-project: global`.
  - `injectCoreTools` (boolean, default `true`): Toggle fallback injection of standard `read` (`filePath`) and `bash` (`command`) tool schemas on free-tier `/responses` requests when tools are empty.
- **Strict Request Differentiation**:
  - Differentiates OpenCode API requests (`opencode.ai/zen` and configured provider routes) from all other network traffic.
  - Non-OpenCode requests (e.g. `api.deepseek.com`, Anthropic, OpenAI, GitHub, arbitrary tool calls) pass through completely untouched.
- **Deterministic Session ID Hashing**:
  - OpenCode Zen's gateway requires session IDs matching `^ses_[0-9a-f]{12}[A-Za-z0-9]{14}$` (30 characters).
  - Raw DSH conversation UUIDs are deterministically hashed via SHA-256 into compliant `ses_...` IDs, preserving conversation turn affinity and prompt cache warmth without triggering gateway format validation errors.
- **DSH Web Client Settings UI (`src/settings-page.tsx`)**:
  - Ships a client bundle (`lib/client.js`) registering an OpenCode configuration card under **DSH Settings -> Plugins**.
  - Provides reactive UI controls for toggling User-Agent injection, editing User-Agent overrides, toggling origin headers, and managing provider lists.
  - Full English (`en`) and Simplified Chinese (`zh`) localization.
- **100% TypeScript & Node 24+ Target**:
  - Re-implemented the entire codebase in strict TypeScript (`src/index.ts`, `src/settings-page.tsx`, `test/plugin.test.ts`, `scripts/name-client-bundle.ts`).
  - Runtime targeted to **Node 24+** (`engines: { node: ">=24" }`, `target: "node24"`, `ES2024`).
- **Vite+ (`vp`) Toolchain Integration**:
  - Dual library bundling with tsdown (`vp pack`): Host ESM bundle + DTS emit (`lib/index.mjs`, `lib/index.d.mts`) and browser client bundle (`lib/client.js`).
  - Oxlint linting extending Ultracite (`vp lint`).
  - Oxfmt formatting (`vp fmt`).
  - Parallel Vitest testing suite (`vp test`).
- **Comprehensive Unit Testing**:
  - 44 deterministic tests covering hashing, config, session caching, stream context, request differentiation, header injection, tool injection, and plugin lifecycle.
- **Proper Attribution & MIT Licensing**:
  - Dual copyright attribution acknowledging original author `@nobu121` and maintainer `@viztor`.

### Changed

- Renamed package to `dsh-opencode` to reflect full OpenCode platform integration beyond session headers.
- Safe environment fallback: `OPENCODE_SESSION_ID` can be supplied via environment; never hardcodes private session IDs in source or git history.

---

## Upstream Comparison (vs `nobu121/dsh-opencode-session` v0.1.1)

| Capability | Upstream (`v0.1.1`) | `dsh-opencode` (`v0.2.0`) |
| :-- | :-- | :-- |
| **Primary Goal** | Fix `400 MissingSessionID` on OpenCode Go | Fix `400 MissingSessionID` + `403 FreeTierError` on OpenCode Zen |
| **Header Injection** | `x-opencode-session` only | `x-opencode-session`, `User-Agent`, `x-opencode-client`, `x-opencode-project` |
| **Session ID Format** | Raw DSH UUID (triggers 403 on Zen) | Deterministic SHA-256 mapping to `ses_<hex12><base62>` |
| **User-Agent Handling** | None (stripped by DSH adapter) | Restored & configurable with custom override |
| **Free-Tier Gateway Tools** | None | Fallback injection of `read` & `bash` schemas |
| **Request Differentiation** | Provider filter on `llm/stream` | Provider filter + URL validation guard in `patchFetch` |
| **Settings UI** | None | DSH Web Client Settings Card (`src/settings-page.tsx`) |
| **Language** | Plain JavaScript (untyped `.js` / `.mjs`) | 100% Strict TypeScript |
| **Runtime Target** | Node 20+ | Node 24+ (`ES2024`) |
| **Toolchain** | Bare Node scripts | Vite+ (`vp pack`, `vp check`, `vp test`, Oxlint, Oxfmt) |
