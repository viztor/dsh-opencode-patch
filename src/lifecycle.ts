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
 * | {@link installRemoteServices} | the usage, purge and store-inspection services, through {@link installRemoteService} |
 * | {@link installFetchPatch}   | wrap `globalThis.fetch` (returns `undefined` if none) |
 * | {@link installStreamHook}   | capture turn state on `llm/stream`; warn once if fetch was replaced (L1) |
 * | {@link installDiscovery}  | complement Settings' model discovery with the catalog (D3) |
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
import { installRemoteService } from "./host/remote.ts";
import { installRouteClaim } from "./host/route-claim.ts";
import { LEGACY_NAME, LEGACY_PKG } from "./identity.ts";
import {
  decorateModelDiscovery,
  type DiscoveryClaim,
} from "./models-discovery.ts";
import { storeRemote } from "./opencode-store-contract.ts";
import { OpencodeStoreService } from "./opencode-store-service.ts";
import { purgeRemote } from "./purge-contract.ts";
import { ModelPurgeService } from "./purge-service.ts";
import { createStreamHook } from "./stream-hook.ts";
import type { ActiveTurnState } from "./turn-store.ts";
import { usageRemote } from "./usage-contract.ts";
import { GoUsageService } from "./usage.ts";
import { isFetchFunction, isFunctionLike, isRecord } from "./utils/guards.ts";

/**
 * The fetch patches of this module's live activations. Two live activations
 * nest (the later one wraps the earlier one's patch), so an activation's own
 * patch still runs while `globalThis.fetch` is ANY of these; a function outside
 * the set reads as a replacement (L1). One such function still calls through:
 * a disposed patch that a later activation's restore put back (P6's stale
 * restore, which takes three overlapping activations on one root, the middle
 * one disposed first), so that case warns although the patch runs.
 */
const livePatches = new Set<unknown>();

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
 * Mount the usage meter's, the purge row's and the store inspection's remote
 * services on the root (see {@link installRemoteService}), in that order.
 *
 * Runs before the fetch patch so a composition without `globalThis.fetch`
 * still gets a working meter.
 *
 * @returns each mount's report, settled once the mount has been checked; none
 * rejects.
 */
const installRemoteServices = (
  ctx: CordisContext,
  config: ResolvedPluginConfig
): Promise<void>[] => {
  const reports: Promise<void>[] = [];
  if (config.usageEnabled) {
    reports.push(
      installRemoteService(ctx, GoUsageService, usageRemote, {
        baseURL: () => resolveGoBaseURL(ctx, config.usageBaseURL),
        keySource: config.keySource,
        // The installation's own store, last and only when the user turned it on.
        readOpencodeStore: config.readOpencodeStore,
      })
    );
  } else {
    ctx.logger?.info?.(
      "[dsh-opencode-patch] usage service NOT registered; the meter will render nothing"
    );
  }
  reports.push(
    installRemoteService(ctx, ModelPurgeService, purgeRemote),
    installRemoteService(ctx, OpencodeStoreService, storeRemote)
  );
  return reports;
};

/**
 * Wrap `globalThis.fetch` so claimed OpenCode traffic carries session affinity
 * and the gateway headers, restoring it on dispose.
 *
 * @returns `undefined` when there is no fetch to wrap. The caller then stops:
 * the stream hook and discovery must not attach, or turns would run without
 * the session affinity this plugin exists to provide. Otherwise, whether
 * `globalThis.fetch` is still a live patch of this module's, this
 * activation's or one that wraps it (L1), which the stream hook reads per
 * decorated turn.
 */
const installFetchPatch = (
  ctx: CordisContext,
  config: ResolvedPluginConfig,
  als: AsyncLocalStorage<ActiveTurnState>
): (() => boolean) | undefined => {
  const originalFetch: unknown = globalThis.fetch;
  if (!isFetchFunction(originalFetch)) {
    ctx.logger?.warn?.(
      "[dsh-opencode-patch] globalThis.fetch is unavailable; cannot inject x-opencode-session"
    );
    return undefined;
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
    // **The FILE is written when the deployment named a file.** `debug` is the
    // console switch ("Log injected streamed calls"), and `debugFile` is the
    // path — so a deployment that set only the path asked for the file, and
    // the two halves of one JSONL log must not have different gates.
    //
    // They did: the stream hook wrote its entries whenever a path was set, and
    // this one required `debug` as well. So the README's own example — `debug:
    // false` beside a `debugFile` path — produced a file holding the stream
    // entries and none of the per-request ones, which is the half that says
    // what the interceptor did.
    ...(config.debugFile === undefined
      ? {}
      : {
          debug: (entry: Record<string, unknown>) => {
            void recordDebug(ctx, config.debugFile ?? "", entry);
          },
        }),
  });

  ctx.effect?.(() => {
    globalThis.fetch = patched;
    livePatches.add(patched);
    // Console as well as the logger: the logger's default exporter only buffers,
    // so a boot line that says "the plugin loaded" has to reach stdout to be worth
    // anything when someone is checking whether a build was picked up.
    console.info(
      `[dsh-opencode-patch] active for providers [${[...config.providers].join(
        ", "
      )}]`
    );
    return () => {
      livePatches.delete(patched);
      if (globalThis.fetch === patched) {
        globalThis.fetch = originalFetch;
      }
    };
  }, "dsh-opencode-patch.fetch-patch");

  return () => livePatches.has(globalThis.fetch);
};

/**
 * Capture turn state (session id, project, parent) on every streamed turn,
 * except a turn on a plane the route claim left to another plugin (D27), and
 * warn once if a decorated turn finds the fetch patch replaced (L1).
 */
const installStreamHook = (
  ctx: CordisContext,
  config: ResolvedPluginConfig,
  als: AsyncLocalStorage<ActiveTurnState>,
  steppedAside: () => ReadonlySet<string>,
  fetchInPlace: () => boolean
): void => {
  ctx.on?.(
    "llm/stream",
    createStreamHook(ctx, config, als, steppedAside, fetchInPlace),
    { prepend: true }
  );
};

/**
 * Settings' model discovery for one `llm` scope: a fetch on a plane the
 * plugin serves is complemented by the catalog (D3). Tied to the scope, so an
 * `llm` restart wraps the new service and a disable undoes it.
 */
const installDiscovery = (
  ctx: CordisContext,
  config: ResolvedPluginConfig,
  claim: DiscoveryClaim
): void => {
  ctx.inject?.(["llm"], (scope: unknown) => {
    if (!isRecord(scope)) {
      return;
    }
    const llmScope = scope as CordisContext;
    const stop = decorateModelDiscovery(llmScope, config, claim);
    if (isFunctionLike(llmScope.effect)) {
      llmScope.effect(() => () => stop?.(), "dsh-opencode-patch.discovery");
    }
  });
};

/**
 * Plugin entry: claim the plane routes, mount the remote services, patch
 * `fetch` for OpenCode traffic, and capture turn state for configured
 * providers.
 *
 * Order matters:
 * 1. the route claim, first, so its teardown is the first effect and runs
 *    last, and its `internal/config` listener is in place before any pi-ai
 *    config run this activation can see;
 * 2. the Settings graft, which reads the claim's committed entries;
 * 3. the rename notice and the remote services, before the fetch patch, so
 *    a composition without `globalThis.fetch` still gets a working meter;
 * 4. the fetch patch, which bails out (warning) when there is nothing to
 *    wrap — the stream hook must not be attached then, or turns would run
 *    without session affinity;
 * 5. the stream hook, and the Settings discovery wrapper that complements a
 *    plane's fetch with the catalog (D3), which only make sense once the
 *    request path is patched.
 *
 * The returned promise is the claim's mount and the remote services'
 * reports: cordis waits for it, which is what orders a pi-ai restart against
 * the rest of the boot (F17), and each service is checked once its mount has
 * settled. It never rejects.
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
  const services = installRemoteServices(ctx, config);

  const fetchInPlace = installFetchPatch(ctx, config, als);
  if (fetchInPlace !== undefined) {
    installStreamHook(ctx, config, als, claim.steppedAside, fetchInPlace);
    installDiscovery(ctx, config, claim);
  }
  await Promise.all([claim.mounted, ...services]);
};
