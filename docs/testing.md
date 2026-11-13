# The test system

Seven layers, each answering a question the others cannot. What follows is the map, the rule that decides which layer a new case belongs to, how the suite is laid out, and the two habits that keep the layers honest. The real-host harness and the `e2e-host` job are described in full in [CONTRIBUTING](../CONTRIBUTING.md#the-real-host-harness); this page places them.

## The layers

| command | layer | what it proves | network |
| :-- | :-- | :-- | :-- |
| `vp test run` | unit | one module's decisions, with its inputs constructed | no |
| `vp test run` (the files that mount `mountTierA` or `bootTierB` from `test/support/host.ts`: the `host-*` contract, planes, discovery and characterization files, `patch-method`, `reload`) | real host, in-process | the plugin on the host's own `llm` service and `llm-pi-ai`: tier A (`mountTierA`, a bare cordis `Context`) and tier B (`bootTierB`, dsh-app-boot's own boot) | no |
| `pnpm run test:mock` | gateway mock | the plugin against a **fake gateway**, end to end, over a loopback socket | loopback only |
| `pnpm run test:e2e` | live gateway | the plugin against **opencode.ai itself**: keyless on every pull request, keyed by tier (`OPENCODE_E2E_KEYED`: `none`, `probes`, `full`) | yes |
| `pnpm run test:e2e:host` | published host | the built bundle inside the published `dsh` binary, per channel and cell (`DSH_HOST_E2E=1`, `DSH_HOST_PREFIX`) | install only |
| `vp test run --coverage` | ratchet | the floors the suite must stay above, overall and per load-bearing file | no |
| `node --experimental-strip-types scripts/check.ts` | bundle gate | the shipped client bundle and the consumer install | install only |

Beside them, CI's vendor gates (`catalog freshness`, `pnpm run cli:version`) hold the generated tables and the claimed CLI version to the vendor, and the nightly `host-drift` job holds `test/support/host-versions.ts` to the registry. The first five layers are the suite, the published host included (its cases assert the same tagged characterization rows as the in-process tier); the coverage ratchet and the bundle gate are gates, as are the vendor gates and `host-drift` beside them. **A gate is not a test**: it fails the build, it does not explain a behaviour.

**Both harness channels.** The unit, real-host and mock layers run on the install of the channel `test/support/host-versions.ts` selects: `alpha` (`dsh@alpha`) is the root lockfile, `rc` (its newest build, `dsh@next` ahead of `dsh@latest`) is `channels/rc/pnpm-lock.yaml`, each with pi unpatched at the newest version its bridge's range admits. `node --experimental-strip-types scripts/use-channel.ts <rc|alpha> [--floor]` switches the local install (`--floor`: pi at the range's floor, the desktop app's pi, never committed); CI runs both channels' default installs on every pull request and the floors nightly.

### Unit: the decision, with its inputs constructed

The bulk of the suite. Each file names one subject, and the cases are the branches a reader would otherwise have to reach through an integration path.

The rule for what belongs here, from `AGENTS.md`: **a predicate that lives in a closure cannot be exercised alone**. Every decision the plugin makes is either exported or takes its value as a parameter, and `test/architecture.test.ts` polices the purity of `src/utils/` so the ones that should be pure stay pure.

Properties the unit and mock suites keep by construction rather than by care:

- **Offline.** `test/support/offline.ts` refuses every non-loopback request, so a networked runner cannot make a result depend on the vendor's live catalog. A case that means to fetch stubs `fetch` itself.
- **No socket in the unit run.** A case that binds a port, even on loopback, belongs to the mock suite (`test/mock/*.mock.ts`), which has the timeouts a socket needs. The offline guard admits loopback, so it cannot hold this; `test/architecture.test.ts` does, failing the build on a runtime import of a socket module (`node:http`, `node:net`, …) or a `createServer(`, `.listen(` or `startMockGateway(` call in any unit test file or any `test/` module one of them loads, with a planted row of each kind.
- **Order-independent.** `test/support/reset-process-state.ts` clears the plugin's module-level stores (captured keys, session spend, the live catalog) after every test, and CI runs the suite shuffled (`pnpm run test:shuffle`; reproduce a failure with `--sequence.seed=<n>`). A new module-level store gets a reset beside its siblings.
- **Engine-checked.** The suite refuses to start below `engines.node` and names both versions (`test/support/node-engine.ts`), because below the floor `node:sqlite` and the ICU strings the tests pin differ, and the failures read like regressions.
- **Real contexts.** A service is built on `new Context()` with what it reads provided (`test/support/loader-rows.ts` serves loader rows and credentials there), and "the plugin, applied" is `mountPlugin` in `test/support/composition.ts`: the module's own `apply`, `Config`, `inject` and `name` mounted the way the Loader mounts them, a turn through `ctx.waterfall("llm/stream", …)`, teardown through `fiber.dispose()`. The one stand-in for the composition is `degradedHost`, for the compositions a real `Context` cannot be (a `plugin` that registers nothing; no `plugin` at all). The route claim keeps its own stand-in host (`test/support/route-claim-stand-in.ts`) for the fiber states a real host cannot be put in on demand.
- **Vendor-proof, where the helpers are used.** A catalog count or a vendor id breaks on the nightly refresh, so the catalog tests assert invariants (non-empty, unique ids, the generator's `is_free` rule, a paid row per served protocol, set differences between the planes), and a case that needs a row picks it by shape (`findCatalogRow`, `catalogRow`, `freeZenModel` in `test/support/catalogs.ts`) and reads its expected values off that row, or seeds a world of its own. This holds for the catalog tests, `tool-fallback`, `models-discovery` and the cases P-T2 and `main` brought; it is not yet true of every file. Older cases still look up a named id in the shipped tables with no skip (the Go allowance coverage case in `go-limits.test.ts`, the Gemini rows of `thinking-levels.test.ts`, `plane-model.test.ts`'s `specOf`), and converting them is an open follow-up. A case whose point IS a named id says so, and should skip by name once the catalog no longer carries it.

### Real host, in-process

`test/support/host.ts` builds the host from this repository's own install: tier A for the `internal/config` waterfall and pi-ai's credential paths, tier B for the config editor, `settings.describe`, the volatile commit and the characterization of the plugin as it ships. Every fake keeps the case offline and its credentials out of the environment. The contract tests (`host-waterfall`, `host-shapes`, `host-credentials`, `host-editor-contracts`) pin what the host does without the plugin; the `host-planes*` files and `host-characterization.test.ts` pin what the plugin does on it, one row table per host cell, tagged `[BASELINE]`, `[KNOWN_DEFECT]`, `[INTENDED_CHANGE]` or `[HOST_LIMITATION]`.

### Mock: the wiring, without a vendor

`test/mock/` boots the plugin against a gateway that answers like the real one, including its refusals (`403 FreeTierError`, `400 ModelProtocolUnsupported`, `401 AuthError`), over a loopback socket. This is the layer that catches a wrong header, a wrong path or a wrong protocol — the questions no unit test can ask because they are about the seam. `protocol-endpoints.mock.ts` also holds the converse: every base and every request either `endpoint` setting can dispatch must reach an endpoint of the mock, and no root-family request may, so a case that checks headers rather than the status cannot pass on a request the mock never served.

### E2E: the vendor's own answer

`test/e2e/` talks to `opencode.ai`. Every e2e-only input it takes from the environment — whether the live suite runs, the key tier and the key it arms per plane, a mirror's bases, the record directory, the CI run, the host-binary cell — comes through `test/support/e2e-env.ts`, and no e2e file reads `process.env` itself. The one switch it shares with the other suites, the harness channel (`DSH_CHANNEL`, `DSH_PI`), is read by `test/support/host-versions.ts` (`selectedHost`) for the unit, real-host and binary suites alike. Its cases **pick their subjects from the catalog at run time** rather than naming a model, because the vendor retires ids on its own schedule. The pure halves of the live suites (the keyless matrix, the keyed cells, the candidate walk, the probe and its verdicts) live in `test/support/` and are unit-tested offline.

**Three rules, learned from failures:**

1. **A live case skips on a vendor-side move, it does not fail.** A retired model (`410 ModelDeprecated`, or an upstream's `400 … Model is unavailable`), a closed tier (`FreeTierError`, or the free tier's usage cap, `429 FreeUsageLimitError`), a missing entitlement and a busy gateway (any other `429`) are all "not observable today". The reason is printed so the run says which.
2. **A case that walks candidates walks past the retired ones.** A `410` is an answer, so a picker that accepts "anything but a refusal" picks a dead model and then fails on it. For a `400` it is the body, not the status, that makes it a retirement: a bare `400` is also a malformed request, which is the plugin's fault and must still fail (`test/support/live-probe.ts`, `modelGone`).
3. **An assertion about the vendor is a claim about a moving thing.** Prefer asserting the PLUGIN's behaviour (which endpoint it chose, which headers it sent) over the vendor's answer.

## The layout

- **One door into `src`.** Every test reaches the plugin's modules through `test/support/src.ts`, which re-exports each name from the module that DEFINES it, so a module move edits one file. `test/architecture.test.ts` fails the build on a test that imports a `src` path itself (outside its named exemptions: `vi.mock` targets, fresh re-imports after `vi.resetModules()`, the architecture and public-API tests, the jsdom client tests and the setup file) and on a jsdom test that loads the door.
- **One subject per file, siblings by name.** A file that grew past one subject is split, the first part keeping the original name and naming its siblings in its header: `fetch-patch` (credentials) beside `fetch-patch-headers`, `-tools` and `-observability`; `catalog` (the shim's invariants) beside `catalog-enrichment`, `-refresh`, `-docs` and `-routing`; likewise `go-discovery`, `route-claim`, `settings-page`, `usage-service` and `host-planes`. A new case goes to the sibling whose subject it is.
- **Shared fixtures in `test/support/`.** A helper two files need lives there once; `test/test-helpers.ts` keeps only what the jsdom client tests may also load.
- **Every coverage floor names a file that exists**, which `test/architecture.test.ts` checks, so a moved module cannot leave a floor on nothing.

## The fixtures

`test/test-helpers.ts` — streams, a capture fetch, the URL of a `fetch` input, and the element walkers for the React trees. The jsdom (client) tests import it, so nothing in it may need a host-only module.

`test/support/opencode-store-fixture.ts` — the OpenCode store fixture. It needs `node:sqlite` and the filesystem, which is why it lives with the other host-only support files rather than in the shared helpers.

`test/support/catalogs.ts` — **catalogue rows**, reaching `src` through the one door like the other fixtures. It does two things. It picks rows of the SHIPPED shim by shape (`findCatalogRow`, `catalogRow`, `freeZenModel`), so a case about "a Messages model on Go" never names one. And it builds the rows a test needs, including rows the vendor has not produced: the plane-aware decisions are only observable when the two planes DISAGREE, and the real catalogue agrees about the free flag for every model it shares.

- `spec(...)` / `divergent(id, { go, zen })` build a row (or a pair of rows) directly, for a decision that takes the row as its parameter — `coreToolDecision`, `calculateTurnCost`.
- `payload({ go, zen })` builds a whole `models.dev` payload, for the paths that read the LIVE catalogue through `refreshCatalog` (`test/plane-lookup.test.ts`, the plane price and the plane-lookup fallback in `test/stream-hook.test.ts` and `test/fetch-patch.test.ts`). That world is per TEST: `refreshCatalog` merges by id and cannot remove, but the setup file resets the live catalog after every test, so a case installs its world itself and gives its rows ids no other test names.
- `seedDivergentCatalog()` installs one such world for the request-path tests: `ZEN_FREE_PROBE` is free on Zen and paid on Go, `GO_FREE_PROBE` the reverse, so a lookup that reads the wrong plane is red in both directions (`test/tool-fallback.test.ts`, `test/fetch-patch-headers.test.ts`).

**A model with no price in a fixture is PAID at a nominal rate, not free.** The parser derives `is_free` from a zero cost, so a "no price" default would silently turn every fixture model into a free tier.

The others, each named for its subject: `composition.ts` and `cordis-wait.ts` (the plugin mounted on a real `Context`, and waiting on one), `loader-rows.ts` and `usage-fixture.ts` (loader rows, credentials and the usage service's endpoint), `host.ts`, `host-planes.ts` and `host-versions.ts` (the real host, its plane-ownership helpers, and the channel records), `route-claim-stand-in.ts`, `card-tree.ts` and `ui-primitives.ts` (the settings card's tree and the host's UI primitives, for the jsdom files), `e2e-env.ts`, `keyless-matrix.ts`, `keyed-probes.ts`, `live-walk.ts`, `live-probe.ts` and `endpoint-record.ts` (the live suites' pure halves), `thinking-levels.ts` and `served-model.ts` (which models think in Google levels, and the model object the plane adapter serves for a row, shared by the offline and live dispatch-levels files), `host-drift-fixture.ts` (registry views for the host-drift rules), and `strip-comments.ts` (the comment blanking the source-reading gates in `test/architecture.test.ts` read through, held by `test/strip-comments.test.ts`).

## The scripts' pure halves

A gate is a script, and a script that runs at import time cannot be tested — so its decisions move out of it:

| script | the decision, extracted | what the test holds |
| :-- | :-- | :-- |
| `generate-go-limits.ts` | `scripts/go-limits-html.ts` | which table is an allowance (by header, not position), the refusal when the page carries none, and the round trip through the real parser |
| `check-vendor-version.ts` | `scripts/vendor-version.ts` | the constant is found, "read nothing" is distinguishable from "passed", and the scan reads every file a copy can live in but never the generated tables |
| `report-host-drift.ts` | `scripts/host-drift.ts` | what each channel installs today, read the way the record's fields are defined (`dsh` as the newest build any dist-tag carries on the record's line, so `next` and `latest` both count for rc, or a newer stable release, the line graduating, under the tag the record names for that (`graduatesUnder`: `latest` for rc, none for alpha); pi as the bridge's range, that range's floor and the newest version it admits, a prerelease only on its own tuple; each of the seven cordis-family members, cordis, the loader, include, group, timer, cosmokit and schemastery, at the floor of the `~` range its declarer (`FAMILY_DECLARERS`) declares in the dist-tagged cluster, so a newer patch inside a range is not drift), one line per field that moved, and "the registry answered nothing" never read as current; known answers: today's registry prints nothing, the next cut prints one line per moved field, and a record whose timer is not the declared floor prints that one line; the CLI runs against a loopback registry in the mock suite (`test/mock/host-drift-cli.mock.ts`) and the CI job's condition is evaluated (nightly and dispatch only) |
| `use-channel.ts` | `scripts/channel-manifest.ts` | which packages a channel repins (every `@deepseek-ai` pin moved, pi's range untouched, a harness package with no rule refused rather than guessed), the identity on the committed channel, the one-line floor override, and the host-free lockfile a `--relock` starts from (every host key gone from the importer, `packages:` and `snapshots:`, everything else kept) |

The pattern is the same one the `utils/` gate enforces inside `src/`, applied to the one place it had not reached: **a decision that lives in a top-level-await script is exercised only by the vendor's schedule** (or, for the channel switch, by the next harness bump). The first two had already passed while wrong — the version gate twice, the Go-limits reader when the docs moved to HTML.

## Two habits

### Plant the violation

A test is only worth its name if it fails when the behaviour it describes is removed. Every guard in this repository was checked by putting the old behaviour back and watching the test go red — the plane-blind lookup, the wrong warning token, the enrichment that answered a refusal with a catalogue.

The recipe: copy the file, apply the old behaviour, run the one test file, confirm the failure names the behaviour (not something incidental), restore.

### Assert the premise

A fixture that quietly stopped describing what the test believes is the failure mode of every long-lived suite. So the cases assert their own premises:

- `test/catalog.test.ts` asserts that the two planes **agree about the free flag** on every id both carry — which is what makes the divergent fixtures necessary — and fails the day the vendor breaks it, naming the models; the seeded price case in `test/stream-hook.test.ts` then holds the plane's own price whatever the vendor's prices are.
- `test/plane-lookup.test.ts` asserts that the synthetic payload **really did** produce a free Go row and a paid Zen row before any decision is exercised.

## What the gates cover, and what they do not

Two rows below are parts of the suite listed for the drift they also hold: the mock suite holds the wire shape, and `host-versions` · `harness-channel` (unit files) hold the install to the channel record. The published host is a test layer, not a gate, and is not listed.

| gate | catches | does not catch |
| :-- | :-- | :-- |
| catalog freshness | the generated shim drifting from the vendor | a wrong decision made from correct data |
| limits freshness | the generated allowance table drifting | the same |
| `cli:version` | the claimed User-Agent version drifting | a wrong header value at the right version |
| bundle gate | the client bundle crossing its ceiling, or a dependency that should have stayed external | a bundle that is small and wrong |
| coverage ratchet | a large uncovered surface | an assertion that cannot fail |
| mock suite | a wrong wire shape | a wrong decision |
| `host-versions` · `harness-channel` | an install, or a lockfile, that is not the channel record's | a record that is itself behind the registry (the nightly `host-drift` job's) |

The pattern: gates catch **drift**, tests catch **logic**. A change that only adds a gate has not covered the behaviour, and a change that only adds a test has not covered the data.
