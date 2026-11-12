# The test system

Six layers, each answering a question the others cannot. What follows is the map, the rule that decides which layer a new case belongs to, and the two habits that keep the layers honest.

## The layers

| command | layer | what it proves | network |
| :-- | :-- | :-- | :-- |
| `vp test run` | unit | one module's decisions, with its inputs constructed | no |
| `pnpm run test:mock` | gateway mock | the plugin against a **fake gateway**, end to end | no |
| `pnpm run test:e2e` | live gateway | the plugin against **opencode.ai itself** | yes, with a key |
| `vp test run --coverage` | ratchet | the floors the suite must stay above | no |
| `node --experimental-strip-types scripts/check.ts` | bundle gate | the shipped client bundle and the consumer install | install only |
| CI `catalog freshness` · `pnpm run cli:version` | vendor gates | the generated tables and the claimed CLI version match the vendor | yes |

The first two are the suite; the rest are gates. **A gate is not a test**: it fails the build, it does not explain a behaviour.

### Unit: the decision, with its inputs constructed

The bulk of the suite. Each file names one subject, and the cases are the branches a reader would otherwise have to reach through an integration path.

The rule for what belongs here, from `AGENTS.md`: **a predicate that lives in a closure cannot be exercised alone**. Every decision the plugin makes is either exported or takes its value as a parameter, and `test/architecture.test.ts` polices the purity of `src/utils/` so the ones that should be pure stay pure.

Three properties the unit and mock suites keep by construction rather than by care:

- **Offline.** `test/support/offline.ts` refuses every non-loopback request, so a networked runner cannot make a result depend on the vendor's live catalog. A case that means to fetch stubs `fetch` itself.
- **Order-independent.** `test/support/reset-process-state.ts` clears the plugin's module-level stores (captured keys, session spend, the live catalog) after every test, and CI runs the suite shuffled (`pnpm run test:shuffle`; reproduce a failure with `--sequence.seed=<n>`). A new module-level store gets a reset beside its siblings.
- **Engine-checked.** The suite refuses to start below `engines.node` and names both versions (`test/support/node-engine.ts`), because below the floor `node:sqlite` and the ICU strings the tests pin differ, and the failures read like regressions.

### Mock: the wiring, without a vendor

`test/mock/` boots the plugin against a gateway that answers like the real one, including its refusals (`403 FreeTierError`, `400 ModelProtocolUnsupported`, `401 AuthError`). This is the layer that catches a wrong header, a wrong path or a wrong protocol — the questions no unit test can ask because they are about the seam.

### E2E: the vendor's own answer

`test/e2e/` talks to `opencode.ai`. Its cases **pick their subjects from the catalog at run time** (`OPENCODE_ZEN_CATALOG.filter(...)`) rather than naming a model, because the vendor retires ids on its own schedule — three of the last four rotations would have turned a constant into a red build.

**Three rules, learned from failures:**

1. **A live case skips on a vendor-side move, it does not fail.** A retired model (`410 ModelDeprecated`, or an upstream's `400 … Model is unavailable`), a closed tier (`FreeTierError`), a missing entitlement and a busy gateway (`429`) are all "not observable today". The reason is printed so the run says which.
2. **A case that walks candidates walks past the retired ones.** A `410` is an answer, so a picker that accepts "anything but a refusal" picks a dead model and then fails on it. For a `400` it is the body, not the status, that makes it a retirement: a bare `400` is also a malformed request, which is the plugin's fault and must still fail (`test/e2e/verdict.ts`, `retiredAtTheGateway`).
3. **An assertion about the vendor is a claim about a moving thing.** Prefer asserting the PLUGIN's behaviour (which endpoint it chose, which headers it sent) over the vendor's answer.

## The fixtures

`test/test-helpers.ts` — streams, a capture fetch, a mock cordis context, element walkers for the React trees. The jsdom (client) tests import it, so nothing in it may need a host-only module.

`test/support/opencode-store-fixture.ts` — the OpenCode store fixture. It needs `node:sqlite` and the filesystem, which is why it lives with the other host-only support files rather than in the shared helpers.

`test/support/catalogs.ts` — **synthetic catalogue rows**, reaching `src` through the one door like the other fixtures. Every other fixture quotes something that exists; this one builds the row a test needs, including rows the vendor has not produced. It exists because the plane-aware decisions are only observable when the two planes DISAGREE, and the real catalogue agrees about the free flag for every model it shares.

Three entry points:

- `spec(...)` / `divergent(id, { go, zen })` build a row (or a pair of rows) directly, for a decision that takes the row as its parameter — `coreToolDecision`, `calculateTurnCost`.
- `payload({ go, zen })` builds a whole `models.dev` payload, for the paths that read the LIVE catalogue through `refreshCatalog` (`test/plane-lookup.test.ts`). That world is per TEST: `refreshCatalog` merges by id and cannot remove, but the setup file resets the live catalog after every test, so a file installs its world in `beforeEach` and gives its rows ids no other test names.
- `seedDivergentCatalog()` installs one such world for the request-path tests: `ZEN_FREE_PROBE` is free on Zen and paid on Go, `GO_FREE_PROBE` the reverse, so a lookup that reads the wrong plane is red in both directions (`test/tool-fallback.test.ts`, `test/fetch-patch.test.ts`).

**A model with no price in a fixture is PAID at a nominal rate, not free.** The parser derives `is_free` from a zero cost, so a "no price" default would silently turn every fixture model into a free tier.

## The scripts' pure halves

A gate is a script, and a script that runs at import time cannot be tested — so its decisions move out of it:

| script | the decision, extracted | what the test holds |
| :-- | :-- | :-- |
| `generate-go-limits.ts` | `scripts/go-limits-html.ts` | which table is an allowance (by header, not position), the refusal when the page carries none, and the round trip through the real parser; which allowance table is which plan (by the label the page attaches to it, never by position or count: a Starlight-shaped page with three tabs in a non-plan order, its attributes reordered and single-quoted with the tab ids reused in `href`s, innermost and unprocessed panels, a tag inside a script or a comment, heading-labelled tables; two unlabelled tables keep the measured order, three are refused, a duplicated or missing plan label and two tabs naming no plan are refused, a labelled Go table with no model row is refused by the parser; the Starlight markup is assumed, not measured); which answer is read (a 2xx answer by what its body carries; the status alone is never trusted: the tabbed markdown with both tabs as it is, a page whose Go and Go Plus tables can be chosen converted, either only when the real parser reads it without an error, anything else not at all), a cell that spans lines read as one line, a cell's character references decoded in one pass as a browser shows them (`&#36;15` is $15, `Grok&nbsp;4.7` keys as `grok-4.7`), the walk over the sources (a fake reader: the moved page first, a later one asked only when the earlier carried nothing the parser reads, the 2026-11-07 `go.md` shape refused), the error that names what each source answered, every allowance table with its label, rows and first row, and why none was read, and the success line that names which table was read as each plan and which were ignored |
| `check-vendor-version.ts` | `scripts/vendor-version.ts` | the constant is found, "read nothing" is distinguishable from "passed", and the scan reads every file a copy can live in but never the generated tables |
| `report-host-drift.ts` | `scripts/host-drift.ts` | what each channel installs today, read as npm resolves it (`dsh` as the newest build any dist-tag carries on the record's line, so `next` and `latest` both count for rc, or a newer stable release, the line graduating, under the tag the record names for that (`graduatesUnder`: `latest` for rc, none for alpha); cordis, the loader, schemastery and pi at the newest version the bridge's ranges admit, a prerelease only on its own tuple), one line per field that moved, and "the registry answered nothing" never read as current; the CLI runs against a loopback registry and the CI job's condition is evaluated (nightly and dispatch only) |
| `use-channel.ts` | `scripts/channel-manifest.ts` | which packages a channel repins (every `@deepseek-ai` pin moved, pi's range untouched, a harness package with no rule refused rather than guessed), the identity on the committed channel, the one-line floor override, and the host-free lockfile a `--relock` starts from (every host key gone from the importer, `packages:` and `snapshots:`, everything else kept) |

The pattern is the same one the `utils/` gate enforces inside `src/`, applied to the one place it had not reached: **a decision that lives in a top-level-await script is exercised only by the vendor's schedule** (or, for the channel switch, by the next harness bump). The first two had already passed while wrong — the version gate twice, the Go-limits reader when the docs moved to HTML.

## Two habits

### Plant the violation

A test is only worth its name if it fails when the behaviour it describes is removed. Every guard in this repository was checked by putting the old behaviour back and watching the test go red — the plane-blind lookup, the wrong warning token, the enrichment that answered a refusal with a catalogue.

The recipe: copy the file, apply the old behaviour, run the one test file, confirm the failure names the behaviour (not something incidental), restore.

### Assert the premise

A fixture that quietly stopped describing what the test believes is the failure mode of every long-lived suite. So the cases assert their own premises:

- `test/catalog.test.ts` measures that the two planes **disagree about price** and **agree about the free flag** — the second is what makes the first fixture necessary, and it fails the day the vendor breaks it, naming the models.
- `test/plane-lookup.test.ts` asserts that the synthetic payload **really did** produce a free Go row and a paid Zen row before any decision is exercised.

## What the gates cover, and what they do not

| gate | catches | does not catch |
| :-- | :-- | :-- |
| catalog freshness | the generated shim drifting from the vendor | a wrong decision made from correct data |
| limits freshness | the generated allowance table drifting | the same |
| `cli:version` | the claimed User-Agent version drifting | a wrong header value at the right version |
| bundle gate | the client bundle crossing its ceiling, or a dependency that should have stayed external | a bundle that is small and wrong |
| coverage ratchet | a large uncovered surface | an assertion that cannot fail |
| mock suite | a wrong wire shape | a wrong decision |

The pattern: gates catch **drift**, tests catch **logic**. A change that only adds a gate has not covered the behaviour, and a change that only adds a test has not covered the data.
