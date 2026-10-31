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

### Mock: the wiring, without a vendor

`test/mock/` boots the plugin against a gateway that answers like the real one, including its refusals (`403 FreeTierError`, `400 ModelProtocolUnsupported`, `401 AuthError`). This is the layer that catches a wrong header, a wrong path or a wrong protocol — the questions no unit test can ask because they are about the seam.

### E2E: the vendor's own answer

`test/e2e/` talks to `opencode.ai`. Its cases **pick their subjects from the catalog at run time** (`OPENCODE_ZEN_CATALOG.filter(...)`) rather than naming a model, because the vendor retires ids on its own schedule — three of the last four rotations would have turned a constant into a red build.

**Three rules, learned from failures:**

1. **A live case skips on a vendor-side move, it does not fail.** A retired model (`410 ModelDeprecated`), a closed tier (`FreeTierError`), a missing entitlement and a busy gateway (`429`) are all "not observable today". The reason is printed so the run says which.
2. **A case that walks candidates walks past the retired ones.** A `410` is an answer, so a picker that accepts "anything but a refusal" picks a dead model and then fails on it.
3. **An assertion about the vendor is a claim about a moving thing.** Prefer asserting the PLUGIN's behaviour (which endpoint it chose, which headers it sent) over the vendor's answer.

## The fixtures

`test/test-helpers.ts` — streams, a capture fetch, a mock cordis context, the OpenCode store fixture, element walkers for the React trees.

`test/fixtures/catalogs.ts` — **synthetic catalogue rows**. Every other fixture quotes something that exists; this one builds the row a test needs, including rows the vendor has not produced. It exists because the plane-aware decisions are only observable when the two planes DISAGREE, and the real catalogue agrees about the free flag for every model it shares.

Two entry points:

- `spec(...)` / `divergent(id, { go, zen })` build a row (or a pair of rows) directly, for a decision that takes the row as its parameter — `coreToolDecision`, `calculateTurnCost`.
- `payload({ go, zen })` builds a whole `models.dev` payload, for the paths that read the LIVE catalogue through `refreshCatalog` (`test/plane-lookup.test.ts`). That world is per FILE: `refreshCatalog` merges by id and cannot remove, so a file that installs one holds nothing else.

**A model with no price in a fixture is PAID at a nominal rate, not free.** The parser derives `is_free` from a zero cost, so a "no price" default would silently turn every fixture model into a free tier.

## Two habits

### Plant the violation

A test is only worth its name if it fails when the behaviour it describes is removed. Every guard in this repository was checked by putting the old behaviour back and watching the test go red — the plane-blind lookup, the wrong warning token, the enrichment that answered a refusal with a catalogue, the wrapper's `default` re-export.

The recipe: copy the file, apply the old behaviour, run the one test file, confirm the failure names the behaviour (not something incidental), restore.

### Assert the premise

A fixture that quietly stopped describing what the test believes is the failure mode of every long-lived suite. So the cases assert their own premises:

- `test/catalog.test.ts` measures that the two planes **disagree about price** and **agree about the free flag** — the second is what makes the first fixture necessary, and it fails the day the vendor breaks it, naming the models.
- `test/plane-lookup.test.ts` asserts that the synthetic payload **really did** produce a free Go row and a paid Zen row before any decision is exercised.
- `test/wrapper-forwarder.test.ts` links the generated wrapper against the **built** barrel in a real Node process, because a bundler turns a missing export into `undefined` and stays green.

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
