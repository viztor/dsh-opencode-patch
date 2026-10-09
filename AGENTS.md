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
- **Declare cross-plugin services.** `ctx.inject(['slots', 'modelDirectories'], scope => …)` — reading them off the root context fails silently, because every access in that path is optional.
- **The `Tooltip` clones its child.** Wrap a DOM node, never a component, or the tooltip attaches handlers to something that ignores them and never appears.
- **One switch per surface.** A switch whose effect only exists inside another switch's surface is a state, not a decision.
- **Opt into the theme; do not re-declare it.** `data-menu-material="translucent"` and no hand-set stroke, so both themes stay right.
- **Verify the artifact, not the command's output.** A grep over a directory that does not exist is indistinguishable from a grep that found nothing; a cached registry read makes a completed operation look pending. Assert that the input was actually read, and include a case whose answer you already know.
- **A test for a behaviour must perform that behaviour.** Asserting a constant is not the same as exercising a switch.

## Repo map

Host bundle (`lib/index.mjs`), a thin `apply` barrel over small modules:

- `src/index.ts` · `src/identity.ts` · `src/lifecycle.ts` — the public barrel, the identity constants, and the `apply()` composition (one installer per side effect, in load-bearing order).
- `src/config.ts` · `src/config-values.ts` · `src/guards.ts` — the schema and its defaults; dependency-free readers and type guards. `config-values.ts` and `guards.ts` are the **only** host modules the client bundle may import.
- `src/session.ts` · `src/turn-store.ts` — the `ses_<12hex><14base62>` derivation and the `AsyncLocalStorage` turn store.
- `src/stream-hook.ts` · `src/fetch-patch.ts` · `src/tool-fallback.ts` — the `llm/stream` hook, the fetch interceptor, and the free-tier `read`/`bash` fallback.
- `src/key-capture.ts` · `src/go-discovery.ts` · `src/usage.ts` · `src/usage-contract.ts` — credential extraction, quota discovery, the usage service, and the shared shape.
- `src/catalog-data.ts` · `src/models-catalog.ts` · `src/models-discovery.ts` — the generated static shim, the `models.dev` parser with SWR refresh, and discovery decoration. `catalog-data.ts` is **generated**; never hand-edit it.
- `src/responses-routes.ts` · `src/responses-provider.ts` — the protocol table and the in-process mount of the host's `llm-pi-ai`.
- `src/session-cost.ts` · `src/cordis-context.ts` · `src/debug.ts` — per-turn accounting, the typed host interfaces, and stream debug logging.

Web client bundle (`lib/client.js`): `src/settings-page.tsx` (entry, wiring only), the `settings-*` card and its controls, and the meter — `src/usage-pill.tsx` (state), `src/usage-panel.tsx` (pure views), `src/usage-ui.ts` (logic and stylesheet).

## Commands

```sh
vp test run            # unit suite
vp test run --coverage # with the coverage ratchet (95/90/93/95)
vp check               # format, lint, types
vp fmt --write         # rewrite formatting
vp pack                # build lib/ (host bundle + client bundle)
node --experimental-strip-types scripts/check.ts   # bundle gate
```

`lib/` is built output and is not committed; the host loads `lib/index.mjs`, so a source change is not deployed until `vp pack` runs.

## Releasing

Releases are cut by release-please from Conventional Commit subjects, and published to npm by `.github/workflows/release.yml` through OIDC trusted publishing (no stored token). **`CHANGELOG.md` is owned by release-please — never hand-edit it**; clarity comes from commit subjects and the `changelog-sections` mapping in the release-please workflow.

**Let release-please drive the release.** Its version anchor is the latest GitHub **Release**, not the latest tag, so a manual cut (`npm version` + `git tag` + push) creates a tag it cannot see. It then keeps computing from the last release it knows: it re-proposes a version that is already published, that pull request _regresses_ `package.json`, and its next run fails with `already_exists` when it tries to create the release a second time. If a manual cut is ever necessary, create the GitHub Release as part of it (`gh release create <tag> --generate-notes`).
