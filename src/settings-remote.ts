/**
 * Reading a plugin's own namespace off a Cordis remote, safely.
 *
 * **Why this exists and why it is not inline.** Cordis guards property access on
 * a remote by NAME: a namespace this bundle has not declared in `inject` THROWS
 * `cannot get property "remote.<ns>" without inject` rather than answering
 * `undefined`, and an optional chain cannot catch a throw. So
 * `scope.remote.opencodeGoUsage` takes the whole slot entry down — and it takes
 * it down in a way indistinguishable from a host that mounts no service at all.
 *
 * This was fixed once, in the usage meter's injector, and the same unguarded read
 * survived in the settings card. A guard that has to be remembered is a guard
 * that gets missed; it lives here once, and both call sites read through it.
 *
 * Declaring the names in `inject` is NOT the fix. A name there is a HARD gate
 * that holds the whole plugin until it exists, which is what took the meter out
 * once with "web boot: 1 entry did not activate".
 *
 * It is also where every Remote answer is unwrapped, once, for every caller:
 * {@link callRemote} finds the call, makes it, and parses the answer with the
 * contract's own parser ({@link unwrapRemote}).
 *
 * @module dsh-opencode-patch/settings-remote
 */

import type { RemoteMethod } from "./contracts/remote.ts";

/** One call on a remote namespace, as the seam exposes it. */
export type RemoteCall = (query?: unknown) => Promise<unknown>;

/** The reachable calls of one namespace, or `undefined` when it is not. */
export type RemoteNamespace = Record<string, RemoteCall | undefined>;

/**
 * Whether a value is an object, narrowed without an assertion.
 *
 * `isRecord` from `guards.ts` does exactly this and is already the house
 * predicate; it is re-used rather than restated so the narrowing is a guard the
 * compiler follows instead of a cast it only tolerates.
 */
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/**
 * The namespace's calls, or `undefined` when the namespace is not reachable.
 *
 * Three ways it is not reachable, all answering `undefined`: there is no remote,
 * the remote has no such namespace, and the access THROWS because the bundle
 * never declared the name.
 *
 * @param remote - the host's remote face.
 * @param namespace - the namespace to read.
 * @returns the namespace's calls, or `undefined`.
 */
export const remoteNamespace = (
  remote: unknown,
  namespace: string
): RemoteNamespace | undefined => {
  try {
    if (!isObject(remote)) {
      return undefined;
    }
    const face: unknown = remote[namespace];
    if (!isObject(face)) {
      return undefined;
    }
    // The one cast, and it is a widening of a value already known to be a plain
    // object: the seam's own shape, whose members are checked at the call site
    // by `isRemoteCall`. Narrowing each key here would validate the whole
    // namespace to read one function off it.
    return face as RemoteNamespace;
  } catch {
    // The guarded-access throw. Ordinary, and exactly what this is for.
    return undefined;
  }
};

/** Whether a value is one of the seam's call shapes. */
export const isRemoteCall = (value: unknown): value is RemoteCall =>
  typeof value === "function";

/**
 * The zero-argument refusal DSH answers when it validates a call's arity.
 *
 * The endpoint is deliberately not named: both reads this bundle makes go
 * through it, and the wording is the harness's. A message it stops emitting
 * simply means no fallback, and the original error surfaces — the safe way to
 * be wrong.
 */
const ARITY_REFUSAL = /^client api: \S+ expected 0 argument\(s\), got \d+$/u;

/**
 * Call `opencodeGoUsage.read`, tolerating the sibling registration.
 *
 * `dsh-opencode-go` declares the same endpoint with no parameters, and DSH
 * validates the argument count against whichever registration the CLIENT holds
 * — which need not be the service the Host resolves for the call. When the
 * sibling's declaration wins, a scoped read is refused before it leaves the
 * browser (`client api: opencodeGoUsage/read expected 0 argument(s), got 1`) and
 * the meter reports "refresh failed" for a Host that is answering.
 *
 * Retrying unscoped reads the account the configured route selects, which is the
 * only account one meter can price anyway.
 *
 * @param call - the namespace's `read`.
 * @param query - the arguments this bundle would like to pass.
 * @returns the call's answer.
 */
export const callUsageRead = async (
  call: RemoteCall,
  query: Record<string, string>
): Promise<unknown> => {
  try {
    return await call(query);
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (!ARITY_REFUSAL.test(message)) {
      throw error;
    }
    return await call();
  }
};

/**
 * Read a namespace through the CONTEXT rather than the remote face.
 *
 * **This is the read that works for a namespace this bundle mounts itself.**
 * `remote.<namespace>` is a Cordis service property, so reading it requires the
 * name in `inject` — and a name there is a hard gate that holds the whole plugin
 * until it exists, which is a deadlock when the same plugin is what mounts it.
 * Cordis refuses the property access with
 * `cannot get property "remote.<ns>" without inject`, {@link remoteNamespace}
 * catches that and answers `undefined`, and the meter then reports
 * "no usage service" for a service that is mounted and answering.
 *
 * Measured in a browser console, after the contribution mounted:
 *
 *   property read: false; ctx.get('remote.opencodeGoUsage'): object
 *
 * `ctx.get` does NOT consult `inject` (cordis reads the scope's store directly),
 * so it reaches the namespace without declaring it. That is the documented
 * difference between `get` and property access, and it is exactly the seam this
 * needs.
 *
 * @param ctx - any context in the composition the contribution mounted on.
 * @param namespace - the Remote namespace to read.
 * @returns the namespace's calls, or `undefined` when it is not mounted.
 */
export const remoteNamespaceOf = (
  ctx: unknown,
  namespace: string
): RemoteNamespace | undefined => {
  if (!isObject(ctx)) {
    return undefined;
  }
  const { get } = ctx as { get?: (name: string) => unknown };
  if (typeof get !== "function") {
    return undefined;
  }
  try {
    const face: unknown = get.call(ctx, `remote.${namespace}`);
    return isObject(face) ? (face as RemoteNamespace) : undefined;
  } catch {
    return undefined;
  }
};

/** A contract, as the unwrap reads it: its namespace and each result parser. */
interface Contract<Method extends string, Value> {
  readonly namespace: string;
  readonly methods: Readonly<Record<Method, RemoteMethod<Value>>>;
}

/** The call a contract's method resolves to, or the keys found instead. */
export type FoundCall =
  | { readonly call: RemoteCall }
  | { readonly call: undefined; readonly exposed: readonly string[] };

/** The scope's `remote` face, or `undefined` when it is absent or the read throws. */
export const remoteFaceOf = (scope: unknown): unknown => {
  try {
    return isObject(scope) ? scope.remote : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Find one method of a contract on the scope: through `ctx.get` first, then
 * the guarded property (see {@link remoteNamespaceOf}).
 *
 * @param scope - the scope the caller was rendered with.
 * @param contract - the contract; only its namespace is read.
 * @param method - the method to find.
 * @returns the call, or the keys the namespace (else the remote) exposes.
 */
export const findRemoteCall = (
  scope: unknown,
  contract: { readonly namespace: string },
  method: string
): FoundCall => {
  const viaGet = remoteNamespaceOf(scope, contract.namespace);
  // `scope.remote` is read only when `ctx.get` found nothing, and guarded: a
  // getter that throws (`cannot get property "remote" without inject`) reads
  // as no remote, never as a throw out of a slot injector.
  const remote = viaGet === undefined ? remoteFaceOf(scope) : undefined;
  const namespace = viaGet ?? remoteNamespace(remote, contract.namespace);
  const call = namespace?.[method];
  if (isRemoteCall(call)) {
    return { call };
  }
  return {
    call: undefined,
    exposed: Object.keys(namespace ?? (isObject(remote) ? remote : {})),
  };
};

/** One answer, unwrapped: the parsed value, the host's refusal, or neither. */
export type RemoteAnswer<Value> =
  | { readonly kind: "ok"; readonly value: Value }
  | {
      readonly kind: "refused";
      readonly error: unknown;
      readonly reason: string | undefined;
    }
  | { readonly kind: "invalid"; readonly value: unknown };

/** A refusal's reason: the envelope's `message`, else the error's own words. */
const reasonOf = ({
  error,
  message,
}: Record<string, unknown>): string | undefined => {
  if (typeof message === "string") {
    return message;
  }
  if (typeof error === "string") {
    return error;
  }
  return isObject(error) && typeof error.message === "string"
    ? error.message
    : undefined;
};

/**
 * THE one unwrap of a Remote answer. The gateway answers `{ ok, value | error }`;
 * a bare value, or `{ value }`, is read as the payload. The payload is parsed
 * with the contract's own result parser: a throw or `undefined` is `invalid`.
 *
 * @param contract - the contract the call was made through.
 * @param method - the method that answered.
 * @param answer - what the call resolved to.
 * @returns the answer, unwrapped.
 */
export const unwrapRemote = <Method extends string, Value>(
  contract: Contract<Method, Value>,
  method: Method,
  answer: unknown
): RemoteAnswer<NonNullable<Value>> => {
  let payload = answer;
  if (isObject(answer) && typeof answer.ok === "boolean") {
    if (!answer.ok) {
      return { error: answer.error, kind: "refused", reason: reasonOf(answer) };
    }
    payload = answer.value;
  } else if (isObject(answer) && "value" in answer) {
    payload = answer.value;
  }
  let value: Value | undefined;
  try {
    value = contract.methods[method].result.schema.parse(payload);
  } catch {
    value = undefined;
  }
  return value === undefined || value === null
    ? { kind: "invalid", value: payload }
    : { kind: "ok", value };
};

/** A call's outcome: its answer, or no call to make. */
export type RemoteOutcome<Value> =
  | RemoteAnswer<Value>
  | { readonly kind: "unavailable"; readonly exposed: readonly string[] };

/**
 * Find, call and unwrap one method. With no `argument` the call takes NONE:
 * the client gateway refuses a call whose count differs from the descriptor's.
 * A rejected call rejects.
 *
 * @param scope - the scope the caller was rendered with.
 * @param contract - the contract to call through.
 * @param method - the method to call.
 * @param argument - the one argument, for a method that takes one.
 * @returns the outcome.
 */
export const callRemote = async <Method extends string, Value>(
  scope: unknown,
  contract: Contract<Method, Value>,
  method: Method,
  argument?: unknown
): Promise<RemoteOutcome<NonNullable<Value>>> => {
  const found = findRemoteCall(scope, contract, method);
  if (found.call === undefined) {
    return { exposed: found.exposed, kind: "unavailable" };
  }
  const answer =
    argument === undefined ? await found.call() : await found.call(argument);
  return unwrapRemote(contract, method, answer);
};
