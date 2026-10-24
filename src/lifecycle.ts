/**
 * Plugin lifecycle: the `apply()` entry point and its installers.
 *
 * `apply()` is a composition of small, independently readable installers, one
 * per side effect the plugin has on the host:
 *
 * | installer                | side effect                                   |
 * | ------------------------ | --------------------------------------------- |
 * | {@link installRouteClaim}   | own the `opencode`/`opencode-go` routes (D13) |
 * | {@link installDescribeGraft} | keep Settings showing the planes (D18)      |
 * | {@link logRenameNotice}  | one-time notice for legacy rows                |
 * | {@link installUsageService} | register the Go quota service + remotes     |
 * | {@link installFetchPatch}   | wrap `globalThis.fetch` (returns `false` if none) |
 * | {@link installStreamHook}   | capture turn state on `llm/stream`          |
 * | {@link installModelDiscovery} | publish the canonical catalog to the picker |
 *
 * Order is load-bearing and documented at the call site in {@link apply}.
 *
 * @module dsh-opencode-patch/lifecycle
 */

import { AsyncLocalStorage } from "node:async_hooks";

import {
  type PluginConfig,
  type ResolvedPluginConfig,
  resolveConfig,
} from "./config.ts";
import { type CordisContext, readEntryOptions } from "./cordis-context.ts";
import { recordDebug } from "./debug.ts";
import { patchFetch } from "./fetch-patch.ts";
import { resolveGoBaseURL } from "./go-discovery.ts";
import { installDescribeGraft } from "./host/describe-graft.ts";
import { installRouteClaim } from "./host/route-claim.ts";
import { LEGACY_NAME, LEGACY_PKG, name } from "./identity.ts";
import {
  type CatalogModelSpec,
  getLiveGoCatalog,
  getLiveZenCatalog,
  sanitizeModalities,
} from "./models-catalog.ts";
import { decorateModelDiscovery } from "./models-discovery.ts";
import { STORE_NAMESPACE } from "./opencode-store-contract.ts";
import { OpencodeStoreService } from "./opencode-store-service.ts";
import { ModelPurgeService } from "./purge-service.ts";
import { createStreamHook } from "./stream-hook.ts";
import type { ActiveTurnState } from "./turn-store.ts";
import { GoUsageService } from "./usage.ts";
import { isFetchFunction, isFunctionLike, isRecord } from "./utils/guards.ts";
import { isServableSdk } from "./utils/protocols.ts";

/**
 * One catalog row in the shape DSH's model-discovery surface expects.
 *
 * Models whose SDK no route serves are dropped: offering them would be offering
 * a model that cannot work, and the user has no way to tell that from the row.
 */
const toDiscovered = (specs: readonly CatalogModelSpec[]) =>
  specs
    .filter((m) => isServableSdk(m.provider_npm))
    .map((m) => ({
      contextWindow: m.context_window,
      id: m.id,
      inputModalities: sanitizeModalities(m.input_modalities),
      maxTokens: m.max_output_tokens,
      name: m.name,
    }));

/** Tell a row still configured under the pre-rename id/package to update. */
const logRenameNotice = (ctx: CordisContext): void => {
  const entryOptions = readEntryOptions(ctx);
  if (entryOptions?.name === LEGACY_PKG || entryOptions?.id === LEGACY_NAME) {
    ctx.logger?.info?.(
      '[dsh-opencode-patch] Notice: "@viztor/dsh-opencode" has been renamed to "dsh-opencode-patch". Please update your profile configuration.'
    );
  }
};

/**
 * Publish a service through `ctx.provide`, when `ctx.plugin` is not available.
 *
 * The fallback exists because a service the client cannot reach has no way to say
 * so from the host: the installers report through `ctx.logger`, and a host that
 * writes no log file turns every one of those into a silence. `provide` reaches
 * the same lookup under the same name, which is the half that matters.
 *
 * @param ctx - the host context.
 * @param name - the service name the client looks for.
 * @param Service - the service class.
 * @param options - its constructor options.
 */
const mountByProvide = (
  ctx: CordisContext,
  serviceName: string,
  Service: new (ctx: never, options: never) => unknown,
  options?: unknown
): void => {
  const { provide } = ctx as {
    provide?: (key: string, value: unknown) => void;
  };
  if (typeof provide !== "function") {
    ctx.logger?.warn?.(
      `[dsh-opencode-patch] ${serviceName} did not mount: this composition has neither ctx.plugin nor ctx.provide`
    );
    return;
  }
  try {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the constructors take cordis `Context`, whose types ship only from the Harness installation.
    provide.call(ctx, serviceName, new Service(ctx as never, options as never));
  } catch (error) {
    ctx.logger?.warn?.(
      `[dsh-opencode-patch] ${serviceName} did not mount`,
      error
    );
  }
};

/**
 * Roots that already carry the usage service.
 *
 * Keyed on the ROOT context rather than the activation, so a live reload neither
 * registers a duplicate nor loses the one it has. See {@link installUsageService}
 * for the measured failure this prevents.
 */
const usageMountedOn = new WeakSet<object>();

/**
 * Register the Go quota service and its Typert remote face.
 *
 * Runs before the fetch patch so a composition without `globalThis.fetch`
 * still gets a working meter.
 */
const installUsageService = (
  ctx: CordisContext,
  config: ResolvedPluginConfig
): void => {
  if (!config.usageEnabled) {
    ctx.logger?.info?.(
      "[dsh-opencode-patch] usage service NOT registered; the meter will render nothing"
    );
    return;
  }
  const usageOptions = {
    baseURL: () => resolveGoBaseURL(ctx, config.usageBaseURL),
    keySource: config.keySource,
    // The installation's own store, last and only when the user turned it on.
    readOpencodeStore: config.readOpencodeStore,
  };
  if (typeof ctx.plugin !== "function") {
    // `ctx.plugin` is the documented way and the one that gets cordis's own
    // bookkeeping. A composition without it is not one to give up on, though:
    // `ctx.provide` publishes the same service under the same name, which is what
    // the client looks for - and a meter that cannot mount is otherwise a
    // silence with no way to tell it from a meter whose service answered
    // nothing.
    mountByProvide(ctx, "opencodeGoUsage", GoUsageService, usageOptions);
    return;
  }
  // **Registered on the ROOT context, once per process.**
  //
  // Measured, and it is the whole of "the usage meter is not rendering: no usage
  // service: remote.opencodeGoUsage.read is missing": the host applies this
  // plugin more than once (a live reload does it on every patch), and the second
  // activation's `ctx.plugin(GoUsageService, …)` was refused as a duplicate
  // because the first activation's service was still alive. Then the first
  // fiber disposed — taking its service with it — and the second registration
  // had already been lost. Net result: no service at all, and the Gateway has
  // nothing to expose.
  //
  // Reproduced on a real cordis: apply → `present`, apply again →
  // `present`, dispose the first then re-apply → `MISSING`.
  //
  // Tied to the activation fiber, the service cannot survive that ordering. On
  // the root it belongs to the process, which is what a Gateway-scanned service
  // should be: `read()` resolves the credential per call, so a long-lived
  // instance holds no state that a reload could stale. The cost is that turning
  // `usageEnabled` off needs a process restart rather than a reload; a meter
  // that disappears and never comes back is the worse trade.
  const root: CordisContext = ctx.root ?? ctx;
  if (usageMountedOn.has(root)) {
    verifyUsageService(root);
    return;
  }
  usageMountedOn.add(root);
  // A throw here is not local: `apply` runs its installers in order, so an
  // unguarded throw takes every installer AFTER this one down with it - silently,
  // because nothing catches it either. Reported and contained instead, so a
  // meter that cannot mount is a meter that says so rather than one that also
  // takes the rest of the plugin with it.
  try {
    root.plugin?.(GoUsageService, usageOptions);
  } catch (error) {
    usageMountedOn.delete(root);
    ctx.logger?.warn?.(
      "[dsh-opencode-patch] the usage service did not mount; the meter will render nothing",
      error
    );
  }
  verifyUsageService(root);
};

/**
 * Confirm the usage service is REACHABLE from the context, and say so either way.
 *
 * The client reported, from a browser console:
 *
 *   the usage meter is not rendering: no usage service: remote.opencodeGoUsage.read is missing
 *
 * That names the client's half as fine (the contribution mounts, the descriptor
 * names `service: "opencodeGoUsage"`). The Gateway exposes a namespace from the
 * host's registry, so what is missing is a Service it can find — and there are
 * three ways that happens with nothing in the client to show it:
 *
 *  1. the host never registered it (this installer threw, or `usageEnabled` is off
 *     in the row the host actually loaded);
 *  2. it registered under another key;
 *  3. it registered as a VALUE (`ctx.provide`) rather than a Service, and the
 *     Gateway's "source-mode discovery" scans services, so a provided value is
 *     invisible to it even though `ctx.get` can see it.
 *
 * Cases 2 and 3 are indistinguishable from the client and from here, so this reads
 * the service back through the same context and reports what it found: whether it
 * resolved, and whether it carries the `typertRemote` binding the Gateway scans
 * for. One line, once per process, so the next console says which case it is
 * instead of a meter that is merely absent.
 */
const verifyUsageService = (ctx: CordisContext): void => {
  let resolved: unknown;
  try {
    resolved =
      typeof ctx.get === "function" ? ctx.get("opencodeGoUsage") : undefined;
  } catch {
    // An unregistered name answers undefined on some hosts and throws on others.
    resolved = undefined;
  }
  if (!isRecord(resolved)) {
    ctx.logger?.warn?.(
      "[dsh-opencode-patch] the usage service did not register: ctx.get('opencodeGoUsage') answered nothing",
      "the meter will render nothing with 'no usage service'"
    );
    return;
  }
  const binding: unknown = resolved.typertRemote;
  if (!isRecord(binding)) {
    ctx.logger?.warn?.(
      "[dsh-opencode-patch] the usage service registered but carries no typertRemote binding",
      "the Gateway's source-mode discovery will not find it; ctx.provide() publishes a value, not a Service",
      "the meter will render nothing with 'no usage service'"
    );
    return;
  }
  ctx.logger?.info?.(
    "[dsh-opencode-patch] the usage service is reachable with a typertRemote binding for namespace %s",
    typeof binding.namespace === "string" ? binding.namespace : "(unnamed)"
  );
};

/**
 * Roots that already carry the purge service, for the same reason the usage
 * service keeps its own set: `apply` runs once per live reload, and a service
 * tied to the activation fiber dies with it while a second registration is
 * refused as a duplicate. Process-scoped is what a Gateway-scanned service wants.
 */
const purgeMountedOn = new WeakSet<object>();

const installPurgeService = (ctx: CordisContext): void => {
  const root: CordisContext = ctx.root ?? ctx;
  if (purgeMountedOn.has(root)) {
    return;
  }
  purgeMountedOn.add(root);
  if (typeof ctx.plugin !== "function") {
    mountByProvide(ctx, "opencodeModelPurge", ModelPurgeService);
    return;
  }
  try {
    root.plugin?.(ModelPurgeService);
  } catch (error) {
    purgeMountedOn.delete(root);
    // Not fatal, and said out loud: without this service the card's purge row
    // reports that it is unavailable rather than failing the whole plugin.
    console.warn(
      "[dsh-opencode-patch] the purge service did not mount; the card will say so",
      error
    );
  }
};

const storeMountedOn = new WeakSet<object>();

const installStoreService = (ctx: CordisContext): void => {
  const root: CordisContext = ctx.root ?? ctx;
  if (storeMountedOn.has(root)) {
    return;
  }
  storeMountedOn.add(root);
  if (typeof ctx.plugin !== "function") {
    mountByProvide(ctx, STORE_NAMESPACE, OpencodeStoreService);
    return;
  }
  try {
    root.plugin?.(OpencodeStoreService);
  } catch (error) {
    storeMountedOn.delete(root);
    console.warn(
      "[dsh-opencode-patch] the opencode store inspection service did not mount",
      error
    );
  }
};

/**
 * Wrap `globalThis.fetch` so claimed OpenCode traffic carries session affinity
 * and the gateway headers, restoring it on dispose.
 *
 * @returns `false` when there is no fetch to wrap. The caller then stops: the
 * stream hook and discovery must not attach, or turns would run without the
 * session affinity this plugin exists to provide.
 */
const installFetchPatch = (
  ctx: CordisContext,
  config: ResolvedPluginConfig,
  als: AsyncLocalStorage<ActiveTurnState>
): boolean => {
  const originalFetch: unknown = globalThis.fetch;
  if (!isFetchFunction(originalFetch)) {
    ctx.logger?.warn?.(
      "[dsh-opencode-patch] globalThis.fetch is unavailable; cannot inject x-opencode-session"
    );
    return false;
  }

  const patched = patchFetch(originalFetch, als, config, {
    // The configured value wins, because it is the one thing here the user said
    // out loud. There is no login to infer an org from: this build carries the
    // API key path only.
    resolveOrg: () => config.credentialOrg,
    // One JSONL line per request the interceptor touched, when the deployment
    // asked for debugging. It is the only way to see a request that was patched
    // wrongly: the gateway's answer for a malformed session id reads exactly
    // like its answer for a bad credential.
    ...(config.debug && config.debugFile !== undefined
      ? {
          debug: (entry: Record<string, unknown>) => {
            void recordDebug(ctx, config.debugFile ?? "", entry);
          },
        }
      : {}),
  });

  ctx.effect?.(() => {
    globalThis.fetch = patched;
    // Console as well as the logger: the logger's default exporter only buffers,
    // so a boot line that says "the plugin loaded" has to reach stdout to be worth
    // anything when someone is checking whether a build was picked up.
    console.info(
      `[dsh-opencode-patch] active for providers [${[...config.providers].join(
        ", "
      )}]`
    );
    return () => {
      if (globalThis.fetch === patched) {
        globalThis.fetch = originalFetch;
      }
    };
  }, "dsh-opencode-patch.fetch-patch");

  return true;
};

/** Capture turn state (session id, project, parent) on every streamed turn. */
const installStreamHook = (
  ctx: CordisContext,
  config: ResolvedPluginConfig,
  als: AsyncLocalStorage<ActiveTurnState>
): void => {
  ctx.on?.("llm/stream", createStreamHook(ctx, config, als), { prepend: true });
};

/**
 * The settings the LATEST activation on a root resolved, which is what every
 * discovery callback answers from.
 *
 * Keyed on the root for the same reason the services are: `apply` runs once per
 * live reload, and the host refuses a second registration under a namespace that
 * is still held. The registrations therefore belong to the process, and only the
 * settings they read move with each activation.
 */
const discoveryConfigOn = new WeakMap<object, ResolvedPluginConfig>();

/** The namespaces this plugin publishes, and the catalog each one answers with. */
const DISCOVERY_NAMESPACES: readonly {
  readonly ns: string;
  readonly catalog: () => readonly CatalogModelSpec[];
}[] = [
  { catalog: () => [...getLiveGoCatalog(), ...getLiveZenCatalog()], ns: name },
  { catalog: getLiveGoCatalog, ns: "opencode-go" },
  { catalog: getLiveZenCatalog, ns: "opencode" },
];

/**
 * Publish the canonical Go/Zen catalog to DSH's model discovery.
 *
 * Model discovery is part of the same "canonical catalog" feature as the
 * gateway listing enrichment, so both sit behind the one `enrichModels`
 * toggle: turning it off leaves DSH's own catalog and the raw gateway
 * listings untouched.
 *
 * Registered once per root and never withdrawn, like the usage service. The
 * earlier shape registered on every activation and swallowed the host's
 * duplicate refusal, so the FIRST activation's settings answered forever: a
 * reload that changed `enrichModels` changed nothing the picker saw. Each
 * namespace is registered on its own, so one refusal no longer skips the
 * others.
 */
const installModelDiscovery = (
  scope: CordisContext,
  config: ResolvedPluginConfig
): void => {
  const root: CordisContext = scope.root ?? scope;
  const registered = discoveryConfigOn.has(root);
  if (!registered && !config.enrichModels) {
    return;
  }
  discoveryConfigOn.set(root, config);
  if (registered) {
    return;
  }
  const { llm } = scope;
  if (typeof llm?.registerModelDiscovery !== "function") {
    return;
  }
  const current = (): ResolvedPluginConfig =>
    discoveryConfigOn.get(root) ?? config;
  for (const { ns, catalog } of DISCOVERY_NAMESPACES) {
    try {
      llm.registerModelDiscovery(ns, () => {
        const settings = current();
        return Promise.resolve(
          settings.enrichModels ? toDiscovered(catalog()) : []
        );
      });
    } catch (error) {
      // Non-fatal, and said: a picker missing a plane is otherwise a silence.
      scope.logger?.warn?.(
        `[dsh-opencode-patch] model discovery for ${ns} did not register`,
        error
      );
    }
  }
};

/**
 * Discovery for one `llm` scope: the catalog namespaces, and the wrapper that
 * merges the catalog into a discovery answer, tied to the scope so an `llm`
 * restart or a disable undoes it.
 */
const installDiscovery = (
  ctx: CordisContext,
  config: ResolvedPluginConfig
): void => {
  ctx.inject?.(["llm"], (scope: unknown) => {
    if (!isRecord(scope)) {
      return;
    }
    const llmScope = scope as CordisContext;
    installModelDiscovery(llmScope, config);
    const stop = decorateModelDiscovery(llmScope, config);
    if (isFunctionLike(llmScope.effect)) {
      llmScope.effect(() => () => stop?.(), "dsh-opencode-patch.discovery");
    }
  });
};

/**
 * Plugin entry: claim the plane routes, register the quota service, patch
 * `fetch` for OpenCode traffic, and capture turn state for configured
 * providers.
 *
 * Order matters:
 * 1. the route claim, first, so its teardown is the first effect and runs
 *    last, and its `internal/config` listener is in place before any pi-ai
 *    config run this activation can see;
 * 2. the Settings graft, which reads the claim's committed entries;
 * 3. the rename notice and the services, before the fetch patch, so a
 *    composition without `globalThis.fetch` still gets a working meter;
 * 4. the fetch patch, which bails out (warning) when there is nothing to
 *    wrap — the stream hook must not be attached then, or turns would run
 *    without session affinity;
 * 5. the stream hook and model discovery, which only make sense once the
 *    request path is patched.
 *
 * The returned promise is the claim's mount: cordis waits for it, which is
 * what orders a pi-ai restart against the rest of the boot (F17). It never
 * rejects.
 *
 * @param ctx - the Cordis host context.
 * @param rawConfig - the row config, if any.
 */
export const apply = async (
  ctx: CordisContext,
  rawConfig: PluginConfig = {}
): Promise<void> => {
  const config = resolveConfig(rawConfig);
  const als = new AsyncLocalStorage<ActiveTurnState>();

  const claim = installRouteClaim(ctx, config);
  installDescribeGraft(ctx, claim);
  logRenameNotice(ctx);
  installUsageService(ctx, config);
  installPurgeService(ctx);
  installStoreService(ctx);

  if (installFetchPatch(ctx, config, als)) {
    installStreamHook(ctx, config, als);
    installDiscovery(ctx, config);
  }
  await claim.mounted;
};
