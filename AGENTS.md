---
tags:
  - dsh
  - plugin
  - opencode
  - cordis
status: note
aliases:
  - dsh-opencode
  - dsh-opencode-patch
---

# `dsh-opencode-patch` — OpenCode on DeepSeek Harness

> [!info] Summary DSH host plugin (`dsh-opencode-patch` on npm, published with the `@viztor/dsh-opencode-patch` and `@viztor/dsh-opencode` scoped aliases from the same tree; repo `viztor/dsh-opencode-patch`) that keeps OpenCode Zen free-tier models working inside DeepSeek Harness: deterministic `ses_…` session affinity, gateway origin-header restoration, `read`/`bash` tool-schema fallback, a models.dev-backed model catalog with SWR refresh, and a composer meter showing Go quota, Zen overflow, session spend and the active model's rate. Standards reference: [[OBSIDIAN]] (`~/dev/OBSIDIAN.md`).

## How it works

1. **Turn scope** — `apply()` hooks `llm/stream` for configured providers, derives a stable `ses_<12hex><14base62>` ID per DSH session (`openCodeSessionIdFor`, SHA-256), and carries it in `AsyncLocalStorage` across the streamed turn (`withStore`).
2. **Fetch patch** — `patchFetch()` intercepts only OpenCode traffic (`isOpenCodeRequest`: `opencode.ai/zen` URL or matching provider in turn state). It always sets `x-opencode-session`, optionally restores `User-Agent` / `x-opencode-client` / `x-opencode-project`, and injects fallback `read`+`bash` schemas into free-tier `/responses` bodies. Non-OpenCode requests return via the original fetch untouched.
3. **Settings UI** — `src/settings-page.tsx` builds `lib/client.js`, contributing the OpenCode Patch card under DSH Settings → Plugins: **8 fields in 3 sections** (Gateway Requests / Models & Free Tier / Quota Meter) — the behaviour toggles plus the `keySource` credential policy. The other 8 schema knobs are **config-only** (see `CONFIG_ONLY_FIELDS`), and the row config (`cordis.patch.yml`) is their reference.

## Package vs component (do not conflate)

- **npm package** `dsh-opencode-patch`: the installable unit (host `main` + `lib/client.js`); the `@viztor/dsh-opencode-patch` and `@viztor/dsh-opencode` scoped aliases are published from the same tree. The host resolves a row to `node_modules/<row name>`, so the row's `name` must equal `dsh-opencode-patch` exactly.
- **cordis row**: one _instance_ of the package. `id` (`dsh-opencode-patch`) is the instance id and doubles as the settings namespace the client card binds (with a fallback to the legacy namespace `dsh-opencode`). One package can back N rows with different ids/configs — the card binds the default `dsh-opencode-patch` row (single-row assumption; a second row would need its own NS binding).
- **plugin `name` export** (`src/index.ts`): the component identity (log lines, service scoping). Matches the default row id by convention only.
- **client slot key** (`PKG` in `src/settings-page.tsx`): bundle-level page key, always the npm package name.

## Why the gateway markers and the free-tier marker exist

Two knobs look redundant until you know what they cover — both are config-only for that reason. A third, `usageProviderMarkers`, _was_ redundant and has been removed: see below.

**`gatewayUrls`** is consulted in exactly one place (`isOpenCodeRequest`) and is checked _before_ the turn state. Two kinds of request need it: one that arrives with **no active turn state** (the patch runs deep in the adapter path, and not every gateway call happens inside a turn) and one whose **provider id we do not list** (a custom relay, mirror, or self-hosted gateway). The provider list cannot cover either, because it is matched against turn state that may not exist.

`isModelsListingUrl` used to be the same gap and no longer is: it now takes the configured markers exactly like `isOpenCodeRequest` does (`gatewayUrls` with a default), and `patchFetch` — which already holds the config — passes them. The reason that gap was worth closing is that it was **invisible**: a relay matched every other OpenCode rule, so it got the headers, the session id and the key injection, and then no catalog — and a shorter model list reads as "fewer models", not as a broken rule. The same class of bug as the missing `Tooltip` (works, does nothing) and the stale bundle (works, says the old thing). `isGoModelsListingUrl` forwards the markers too, because the Go plane is a property of the PATH (`/go/v1`), never of the host — which is exactly why the host had to come out of the predicate.

**`freeModelMarker`** exists because **the gateway really does treat free tier differently**. `tool-fallback.ts`: "The OpenCode Zen gateway rejects free-tier `/responses` bodies that lack `read` and `bash` in `tools`, while DSH deliberately does not send them." The plugin rewrites the body to carry both schemas — and only when they are genuinely missing, so a body that already declares them passes through byte-identical. The marker (default `"free"`, `"*"` for every model) is how we detect "free tier", because a model row carries **no capability flag** — the only signal is the model id. It is config-only because `"free"` tracks the vendor's ids and `"*"` is the escape hatch if the rule ever widens to paid models.

### The meter's registration: declare services with `ctx.inject`

The composer-dock meter depends on two cross-plugin services: `slots` (to register the entry) and `modelDirectories` (to know the active provider). **They must be declared with `ctx.inject([...], scope => …)`**, which is the host's own idiom — `ui-model-selection` does exactly this for the same pair:

```ts
ctx.inject(['slots', 'modelDirectories'], (scope: ClientContext) => { … })
```

Reading `ctx.modelDirectories` straight off the **root** context is not guaranteed, and because every access in that path is optional (`?.`) the failure is **silent**: `directoryFor` never resolved, the injector returned `null`, and the meter simply never mounted — with no error anywhere. That is how it shipped broken. `settings-page.tsx` now registers through `ctx.inject` and falls back to the root context only when the assembly has no `inject` at all. A regression test pins it: a root context carrying _neither_ service must still produce a working injector, because both arrive on the injected scope.

General rule: when reaching for another plugin's service, declare it. An optional read off the root context turns a wiring mistake into a missing feature.

It gated _whether the meter renders_ for the active provider, and its default was `["opencode-go", "opencode"]` — the same list as `providers`, reversed. They are the same set by construction: a route we do not claim carries no OpenCode headers, so it has no quota to report either. The meter now reads **`providers`** (client-side, from the served settings snapshot, falling back to `DEFAULT_PROVIDERS`), and the pill's prop is named `meterProviders` so the source is obvious.

`DEFAULT_PROVIDERS` therefore moved to `config-values.ts` — the client bundle needs the default and may not import `config.ts` (schemastery). This is the same pattern as `usageKeyEnv`: a row setting that asked the user to restate a decision the composition already owns. Both are gone; prefer removing such a knob over documenting it.

### The meter's trigger: the `Tooltip` wraps the BUTTON

Hovering explains, clicking opens — and the tooltip is what "explains" now, because `3313094` removed hover-to-open when the popover was aligned with the host's own language. The wiring looks correct either way, which is the problem: **the host `Tooltip` clones its child and hands the clone the hover handlers and the anchor ref**, so wrapping our _component_ attaches them to a component that ignores unknown props and the tooltip never appears. Hovering the pill did nothing at all for one release, and nothing in the tree said why.

It sits inside `UsageTrigger`, around the `<button>`, for that reason — the clone needs a DOM node. Two tests pin the seam, because it is invisible from the JSX alone: `usage-panel.test.tsx` asserts the button is the tooltip's _child_ (the tree, not the intent), and `usage-pill-mount.test.tsx` hovers the trigger in a real DOM and reads the `role="tooltip"` that appears.

The stub in `test/primitives-stub.tsx` is the other half and was **missing `Tooltip` entirely** — so every mount test died on "Element type is invalid" while the other 27 files stayed green. It is now the one kit export that returns real elements and holds state, mirroring the host's: clones its child, composes the child's handlers first, bubble as a sibling, inert to the pointer (a tooltip that swallowed the meter's hover would open a panel nobody could close).

### The meter's panel: three actions, one sentence

The panel's action row had **no CSS rule at all**, so its three anchors fell back to the UA default — purple, solid underline, no gap — and concatenated into one run-on line across the panel: `升级套餐控制台与余额额度说明`, which reads as one link and is in fact three (`usageUpgradePlan`, `usageConsole`, `usageLimitsDoc`). Nothing was wrong with the JSX or the copy; the row was simply unstyled, and a stylesheet is only as good as the rules you remember to write. It now carries `display: flex` + a gap and the host's own link language (`--dsw-alias-link`, no underline until hover, per `MarkdownText.module.css`), with a test asserting both that the class is wired and that the sheet still styles it — the two regress independently.

General rule, and the second time this repo has paid for it: **a surface with no rule of its own inherits the browser's**, which ignores the theme entirely. An invented `--color-*` name does the same thing more quietly.

**Then the copy: the Zen panel said `按量计费` three times.** The badge, a subtitle under the header, and the value of an "Available Zen Balance" row — with the per-token explanation printed under the header _and_ under that row. None of it was wrong; all of it repeated. The panel says the billing model once now, in the badge, which is where the Go panel puts its own (`Go Plan` / the limit notice), and **the Zen balance row moved to the Go panel alone**: it answers "where does an over-limit Go request get billed?", and on a Zen route you are already paying per token with no balance to report — OpenCode exposes none. That is the test for a row here: _what question does this row answer, and can the panel answer it?_ A row that restates the badge answers nothing. `describeUsage` followed — its Zen branches were computing copy nothing rendered any more.

**Do not hand-roll a look-alike of a primitive you already ship.** The meter's billing badge was a `<span>` with its own padding, radius and fill — a clone of `Tag`, which this repo already uses for the settings card's "Overridden" badge. The clone got the palette wrong in the way clones do: it used `--dsw-alias-interactive-bg-hover` as its **resting** background, so the chip sat permanently lit, exactly like the trigger. It is `<Tag tone={isLimited ? "danger" : "neutral"}>` now, and deleting the two hand-rolled rules plus the dead retry rules took **1,141 bytes** off the bundle. When the host ships the primitive, the primitive is both more correct and smaller.

**Anything the meter RENDERS must be a real component in the stub — and it is always the SAME commit.** `test/primitives-stub.tsx` returns `{props, type}` objects for most of the kit, which is fine because the settings tests only _walk_ the tree. The meter's `usage-pill-mount` test mounts for real — so a kit export the panel draws has to return elements there, or the suite dies with "Element type is invalid" while every other file stays green. **Three times now**: the missing `Tooltip` (cost all thirteen mount tests), `Tag` when the badge started using it, and `IconRefreshOutlineRegular` when the hand-drawn arrow was finally swapped for the host's icon. The rule that actually saves time: **wiring a kit export into the panel and stubbing it are one edit** — do both in the same commit, or the suite is the thing that tells you.

**A meter row must name its subject, and the free case is still a model.** The session-spend row read `${activeModel} · ${activeRateFormatted}`, and both halves went wrong on a free model: the identity was the raw id (`muse-spark-1.3-contributor-free` — a debug value, and the second time that row said "free"), and the rate was the string `Free Tier ($0.00)` — a sentence containing the number the row already prints in its value column. The free branch then "fixed" it by rendering `t("freeModel")` alone, which dropped the model name entirely: the one row whose value is always `$0.00` became the only row that could not say what you were paying for. It is now the same shape either way — which model, then what it costs — with the name coming from the catalog (`describeModel` takes a display name, `attachSession` backfills one for the id a turn recorded, since a turn only ever knows the id the gateway speaks) and the rate string reduced to `Free`, which is what a field that otherwise holds a per-million price should say.

The general rule, and it is the third time this file has recorded a version of it: **a field that repeats a number already on screen is not a second fact.** `Free Tier ($0.00)` beside a value of `$0.00` is the nested-card mistake in text.

**The trigger is ghost until hover, like everything else in the composer.** It carried a `--dsw-alias-interactive-bg-hover` fill at rest, which is the _hover_ token — so the pill sat there permanently looking pressed, with a frame of its own beside the model selector. No fill at rest; the tint moved to `:hover` / `:focus-visible`, which is where it also becomes the affordance that says the ring is a button. Same class of mistake as the nested card: an element drawn as a surface when it is not one.

**One frame, not two.** The spend row was a card — its own background, radius and padding — sitting inside the panel, which is _already_ a floating surface. Two nested rectangles around one line of text is the visual equivalent of the redundant copy above: each element is defensible alone and the pair is noise. The row is now plain text with the same metrics as a breakdown row's value, so the whole panel reads as one list. `dsh-oc-zen-card` became `dsh-oc-usage-detail` in the same pass — it renders on BOTH providers, so naming it after one was wrong, and the name is what made a second box look intentional.

**The rate beside the spend is PROSPECTIVE, so it follows the picker.** The accumulator prices each turn at the model that ran it, so `session.activeModel` names the **last completed turn** — which goes stale the moment you switch models, and described `mimo-v2.6-flash` while the composer sat on Space Bunny Free. The Host owns the catalog and the client ships no rates, so the client sends the selection with the query (`UsageQuery.model`) and the Host re-describes the snapshot: `describeModel` swaps the identity and re-derives the rate, **leaving `costUsd` alone** because that is history. `attachSession` (usage.ts) is the single place that does it; it no-ops when the selection already matches, so the common path costs nothing. But a re-describe only happens when a READ reaches the Host, and the meter's poll loop depended only on `readUsage` — a function the injector builds once — so a model switch left the panel describing the PREVIOUS model for up to a minute. The lesson: **a derived value is exactly as live as the dependency that re-fetches it**, so `provider` and `model` sit in the poll effect's dependency list beside `readUsage`, and a switch re-reads at once instead of waiting for the next 60s tick. Renaming `includedInPlan` to `freeModel` came from the same read: the flag is set from the catalog's `is_free`, so it means _this model bills nothing_ — "Go 套餐包含" claimed a plan was paying for a model that is free on any plan.

**Every action link lives in the footer; a link does not get its own row.** `升级套餐` had a row to itself, behind a divider, above the spend block — so the Go panel was one row taller than the Zen panel for one word, and the two actions sat in two different places on a 320px surface. Every link is in the footer now (`升级套餐  控制台`), where they read as what they are: actions. Still two, because they are two destinations — `opencode.ai/go` answers 200 with no title (the plan page) while `/console` answers 200 titled "OpenCode Console", and `/go/billing` 404s — so this is not the Zen case of two links to one page.

**The panel is ONE component with per-provider content, expressed as data.** `panelActions(isZen)` returns the actions _below_ the console link — Go's plan and limits doc, nothing for Zen — and the footer carries the console for both. Zen's single action is that link, labelled 充值 because that is what a pay-as-you-go user wants from the console, so repeating it below would be two links to one page. Top-up has no URL of its own: `/console/` is a single-page app that answers 200 for every path under it, so a probe cannot tell a real `/billing` route from a catch-all, and a link that 404s is worse than one that opens the page where top-up lives.

**A 20px hit target is not padding, and moving a control is not the same as shrinking it.** The footer's refresh button read as a hole: `⟳` led the row, and it is a 20×20 box around a 14px glyph with a 5px gap on top — so the row showed a lone button with a caption beside it. Two fixes, and the second is the one that was actually wrong to reach for. The control now comes AFTER the timestamp (`更新于 08:13 AM ⟳`), which reads like any "as of" field and puts the thing that refreshes the value next to the value; the gap went 5px → 1px. What stayed: `width: 20px` and `padding: 0`. **Dropping the padding would have shrunk the click target to fix a spacing problem** — the box is accessibility, and the gap was the thing making the row look empty. Same family as the nested box: the element is right and the SPACE around it is what is wrong.

**A feedback animation that the data outruns is not feedback.** The refresh glyph already spun a full `rotate(360deg)` every 0.9s while disabled — and a click still read as "nothing happened", because `/usage` usually answers in ~100ms and the icon flickered without completing a turn. A manual refresh now holds its busy state open for **at least one full cycle** (`MIN_FEEDBACK_MS`, and it is exported so a test can pin it against the keyframes). Two rules fall out of that one fix:

- **The busy window and the animation duration are the same number.** They live in different files — CSS and TSX — and the failure is silent when they drift: the icon either never completes a turn or spins on with nothing to show for it. A test reads the `0.9s` out of `STYLES` and asserts it equals `MIN_FEEDBACK_MS / 1000`, so the next person to retune the animation finds out from the suite.
- **Only the MANUAL refresh is padded.** The 60s background poll is invisible; holding its state open would delay the next tick for nothing. And `prefers-reduced-motion: reduce` skips the wait entirely — a full turn is motion the reader opted out of, and the data still lands, just without an animation to wait for. The media query is read at call time, never cached at module load, because the preference can change between renders.

**The tooltip is where a number gets MEANING, so it must not restate the panel — and it must be a statement ABOUT THE TRIGGER'S OWN NUMBER.** That is a second rule the screenshot forced: hovering the Zen pill said `OpenCode Zen`, because `UsageCopy.headline` — a sentence explaining a RING — was bound to the hover label of a trigger that has no ring and shows session spend. The account name is not an explanation of a dollar amount; it is the panel header, one click away. `UsageCopy` now carries `tooltip` beside `headline`, per provider: Go keeps the ring's own figure (`90% of 5 hours used`), Zen answers the question its number actually raises (`Pay-as-you-go · no quota window`). The general form: **a trigger's hover label must be about that trigger's number** — reusing one string across two different triggers silently produces a tooltip that explains nothing, which is the same failure as the nested box: the element is defensible alone and the pairing is noise.

Go gets the ring's own figure spelled out (`90% of 5 hours used`); Zen's trigger shows session spend, so its tooltip answers the question that number raises — _consumed yes, but what is LEFT?_ Two answers, both real: `zenOverflow` means the **Go plan is what ran out**, so the remaining is zero and billing moved here (`Go 额度已用尽，计费已转到 Zen`); otherwise **Zen has no window at all**, because OpenCode exposes no balance or remaining-quota figure (every `balance`/`credits`/`account` path 404s, and the balance lives in console server actions a browser must fetch). Asking for "remaining" on a Zen route has one knowable answer — _why am I paying per token at all_ — and the overflow flag is what knows it. `UsageCopy` carries `tooltip` beside `headline`; they were the same string, which is why hovering a Zen pill explained nothing.

## Repo map

Host bundle (`lib/index.mjs`) — a thin `apply` barrel over small modules:

- `src/index.ts` — public barrel: re-exports identity, `apply`, and every module's surface. No `as`, arrow consts, sync Promise wrappers (ALS-safe by design).
- `src/identity.ts` · `src/lifecycle.ts` — the component/package name constants, and the `apply()` composition: one installer per side effect (rename notice, usage service, fetch patch, stream hook, model discovery) in load-bearing order.
- `src/config.ts` — schemastery `Config` schema + `resolveConfig`; every default lives once in `CONFIG_DEFAULTS`.
- `src/config-values.ts` · `src/guards.ts` — dependency-free readers and type guards. **The only host modules the client bundle may import** (never `config.ts`/schemastery).
- `src/session.ts` · `src/turn-store.ts` — `ses_<12hex><14base62>` hashing (`OPENCODE_SESSION_ID` override) and the ALS turn store.
- `src/stream-hook.ts` · `src/fetch-patch.ts` · `src/tool-fallback.ts` — the `llm/stream` hook, the fetch interceptor, and the free-tier `read`/`bash` fallback.
- `src/key-capture.ts` — what a credential _is_: header extraction, placeholder rejection, tier classification and the capture store. Split from `go-discovery.ts`, which keeps the plan side (endpoint, credential reference, and the policy ordering the two sources against each other).
- `src/go-discovery.ts` · `src/usage.ts` · `src/usage-contract.ts` — credential/base-URL precedence, the usage Host service, and the shared `GoUsage` shape.
- `src/catalog-data.ts` — the static Go/Zen model shim: per-model specs, per-million-token rates, and the provider-scoped retirement list. Pure data, no behavior, and **generated** by `scripts/regenerate-catalog-shim.ts` — never hand-edited, because a hand-patched field once mis-routed nine models on every cold start. `pnpm run catalog:shim` reports staleness; `--write` rewrites it.
- `src/models-catalog.ts` — parses `models.dev`, revalidates the catalog (SWR), and enriches gateway `/models` listings and discovery feeds. Re-exports the `catalog-data.ts` surface. Both sit behind `enrichModels`.
- `src/models-discovery.ts` — provider-aware decoration for `ctx.llm.discoverModels` answers on claimed OpenCode routes. It preserves adapter rows, appends missing canonical rows, and omits provider-retired rows when `enrichModels` is on.
- `src/responses-routes.ts` · `src/responses-provider.ts` — the protocol table read off the vendor's per-model SDK, and the in-process mount of the host's own `llm-pi-ai` that serves the routes it implies. The mount is the piece with four host contracts to survive; read its header before touching it.
- `src/session-cost.ts` — per-turn token/dollar accounting from `llm/stream` usage events, priced with catalog rates. Tracks the ACTIVE model so a mid-session switch reprices without discarding spend.
- `src/cordis-context.ts` · `src/debug.ts` — typed ctx/remote/slots interfaces and JSONL stream debug logging.

Web client bundle (`lib/client.js`):

- `src/settings-page.tsx` — bundle entry (`vp pack`): wiring only — `ClientContext`, `apply`, scope validation, the settings store, slot registration, quota-pill props; re-exports `SPECS`. Guard unknown scope with `isSettingsFormScope`, never assert.
- `src/settings-card.tsx` · `src/settings-field-shell.tsx` · `src/settings-boolean-field.tsx` · `src/settings-choice-field.tsx` — the configuration card (one control per `CARD_FIELDS` entry) and its controls: one shared row shell (label / override badge / reset / message) plus a boolean toggle and an enum `<select>`. Pure views fed by the store `settings-page.tsx` owns.
- `src/settings-copy.ts` — en/zh dictionaries + `Translate`; `zh` is typed against `en`'s keys, so a missing translation is a type error.
- `src/settings-fields.ts` — the `CARD_FIELDS` register: the single source of truth for which knobs the card edits (knob, **section**, control kind, copy keys). `SPECS` (the draft conversions the form model binds) and the card's JSX are both derived from it, so a field can no longer be bound but never rendered. Kinds are `boolean` / `select` only — the card renders toggles and one enum, so a `text`/`list` kind would be unreachable vocabulary. A new kind must be added to `COMPONENT_BY_KIND` in `test/settings-page.test.tsx`, which is a total record over the union. Each entry names a `GROUP`, and the card renders a heading wherever the group changes — so **a group's entries must stay contiguous** (a test pins that).
- **`CONFIG_ONLY_FIELDS`** (same file) is the other half of the register: the schema knobs that deliberately render no control, each with its reason. The card shows the decisions a user makes (toggles, the credential policy); everything there is an _override_ — a literal (UA string, header value, endpoint), a marker (model-id or URL substring) or a reference (env-var name, credential ref, route list) whose default fits every documented setup. Exposing them only invited someone to break their own routing, and hiding them is what took the card from 17 rows to 8. A test pins that `CARD_FIELDS` and `CONFIG_ONLY_FIELDS` **partition the schema exactly** — no knob in both, none in neither — so a new schema field cannot silently become unreachable.
- `src/usage-pill.tsx` — the meter's state: gating, polling, hover/click dismissal, retry. Renders `usage-panel.tsx`; all wording comes from `usage-ui.ts`.
- `src/usage-panel.tsx` — `UsageTrigger` (ring / Zen pill) and `UsagePanel` (breakdown, detail rows, actions): pure presentational components, no hooks, so tests invoke them directly and walk the element tree. **One frame only** — the panel is the surface, and every row inside it is plain text; a background on a row draws a box inside a box.
- `src/usage-ui.ts` — dependency-free meter logic: geometry, action links, window/affinity helpers, `isZenProvider`, `describeUsage`, `parseFailure`, `ringGeometry`, and the stylesheet — exported so tests hit real logic.

### A fallback chain can be correct in every token and still paint the wrong colour

The panel rendered SOLID WHITE while every other popover in the composer was translucent — the one surface in the dock that did not look like part of the harness. Both tokens were real, correctly named, and correctly applied:

| layer | token | resolved value | alpha |
| --- | --- | --- | --- |
| 1 | `--dsw-specific-menu` | `#f8f9faf0` | 94% opaque |
| 2 | `--dsw-alias-bg-layer-2` → `--dsw-static-neutral-bluish-00` | `#fff` | fully opaque |

Stacked, that is solid white. The right declaration is the host's actual menu material: `--dsw-menu-surface-fill` (`#f8f9fa94` light, `#43454a73` dark) behind `--dsw-menu-backdrop-filter` (`blur(40px) saturate(150%)`), with `--dsw-elevation-stroke-color: var(--dsw-alias-border-l3)` — the stroke the theme scopes to `[data-menu-material]`.

**The lesson is not "invented tokens fail" — that is already recorded above, and these were NOT invented.** It is that a chain of individually valid tokens can still be wrong, and reading a token's NAME says nothing about the product. `--dsw-specific-menu` is the _specific_ (higher-emphasis) menu; a plain floating surface wants the _surface fill_. Grepping the checkout proves a token EXISTS, never that it is the right one — read its VALUE, in both themes. The test strips CSS comments before asserting, because a rule that merely TALKS about `--dsw-specific-menu` is not a rule that sets it, and otherwise the explanation of the fix fails the test for the fix.

**Two host surfaces are floating boxes, and matching on "it is also a floating surface" got this wrong twice.** The panel is **menu material** (`--dsw-menu-surface-fill` + `--dsw-menu-backdrop-filter`, the pair the theme's `[data-menu-material]` stroke rule is built for — the host's own `Menu` opts in by rendering `data-menu-material="translucent"`). The dockkit **float** is not: `position: fixed`, an opaque `--dsw-alias-bg-layer-2`, no backdrop, docked to the screen edge. They differ where it counts:

|  | popover / **menu material** (ours) | dockkit **float** |
| --- | --- | --- |
| radius | `--dsw-radius-lg` (16px) | `--dsw-radius-panel` (28px) |
| stroke | `--dsw-alias-border-l3` | `--dsw-alias-border-l2` |
| elevation | `--dsw-elevation-prominent` | `--dsw-elevation-prominent` |
| source | `MenuSurface.module.css`, `[data-menu-material]` | `_float_6nhg2_156` in the app stylesheet |

Radius went `lg` → `panel` → back to `lg`, and the stroke `l3` → `l2` → back to `l3`, across two rounds of "read the host's values" that made it worse both times. **The discriminator is MATERIAL, not resemblance**: check whether the reference surface is the same _kind_ of thing (translucent popover vs opaque docked panel), not merely a similar shape. A screenshot is what catches this; the code cannot.

**The stroke is chosen by the THEME, per theme, off an ATTRIBUTE — so do not declare it.** The owner's first instinct ("maybe we should use `border-l4`?") was **right**, and two rounds of reasoning talked them out of it. The theme ships:

```
body                                            -> --dsw-elevation-stroke-color: border-l4
body[data-ds-dark-theme] [data-menu-material]   -> border-l3
```

There is **no light-theme `[data-menu-material]` rule**. Grepping that selector out of context yields a rule that reads like a global one and is in fact **dark-only** — which is why `l3` looked correct (it was the dark answer) and why hardcoding it was wrong in the light theme, the theme every screenshot here is taken in. The panel now carries `data-menu-material="translucent"`, exactly what the host's own `Menu` renders, and declares **no** stroke of its own: the theme decides, and both themes are right. **Opting in beats re-declaring** — a hand-set `--dsw-elevation-stroke-color` pins one theme's answer and silently breaks the other's, which is a worse bug than the one it replaced because it looks correct in whichever theme you test it in.

**The border scale is not inverted.** Light-theme alpha: `l1` 4%, `l2` 10%, `l3` 12%, `l4` 16% — a **higher number is a stronger border**, `l4` the loudest in the app, `l1` the faintest. Read the value before the name; "is l1 the top?" is answerable from the alpha in one command and worth answering before acting on it.

**Read a CSS rule WITH its selector, never as a bare match.** Three times in one session: a `body[data-ds-dark-theme]` rule read as global, a dockkit float read as "the panel's reference", and an `elevation-stroke-color` definition traced across a JS string boundary (`lib/client.js` embeds CSS as string literals, so naive brace-matching walks out of the CSS and into JavaScript — parse the blob, not the file). The theme's CSS lives in `dsh-client-ui-theme/lib/client.js` as embedded strings; `grep` proves a rule exists, never which scope it applies to.

**Braces cannot appear in `STYLES` comments.** The panel tests extract a rule with a brace-free match, so a `{` in an explanatory comment truncates the captured rule and fails every assertion in the file — with an error that names a missing declaration rather than a comment. Same family as the backtick rule below: prose inside a template literal has escaping constraints the linter does not check.

Two files carry these values, and **neither is the checkout root**: token VALUES in `dsh-client-ui-theme/lib/client.js`, but token USAGE in the shipped app stylesheet at `dsh-web-frontend/dist/assets/index-*.css` — which is where the dockkit/float rules above were found. A token defined in the theme and only _consumed_ in the app is invisible if you search the theme for its name.

**Backticks inside `STYLES` terminate the template literal.** Third time this session. The parse error names a comment as the syntax problem ("Expected a semicolon"), and `vp fmt` does not catch it, so `vp check` passes on a file that will not compile — the symptom is a vitest transform failure with four test FILES failing on import. Recovery: `awk '/^export const STYLES = `/,/^`;$/' src/usage-ui.ts | grep -c '`'` must print **2**.

Token values live in `@deepseek-ai/dsh-client-ui-theme`'s `lib/client.js` (403 `--dsw-*` names). Search THAT file, not the checkout root: every package under the checkout is a symlink into the pnpm store, so `grep -r` from the root finds nothing — which is how this looked like an invented token for a minute.

### STANDING RULE: every UI addition or alteration must start from the host's built-ins

**Before writing or restyling any UI here, read what `@deepseek-ai/dsh-client-ui-primitives` already ships, and use it.** The kit is in our own `node_modules` (it exports `Switch`, `Button`, `Tag`, `Tooltip`, `Menu`, `Tooltip`, …). Its `lib/` also carries **one CSS module per component** — `Pill.module.css`, `MenuSurface.module.css`, `StateDot.module.css`, `Button.module.css`, `Tag.module.css`, `Divider`, `HoverCard`, `DisclosureRow`, `Toast`, `ShortcutKeys`, `Modal`, `Tooltip`, `Input`, `SegmentedControl`, `TextShimmer`, `PathLabel`, `Checkbox`, `RiskConfirmation`, `ConnectionIndicator`, `ImageLightbox`, `ImagePreview`, `MenuGroup`, `CodeCard` — which is the fastest inventory of the host's design language available: **a component we hand-roll is one whose CSS module we never opened.**

Cost of skipping the check, all paid for in one session: a hand-drawn 12px refresh arrow (the code even claimed _the host kit ships no icon set_ — **it ships ~150 icons**, including `IconRefreshOutlineRegular`); a hand-rolled divider; a hand-rolled state dot; a hand-rolled pill. Every one of them is smaller, wrong, and unthemed next to the built-in.

**And the corollary, which is the rule's real cost:** a claim in a comment about what the host does _not_ ship must be **verified against the kit before it is written**, because it freezes the decision. "The host kit ships no icon set" is why the arrow stayed hand-drawn. Naming a limitation you have not checked is the most expensive kind of comment in this repo.

### What the meter still hand-rolls (audit, 2026-10-08)

| we hand-roll | the kit ships | verdict |
| --- | --- | --- |
| `RefreshIcon` — 12px arrow SVG | `IconRefreshOutlineRegular` (1px stroke) / `…Medium` | **swap** — done, and the "no icon set" comment is gone |
| `.dsh-oc-usage-divider` | `Divider` (host has `_divider_6nhg2_39`) | swap |
| `.dsh-oc-usage-dot` | `StateDot` | swap |
| the trigger pill itself | `Pill` + `Pill.module.css` | candidate — a real refactor, not a substitution |
| the ring SVG | `WithoutRing` (an exclusion helper, not a gauge) | keep the ring; there is no ring primitive |
| footer links `<a>` | — | keep, they are anchors with a target |
| `~$186K` style sizes | `SizeText`, `Totals` | candidate, for the allowance row |

`WithoutRing` is the trap in this list: the name invites swapping the meter's ring for it, and it is a **context-exclusion helper** for a model menu. Read the component, not the name — the same lesson as `--dsw-elevation-panel`, and the reason both are written down.

### Why the card owns its boolean/list fields

The host UI kit ships **no** boolean control and no boolean/list/enum spec, so the card composes its controls from the primitives it does ship. Re-verified against `@deepseek-ai/dsh-client-ui-primitives` (`0.2.1-alpha.1`, source at `packages/client/ui-primitives/src`):

**Relied on from the platform:**

- `Switch` — the two-state toggle (`role="switch"`, `label` required, fully controlled). `settings-boolean-field.tsx` renders it, so the toggles in the card are the host's own control, not a look-alike.
- `Tag` — the "Overridden" badge in the settings card, and the meter panel's billing badge. Tones are `outline` / `solid` / `neutral` / `quiet` / `success` / `info` / `warning` / `danger`.
- `Button` (`variant="ghost" size="sm"`) — the reset control, which buys the `--dsw-alias-button-*` tokens plus hover / focus-visible / disabled states that an inline-styled `<button>` did not have.
- `SettingsForm`, `SettingsFormModel`, `settingsTextField`, `settingsNumberField` — the form shell, the staging model, and the text/number draft specs.

**Ours, and why:**

- The field _frame_ (label + badge + reset + hint/message). `SettingsFieldProps` documents the shape, but `SettingsValueField` renders an `<input>` and its `fields.module.css` classes (`css.field`, `css.reset`, `css.hint`, `css.invalid`, …) are private to `ui-primitives`. `settings-field-shell.tsx` is therefore a structural clone in inline styles, mirroring `SettingsValueField`'s markup and its "an invalid draft replaces the hint" rule.
- The enum control — a native `<select>`. `SegmentedControl` is **not** a substitute: it is a `role="tab"` tablist whose every tab names the panel it controls, i.e. for switching modes (its only non-primitive use is `ui-settings-models`'s add-mode switch), not for editing a stored value. `Menu`/`MenuItemButton` is for actions (`ui-workspace`'s Fork/Rename/Archive/Pin). The platform's own settings pages use `SettingsValueField` for everything non-secret — and for a _stored enum_ the harness itself renders a **native `<select>`** (`ui-settings-models`'s `ProviderEditor` protocol picker), down to naming the empty option so a screen reader does not announce a choice with no identity. `settings-choice-field.tsx` mirrors that.

**Styling rule — use the host's tokens, never invent one.** The host's only variable family is `--dsw-*` (`--dsw-alias-label-*`, `--dsw-alias-state-*`, `--dsw-alias-border-l1…l4`, `--dsw-alias-bg-layer-*`, `--dsw-radius-*`). An invented name such as `--color-fg-subtle` resolves to nothing, so its hard-coded fallback renders instead and the control ignores the theme entirely — dark-theme greys inside a light theme. That is exactly how the enum control first shipped, reading as a bare OS dropdown in the middle of the design system. `fields.module.css` is the reference for the frame, and the metrics matter as much as the colours: a select sitting beside `SettingsValueField` rows must match `.input` (34px, `--dsw-alias-bg-layer-3`, 13px, `0.5px solid --dsw-alias-border-l4`), not a text field's own look. Tests in `settings-choice-field.test.tsx` and `settings-field-shell.test.tsx` assert `--dsw-alias-` is present and `--color-` absent, so it cannot silently regress.

- The list draft conversion — the platform ships no list spec, so `settings-fields.ts` supplies one.

`plugins.bundle.config` is rendered with `{ view }` only — the host-owned `form` (state + mutate) is passed to `plugins.item` and `plugins.row.config`, **not** to bundle config — so the card owns its scope and `SettingsFormModel` itself. If the host ever ships a boolean or enum field, delete the matching file here and render that instead.

Tests — 541 deterministic cases in 29 files; polling helper instead of sleeps; each file restores `globalThis.fetch`/env in `afterEach` (the hook must live in every file, not just the old monolith). `pnpm run test:coverage` enforces a ratchet at **95 / 90 / 93 / 95** (statements / branches / functions / lines, with per-file floors on `responses-provider`) — it sits just above the measurement, so it fails only when coverage drops:

- Host behavior split by concern: `session` · `config` · `fetch-patch` · `lifecycle` · `manifest` · `usage` · `catalog` (27) · `session-cost` · `models-discovery`.
- Host units asserted directly, because every other module narrows through them: `guards` (12) · `config-values` (15) · `cordis-context` (11) · `debug` (5). Each case pins the shapes the unit must REJECT as well as the ones it accepts — an over-accepting guard mis-shapes a host object silently.
- Routing: `responses-routes` (10) split table · `responses-provider` (26) the mount — and the stand-in host it runs against **reproduces all four collisions**, so four more of those cases assert the stand-in REFUSES the shapes the old mount passed.
- Client: `settings-page` (29) card + register + **unload** · `settings-field-shell` (7) row chrome · `settings-boolean-field` (3) toggle · `settings-choice-field` (7) enum · `usage-pill` (23) gating + copy/failure parsing · `usage-pill-mount` (20) **the pill's poll loop, switch re-reads, retry and dismissal, really mounted** · `usage-panel` (31) trigger + panel · `client-bundle` (4) bundle boundary.
- The half of the meter that was untested: `go-discovery` (61) credential policy · `usage-service` (32) + `usage-contract` (19, 100%) the Host service and its parsers · `tool-fallback` (25) + `turn-store` (12) the free-tier rewrite and the ALS store.
- `test/test-helpers.ts` — shared fixtures: mock streams, capture fetch, predicates, `createMockContext`.
- `test/primitives-stub.tsx` — stand-in for the host UI kit; keep it behaviourally faithful to the real primitives (trimmed drafts, empty clears).

Supporting files:

- `scripts/name-client-bundle.ts` — renames `vp pack`'s `.cjs` output to `lib/client.js` (DSH loader requires `.js`).
- `scripts/regenerate-catalog-shim.ts` — writes `src/catalog-data.ts` from models.dev through the plugin's own parser. Runs offline with `--from <path>`, exits 1 when the shim is stale, rewrites with `--write`.
- `vitest.e2e.config.ts` · `test/e2e/` — the opt-in end-to-end suite (`pnpm run test:e2e`), collected only by that config so `pnpm test` stays offline and deterministic. `opencode-live.e2e.ts` asserts the live `/models` enrichment and `/usage` payload shapes; `patched-fetch-headers.e2e.ts` proves the outgoing header set over a real socket; **`protocol-routing.e2e.ts` asks the gateway which endpoints actually recognise each shipped model** — the one thing a stub cannot do, because the unit tests read the very mapping they are meant to check. **Its free-tier case pins the ROUTE, not the model**: it asserts `403 FreeTierError`, and that 403 is the `stream`+`read`/`bash` gate refusing the probe — the request carries neither. So the assertion cannot distinguish "recognised" from "refused"; what actually pins the route is the wrong-endpoint cells asserting `500`, which only happens when the gateway parsed the model. A test that told those apart would send `stream: true` plus the two schemas and assert a real completion — and would then behave identically on **both** planes, since the gate is the same. All gated on `OPENCODE_E2E=1`, and each keyed block skips without its key — which is why the CI `e2e` job is green on fork PRs.
- `cordis.patch.yml` — default plugin row (`id: dsh-opencode-patch`); header comments are the headless-config reference.
- `scripts/check.ts` — CI/release gate: lib freshness, peer ranges, harness surface contracts, secret scan, consumer install+load, workflow guards, identity/title consistency, client budget. `scripts/publish-scoped.ts` — publishes/mirrors the scoped aliases with idempotent skip-if-exists guards.
- `.github/workflows/` — `ci.yml` has three jobs: **check** (push/PR/schedule — check + test + build + `scripts/check.ts` + the coverage ratchet, uploading the report), **catalog** (regenerates `src/catalog-data.ts` against models.dev and fails when it is stale), **e2e** (the live gateway). `release.yml` (tag `v*.*.*`) queues per tag instead of cancelling — see the release notes below — packs and hashes the tarball, verifies, then OIDC-publishes the primary + both scoped aliases and confirms every target is readable. `dependabot.yml` keeps both ecosystems current, because the release path is actions and cannot be exercised until it matters.
- `README.md` consumer docs · `CONTRIBUTING.md` dev conventions + release · `CHANGELOG.md` per-version record (release-please-owned; do not hand-edit).

## Commands & policies

```sh
pnpm install     # install dependencies
pnpm run build   # vp pack -> lib/index.mjs + lib/index.d.mts + lib/client.js
pnpm run check   # zero *errors* required; zero warnings is the goal (no debt)
pnpm run test    # deterministic offline tests, fully green required
pnpm run test:coverage   # the same run with the coverage ratchet enforced
pnpm run catalog:shim   # regenerate src/catalog-data.ts from models.dev
pnpm run test:e2e   # opt-in live gateway suite; no-op unless OPENCODE_E2E=1
```

- Host code needs a **restart**: the base bundle ships `hmr root: []` (config watches only) and a `link:` package resolves through `node_modules` (ignored), so the host never re-imports `lib/index.mjs` after boot — restart `dsh web` after every `pnpm run build`, or the profile runs the old module and `dsh-settings` serves a stale/absent config schema. `lib/client.js` is re-served per page load, so a browser refresh suffices for client-only changes.
- Release: conventional commits on `main` → release-please opens the version + `CHANGELOG.md` PR → merging it tags, and `release.yml` publishes via OIDC (primary + scoped aliases). Never hand-edit `CHANGELOG.md`.
- DSH Web profile wires the build: `~/.dsh/profiles/web/package.json` deps + `bundles` use `dsh-opencode-patch` (`link:../../../dev/dsh-opencode` only for local dev).
- Hygiene: never hardcode `ses_…`/keys in src/tests/git; `lib/` gitignored; `OPENCODE_SESSION_ID` env override only.
- **Client bundle ceiling — a TRIPWIRE, not a budget (the owner says so).** `lib/client.js` must stay under **75 KiB** (`scripts/check.ts`). It sat at ~58.5 KB when this note was written, the gate was 64 KiB then too, and the bundle is **65,529 bytes** after this round — at which point the number had stopped answering the question it was built for. What it really watches is a **dependency getting bundled instead of left external**, and that arrives as a jump of thousands of bytes, not as creep; the ceiling was raised rather than leave the next copy string tripping a guard about bundling. Prefer platform primitives over hand-rolled controls (swapping our inline-styled reset `<button>` for the platform's `Button` atom _shrank_ the bundle by 160 bytes), and ask whether a knob belongs in the UI at all before writing copy for it. **Comments ship in the bundle** — long rationale belongs here, not in client modules. The entry's own comments ship too: measured 2026-10-07, **7 of `settings-page.tsx`'s 8 blocks survive into `lib/client.js`**, so trimming that file reclaims bytes (the earlier note claiming otherwise was wrong). Comments are ~13.7 KB of the payload, which makes them the cheapest lever there is — and the reason the documented one worked. Measure with `wc -c lib/client.js` before and after. **Two kinds of shrink, only one of which is free**: deleting CSS no component renders any more is pure win (1.9 KB came out of the bars and cards the panel dropped), whereas cutting prose to fit a number moves knowledge out of the file that owns it.

  **Do NOT trim prose or comments to stay under it.** The number exists to catch an accident — a dependency silently bundled instead of left external — and that arrives as a jump of _thousands_ of bytes. Measured three times in one session with the bundle within ~500 bytes of the ceiling, the response was to shorten a comment that explained WHY a surface is translucent, on the reasoning that "comments ship in the bundle". That is optimising against the tripwire: it protects against a 4 KB mistake, and it made the file that owns the knowledge worse to defend a number nobody asked for. Write the full explanation where it belongs; if a genuine dependency jump ever shows up, the gate fires and that is the moment to act.

  **When it exceeds, RAISE IT — that is the owner's standing instruction** ("可以修改超过的"). The gate must never be answered by deleting something. It now names both causes and both responses in its failure message, because the message is where the next session meets this: kilobytes over → a dependency got bundled, add it to `deps.neverBundle`; a few hundred bytes of copy or comments → raise `CLIENT_BUDGET` and move on.

The ceiling is therefore **75 KiB**, sitting ~3 KB above the real working size rather than a few hundred bytes above it. At 72 KiB it fired on a restored comment — the exact false positive it exists to avoid. A dependency regression lands _kilobytes_ over (the bundled React alone is 40+ KB), so the extra slack costs no signal and buys back the prose in the files that own the knowledge. The number is only load-bearing for one failure mode; do not let it become a second thing to optimise.

- **Dead CSS is shipped weight**: `STYLES` is a template literal in the bundle, so a rule nothing renders still costs bytes forever. `cbe7280` removed the panel's progress bar and its three quota cards from the JSX and left ~2.4 KB of their rules behind. Grep the class names in `src/usage-*.tsx` before assuming a rule is live.

## Release automation: the decisions that are load-bearing

The release path cannot be exercised until it matters, so each choice below encodes a failure that already happened or a way it could.

**`release.yml` QUEUES per tag and never cancels.** `cancel-in-progress: false`, grouped on the ref name. This looks backwards — CI cancels, release should not — and the reason is specific: a re-run of the same tag is the RECOVERY path for a transient npm fault, because the publish steps skip any version already on the registry. Cancelling the first run holds a half-published registry and kills the second before it can finish it, so neither run completes. That is exactly how v0.7.0 was lost. Cancelling would convert every recoverable failure into an unrecoverable one.

**Every job carries `timeout-minutes`.** GitHub's default is six hours. A hung test in a suite that runs in seconds should fail in seconds; a release whose ten-minute npm polling loop has wedged should fail rather than hold its concurrency group open forever.

**The tarball is packed, hashed and kept.** `npm pack` writes the real tarball, `shasum -a 256` records it, and the job asserts `lib/index.mjs` and `lib/client.js` are inside before anything is published. npm's provenance attestation proves WHERE the package was built and by whom; it does not let a consumer confirm they received those exact bytes. This does, from the same artifact every registry receives.

**`ci.yml` runs three jobs, and the nightly one is not optional.** `check` (push/PR/schedule), `catalog` and `e2e`. The `catalog` job regenerates `src/catalog-data.ts` from models.dev and fails when it is stale — the one check that would have caught the nine mis-routed models, since no unit test can: they all read the very mapping they are meant to verify. The schedule matters because models.dev moves without a commit.

**`scripts/check.ts` gates the automation itself.** A guard nobody reads is a guard that silently stops guarding, so the gate asserts the wiring exists: a `catalog:shim` script AND a CI step that RUNS it (matched as a command, not as a string — the failing step prints the command it ran, so a plain grep would match its own error message), the coverage provider installed at a version matching the bundled runner, thresholds actually set, every job bounded, release not cancelling, the tarball hashed, and dependabot covering both ecosystems. Each was verified by sabotaging the workflow and watching the gate fail.

## Key resolution: two methods, and which one wins

The plugin can learn a credential two ways, and both exist on purpose:

1. **Captured from a live request** (`patchFetch` → `extractApiKeyFromHeaders` → `recordCapturedApiKey`). This is the rotation-proof source: whatever the adapter actually sent is, by definition, the key that works. Stored three ways — by provider id, by **tier** (`go`/`zen`), and as the most recent.
2. **Resolved from declared configuration** (`discoverGoConfig` reading other rows' `apiKeyEnv`/`apiKey`/`headers`, then `ctx.get("credentials").resolve(ref)`, then `process.env[ref]`). This is the cold-start source: nothing is captured until a turn has actually gone out, so the first `/usage` poll of a fresh boot has only this.

Rules that keep the two from fighting:

- **The credential reference is never a row setting.** `effectiveGoKeyRef` reads the composition's `apiKeyEnv` and falls back to `OPENCODE_GO_API_KEY`. A `usageKeyEnv` knob used to exist and was removed: it duplicated the provider row's own `apiKeyEnv`, i.e. asked the user to re-state a decision they had already made in the place that owns it. The capture path makes that duplication unnecessary anyway. The schema is permissive, so a row that still sets it is ignored rather than rejected — but it does nothing.
- **The tier is derived from the key prefix first, then the URL, and only last the provider id** (`tierForRequest`). The prefix is intrinsic to the credential; the URL is observed; the provider id is _user-defined config_ and may be named anything — so it must never be the sole reason a lookup succeeds.
- **Every capture lookup falls back to the tier**, so a renamed provider route cannot hide a key that is already known to work.
- **A placeholder is never captured.** The DSH adapter emits `Bearer unused` / `undefined` / `null`; recording one would overwrite a working key and every later lookup would re-inject the dummy (`isPlaceholderApiKey`).
- **And a placeholder is never DISCOVERED, either** — this was a live bug, and the worst one this section has. `readProviderRow` copied a row's `authorization` header into `literalKey` with none of the check `recordCapturedApiKey` applies, and since `literal` is the FIRST step of both `auto` and `configured`, a row carrying `authorization: Bearer unused` — exactly what this repo's README tells users to write on a keyless route — outranked a working stored credential AND a working captured key. The meter then authenticated as `Bearer unused` on every poll, and the 401 read like a missing subscription. Reproduced before fixing: `discoverGoConfig` returned `literalKey: "unused"`. One `usableCredential` guard now rejects placeholders and blank-but-indented values on every literal path. **A declared value that is not a credential must not become the credential**: `apiKey: "   "` is what a YAML secret looks like after someone blanks it, and it passed a bare `length > 0` the same way. `keyEnv`/`baseURL` are deliberately NOT trimmed — they are references, and rewriting one would make the discovered value disagree with the row that declared it.
- **The tier filter applies to the route-scoped lookup too.** `getCapturedApiKey(provider, "go")` returned the provider's captured key without consulting the tier, while the other two paths filtered correctly — so an `oc_sk_…` key seen while the Go route was in play reached `/usage`, and it is first in `auto` and `request`. `capturedKeysByProvider` now stores `{key, tier}` and all three lookups share one `tierSatisfies` rule. Naming a route is a PREFERENCE, not a licence to ignore the tier; and `unknown` stays permissive in all three, because an unclassified key is one we never identified, not one we proved to be the other tier.
- The Go `/usage` endpoint **rejects Zen keys** (`oc_sk_…`), which is why the tier filter exists at all: never hand the Go endpoint whatever key happens to be newest.
- **Which source wins is the user's choice** (`keySource`), because there is no single correct answer: `auto` (composition → captured → credentials → any captured) suits most setups and is byte-for-byte the original precedence; `request` promotes both captured steps, for setups that rotate keys; `configured` demotes them, for pinned/CI setups. `KEY_SOURCE_ORDER` is the whole policy — a `Record<KeySourcePolicy, readonly KeySourceStep[]>`, so a new policy is one line and a new step is a type error. The policy reaches **both** consumers: `patchFetch`'s Authorization fallback and the meter's `resolveGoApiKey` (via `UsageOptions.keySource`).

### A fallback that satisfies a TYPE is not a reading (2026-10-08)

The panel showed three confident `0%` rows, all counting down from `<1m`, beside a "Zen balance ready" row. Three windows with different schedules cannot all reset in under a minute — that inconsistency is what gave it away.

Cause: `zenOverflowUsage` (the fallback when `/usage` answers `403 EntitlementError` and a Zen balance is configured) has to return three `UsageWindow`s, and the only way to fill them without inventing a number is `percent: 0` with `resetsAt: new Date().toISOString()`. `0%` plus "resets now" is what a **type floor** looks like once something renders it. Verified against the live API on the same key minutes later: **2% rolling, 1% weekly, monthly resetting 7 Nov** — real figures the panel had thrown away.

**The payload was never in doubt.** The public `/zen/go/v1/usage` is exactly `usage.{rolling,weekly,monthly}[{status, percent, resetsAt}]` — confirmed by fetching it, not inferred. (The vendor's _console_ reads a different, richer shape internally: `meters.{fiveHour,week,month}` with `limitMicroCents`/`usedMicroCents` and no `percent`. Do not "fix" our parser toward that one — the public endpoint is the contract, and `parseGoUsage` already matches it.)

The general rule, and the fourth instance of this shape in this file: **an inference is honest, the numbers around it may not be.** `zenOverflow` is derived from the 403 and stays; the three percentages were never knowable, so `GoUsage.quotaUnavailable` now marks the reading and the panel draws **no window rows** for it. A type is a promise about shape, never a licence to fill it.

### How the "console key" actually works — the CLI's own auth module (2026-10-08)

The account switch that broke the meter was a credential-class switch, and the mechanism is now read from `sst/opencode`'s `packages/opencode/src/auth/index.ts`. `auth.json` holds exactly three shapes, discriminated on `type`:

- **`oauth`** — `{type, refresh, access, expires, accountId?}`. This is what `/connect` writes for the `opencode` provider: the **console identity**. `access` is a short-lived bearer the CLI spends as `Authorization` against the console plane, and it EXPIRES — the SPA's own client posts `/auth/refresh` and treats any non-200 as "not logged in" silently. A meter reading this credential class sees `401`s that arrive in bursts when the access token lapses and a refresh lands.
- **`api`** — `{type, key, metadata?}`. The classic API key (`sk-…` Go / `oc_sk_…` Zen). What our tier classification (`tierForRequest`) is built on.
- **`wellknown`** — `{type, key, token}`. Third-party gateway credentials.

Two consequences, both verified against the live plane:

- The console plane's auth failure signature is **`{"error":{"type":"server_error","message":"Invalid credential"}}`** — `server_error`, not `AuthError`, for ANY bearer (real-shaped `oc_sk_…`/`sk-…` dummies included). Its only live route found so far is `/inference/v1/models` (200-with-JSON-when-authed); `/inference/{v1/}chat/completions|responses` 404. So a console-credential meter poll would fail with `server_error`, which `parseFailure` currently reports as a generic failure — correct, but a dedicated signature would let the panel say "re-run /connect".
- The CLI's autoload gate prunes **paid** models when no credential exists and keeps **free** ones (`cost.input === 0` survives), passing `apiKey: "public"`. Which means a no-credential DSH session sees a Zen-flavoured free list through the CLI's own loader too — our enrichment appending canonical rows agrees with that shape rather than fighting it.

The meter's existing rule stands, now with the mechanism spelled out: the console credential is a BROWSER session (cookie or its OAuth bearer), the API planes speak API keys, and `/zen/go/v1/usage` — the meter's endpoint — rejects the former. What an account switch breaks is the credential class, not the key's validity.

### The balance question, settled by reading the vendor's own code (2026-10-08)

The meter cannot show a balance, and this is now verified at the SOURCE level, not just by probing:

- The console's balance is `BillingTable.balance` (micro-cents), read by `Billing.get` in `sst/opencode`'s `packages/console/core/src/billing.ts`. That module's exports are `fn()` server functions — a zod-validated in-process pattern — not HTTP routes. The SPA's generated SDK carries prefixes `/api/billing` / `/api/usage`, but those are served through the web server's SSR `RequestContext` (session cookie injected server-side; `SessionMiddleware` accepts `console_session` cookie OR Bearer). They are not reachable with an API key: `/api/billing/account` on opencode.ai answers **404 text/html**, not 401 JSON, while the genuinely-real `/zen/go/v1/usage` answers **401 application/json**. A real-but-unauthorized route and a nonexistent one are distinguishable by content type.
- Probe re-measurement, both planes: zen `/v1/{usage,billing,balance,me,account,key,keys,info,workspace}` all 404; go `/v1/{usage,billing,balance,limits,plan,subscription,account,quota,credits,key/info}` — only `/usage` exists. Every balance-ish path is absent, and the vendor's own client never calls one.
- **Second SPA trap, on a second host**: `api.opencode.ai` answers **200 for every path** with a 9-byte `Not Found` body — including `/totally-bogus-path-xyz`. The "SPA answers 200 for everything" hazard in the next section applies to `api.opencode.ai` too, and a status code alone cannot distinguish a real route there. Control comparison (real route → 401 JSON; fake route → 200 `Not Found`) is the only reliable probe on both hosts.

Consequence for the meter: the honest signals remain exactly two — the live window percentages (Go), and the failure path when the gateway actually refuses a request. The monthly allowance table (`go-limits-data.ts`) is the only dollar figure the API surface can support, and it is a published total, not a balance.

### Two names, one package — and the card was registered under the wrong one

The bundle registered itself under FOUR module ids, one of which was `@viztor/dsh-opencode` — the RETIRED wrapper, which ships no `lib/client.js` at all and whose row forwards to `dsh-opencode-patch`, so its page is served by this very bundle under another id. Meanwhile **no card was registered under `@viztor/dsh-opencode-patch`**, the name new installs actually get. The aliases list was `{PKG, LEGACY_PKG, LEGACY_NS}` — the current scoped name simply was not in it.

Now `{PKG, SCOPED_PKG, LEGACY_NS}`: both names the tree is published as, plus the pre-rename cordis **row id** (`dsh-opencode`), which is a namespace rather than a package and must keep working. The loader ids are the same three. `SCOPED_PKG` is the canonical scoped name; `publish-scoped.ts` publishes all three npm names but its deprecation notice and README now point at the canonical one, because the message a user reads on the registry is the one place that should not offer a choice between two spellings of the same package.

## OpenCode endpoints (probed, not guessed)

**Zen serves four classes of model, and they fail differently.** Probe any model with a keyless POST — the response identifies its class:

| response | class | meaning |
| --- | --- | --- |
| `401 AuthError` "Missing API key." | **paid** | recognised, needs a key (`claude-*`, `gpt-*`, …) |
| `403 FreeTierError` "…can only be used from within OpenCode" | **free-tier gated** | needs the OpenCode identity — _what the plugin exists for_ |
| a real completion | **unmetered** | needs nothing at all (`space-bunny-free`) |
| `401 ModelError` "…is not supported" | unknown | not a model on that route |
| `500 Internal server error` | **wrong format** | served on the other endpoint (next section) |

`space-bunny-free` is the unmetered class: it returns a full `chat.completion` with **no key, no `x-opencode-client`, no User-Agent**, and it still succeeds with the whole header set injected. **Our header restoration is additive, not a gate**, so nothing has to special-case a model that needs no auth — verified both ways. Worth knowing though: `fetch-patch.ts` sets `Authorization` whenever the caller omitted it or sent a dummy (`Bearer unused`/`undefined`/`null`). On an unmetered model that is unnecessary — the call would have worked without it — but it is what rescues the adapter's placeholder for the gated class, so it stays.

### The free-tier gate: `stream:true` AND `read`+`bash`, on BOTH planes

Measured 2026-10-07 on both planes, same account, both credentials. Five runs per cell:

| `(stream, read+bash)` | legacy `/zen/*` | console `/inference/*` |
| --------------------- | --------------- | ---------------------- |
| **both**              | **200** (5/5)   | **200** (5/5)          |
| `stream` only         | 403 (5/5)       | 403                    |
| `read`+`bash` only    | 403 (5/5)       | 403                    |
| neither               | 403 (5/5)       | 403                    |

**The gate is conjunctive and it is the same on both planes.** `stream:true` alone 403s; `read`+`bash` alone 403s; `read`-only 403s; `bash`-only 403s; a dummy tool 403s. Only the conjunction returns 200. It applies to the **gated-free class only**: unmetered models (`space-bunny-free`) answer 200 in every cell, and paid models never produce this 403 at all.

Consequences:

- **`tool-fallback.ts` is half the gate and always necessary.** The `stream:true` half is free: DSH's adapter contract is stream-only — `abstract stream(options)` is documented as "the only required method" (`packages/llm/llm/src/index.ts`), and `llm-pi-ai` calls only pi-ai's `streamSimple`. So DSH satisfies it unconditionally and the plugin never sets it. **Between them the plugin satisfies the whole gate.**
- **The header restoration is not what unlocks the free tier on either plane.** Eliminated by measurement: `User-Agent` (the plugin's own, and the CLI's exact string with its `ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14` suffix — both 200), `x-opencode-request` as a message id, `x-opencode-session-id`, `ses_`-prefixed ids, the console `x-opencode-org-id`, and the tools on their own. Session _registration_ is not a factor either: the session id is only read, for sticky routing and usage attribution.

**How this was found, because the obvious method is worthless here — and it lied twice.** The 403 says "can only be used from within OpenCode", which sends you looking for a missing client signal; every one of those hypotheses is false. What settled it was running the real CLI against a gated model (it succeeded), putting a logging reverse proxy in front to capture the request byte-for-byte, then bisecting that body until one field flipped 403→200.

Two wrong conclusions were recorded before the right one, and both came from the same error — **generalising from one plane, or from one moment**:

1. "`stream:true` is the discriminator" — true, but `read`+`bash` was also required and had been missed.
2. "the legacy plane's gate is not satisfiable" — **false**. It was measured only with the plugin's own `User-Agent` and, worse, during a window when the same request was returning 403 for an unidentified reason; the identical request returned 200 minutes later and 5/5 after that. A single-probe matrix is not a measurement of a gate.

**So: verify a gate across planes, across credentials, and repeat it.** A 403 sampled once is a fact about that instant, not about the rule.

**The free tier was never broken, on either plane.** What an account switch actually breaks is the **meter** — the console token is rejected by the legacy `/zen/go/v1/usage` the plugin still points at.

**The free tier is split across TWO protocols, and the protocol is route-level.** `ModelProtocolUnsupported` (a vendor 400) means the request reached the gateway on an endpoint that does not serve that model. Probe each model with a keyless POST: the endpoint that _recognises_ it answers `403 FreeTierError` ("OpenCode's free tier can only be used from within OpenCode" — the rule the header restoration exists to satisfy), while the endpoint that does not answers `500 Internal server error`. Measured 2026-10-04 against `https://opencode.ai/zen/v1`:

| endpoint | models |
| --- | --- |
| `/chat/completions` (`openai-completions`) | fledge-alpha-free · ling-3.0-flash-fin-free · ling-3.1-flash-free · longcat-2.5-preview-free · **mimo-v2.6-flash-free** · nemotron-3-ultra-free · nemotron-3.5-lightning-free · **space-bunny-free** (unmetered) |
| `/responses` (`openai-responses`) | **muse-spark-1.3-contributor-free** — the only one |

Because `llm-pi-ai`'s `modelFields` is `{name, contextWindow, maxTokens, input, reasoningEfforts, compat}` — **no per-model `api`** — a route carries ONE protocol for all its models. Muse therefore **cannot** share the `opencode` route with the other free models: it needs its own route (`opencode-responses`, `api: openai-responses`) and that route must be listed in the plugin's `providers` or the free-tier headers never get injected and the 403 persists. The same applies to any future model that lands on `/responses`.

**Checked twice, because "surely a provider can mix formats" is the natural assumption.** It can mix _routes_ — `llm-pi-ai`'s `providers` is `z.dict(profile)`, so one row declares N routes each with its own `api`. That is what `opencode` + `opencode-responses` are: two routes on the SAME provider row, not a new provider. But a single _route_ cannot mix formats: `modelProfile = z.object({ id, ...modelFields })` and `modelOverride = z.object(modelFields)` both exclude `api`. OpenCode itself is under the same constraint — models.dev's `opencode` provider declares `npm: @ai-sdk/openai-compatible` + `api: https://opencode.ai/zen/v1` for all **116** models, and no model entry carries a format field. There is no per-model mechanism to copy; route-level is the only lever either side has.

**Keyless probing cannot separate the endpoints for a PAID model — re-measured 2026-10-06.** This note previously said a keyless POST to the wrong format gives `500` and the keyed one gives the true `400 ModelProtocolUnsupported`. That holds for free-tier models and is **false for paid ones**, where the gateway decides about credentials _before_ it looks at the format. Measured keyless across all three endpoints:

| model class | its own endpoint | a wrong endpoint |
| --- | --- | --- |
| free-tier gated (`muse-spark-1.3-contributor-free`) | `403 FreeTierError` | `500 Internal server error` |
| unmetered (`space-bunny-free`) | `200`, a real completion | `401 ModelError: … not supported for format …` |
| **paid** (`claude-*`, `gpt-*`) | `401 AuthError` | **`401 AuthError` — identical** |

So a suite asserting "the wrong endpoint 500s" would pass **vacuously for every paid model**, which is most of what this plugin routes. Two consequences, both now pinned by `test/e2e/protocol-routing.e2e.ts`: the paid cases are keyed and skip without `OPENCODE_API_KEY`, and the keyless cases target the free-tier and unmetered classes where the asymmetry is real.

Also measured, and worth knowing before deriving anything from a probe: **`space-bunny-free` answers both `/chat/completions` and `/messages` with a real completion.** It is genuinely format-agnostic, so a probe can _reject_ a wrong protocol for it but cannot _derive_ its protocol. Nothing routes it to `/messages`, which is correct rather than required.

**With a credential the discriminator is exact, and it is `ModelProtocolUnsupported`.** Measured on the account this was developed against: `grok-4.7` (`@ai-sdk/openai`) answers `200` on `/responses` and `400 ModelProtocolUnsupported` on the other two. That is the vendor naming the mismatch, so it is the assertion the keyed cases make — and it is why they are worth arming rather than skipping.

Two further facts that cost time to discover, both measured:

- **Each endpoint has its own auth convention.** `/messages` is the Anthropic Messages shape and reads **`x-api-key`** (plus `anthropic-version`); `/chat/completions` and `/responses` read `Authorization: Bearer`. Sending `Bearer` to `/messages` answers `401 AuthError "Missing API key."` — the header is never read — which reads like a bad key rather than a bad header. A probe using one convention everywhere concludes the model is unreachable.
- **An account may have no paid access at all.** Every paid model then answers `403 Model access is disabled` on _every_ endpoint, and that gate runs **before** the format check — so nothing about routing is observable, keyless or keyed. The e2e SKIPS in that case rather than failing: the account's entitlement is not this plugin's contract. `claude-*`, `gpt-5.4` and `kimi-k2.5` were all in that state here, while `grok-4.7`, `qwen3.8-max`, `minimax-m3` and `deepseek-v4.1-flash` were reachable.

**How OpenCode itself does it** (read from `sst/opencode`'s `packages/opencode/src/provider/provider.ts`) — it is **one provider with a per-model endpoint**, which is the shape DSH lacks:

```ts
// one npm for the whole Zen provider…
npm: model.provider?.npm ?? provider.npm ?? "@ai-sdk/openai-compatible"
// …and the ENDPOINT is picked per model at the SDK-call layer:
if ("endpoint" in model.api) {                     // github-copilot loader
  if (model.api.endpoint === "responses" && sdk.responses) return sdk.responses(modelID)
  if (model.api.endpoint === "chat" && sdk.chat) return sdk.chat(modelID)
}
async getModel(sdk, modelID) { return sdk.responses(modelID) }   // openai / meta / xai: always Responses
```

So `createOpenAICompatible` exposes both `.chat()` and `.responses()`, and opencode chooses between them per model — keyed by `api.endpoint` or the provider's own loader. `cloudflareGatewayNpm` shows the same pattern for npm (model-id prefix → native SDK). **The protocol is a per-model decision there; in `llm-pi-ai` it is a per-route decision**, and that is the whole gap.

Consequence: the same `llm-pi-ai` row carrying `opencode` + `opencode-responses` is the closest DSH equivalent — two _routes_ on ONE provider row (`providers` is `z.dict(profile)`), not a second provider.

**The plugin declares that route itself, in its own layer.** `cordis.patch.yml` inserts **only** the `dsh-opencode-patch` row; the Responses route is mounted in-process by `responses-provider.ts`, so the user configures nothing and their own `llm-pi-ai` row is untouched. Two facts force that shape:

- **A patch replaces a row's whole `config`**; it does not merge. `vendor/include/src/index.ts`'s `applyEntryPatches` does `target[key] = value`. So the route cannot live on the profile's `llm-pi-ai` row and survive the profile's own `providers:` block — and a second row in this layer would be replaced anyway if the profile named it.
- **The plugin must CLAIM the route it declares.** `DEFAULT_PROVIDERS` therefore carries `opencode-responses`: an unclaimed route gets no session header, no origin headers and no key injection, and the request then fails 403 looking like a model problem. `test/config-values.test.ts` asserts every route the layer declares is claimed — that seam is otherwise silent.

**What is NOT possible, and why "one provider id, two formats" is not a thing here.** `llm.registerAdapter(providers, adapter)` throws `DUPLICATE_ADAPTER` for any route that already has one, so a plugin cannot take over `opencode` to dispatch per model. And nothing in `llm` carries a per-model protocol: `LlmModelInfo` is `{provider, id, name, description?, inputModalities?}`, `LlmModelDiscoveryRequest`'s `protocol` describes the _endpoint being interrogated_, and `modelFields` has no `api`. The format is a property of the route, full stop. Dispatch-per-model exists only inside OpenCode's own SDK layer (above) — precisely the layer `llm-pi-ai` does not expose.

### How the split is actually bridged: re-dispatch, not translation

`llm.stream` is a **waterfall** — `streamWithRegistration` calls `ctx.waterfall(this, 'llm/stream', options, () => this.adapterStream(options, prepared))`, and its doc says "`options.provider` selects the adapter". So a listener can take the call over (that is how `llm-replay` works: `ctx.on('llm/stream', (options, _next) => replay(options))`).

Note the fallback **closes over the original `options`** (`() => this.adapterStream(options, prepared)`), so `next(modifiedOptions)` would NOT reach the adapter — the only lever is to skip `next()` and dispatch again yourself:

```ts
const redirect = responsesRouteFor(providerKey, options.model);
if (redirect !== undefined)
  return ctx.llm.stream({ ...options, provider: redirect });
```

`stream-hook.ts` does exactly this; `responses-routes.ts` holds the table. The redirected call re-enters the same hook with the target route already set, so `responsesRouteFor` is **guarded on the source route** — without that it recurses until the stack runs out. Returning immediately also keeps the session/debug/turn-state work to exactly one pass (the redirected call's own).

This is the shape to reach for: **re-dispatch to a route whose `api` already names the format**, so DSH's own adapter speaks it and nothing about the response is rewritten. A transport-level protocol bridge (rewriting `/chat/completions` → `/responses` and translating the SSE back) was the alternative and is strictly worse — the response side cannot be verified without a live credential, so every fixture would be a guess.

**A second `llm-pi-ai` ROW does not work — `DUPLICATE_FLOW`.** The tempting way to make the plugin own the route is to insert a second row of the same package in this layer. It fails: `apply()` in `llm-pi-ai` calls `ctx.inject(['authorization'], (authorized) => registerPiAiFlows(authorized, auth))`, and `registerPiAiFlows` loops over `catalogProviderIds()` — the **installed** catalog, identical for both instances — calling `authorization.registerFlow({ key: recordKeyFor(providerId), … })` for each. That service throws:

```ts
if (this.flows.has(flow.key)) {
  throw new AuthorizationError(
    `an authorization flow for "${flow.key}" is already registered`,
    "DUPLICATE_FLOW"
  );
}
```

Its own API docs state the rule: "One flow per key: two plugins claiming the same key would each write a record in their own format." The flows are registered unconditionally, and — as the measurements below show — **the flows are the smallest of the four problems a second instance has**, not the only one. Do not read this as "isolate `authorization` and you are done": that alone still fails `DUPLICATE_DIRECTORY`.

**So the plugin mounts the host's own `llm-pi-ai`** (`responses-provider.ts`) — **and that mechanism is verified against the real harness**, not a stub: a real `@deepseek-ai/cordis` app, a real `LlmRuntime`, a real `llm-pi-ai`, with the host's own instance already mounted on its own entry.

```
directory   before→after: 41 → 41        (no DUPLICATE_DIRECTORY)
auth flows  before→after: 41 → 41        (no DUPLICATE_FLOW)
adapters added          : ["opencode-anthropic", "opencode-responses"]
models per internal route: 17 Anthropic, 30 Responses
after dispose, routes   : ["opencode"]   (internal route withdrawn)
```

**Why it works.** `llm-pi-ai` is written as a plugin, not a library: it exports `apply`/`inject`/`name` plus what a configuration surface needs (`Config`, `PiAiAdapter`, the profile types), and keeps `resolveProfiles`/`credentialStoreFrom`/`authContextFrom` internal — its published `exports` map advertises `"./src/*"` while `files` ships only `lib/`, so that path is dead in every installed copy, and Node does not strip types inside `node_modules` anyway. `apply(ctx, config)` is the supported entry and resolves all of that itself.

**Reaching the package: the loader's entry list, not a guessed path.** `ctx.get("loader")` is a public service, and every configured entry the host loaded keeps its **raw import result** on `entry.moduleNamespace`, with `loader.unwrapExports` performing the same export normalization the loader itself applied. So `loadPiAi` reads the module off the entry whose `options.name` is `@deepseek-ai/dsh-llm-pi-ai` — no bare-specifier `import()`, no `createRequire` over `DSH_PROFILE_DIR`, no install-root arithmetic. **Guessing is what made this look unsolved**: measured, `import()` of the bare specifier fails, so does resolution from the profile's `package.json` (the profile has no `@deepseek-ai/`), and so does resolution from the CLI's entry (`dsh` does not depend on it — it arrives through `@deepseek-ai/dsh-base`). **Declaring it as a dependency is still not the answer**: it pulls ~1000 lockfile lines through `@google/genai` and `protobufjs`, and pnpm then refuses the install over their build scripts — which would break every consumer's `pnpm install`. An entry the host has not loaded reports `undefined`, which is the honest answer: there is no internal route to register, and every route the profile declares still works.

**Three things make a second instance throw, and none of them is a configuration problem.** This is the part that has to be written down, because each failure is a throw at mount time with nothing pointing at its cause:

1. **`Config(raw)` is validated a second time.** The registry keys its runtime record by the `apply` function's **identity**, so the FIRST instance's schema is the one on record — and it validates whatever the second mount is handed. Handing it an already-validated `Config` is what produces `providers.get expected object`; measured verbatim: `invalid config: $.providers.get expected object but got () => current`. **The raw config object is what gets passed**, once, carrying every internal route.
2. **`DUPLICATE_DIRECTORY`.** `apply` declares the **entire installed catalog** as configurable providers, not only the routes in its own config, so the second instance collides on every catalog provider. Isolating `authorization` does not help.
3. **`DUPLICATE_DISCOVERY`.** Model discovery is keyed by settings namespace, and the namespace is `ctx.fiber.entry.options.id` — which a child plugin **inherits** from its parent entry. So the second instance lands on `dsh-opencode-patch`, the namespace this plugin already registered under.

(2) and (3) are answered by **scope**, not by configuration: below an `extend()`ed context whose `llm` is a **facade**, the mounted instance still registers its adapter — on the real service — while its catalog and discovery registrations land on no-ops. `settings` is isolated for the same reason: the mounted instance's directory is driven by a settings section nobody asked to write. **`extend`, not a property assignment**: `Context.extend` uses `Object.defineProperty`, because a service on the parent is an inherited _getter_ and shadowing it is the entire reason `extend` exists.

**The facade must forward through the RECEIVER, and hold the handle.** `llm` is a **per-context Proxy**, and `registerAdapter` owns its registration with `this.ctx.effect(…)`, `this.ctx` being rebound on every read. Forwarding through a service captured once — at facade-construction time, or through the scope the plugin happens to hold — parks the registration on the ROOT fiber, which outlives everything: measured, the route then survives `dispose()` and the next mount fails `DUPLICATE_ADAPTER`, which is a reload loop that never recovers. So the real service is resolved **per read, from the context that read the facade**, and the disposer releases the captured handles before disposing the fiber, so withdrawal never depends on fiber ownership lining up.

When it does activate, two behaviours matter: the route's model list is read from the catalog's `provider_npm`, so it covers **every** Responses model rather than the one a hand-written list named; and registration **defers** per route when the profile already declares it, so a deployment that hand-declares one keeps its own model list. It never throws.

**The credential is the user's, not ours.** Every route this module mounts names the `apiKeyEnv` its own `opencode` route already declares, read from the loaded `llm-pi-ai` entry's configuration by the same `discoverGoConfig` the Go meter uses, falling back to `OPENCODE_API_KEY`. pi-ai resolves a reference through the credentials service first and the environment second, so the same ref is the same stored record — a deployment that named `MY_ZEN_KEY` is inherited rather than asked to state that decision twice. A literal key in the user's row is deliberately not copied: the routes carry the `Bearer unused` sentinel below, and `fetch-patch` swaps it.

**A keyless route ALONE throws — which is why the routes carry a sentinel anyway.** `provider.ts` says a route naming no credential is "deliberately unauthenticated", which reads as "it will just send no key". It does not. pi-ai's implementations resolve the key like this (`dist/api/openai-responses.js`):

```js
function getClientApiKey(provider, apiKey, headers) {
  if (apiKey) return apiKey;
  if (
    hasHeader(headers, "authorization") ||
    hasHeader(headers, "cf-aig-authorization")
  )
    return "unused";
  throw new Error(`No API key for provider: ${provider}`); // ← before fetch
}
```

The `headers` here are the **route's own** `headers` config, not the outgoing request's — and the throw happens **before `fetch`**, so `patchFetch` never gets a chance to inject anything. The route must therefore declare the sentinel:

```yaml
headers:
  authorization: Bearer unused
```

`createClient` merges the route's headers **last** (`Object.assign(headers, optionsHeaders)` — "so they can override defaults"), so the value must be the literal `Bearer unused`, not `unused`: whatever the SDK would have sent, this is what goes out. `fetch-patch.ts` then swaps that sentinel for the credential it captured from `opencode` — a path that is unit-tested in `fetch-patch.test.ts` — so the key stays configured exactly once. (`hasHeader` is case-insensitive and ignores empty values.)

The alternative is `apiKeyEnv: OPENCODE_API_KEY` on both routes. It is more robust — no sentinel, no dependence on `patchFetch` — and it is _not_ the same secret twice: both routes name one ref, so the credentials service still holds one record and the Models page shows one entry. Choose it if the sentinel path ever proves fragile.

Two things that would be nicer, and are **not possible** — checked so nobody retries them:

- **A custom `api` id that dispatches per model.** pi-ai has exactly this machinery: `stream(model)` dispatches on `model.api` through `getApiProvider(api)`, and `registerApiProvider({api, stream, streamSimple}, sourceId)` adds implementations. But `llm-pi-ai`'s `supportedProtocols()` is `Object.keys(PROTOCOLS)` — a hardcoded table — so a route naming any other protocol is rejected by the config schema.
- **Taking over the `opencode` route's adapter.** `llm.registerAdapter` throws `DUPLICATE_ADAPTER` for a route that already has one.

**Keeping the internal route out of every listing a user sees — two patches, not three.** DSH has **no "internal provider" concept**: a route registered with the LLM service is surfaced by every listing, with no flag to mark it hidden. Two listings enumerate providers, and the route must be absent from both:

- `buildModelCatalog` (`packages/api/session-controller/src/catalog.ts`) turns every registered route into a group and drops the groups whose model list is empty.
- `joinProviderDirectory` (`packages/client/ui-settings-models/src/client/store.ts`) maps `listConfigurableProviders`, then pushes a row for **every remaining registered provider**:

  ```ts
  const rows = directory.map(…)
  for (const provider of registered) {
    if (declared.has(provider.id)) continue
    rows.push({ provider: provider.id, displayName: provider.name, settingsNs: '', active: true })
  }
  ```

  So filtering only the configurable directory leaves the route on screen — **`listProviders` is the one that matters**.

- `modelAvailable` resolves through the same registry.

`hideResponsesRoute` (`models-discovery.ts`) therefore patches exactly those two, inside the fiber effect so unloading restores both. **`listModels` is deliberately NOT patched**: every Host consumer of it iterates `listProviders()` first — `buildModelCatalog` (`session-controller/src/catalog.ts:27`), `modelAvailable` (`:83`, after a `listProviders().some(…)` check) and `acp`'s model control (`model-control.ts:158`) — so once the registry omits the route, nothing reaches its model list. Patching it too would be a third wrapper guarding nothing.

**The catch: the redirect must not read the filtered listing.** `isResponsesRouteRegistered()` reads the ORIGINAL `listProviders`, captured at install. Asking the patched method would always answer "no" and the re-dispatch would never fire. `stream-hook.ts` uses that helper, not `ctx.llm.listProviders`.

Nothing in dispatch reads either method: the adapter registry resolves a route internally, so hiding it from the UI cannot break serving it. The one alternative needing fewer patches — the plugin registering its own adapter via `llm.registerAdapter` — means implementing the Responses protocol client ourselves, which is the untestable work this design exists to avoid.

```ts
const providers = ctx.llm.listProviders()
const models = await ctx.llm.listModels(provider.id)
const groups = catalog.flatMap(…).filter(group => group.models.length > 0)
```

`routableProviders` is derived _from_ the groups, not a filter over them, so the empty-group rule is the only lever on that surface — but it is not the only surface. Hiding is deliberately **not** behind `enrichModels`: it is what makes the re-dispatch read as a single provider, not a catalog preference.

Two seams the tests pin, both silent failures otherwise: the redirect target must be claimed by the layer (`responses-routes.test.ts`), and the redirect must consult the **unfiltered** registry (`lifecycle.test.ts` — a test whose `effect` is a no-op would silently stop covering it).

**Where the split comes from — the vendor's per-model SDK, not a list.** models.dev names `provider.npm` **only as an override** of the provider's default, so its PRESENCE is the signal. `opencode`'s provider-level value is `@ai-sdk/openai-compatible`; measured 2026-10-05 across its 116 models, **80 of them active**: 26 name nothing (the default), **30 name `@ai-sdk/openai`**, 17 name `@ai-sdk/anthropic`, 7 name `@ai-sdk/google`. The other 36 are deprecated or retired and are never served. `@ai-sdk/openai` is the OpenAI SDK proper, which speaks the Responses API — the same mapping OpenCode's own adapter applies. So `responsesRouteFor(provider, model, providerNpm)` reads `PROTOCOL_FOR_SDK`, and the catalog carries `provider_npm` on each spec (`extractSpecs`), read back through `findModelSpec`.

The hand-written list this replaced named ONE model — `muse-spark-1.3-contributor-free` — and **46 more were already on the wrong side of it**. `gpt-5`, `gpt-5.1`, `gpt-5-codex`, the whole `claude-*` set and the rest would have been dispatched to the completions route and failed.

**The SDK must be read from the plane the request is on — the second mis-route, and the one the live e2e was written to catch.** `findModelSpec` is **Go-first** (`activeGoCatalog.get(id) ?? activeZenCatalog.get(id)`), and `stream-hook.ts` used it to answer a question about a **Zen** request. models.dev's two providers declare **different SDKs for the same id**: `opencode-go` names `@ai-sdk/anthropic` for `qwen3.8-max`, `minimax-m2.7` and `minimax-m3`, while `opencode` names nothing — the completions default. So all three were redirected to `/messages` by the Go plane's answer.

Measured 2026-10-06 against the live gateway, with a credential: `qwen3.8-max` and `minimax-m3` answer **`200` on `/chat/completions`** and **`400 ModelProtocolUnsupported` on `/messages`** — reachable models, hard-failing on the route we chose. Nineteen ids are shared between the planes and three of them diverge.

The fix is `findModelSpecOn(plane, id)` with `catalogPlaneForRoute(route)`, so the plane comes from the route the user configured. `findModelSpec` remains for "does either plane know this model" — pricing and limits, which agree across the planes for every shared id — and its docblock now says so. The same seam existed in `models-discovery.ts`'s servability filter, where `listModels(provider)` knows the provider and now passes it. Both call sites are pinned by a test that fails if either reverts, and the live case re-proves it against the vendor.

**What this still does NOT solve.** `@ai-sdk/google` (7 active models) maps to no route we declare, so those are dropped from every listing by `isServableSdk` rather than offered and failed — deliberately: `supportedProtocols()` is `openai-completions`, `openai-responses` and `anthropic-messages`, and guessing a target would be worse than the honest exclusion. Two second-order limits remain. The redirect is **not bounded by what an internal route lists**: a model added to the `opencode` route after the mount would redirect to a route that does not carry it and fail as "model not found" — the mount's model list is a snapshot, and a live catalog refresh does not re-register it. And the routes are **Zen**-based, so `modelsForSdk` is called with the Zen plane alone: the Go plane names six models the Zen endpoint does not serve, and listing one would resolve to "model not found" against the route's own base URL.

**The bundled shim is GENERATED, and it must carry `provider_npm`.** It answers before the first live refresh — and if a refresh never succeeds. That makes a missing model merely ABSENT (it appears later) while a model present but missing its `provider_npm` is **WRONG**: dispatched to an endpoint that does not speak its format, failing with a gateway error that reads like a model problem.

That is not hypothetical: `provider_npm` was added to the parser and to exactly ONE shim entry by hand, so **nine models were mis-routed on every cold start** (3 × `claude-*`, 4 × `gpt-*`/`grok`, and 2 × `gemini-*` that `isServableSdk` should have been excluding from the picker entirely). The shim drifted in every other field not at all — limits, costs and statuses matched models.dev exactly — because those were generated and only this column was not.

So: `src/catalog-data.ts` is written by `scripts/regenerate-catalog-shim.ts`, from `parseModelsDevCatalog` — **the plugin's own parser**, so the shim cannot disagree with what a live refresh produces. `pnpm run catalog:shim` reports whether it is stale (exit 1) or rewrites it (`--write`); `RETIRED_*_MODEL_IDS` is deliberately not regenerated, because retirement is a judgement about what OpenCode CLI still offers rather than a fact models.dev carries. `test/catalog.test.ts` pins the curation rule — every carried model that names an SDK carries it, and each such SDK maps to a route we serve or is deliberately excluded.

Two planes on one host: **Zen** `https://opencode.ai/zen/v1` (pay-as-you-go + free tier) and **Go** `https://opencode.ai/zen/go/v1` (subscription). `toGoBaseURL` rewrites a Zen base into a Go one because they share a host.

What exists: `GET {base}/models` (both planes; **200 even with a bogus key**, so it is not auth-gated), `GET {go}/usage`, `POST {base}/chat/completions`, `POST {zen}/v1/messages`, and the free-tier `…/responses` path the tool fallback targets.

What does **not** exist: `balance`, `credits`, `billing`, `account`, `me`, `key`, `limits`, `plan`, `subscription` — all 404 under both planes, while `/models` returns 200 on the same key, so those are real absences rather than an auth problem. **There is no credit endpoint and no dedicated overage endpoint.**

`GET {go}/usage` returns `{ usage: { rolling, weekly, monthly } }` (or unwrapped), each window exactly `{ status: "ok" | "rate-limited", percent: 0–100, resetsAt: ISO }` — percentages only, no currency, and **no hourly window**: `rolling` is the short one. Request headers: `Authorization: Bearer <go key>`, `Accept: application/json`, `User-Agent: opencode/1.18.33 dsh-opencode-patch`, `x-opencode-client: cli`, `x-opencode-project: global`, 10 s timeout, `redirect: error`, 1 MiB cap.

Overage is **inferred, never queried**: a `403` carrying `EntitlementError` plus a configured Zen key yields `zenOverflowUsage()` (`zenOverflow: true`, all windows 0%). `resolveZenCreditInfo` therefore answers "can Go overflow into Zen credit?", not "how much is left" — it makes no HTTP call, because there is nothing to call. No balance number is possible either: the monthly cap is per _model_ ($15/$30/$60 Go, $60–$240 Go Plus) while usage accrues _across_ models, so a dollar figure cannot be derived from a percentage. The console is the only place it shows.

## Publishing the quota remote: three pieces, none of which works alone

The meter renders nothing unless all three are in place. Each was tried in isolation and each failed in a way that looked unrelated to the others, so this is written down rather than rediscovered.

**1. The Host method needs a Remote marker.** The Gateway finds remotes by source-mode discovery: for every service in `ctx.reflect.props` it reads `original.typertRemote` and then `remoteMethods(original)`, which reads a descriptor off the prototype (`packages/api/gateway/src/index.ts`, `collectSrcClaims`). No marker means no claim, so `opencodeGoUsage/read` is not an endpoint at all.

The sanctioned form is `@Remote()` on the method. It cannot be used here: the build transform is oxc/rolldown based and rejects TC39 decorator syntax outright (`SyntaxError: Invalid or unexpected token`), and `esbuild: { target: "esnext" }` is ignored by it — at the top level of `vite.config.ts` and inside the `test` block alike. The decorator has no magic: it registers an instance initializer that calls `mark(prototype, method, invocation)`, and `mark` only writes one property whose key is a plain string constant (`@deepseek-ai/dsh-typert-protocol/remote-methods`). So `src/usage.ts` writes that property directly. Swap it for the decorator the moment the transform accepts one.

**2. The client mounts its own contribution.** Source-mode discovery only makes the endpoint callable on the Host; it does not install `ctx.remote.opencodeGoUsage` in the browser. Every official plugin mounts its own contribution in its client `apply()` — `ctx.remote.$mount(contribution)` (`api/remotes/src/client/index.ts`). The contribution object is `usageRemote` in `src/usage-contract.ts`.

**3. The namespace is declared in `ctx.inject`, never in `inject`.** cordis refuses a service read the caller never declared (`cannot get property "remote.opencodeGoUsage" without inject`). Where that name goes is the whole question, and the two mechanisms are not interchangeable:

| mechanism | behaviour |
| --- | --- |
| top-level `export const inject` | hard gate — a missing name stops the entire plugin activating (`web boot: 1 entry did not activate: pending (waiting for service: …)`) |
| `ctx.inject(deps, cb)` | scoped wait — runs `cb` once the services appear, never gates activation |

The namespace belongs in the scoped call, alongside `modelDirectories`, `remote` and `slots`. There is no deadlock from the mount being async: the mount is an effect, registered synchronously in `apply` and completed asynchronously, so the scoped wait resolves after it.

**Comments ship in `lib/client.js`.** Rationale of this length belongs here, not beside the code — the client bundle has a 64 KiB budget that is a release gate in `scripts/check.ts`.
