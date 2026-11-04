/**
 * Provider-aware decoration for DSH model discovery.
 *
 * The settings surface asks the adapter that owns a route for candidates —
 * this plugin's plane adapter for `opencode` and `opencode-go`, which answers
 * the way `llm-pi-ai` does, from pi's installed catalog without calling the
 * gateway, so response enrichment never runs. Decorating its returned
 * candidates is therefore the in-plugin way to fill a capacity the installed
 * catalog omits, or to remove a model OpenCode CLI retired, from a “fetch
 * available models” answer. (P3 replaces this wrapper with a discovery
 * answer of the plugin's own.)
 *
 * The decorator only rewrites results for an explicitly claimed OpenCode
 * provider route. Nothing is stored: as with the underlying discovery call,
 * the answer remains candidate metadata for the surface to adopt.
 *
 * @module dsh-opencode-patch/models-discovery
 */

import type { ResolvedPluginConfig } from "./config.ts";
import type { CordisContext } from "./cordis-context.ts";
import { patchMethod } from "./host/patch-method.ts";
import {
  findModelSpecOn,
  isDeprecatedModelOn,
  sanitizeModalities,
  type CatalogProvider,
} from "./models-catalog.ts";
import { isRecord } from "./utils/guards.ts";
import { isGoPlaneUrl } from "./utils/request-shape.ts";

/**
 * The patch sites this module installs, one id each. Two activations of the
 * same site share it, which is how a reload replaces a wrapper instead of
 * stacking another one on it (see `host/patch-method.ts`).
 */
const PATCH_SITE = {
  discovery: "dsh-opencode-patch/model-discovery",
} as const;

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
  // The plane is a property of the path, and the path is read as a path: the
  // Go plane's base is the `inference` family (`…/inference/go/openai/v1`), and
  // a substring check that does not know that path attributes a Go discovery
  // request to the ZEN catalog.
  return isGoPlaneUrl(baseURL) ? "go" : "zen";
};

/**
 * Enrich an adapter’s discovery answer from the catalog, honoring provider-scoped
 * retirements.
 *
 * The adapter’s own rows keep their capacities and order; a missing capacity is
 * filled from the catalog. **Catalog rows are NOT appended when the adapter
 * answered at all** — the deployment’s list is the list, and a refresh must not
 * widen it. They are used only as a cold-start fallback, when the adapter
 * reported nothing, so a route is never empty.
 *
 * An earlier version always appended the catalog. On the picker that was
 * invisible until someone counted the rows; on a refresh it is the same mistake a
 * second time — the settings model list would grow past what was configured.
 */
export const mergeDiscoveredModels = (
  discovered: unknown,
  provider: CatalogProvider
): DiscoveryCandidate[] => {
  const seen = new Set<string>();
  const merged: DiscoveryCandidate[] = [];

  if (Array.isArray(discovered)) {
    for (const candidate of discovered) {
      if (!isDiscoveryCandidate(candidate) || seen.has(candidate.id)) {
        continue;
      }
      // Retired by the REGISTRY, not by our own list. The adapter's installed
      // snapshot is older than the live catalog and still lists ids the vendor
      // has retired; merging it unchanged is a picker led by models that no
      // longer answer. Our catalog drops them during parse, so without this the
      // merge is what puts them back.
      if (isDeprecatedModelOn(provider, candidate.id)) {
        continue;
      }
      seen.add(candidate.id);
      const spec = findModelSpecOn(provider, candidate.id);
      merged.push({
        ...candidate,
        contextWindow: candidate.contextWindow ?? spec?.context_window,
        inputModalities: sanitizeModalities(
          candidate.inputModalities ?? spec?.input_modalities
        ),
        maxTokens: candidate.maxTokens ?? spec?.max_output_tokens,
      });
    }
  }

  // **Nothing is ever added.** An earlier revision seeded the whole catalog when
  // the adapter reported no models ("cold start"), and that is how a deployment
  // that had declared four models saw eighty-six: the fallback could not see the
  // declaration, so it treated "no answer" as "no preference". A list this plugin
  // is not the owner of is never widened — the same rule that withdrew the picker
  // join, applied to the empty case.
  //
  // The cost is honest: a cold start with nothing discovered shows nothing until
  // the adapter answers. Showing models the deployment did not select is the worse
  // failure, because it looks like a working picker.
  // **Discovery does NOT get the catalog either.**
  //
  // This briefly joined the whole catalog into `discoverModels`, reasoning that
  // "browse to pick" is a different surface from "what this route serves". The
  // owner's instruction had been explicit — *user can select them from the list,
  // but we shouldn't override the user's config for what is usable* — and the
  // join violated it: Settings listed models the deployment never declared, which
  // is the same failure the picker join was withdrawn for.
  //
  // The original problem it was reaching for was narrower: pi's installed
  // snapshot is a fixed vintage and can miss a model the ENDPOINT reports. That
  // is answered by the adapter's own answer, not by this plugin's bundled copy.
  return merged;
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
  // A non-extensible Host service answers `undefined` here, and must not
  // prevent request patching.
  return patchMethod(
    llm,
    "discoverModels",
    (discover) =>
      async (
        settingsNs: string,
        request?: unknown,
        signal?: AbortSignal
      ): Promise<unknown> => {
        const discovered: unknown = await Reflect.apply(discover, llm, [
          settingsNs,
          request,
          signal,
        ]);
        const provider = resolveDiscoveryProvider(request, config);
        if (provider === undefined) {
          return discovered;
        }
        return mergeDiscoveredModels(discovered, provider);
      },
    { id: PATCH_SITE.discovery }
  );
};
