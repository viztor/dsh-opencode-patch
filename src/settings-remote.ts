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
 * @module dsh-opencode-patch/settings-remote
 */

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
