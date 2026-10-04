/**
 * Plugin lifecycle: the `apply()` entry point and its installers.
 *
 * `apply()` is a composition of small, independently readable installers, one
 * per side effect the plugin has on the host:
 *
 * | installer                | side effect                                   |
 * | ------------------------ | --------------------------------------------- |
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
import { patchFetch } from "./fetch-patch.ts";
import { resolveGoBaseURL } from "./go-discovery.ts";
import { isFetchFunction } from "./guards.ts";
import { LEGACY_NAME, LEGACY_PKG, name } from "./identity.ts";
import {
  type CatalogModelSpec,
  getLiveGoCatalog,
  getLiveZenCatalog,
  sanitizeModalities,
} from "./models-catalog.ts";
import {
  decorateModelDiscovery,
  hideResponsesRoute,
} from "./models-discovery.ts";
import { registerResponsesProvider } from "./responses-provider.ts";
import { createStreamHook } from "./stream-hook.ts";
import type { ActiveTurnState } from "./turn-store.ts";
import { GoUsageService, registerUsageRemotes } from "./usage.ts";

/** One catalog row in the shape DSH's model-discovery surface expects. */
const toDiscovered = (specs: readonly CatalogModelSpec[]) =>
  specs.map((m) => ({
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
 * Register the Go quota service and its Typert remote face.
 *
 * Runs before the fetch patch so a composition without `globalThis.fetch`
 * still gets a working meter.
 */
const installUsageService = (
  ctx: CordisContext,
  config: ResolvedPluginConfig
): void => {
  if (!config.usageEnabled || typeof ctx.plugin !== "function") {
    return;
  }
  ctx.plugin(GoUsageService, {
    baseURL: () => resolveGoBaseURL(ctx, config.usageBaseURL),
    keySource: config.keySource,
  });
  registerUsageRemotes(ctx);
};

/**
 * Wrap `globalThis.fetch` so claimed OpenCode traffic carries session affinity
 * and the gateway headers, restoring both on dispose.
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

  const patched = patchFetch(originalFetch, als, config);

  ctx.effect?.(() => {
    globalThis.fetch = patched;
    ctx.logger?.info?.(
      "[dsh-opencode-patch] active for providers [%s]",
      [...config.providers].join(", ")
    );
    // Decorate discovery in the same effect so disabling the plugin restores
    // both the gateway fetch behavior and the Host discovery method.
    const stopDiscoveryDecoration = decorateModelDiscovery(ctx, config);
    // Same reasoning for the listing patch: it replaces Host methods, so it must
    // be tied to this fiber. Called OUTSIDE an effect it would never be undone,
    // and every live reload would stack another wrapper. Installed before the
    // stream hook is used, because the redirect asks it whether the route is
    // really registered.
    const stopCatalogHiding = hideResponsesRoute(ctx);
    // Own the Responses route from here, so the user configures nothing: they
    // keep the `opencode` provider and key they already have. Best-effort — a
    // route declared in the profile still works if this cannot register. The
    // registration is async (it imports `llm-pi-ai` lazily), so the disposer
    // arrives after the effect body has returned.
    let stopResponsesProvider: (() => void) | undefined;
    void (async () => {
      stopResponsesProvider = await registerResponsesProvider(ctx);
    })();
    return () => {
      stopResponsesProvider?.();
      stopCatalogHiding?.();
      stopDiscoveryDecoration?.();
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
 * Publish the canonical Go/Zen catalog to DSH's model discovery.
 *
 * Model discovery is part of the same "canonical catalog" feature as the
 * gateway listing enrichment, so both sit behind the one `enrichModels`
 * toggle: turning it off leaves DSH's own catalog and the raw gateway
 * listings untouched.
 */
const installModelDiscovery = (
  ctx: CordisContext,
  config: ResolvedPluginConfig
): void => {
  if (!config.enrichModels) {
    return;
  }
  try {
    const { llm } = ctx;
    if (typeof llm?.registerModelDiscovery !== "function") {
      return;
    }
    llm.registerModelDiscovery(name, () =>
      Promise.resolve(
        toDiscovered([...getLiveGoCatalog(), ...getLiveZenCatalog()])
      )
    );
    llm.registerModelDiscovery("opencode-go", () =>
      Promise.resolve(toDiscovered(getLiveGoCatalog()))
    );
    llm.registerModelDiscovery("opencode", () =>
      Promise.resolve(toDiscovered(getLiveZenCatalog()))
    );
  } catch {
    // Model discovery registration is non-fatal
  }
};

/**
 * Plugin entry: register the quota service, patch `fetch` for OpenCode
 * traffic, and capture turn state for configured providers.
 *
 * Order matters:
 * 1. the rename notice, so it is the first thing a legacy row logs;
 * 2. the quota service, before the fetch patch, so a composition without
 *    `globalThis.fetch` still gets a working meter;
 * 3. the fetch patch, which bails out (warning) when there is nothing to
 *    wrap — `on` must not be attached in that case, or turns would run
 *    without session affinity;
 * 4. the stream hook and model discovery, which only make sense once the
 *    request path is patched.
 *
 * @param ctx - the Cordis host context.
 * @param rawConfig - the row config, if any.
 */
export const apply = (
  ctx: CordisContext,
  rawConfig: PluginConfig = {}
): void => {
  const config = resolveConfig(rawConfig);
  const als = new AsyncLocalStorage<ActiveTurnState>();

  logRenameNotice(ctx);
  installUsageService(ctx, config);

  if (!installFetchPatch(ctx, config, als)) {
    return;
  }

  installStreamHook(ctx, config, als);
  installModelDiscovery(ctx, config);
};
