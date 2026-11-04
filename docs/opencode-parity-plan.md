# OpenCode Implementation Parity & Architecture Specification

This document defines the complete architectural parity plan between `dsh-opencode-patch` and the official OpenCode CLI engine (`opencode`). It details how the DeepSeek Harness (DSH) integration achieves full protocol, credential, session, and catalog fidelity, and establishes the contracts for data model separation and domain boundaries.

---

## 1. Executive Summary & Purpose

The objective of `dsh-opencode-patch` is to make DeepSeek Harness a native, first-class runtime host for OpenCode models across both gateway planes:

1. **The Zen Plane (`opencode`)**: The flagship and pay-as-you-go plane (`https://opencode.ai/zen/v1` and `https://opencode.ai/inference/openai/v1`).
2. **The Go Plane (`opencode-go`)**: The subscription quota plane (`https://opencode.ai/zen/go/v1` and `https://opencode.ai/inference/go/openai/v1`).

Because DeepSeek Harness's native LLM subsystem (`@deepseek-ai/dsh-llm-pi-ai`) enforces one wire protocol per route and expects a standard OpenAI Chat Completions dialect, it cannot natively handle OpenCode's multi-protocol routing, session cache affinity, or subscription quota monitoring. `dsh-opencode-patch` bridges this gap transparently in memory without requiring user-side proxy configuration or changes to DSH core.

---

## 2. Six-Domain Parity Matrix

The table below outlines OpenCode's native features and the corresponding implementation in `dsh-opencode-patch`:

| Feature Domain | Official OpenCode Implementation (`opencode`) | `dsh-opencode-patch` Implementation | Status |
| :-- | :-- | :-- | :-- |
| **1. Model Catalog Ingestion** | Ingests `https://models.opencode.ai/api.json` with bundled `snapshot.txt` fallback | `MODELS_OPENCODE_URL = "https://models.opencode.ai/api.json"` with SWR revalidation and bundled static shim `src/catalog-data.ts` | **Full Parity** |
| **2. Gateway `/models` Emulation** | Does not call `/models`; uses internal catalog dictionary directly | Intercepts `GET .../models` via `fetchPatch`, overlays real context limits, token caps, and modalities via `enrichModelsResponse` | **Full Parity** |
| **3. Multi-Protocol Wire Routing** | Dispatches via `@ai-sdk/openai`, `@ai-sdk/anthropic`, `@ai-sdk/google` per model | `internalRouteFor` inspects model ID & SDK, redirecting via mounted child adapters (`opencode-responses`, `opencode-anthropic`, `opencode-google`) | **Full Parity** |
| **4. Cross-Plane Model Resolution** | Selects plane based on account subscription and model ID prefix | Cross-plane fallback: routes Go-specific models (e.g. `muse-spark-1.3-contributor`) to `opencode-go-responses` automatically | **Full Parity** |
| **5. Session Cache Affinity** | Attaches `x-opencode-session-id` and `x-opencode-session` (v1.19.5 parity) | Generates `ses_<12hex><14base62>`, injects unified session and affinity headers, supports subagent parent session tracking | **Full Parity** |
| **6. Client & Project Attribution** | Sends `User-Agent: opencode/1.19.5 (...)`, `x-opencode-client`, `x-opencode-project` | `fetchPatch` injects standard CLI User-Agent, `x-opencode-client: cli`, and workspace folder name | **Full Parity** |
| **7. Credential Precedence Ladder** | Request Key → Declared Env → OAuth Token → Local SQLite Store (`opencode.db`) | Request Key → Captured Key → Env (`OPENCODE_API_KEY`/`OPENCODE_GO_API_KEY`) → OAuth Token Store → Local SQLite (`opencode-store.ts`) | **Full Parity** |
| **8. Console OAuth Device Flow** | Device flow via `/auth/device/code`, `/auth/device/token`, `/api/user`, `/api/orgs` | Implemented via `console-auth.ts`, `login-flow.ts`, and atomic `token-store.ts` with auto-polling and rate-limit handling | **Full Parity** |
| **9. Organization Scoping** | Sends `x-org-id: wrk_...` for Console tokens; omits for static API keys | Attaches `x-opencode-org-id` exclusively for OAuth grants; strictly omitted for static keys | **Full Parity** |
| **10. Free-Tier Model Handling** | Sets `apiKey: "public"`, disables paid models, injects core tool schemas | Injects `maybeInjectCoreTools` (`read`, `bash`) into free-tier Responses models (`muse-spark-*-free`); detects `is_free` | **Full Parity** |
| **11. Quota & Spending Tracking** | Tracks monthly subscription balance & per-token usage | Exposes `GoUsageService`, computes turn spend from catalog rates, renders real-time composer pill and usage card | **Full Parity** |
| **12. Context Window Tuning** | Reads `limit.context` per model; allows client-level constraints | Non-destructive context merging, `resolveEffectiveContextWindow` engine, and deployment ceiling knob `maxContextWindow` | **Full Parity** |

---

## 3. Data Model Architecture & Separation of Concerns

To maintain long-term stability and prevent regressions, the codebase enforces strict separation of concerns across five architectural layers:

```
┌────────────────────────────────────────────────────────────────────────┐
│ 1. Domain Models (Pure Types & Constants)                              │
│    • src/config-values.ts: Pure coercion readers & constants           │
│    • src/usage-contract.ts: Quota reading envelopes & status enums     │
│    • src/login-contract.ts: OAuth grant records & service codecs       │
│    • src/catalog-data.ts: Static catalog schema definitions            │
│    (Zero dependencies, shared safely across Host and Web Client)       │
└────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│ 2. Core Business Logic (Side-Effect Free)                              │
│    • src/models-catalog.ts: SWR catalog parser & schema normalizer     │
│    • src/responses-routes.ts: SDK protocol mapping & routing table     │
│    • src/go-limits.ts: Plan allowance calculation & string formatting  │
│    • src/session.ts: Session ID derivation & regex validation          │
│    • src/key-capture.ts: Credential classification & tier detection    │
└────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│ 3. State & Persistence Subsystem (Host-Isolated)                       │
│    • src/turn-store.ts: AsyncLocalStorage for active turn attribution  │
│    • src/token-store.ts: Atomic JSON store for OAuth credentials       │
│    • src/opencode-store.ts: Read-only SQLite query engine (node:sqlite)│
└────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│ 4. Protocol Transports & Gateway Emulation                             │
│    • src/fetch-patch.ts: Global fetch interceptor & header injection   │
│    • src/stream-hook.ts: DSH llm/stream hook & route interceptor       │
│    • src/responses-provider.ts: In-process PiAiAdapter mounting        │
│    • src/google-bridge.ts: Google Generative AI SSE streaming bridge   │
│    • src/lifecycle.ts: Cordis plugin lifecycle & service registration  │
└────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│ 5. Presentation & UI Layer (Web Client Bundle)                         │
│    • src/settings-page.tsx: Settings card entry & remote RPC binding   │
│    • src/settings-login.tsx: OAuth sign-in / sign-out component        │
│    • src/settings-usage.tsx: Quota inspector container                 │
│    • src/usage-pill.tsx: Composer dock live quota badge                │
│    • src/usage-panel.tsx: Quota breakdown popover & pricing views      │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 4. Key Architectural Invariants

### Invariant 1: The Client Bundle Boundary

The Web Client bundle (`lib/client.js`) is loaded inside the user's browser. It must never import Node.js built-ins (`node:fs`, `node:sqlite`, `node:async_hooks`), Cordis context instances, or secret storage logic. This invariant is continuously verified by `scripts/check.ts` and `test/client-bundle.test.ts`.

### Invariant 2: The Hard Rule on Local Machine Paths

No machine-specific absolute path (e.g. `/Users/<name>/...` or `/home/you/...`) may ever appear in code comments, test fixtures, documentation, or compiled bundles. All paths must use relative paths, environment-based root resolution, or neutral placeholders (`~/dev/app`). Enforced by `test/no-local-paths.test.ts`.

### Invariant 3: Single Source of Truth for Routing

Wire protocol routing must be driven strictly by the metadata supplied in OpenCode's canonical catalog (`provider.npm` and `model.id`). Hand-written model ID routing lists are strictly prohibited to prevent routing drift when OpenCode releases new models.

### Invariant 4: Non-Destructive Model & Context Decoration

When `decorateModelInfo` or `decoratePlaneAdapters` enriches a model:

1. It must never wipe out existing context metadata.
2. It must calculate the effective context window using `resolveEffectiveContextWindow(canonical, requested, ceiling)`.
3. It must respect user-configured deployment ceilings (`config.maxContextWindow`) while preventing requests from exceeding physical model hardware limits.

---

## 5. Verification & Quality Assurance Strategy

Full implementation parity is locked by a multi-layered automated test matrix:

1. **Unit & Integration Suites (`test/*.test.ts`)**:
   - Cover every configuration reader, session derivation, catalog parser, routing table and UI state machine. The count is deliberately not written here: a number in prose does not regenerate with the suite it counts, and this file already carried a stale one.
   - Fast-executing, isolated in-memory test workers.
2. **Gateway Contract Mock Suites (`test/mock/*.mock.ts`)**:
   - Strict HTTP wire contract tests verifying byte-level header injection, SSE chunk streaming, and 401/403/429/502 error emulation.
3. **Coverage Ratchet Enforcement**:
   - Coverage thresholds are enforced on every build:
     - **Statements**: >= 94.5%
     - **Branches**: >= 89.9%
     - **Functions**: >= 92.9%
     - **Lines**: >= 94.5%
4. **Bundle Gate & Hard Rule Check**:
   - `test/no-local-paths.test.ts` scans the entire repository and built artifacts for path leakage.
   - `scripts/check.ts` validates that `lib/client.js` is clean and free of server-side leakage.
