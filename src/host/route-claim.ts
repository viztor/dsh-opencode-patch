/**
 * pi-ai never claims the planes; the plugin registers its own adapter under
 * them (D13, docs/improvement-plan.md "The design").
 *
 * Four parts, each on a supported host path:
 *
 * - **The listener.** A prepended `internal/config` listener on the plugin's
 *   root. For the pi-ai fiber it serves only (`this.runtime?.name ===
 *   "llm-pi-ai"`; see {@link installRouteClaim}'s `servedRow`: the served row
 *   is sticky while it is live and declares a plane, else the first live row
 *   that declares one, else the first live row); another pi-ai row keeps its
 *   planes and serves them itself, and is reported once — it
 *   runs the nested waterfall on a fresh copy without the two plane keys and
 *   returns that, so pi-ai resolves and registers every other route and never
 *   sees the planes (F11, F12) — its own save check included, which a strip
 *   that let the raw value through would not shield. The user's file keeps
 *   every entry: the editor writes the raw value, never the resolved one. A
 *   commit run (`raw === this._config`, F14) schedules {@link reconcile}; an
 *   editor candidate has its changed plane entries validated strictly, and a
 *   malformed one is refused in pi-ai's message style. A commit run never
 *   throws: that would fail pi-ai's fiber and every route it holds.
 * - **Reconcile.** Reads the committed plane entries from pi-ai's
 *   `_config.providers`, interpolates them with the loader's `interpolate`
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
 *   mount does.
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
 * from its fiber's resolved config.
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
import { isFunctionLike, isRecord } from "../utils/guards.ts";
import {
  hasPlaneEntries,
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
   * Whether the claim has neither stood down (the host's modules could not be
   * read) nor torn down. True from install, so before `mounted` settles the
   * plane routes may still be pi-ai's: a plane save is already validated by
   * the plugin, and a fetch complemented in that window assumes the claim goes
   * live, which it does unless the modules are unavailable.
   */
  readonly claiming: () => boolean;
  /** Settles once the claim is mounted; never rejects. */
  readonly mounted: Promise<void>;
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
    const config: unknown = fiber.config;
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

/** Whether a fiber resolved without a plane its raw config declares. */
const lacksDeclaredPlane = (fiber: HostFiber): boolean => {
  const declared = planeEntriesOf(fiber._config);
  const held = resolvedPlanes(fiber);
  return PLANE_ROUTES.some(
    (plane) => Object.hasOwn(declared, plane) && !held.includes(plane)
  );
};

/**
 * Restart pi-ai, once it settles, if it is serving without a plane its raw
 * config declares — a pi-ai that was LOADING when the claim went inert
 * resolved through the still-active listener, and nobody else would ever
 * restart it. One that resolved after the claim went inert holds its planes
 * and is left alone.
 */
const restartOnceSettled = async (pi: HostFiber): Promise<void> => {
  try {
    await pi.await?.();
  } catch {
    // A FAILED pi-ai is read as such below.
  }
  if (pi.uid !== null && pi.state === ACTIVE && lacksDeclaredPlane(pi)) {
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
    normalized: {} as Partial<Record<PlaneRoute, unknown>>,
    pendingDuplicate: false,
    profiles: new Map<string, PlaneProfileLike>() as ReadonlyMap<
      string,
      PlaneProfileLike
    >,
    ready: false,
    reentrant: false,
    scheduled: false,
    /** The fiber the profiles and the handle were built from. */
    served: undefined as HostFiber | undefined,
    /** Rows serving a plane themselves that were already reported. */
    warnedHolders: new WeakSet<HostFiber>(),
    warnedUnavailable: false,
  };
  const warn = (message: string, ...rest: unknown[]): void => {
    ctx.logger?.warn?.(`${LOG} ${message}`, ...rest);
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
    };
  }

  const images = attachmentResolvers(ctx);

  /**
   * The pi-ai fiber the claim serves. Sticky: the row already served stays
   * served while it is not disposed and its raw config still declares a
   * plane. Otherwise the first row not disposed, whatever its state, whose
   * raw config DECLARES a plane — else the first row not disposed. Chosen by
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
      hasPlaneEntries(current._config)
    ) {
      return current;
    }
    return live.find((fiber) => hasPlaneEntries(fiber._config)) ?? live[0];
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
    const entries = planeEntriesOf(pi._config);
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
   * Restart a served pi-ai that resolved holding a plane, once it settles, so
   * it re-resolves through the listener and the planes become the plugin's
   * (the mount's restart, and a handover's).
   */
  const restartHolder = async (fiber: HostFiber): Promise<void> => {
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
      resolvedPlanes(fiber).length > 0
    ) {
      await fiber.restart?.();
    }
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
    if (served === undefined || resolvedPlanes(served).length === 0) {
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
      const held = resolvedPlanes(fiber);
      if (held.length > 0) {
        state.warnedHolders.add(fiber);
        warn(
          `the pi-ai row "${fiber.entry?.options?.id ?? PI_AI_RUNTIME}" serves ${held.join(", ")} itself: only one pi-ai row's planes are the plugin's`
        );
      }
    }
  };

  /** Restart pi-ai so it takes the planes back, reporting a failure. */
  const restartToHandBack = async (pi: HostFiber): Promise<void> => {
    try {
      await restartOnceSettled(pi);
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
    if (resolvedPlanes(pi).length > 0) {
      // pi-ai still holds a plane it resolved before the listener existed;
      // the mount's or the handover's restart moves it, and its registry
      // change brings us back.
      return;
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
    try {
      rebuild(pi, modules);
    } catch (error) {
      warn("the plane profiles did not build", error);
      return;
    }
    register();
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

  /** Validate an editor candidate's changed plane entries, strictly. */
  const validate = (fiber: HostFiber, raw: unknown): void => {
    const previous = planeEntriesOf(fiber._config);
    const candidate = planeEntriesOf(raw);
    for (const plane of PLANE_ROUTES) {
      if (
        !Object.hasOwn(candidate, plane) ||
        JSON.stringify(candidate[plane]) === JSON.stringify(previous[plane])
      ) {
        continue;
      }
      const { modules } = state;
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

  /** The listener's body, with the fiber cordis bound as `this` passed in. */
  const claim = (
    fiber: unknown,
    raw: unknown,
    next: () => unknown
  ): unknown => {
    if (
      !state.active ||
      state.reentrant ||
      !isPiAi(fiber) ||
      fiber !== servedRow()
    ) {
      return next();
    }
    const commit = raw === fiber._config;
    if (!hasPlaneEntries(raw)) {
      if (commit) {
        schedule();
      }
      return next();
    }
    const copy = withoutPlaneProviders(raw);
    const host: unknown = fiber.ctx;
    let resolved: unknown;
    state.reentrant = true;
    try {
      resolved =
        isRecord(host) && isFunctionLike(host.waterfall)
          ? Reflect.apply(host.waterfall, host, [
              fiber,
              "internal/config",
              copy,
              () => copy,
            ])
          : copy;
    } finally {
      state.reentrant = false;
    }
    if (commit) {
      schedule();
      return resolved;
    }
    validate(fiber, raw);
    return resolved;
  };

  function claimListener(
    this: unknown,
    raw: unknown,
    next: () => unknown
  ): unknown {
    return claim(this, raw, next);
  }

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
      !hasPlaneEntries(pi._config)
    ) {
      return undefined;
    }
    // ACTIVE or still LOADING: either way it resolved through the listener
    // while it was active, so it is restarted once it settles.
    return (async () => {
      try {
        await restartOnceSettled(pi);
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
        const declared = Object.keys(planeEntriesOf(pi._config));
        const lost = declared.filter((plane) => !ids.has(plane));
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
  ctx.on?.("internal/config", claimListener, { prepend: true });
  ctx.on?.("llm/adapters-updated", schedule, { global: true });
  ctx.on?.(
    "loader/partial-dispose",
    (entry: unknown) => {
      if (isRecord(entry) && isPiAi(entry.fiber)) {
        state.modules = undefined;
        schedule();
      }
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
      const served = servedRow();
      state.served = served;
      if (served !== undefined && resolvedPlanes(served).length > 0) {
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

  return {
    claiming: () => state.active,
    committedEntries: () => (state.active ? state.normalized : {}),
    mounted,
    piAiNamespace: () => livePiAi()?.entry?.options?.id ?? PI_AI_RUNTIME,
  };
};
