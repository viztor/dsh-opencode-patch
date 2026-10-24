---
tags:
  - dsh
  - plugin
  - opencode
  - cordis
status: note
aliases:
  - dsh-opencode-patch
---

# `dsh-opencode-patch` — working notes

What this repository is, the rules a change has to follow, and where things live. The user-facing side is the [README](./README.md); the design reasoning and protocol findings are in [docs/engineering-notes.md](./docs/engineering-notes.md); the protocol internals are in [docs/deep-dive.md](./docs/deep-dive.md) and [docs/protocol-routing-and-merge.md](./docs/protocol-routing-and-merge.md).

## HARD RULE: a local path never leaves the machine

An absolute path from a development machine (`/Users/<name>/…`, `/home/<name>/…`, `C:\Users\…`) must never appear anywhere a third party can read: documentation, code comments, examples, fixtures, commit messages, issue text, or a published artifact. It leaks a username, an operating system and a directory layout, and it is worthless to the reader anyway.

- Use a neutral placeholder in prose and examples — `/home/you/projects/my-app`, `~/dev/my-app`, or just the folder name.
- **Grep the artifact, not just the tree**, before publishing.
- Generated output counts: coverage reports, source maps and logs carry absolute paths, so they are gitignored, never committed.
- The check belongs **before** the commit. Once it ships, removing it means rewriting content _and_ history, force-pushing over every tag, and invalidating published provenance.

## HARD RULE: internal notes are private by default

A file's name does not decide whether it is public — its content does. Incident logs, machine-specific commands, credential-resolution details and per-project retrospectives belong outside the repository. This file is deliberately the _public_ half; nothing here should describe a particular machine, account or workflow.

## Rules a change must follow

- **Start from the host's built-ins.** Read `@deepseek-ai/dsh-client-ui-primitives` before writing any UI. It ships the components _and_ one CSS module each, which is the fastest inventory of the design language available. A component we hand-roll is one whose CSS module we never opened.
- **Declare cross-plugin services, and know how each access fails.** Measured against cordis: `ctx.get(name)` reads the scope's store and does **not** consult `inject`, so an undeclared service answers `undefined` silently; only property access (`ctx.name`) throws `cannot get property "name" without inject`. Capture an optional service through `ctx.inject([name], scope => …)`, which is a real child scope that can see it — and do **not** hand-roll a context wrapper to make one reachable: a copy that replaces `get` is not a cordis context, and passing it where the host's own context was expected takes the whole host down.
- **The `Tooltip` clones its child.** Wrap a DOM node, never a component, or the tooltip attaches handlers to something that ignores them and never appears.
- **One switch per surface.** A switch whose effect only exists inside another switch's surface is a state, not a decision.
- **Opt into the theme; do not re-declare it.** `data-menu-material="translucent"` and no hand-set stroke, so both themes stay right.
- **Verify the artifact, not the command's output.** A grep over a directory that does not exist is indistinguishable from a grep that found nothing; a cached registry read makes a completed operation look pending. Assert that the input was actually read, and include a case whose answer you already know.
- **A test for a behaviour must perform that behaviour.** Asserting a constant is not the same as exercising a switch.

## Repo map

Host bundle (`lib/index.mjs`), a thin `apply` barrel over small modules:

- `src/index.ts` · `src/identity.ts` · `src/lifecycle.ts` — the public barrel, the identity constants, and the `apply()` composition (one installer per side effect, in load-bearing order).
- `src/config.ts` · `src/config-values.ts` · `src/utils/guards.ts` — the schema and its defaults; dependency-free readers and type guards. The client bundle may import these, and it does — along with the contract and presentation modules (`usage-contract.ts`, `login-contract.ts`, `settings-copy.ts`, `settings-fields.ts`, `usage-ui.ts`, `go-limits.ts`). The rule is not a list of names: **the client may import a module that reaches nothing host-only** — no cordis context, no credential seam, no node built-in — and the bundle gate is what enforces it, by failing the build rather than by anyone remembering. An earlier version of this line named two files as the only ones allowed, which the tree had already outgrown.

## `src/utils/` — pure by construction, enforced by test

    src/utils/   a function of its arguments. No context, no globals, no I/O.
    src/         effects: read a context, ask a utility, cause something.

**The membership test for `utils/` is a property, not a vibe:** no `node:*`, no `@deepseek-ai/cordis`, no `process.env`, no `fetch`, no reference to `console` or a global timer (`setTimeout`/`setInterval`/`setImmediate` and their `clear*` counterparts, called or passed as a value, bare or through `globalThis.`/`window.`/`global.`/`self.`), no relative import that resolves outside the folder (`guards.ts` lives inside it). A utility that needs a clock or a logger takes it as a parameter, the way `utils/retry.ts` takes its `sleep` and `warn` and leaves the timer to the caller. `test/architecture.test.ts` walks the folder recursively, resolves each import from the importing file's own directory, and fails the build otherwise — verified by planting a violation of each kind and watching it fail.

It is the same trick `scripts/check.ts` already uses for the client bundle, at finer grain.

**Why `utils` and not `decisions`/`pure`/subject folders.** `utils` is the name a reader already has for these, and needs no glossary. What stops it becoming the usual dumping ground is the gate above: `fetch-patch.ts` is 498 lines and everything in it is _arguably_ a utility, and the gate says no because it reads a context. Subject folders (`gateway/`, `identity/`) describe what code is _about_, which is a real second axis — adopt it when a folder outgrows reading, not at 37 modules.

**The pattern that made things untestable, and the fix.** Every offender was a decision computed inline from whatever was in scope:

| cause                             | fix                                      |
| :-------------------------------- | :--------------------------------------- |
| not exported                      | export it                                |
| read a global (`process.env`)     | take the VALUE as a parameter            |
| took a transport type (`Headers`) | read at the edge, decide on values       |
| buried in a 600-line grab-bag     | give it a module named after its subject |

`session-id.ts` shows all four at once: `openCodeSessionIdFor` took a string and hashed it internally, so testing the _construction_ needed a crypto module. It now takes the digest (`deriveSessionId`), and `session.ts` — the effect half — computes it in one line. Same for the env: `pinnedSessionId` takes the value.

## What moved

| to `utils/`        | from                                              |
| :----------------- | :------------------------------------------------ |
| `request-shape.ts` | new (extracted in #74)                            |
| `guards.ts`        | `src/`                                            |
| `session-id.ts`    | the rules inside `session.ts`                     |
| `google-replay.ts` | `src/` (pure translation, so the gate polices it) |

- `src/session.ts` · `src/turn-store.ts` — the `ses_<12hex><14base62>` derivation and the `AsyncLocalStorage` turn store.
- `src/stream-hook.ts` · `src/fetch-patch.ts` · `src/tool-fallback.ts` — the `llm/stream` hook, the fetch interceptor, and the free-tier `read`/`bash` fallback.
- `src/utils/request-shape.ts` — the fetch patch's PURE decisions, extracted so each branch is unit-testable on its own: which plane a URL belongs to, which credential header a protocol reads, the URL and header source of a `fetch` input, the model id and tool names a JSON body carries, and the Anthropic version constant. Everything here is a function of its arguments — no context, no globals, no I/O. The rule it encodes: **a predicate that lives in a closure cannot be exercised alone**, so its branches survive until some integration path happens to take them. `hasSessionHeader` and `isOpenCodeRequest` were exported and tested; their six private siblings were not, and that was the difference.
- `src/key-capture.ts` · `src/go-discovery.ts` · `src/usage.ts` · `src/usage-contract.ts` — credential extraction, quota discovery, the usage service, and the shared shape.
- `src/catalog-data.ts` · `src/models-catalog.ts` · `src/models-discovery.ts` — the generated static shim, the OpenCode-catalog parser with SWR refresh, and discovery decoration. `catalog-data.ts` is **generated**; never hand-edit it.
- A note on the sweep that found the two entries around here, because it nearly produced a false one: grepping for a symbol's callers while EXCLUDING the file that defines it makes every same-file call look like no call at all. `resolveGoKeyForRef` reads as unreferenced that way and is not — `resolveGoApiKey` calls it, and the usage service calls that. (An earlier version of this line said that is "how the Go endpoint keeps Zen keys away from itself"; there is no such exclusion, and the note below records why.) Check the defining file too before believing an export is dead.

**The general form, because this shape recurred twice in one session**: a sweep that resolves a name in the wrong CONTEXT reports a clean tree as broken. Grepping for callers without the defining file makes same-file calls look absent; resolving a doc's relative links from the repository root instead of from the file's own directory makes every link look dead. Both produced a list of confident findings and both were entirely wrong. A third instance is reading a UTC timestamp as local time and concluding that a workflow had not run since the previous evening, when it had run twenty minutes earlier — same shape, wrong context, confident conclusion. Before acting on a sweep, check that the thing being searched is the thing the claim is about, including the clock it is written in.

- `src/go-limits.ts` — the allowance lookup, the label normalization and the money formatting. `allowanceFor` is the one lookup: `attachAllowance` in `usage.ts` calls it rather than inlining a second copy, which it used to.
- `src/go-limits-data.ts` — the Go plan allowances, per model and per tier, **generated** from the vendor's own page by `scripts/generate-go-limits.ts`; never hand-edit it, and regenerate with `pnpm run limits:shim -- --write`. The scheduled freshness job is what notices when the page moves, which it did: the docs went under `/v2/docs/console/` and serve HTML now, so the generator reads a table off that page rather than the markdown it used to.
- `src/responses-routes.ts` · `src/responses-provider.ts` — the protocol table and the in-process mount of the host's `llm-pi-ai`.
- `src/purge-service.ts` · `src/purge-contract.ts` — the card's "purge deprecated models" action, and the shape it answers with. It **rewrites the profile**, deleting the declared model entries the live catalog has retired, through `configEditor` (the same service the settings UI writes with). That is deliberate: a read-time filter would leave the declaration in place, and then the only way to explain a missing row is to find the filter. One source of truth, and it is the configuration.
- `src/session-cost.ts` · `src/cordis-context.ts` · `src/debug.ts` — per-turn accounting, the typed host interfaces, and stream debug logging.
- `src/pi-provider.ts` — the per-protocol base URLs, the pi model object, and the gateway headers. Every value here is measured; see `docs/redirect-planes.md`.
- `src/attachment-services.ts` — optional attachment and filesystem services for Google image requests, captured through Cordis child scopes.
- `src/google-bridge.ts` — the Google models, served through the plugin's own adapter on the real `llm` service. It is the ONLY module that imports pi at runtime, and its route is `opencode-google` so the `google` name stays free for a real deployment.
- `src/opencode-paths.ts` — where an OpenCode installation keeps its files, ported from `~/dev/opencode`'s `global-roots.ts` (the directory) and `database-path.ts` (the filename). It takes `home`, `env` and `channel` as parameters and reads neither the environment nor the filesystem, which is what makes the Windows and Linux layouts testable from here. Two facts it encodes that are easy to get wrong: the directory is XDG on EVERY platform — macOS and Windows use `~/.local/share` too, and `os.homedir()` is the only platform-dependent call — and the FILENAME is not constant, being `$OPENCODE_DB`, else `opencode.db` on a stable channel, else `opencode-<channel>.db`. The database sits under `data` while the config sits under `config`, so one root cannot serve both. It is the foundation of the opt-in reader: `go-discovery.ts`'s `resolveOpencodeStoreKey` is what imports it, and nothing else does.
- `src/opencode-store.ts` — reading the credentials an OpenCode installation already holds, through `node:sqlite`. Two rules shape it: nothing throws (a missing file, a foreign schema and `:memory:` all answer `undefined`), and a value never leaves the return value — no log line, no error message, no client bundle. `node:sqlite` is host-only, which is what keeps the module on the host side of the bundle rule. It is reached only through `resolveOpencodeStoreKey`, which is the last step of every key-source policy and is off unless `readOpencodeStore` is on. Its second reader, `inspectOpencodeStore`, answers the _other_ question — "is there a credential here, and whose is it?" — with a sanitized summary (email, org, kind, expiry) and never the token, which is what lets the settings card show the evidence beside the permission.
- `src/opencode-store-contract.ts` · `src/opencode-store-service.ts` — the inspection seam: the sanitized summary type both sides share, and the host service that produces it. The contract is pure data (no `node:`, no context), so the client bundle may import it; the service is the half that touches `node:sqlite` and the filesystem, and it rewrites the store path to `~`-relative before answering — a home directory is a fact about the machine, not about the plugin. `inspect` is declared through the `Object.defineProperty` marker rather than `@Remote`, for the reason `usage.ts` documents.
- A timing dependency every remote shares, worth knowing before debugging a row that will not appear: the mount is an async `$mount` started in an effect, and the card reads `ctx.remote.<namespace>` SYNCHRONOUSLY when its injector builds the props. If the injector runs before the mount resolves, the service is not there yet and the surface renders nothing. More often the cause is a namespace with no client descriptor at all — the purge row and the store-inspection row each shipped that way — which `test/remote-contract.test.ts` now catches per method. Each caller reports an empty lookup (`no opencodeStore service on the remote`), so the symptom is a console line rather than a blank.
- **Sign-in is not in this build.** An earlier line of work carried a Console device-flow login (`console-auth`, `token-store`, `login-*`, `org-cache`, `settings-login`); main carries the API-key path only, and the login is v2 work. The settings copy still holds its strings, and `credentialOrg` is the one remnant with behaviour: a configured org is sent as `x-opencode-org-id`.

Web client bundle (`lib/client.js`): `src/settings-page.tsx` (entry, wiring only), the `settings-*` card and its controls — including the store-inspection row, `src/settings-store-inspect.tsx` — and the meter — `src/usage-pill.tsx` (state), `src/usage-panel.tsx` (pure views), `src/usage-ui.ts` (logic and stylesheet). `test/architecture.test.ts` walks this graph from the entry and fails on a node built-in, the cordis runtime, pi, or `process.env`.

## Commands

```sh
vp test run            # unit suite (refuses to start below engines.node)
pnpm run test:shuffle  # the unit suite in random order; CI runs it on Node 24
pnpm run test:mock     # gateway mock suite: offline, no key, runs in CI
vp test run --coverage # with the coverage ratchet (95/90/93/95)
vp check               # format, lint, types
vp fmt --write         # rewrite formatting
pnpm run build         # build lib/ (host bundle + client bundle)
# `vp pack` alone is NOT enough: it emits lib/client.cjs for a type:module
# package, and the web client loader serves `${package}/client.js` and requires
# the .js extension. `pnpm run build` is `vp pack` plus the rename that fixes it.
node --experimental-strip-types scripts/check.ts   # bundle gate
```

`lib/` is built output and is not committed; the host loads `lib/index.mjs`, so a source change is not deployed until `pnpm run build` runs — and, as above, not until the process restarts.

**And the process has to restart, not just the page.** The host bundle is read once at process start — a deployment installs this package through a `link:`, so there is nothing to reinstall and nothing to notice a newer file. A browser reload picks up `lib/client.js` and keeps running the `lib/index.mjs` the process started with, which makes a client-side fix look like it did nothing and a host-side diagnostic look like it never ran. Measured the hard way: a running host was two and a half hours and eleven commits behind its own build, and every "it still does not work" in between was answered by a file that was never loaded.

## A known local-only failure in the bundle gate

`scripts/check.ts` ends with a consumer install, and it can fail with `ETARGET: No matching version found for @aws-sdk/nested-clients@^3.997.48` on a machine where the registry has only `3.997.46` and `3.997.47`. The chain is ours only by accident: `@earendil-works/pi-ai` → `@aws-sdk/client-bedrock-runtime` → `@aws-sdk/credential-provider-node` → `nested-clients`, and the lockfile pins `3.997.46`, which exists. It is npm resolving a caret range to a version that has not been published, not anything this repository wrote — CI passes on the same commit. Re-run when the registry catches up; do not "fix" it by loosening the lockfile.

## Releasing

Releases are cut by release-please from Conventional Commit subjects, and published to npm by `.github/workflows/release.yml` through OIDC trusted publishing (no stored token). **`CHANGELOG.md` is owned by release-please — never hand-edit it**; clarity comes from commit subjects and the `changelog-sections` mapping in the release-please workflow.

**Let release-please drive the release.** Its version anchor is the latest GitHub **Release**, not the latest tag, so a manual cut (`npm version` + `git tag` + push) creates a tag it cannot see. It then keeps computing from the last release it knows: it re-proposes a version that is already published, that pull request _regresses_ `package.json`, and its next run fails with `already_exists` when it tries to create the release a second time. If a manual cut is ever necessary, create the GitHub Release as part of it (`gh release create <tag> --generate-notes`).

## Merging: squash

Pull requests are merged with **squash**, so one pull request is one commit on `main`.

The reason is the changelog, and it is mechanical rather than stylistic: release-please resolves a **merge commit** to the _pull request's title_, so under a merge-commit history every pull request appears in `CHANGELOG.md` once for its title and once for each commit inside it. The 1.4.0 notes listed nine entries for four changes, and a reader cannot tell a real second change from a repeated one. A squashed commit carries the pull request's title and nothing else, so each change is exactly one line.

**The pull request's title is therefore the release signal**, and it must be a Conventional Commit — `feat:`, `fix:`, `chore:` — because the version bump and the changelog section are read from it. The commits inside the branch keep their own subjects, which is where the detail lives for the review; they do not reach the changelog.
