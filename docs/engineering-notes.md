# Engineering notes

Design decisions and protocol findings behind this plugin, written for someone integrating with OpenCode or writing another DSH plugin. The user-facing description is the [README](../README.md); the protocol internals are [deep-dive](./deep-dive.md) and [protocol routing and merge](./protocol-routing-and-merge.md).

## The session id is the vendor's, character for character

`ses_<12 hex><14 base62>`, read off the vendor's own generator rather than inferred:

```ts
let now = BigInt(currentTimestamp) * BigInt(0x1000) + BigInt(counter);
return prefix + "_" + timeBytes.toString("hex") + randomBase62(LENGTH - 12);
```

Two things follow, and both matter:

- The twelve hex characters are a timestamp, `milliseconds * 0x1000 + counter`, and the vendor parses them back (`timestamp(id)` divides by `0x1000`). Filling them with hash bytes would hand the vendor a random creation instant, and a non-hex alphabet makes that parser throw. So the timestamp comes from the session's own creation time — real, stable, and identical on every turn, in every process and after a restart, without a clock and without state.
- The vendor's buffer is six bytes, so the value is truncated to 48 bits and the embedded time wraps roughly every 795 days (a bug they have filed: [anomalyco/opencode#42589](https://github.com/anomalyco/opencode/issues/42589)). We mirror it exactly, wrap included: a value that recovers a different millisecond than was put in is what a _real_ id does too, and being indistinguishable is the point.

Ascending vs descending is not cosmetic. `descending` is the bitwise NOT of the timestamp value, so the same instant sorts to the opposite end of a lexicographic list — and the vendor's own reader documents that it "does not work with descending IDs". A wrongly-directed id does not merely sort oddly; its embedded time reads as garbage. Direction is a per-type choice (`msg_` and `prt_` may differ from `ses_`); we mint only session ids, so we emit ascending.

A parity test runs the vendor's reader against ids we mint, including a case that fails if the alphabet is ever changed back to something that only _looks_ like an id.

## Endpoints and auth conventions

Covered in full in [deep-dive.md](./deep-dive.md): the two endpoint levels the catalog defines (a provider default plus a per-model `api.url` override) and the rule that authentication follows the **wire shape** rather than the endpoint — Bearer on the OpenAI planes, `x-api-key` on the Anthropic one. Not restated here, because a second copy of a fact is a second thing that can go stale.

## A credential prefix is not an entitlement

A guard that refused to query the Go quota endpoint with a key starting `oc_sk_`, on the belief that the prefix meant "Zen, no Go entitlement", was wrong within one vendor release: the same prefix works on both planes, and the endpoint answers `200` with real windows. What separates the tiers is the **observed request**, never a string prefix. The endpoint's own answer is evidence; a guess about a vendor's key format is not.

## What the meter shows, and why

- The default window is the 5-hour one, not the largest number. A window is shown only when it is actually out (rate-limited or at its cap), widest first; otherwise the smallest window that can still refuse you is the one worth printing. The hover lists all three, because the trigger can only print one.
- Zen draws no ring, because a ring is a gauge and Zen has no window to run out of. Its number is the session spend.
- The spend is split by the plane that served each turn, not by the model's home: the question is which balance paid.
- No estimates. When a number cannot be honest, because the within-allowance vs overage split is not published, the panel states the mechanism instead of inventing a figure. An estimate wearing a precise outfit reads as a measurement, and readers make decisions on it.
- One frame, one list. The panel is the floating surface; rows inside it are plain text. A row that draws its own background is a box inside a box, and a field that repeats a number already on screen is not a second fact.
- A row that disappears reads as a deleted feature. Absent data gets an explicit empty state, not omission.

## The meter's open case, and everything already excluded

One deployment reports an empty meter — the card renders "quota unavailable" — and the host it runs in is the only place the cause can be, because every link that can be checked from outside has been. Recorded here so the next reader starts at the end of this list rather than at the beginning of it.

| Excluded | How |
| :-- | :-- |
| the read itself | the service, mounted with a real-shaped loader row and a real key, answered with real window figures |
| the credential service | a cordis context does see a service provided on it: a probe resolved `Bearer go-key-from-scope` through it |
| the install guard | `usageEnabled` is true and `plugin` is a core registry mixin, so the guard passes |
| the client's inject list | `remote` is declared |
| the contract | the descriptors, the parameter codec and the service's method list all match, and a client query carrying provider, model and sessionId parses cleanly |
| the profile | `config: { usageEnabled: true }` is at the level the schema reads |
| the endpoint | it answers with both keys, measured |
| the host's mount | `ctx.plugin(GoUsageService, …)` succeeds on a real cordis context and `ctx.get('opencodeGoUsage')` resolves — the service registers under the name the client looks for, so the host's half is sound |

What is left is the handshake's client side — the settings context holding a `remote`, `$mount` accepting the contribution, and the face then appearing — and the console is where it will say so, because every branch of that stretch now reports: `readGoUsage` names which of its paths returned nothing, the mount names an absent remote or a throw, and the scoped wait names the service it is still waiting for after ten seconds.

**The host's own diagnostics do not reach a log file.** `ctx.logger.info` from the installers appears in no file under the DSH home, measured — so the client's console is not one channel among several, it is the only one a reader has.

## Next: let a stale deployment say so

The most expensive confusion in this plugin's history was not a bug. A running host was seven and a half hours and eleven commits behind its own build, and every symptom in that window was read as a code fault — because the host bundle is read once at process start, the package is installed through a `link:`, and a browser reload refreshes the client bundle while the host keeps the file it started with. The client's fixes appeared to do nothing and the host's diagnostics appeared never to run, which is exactly what both of those look like when the code is not there.

Documented in three places now, which helps a reader who thinks to look. The next step is to make it say so instead: have the host report an identity for the build it loaded, and have the settings card compare it with the build the client is running. A mismatch is then a line in the console naming both, and a host too old to answer at all is the same signal with the other half missing — which is the state that cost the most time here.

## A missing session reads as a bad credential, measured

The Go plane answers a request with **no** session header `400 MissingSessionID`, and every layer above reports that as an invalid API key. Measured against the live gateway with this deployment's own key:

| Sent | Answer |
| :-- | :-- |
| `Bearer <go key>` with `x-opencode-session: ses_<12hex><14base62>` | `200` |
| the same key with `x-opencode-session: ses_dsh_default` | `200` — the gateway accepts that shape on this path |
| the same key with **no** session header at all | `400 MissingSessionID` |

So the header is the difference, the key is not, and a client that omits it looks exactly like a client with a bad credential. On `/zen/v1` the same malformed value earns a real `401 Invalid API key`, which is why the plugin replaces one wherever it finds it — but "replace it" only helps the requests the interceptor claims.

**The two claims are independent, and that is deliberate.** A URL containing a configured gateway substring is claimed with or without an active turn, which is what keeps session affinity for background calls; a turn routed to a configured provider is claimed too. A request that matches neither goes out untouched, and if it is a Go request it earns the `400` above. When a deployment reports "invalid API key" on a route whose key answers `200` from a shell, this is the first thing to check, and `debug`/`debugFile` records what the interceptor saw and sent — presence only, never the credential — so the answer is a line in that file rather than a guess.

## A model on the wrong protocol route, measured end to end

The report was `400 ModelProtocolUnsupported` from a session, and it is reproducible from a shell against the same gateway with the same key:

| Model                 | Endpoint                      | Answer |
| :-------------------- | :---------------------------- | :----- |
| `deepseek-v4.1-flash` | `/zen/go/v1/chat/completions` | `200`  |
| `gemini-3.8-flash`    | `/zen/go/v1/chat/completions` | `400`  |
| `claude-sonnet-4-6`   | `/zen/go/v1/chat/completions` | `400`  |

All three were listed on the same route, which declares `api: openai-completions`. The last two do not speak that protocol, so choosing either one cannot work — and the routing this plugin exists to do is what would have moved them to a route that does.

**It cannot, because those routes are not registered.** Measured against a real deployment's config: `opencode-responses` is present, `opencode-anthropic` and `opencode-google` are not. The plugin registers model discovery for `opencode` and `opencode-go` only, so the two routes the extra protocols need are the deployment's to write — which is the thing the core model says a user should never have to do.

So the fix belongs here rather than in anyone's profile: the routes for the other protocols have to come from the plugin, the way the completions route already does. Until they do, a model that names an SDK other than completions is offered on a route that cannot serve it, and the answer is the `400` above.

**And the deeper half: a model the catalog does not carry cannot be routed at all.** Measured: `gemini-3.8-flash` and `claude-sonnet-4-6` are in neither shipped catalog, so `findModelSpecOn` finds no entry, `provider_npm` is `undefined`, and `undefined` is the DEFAULT — the completions shape. That default is right for a model that omits its SDK and wrong for one the catalog has never heard of, and the two are indistinguishable at that point. A model listed by hand on a completions route therefore stays there whatever protocol it actually speaks, and the gateway answers `400` — which is the whole of the reported symptom.

`catalog-data.ts` carries `provider_npm` only for models that override the default, so absence is meaningful for the 82 it ships and meaningless for anything else. A hand-listed model needs its protocol from somewhere: the catalog, a route that declares it, or a rule that reads it off the id.

**And the other half of I1: it is still OFFERED.** `models-discovery.ts` filters a route's listing with `isServableModel`, which asks the catalog for the model's SDK and treats a missing answer as servable — correctly, because absence means the completions default. For a model the catalog has never heard of, absence means the same thing by accident, so a hand-listed model is offered on a route that cannot serve it. The routing fix above moves it when it is chosen; this is the half that would stop it being offered at all, and the two belong together: I1 says a model that cannot work is not offered, and today that clause holds only for models the catalog describes.

The check needs the plane, which it already has, and the family, which the id names — the same two facts the routing fix uses. What it must not do is read "no catalog entry" as "servable" without also asking whether any route on that plane speaks the protocol the id implies.

## Rules that came out of real failures

- Start from the host's built-ins. The UI kit ships the components _and_ one CSS module each, the fastest inventory of the host's design language available. A hand-rolled look-alike is one whose CSS module was never opened, and it is smaller, wrong and unthemed next to the built-in.
- Declare cross-plugin services with `ctx.inject`, and know which failure each access has. Measured against cordis: `ctx.get(name)` reads the scope's store and does NOT consult `inject`, so an undeclared service answers `undefined` silently; only PROPERTY access (`ctx.name`) throws `cannot get property "name" without inject`. An optional service is therefore best captured through `ctx.inject([name], scope => …)` — a real child scope that can see it — rather than read off the root context, where the answer is `undefined` and the reason is invisible.
- A `Tooltip` clones its child. Wrap a DOM node, never a component: the clone's handlers land on something that ignores unknown props, and the tooltip never appears.
- Opt into the theme instead of re-declaring it. A hand-set elevation stroke pins one theme's answer and silently breaks the other's, and it looks correct in whichever theme you test it in.
- A countdown floors, and its word order belongs to the language. A reset line is a sentence: English wants the word first, Chinese wants it last, and one copy key cannot serve both shapes.
- A comment that describes intended behaviour is not evidence of it. Read the code the comment is attached to before trusting it; a doc comment had described the opposite of what the function did for several sessions.
- Verify the artifact, not the command's output. A grep over a directory that does not exist is indistinguishable from a grep that found nothing, and a cached registry read makes a completed operation look pending. Assert that the input was actually read, and include a case whose answer you already know.
- A test for a behaviour must perform that behaviour. Asserting a constant is not the same as exercising a switch, and a fixture that sits exactly on a floored boundary is a race, not a test.

## The settings card and the composer meter read the same service differently

Found while chasing a card that says "读不到配额" beside a composer that shows the figure correctly. Two reads of one service, in one page:

|  | composer meter | settings card |
| :-- | :-- | :-- |
| call site | `settings-page.tsx:419` | `settings-page.tsx:576` |
| scope | `meterScope` — the injected child scope | `ctx` — the page's own |
| arguments | `{ provider, model, sessionId }` | `{ provider }` only |
| helper | inline | `readGoUsage(ctx)` in `settings-usage.tsx` |

Three differences, and reading further narrows it to none of them. The page's `inject` list does declare `remote`, so the card's scope can see the service; `readGoUsage` warns on every failure path and the console showed none of them, though that console predates a restart and is not evidence.

**The mechanism is the read's timing, and it is the race already documented above for the remotes.** `UsageSummary` reads once when the card appears — its own comment says so — while the mount is an asynchronous `$mount` started in an effect. If the card renders before that resolves, the read answers `undefined` and **nothing reads again**: the effect's dependency is `readUsage`, whose identity is a fresh closure each render but whose answer never changes. The meter reads on every turn, so it always has the value.

That also explains why the console can be silent. The read may not fail at all — it may succeed against a remote that is simply not there yet, which is a state `readGoUsage` reports rather than warns about, or it may be the "no remote" warning on a console nobody has open at boot. **Either way the fix is not to teach the card the arguments the meter passes.** It is to make the summary read again once the remote appears, which is the same fix the sign-in row needs and the same shape as the two separate mounts.

**The shape is the finding**: one service, two reads, one of them passing a third of the arguments. That is the same shape as the meter and the sign-in row having separate mounts, and the fix is the same kind — make the two reads one read, rather than teaching the second one the arguments the first already had. Worth doing with the console in front of you, because which of the three differences matters is a measurement, not a reading.

## The sign-in row has the same race, one step worse

The card's usage read is lazy — `readUsage: () => readGoUsage(ctx)` — so it resolves the remote when it is called, and it now reads until answered. The sign-in row was not, and this paragraph describes what it was:

```ts
login: loginCalls(ctx),   // called at inject time
readUsage: () => readGoUsage(ctx),   // called when the card asks
```

(`v2` record — this branch has no sign-in row.) `loginCalls` asked for `ctx.remote.opencodeLogin` **while the injector builds the props**, and the mount was an asynchronous `$mount` started in an effect. If it runs first, `loginCalls` answers `undefined`, the card's `props.login !== undefined` is false, and the row never renders — no retry, no second chance, and the warning it prints says the service is missing when it is merely late.

**Fixed, and the choice is worth recording because the two are not equivalent.** `loginCalls` now resolves the remote inside each method and answers the three calls unconditionally. Making them lazy is what fixes the race; answering unconditionally is what makes the row render at all, and it carries a cost: a host that mounts no login service shows a row that reports it rather than showing nothing. That is the better failure — "no row" and "no service" stop looking identical — and it is deliberately the opposite of the meter's choice, which hides itself when its service is absent. The card's prop is now never `undefined`, so the condition that used to guard the row is a formality rather than a decision.

The test that matters is the one the previous version failed: a remote mounted _after_ `loginCalls` has run, which is exactly the case the injector creates.

Either way the tool for it now exists: `readUntilAnswered` in `settings-usage.tsx` is the pattern, and the row needs the same treatment the summary just got.

## The diagnostic, and the mechanism its test needed

The stream hook reports a hand-named model it cannot serve, once per provider/model pair. It has a test now, and the reason the first attempt at one failed is worth keeping: **the hook is registered through `ctx.on(event, handler)`, not by replacing `llm.stream`.** The first test looked for the handler on `llm.stream` after `apply`, found nothing, called nothing, and asserted against an empty warning list.

That is the same shape as the rest of this file — a claim about the tree that the tree did not say — applied to a test rather than to a document. Find how a thing is installed before asserting anything about it.

## A network failure read as a data answer — the class, and where it stops

Two instances, both fixed, and two paths checked that get it right. Worth recording as a class because the symptom is identical every time: something that could not be observed is reported as though it had been, and the conclusion drawn from it is the opposite of what the evidence supports.

**Fixed — three, not two.** The third was found by sweeping this file for the shape rather than by CI, which is the argument for recording a class and not just an instance:

- The catalog-freshness job reports `is src/catalog-data.ts still current?` with exit 1 when its fetch times out. It cannot tell "could not reach models.dev" from "models.dev changed", and it says the second when it means the first. It went red three times in one day and only the third was real.
- The e2e protocol-routing case asserted `toBe(400)` directly on a probe whose status 0 means "the gateway did not answer". A busy gateway was therefore read as the gateway serving a model on the wrong protocol, and the failure message blamed the catalog. `accessDisabled` already treated status 0 as the third shape of "cannot tell"; that loop does now too.
- The same file, one case later: the anthropic-messages probe in the Go-plane case had no guard, while its sibling above and the google case below both did. CI had not reached it. Guarded now.

**And the sweep that found the third found six more.** Every `await probe(...)` in that file, checked for an `accessDisabled` guard within the following lines:

| line | result | shape |
| --: | :-- | :-- |
| ~~325, 342, 569~~ | **guarded now** | the same bug — a status 0 would fail the assertion and report a busy gateway as a routing fault. 325 and 342 share one case, whose signature had no `context`; that is why the guard had nowhere to go until it was added |
| 652 | deliberately not guarded | it checks `freeTierClosed` and reports rather than skips, which the comment there says is the intent — the account is what closed it, so silence would hide a real state |
| ~~591, 612~~ | **guarded now** | not the same bug but the same silence: they assert `not.toBe(404)` and `not.toBe(500)`, which a status 0 satisfies, so a gateway that never replied would PASS a case that proves nothing. The quietest version of the mistake, and the reason the sweep was worth finishing |
| 376, 413, 426, 477, 489, 557 | guarded | 426 and 489 were the two fixed above |

**And the class stops at `probe`.** The other two e2e files call `await fetch(...)` directly rather than through a helper, so a timeout throws and the case fails with an error — which is honest, and is not this class. A failure converted into a value is what makes the shape possible; a failure that stays a failure cannot produce a conclusion at all. That is the boundary, and it is now swept rather than assumed.

So the count was **six unguarded probes, five of them now guarded and one deliberately not** — 325, 342 and 569 were the same bug, 591 and 612 were the same silence, and 652 reports a closed account rather than skipping it, which its own comment says is the intent. The lesson is that recording a class is worth it even when the sweep that follows finds more than the class was named for.

**Checked and correct, so the class has a boundary:**

- `refreshCatalog` — a revalidation failure retains the active catalogs and allows a later retry, rather than emptying the list.
- The models.dev enrichment path — a non-JSON upstream response generates the full catalog response instead of dropping models.

Both were checked precisely because they are the paths where an empty answer would have produced the original symptom — a model list with nothing in it.

## The phantom route, and the sweep that says it was the only one

Five places named `opencode-mistral` as a route while `INTERNAL_ROUTES` has never contained it, and omitted `opencode-google` which it does. The worst of them was the Chinese README saying the patch deliberately does not provide Google Generative AI at all — true before the bridge, false since, and left standing in the translation after the English was corrected.

Swept afterwards for the shape rather than assuming it was the only one: every `opencode-*` name in every document, checked against the routes and planes the code declares. The rest are header names (`opencode-client`, `opencode-org-id`, `opencode-parent-session-id`), the package name, a module name and the CLI — **no second phantom**. That is worth recording because a clean sweep is a result: it is what makes "these five were all of them" a finding rather than a hope.

## The free-tier claim, and the one place it was right all along

The false claim — that a session token, or the org, or a header unlocks the free tier — stood in six places and was swept out of all of them. Two of those places were paragraphs written here, during the round where the exclusion was withdrawn; both now record the withdrawal rather than standing as fact, because the session that appeared to run on a free model was running on `global:step-5-preview`, this host's own model, and the exclusion was right.

**One place had it right before any of this work started.** `docs/opencode-1.19-api.md` already said, at the bottom of its own list: _"The free tier is not reachable by adding a header. Measured: the org id and the key together still answer 403. Any plan that assumed a header fix is wrong."_ That sentence is what the exhaustive table later confirmed, and it was there the whole time — which is the uncomfortable half of this record: the answer was written down, and six other places said the opposite, and the six won for several rounds.

**Correction, 2026-10-17: the exclusion this section defends has been withdrawn, and the reasoning above is why it took so long to see.** The probes that produced it asked the wrong question. They measured _"does a free model answer for this credential"_ and concluded _"the free tier is not served"_; the gateway's own message says something narrower and much more useful:

```
space-bunny-free  403 {"type":"error","error":{"type":"FreeTierError",
  "message":"OpenCode's free tier can only be used from within OpenCode. Download it at https://opencode.ai and keep building."}}
```

That is a statement about the CLIENT, not about the credential, and this plugin exists precisely to present itself as that client. So the models are offered again, and the honest position is the one the gateway states: they may answer, and if they do not the refusal names its own reason. The 403 is still what a keyless or non-OpenCode request gets, which is what the table in `docs/opencode-1.19-api.md` measured and is still true.

**Addendum, 2026-10-18 — where the decision actually is.** The console's own source, read since, says the request is not what gets refused: for a model whose entry allows anonymous use it deletes the credential and forwards the request keyless to the vendor's inference service, and that service answers `FreeTierError` — a class that exists in neither released tree, while the console's own errors name themselves from classes that do. The last untested shapes were closed the same day: the complete client header set with the message id, keyless with the literal `public`, sent from Bun as well as curl, on both endpoint families. Every one is refused identically. So the ids are offered and the refusal is reported in the gateway's own words — the position this section reached, now grounded in the source that decides it rather than in the request's side alone.

What this section should be read for now is the _pattern_, not the conclusion: six places agreed, one disagreed, and the six were not re-measured when the one was. A measurement answers the question it was asked, and "not served" was never the question.

A sweep that ends clean is worth as much as one that finds something, and this one ends with the boundary drawn: every remaining mention of the free tier says it is not served from here. **It did not, in fact, end clean.** Two bullets in `docs/credentials.md` - the measurements at the end of the bare-client section - still asserted the free tier is served and named `opencode/step-5-preview-free` as the proof, because the sweep matched the withdrawal paragraph and stopped at the file that contained it. They were withdrawn later, together with the table row in `docs/deep-dive.md` that said the same thing in a cell with no keywords for a grep to find. The lesson is the one the note above it already recorded and then did not follow: a claim in this file's subject area is not swept because a nearby paragraph was.

## A measurement of mine that was wrong, in the shape this file keeps describing

Checking whether `UNSERVED_SDKS` still records the mistral decision, I imported it and printed it with `JSON.stringify`. A `Set` serialises to `{}`, so the module answered `new Set([MISTRAL_SDK])` and I read an empty object — and concluded the document was lying about a decision the code still holds.

That is the wrong-context sweep this file already names three times: a symbol resolved in a context that cannot show it, producing a confident finding that is entirely wrong. `UNSERVED_SDKS` is fine. The count beside it was not — `redirect-planes.md` said `0 of 32 on Go` was `0 of 31`, missed when the catalog gained `cat-jam-free` — and that one is fixed.

The rule that would have caught it is already written above and was not applied: assert that the input was actually read, and include a case whose answer you know. Printing a `Set` is not reading it.

## Auto review has two failure modes, and only one of them is about the model

`403 FreeTierError` (passed through unchanged, after a remap to 400 was tried and withdrawn) is the one this work chased: the audit call takes its route from `session.requestHeader()`, so a session selected on a Zen free-tier model fails before the patch's headers matter.

`429 RATE_LIMIT: Upstream request failed: Endpoint is unavailable` is a second one, observed afterwards, and it is not about the model, the tier, or this plugin. The reviewer's own endpoint is rate-limited or down, and the tool call is refused before its body runs — which is what a refused tool call looks like from the outside, and why "auto-review failed" is not by itself evidence about the plugin.

Worth keeping separate because the conclusions differ: the first is fixed by not selecting a free model, and the second has no fix here and no fix in the session — it is the reviewer's provider being unavailable, and it clears on its own.

## Every count in the documentation, checked against the data

Two were missed while chasing the catalog's changes — Go's total and its no-SDK row — so the sweep was finished properly: every number stated in any document, compared against `catalog-data.ts`. The facts are Zen 82 with 25 no-SDK, 30 openai, 18 anthropic, 8 google and 1 mistral, and Go 32 with 20 no-SDK, and every live count in the docs says exactly that.

Two numbers that look stale are not, and they are worth naming so the next sweep does not "fix" them: `0 of 31` appears once, inside this file, as a quotation of the mistake; and `16 of 17` is a recorded test result from the round that narrowed the header test, not a count of anything current.

## The link sweep, done in the context the earlier one got wrong

Every relative link in every markdown file, resolved from **the file's own directory** rather than from the repository root — which is the mistake this file already records, and the reason an earlier sweep reported every doc link as dead. Zero broken links.

That is the point of writing a sweep's context down: the second attempt is only better than the first if it applies the correction, and a clean result from the wrong context is worth nothing at all.

## The identifier sweep, and the two contexts it needed before it said anything

Every backticked identifier in the documentation, checked against the code. **The first version was useless**: it asked whether each name is an _export_, and reported 70 of 98 as missing — because most of them are SQL columns, config fields, parameter names, test helpers and host API fields, none of which are exports and all of which are real. That is the wrong-context sweep again, this time written by someone who had just finished documenting it.

The second version asked the right question — does the name appear anywhere in the tree — and the glob still missed `test/e2e/*.ts`, so the two helpers the e2e cases use came back as unknown a second time. With that fixed, 88 of 98 resolve and the rest are host fields, a GitHub error string and an OpenCode migration name.

**The one real finding was a name from a design that had been replaced.** `orgByPlane` appears in `credentials.md` and nowhere in `src/`: it is what the org cache looked like before `src/org-cache.ts`, in a paragraph that reads as a proposal. The fix it proposed was applied and the paragraph never said so, which is the difference between a historical note and a live claim. It says so now.

## The tests, checked against the rule the repository states

The rule is _a test for a behaviour must perform that behaviour_, and the sweep for it is coarse: every case in every test file, checked for an assertion at all. **Zero cases assert nothing** — which is a weak result and worth saying so, because the check finds a case that verifies nothing and not a case that verifies the wrong thing. The one instance of the second kind found this session, the e2e probe asserted on a status that meant "no answer", needed a person to read it.

That is the honest boundary of this sweep: it can say no case is empty, and it cannot say any case is right.

## The sweeps, and what nine of them were worth

Six found something real and three came back clean. The clean ones are results too, and the count matters more than any single finding: it is the difference between "I fixed the instance I tripped over" and "the class is empty".

| class | result |
| :-- | :-- |
| module map | `login-credential.ts` unmapped — found by listing the modules the map omits, which is the only way an omission is visible |
| route names | `opencode-mistral` named in five places and never a route; `opencode-google` a route and named nowhere |
| counts | Go 31 where it is 32 — and this one was missed while fixing the Zen count beside it |
| false claims | the free tier "reachable" in six places, two of them paragraphs written here and later withdrawn |
| quoted code | `PROTOCOL_FOR_SDK` quoted with a member it never had and without the one it has |
| identifiers | `orgByPlane`, a name from the design `org-cache.ts` replaced |
| links | clean — and only clean once resolved from each file's own directory |
| test assertions | clean — with the boundary stated: finds a case that verifies nothing, not one that verifies wrongly |
| source comments | clean — no comment names a symbol the tree does not have |

**Two of the sweeps were wrong before they were right**, and both were the wrong-context shape this file keeps recording: the count sweep missed Go while fixing Zen, and the identifier sweep asked whether names are exports when most of them are columns, fields and parameters. A sweep is only as good as the question it asks, and writing the question down is what makes the second attempt better than the first.

## Ten sweeps, and the tenth found the count that drifted the other way

The settings card has eight controls — `CARD_FIELDS` in `settings-fields.ts` — and the English README said seven in two places. The Chinese README already said 八个. So the two documents drifted in opposite directions on the same fact, one round after the sweep that found the Chinese lagging the English on two others.

Neither language is the source of truth and neither is reliably ahead: the fix is to count against `CARD_FIELDS` rather than to translate from the other file, which is what both rounds actually did, and why both found something.

## Twelve sweeps, and the commands were clean

Every command the documentation names was run or checked: `catalog:shim` and `limits:shim` both work and both are what CI checks, and the one that looked unwired is not — `release:gate` runs `build && check && test && check.ts`, which is exactly what the workflow runs as four separate steps, so it is a convenience for a person rather than a step CI is missing.

One finding came out of this class and it was the previous round's: `vp pack` was documented as the build command and produces `lib/client.cjs`, which the client loader cannot find. The command sweep was worth doing for that alone.

## The paired documents, checked by fact rather than by line count

The two READMEs are 51 lines apart, which is not evidence of anything — Chinese is denser, and line parity was never the claim. Checked by the facts that matter instead: the catalog total, the control count, `opencode-google`, and `step-5-preview` are all present in both, with the Chinese mentioning `FreeTierError` twice fewer and `opencode-google` once fewer, which is the difference between a translation and a copy.

The first attempt at this comparison was the wrong-context shape again: stripping non-ASCII characters from the headings to diff them removes almost every Chinese heading, so the two lists could not align and the output said nothing. Facts survive that mistake; structure does not.

## The diagnostic a user sees, now written down where they would look

The stream hook reports a hand-named model it cannot serve, once per provider/model pair: _"is not offered by this plugin and cannot be served from here"_. It was added and then left undocumented, which matters more for a diagnostic than for most code — a message a user cannot look up is a message they will misread, and the gateway's own answer for a Zen free-tier id is exactly the misreading this exists to prevent.

The trigger is a model named by hand rather than chosen from the picker: the picker no longer offers a Zen `-free` id, but a session that already selected one, a config file, or a direct call can still name it, and the warning is the only thing that says why.

## Seventeen sweeps, and the fourth time a sweep asked the wrong question

Every script under `scripts/`, checked against whether a workflow runs it: `build`, `catalog:shim`, `limits:shim` and `cli:version` are all called, and the one that is not is meant not to be — `release:gate` is the four CI steps as one convenience for a person. `token:refresh` (a console-session refresher) left with the login stack: it rewrote a local credential store through the device flow, which is `v2` work.

The first version of this check grepped the workflows for each script's **filename**, and reported three of them unwired. Workflows call npm script names, not files. That is the fourth time this session a sweep resolved a name in a context that could not show it — after the count sweep that missed Go, the identifier sweep that asked about exports, and the heading diff that stripped non-ASCII out of Chinese.

Four instances in one session is no longer an accident of care. The rule that catches all four is written at the top of this file and has to be applied before the sweep is believed: **check that the thing being searched is the thing the claim is about.**

## Reading deep-dive.md end to end: two findings and one clean check

The file is 190 lines and had only ever been grepped, which is how two findings survived in it: the auto-review section kept the "on the same model" conclusion this work overturned, and section 5's neighbourhood exposed a code comment still describing a credential-prefix guard that was removed.

Sections 1 to 3 check out. The header matrix's version claim is the checkable one — `OPENCODE_CLI_VERSION` is `1.19.4` in `identity.ts`, and `pnpm run cli:version` confirms it is the published version with seven copies agreeing — and the rest of the matrix is a decompilation whose values match what the patch sends.

The remaining claim in section 1 that cannot be checked from here is the `User-Agent`'s purpose: that it prevents Cloudflare WAF Error 1010. It is not the cause of the free-tier refusal, which was measured exhaustively and is about the model rather than the request, and whether it defeats a WAF challenge is not something this repository can observe.

## The duplicate-count sweep, broadened, comes back clean

The narrow version caught the Chinese README's Google claim; the broadened one — every number followed by a counter word, in either language — returns only `85` and `41`, both stated twice on a single line and both correct in both languages. `41 catalog entries and 41 sign-in flows` is a measurement against the real harness, and the Chinese says the same thing.

So the class has one member left standing rather than a pattern, which is the point at which a sweep stops being worth running. Three instances of "a fact written twice, updated once" were found and fixed; this is the check that says there is no fourth.

## Why one document's counts never drifted, and the others' did

`protocol-routing-and-merge.md` states five counts — 28, 30, 18, 8 and 1 of 85 — and every one is correct, which is not luck. The document says why in its own words: _"a count written into prose does not regenerate with the data it counts"_, and it names the test that holds them. `catalog.test.ts` asserts the table against the shipped catalog, so a count that drifts fails the suite rather than sitting in a file.

That is the difference between the counts that were wrong this session and this one. The ones that drifted — Go 31, the Zen total in the plane table, the duplicated 12 and 13, the Chinese README's Google line — were all prose that nothing checked. The fix in each case was to correct it; the fix that would have prevented all of them is the one this document already applies, and it is worth copying rather than rediscovering: put the number where a test can reach it.

## The prose totals are still unguarded, and the attempt to guard them is recorded

`catalog.test.ts` already parses and asserts the tables in three documents — the README's routing table, `protocol-routing-and-merge.md`'s "N of M" pairs, and `redirect-planes.md`'s per-SDK matrix. Every count this repository has had to correct lived outside them, in a sentence: the README's total, the Chinese README's copy of it, and the plane table's "85 served / 120 listed". The mechanism that would have caught all three exists and is not pointed at them.

An attempt to add that case was made and reverted. The regex had to allow for the number being emphasised (`**85** active`), the escaping survived one round of edits and not the second, and the file ended up with no tests running at all. Reverted rather than left half-working, which is this session's rule and the reason the tree is green.

So it is a known gap with a known shape rather than an unknown one: a number in a sentence is the kind a reader trusts most and the kind nothing checks. The fix is a case in that file, and it needs an edit that is tested as it is written rather than after.

## The count gap is closed, and nothing else restates one

With the prose totals asserted, every count in this repository is now either parsed by a test or generated by the script that owns it. Swept for the rest: no other document states a catalog number, and `deep-dive.md` avoids the problem the way it should — _"The counts are deliberately not restated here: they move with the vendor, they are visible in the generated file, and CI fails when the shim is stale."_ That is the better pattern, and it is why that file was never wrong about a count while four others were.

So the class has an ending rather than a fifth instance: numbers live where a test reaches them, or they are not written down.

## Where this session's sweeps stop being worth running

Three preventive mechanisms were installed and each was proved by making it fail: the prose totals against the catalog, the repo map against the module list, and the READMEs' control count against `CARD_FIELDS`. A fourth was attempted — holding the documentation's route names to the routes the code declares — and it does not work: every `opencode-*` string in the docs that is not a route is a **header** (`x-opencode-session`, `x-opencode-project`, `x-opencode-request`, `x-opencode-session-id`), and distinguishing them needs a rule about the surrounding text rather than about the name.

That is the fifth wrong-context sweep of this session, after the count sweep that missed Go, the identifier sweep that asked about exports, the heading diff that stripped non-ASCII, and the script check that grepped filenames. Five in one session, each producing a confident list that was wrong, is the signal rather than the noise: the rule at the top of this file — check that the thing being searched is the thing the claim is about — is not a caution for the first attempt, it is the precondition for believing any of them.

The three that work are recorded by their proof, not by their intent. The ones that do not are recorded here so the next pass does not spend a round rediscovering why.

## credentials.md is current, including the conclusion that matters most

Read end to end for the first time. The resolution chain matches `login-credential.ts` — captured, declared, the DSH grant on the requested plane then the other, the installation account and key when opted in — and the document states its own limits rather than implying they are guarantees: refresh deduplication is per shared reader and not across processes, and the fixtures "verify credential selection and outgoing headers, **not** whether a live gateway accepts a session token on every model endpoint **or grants free-tier access**."

That last clause is the whole free-tier finding, written into the document that is about credentials, and it was there before this session's exhaustive measurement confirmed it. The other documents said the opposite and won for several rounds; this one was right, and is the second place found where the correct answer was already written down.

The historical sections below it are labelled as such, which is why nothing in them needed correcting - the same device `deep-dive.md` uses when it declines to restate a count.

## The free-tier claim, swept in the form that has no keyword

The correction two rounds ago missed a table row that said `served` and a conclusion that named the token, because a grep for the claim matches wording and a table cell has none. So the claim was swept in its keyword-free forms - cells reading `served`, `yes`, `✅` - and the result is clean: the paid-models row says `served | served` and is right, the free-tier row beneath it now says it is not served either way, and every other hit is a different subject.

Nine findings and two "the answer was already written down" have come out of reading these documents end to end, and not one of them from a grep. The rule that follows is not "grep harder" but "a document's central claim can be a table cell with no words in it", which is why the last four rounds have each read a file rather than searched one.

## The language-pair drift resists automation, and the previous round's claim was too optimistic

Four times now the two READMEs, or the two meter documents, have drifted apart on one fact, in both directions: the Chinese lagged on two claims and on a screenshots sentence, and the English lagged on the control count. The last round ended by saying this class "can be automated" - it cannot, and the reason is worth writing down rather than discovering again.

What drifted was a **sentence**: the English says the screenshots are not committed and why, the Chinese says only that a script produces them. The section counts match, the numeric counts match, and the retry paragraph beside it matches. No mechanical comparison over counts, headings or identifiers sees the difference, because the difference is that one document explains something the other does not.

So the rule for this class is procedural, not automated: **change both when you change one**, and treat a one-language edit as an unfinished edit. The three checks that do work are about numbers; this one is about completeness, and it belongs in the discipline rather than in the test suite.

## The artifacts, checked against everything this session changed

Not the source, the build. Every fix is present in the file the host loads and the file the browser loads, and the boundary between them is intact:

- `lib/index.mjs` carries the opt-in store reader (`readOpencodeStore`, 21 references), the JSON credential extraction (`credentialToken`), the revocation rule (`MISSING_CREDENTIAL`, 4), the servability check (`isServableModel`, 3) and the diagnostic sentence.
- `lib/client.js` carries the bounded re-read (`readUntilAnswered`, 2) and the login row's per-call resolution and its diagnostic.
- `lib/client.js` contains no `node:sqlite`, no `node:fs` and no `opencode-store` — the host-only module did not leak into the bundle, which is the rule the bundle gate exists to enforce and the reason it is checked rather than assumed.

That is the last thing worth doing without the host: the code is correct, the data is current, the documents say what the code does, and the artifacts contain all of it. What none of it can show is whether the deployment behaves differently, because that needs the process that is running to be the process that has this code.

## The handoff is current, which was worth checking rather than assuming

The session opened with a request to hand this work to someone else, and the handoff was written into `credentials.md` before any of it was built. Everything since has been built by the same session, so the brief was checked rather than trusted: it has the two planes with the org distinction marked as got-wrong-twice, the two credential sources, the JSON-value fact discovered here, a Status section that says for each part whether it is a correction rather than a detail, and a closing list of what is no longer open that was updated as the answers landed.

So the document that a next reader starts from describes what exists rather than what was intended. That is the last thing this session can verify without the host, and it is the one a handoff is for.

## The coverage ratchet, checked against the code this session added

Statements 95.31% against a floor of 95, branches 90.82 against 90, functions 93.57 against 93, lines 95.29 against 95. Each clears its floor and none clears it by much, which is the useful part: the bounded re-read, the login row's per-call resolution, the unservable-model report, the JSON credential extraction and the login reader were all added to files whose coverage is measured, and a path left untested would have pushed one of these under its floor and failed CI rather than passing quietly.

That is the last of the four ways this session checked its own work: the suite asserts behaviour, the ratchet asserts that the new behaviour was reached, the bundle gate asserts the client did not gain a host dependency, and the artifact check asserts the built files contain all of it.

## Where the productive work ends, and what the remaining condition is

The test files' own comments were swept for claims about behaviour that changed under them - "used to", "no longer", "was removed" - and every one is true: `@ai-sdk/google` was in `UNSERVABLE` before the bridge, the client bundle did register the meter in an earlier shape, and the README's total is asserted rather than stated. That was the last unchecked class this session could name.

Everything the repository can verify about itself has now been verified, four ways and repeatedly: 851 tests, the coverage ratchet above all four of its floors, the bundle gate, and the built artifacts containing every change with no host-only module in the client. Every document has been read end to end, the handoff describes what exists rather than what was intended, and three checks were installed and each proved by making it fail.

**What remains is not a task.** The host process has been running since before any of this work - twelve hours and seventy-two commits behind its own build - and it is the process that answers requests, so no fix, no diagnostic and no corrected document can be observed until it restarts. The four questions worth asking it are the four this session has asked in every round: does the account row appear, does the quota read, are the free models gone from the picker, and does auto review still refuse.

Until then, another round produces another marginal commit. That is worth saying plainly rather than demonstrating.

## A claim I made from names instead of reading the code

I wrote that the endpoint a request goes to is decided by the catalog's `api` field — `models.opencode.ai` declares `opencode.provider.api = https://opencode.ai/inference/v1` and `opencode-go.provider.api = https://opencode.ai/inference/go/v1`, so it looked like the answer. **I never read the code that would make that true.** What I actually read is `packages/ai/src/providers/opencode-zen.ts`, which has `const baseURL = "https://opencode.ai/zen/v1"` and `baseURL: input.baseURL ?? baseURL`, plus `packages/ai/src/route/endpoint.ts` saying a provider helper "can override it by configuring the route before selecting a model". Who passes `input.baseURL`, and whether the catalog's `api` reaches it, is unverified — grepping for callers of that provider in the checkout found only its own exports.

That is the same failure this file keeps recording, applied to source code rather than to a document: a name that looks like the answer, read as the answer. Three subagents are reading the real chain — the endpoint resolution, the key minting and refresh, and a full 1.19-versus-2.x request comparison — and their findings will be recorded as findings rather than as inference. Until then, the sentence above is a hypothesis, not a measurement.

## The endpoint chain, read out of the client instead of inferred

The hypothesis above is now a finding, and the mechanism is not the one the names suggested. Read from the source at `dev` (2.0.27):

- `packages/core/src/models-dev.ts:279` — `defaultSource = "https://models.opencode.ai"`, overridable by `OPENCODE_MODELS_URL`.
- `packages/core/src/models-dev.ts:346` — `HttpClientRequest.get(\`${source}/api.json\`)`.
- **`packages/core/src/models-dev.ts:106`** — the provider's `api` becomes `settings: { baseURL: item.api }`. This is the link that makes the catalog the endpoint's source.
- `packages/core/src/plugin/models-dev.ts:56` — the provider is added to the catalog; `model.ts:204` merges provider settings under model settings, so a model-level value wins; `model-resolver.ts:221,234` passes them to `module.model(id, settings)`; `packages/ai/src/providers/openai-compatible.ts:29` turns `baseURL` into the route's endpoint; `packages/ai/src/route/endpoint.ts:57` renders the URL.

**`OpenCodeZen.configure` is not on that path at all.** Its only callers are tests, and it cannot be a provider package because it exports no `model()`, which `ProviderPackage.Definition` requires. Its hard-coded `https://opencode.ai/zen/v1` matches the _bundled snapshot_ — which is the fallback when the cache is cold — not the live catalog, where `opencode.api` is `https://opencode.ai/inference/v1` and `opencode-go.api` is `https://opencode.ai/inference/go/v1`.

Precedence in `models-dev.ts:385-401`: file, then cache, then bundled snapshot, then fetch — so a cold cache with no network serves the stale `/zen/v1` while steady state serves `/inference/v1`.

**A per-model override exists and is named `provider.api` in 2.x**, not `api.url` as 1.x had it: `models-dev.ts:220` lifts `model.provider.api` into `Model.Info.settings.baseURL`. Neither `opencode` nor `opencode-go` sets one today.

That is what the plugin should read, and it is why its own hard-coded `/zen/v1` is the older of the two live endpoints rather than a mistake about which one exists.

## The auth-key-and-refresh-key premise does not hold, read out of the client

A premise this work was asked to implement — that the Console key mints an API key on the fly and that an auth key is paired with a refresh key — is not supported by the client's source. What exists is two different things that look alike:

- **The device-flow OAuth pair**, `access` + `refresh`, which is genuinely generated and refreshed. It is stored as `type: "oauth"`.
- **The service-account API key**, a single static `oc_sk_<12 hex>_<32 chars>` string that a person creates in the Console and **pastes** into the client. No companion secret, and it is never refreshed.

Evidence, all read:

- The client does not mint it. The only non-doc occurrence of `oc_sk_` at HEAD is a consumer: `packages/console/app/src/lib/inference-proxy.ts:51`. The key-creation code that does exist mints the legacy format — `packages/console/core/src/key.ts:50-57`, `sk-` plus 64 random characters.
- Minting the new format happens in the Console's migration destination, a separate deployment: `infra/console.ts:194-198` (`new sst.Linkable("ConsoleMigration", …)`) and `inference-proxy.ts:57`, which forwards new keys there.
- Only OAuth credentials refresh: `packages/core/src/integration.ts:730` returns a non-oauth credential unchanged, so a `Credential.Key` is handed out as-is forever.
- The device flow returns OAuth and never a key: `packages/core/src/plugin/provider/opencode.ts:618-631` builds `{ access, refresh, expires }`.
- There is no second secret. No `oc_rk_`, no `refresh_key`; the one `refreshKey` symbol is an unrelated MCP cache key (`packages/core/src/mcp/oauth.ts:33`).
- `auth.json` is the **v1** store. v2 reads it once, in `20260805200742_import_legacy_credentials.ts:39`, and migrates `{type:"api",key}` to `{type:"key",key}` in SQLite; nothing writes `auth.json` at HEAD. So an `oc_sk_` value under `opencode` there is a pasted service-account key, not something a login produced.

**What this means for the plugin is that there is nothing to add.** `login-session.ts` already refreshes exactly the pair that refreshes — it posts to `/auth/device/token` with `grant_type=refresh_token`, the same exchange the client uses — and a service-account key is static by design. Implementing a mint-or-refresh mechanism for `oc_sk_` would be implementing something that does not exist.

## The tool schemas were fixed against the wrong generation, and are back

Read from `git show v1.19.4:packages/opencode/src/tool/read.ts:28-36` and `tool/shell/prompt.ts:15-23`, against the 2.x files I had read:

|  | 1.19.4 (what this plugin emulates) | 2.x (what I read) |
| :-- | :-- | :-- |
| `read` required key | **`filePath`** | `path` |
| `read` offset/limit descriptions | "The line number to start reading from (1-indexed)" / "The maximum number of lines to read (defaults to 2000)" | "…directory entry…" / "…defaults to and capped at 2000" |
| the shell tool's name | **`bash`** | `shell` |
| shell parameters | `command`, `timeout`, `workdir` | `command`, `workdir`, `timeout`, **`background`** |
| shell `timeout` description | "Optional timeout in milliseconds" | "Set to 0 to disable… defaults to 120000…" |

So the round that "fixed the tool schemas" renamed `filePath` to `path` and added `background` — both correct for 2.x and wrong for the generation this plugin emulates. Reverted. This is the third time in this session that reading the `dev` branch produced a change the `v1.19.4` tag contradicts, after the session headers and the affinity split; the branch layout is the first thing to establish, not the last.

Other deltas the comparison establishes, none of them acted on yet:

- `x-opencode-request` **is** sent by 1.19.4 (the user message id) and was dropped in 2.x. This plugin omitted it for a round — the turn store held no message id — and now sends one minted per turn in the same shape; the section below records how and why.
- `x-session-affinity` and `X-Session-Id` are **not** sent for `opencode*` providers in 1.19.4 — they are the other branch, for relays. This plugin sends them on every claimed request.
- `User-Agent` is `opencode/<version>` in 1.19.4, and `opencode/<channel>/<version>/<client>` in 2.x. The plugin sends `opencode/1.19.4 ai-sdk/provider-utils/… runtime/bun/…`, which is neither.
- Chat bodies use `max_tokens` in 1.19.4 and `max_completion_tokens` in 2.x.
- `b3` is absent in **both** generations, and `traceparent` appears only under `experimental.openTelemetry` — so neither belongs in the plugin's request on the evidence available.

## The two gaps the failed subagent left, answered directly

It died without a closing message, so the four questions it was given were answered by hand instead. Two of them are settled.

**`x-opencode-project` is not a hash — it is the git root's path.** `packages/core/src/project.ts:307-315` is `root.replace(/\.git\/?$/, "")` fed to `ID.make`, so the identifier is the working-copy root with the `.git` suffix stripped. A subproject or worktree does not get its own id: `project.ts:356-376` resolves through `repo.commonDirectory` and takes that store's cached id, so a worktree shares its main repository's — which is what "workspace project attribution" means. With no VCS at all the id is `ID.global` (`:348`, `:376`), and that is the case the plugin's current `"global"` actually matches. So for a real repository the plugin sends the wrong value, and the right one is a path rather than a digest.

**`x-opencode-request` is a user-message id, and it can be supplied.** 1.19.4 sends `input.user.id` (`request.ts:194`), and the value is `input.messageID ?? MessageID.ascending()` (`session/prompt.ts:471` and `:657`) — so it is the id of the user's message, not of a turn, and the CLI accepts one from its caller rather than always minting one. The capture of the running client shows the shape as `msg_…`. That matters for this plugin: the turn store held no message id, which is why the header was absent for a round, and a host-supplied value would still be the faithful one — what shipped instead is a minted id in the same shape, because the one consumer the trees show is a metric and a per-turn value satisfies it without a host change. See the section below.

Still open from that subagent's brief: the exact AI SDK wire body on 1.19.4's default path (`max_tokens` versus `max_completion_tokens`, `stream_options`, `store`, `prompt_cache_key`, `strict`) — the pinned AI SDK versions are not in this checkout and the earlier comparison flagged its own answer as read from a different version.

## The mount's base URL should be data, and what it takes to make it so

`src/pi-provider.ts` hard-codes the family in `BASE_FOR_PROTOCOL` — `https://opencode.ai/zen/v1` and `…/zen/go/v1`. That is the value the **1.19-era** catalogs declare (`models.dev`'s `opencode.api` and `opencode-go.api`), so it is right for the generation this plugin emulates; what is wrong is that it is a constant rather than a fact the shim carries.

The client resolves the same value from the catalog at runtime — `models-dev.ts:107` lifts `provider.api` into `settings.baseURL` — so a deployment whose catalog moves to the newer family gets the newer endpoint without a code change. The plugin cannot, and its shim has no place to put one: `src/catalog-data.ts` exports only the retired set and the two model arrays.

To make it data, four things together:

1. the generator reads `api` from each provider entry of `models.dev` and emits a third export, e.g. `OPENCODE_PLANE_API: Readonly<Record<Plane, string>>`;
2. the shim is regenerated, so the file carries the value rather than a person;
3. `pi-provider.ts` reads that export in `BASE_FOR_PROTOCOL` instead of the literal map;
4. tests assert the constant agrees with the data.

Steps 1 and 2 alone change nothing, and step 3 without 1 or 2 moves a constant. They belong in one piece.

## `x-opencode-request` is sent again — minted, because the message id is not reachable from here

1.19.4 sends it (`request.ts:194`) and 2.x dropped it. It is the user's message id — `input.user.id`, set from `input.messageID ?? MessageID.ascending()` (`session/prompt.ts:471`, `:657`) — so the CLI is happy to be handed one rather than minting it, and the running client shows the shape as `msg_…`.

The plugin's turn state carries `model`, `parentValue`, `project`, `provider` and `value` (`src/turn-store.ts`), and none of them is a message id: `value` is the session's derived id, which is a different object from the message. The stream hook's `options` carries no message either — the adapter builds the body after the hook returns — so there is nothing at this layer to send. This section said for a round that "inventing a value would be worse than omitting the header", and the premise turned out to be the part that was wrong: the gateway reads this header as a metric (`packages/console/app/src/routes/zen/util/handler.ts:127-135`) and the console rewrites it to `x-opencode-request-id` before forwarding, so **what the header has to satisfy is its shape and its one-value-per-request lifecycle — not the CLI's own message table**, which nothing reads back.

So the plugin mints: `newOpenCodeMessageId` (`src/session.ts`) returns `msg_` + 12 hex + 14 base62 — the vendor's own skeleton — with the twelve hex carrying `milliseconds * 0x1000 + counter` modulo `2^48` and the suffix drawn from `randomBytes`. `stream-hook.ts` mints once per turn and stores it as `requestValue`; `fetch-patch.ts` sends it beside the client and project headers. Two properties were chosen deliberately: the value is random rather than derived from message content (a digest of the user's text travelling in a header would be a guessable fingerprint), and it is per-turn rather than per-message — the client repeats one id across a multi-step tool turn, and with no DSH message id reachable from this layer the turn is the largest unit that can honestly own one. The measurement in `docs/opencode-1.19-api.md` closed the question the other way: with the complete set sent — this header included — the free tier answered exactly as before. The header is correct to send, and it is not the gate.

## A free model ran on /zen/v1 and may not run on /inference/v1 — measured, unresolved

The observed error is this plugin's own remap with the old wording, which means the running host predates the message change - but the endpoint it was refused on is the new one, and that is the part that matters.

A session did run on `opencode/step-5-preview-free` through this plugin when the mount sent to `…/zen/v1`. Measured on the raw HTTP path, that model is refused on **both** families:

- deployment key → `/zen/v1`: 403, → `/inference/v1`: 403
- installation key → `/zen/v1`: 403, → `/inference/v1`: 403

So a raw client cannot distinguish them for this model, and the session that worked on the old family did so through the host's adapter rather than through any of those. **Whether the adapter's path to `/inference/v1` is treated the same way as its path to `/zen/v1` is not measured**, and it is the first thing to check after a restart: the endpoint change moved every request to the new family, including the free-tier ones.

That is recorded rather than asserted, because the honest position is that the plugin's free models worked on one endpoint in practice and are refused on both in measurement - which is exactly the place this work has been wrong before.

## Both remotes absent at once, and the two console lines that would say why

(`v2` record.) The card reported `the login remote did not answer` and `读不到配额` together while both services were mounted by the same helper. This branch mounts the meter's remote only, so the meter is the one surface whose absence has to be reported.

It is **not** the read race: the login row resolves its remote per call, and the usage summary reads up to five times with a growing wait, so a mount that arrived late would be found by either. Both being absent means the mount did not happen or did not succeed.

The helper warns in exactly two ways, and the console will carry one of them:

- `[dsh-opencode-patch] <what>: the settings context has no remote to mount on` followed by `Object.keys(ctx)` — the settings context exposes no `remote`, which is also what would stop the plugin activating at all if `remote` were a hard inject key.
- `[dsh-opencode-patch] <what> did not mount` followed by the thrown error — `ctx.remote.$mount` rejected.

Neither line is visible in a screenshot, and which one it is decides the fix: the first is a wiring problem in this plugin, the second is the host refusing the contribution. Ask for the line rather than guessing, which is the mistake this file keeps recording.

## pi ships its own stale `opencode` catalog, which is what a plane route answers from

A deployment declares its own `opencode` / `opencode-go` routes and no `models` list, so `llm-pi-ai` resolves them from the catalog pi installs — `dist/providers/data/opencode.json`, keyed by API rather than by provider. That file is a DIFFERENT VINTAGE of models.dev, and the divergence is measured rather than assumed: pi says 272k for `gpt-5.4` and 200k for `claude-sonnet-4-5` where the vendor and our shim both say 1.05M and 1M, and it carries no `thinkingLevelMap` for the `budget_tokens` Claude models where models.dev declares a token minimum.

So a plane route's adapter is a stale source, and decorating `resolveModelInfo` by filling only what it left BLANK let every stale value survive — which is what the surfaces then reported, and what read as "the thinking level and the context are still wrong". Our catalog is the fresher snapshot of the same data, so it is now authoritative for the fields it carries, and the efforts are derived by the same `thinkingLevelMapFor` the internal routes use.

The dispatch path needed no second patch, which is worth knowing before reaching for one: every stale model names an SDK and is therefore redirected to an internal route carrying our fresh profile, and the models that stay on the plane route already agree with the catalog — verified by diffing all 82 Zen and 31 Go entries against pi's file.

## The plane-route override was wrong, and `modelOverrides` is why

An attempt to make a selected model's thinking level survive dispatch mounted a `modelOverrides` profile for the deployment's own `opencode` / `opencode-go` routes. It could not have worked, for three separate reasons read out of `llm-pi-ai`'s resolver rather than assumed:

1. **`modelOverrides` requires `defaults.has(id)`.** The resolver rejects an id the installed catalog does not describe, and in strict validation that is a thrown `INVALID_CONFIG` — so every id absent from pi's catalog, which is most of ours, would have failed the route rather than augmented it.
2. **`entries` comes from `defaults.values()`.** With no `models` list the served set is pi's catalog, so an override id is never in `entries` at all. The entry describes models that already exist; it does not add them.
3. **The route already has an adapter.** `llm.registerAdapter` throws `DUPLICATE_ADAPTER` for a route the host's own instance owns, and the plane routes are exactly those the deployment declared.

So the attempt was reverted whole. What survives is the decoration of the public `resolveModelInfo`, which is what the picker reads and is correct for it: it reports the catalog's context and efforts for a plane route, so the composer offers real levels.

What does NOT work, stated plainly, is the other half. `prepareCall` reads the route's **adapter**, never the public method, and the plane route's adapter resolves its models from pi's installed catalog — where `step-5-preview-free` is absent, because pi ships no `step-5` entry on either plane. A model with no SDK also has no redirect, so it is dispatched on the route the user selected and the adapter answers `UNKNOWN_MODEL`.

The fix is therefore not a mount: it is a route whose adapter the plugin itself owns and whose `models` list carries the catalog's `reasoningEfforts` — the same `models` list the internal routes already use, which works precisely because `configured.length > 0` takes the `entries` from it directly and tolerates ids the installed catalog has never heard of. That means giving the model an SDK so `internalRouteFor` can redirect it, or listing it in the deployment's profile, and neither is something to invent without a measurement of which endpoint the model is actually served on.

## Replacing another plugin's adapter registration is not an API, so the plugin does not try

`src/adapter-replacement.ts` took a provider route over from the adapter that already served it: it released the llm registry's map entry for a route pi-ai held, registered our adapter through `registerAdapter`, and put the original entry back on disposal. Nothing in `src/` ever imported it, and P1b deleted it with its test.

It could not have been wired, and the reason is read from the host's llm runtime (`packages/llm/llm/src/index.ts`) rather than assumed:

1. **`registerAdapter` is all-or-nothing against a private map.** `prepareRoutes` throws `DUPLICATE_ADAPTER` for any route another registration holds (`:440-444`), so the only way in was to delete that registration's entry first.
2. **Only the owner moves its routes.** A registration's routes change through its own `handle.replace`, the method `registerAdapter` returns on its handle (`:421-428`). Nothing else is an API for it.
3. **The owner's disposer deletes what it still believes it holds.** On dispose, the registration deletes every route in its `owned` set and emits `llm/adapters-updated` (`registerAdapter`'s disposer, `:411-416`). An entry deleted from outside leaves pi-ai's registration believing it still owns the route, so its next dispose or restart deletes OUR entry — the plane then answers `NO_ADAPTER` — and its next `replace` registers over us. This failure mode is read from the host's disposer and has not been run. S0's handback failed for a different reason: the prototype released its registration while its own config listener was still live (see the plan's spike record), which is why P-R1 calls its handle and then makes its listener inert in one synchronous section, with no await between them, and restarts pi-ai only after both (the plan's Teardown).

What the plugin does instead (D13, landing in P-R1 as `src/host/route-claim.ts`): keep pi-ai from claiming `opencode` / `opencode-go` in the first place, through the config waterfall — a prepended `internal/config` listener strips the two plane keys from a copy of the config pi-ai reads — and register its own adapter under the same ids through the ordinary `registerAdapter`. On teardown it releases its own handle and restarts pi-ai, which hands the routes back. It never deletes another plugin's registration; `test/architecture.test.ts` fails the build on a direct `adapters.delete` / `set` / `clear` call (optional chaining included) anywhere in `lifecycle.ts`'s static import graph.

## A placeholder in a string has no spelling this linter accepts

`check.ts` asserts the refresh push carries the PAT by looking for the token URL as a literal, and the literal carries the workflow's own placeholders. Written plainly (`"…${GH_TOKEN}…"`), `no-template-curly-in-string` flags it; written with escapes (`"…\${GH_TOKEN}…"`), `no-useless-escape` flags every escape instead — a plain string has no spelling this oxlint accepts. A regex literal is not an escape hatch either: `prefer-includes` rejects a pattern that is a static string. The one spelling both rules accept is a template literal with `\${`: there the backslash is the documented way to write a literal placeholder, and neither rule applies.

The red run that followed was the verification's fault, not the lint's. The check was run as `pnpm run check | grep …`, and a pipeline reports its last command's exit status, so a failing check read as success and the commit went out red. `pnpm run check; echo exit=$?` — or `set -o pipefail` — is the form that cannot lie.

## A wrapped method must keep its receiver, and a foreign adapter is not ours to wrap

`decoratePlaneAdapters` extracts `adapter[method]`, replaces it, and calls the extracted original. The first version called that original DETACHED, `original(provider, model, signal)`, which is only safe while every adapter's methods are closures. The registry holds class instances instead: pi-ai's `resolveModel` and `prepareCall` both open with `this.current()`, and Command Code's reads `this.currentCatalogState()`. With a detached call `this` is `undefined`, so `session/modelCatalog` answered seven failures - the six pi-ai groups (`opencode-go`, `antigravity`, `nvidia`, `workbuddy`, `opencode`, `minimax-cn`) with `Cannot read properties of undefined (reading 'current')`, and `commandcode` with `…('currentCatalogState')` - and the picker showed one failed group per provider with nothing selectable.

Two properties decided the blast radius, and both pointed the same way:

- **The suite could not see it.** The mock adapters are plain objects of arrow functions, so the extracted call behaved exactly like the method; an arrow cannot fail when the receiver is lost, and the suite stayed green while every class-based adapter answered "Cannot read properties of undefined".
- **The loop wrapped every adapter in the registry.** `catalogPlaneForRoute` answers a plane for ANY route (defaulting to Zen), so nothing excluded foreign adapters - which is how our wrapper reached a third-party adapter, Command Code's.

The fix is `Reflect.apply(original, adapter, [provider, model, signal])`, the idiom `decorateModelInfo` already used for the service method, plus a `route in PLANES` gate on the loop. The shared pi-ai adapter still receives the wrap through its plane routes, so the fill keeps applying to its models on every route; an adapter behind no plane route keeps its own methods. The regressions are two cases that fail on the previous code: a class-based adapter whose method reads `this`, and a foreign route that must stay unwrapped.

Measured on the running deployment after the rebuild: `session/modelCatalog` answers with every group populated and `failures: []`.
