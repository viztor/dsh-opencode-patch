/**
 * Provider-aware decoration for DSH model discovery.
 *
 * The settings surface asks the adapter that owns a route—`llm-pi-ai` for
 * `opencode` and `opencode-go`—for candidates. When that adapter already
 * knows the route, it answers from its installed catalog without calling the
 * gateway, so response enrichment never runs. Decorating its returned
 * candidates is therefore the only in-plugin way to add a catalog model the
 * installed catalog omits, or to remove a model OpenCode CLI retired, from a
 * “fetch available models” answer.
 *
 * The decorator only rewrites results for an explicitly claimed OpenCode
 * provider route. Nothing is stored: as with the underlying discovery call,
 * the answer remains candidate metadata for the surface to adopt.
 *
 * @module dsh-opencode-patch/models-discovery
 */

import type { ResolvedPluginConfig } from "./config.ts";
import type { CordisContext } from "./cordis-context.ts";
import { isRecord } from "./guards.ts";
import {
  getLiveGoCatalog,
  findModelSpec,
  getLiveZenCatalog,
  isRetiredModel,
  sanitizeModalities,
  type CatalogModelSpec,
  type CatalogProvider,
} from "./models-catalog.ts";
import { isInternalRoute, isServableSdk } from "./responses-routes.ts";

export interface DiscoveryCandidate {
  contextWindow?: number;
  id: string;
  inputModalities?: string[];
  maxTokens?: number;
  name?: string;
}

/** Whether a discovery result has the shape this decorator can preserve. */
const isDiscoveryCandidate = (value: unknown): value is DiscoveryCandidate => {
  if (!isRecord(value)) {
    return false;
  }
  if (typeof value.id !== "string" || value.id.length === 0) {
    return false;
  }
  const { contextWindow, inputModalities, maxTokens, name } = value;
  if (name !== undefined && (typeof name !== "string" || name.length === 0)) {
    return false;
  }
  if (contextWindow !== undefined && typeof contextWindow !== "number") {
    return false;
  }
  if (maxTokens !== undefined && typeof maxTokens !== "number") {
    return false;
  }
  if (
    inputModalities !== undefined &&
    (!Array.isArray(inputModalities) ||
      inputModalities.some((modality) => typeof modality !== "string"))
  ) {
    return false;
  }
  return true;
};

/**
 * Decide which canonical catalog, if any, may supplement one discovery answer.
 *
 * Exact claimed route IDs win. A configured custom route or an unstored draft
 * falls back to the gateway URL only when the request names an OpenCode
 * gateway; anything else is left to its owning adapter.
 */
export const resolveDiscoveryProvider = (
  request: unknown,
  config: Pick<ResolvedPluginConfig, "gatewayUrls" | "providers">
): CatalogProvider | undefined => {
  const provider =
    isRecord(request) &&
    typeof request.provider === "string" &&
    request.provider.length > 0 &&
    config.providers.has(request.provider)
      ? request.provider
      : undefined;
  const baseURL =
    isRecord(request) && typeof request.baseURL === "string"
      ? request.baseURL
      : undefined;
  const normalizedBaseURL = baseURL?.toLowerCase() ?? "";
  const isGateway = config.gatewayUrls.some(
    (marker) =>
      marker.length > 0 && normalizedBaseURL.includes(marker.toLowerCase())
  );

  if (provider === "opencode-go") {
    return "go";
  }
  if (provider === "opencode") {
    return "zen";
  }
  if (!isGateway || baseURL === undefined) {
    return undefined;
  }
  return normalizedBaseURL.includes("/zen/go") ||
    normalizedBaseURL.includes("/go/v1")
    ? "go"
    : "zen";
};

/**
 * Merge canonical entries into an adapter’s discovery answer while honoring
 * provider-scoped retirements.
 *
 * The adapter’s own rows keep their capacities and order. Canonical rows are
 * appended only when the adapter did not already report that ID.
 */
export const mergeDiscoveredModels = (
  discovered: unknown,
  provider: CatalogProvider,
  catalog: readonly CatalogModelSpec[]
): DiscoveryCandidate[] => {
  const seen = new Set<string>();
  const merged: DiscoveryCandidate[] = [];

  if (Array.isArray(discovered)) {
    for (const candidate of discovered) {
      if (!isDiscoveryCandidate(candidate) || seen.has(candidate.id)) {
        continue;
      }
      if (isRetiredModel(provider, candidate.id)) {
        continue;
      }
      seen.add(candidate.id);
      merged.push({
        ...candidate,
        inputModalities: sanitizeModalities(candidate.inputModalities),
      });
    }
  }

  for (const spec of catalog) {
    if (seen.has(spec.id) || isRetiredModel(provider, spec.id)) {
      continue;
    }
    seen.add(spec.id);
    merged.push({
      contextWindow: spec.context_window,
      id: spec.id,
      inputModalities: sanitizeModalities(spec.input_modalities),
      maxTokens: spec.max_output_tokens,
      name: spec.name,
    });
  }

  return merged;
};

/**
 * The Host's UNFILTERED provider listing, captured when the hiding patch is
 * installed. The re-dispatch must consult this one: the patched listing
 * deliberately omits the route, so checking the patched method would make the
 * redirect never fire.
 */
let registeredRoutes: (() => unknown) | undefined;

/**
 * Whether a route the plugin owns is really registered on the Host.
 *
 * The redirect must consult the UNFILTERED registry: the patched listing
 * deliberately omits every internal route, so asking it would always answer "no"
 * and the re-dispatch would never fire.
 *
 * @param routeId - the internal route to test for.
 * @returns true when the unfiltered registry still carries the route.
 */
export const isRouteRegistered = (routeId: string): boolean => {
  const routes = registeredRoutes?.();
  return (
    Array.isArray(routes) &&
    routes.some((route) => isRecord(route) && route.id === routeId)
  );
};

/** Drop every internal route from a Host listing, leaving other entries alone. */
const withoutRoute = (value: unknown, key: "id" | "provider"): unknown =>
  Array.isArray(value)
    ? value.filter((entry) => !(isRecord(entry) && isInternalRoute(entry[key])))
    : value;

/** Whether a model can be served from some route. */
const isServableModel = (id: unknown): boolean =>
  typeof id !== "string" || isServableSdk(findModelSpec(id)?.provider_npm);

/**
 * Keep the internal routes out of every listing a user sees.
 *
 * Three surfaces enumerate providers, and the route has to be absent from all
 * of them or it shows up as a provider the user is invited to configure:
 *
 * - `buildModelCatalog` (the model picker) turns every registered route into a
 *   group and drops the groups whose model list is empty, so reporting no models
 *   removes it there.
 * - `joinProviderDirectory` (Settings → Models) maps `listConfigurableProviders`
 *   and then pushes a row for **every remaining registered provider** — so
 *   filtering only the configurable directory would not hide it.
 *
 * `listModels` is deliberately NOT patched. Every consumer of it in the Host
 * iterates `listProviders()` first — `buildModelCatalog`, `modelAvailable` and
 * `acp`'s model control all do — so once the registry omits the route, nothing
 * reaches its model list. Filtering it as well would be a third patch guarding
 * nothing.
 *
 * Nothing in dispatch reads these: the adapter registry resolves a route
 * internally, and the `llm/stream` hook uses {@link isResponsesRouteRegistered}
 * — which reads the ORIGINAL listing, captured here — to decide whether the
 * redirect has somewhere to go.
 *
 * @param ctx - host context carrying the LLM registry.
 * @returns the disposer restoring the original methods, or `undefined` when
 *   there is nothing to patch.
 */
export const hideResponsesRoute = (
  ctx: CordisContext
): (() => void) | undefined => {
  const { llm } = ctx;
  if (llm === undefined) {
    return undefined;
  }
  const {
    listConfigurableProviders: originalListConfigurableProviders,
    listModels: originalListModels,
    listProviders: originalListProviders,
  } = llm;
  if (
    typeof originalListProviders !== "function" &&
    typeof originalListConfigurableProviders !== "function" &&
    typeof originalListModels !== "function"
  ) {
    return undefined;
  }
  registeredRoutes = originalListProviders;

  const patched: Record<string, unknown> = {};
  if (typeof originalListProviders === "function") {
    patched.listProviders = function listProviders(this: unknown): unknown {
      return withoutRoute(Reflect.apply(originalListProviders, this, []), "id");
    };
  }
  if (typeof originalListConfigurableProviders === "function") {
    patched.listConfigurableProviders = function listConfigurableProviders(
      this: unknown
    ): unknown {
      return withoutRoute(
        Reflect.apply(originalListConfigurableProviders, this, []),
        "provider"
      );
    };
  }
  if (typeof originalListModels === "function") {
    // Filtering `listModels` is not about hiding the internal routes — nothing
    // reaches it for those, because `listProviders` no longer names them. It is
    // about what a user CAN pick: the `opencode` route's own list may name a
    // model whose SDK no route serves, and selecting it would fail with nothing
    // in the row to say why.
    patched.listModels = async function listModels(
      this: unknown,
      provider: string
    ): Promise<unknown> {
      if (isInternalRoute(provider)) {
        return [];
      }
      const models = await Reflect.apply(originalListModels, this, [provider]);
      return Array.isArray(models)
        ? models.filter(
            (model) => !isRecord(model) || isServableModel(model.id)
          )
        : models;
    };
  }

  const installed: string[] = [];
  const restoreFrom: Record<string, unknown> = {
    listConfigurableProviders: originalListConfigurableProviders,
    listModels: originalListModels,
    listProviders: originalListProviders,
  };
  try {
    for (const [key, value] of Object.entries(patched)) {
      Reflect.set(llm, key, value);
      installed.push(key);
    }
  } catch {
    for (const key of installed) {
      Reflect.set(llm, key, restoreFrom[key]);
    }
    return undefined;
  }
  return () => {
    for (const key of installed) {
      if (Reflect.get(llm, key) === patched[key]) {
        Reflect.set(llm, key, restoreFrom[key]);
      }
    }
  };
};

/**
 * Wrap the Host’s model-discovery method so “fetch available models” answers
 * for claimed OpenCode routes include the canonical catalog’s missing rows
 * and omit its provider-scoped retired rows.
 *
 * The original method keeps ownership of errors, cancellation, and every
 * unclaimed route. The returned disposer restores it.
 */
export const decorateModelDiscovery = (
  ctx: CordisContext,
  config: ResolvedPluginConfig
): (() => void) | undefined => {
  if (!config.enrichModels) {
    return undefined;
  }
  const { llm } = ctx;
  if (llm === undefined || typeof llm.discoverModels !== "function") {
    return undefined;
  }
  const discover = llm.discoverModels;
  const decorated = async (
    settingsNs: string,
    request?: unknown,
    signal?: AbortSignal
  ): Promise<unknown> => {
    const discovered = await Reflect.apply(discover, llm, [
      settingsNs,
      request,
      signal,
    ]);
    const provider = resolveDiscoveryProvider(request, config);
    if (provider === undefined) {
      return discovered;
    }
    return mergeDiscoveredModels(
      discovered,
      provider,
      provider === "go" ? getLiveGoCatalog() : getLiveZenCatalog()
    );
  };

  try {
    llm.discoverModels = decorated;
  } catch {
    // A non-extensible Host service must not prevent request patching.
    return undefined;
  }
  return () => {
    if (llm.discoverModels === decorated) {
      llm.discoverModels = discover;
    }
  };
};
