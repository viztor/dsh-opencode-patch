/**
 * pi-ai never claims the planes; the plugin registers its own adapter under
 * them (D13, docs/improvement-plan.md "The design").
 *
 * Four parts, each on a supported host path:
 *
 * - **The listener.** ONE `internal/config` listener on the plugin's root,
 *   APPENDED, that speaks both call shapes the host core dispatches
 *   (`utils/config-run.ts`): the OLD core (cordis 4.0.5, 4.0.6-alpha.1) calls
 *   it as `function (this: Fiber, raw, next)`, the NEW one (4.0.6-alpha.2,
 *   4.1.0) as `(fiber, next)` with `this` null. On both, `next` is the last
 *   argument and is called exactly once (the NEW core throws on a second
 *   call), and what it answers is the run's raw candidate, because the
 *   listener is the innermost: appended, it is inner to the loader's
 *   interpolate and, on the NEW core, to the built-in schema listener; and it
 *   re-appends itself whenever pi-ai reaches `internal/status` ACTIVE,
 *   because pi-ai registers its own checking listener at every activation,
 *   which would otherwise sit inner to the claim and see the planes. For the
 *   pi-ai fiber it serves only (see {@link installRouteClaim}'s `servedRow`:
 *   the served row is sticky while it is live and declares a plane, else the
 *   first live row that declares one, else the first live row); another
 *   pi-ai row keeps its planes and serves them itself, and is reported once —
 *   it returns a fresh copy without the plane keys it TAKES, so pi-ai resolves
 *   and registers every other route and never sees those planes (F11, F12) —
 *   its own save check included, which a strip that let the raw value through
 *   would not shield. A plane entry another plugin owns is not taken (D27,
 *   `utils/plane-ownership.ts`): pi-ai's row resolving `credentials` in a
 *   realm the plugin's context does not (a group's realm counts as its
 *   rows'), or an entry carrying the `x-opencode-plugin` header. It stays in
 *   pi-ai's copy, pi-ai validates and serves it, it is logged once, and
 *   nothing below — a restart, the reconcile's wait, the handback, the
 *   Settings graft — counts it; a commit run releases a plane the plugin had
 *   registered and no longer takes before pi-ai registers it. The user's file keeps every entry: the editor writes the
 *   raw value, never the resolved one. A commit run (`isCommitRun`: the raw
 *   value is the fiber's own raw config or the loader's stored row config, or
 *   the fiber is not ACTIVE, F14) schedules {@link reconcile}; an editor
 *   candidate has its changed plane entries validated strictly, and a
 *   malformed one is refused in pi-ai's message style. A commit run never
 *   throws: that would fail pi-ai's fiber and every route it holds, and on the
 *   NEW core a FAILED fiber recovers only through `update()`.
 *
 *   **A constraint this places on the OLD core (F12).** cordis 4.0.5's
 *   `Fiber.update(config, noSave)` hands the RESOLVED value to
 *   `internal/update`, where loader 1.0.6 writes it to the row's options and
 *   the profile unless `noSave` is set (`cordis/src/fiber.ts:736-753`,
 *   `loader/src/index.ts:115-121`). So a `piFiber.update(raw)` with `noSave`
 *   false would persist this copy and delete both planes from the user's
 *   file. No caller does that — the editor writes the raw value, and the
 *   loader's own update passes `noSave = true` (`loader/src/config/entry.ts`)
 *   — and the same path would already write interpolated `!!js` values for
 *   any plugin. On the NEW core persistence moved to `internal/commit`, which
 *   carries the RAW value (`cordis/src/fiber.ts:787-789` at 4.1.0,
 *   `loader/src/index.ts:112-120` at 1.1.0), so the constraint does not arise.
 * - **Reconcile.** Reads the committed plane entries from pi-ai's raw
 *   config (`rawConfigOf`), interpolates them with the loader's `interpolate`
 *   (F16), normalizes them with pi-ai's `Config`, builds the profiles
 *   (`utils/plane-profile.ts`), and registers the declared planes with
 *   `registerAdapter`, or moves them with `handle.replace` when the route set,
 *   a `displayName` or a retry policy changed. It also runs on every
 *   `llm/adapters-updated`, on pi-ai's `loader/partial-dispose`, and when a
 *   catalog refresh lands (the memo key holds the catalog's generation).
 *   When the served pi-ai changes — only when it is disposed or stops
 *   declaring a plane, so the previous one never has a stripped plane to take
 *   back — the previous one's handle and profiles are dropped first, and a new
 *   served row already holding a plane is restarted once it settles, as the
 *   mount does. A live change of the served row's `isolate` alone, which
 *   swaps its realm map with no config run (D27), is reconciled the same
 *   way: a plane pi-ai resolved stripped and now keeps is released and pi-ai
 *   restarted once it settles; a plane it resolved holding and the claim now
 *   takes restarts it. Each restart is asked once per need.
 * - **Mount.** Inside `apply`'s promise, never on a timer: when pi-ai applied
 *   first and already holds a plane, wait for it to settle and restart it
 *   once, so it re-resolves through the listener (F17) — unless the host's
 *   modules cannot be read, when it stands down with no restart at all.
 * - **Teardown.** One effect, registered first so it runs last: release the
 *   handle and go inert with no await between; then, only on a real dispose
 *   (`ctx.fiber.uid === null`) with pi-ai live and its parent not unloading,
 *   wait for pi-ai to settle and restart it if it resolved without a plane it
 *   declares, so it takes the planes back — a pi-ai that was LOADING resolved
 *   through the still-active listener too. A reload of the plugin's own row
 *   restarts pi-ai zero times, and unsubscribes from the catalog all the
 *   same. The stand-down when the host's modules cannot be read hands back
 *   the same way, whether or not a plane is declared yet, so a plane a
 *   Settings save adds later goes to pi-ai's own save check.
 *
 * The registry and `adapter.config` are never read: what pi-ai holds is read
 * from its fiber's resolved config (`effectiveConfigOf`). Every fiber config
 * is read through the feature-detected accessors, never `_config` or a
 * resolved `config` directly.
 *
 * @module dsh-opencode-patch/host/route-claim
 */

import { attachmentResolvers } from "../attachment-services.ts";
import { OPENCODE_FAMILY_API } from "../catalog-data.ts";
import type { ResolvedPluginConfig } from "../config.ts";
import {
  type AdapterRegistrationLike,
  type CordisContext,
  type HostFiber,
  type HostModules,
  loadHostModules,
  PI_AI_RUNTIME,
  piAiFibers,
} from "../cordis-context.ts";
import {
  catalogGeneration,
  getLiveGoCatalog,
  getLiveZenCatalog,
  onCatalogChange,
} from "../models-catalog.ts";
import {
  configRunOf,
  effectiveConfigOf,
  isCommitRun,
  rawConfigOf,
} from "../utils/config-run.ts";
import { isFunctionLike, isRecord } from "../utils/guards.ts";
import {
  type ForeignRealm,
  foreignCredentialsRealm,
  stepAsideMessage,
  steppedAsidePlanes,
  takenPlanes,
} from "../utils/plane-ownership.ts";
import {
  planeEntriesOf,
  planeProfileFor,
  withoutPlaneProviders,
} from "../utils/plane-profile.ts";
import { PLANE_ROUTES, type PlaneRoute } from "../utils/protocols.ts";
import {
  buildPlaneProvider,
  createPlaneAdapter,
  planeApiKeyResolver,
  planeAuth,
  type PlaneProfileLike,
} from "./plane-provider.ts";

/** cordis `FiberState`. */
const ACTIVE = 2;
const FAILED = 3;
const UNLOADING = 5;

/** What {@link installRouteClaim} hands the rest of `apply`. */
export interface RouteClaim {
  /** The interpolated, normalized committed plane entries, for the Settings graft. */
  readonly committedEntries: () => Readonly<
    Partial<Record<PlaneRoute, unknown>>
  >;
  /** The settings namespace pi-ai's row is described under. */
  readonly piAiNamespace: () => string;
  /**
   * Whether the claim has engaged, as the plugin observes it: false once it
   * stood down (the host's modules could not be read) or tore down, and false
   * once `mounted` has settled while the served pi-ai row still resolves
   * holding a plane and no restart of that row is in flight. The listener
   * speaks both cores' `internal/config` call shapes, so on either one the
   * mount's restart moves the planes, and so does a handover's: a row that
   * was passed through becomes the served one holding its plane, and is
   * restarted once it settles. While either restart is in flight (from the
   * call, through the wait for the row to settle, until the restart settles)
   * this reads true, as it does before the mount settles: on both cores the
   * restart unloads the row first and the host answers `NO_DISCOVERY` until
   * it reloads, so a fetch is the plane's catalog alone there, and
   * complemented before the unload begins. A restart that throws does not
   * leave the planes with pi-ai: on cordis 4.0.6-alpha.2 and 4.1.0 it throws
   * only for a disposed fiber or by rethrowing a failed load, which leaves
   * the fiber FAILED, and a FAILED row holds nothing to read here (it
   * recovers through `update()`, which resolves through the listener). What
   * reads false is a served row whose restart has settled still holding a
   * plane: a call shape the listener does not speak. It is read with the
   * same check the reconcile waits on (`heldPlanes` of the live served row:
   * the planes it resolved holding that the claim takes, so a plane left to
   * pi-ai under D27 never counts), so the two never disagree; pi-ai serves the planes there and
   * refuses at save an id it does not list, so reading false only narrows a
   * fetch to pi's own list. While it reads true with the plane routes still
   * pi-ai's (before the mount or a handover's restart settles), a plane save
   * is already judged by the plugin and re-resolves the row without its
   * planes, so a fetch complemented then assumes the claim engages.
   */
  readonly claiming: () => boolean;
  /** Settles once the claim is mounted; never rejects. */
  readonly mounted: Promise<void>;
  /**
   * The plane routes pi-ai serves for another plugin (D27): declared by a
   * live pi-ai row the claim steps aside for, and not taken by the row it
   * serves. Read per call, so a turn sees the rows as they are now.
   */
  readonly steppedAside: () => ReadonlySet<PlaneRoute>;
  /**
   * Whether the claim would take an entry of `plane` saved on the row it
   * serves: false only when that row resolves credentials in a realm the
   * plugin does not share, where every plane entry, declared or not yet, is
   * pi-ai's (D27). Read per call, from the served row as it is now; true
   * while no live row exists. It says nothing about whether the claim has
   * engaged: that is {@link RouteClaim.claiming}.
   */
  readonly wouldTake: (plane: PlaneRoute) => boolean;
}

/** The `llm` service, as the claim calls it. */
interface LlmLike {
  registerAdapter?: (
    providers: readonly string[],
    adapter: unknown
  ) => AdapterRegistrationLike | undefined;
  listProviders?: () => unknown;
}

const LOG = "[dsh-opencode-patch]";

/** Whether a fiber is one of pi-ai's (never by `fiber.name`, which inject children inherit). */
const isPiAi = (fiber: unknown): fiber is HostFiber =>
  isRecord(fiber) &&
  isRecord(fiber.runtime) &&
  fiber.runtime.name === PI_AI_RUNTIME;

/** The plane keys a fiber's RESOLVED config holds: what pi-ai has registered. */
const resolvedPlanes = (fiber: HostFiber): PlaneRoute[] => {
  try {
    const config: unknown = effectiveConfigOf(fiber);
    const providers: unknown = isRecord(config) ? config.providers : undefined;
    const value: unknown =
      isRecord(providers) && isFunctionLike(providers.get)
        ? Reflect.apply(providers.get, providers, [])
        : providers;
    return isRecord(value)
      ? PLANE_ROUTES.filter((plane) => Object.hasOwn(value, plane))
      : [];
  } catch {
    return [];
  }
};

/**
 * Whether a fiber resolved without a plane the claim takes from it: the
 * planes it leaves to pi-ai (D27) are never stripped, so they never count.
 */
const lacksTakenPlane = (
  fiber: HostFiber,
  taken: readonly PlaneRoute[]
): boolean => {
  const held = resolvedPlanes(fiber);
  return taken.some((plane) => !held.includes(plane));
};

/**
 * Restart pi-ai, once it settles, if it is serving without a plane the claim
 * took from it — a pi-ai that was LOADING when the claim went inert resolved
 * through the still-active listener, and nobody else would ever restart it.
 * One that resolved after the claim went inert holds its planes and is left
 * alone.
 */
const restartOnceSettled = async (
  pi: HostFiber,
  takenOf: (fiber: HostFiber) => readonly PlaneRoute[]
): Promise<void> => {
  try {
    await pi.await?.();
  } catch {
    // A FAILED pi-ai is read as such below.
  }
  if (
    pi.uid !== null &&
    pi.state === ACTIVE &&
    lacksTakenPlane(pi, takenOf(pi))
  ) {
    await pi.restart?.();
  }
};

const codeOf = (error: unknown): unknown =>
  isRecord(error) ? error.code : undefined;

/**
 * Install the claim. Runs synchronously up to its first await, so the
 * teardown is the first effect `apply` registers and the listener is in place
 * before any `llm` scope exists.
 *
 * @param ctx - the plugin context (its root fiber).
 * @param config - the plugin's resolved settings.
 * @returns the claim's readers and its mount.
 */
export const installRouteClaim = (
  ctx: CordisContext,
  config: Pick<ResolvedPluginConfig, "endpoint" | "readOpencodeStore">
): RouteClaim => {
  const state = {
    active: true,
    adapter: undefined as object | undefined,
    effortNames: new Map<
      string,
      ReadonlyMap<string, Readonly<Record<string, string>>>
    >(),
    entriesKey: undefined as string | undefined,
    facts: undefined as string | undefined,
    handle: undefined as AdapterRegistrationLike | undefined,
    llm: undefined as LlmLike | undefined,
    modules: undefined as HostModules | undefined,
    /**
     * The last modules that loaded, for judging a Settings save. Never
     * cleared by a handover or pi-ai's partial dispose: validation reads only
     * pi-ai's `Config`, the libraries and pi's catalog, none of which change
     * between two loads short of a hot reload, which the next reconcile
     * re-reads anyway. So a valid save is not refused for timing.
     */
    validationModules: undefined as HostModules | undefined,
    normalized: {} as Partial<Record<PlaneRoute, unknown>>,
    pendingDuplicate: false,
    profiles: new Map<string, PlaneProfileLike>() as ReadonlyMap<
      string,
      PlaneProfileLike
    >,
    ready: false,
    /**
     * The served row whose restart `restartServed` is carrying (the mount's,
     * a handover's, or a reconcile's after a realm change, D27), from the
     * call until it settles: the claim reads engaged throughout, as it does
     * before the mount settles.
     */
    restarting: undefined as HostFiber | undefined,
    scheduled: false,
    /** The fiber the profiles and the handle were built from. */
    served: undefined as HostFiber | undefined,
    /** The stepped-aside entries already reported, per row (`<plane>:<reason>`). */
    reportedAside: new WeakMap<HostFiber, Set<string>>(),
    /**
     * The restart the claim last asked of a row, by what it was for
     * (`take:<planes>` or `give:<planes>`), so a row whose shape does not
     * change is never restarted twice for it. Cleared once the row holds
     * exactly what it should.
     */
    restartAsked: new WeakMap<HostFiber, string>(),
    /** Rows serving a plane themselves that were already reported. */
    warnedHolders: new WeakSet<HostFiber>(),
    warnedUnavailable: false,
  };
  const warn = (message: string, ...rest: unknown[]): void => {
    ctx.logger?.warn?.(`${LOG} ${message}`, ...rest);
  };

  /**
   * The plugin's own side of a realm comparison: its context, which resolves
   * `credentials` in whatever realm its row sits in (its own `isolate`, or an
   * enclosing group's), and its row's options, read only where a context
   * carries no realm map.
   */
  const ownFiber: unknown = Reflect.get(ctx, "fiber");
  const ownEntry: unknown = isRecord(ownFiber) ? ownFiber.entry : undefined;
  const ownSide = {
    context: ctx,
    options: isRecord(ownEntry) ? ownEntry.options : undefined,
  };
  const rootContext: unknown = Reflect.get(ctx, "root");

  /**
   * A pi-ai row's realm when the plugin does not resolve credentials there,
   * else `undefined`: compared by the realm each context RESOLVES, so a
   * group's realm counts as its rows' (D27). Read per call, since the loader
   * swaps a row's realm map in place when its `isolate` changes.
   */
  const foreignRealmOf = (fiber: HostFiber): ForeignRealm | undefined =>
    foreignCredentialsRealm(
      { context: fiber.ctx, options: fiber.entry?.options },
      ownSide,
      rootContext
    );

  /**
   * The planes the claim TAKES from a pi-ai row: those its raw config (or a
   * run's candidate) declares, minus the ones another plugin owns (D27).
   * Everything that strips, restarts, validates, builds or hands back reads
   * this, never the declared set.
   */
  const takenOf = (
    fiber: HostFiber,
    raw: unknown = rawConfigOf(fiber)
  ): PlaneRoute[] => takenPlanes(raw, foreignRealmOf(fiber));

  /** The taken planes a fiber's RESOLVED config still holds. */
  const heldPlanes = (fiber: HostFiber): PlaneRoute[] => {
    const taken = takenOf(fiber);
    return resolvedPlanes(fiber).filter((plane) => taken.includes(plane));
  };

  /**
   * The planes a fiber's raw config leaves to pi-ai (D27) that its RESOLVED
   * config lacks: stripped while the claim still took them, before a change
   * that touched no config (a live edit of the row's `isolate` alone) made
   * them another plugin's. pi-ai registers them only once it re-resolves.
   */
  const lentPlanes = (fiber: HostFiber): PlaneRoute[] => {
    const held = resolvedPlanes(fiber);
    return [
      ...steppedAsidePlanes(rawConfigOf(fiber), foreignRealmOf(fiber)).keys(),
    ].filter((plane) => !held.includes(plane));
  };

  const missing = ["on", "inject", "effect"].filter(
    (key) => !isFunctionLike(Reflect.get(ctx, key))
  );
  if (missing.length > 0) {
    warn(
      `the plane routes stay pi-ai's: this composition offers no ${missing.join(", ")}`
    );
    return {
      claiming: () => false,
      committedEntries: () => ({}),
      mounted: Promise.resolve(),
      piAiNamespace: () => PI_AI_RUNTIME,
      steppedAside: () => new Set(),
      // No row is judged here, so none is in a foreign realm: `claiming`
      // already keeps every fetch to pi's list with the enrich-only merge.
      wouldTake: () => true,
    };
  }

  const images = attachmentResolvers(ctx);

  /**
   * The pi-ai fiber the claim serves. Sticky: the row already served stays
   * served while it is not disposed and its raw config still declares a
   * plane the claim takes. Otherwise the first row not disposed, whatever its
   * state, whose raw config DECLARES a plane the claim takes (a plane another
   * plugin owns is not one, D27) — else the first row not disposed. Chosen by
   * declaration, not by registry order alone, because cordis appends a
   * re-enabled row's new fiber to the end of the registry: by order, a
   * plane-less row ahead of it would be served and the planes never claimed.
   * Sticky, because only the served fiber's planes are stripped: were the
   * served row to move between two live declaring rows, the one left behind
   * would keep its stripped config and nobody would serve its planes. The
   * served row therefore moves only when it is gone or has nothing to strip,
   * and another pi-ai row keeps its own planes and serves them itself.
   */
  const servedRow = (): HostFiber | undefined => {
    const live = piAiFibers(ctx).filter((fiber) => fiber.uid !== null);
    const current = state.served;
    if (
      current !== undefined &&
      live.includes(current) &&
      takenOf(current).length > 0
    ) {
      return current;
    }
    return live.find((fiber) => takenOf(fiber).length > 0) ?? live[0];
  };

  /** The served pi-ai fiber while it is not FAILED: a FAILED one has nothing to claim. */
  const livePiAi = (): HostFiber | undefined => {
    const fiber = servedRow();
    return fiber?.state === FAILED ? undefined : fiber;
  };

  /**
   * Profiles and adapter for the committed entries; memoized by their JSON and
   * the catalog's generation, so a refresh that lands after boot reaches the
   * profiles (D3's default list, D16's protocol, D17's metadata).
   */
  const rebuild = (pi: HostFiber, modules: HostModules): void => {
    const entries = planeEntriesOf(rawConfigOf(pi), takenOf(pi));
    const key = `${catalogGeneration()}:${JSON.stringify(entries)}`;
    if (key === state.entriesKey && state.adapter !== undefined) {
      return;
    }
    const { libraries, piAi } = modules;
    const profiles = new Map<string, PlaneProfileLike>();
    const effortNames = new Map<
      string,
      ReadonlyMap<string, Readonly<Record<string, string>>>
    >();
    const normalized: Partial<Record<PlaneRoute, unknown>> = {};
    const { interpolate } = libraries;
    for (const route of PLANE_ROUTES) {
      if (!Object.hasOwn(entries, route)) {
        continue;
      }
      const result = planeProfileFor({
        buildProvider: buildPlaneProvider(libraries),
        catalog:
          route === "opencode-go" ? getLiveGoCatalog() : getLiveZenCatalog(),
        endpoint: config.endpoint,
        entry: entries[route],
        familyApi:
          route === "opencode-go"
            ? OPENCODE_FAMILY_API.go
            : OPENCODE_FAMILY_API.zen,
        ...(interpolate === undefined
          ? {}
          : { interpolate: (value: unknown) => interpolate(pi.ctx, value) }),
        normalize: (entry: unknown) => {
          const resolved: unknown = piAi.Config({
            providers: { [route]: entry },
          });
          const providers: unknown = isRecord(resolved)
            ? resolved.providers
            : undefined;
          const value: unknown =
            isRecord(providers) && isFunctionLike(providers.get)
              ? Reflect.apply(providers.get, providers, [])
              : providers;
          return isRecord(value) ? value[route] : undefined;
        },
        piModels: libraries.builtinModels(route),
        resolveRetryPolicy: libraries.resolveRetryPolicy,
        route,
      });
      profiles.set(route, result.profile);
      effortNames.set(route, result.effortNames);
      if (result.normalized !== undefined) {
        normalized[route] = result.normalized;
      }
    }
    state.profiles = profiles;
    state.effortNames = effortNames;
    state.normalized = normalized;
    state.entriesKey = key;
    if (state.adapter === undefined) {
      // One auth for both: the resolver asks pi's own lookup through the same
      // seams the adapter hands pi, so the store stays the last resort.
      const auth = planeAuth(ctx, piAi.recordKeyFor, libraries);
      state.adapter = createPlaneAdapter({
        auth,
        effortNames: (provider, model) =>
          state.effortNames.get(provider)?.get(model),
        modules,
        onReplayDegrade: ({ model, provider, reason }) => {
          warn(
            `unusable replay state on assistant history for route "${provider}/${model}"; sending that message as provider-neutral content (${reason})`
          );
        },
        profiles: () => state.profiles,
        resolveApiKey: planeApiKeyResolver(ctx, modules, config, auth),
        resolveAttachments: images.resolveAttachments,
        resolveImageAccess: images.resolveImageAccess,
      });
    }
  };

  /** Register, or move, the declared planes. */
  const register = (): void => {
    const { llm, adapter } = state;
    if (llm === undefined || adapter === undefined) {
      return;
    }
    const routes = [...state.profiles.keys()];
    const facts = JSON.stringify(
      routes.toSorted().map((route) => {
        const profile = state.profiles.get(route);
        return {
          displayName: profile?.displayName,
          retryPolicy: profile?.retryPolicy,
          route,
        };
      })
    );
    try {
      if (state.handle === undefined) {
        if (routes.length > 0) {
          state.handle = llm.registerAdapter?.(routes, adapter);
        }
      } else if (facts !== state.facts) {
        state.handle.replace?.(routes);
      }
      state.facts = facts;
    } catch (error) {
      if (codeOf(error) === "DUPLICATE_ADAPTER") {
        // Another registration still holds a plane: pi-ai mid-restart, most
        // likely. The next registry change retries, after pi-ai settles.
        state.pendingDuplicate = true;
        ctx.logger?.info?.(
          `${LOG} a plane route is still held elsewhere; retrying once the registry changes`
        );
        return;
      }
      warn("the plane routes did not register", error);
    }
  };

  /**
   * Restart the served pi-ai once it settles, if `still` holds of it then:
   * recorded under `key` first, so the same need never asks twice.
   */
  const restartServed = async (
    fiber: HostFiber,
    key: string,
    still: (fiber: HostFiber) => boolean
  ): Promise<void> => {
    state.restartAsked.set(fiber, key);
    state.restarting = fiber;
    try {
      try {
        await fiber.await?.();
      } catch {
        // A FAILED pi-ai holds nothing; the check below says so.
      }
      if (
        state.active &&
        fiber === servedRow() &&
        fiber.uid !== null &&
        fiber.state === ACTIVE &&
        still(fiber)
      ) {
        await fiber.restart?.();
      }
    } finally {
      if (state.restarting === fiber) {
        state.restarting = undefined;
      }
    }
  };

  const takeKey = (fiber: HostFiber): string =>
    `take:${heldPlanes(fiber).join(",")}`;
  const giveKey = (fiber: HostFiber): string =>
    `give:${lentPlanes(fiber).join(",")}`;

  /**
   * Restart a served pi-ai that resolved holding a plane, once it settles, so
   * it re-resolves through the listener and the planes become the plugin's
   * (the mount's restart, a handover's, and a reconcile's after a live
   * change made a plane it holds one the claim takes).
   */
  const restartHolder = (fiber: HostFiber): Promise<void> =>
    restartServed(
      fiber,
      takeKey(fiber),
      (settled) => heldPlanes(settled).length > 0
    );

  /**
   * Restart a served pi-ai that resolved without a plane it now keeps, once
   * it settles, so it re-resolves and registers it. Run only after the
   * plugin released the plane: pi-ai's registration would otherwise meet
   * the plugin's (DUPLICATE_ADAPTER fails pi-ai and every route it holds).
   */
  const restartLender = (fiber: HostFiber): Promise<void> =>
    restartServed(
      fiber,
      giveKey(fiber),
      (settled) => lentPlanes(settled).length > 0
    );

  /** Ask a restart in the background, once per need, reporting a failure. */
  const askRestart = (
    fiber: HostFiber,
    key: string,
    restart: (fiber: HostFiber) => Promise<void>
  ): void => {
    if (state.restartAsked.get(fiber) === key) {
      return;
    }
    void (async () => {
      try {
        await restart(fiber);
      } catch (error) {
        warn("pi-ai did not restart to move the plane routes", error);
      }
    })();
  };

  /** The once-only report that the host's modules cannot be read. */
  const warnUnavailable = (): void => {
    if (!state.warnedUnavailable) {
      state.warnedUnavailable = true;
      warn(
        "the host's pi-ai module or its libraries are unavailable; the plane routes stay pi-ai's"
      );
    }
  };

  /**
   * The served pi-ai changed (it was disposed, or stopped declaring a plane):
   * what was built from the previous one is dropped — its handle
   * released, so its planes are no longer served from a row that is gone,
   * and nothing of it reaches the Settings graft — and a new served row that
   * already holds a plane is restarted once it settles, as the mount does.
   */
  const handOver = (served: HostFiber | undefined): boolean => {
    const { handle } = state;
    state.served = served;
    state.handle = undefined;
    state.facts = undefined;
    state.entriesKey = undefined;
    state.profiles = new Map();
    state.effortNames = new Map();
    state.normalized = {};
    // pi-ai's module is read from the served row's own loader entry.
    state.modules = undefined;
    state.adapter = undefined;
    try {
      handle?.();
    } catch (error) {
      warn("the plane routes did not release", error);
    }
    if (served === undefined || heldPlanes(served).length === 0) {
      return false;
    }
    void (async () => {
      try {
        await restartHolder(served);
      } catch (error) {
        warn("pi-ai did not restart to hand the plane routes over", error);
      }
    })();
    return true;
  };

  /** Say once per row that another pi-ai row serves a plane itself. */
  const reportOtherHolders = (served: HostFiber | undefined): void => {
    for (const fiber of piAiFibers(ctx)) {
      if (
        fiber === served ||
        fiber.uid === null ||
        state.warnedHolders.has(fiber)
      ) {
        continue;
      }
      const held = heldPlanes(fiber);
      if (held.length > 0) {
        state.warnedHolders.add(fiber);
        warn(
          `the pi-ai row "${fiber.entry?.options?.id ?? PI_AI_RUNTIME}" serves ${held.join(", ")} itself: only one pi-ai row's planes are the plugin's`
        );
      }
    }
  };

  /**
   * Say once per entry that a plane is left to pi-ai, and why (D27): each
   * live row's stepped-aside entries, keyed by plane and reason, so a row
   * whose reason changes says so again.
   */
  const reportSteppedAside = (): void => {
    for (const fiber of piAiFibers(ctx)) {
      if (fiber.uid === null) {
        continue;
      }
      const seen = state.reportedAside.get(fiber) ?? new Set<string>();
      state.reportedAside.set(fiber, seen);
      const aside = steppedAsidePlanes(
        rawConfigOf(fiber),
        foreignRealmOf(fiber)
      );
      for (const [plane, reason] of aside) {
        const key = `${plane}:${reason.kind}`;
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        ctx.logger?.info?.(
          `${LOG} ${stepAsideMessage(plane, reason, fiber.entry?.options?.id ?? PI_AI_RUNTIME)}`
        );
      }
    }
  };

  /** Restart pi-ai so it takes the planes back, reporting a failure. */
  const restartToHandBack = async (pi: HostFiber): Promise<void> => {
    try {
      await restartOnceSettled(pi, takenOf);
    } catch (error) {
      warn("pi-ai did not restart to take the plane routes back", error);
    }
  };

  /**
   * Hand the planes back to pi-ai: release the handle and go inert with no
   * await between, so pi-ai's restart never meets the plugin's registration
   * (DUPLICATE_ADAPTER would fail pi-ai and every route it holds), then
   * restart it once it settles.
   */
  const handBack = (pi: HostFiber | undefined): void => {
    const { handle } = state;
    state.handle = undefined;
    state.facts = undefined;
    state.active = false;
    try {
      handle?.();
    } catch (error) {
      warn("the plane routes did not release", error);
    }
    if (pi !== undefined && pi.uid !== null && pi.state !== FAILED) {
      void restartToHandBack(pi);
    }
  };

  const reconcile = async (): Promise<void> => {
    state.scheduled = false;
    if (!state.active || !state.ready || state.llm === undefined) {
      return;
    }
    reportSteppedAside();
    const served = servedRow();
    if (served !== state.served && handOver(served)) {
      // The new served row's restart brings us back through the registry.
      return;
    }
    reportOtherHolders(served);
    const pi = livePiAi();
    if (pi === undefined) {
      // pi-ai is gone or FAILED: nothing is claimed.
      state.entriesKey = undefined;
      state.profiles = new Map();
      state.normalized = {};
      register();
      return;
    }
    const lent = lentPlanes(pi);
    if (heldPlanes(pi).length > 0) {
      // pi-ai holds a plane the claim takes: one it resolved before the
      // listener existed (the mount's or the handover's restart moves it), or
      // one a live change of its row's realm alone made the claim's again,
      // which no config run follows. Either way a restart moves it, once, and
      // its registry change brings us back.
      askRestart(pi, takeKey(pi), restartHolder);
      return;
    }
    if (lent.length === 0) {
      state.restartAsked.delete(pi);
    }
    if (state.pendingDuplicate) {
      state.pendingDuplicate = false;
      try {
        await pi.await?.();
      } catch {
        // A FAILED pi-ai is read as such below.
      }
    }
    const modules = state.modules ?? (await loadHostModules(ctx, pi));
    if (!state.active || state.llm === undefined) {
      return;
    }
    if (modules === undefined) {
      // The module lookup does not recover within a live row, so stand down
      // whether or not a plane is declared: pi-ai validates and serves a plane
      // a later save adds, rather than the claim refusing it for good. With
      // nothing declared the handback restarts nothing.
      warnUnavailable();
      handBack(pi);
      return;
    }
    state.modules = modules;
    state.validationModules = modules;
    try {
      rebuild(pi, modules);
    } catch (error) {
      warn("the plane profiles did not build", error);
      return;
    }
    register();
    if (lent.length > 0) {
      // A plane the claim no longer takes, which pi-ai resolved without (its
      // row's realm changed and nothing else did): the registration above
      // released it, so pi-ai is restarted to register it.
      askRestart(pi, giveKey(pi), restartLender);
    }
  };

  const reconcileReported = async (): Promise<void> => {
    try {
      await reconcile();
    } catch (error) {
      warn("the plane routes did not reconcile", error);
    }
  };

  const schedule = (): void => {
    if (state.scheduled || !state.active) {
      return;
    }
    state.scheduled = true;
    queueMicrotask(() => {
      void reconcileReported();
    });
  };

  /**
   * Validate an editor candidate's changed plane entries, strictly: only the
   * ones the claim takes, since an entry it leaves to pi-ai reaches pi-ai's
   * own save check (D27).
   */
  const validate = (
    fiber: HostFiber,
    raw: unknown,
    taken: readonly PlaneRoute[]
  ): void => {
    const previous = planeEntriesOf(rawConfigOf(fiber));
    const candidate = planeEntriesOf(raw, taken);
    for (const plane of PLANE_ROUTES) {
      if (
        !Object.hasOwn(candidate, plane) ||
        JSON.stringify(candidate[plane]) === JSON.stringify(previous[plane])
      ) {
        continue;
      }
      // Refused only before the host's modules ever loaded (at boot, before
      // the mount's preload settles), never in the window after a handover
      // or a partial dispose.
      const modules = state.modules ?? state.validationModules;
      if (modules === undefined) {
        throw new Error(
          `llm-pi-ai: provider "${plane}" cannot be validated yet: the plugin has not loaded the host's pi-ai module; try the save again`
        );
      }
      const { interpolate } = modules.libraries;
      const result = planeProfileFor({
        buildProvider: buildPlaneProvider(modules.libraries),
        catalog:
          plane === "opencode-go" ? getLiveGoCatalog() : getLiveZenCatalog(),
        endpoint: config.endpoint,
        entry: candidate[plane],
        familyApi:
          plane === "opencode-go"
            ? OPENCODE_FAMILY_API.go
            : OPENCODE_FAMILY_API.zen,
        ...(interpolate === undefined
          ? {}
          : { interpolate: (value: unknown) => interpolate(fiber.ctx, value) }),
        normalize: (entry: unknown) => {
          const resolved: unknown = modules.piAi.Config({
            providers: { [plane]: entry },
          });
          const providers: unknown = isRecord(resolved)
            ? resolved.providers
            : undefined;
          const value: unknown =
            isRecord(providers) && isFunctionLike(providers.get)
              ? Reflect.apply(providers.get, providers, [])
              : providers;
          return isRecord(value) ? value[plane] : undefined;
        },
        piModels: modules.libraries.builtinModels(plane),
        resolveRetryPolicy: modules.libraries.resolveRetryPolicy,
        route: plane,
      });
      const failure = result.profile.catalogError;
      if (failure !== undefined) {
        throw new Error(failure);
      }
    }
  };

  /**
   * On a commit run, release at once the planes the plugin registered that
   * the run's candidate no longer lets it take (an edit that adds the marker,
   * D27). pi-ai registers the routes of the config this run resolves as soon
   * as the run returns, before the scheduled {@link reconcile}: a route the
   * plugin still held then would be refused as a duplicate and left with no
   * adapter at all. The reconcile rebuilds from the same candidate after.
   */
  const releaseUntaken = (taken: readonly PlaneRoute[]): void => {
    const { handle } = state;
    if (handle === undefined) {
      return;
    }
    const takenNames: readonly string[] = taken;
    const held = [...state.profiles.keys()];
    const kept = held.filter((route) => takenNames.includes(route));
    if (kept.length === held.length) {
      return;
    }
    state.facts = undefined;
    state.entriesKey = undefined;
    try {
      // Through the live handle, as every withdrawal is: `replace([])` when
      // nothing is left, never a release.
      handle.replace?.(kept);
    } catch (error) {
      warn("the plane routes did not release", error);
    }
  };

  /**
   * The listener's body, for the run's fiber and the raw value its `next()`
   * answered: the innermost value, the run's raw candidate.
   */
  const claim = (fiber: unknown, raw: unknown): unknown => {
    if (!state.active || !isPiAi(fiber)) {
      return raw;
    }
    const commit = isCommitRun(raw, fiber, ACTIVE);
    if (fiber !== servedRow()) {
      // The row the handle was built from, on a commit whose candidate the
      // loader already stored (its volatile path) and which takes nothing:
      // `servedRow` has moved on from it, yet the plugin still holds its
      // planes, which pi-ai registers as soon as this run returns.
      if (commit && fiber === state.served) {
        releaseUntaken(takenOf(fiber, raw));
        schedule();
      }
      return raw;
    }
    // The run's own candidate decides: an edit can add or drop a marker.
    const taken = takenOf(fiber, raw);
    if (commit) {
      releaseUntaken(taken);
    }
    if (taken.length === 0) {
      if (commit) {
        schedule();
      }
      return raw;
    }
    const copy = withoutPlaneProviders(raw, taken);
    if (commit) {
      schedule();
      return copy;
    }
    validate(fiber, raw, taken);
    return copy;
  };

  /**
   * The `internal/config` listener, in either call shape: `this` is the fiber
   * on the OLD core, the first argument on the NEW one, and `next` is the
   * last argument on both. `next()` runs exactly once.
   */
  function claimListener(this: unknown, ...args: unknown[]): unknown {
    const run = configRunOf(this, args);
    return claim(run.fiber, run.next?.());
  }

  /** The listener's current registration, so it can be moved innermost. */
  let unlisten: unknown;
  /**
   * Register the listener innermost: the new registration first, the old one
   * released only once the host accepted it. This runs inside pi-ai's own
   * `internal/status` emit, which calls listeners unguarded, so it must not
   * throw. The host refuses a registration (`INACTIVE_EFFECT`) once the
   * plugin's fiber is disposed and before its teardown runs; the refusal is
   * the answer, and the existing registration stays until that teardown.
   */
  const listen = (): void => {
    const previous = unlisten;
    try {
      unlisten = ctx.on?.("internal/config", claimListener);
    } catch {
      return;
    }
    if (isFunctionLike(previous)) {
      Reflect.apply(previous, undefined, []);
    }
  };

  const teardown = (): Promise<void> | undefined => {
    const { handle } = state;
    state.handle = undefined;
    state.active = false;
    try {
      handle?.();
    } catch (error) {
      warn("the plane routes did not release", error);
    }
    images.dispose();
    // Before the reload return: the next activation subscribes its own, and a
    // listener left here would keep this activation's state alive for good.
    stopCatalog();
    const own: unknown = Reflect.get(ctx, "fiber");
    if (isRecord(own) && own.uid !== null) {
      // A reload of the plugin's own row: the next activation claims again.
      return undefined;
    }
    const pi = livePiAi();
    if (
      pi === undefined ||
      pi.parent?.fiber?.state === UNLOADING ||
      takenOf(pi).length === 0
    ) {
      return undefined;
    }
    // ACTIVE or still LOADING: either way it resolved through the listener
    // while it was active, so it is restarted once it settles.
    return (async () => {
      try {
        await restartOnceSettled(pi, takenOf);
        const llm: unknown = ctx.get?.("llm");
        const listed: unknown =
          isRecord(llm) && isFunctionLike(llm.listProviders)
            ? Reflect.apply(llm.listProviders, llm, [])
            : [];
        const ids = new Set(
          (Array.isArray(listed) ? listed : []).map((row: unknown) =>
            isRecord(row) ? row.id : undefined
          )
        );
        const lost = takenOf(pi).filter((plane) => !ids.has(plane));
        if (lost.length > 0) {
          warn(
            `pi-ai did not take back ${lost.join(", ")}: their entries may hold ids its catalog cannot serve`
          );
        }
      } catch (error) {
        warn("pi-ai did not take the plane routes back", error);
      }
    })();
  };

  // A catalog refresh that lands re-runs the reconcile, whose memo key holds
  // the catalog's generation.
  const stopCatalog = onCatalogChange(schedule);
  // The first effect `apply` registers, so it is the last to run.
  ctx.effect?.(() => teardown, "dsh-opencode-patch.route-claim");
  // Appended, so it is inner to the loader's interpolate and, on the NEW
  // core, to the built-in schema listener; and moved innermost again each
  // time pi-ai reaches ACTIVE, since pi-ai appends its own checking listener
  // at every activation (`internal/status` is `(fiber, oldState)` on both
  // cores).
  listen();
  ctx.on?.(
    "internal/status",
    (fiber: unknown) => {
      if (state.active && isPiAi(fiber) && fiber.state === ACTIVE) {
        listen();
      }
    },
    { global: true }
  );
  ctx.on?.("llm/adapters-updated", schedule, { global: true });
  // Any row's partial dispose, not only pi-ai's: a live edit of the plugin's
  // own row's `isolate`, or of a group around either row, moves a realm and
  // changes which planes the claim takes (D27) without a config run, a
  // restart or a registry change. The loader swaps the realm map before the
  // scheduled reconcile runs, which then moves the plane with one restart.
  ctx.on?.(
    "loader/partial-dispose",
    (entry: unknown) => {
      if (isRecord(entry) && isPiAi(entry.fiber)) {
        state.modules = undefined;
      }
      schedule();
    },
    { global: true }
  );
  ctx.inject?.(["llm"], (scope: unknown) => {
    if (!isRecord(scope)) {
      return;
    }
    const { llm } = scope;
    state.llm = isRecord(llm) ? llm : undefined;
    if (isFunctionLike(scope.effect)) {
      Reflect.apply(scope.effect, scope, [
        () => () => {
          state.llm = undefined;
          state.handle = undefined;
          state.facts = undefined;
        },
        "dsh-opencode-patch.route-claim: llm",
      ]);
    }
    schedule();
  });

  const mounted = (async () => {
    try {
      // Preload the libraries, so the first commit run does not wait on them.
      state.modules = await loadHostModules(ctx, livePiAi());
      state.validationModules = state.modules;
      const served = servedRow();
      state.served = served;
      if (served !== undefined && heldPlanes(served).length > 0) {
        if (state.modules === undefined) {
          // Nothing could serve the planes: stand down without a restart, so
          // pi-ai keeps them and restarts zero times rather than twice. The
          // handback restarts only a row that settles WITHOUT its planes.
          warnUnavailable();
          handBack(served);
          return;
        }
        await restartHolder(served);
      }
    } catch (error) {
      warn("the plane routes did not mount", error);
    } finally {
      state.ready = true;
      schedule();
    }
  })();

  /**
   * The mount has settled, no restart of the served row is in flight, and
   * that row still holds a plane the claim takes (a plane it leaves to pi-ai,
   * D27, is pi-ai's to hold).
   */
  const heldByPiAi = (): boolean => {
    if (!state.ready) {
      return false;
    }
    const pi = livePiAi();
    return (
      pi !== undefined && pi !== state.restarting && heldPlanes(pi).length > 0
    );
  };

  /**
   * The planes another plugin owns on a live pi-ai row, minus any the served
   * row's planes the claim takes: those are the plugin's whatever a second
   * row declares.
   */
  const steppedAside = (): ReadonlySet<PlaneRoute> => {
    const out = new Set<PlaneRoute>();
    for (const fiber of piAiFibers(ctx)) {
      if (fiber.uid === null) {
        continue;
      }
      for (const plane of steppedAsidePlanes(
        rawConfigOf(fiber),
        foreignRealmOf(fiber)
      ).keys()) {
        out.add(plane);
      }
    }
    const served = state.active ? servedRow() : undefined;
    for (const plane of served === undefined ? [] : takenOf(served)) {
      out.delete(plane);
    }
    return out;
  };

  /** See {@link RouteClaim.wouldTake}: a plain entry, judged as the listener would. */
  const wouldTake = (plane: PlaneRoute): boolean => {
    const served = servedRow();
    return (
      served === undefined ||
      takenPlanes({ providers: { [plane]: {} } }, foreignRealmOf(served))
        .length > 0
    );
  };

  return {
    claiming: () => state.active && !heldByPiAi(),
    committedEntries: () => (state.active ? state.normalized : {}),
    mounted,
    piAiNamespace: () => livePiAi()?.entry?.options?.id ?? PI_AI_RUNTIME,
    steppedAside,
    wouldTake,
  };
};
