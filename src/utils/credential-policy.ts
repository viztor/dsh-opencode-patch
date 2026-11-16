/**
 * The credential rules every decider shares, as pure functions.
 *
 * Four places answer "which key?" — the fetch patch's fill for an empty or
 * placeholder wire key, the Go meter, the Zen credit check and the plane
 * adapter (D20) — and they used to carry their own copies of the same rules:
 * which values are not credentials, the order a policy imposes, and when a key
 * seen on the wire may be kept. This module is the one copy of each; the
 * effects that read a header, the environment, a store or a service live in
 * `credentials.ts` and ask here.
 *
 * Everything here is a function of its arguments: no context, no globals, no
 * I/O.
 *
 * @module dsh-opencode-patch/utils/credential-policy
 */

/**
 * The policy that orders the credential sources, as `config-values.ts`
 * declares it. Restated rather than imported, because a utility imports
 * nothing outside this folder; a test pins the two lists equal.
 */
export type KeySourcePolicy = "auto" | "configured" | "request";

/**
 * Bearer values the DSH adapter emits when it holds no real credential, plus the
 * gateway's own keyless sentinel.
 *
 * These are the exact strings the Authorization fallback exists to repair, so
 * they must never be *recorded* as a captured key: doing so overwrites a working
 * key with a dummy one, and every later lookup then re-injects the dummy.
 *
 * `public` is not an adapter placeholder — it is the gateway's own literal for a
 * keyless request, the vendor's own path for a model whose entry allows
 * anonymous use. The proxy treats no key and the literal alike, strips it and
 * forwards keylessly (`packages/console/app/src/lib/inference-proxy.ts`, both
 * 1.19 and 2.x: `const anonymous = !key || key === "public"`). What the service
 * behind the proxy answers is its own decision — the Zen free tier is refused
 * there — but the sentinel must never become a credential: capturing it would
 * forward `Bearer public`, turning an anonymous request into an authenticated
 * one. See `docs/upstream-findings.md` §1.5.
 */
export const PLACEHOLDER_API_KEYS: ReadonlySet<string> = new Set([
  "null",
  "none",
  "public",
  "undefined",
  "unused",
]);

/** Whether a value is one of the adapter's placeholder credentials. */
export const isPlaceholderApiKey = (key: string): boolean =>
  PLACEHOLDER_API_KEYS.has(key.trim().toLowerCase());

/**
 * The one filter: a value worth sending as a credential, trimmed, or
 * `undefined`.
 *
 * Every decider's answer leaves through here, so a blank (`"   "` is what a
 * YAML file produces when someone indents a secret they then blank out) or a
 * placeholder never reaches the wire or the usage endpoint, whichever source
 * produced it — a declared variable, the credentials service, a captured
 * request or the installation's store.
 *
 * @param value - anything a source answered.
 * @returns the trimmed key, or `undefined`.
 */
export const usableKey = (value: unknown): string | undefined => {
  if (typeof value !== "string") {
    return undefined;
  }
  const key = value.trim();
  return key.length === 0 || isPlaceholderApiKey(key) ? undefined : key;
};

/**
 * Whether the key on the wire needs the fill: none, blank, or a placeholder.
 * A real key the caller sent is never replaced.
 *
 * @param wireKey - the key the request's credential header carries.
 */
export const needsFill = (wireKey: string | undefined): boolean =>
  usableKey(wireKey) === undefined;

/** One source the fill can consult. */
export type FillSource = "captured" | "declared" | "request" | "store";

/**
 * The fill's order per policy.
 *
 * The request's own key first (a real one in another credential header), then
 * a key captured on a decorated turn, then the plane's declared variable, and
 * the installation's store last. `configured` drops the captured step: the
 * declared credential wins outright, and a captured key never fills.
 */
export const FILL_ORDER: Readonly<
  Record<KeySourcePolicy, readonly FillSource[]>
> = {
  auto: ["request", "captured", "declared", "store"],
  configured: ["request", "declared", "store"],
  request: ["request", "captured", "declared", "store"],
};

/**
 * One lookup step the meter can consult.
 *
 * `captured` is scoped to the route in hand; `capturedAny` accepts a key
 * captured under any route. They are separate steps so `auto` can keep
 * credentials ahead of the any-route fallback, exactly as it always has.
 *
 * `opencodeStore` is the installation's own store, and it is LAST in every
 * policy rather than placed among them: everything the user declared — a
 * literal, a captured request, a named reference — outranks anything inferred
 * from another program's files.
 */
export type MeterSource =
  | "captured"
  | "capturedAny"
  | "configured"
  | "literal"
  | "opencodeStore";

/**
 * The lookup order each policy imposes on the meter — the only thing the user
 * is choosing between.
 *
 * `auto` reproduces the original precedence exactly, so the default is not a
 * behaviour change: composition first, then a captured key in the right tier,
 * then credentials/env, then any captured key. `request` promotes both captured
 * steps above the declared sources; `configured` does the reverse.
 *
 * The captured steps read only keys filed under the Go plane, in all three
 * policies — but a key is filed by the plane its request went to, not by what
 * it is entitled to. Nothing here can tell a Zen key from a Go key: a Go entry
 * without `apiKeyEnv` sends pi's `OPENCODE_API_KEY` on its turns (D20), that
 * bearer is filed as a Go key, and `auto` then sends it to the Go usage
 * endpoint, which refuses it. Naming the reference on the Go entry is the fix.
 *
 * The store is appended to all three, and to none of them in the middle: the
 * policy orders the sources the user declared, and the installation's store is
 * never one of those.
 */
export const METER_ORDER: Readonly<
  Record<KeySourcePolicy, readonly MeterSource[]>
> = {
  auto: ["literal", "captured", "configured", "capturedAny", "opencodeStore"],
  configured: [
    "literal",
    "configured",
    "captured",
    "capturedAny",
    "opencodeStore",
  ],
  request: [
    "captured",
    "capturedAny",
    "literal",
    "configured",
    "opencodeStore",
  ],
};

/**
 * The first usable answer of a policy's steps, in order, or `undefined`.
 *
 * Lazy: a later step's thunk is not called once an earlier one has answered,
 * so a source the policy did not reach is never read. The filter is applied
 * here, once, at the exit.
 *
 * @param order - the steps, in the policy's order.
 * @param steps - one thunk per step.
 * @returns the step that answered and its key, or `undefined`.
 */
export const firstUsable = <Step extends string>(
  order: readonly Step[],
  steps: Readonly<Record<Step, () => unknown>>
): { readonly step: Step; readonly key: string } | undefined => {
  for (const step of order) {
    const key = usableKey(steps[step]());
    if (key !== undefined) {
      return { key, step };
    }
  }
  return undefined;
};

/**
 * {@link firstUsable} over steps that may answer a promise, awaited in order.
 *
 * Sequential on purpose: the order IS the policy, and a later step must not
 * run (or be able to throw) once an earlier one has answered.
 *
 * @param order - the steps, in the policy's order.
 * @param steps - one thunk per step.
 * @returns the first usable key, or `undefined`.
 */
export const firstUsableAsync = async <Step extends string>(
  order: readonly Step[],
  steps: Readonly<Record<Step, () => unknown>>
): Promise<string | undefined> => {
  for (const step of order) {
    // oxlint-disable-next-line no-await-in-loop -- see above; order is the contract.
    const key = usableKey(await steps[step]());
    if (key !== undefined) {
      return key;
    }
  }
  return undefined;
};

/**
 * Whether a key seen on a request may be recorded (OC3).
 *
 * Only a request of a turn the stream hook decorated: the plugin then knows
 * the route the key was sent for, and the key is one the turn's own adapter
 * sent. A request outside any such turn — a Console call, another plugin's
 * background request — carries a token the plugin did not send, and a turn
 * on a plane another plugin owns (`foreign`) or a request carrying a plugin's
 * marker is that plugin's (D27). The fetch patch returns before this for the
 * last two; they are inputs here so the rule is one function.
 */
export const mayCapture = (request: {
  readonly decorated: boolean;
  readonly foreign: boolean;
  readonly marked: boolean;
}): boolean => request.decorated && !request.foreign && !request.marked;

/**
 * How many well-formed 401s in a row drop a captured key (L8).
 *
 * Not one: the gateway answers a malformed session header with `401 Invalid
 * API key`, and the same request has been seen refused and then accepted, so
 * one refusal does not prove the key bad. A second refusal in a row, with a
 * well-formed session and no success between, does.
 */
export const EVICT_AFTER = 2;

/**
 * One answer folded into a captured key's strike count.
 *
 * @param strikes - the count so far.
 * @param outcome - `accepted` for a 2xx, `refused` for a well-formed 401.
 * @returns the new count, and whether the key is to be dropped.
 */
export const strike = (
  strikes: number,
  outcome: "accepted" | "refused"
): { readonly strikes: number; readonly evict: boolean } => {
  if (outcome === "accepted") {
    return { evict: false, strikes: 0 };
  }
  const next = strikes + 1;
  return { evict: next >= EVICT_AFTER, strikes: next };
};

/**
 * Whether an answer counts against the key it was sent with: a 401, on a
 * request whose session id was well-formed (a malformed one draws the same
 * 401 whatever the key), that carried a key at all.
 */
export const countsAsRefusal = (answer: {
  readonly status: number;
  readonly sessionWellFormed: boolean;
  readonly keySent: boolean;
}): boolean =>
  answer.status === 401 && answer.sessionWellFormed && answer.keySent;
