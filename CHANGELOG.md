# Changelog

All notable changes to `dsh-opencode` are documented in this file.

This project is an evolution of [**`nobu121/dsh-opencode-session`**](https://github.com/nobu121/dsh-opencode-session) by [@nobu121](https://github.com/nobu121).

---

## [0.12.0](https://github.com/viztor/dsh-opencode-patch/compare/v0.11.0...v0.12.0) (2026-10-03)


### Features

* auto-enrich gateway /models responses with canonical 33-model catalog ([2f9e9e7](https://github.com/viztor/dsh-opencode-patch/commit/2f9e9e7e0f6e7cfb344044c20ec19d55896d5e32))
* dual-catalog SWR updates (Go + Zen free models) and routed key resolution ([4124479](https://github.com/viztor/dsh-opencode-patch/commit/41244790fe63f1497f58f3b36f82803cd7e780fb))
* dynamically attribute x-opencode-project to workspace directory ([9adfb9a](https://github.com/viztor/dsh-opencode-patch/commit/9adfb9a0837f40bc8b3edf23b3d2669eee71c9c6))
* inject x-session-affinity and x-parent-session-id for proxy and gateway compatibility ([9883251](https://github.com/viztor/dsh-opencode-patch/commit/9883251e5188412731858b7bc46d5876cc35088b))
* make quota meter provider-based, remove UI debug fields, and enhance provider discovery ([979e9ed](https://github.com/viztor/dsh-opencode-patch/commit/979e9ed4e438a645c7d08f19fe92811e18842a0b))
* real-time Stale-While-Revalidate (SWR) model catalog updating with local shim ([19fe3e1](https://github.com/viztor/dsh-opencode-patch/commit/19fe3e173a05903bb14099d0245967c3576d4c57))
* refine Go and Zen usage display and attach available Zen credit ([4e2c01d](https://github.com/viztor/dsh-opencode-patch/commit/4e2c01d56959319c0445abef741d837eb9414120))
* replace boolean text inputs with Switch toggles in settings card ([857b4d7](https://github.com/viztor/dsh-opencode-patch/commit/857b4d7e86b458b26edbd2c4e4a7bbe38c06b5bf))
* replace originProject text override with natural language injectProject toggle ([b34fabe](https://github.com/viztor/dsh-opencode-patch/commit/b34fabe87c02a3906a9599233c2958c52ab63e5a))
* session spend tracking, catalog/price toggles, and split test suite ([a5fa579](https://github.com/viztor/dsh-opencode-patch/commit/a5fa579289659f888e1ef0d94a51aa8f87bc4030))
* support x-opencode-parent-session-id for DSH subagents and child sessions ([58354e4](https://github.com/viztor/dsh-opencode-patch/commit/58354e498a80ac843e1d9bfe607f0f6a71f8a993))


### Bug Fixes

* apply request patch to auto-review calls and inject session-id headers ([b6e492a](https://github.com/viztor/dsh-opencode-patch/commit/b6e492a077f3c6adc55dd079b03593faf8fb7bd5))
* isolate Go usage queries to Go keys and ignore Zen keys for quota endpoint ([cfecac0](https://github.com/viztor/dsh-opencode-patch/commit/cfecac03091638fc6d33eacf982a7e7e351503c1))
* keep deprecated models out of the refresh, and correct the README model lists ([5ca3c4f](https://github.com/viztor/dsh-opencode-patch/commit/5ca3c4f6933d983d15df63f2c96393c073cf1b16))
* remove default export so cordis unwrapExports exposes Config ([80c7af1](https://github.com/viztor/dsh-opencode-patch/commit/80c7af152ff37f9d8de8b54e6e39135f0dbfa9a0))
* scope the spend reading to the conversation and route that asked for it ([dc5e1b1](https://github.com/viztor/dsh-opencode-patch/commit/dc5e1b129e6354674b26dfb8fecd9f2174e0e250))
* ship only active catalog models with rates, and cover the new surface ([73a9d0f](https://github.com/viztor/dsh-opencode-patch/commit/73a9d0f53ac9022bc5911312666ec29d3b3a6a16))

## [0.11.0](https://github.com/viztor/dsh-opencode-patch/compare/v0.10.1...v0.11.0) (2026-10-02)


### Features

* make gateway, origin, session, and quota-meter behavior configurable ([6937f56](https://github.com/viztor/dsh-opencode-patch/commit/6937f56eef9651fd92a46ea7037b13735988f520))

## [0.10.1](https://github.com/viztor/dsh-opencode-patch/compare/v0.10.0...v0.10.1) (2026-10-02)


### Bug Fixes

* **settings:** export volatile Config schema and decouple bundle slot registration ([41db32b](https://github.com/viztor/dsh-opencode-patch/commit/41db32b8edacb9726a157200fc2e9f7a5dab8ab0))

## [0.10.0](https://github.com/viztor/dsh-opencode-patch/compare/v0.9.2...v0.10.0) (2026-10-01)


### Features

* link the console, and document why balance cannot be shown ([e5a3684](https://github.com/viztor/dsh-opencode-patch/commit/e5a3684ed8e9eb238eef7c44c80f8ca1f5b4213f))

## [0.9.2](https://github.com/viztor/dsh-opencode-patch/compare/v0.9.1...v0.9.2) (2026-10-01)


### Bug Fixes

* draw the quota meter once, and only when Go is configured ([215149e](https://github.com/viztor/dsh-opencode-patch/commit/215149e968354930972706ccd8d6e0999a3bdf0d))
* publish safely, thin the wrapper's client half, and ship plugin metadata ([0c95202](https://github.com/viztor/dsh-opencode-patch/commit/0c95202c6aa5fd8dfdd30a3ae812fbc24484c1b6))

## [0.9.1](https://github.com/viztor/dsh-opencode-patch/compare/v0.9.0...v0.9.1) (2026-10-01)


### Bug Fixes

* add publish error recovery and non-blocking scoped publishing ([4baea6f](https://github.com/viztor/dsh-opencode-patch/commit/4baea6fc737ae046fa33c5e8840ca8eeeb35c7fe))
* rewrite cordis.patch.yml name for scoped package ([a164f98](https://github.com/viztor/dsh-opencode-patch/commit/a164f9845348bbdd2371971168f2371b808972e2))

## [0.9.0](https://github.com/viztor/dsh-opencode-patch/compare/v0.8.0...v0.9.0) (2026-10-01)


### Features

* expose usage monitor settings in Web UI and mount in composer dock ([9a28f25](https://github.com/viztor/dsh-opencode-patch/commit/9a28f25e121ed08d831e70e48f0558091c185162))

## [0.8.0](https://github.com/viztor/dsh-opencode-patch/compare/v0.7.0...v0.8.0) (2026-10-01)


### Features

* implement thin wrapper pattern for legacy @viztor/dsh-opencode package ([8ad0d94](https://github.com/viztor/dsh-opencode-patch/commit/8ad0d94c6097904380dc85a7411d9b51ed0e84db))

## [0.7.0](https://github.com/viztor/dsh-opencode-patch/compare/v0.6.0...v0.7.0) (2026-10-01)


### Features

* add manifest deprecation, redirect README, and runtime notice for legacy package ([f2b779a](https://github.com/viztor/dsh-opencode-patch/commit/f2b779a7ffbb2a87bd89a651b2d41d575a30ef62))
* alias legacy dsh-opencode across loader, settings, and publishing ([c344067](https://github.com/viztor/dsh-opencode-patch/commit/c3440672cde3072ff74321e4cb64a8cb365b3a1b))
* auto-discover opencode-go apiKeyEnv, apiKey, and baseURL from user config ([5e4b169](https://github.com/viztor/dsh-opencode-patch/commit/5e4b1695bca6eca60323bec451038ecae6bd9c7c))
* render circular meter trigger and rich hover modal for quota breakdown ([b3f74a4](https://github.com/viztor/dsh-opencode-patch/commit/b3f74a4a35452b2ad260fba3416efb91fdfa5703))

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
