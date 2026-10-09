# Engineering notes

Design decisions and protocol findings behind this plugin, written for someone integrating with OpenCode or writing another DSH plugin. The user-facing description is the [README](../README.md); the protocol internals are [deep-dive](./deep-dive.md) and [protocol routing and merge](./protocol-routing-and-merge.md).

## The session id is the vendor's, character for character

`ses_<12 hex><14 base62>` — read off the vendor's own generator rather than inferred:

```ts
let now = BigInt(currentTimestamp) * BigInt(0x1000) + BigInt(counter);
return prefix + "_" + timeBytes.toString("hex") + randomBase62(LENGTH - 12);
```

Two things follow, and both matter:

- **The twelve hex characters are a timestamp**, `milliseconds * 0x1000 + counter`, and the vendor parses them back (`timestamp(id)` divides by `0x1000`). Filling them with hash bytes would hand the vendor a random creation instant, and a non-hex alphabet makes that parser throw. So the timestamp comes from the session's own creation time — real, stable, and identical on every turn, in every process and after a restart, without a clock and without state.
- **The vendor's buffer is six bytes**, so the value is truncated to 48 bits and the embedded time wraps roughly every 795 days (a bug they have filed: [anomalyco/opencode#42589](https://github.com/anomalyco/opencode/issues/42589)). We mirror it exactly, wrap included: a value that recovers a different millisecond than was put in is what a _real_ id does too, and being indistinguishable is the point.

**Ascending vs descending is not cosmetic.** `descending` is the bitwise NOT of the timestamp value, so the same instant sorts to the opposite end of a lexicographic list — and the vendor's own reader documents that it "does not work with descending IDs". A wrongly-directed id does not merely sort oddly; its embedded time reads as garbage. Direction is a per-type choice (`msg_` and `prt_` may differ from `ses_`); we mint only session ids, so we emit ascending.

A parity test runs the vendor's reader against ids we mint — including a case that fails if the alphabet is ever changed back to something that only _looks_ like an id.

## Two endpoint levels, and two ways to authenticate

OpenCode's endpoints are not pinned in its source: they come from the catalog (`models.dev`), which defines a **provider default** (`api` on the provider — `https://opencode.ai/zen/v1` for Zen, `https://opencode.ai/zen/go/v1` for Go) and a per-model **inference** endpoint (`model.api.url`) that overrides it. The CLI resolves `model.api.url ?? provider default`, which is exactly why this plugin matches the `opencode.ai/zen` **marker** instead of a base URL: a model served from the default and one served from its own endpoint are both patched.

Authentication follows the **wire shape**, not the endpoint. The OpenAI planes (`/chat/completions`, `/responses`) send `Authorization: Bearer <key>`; the Anthropic plane (`/messages`) sends `x-api-key: <key>`. That is why the credential extractor reads `Authorization` first and falls back to `x-api-key` / `api-key` — not defensive coding, but the two SDK families the three shapes come from.

## The free-tier gate

The Zen gateway rejects free-tier `/responses` bodies that lack `read` and `bash` in `tools`, while DSH deliberately does not send them. The plugin rewrites the body to carry both schemas — **and only when they are genuinely missing**, so a body that already declares them passes through byte-identical. Detection is by model id (default marker `"free"`, `"*"` for every model), because a model row carries no capability flag.

## A credential prefix is not an entitlement

A guard that refused to query the Go quota endpoint with a key starting `oc_sk_` — on the belief that the prefix meant "Zen, no Go entitlement" — was wrong within one vendor release: the same prefix works on both planes, and the endpoint answers `200` with real windows. What separates the tiers is the **observed request**, never a string prefix. The endpoint's own answer is evidence; a guess about a vendor's key format is not.

## What the meter shows, and why

- **The default window is the 5-hour one**, not the largest number. A window is shown only when it is actually out (rate-limited or at its cap), widest first; otherwise the smallest window that can still refuse you is the one worth printing. The hover lists all three, because the trigger can only print one.
- **Zen draws no ring**, because a ring is a gauge and Zen has no window to run out of. Its number is the session spend.
- **The spend is split by the plane that served each turn**, not by the model's home: the question is which balance paid.
- **No estimates.** When a number cannot be honest — the within-allowance vs overage split is not published — the panel states the mechanism instead of inventing a figure. An estimate wearing a precise outfit reads as a measurement, and readers make decisions on it.
- **One frame, one list.** The panel is the floating surface; rows inside it are plain text. A row that draws its own background is a box inside a box, and a field that repeats a number already on screen is not a second fact.
- **A row that disappears reads as a deleted feature.** Absent data gets an explicit empty state, not omission.

## Rules that came out of real failures

- **Start from the host's built-ins.** The UI kit ships the components _and_ one CSS module each — the fastest inventory of the host's design language available. A hand-rolled look-alike is one whose CSS module was never opened, and it is smaller, wrong and unthemed next to the built-in.
- **Declare cross-plugin services with `ctx.inject`.** Reading them off the root context fails silently, because every access in that path is optional.
- **A `Tooltip` clones its child.** Wrap a DOM node, never a component: the clone's handlers land on something that ignores unknown props, and the tooltip never appears.
- **Opt into the theme instead of re-declaring it.** A hand-set elevation stroke pins one theme's answer and silently breaks the other's — and it looks correct in whichever theme you test it in.
- **A countdown floors, and its word order belongs to the language.** A reset line is a sentence: English wants the word first, Chinese wants it last, and one copy key cannot serve both shapes.
- **A comment that describes intended behaviour is not evidence of it.** Read the code the comment is attached to before trusting it; a doc comment had described the opposite of what the function did for several sessions.
- **Verify the artifact, not the command's output.** A grep over a directory that does not exist is indistinguishable from a grep that found nothing, and a cached registry read makes a completed operation look pending. Assert that the input was actually read, and include a case whose answer you already know.
- **A test for a behaviour must perform that behaviour.** Asserting a constant is not the same as exercising a switch — and a fixture that sits exactly on a floored boundary is a race, not a test.
