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
import { declaredProviderModels } from "./go-discovery.ts";
import {
  catalogPlaneForRoute,
  type CatalogPlane,
  findModelSpecOn,
  isDeprecatedModelOn,
  sanitizeModalities,
  type CatalogProvider,
} from "./models-catalog.ts";
import {
  baseForProtocol,
  LEGACY_PLANE_API,
  protocolFor,
  thinkingLevelMapFor,
} from "./pi-provider.ts";
import {
  GO_GOOGLE_INTERNAL_ROUTE,
  internalRouteFor,
  isInternalRoute,
  isServableSdk,
  PLANES,
  protocolFromModelId,
  UNSERVED_PLANE_SDKS,
} from "./responses-routes.ts";
import { isRecord } from "./utils/guards.ts";
import { isGoPlaneUrl } from "./utils/request-shape.ts";

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
 * The Host's UNFILTERED provider listing, captured when the hiding patch is
 * installed. The re-dispatch must consult this one: the patched listing
 * deliberately omits the route, so checking the patched method would make the
 * redirect never fire.
 */
/**
 * Kept WITH its receiver. A method read off the service and called detached
 * runs with `this === undefined`, and the LLM registry reads its own state
 * through `this` — so the detached call surfaces as
 * "Cannot read properties of undefined (reading 'adapters')", which names the
 * registry's internals rather than the call that broke the receiver.
 */
let registeredRoutes: { list: () => unknown; receiver: unknown } | undefined;

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
  if (registeredRoutes === undefined) {
    return false;
  }
  const { receiver } = registeredRoutes;
  if (
    isRecord(receiver) &&
    "adapters" in receiver &&
    receiver.adapters instanceof Map &&
    receiver.adapters.has(routeId)
  ) {
    return true;
  }
  const routes = Reflect.apply(
    registeredRoutes.list,
    registeredRoutes.receiver,
    []
  );
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

/**
 * Whether a model can be served, judged by the SDK the PLANE IN HAND declares.
 *
 * The plane matters: `qwen3.8-max`, `minimax-m2.7` and `minimax-m3` are
 * `@ai-sdk/anthropic` on Go and the default (completions) on Zen, so a Go-first
 * lookup filters a Zen listing by a Go fact. Same seam as the redirect's — see
 * `findModelSpecOn`.
 */
/**
 * Whether a model may be offered on a route.
 *
 * Exported for its own test: it is the one place I1's second clause lives, and the
 * interesting case is a model no catalog describes.
 */
export const isServableModel = (id: unknown, route: string): boolean => {
  if (typeof id !== "string") {
    return true;
  }
  // A free-tier id is OFFERED, and not because it is served from here - measured
  // since, and it is not: an API key, the account token, the token with its org,
  // every header the client sends (the message id included), both endpoints and
  // no credential at all each answer `403 FreeTierError`, while a paid model on
  // the same request answers `200`. A round of this reasoning claimed a signed-in
  // deployment would be served; it is not, and the run was made. What the console
  // source shows is that the refusal is not this request's shape at all: for a
  // model whose entry allows anonymous use, the console forwards the request to
  // the inference service keyless and does not refuse it itself, so the gate is
  // the vendor's service to open or close. Offering the ids is the decision that
  // follows - hiding would remove a row the vendor may serve, and the refusal is
  // legible now that it is reported as the model's own answer rather than as a
  // bad key.
  //
  // The refusal is not silent when it happens: `fetch-patch.ts` maps it to `400
  // free_tier_restricted` in the gateway's own words, and `stream-hook.ts`
  // reports a model this plugin cannot serve, once per pair - that report is what
  // a reader should be given instead of an empty picker.
  const plane = catalogPlaneForRoute(route);
  const spec = findModelSpecOn(plane, id);
  const sdk = spec?.provider_npm;
  if (sdk !== undefined) {
    if (UNSERVED_PLANE_SDKS.has(`${route} + ${sdk}`)) {
      return false;
    }
    return isServableSdk(sdk);
  }
  // A model the catalog does not describe: `undefined` is the completions default,
  // which is right for a model that omits its SDK and wrong for one nobody has
  // described. So the id is asked, and a family whose protocol this plane has no
  // route for is not offered - I1's second clause, which until now held only for
  // models the catalog carries. `internalRouteFor` answers exactly this: a route
  // when one exists, and `undefined` when the model stays where it is.
  return (
    protocolFromModelId(id) === undefined ||
    internalRouteFor(route, id) !== undefined
  );
};

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
 * **`listModels` IS patched, and the note that used to sit here saying it was
 * not is why the picker lost most of the catalog.** The old text read:
 *
 *   "`listModels` is deliberately NOT patched. Every consumer of it in the Host
 *    iterates `listProviders()` first … so once the registry omits the route,
 *    nothing reaches its model list."
 *
 * The premise is true and the conclusion does not follow. Hiding the internal
 * routes is exactly why their models must be JOINED into the parent route's list:
 * `buildModelCatalog` is `listProviders()` × `listModels(id)`, each internal route
 * carries only its own protocol's models, and hiding it therefore makes those
 * models unreachable rather than merely unlisted. Measured: 27 models in the
 * picker before the join, 88 after.
 *
 * The patch now does two things: it empties an internal route's own list (nothing
 * reaches it, but a third patch guarding nothing is cheaper than a surprise), and
 * it merges each plane root's list with its plane's catalog. Both are below.
 *
 * Nothing in dispatch reads these: the adapter registry resolves a route
 * internally, and the `llm/stream` hook uses {@link isResponsesRouteRegistered}
 * — which reads the ORIGINAL listing, captured here — to decide whether the
 * redirect has somewhere to go.
 *
 * @param ctx - host context carrying the LLM registry.
 * @param config - the resolved config, for the ids a deployment withholds.
 * @returns the disposer restoring the original methods, or `undefined` when
 *   there is nothing to patch.
 */
/**
 * What the listing patch needs from its caller beyond the configuration.
 */
export interface ListingOptions {
  /**
   * Whether this plane has a credential the gateway would accept.
   *
   * Absent means "do not ask": a caller that cannot tell leaves the list exactly
   * as the deployment declared it. Only a definite `false` narrows anything.
   */
  readonly hasCredential?: (plane: string) => boolean | Promise<boolean>;
}

/** The two routes this plugin owns; a deployment's own relay is not one. */
const isPlaneRoute = (provider: string): boolean =>
  provider === "opencode" || provider === "opencode-go";

/**
 * Whether the catalog prices this model above zero, on its own plane.
 *
 * The official client's keyless rule is exactly this test
 * (`packages/opencode/src/provider/provider.ts:231-237`: delete every model whose
 * `cost.input` is not 0 when no credential is present), so a keyless deployment
 * is offered the free ids and nothing it cannot pay for.
 *
 * @param plane - the catalog plane the route belongs to.
 * @param id - the model id.
 * @returns whether the model costs anything to call.
 */
const costsMoney = (plane: CatalogPlane, id: string): boolean => {
  const cost = findModelSpecOn(plane, id)?.cost;
  return cost !== undefined && cost.input > 0;
};

export const hideResponsesRoute = (
  ctx: CordisContext,
  config: ResolvedPluginConfig,
  options: ListingOptions = {}
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
  if (typeof originalListProviders === "function") {
    registeredRoutes = { list: originalListProviders, receiver: llm };
  }

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
    // **The deployment's model list is the whole list.** This route's `models:`
    // array is a decision the operator made, and the picker must show it and
    // nothing else.
    //
    // An earlier revision merged the plane's whole catalog in here, so that
    // models living on the hidden protocol routes would be reachable. That was
    // wrong, and the way it failed is worth keeping: the join was invisible on
    // screen (nobody can tell 27 rows from 88 unless they counted the config), it
    // overrode every explicit `models:` list, and it put models the operator never
    // offered in front of them — which is how a request for a model the account
    // cannot use became the reported bug. A route's list is not ours to widen.
    //
    // What remains is a filter, and only that: a model the plane cannot serve is
    // dropped, because offering one produces a failure with nothing in the row to
    // explain it. `internalRouteFor` still redirects a DECLARED model whose
    // protocol differs, so a Responses / Messages / Google id the operator lists
    // keeps working — it just has to be listed.
    patched.listModels = async function listModels(
      this: unknown,
      provider: string
    ): Promise<unknown> {
      if (isInternalRoute(provider)) {
        return [];
      }
      const models = await Reflect.apply(originalListModels, this, [provider]);
      if (!Array.isArray(models)) {
        return models;
      }
      // **An empty answer from a route that DECLARES models is a credential
      // fact, not a catalogue fact.** `dsh-llm-pi-ai` resolves the route's key
      // before listing and answers `[]` when it cannot — which at boot is the
      // ordinary case, and it emptied the picker for a route that declares
      // nineteen models. The declaration is in the loader config and needs no
      // credential, so it answers here.
      //
      // Only for the plane routes, and only when the adapter answered nothing:
      // an adapter that answered keeps its own list, unchanged.
      if (models.length === 0 && isPlaneRoute(provider)) {
        const declared = declaredProviderModels(ctx, provider);
        if (declared !== undefined && declared.length > 0) {
          return declared.map((entry) => ({
            id: entry.id,
            name: entry.name ?? entry.id,
            provider,
          }));
        }
      }
      const servable = models.filter(
        (model) => !isRecord(model) || isServableModel(model.id, provider)
      );
      // **Keyless deployments are offered only what they can actually call.**
      // The official client deletes every model whose price is non-zero when no
      // credential is present; without this the picker offers paid rows that
      // answer 401 with nothing in the row to explain it.
      if (options.hasCredential === undefined || !isPlaneRoute(provider)) {
        return servable;
      }
      const keyed = await options.hasCredential(provider);
      if (keyed) {
        return servable;
      }
      const plane = catalogPlaneForRoute(provider);
      return servable.filter((model) => {
        if (!isRecord(model)) {
          return true;
        }
        const { id } = model;
        return typeof id !== "string" || !costsMoney(plane, id);
      });
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
    return mergeDiscoveredModels(discovered, provider);
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

/** Every pi thinking level, in escalation order, `off` first. */
export const PI_THINKING_LEVELS: readonly string[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

/**
 * The reasoning efforts DSH renders for one model, read off the SAME
 * thinking-level map the routes dispatch on.
 *
 * One rule, so a level the composer offers is a level the model answers: a
 * level the map pins to `null` is not offered, and every other level is. The
 * wire spelling is NOT carried — an adapter's effort `id` is the pi level, and
 * `resolveReasoningLevel` matches it by that name before the adapter translates
 * it, so re-spelling it here would make the composer offer an effort the
 * resolver refuses.
 *
 * @param map - the model's `thinkingLevelMap`.
 * @returns the efforts, in escalation order.
 */
const effortsFromLevelMap = (
  map: Partial<Record<string, string | null>>
): { id: string; name: string }[] =>
  PI_THINKING_LEVELS.filter((level) => map[level] !== null).map((level) => ({
    id: level,
    name:
      level === "off"
        ? "Off"
        : `${level.charAt(0).toUpperCase()}${level.slice(1)}`,
  }));

/**
 * The vendor's retired plane bases, as they appear in pi's installed catalog and
 * in profiles written before the per-family move.
 *
 * Only these are rewritten. Matching a path rather than an origin keeps a
 * deployment's own proxy out of it: `https://gateway.internal/zen/v1` is not this
 * vendor's endpoint and is none of our business.
 *
 * The list is DERIVED from {@link LEGACY_PLANE_API}, not written out here. It was
 * written out here, and it carried only the Zen plane — so a profile declaring
 * `…/zen/v1` was repaired to the inference family while one declaring
 * `…/zen/go/v1`, the older address of the *other* plane, was left alone. Under
 * `endpoint: auto` both are "follow the catalog", and the second plane's old
 * address was quietly exempt: measured, both families answer 200 on Go, so the
 * only thing the omission bought was one plane drifting behind the other.
 *
 * The bare `…/zen` entry is the alias pi's own installed catalog still ships,
 * which the plane table writes with its version segment.
 */
const LEGACY_PLANE_BASES: ReadonlySet<string> = new Set([
  "https://opencode.ai/zen",
  ...Object.values(LEGACY_PLANE_API),
]);

/** Whether a value is a usable token count. */
const usableWindow = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value > 0;

/**
 * The context window a model actually gets.
 *
 * The rule is the repository's own, applied to a number: **a declaration outranks
 * an estimate.** The window the deployment wrote wins outright, and the catalog's
 * value is the fallback when it wrote none — which matters because the catalog is
 * a bundled snapshot of the vendor's published limits and is conservative where
 * the vendor is: the free DeepSeek id is listed at 200k while the model serves 1M.
 * `Math.min(requested, canonical)` used to clamp that back down and made a stale
 * entry unoverridable.
 *
 * `maxContextWindow` still clamps, because it is the deployment's own explicit
 * ceiling rather than our estimate of the model's.
 *
 * @param requestedWindow - the window the deployment (or the catalog) declared.
 * @param maxCeiling - the deployment's ceiling, when it configured one.
 * @returns the effective window in tokens, or 0 when nothing usable was given.
 */
export const resolveEffectiveContextWindow = (
  requestedWindow: number,
  maxCeiling?: unknown
): number => {
  const base = usableWindow(requestedWindow) ? requestedWindow : 0;
  return usableWindow(maxCeiling) ? Math.min(base, maxCeiling) : base;
};

/**
 * Wrap the ADAPTERS behind the plane routes, so a model our catalog carries but
 * pi's installed catalog does not is resolvable at dispatch, and takes every
 * thinking level the composer offers.
 *
 * This is the seam the `modelOverrides` attempt missed, and the method that
 * matters is `modelOf`. The picker reads the public `ctx.llm.resolveModelInfo`,
 * which this plugin decorates, so the composer renders OUR catalog's context and
 * levels for every catalogued model. Dispatch (`streamWithSnapshot`) resolves
 * the model through the adapter's `modelOf` and validates the saved effort with
 * `getSupportedThinkingLevels`; `modelInfo` - and so `resolveModel` and
 * `prepareCall` - read the same method, which is why filling the picker's answer
 * was never enough. For an id pi's installed catalog does not carry -
 * `glm-5.3-flash-free` on Zen, `cat-jam-free` on both planes, both declared in
 * the deployment's profile - with no `reasoningEfforts` of its own on the row,
 * that model materializes as `reasoning: false` with no level map: the only
 * level it takes is `off`, so every level the picker offered came back
 * UNSUPPORTED_REASONING_EFFORT.
 *
 * A `modelOverrides` entry cannot fix this - it only DESCRIBES ids
 * `defaults.has(id)`, and `entries` comes from `defaults.values()`, so an id pi
 * has never heard of is rejected in strict validation and never served anyway.
 *
 * The registry keeps its adapters in a public `Map`, so the registration is
 * wrapped in place: nothing is re-registered, the user's profile is untouched, and
 * the route keeps the adapter it always had. `resolveModel` and `prepareCall` fill
 * only what the adapter left BLANK, so an adapter that knows the model keeps its
 * own answer. `modelOf` is the other shape - what comes out of it has to ACCEPT
 * the levels the composer offers, or a saved effort cannot be dispatched - so it
 * fills the levels the model REFUSES and leaves every level it already takes
 * alone: nothing is removed, and a level that dispatches today dispatches the
 * same way afterwards.
 *
 * Only the adapters behind the plane ROUTES are wrapped - a foreign adapter in
 * the same registry (another provider's) is not this plugin's to replace - and
 * the original runs with the adapter as its receiver, because all three are
 * class methods that read `this`.
 *
 * @param llm - the Host's LLM service.
 * @param config - the resolved config, for the ids a deployment withholds.
 * @returns the disposer restoring the original methods, or `undefined`.
 */
export const decoratePlaneAdapters = (
  llm: CordisContext["llm"],
  config: ResolvedPluginConfig
): (() => void) | undefined => {
  // The registry's own map. Reached structurally rather than through a typed
  // handle because the service exposes it as a field, not a method.
  const registry = (llm ?? {}) as {
    adapters?: Map<string, { adapter: Record<string, unknown> }>;
  };
  const { adapters } = registry;
  if (!(adapters instanceof Map)) {
    return undefined;
  }
  const restored: (() => void)[] = [];
  for (const [route, registration] of adapters) {
    const adapter = registration?.adapter;
    if (adapter === undefined || adapter === null) {
      continue;
    }
    // Only the adapters behind THIS plugin's plane routes: the fill exists for
    // the routes a deployment declares without a `models` list, whose adapter
    // falls back to pi's installed catalog. Another provider's adapter is not
    // this plugin's to replace.
    if (!(route in PLANES)) {
      continue;
    }
    // The plane comes from the ROUTE, so a Go model is filled from the Go
    // catalog and a Zen one from Zen's - the same rule `findModelSpecOn` applies.
    const plane = catalogPlaneForRoute(route);
    for (const method of ["resolveModel", "prepareCall"] as const) {
      const original = adapter[method];
      if (typeof original !== "function") {
        continue;
      }
      const wrapped = async (
        provider: string,
        model: string,
        signal?: AbortSignal
      ): Promise<unknown> => {
        // Go's shipped catalog cannot resolve Gemini before the stream hook runs.
        // Ask the native bridge during model preparation as well as generation.
        if (
          provider === "opencode-go" &&
          internalRouteFor(
            provider,
            model,
            findModelSpecOn("go", model)?.provider_npm,
            config.modelRoutes[model]?.api
          ) === GO_GOOGLE_INTERNAL_ROUTE
        ) {
          const target = adapters.get(GO_GOOGLE_INTERNAL_ROUTE)?.adapter;
          const resolve = target?.[method];
          if (target !== undefined && typeof resolve === "function") {
            const prepared: unknown = await Reflect.apply(resolve, target, [
              GO_GOOGLE_INTERNAL_ROUTE,
              model,
              signal,
            ]);
            if (isRecord(prepared))
              return method === "prepareCall" && isRecord(prepared.model)
                ? { ...prepared, model: { ...prepared.model, provider } }
                : { ...prepared, provider };
            return prepared;
          }
        }
        // The original with the adapter as its receiver: both methods are class
        // methods that read `this` (pi-ai's open with `this.current()`), and a
        // detached call fails the provider's whole catalog load.
        const answered: unknown = await Reflect.apply(original, adapter, [
          provider,
          model,
          signal,
        ]);
        const spec = findModelSpecOn(plane, model);
        if (spec === undefined) {
          return answered;
        }
        // Only what the adapter left BLANK. An adapter that answers keeps its
        // answer, because that is what dispatch will honour.
        const override = config.modelOverrides[model];
        const record = isRecord(answered) ? answered : {};
        const existingContext = isRecord(record.context) ? record.context : {};
        const requestedWindow =
          override?.contextWindow ??
          (typeof existingContext.contextWindow === "number"
            ? existingContext.contextWindow
            : undefined);
        // What the deployment declared outranks the catalog; the catalog is the
        // fallback when nothing did.
        const declaredWindow = requestedWindow ?? spec.context_window;
        const effectiveWindow =
          declaredWindow > 0
            ? resolveEffectiveContextWindow(
                declaredWindow,
                config.maxContextWindow
              )
            : undefined;
        const modelName =
          override?.name ??
          (typeof record.name === "string" ? record.name : spec.name);
        const { defaultMaxTokens: recordMaxTokens } = record;
        let inputModalities: ("text" | "image")[] = sanitizeModalities(
          spec.input_modalities
        );
        if (override?.inputModalities !== undefined) {
          inputModalities = [...override.inputModalities];
        } else if (Array.isArray(record.inputModalities)) {
          inputModalities = sanitizeModalities(record.inputModalities);
        }

        let defaultMaxTokens: number | undefined;
        if (override?.maxTokens !== undefined) {
          defaultMaxTokens = override.maxTokens;
        } else if (typeof recordMaxTokens === "number") {
          defaultMaxTokens = recordMaxTokens;
        } else if (spec.max_output_tokens > 0) {
          defaultMaxTokens = spec.max_output_tokens;
        }

        // The same pair the picker reads: `thinkingLevelMapFor` decides which
        // levels exist, `effortsFromLevelMap` renders them, so a level offered
        // here is a level the composer shows.
        let supports: { id: string; name: string }[] | undefined;
        if (override?.reasoningEfforts !== undefined) {
          supports = override.reasoningEfforts.map((id) => ({
            id,
            name:
              id === "off"
                ? "Off"
                : `${id.charAt(0).toUpperCase()}${id.slice(1)}`,
          }));
        } else if (record.reasoning === undefined) {
          const map = thinkingLevelMapFor(spec);
          if (map !== undefined) {
            supports = effortsFromLevelMap(map);
          }
        }

        const outRecord: Record<string, unknown> = {
          ...record,
          inputModalities,
          name: modelName,
        };
        if (record.provider === undefined) {
          outRecord.provider = provider;
        }
        if (record.id === undefined) {
          outRecord.id = model;
        }
        if (effectiveWindow !== undefined) {
          outRecord.context = {
            ...existingContext,
            contextWindow: effectiveWindow,
          };
        }
        if (defaultMaxTokens !== undefined) {
          outRecord.defaultMaxTokens = defaultMaxTokens;
        }
        if (supports !== undefined && supports.length > 0) {
          outRecord.reasoning = { efforts: supports };
        }
        // **Route the model on the object the host dispatches on.**
        // `dsh-llm-pi-ai` selects the implementation per model —
        // `stream: (model, …) => input.api.stream(model, …)`, with the protocol
        // materialized as `request.api ?? base?.api ?? routeApi` — so a single
        // provider route serves every protocol its models name. That makes this
        // object the place to say it, and it is why a model needing Anthropic does
        // not need a provider of its own.
        //
        // The catalog's protocol is the default; `modelRoutes` overrides it, which
        // is the layer for an endpoint the shim gets wrong.
        const declaredRoute = config.modelRoutes[model];
        const protocol = declaredRoute?.api ?? protocolFor(spec);
        if (protocol !== undefined) {
          outRecord.api = protocol;
        }
        // **The endpoint: a declaration outranks our measurement, except where the
        // declaration is the vendor's own retired path.** pi's installed catalog
        // still says `https://opencode.ai/zen`, and a profile written for the old
        // gateway says `…/zen/v1`; both are aliases today (measured: `/zen/v1/…`
        // and `/inference/openai/v1/…` both answer 200), but the per-family
        // addresses are what the gateway serves, and an anthropic model on a
        // `/zen` base is simply wrong.
        //
        // Anything else is left alone: a deployment pointing this route at its own
        // proxy must not have that endpoint rewritten by a bundled snapshot.
        const existingBase =
          typeof record.baseUrl === "string"
            ? record.baseUrl.trim().replace(/\/+$/u, "")
            : undefined;
        const legacyBase =
          existingBase !== undefined && LEGACY_PLANE_BASES.has(existingBase);
        // The catalog's per-family endpoint is a REPAIR for a retired base and a
        // FALLBACK when none was given; an endpoint the deployment wrote is kept.
        const keepExisting =
          existingBase !== undefined && !legacyBase && protocol !== undefined;
        const measured =
          protocol === undefined
            ? undefined
            : baseForProtocol(route, protocol, config.endpoint);
        const baseURL =
          declaredRoute?.baseURL ?? (keepExisting ? existingBase : measured);
        if (baseURL !== undefined) {
          outRecord.baseUrl = baseURL;
        }
        return outRecord;
      };
      adapter[method] = wrapped;
      restored.push(() => {
        adapter[method] = original;
      });
    }

    // The half dispatch validates against, and the reason a filled picker was
    // still not enough. `streamWithSnapshot` resolves the model through
    // `modelOf` and then reads the level map off it; `getSupportedThinkingLevels`
    // refuses a level whose entry is `null` and refuses `xhigh`/`max` unless the
    // entry exists at all - so a level is filled exactly when the model does not
    // already take it, and a level the adapter (or the deployment's own row)
    // declares keeps its wire spelling.
    //
    // The map is the one the composer already renders: `thinkingLevelMapFor` is
    // the same derivation `decorateModelInfo` uses to build the picker's Effort
    // row, so the two read one source rather than two that have to agree.
    const originalModelOf = adapter.modelOf;
    if (typeof originalModelOf === "function") {
      const wrappedModelOf = (
        snapshot: unknown,
        provider: string,
        model: string
      ): unknown => {
        const answered: unknown = Reflect.apply(originalModelOf, adapter, [
          snapshot,
          provider,
          model,
        ]);
        if (!isRecord(answered)) {
          return answered;
        }
        const spec = findModelSpecOn(plane, model);
        if (spec === undefined) {
          return answered;
        }
        const override = config.modelOverrides[model];
        const levels =
          override?.reasoningEfforts === undefined
            ? thinkingLevelMapFor(spec)
            : Object.fromEntries(
                override.reasoningEfforts.map((id) => [id, id] as const)
              );
        // No opinion: the catalog does not call the model a reasoning one, and
        // the deployment named no level for it either.
        if (levels === undefined || Object.keys(levels).length === 0) {
          return answered;
        }
        const declared = isRecord(answered.thinkingLevelMap)
          ? answered.thinkingLevelMap
          : {};
        // pi's acceptance rule, which is what `resolveReasoningLevel` throws
        // against (`getSupportedThinkingLevels`): a model that reasons takes a
        // level whose entry is not `null`, and `xhigh`/`max` need an entry to
        // exist at all - an absent entry there is not a level, while for the
        // base levels it means the level's own name on the wire.
        const taken = (level: string): boolean => {
          if (answered.reasoning !== true) {
            return false;
          }
          const entry = declared[level];
          if (entry === null) {
            return false;
          }
          return level === "xhigh" || level === "max"
            ? entry !== undefined
            : true;
        };
        const merged: Record<string, unknown> = { ...declared };
        let filled = false;
        for (const [level, wire] of Object.entries(levels)) {
          // A level the model already takes keeps the adapter's own answer: one
          // that spells the level itself keeps that spelling, and one that leaves
          // it out keeps the level's name on the wire. Only what it REFUSES is
          // filled, so the levels that work today keep working byte for byte.
          if (wire === null || taken(level)) {
            continue;
          }
          merged[level] = wire;
          filled = true;
        }
        // Nothing to add - and so nothing to say about `reasoning` either, since
        // every level is only "taken" for a model that already reasons: hand back
        // the adapter's own object rather than an equal copy of it.
        if (!filled) {
          return answered;
        }
        return { ...answered, reasoning: true, thinkingLevelMap: merged };
      };
      adapter.modelOf = wrappedModelOf;
      restored.push(() => {
        adapter.modelOf = originalModelOf;
      });
    }
  }
  if (restored.length === 0) {
    return undefined;
  }
  return () => {
    for (const undo of restored.toReversed()) {
      undo();
    }
  };
};

/**
 * Wrap the Host's `resolveModelInfo` so a plane route's model reports the
 * thinking level the catalog declares and the context window it names.
 *
 * This is the seam the model picker actually reads. `buildModelCatalog`
 * (`dsh-api-session-controller`) calls `ctx.llm.resolveModelInfo` per model and
 * renders an Effort row only from what comes back — so a plane route whose
 * adapter reports no `reasoning` shows no Effort row at all, which is the exact
 * symptom this exists for: `MiniMax-M3` and `MiniMax-M2.7` declare
 * `reasoning: true` in the catalog and still offered no thinking level.
 *
 * A plane route is a profile's own (`opencode`, `opencode-go`), and its adapter
 * materializes each declared row OVER the installed catalog's entry for the same
 * id: a row that declares no `reasoningEfforts` reports what that snapshot says
 * of the id — `reasoning: false`, with no level map, for every id it does not
 * carry — beside the row's own window and output cap.
 *
 * The fields our catalog carries are therefore AUTHORITATIVE here rather than
 * advisory: filling only what the adapter left blank let a stale snapshot report
 * itself on every surface that showed it, measured as 272k for `gpt-5.4` where
 * the vendor and our shim both say 1.05M. Only a model the catalog cannot
 * describe is passed through untouched, which is what keeps an id that only the
 * installed catalog knows — and a `reasoningEfforts` the row declares beside it
 * — reporting its own truth. A `modelOverrides` entry decides the fields it
 * names, its window being a request clamped by `maxContextWindow`. The INTERNAL
 * routes this plugin mounts already carry the right metadata through
 * {@link reasoningEffortsFor}, and are passed through so the two never disagree.
 *
 * That authority has a cost dispatch still pays: the requested level is
 * validated against the ADAPTER's object, not this one, so a level offered here
 * and refused there fails the turn — {@link decoratePlaneAdapters} fills that
 * object from the same catalog derivation so the two cannot disagree.
 *
 * @param ctx - host context carrying the LLM registry.
 * @param config - the resolved plugin config.
 * @returns the disposer restoring the original method, or `undefined`.
 */
export const decorateModelInfo = (
  ctx: CordisContext,
  config: ResolvedPluginConfig
): (() => void) | undefined => {
  if (!config.enrichModels) {
    return undefined;
  }
  const { llm } = ctx;
  if (llm === undefined || typeof llm.resolveModelInfo !== "function") {
    return undefined;
  }
  const original = llm.resolveModelInfo;
  const decorated = async (
    provider: string,
    model: string,
    signal?: AbortSignal
  ): Promise<unknown> => {
    let resolved: unknown;
    try {
      resolved = await Reflect.apply(original, llm, [provider, model, signal]);
    } catch (error) {
      // **One throw removes the WHOLE provider group from the picker.** The Host
      // builds a group with `Promise.all` over `listModels`, and a rejection
      // there is caught per PROVIDER, not per model — so the user loses every
      // model on that route, not one row.
      //
      // That became reachable when `listModels` started publishing the catalog on
      // the parent route: the route's own adapter never carried the Responses,
      // Messages or Google models, so `resolveModelInfo` may refuse an id it does
      // not know. Our catalog does know it, so answer from there rather than
      // letting one unknown id take the group down.
      //
      // A model the catalog cannot describe either is rethrown: inventing an
      // answer for an id nobody knows would hide a real problem.
      const spec = findModelSpecOn(catalogPlaneForRoute(provider), model);
      if (isInternalRoute(provider) || spec === undefined) {
        throw error;
      }
      resolved = {};
    }
    // Our own routes carry the real metadata already.
    if (isInternalRoute(provider)) {
      return resolved;
    }
    const spec = findModelSpecOn(catalogPlaneForRoute(provider), model);
    if (spec === undefined) {
      return resolved;
    }
    // A NON-RECORD answer is the same hazard as a throw, one step quieter: the
    // Host reads `resolved.reasoning` immediately after this returns, so
    // `undefined` becomes `TypeError: Cannot read properties of undefined` inside
    // the group's `Promise.all` — and the whole provider group goes with it. When
    // the catalog knows the model, the answer is built from the catalog instead of
    // passed through.
    const out: Record<string, unknown> = isRecord(resolved)
      ? { ...resolved }
      : {};
    // Our catalog is the FRESHER VINTAGE of the same data, and the divergence is
    // measured rather than assumed. pi ships an installed `opencode` catalog the
    // plane routes fall back to, and it is a different snapshot of models.dev:
    // it says 272k for `gpt-5.4` and 200k for `claude-sonnet-4-5` where the
    // vendor and our shim both say 1.05M and 1M, and it carries no
    // `thinkingLevelMap` for the `budget_tokens` Claude models where models.dev
    // declares a token minimum.
    //
    // Filling only what the adapter left BLANK let every one of those stale
    // values survive, which is what the surfaces then reported — so the fields
    // our catalog carries are authoritative here rather than advisory.
    const override = config.modelOverrides[model];
    const existingContext = isRecord(out.context) ? out.context : {};
    const requestedWindow = override?.contextWindow;

    if (typeof spec.context_window === "number" && spec.context_window > 0) {
      const effectiveWindow = resolveEffectiveContextWindow(
        requestedWindow ?? spec.context_window,
        config.maxContextWindow
      );
      out.context = {
        ...existingContext,
        contextWindow: effectiveWindow,
      };
    }
    // The output cap is the same class of staleness, and a wrong one truncates
    // rather than merely mis-reports.
    if (override?.maxTokens !== undefined) {
      out.defaultMaxTokens = override.maxTokens;
    } else if (
      typeof spec.max_output_tokens === "number" &&
      spec.max_output_tokens > 0
    ) {
      out.defaultMaxTokens = spec.max_output_tokens;
    }
    if (override?.name !== undefined) {
      out.name = override.name;
    }
    if (override?.inputModalities !== undefined) {
      out.inputModalities = [...override.inputModalities];
    }
    if (override?.reasoningEfforts === undefined) {
      const map = thinkingLevelMapFor(spec);
      const efforts = map === undefined ? [] : effortsFromLevelMap(map);
      if (efforts.length > 0) {
        out.reasoning = { efforts };
      } else {
        // The model takes no thinking level. Leaving the adapter's `reasoning`
        // here would offer a control the model refuses — and for a model our
        // catalog marks non-reasoning, that is exactly the stale shape.
        delete out.reasoning;
      }
    } else {
      out.reasoning = {
        efforts: override.reasoningEfforts.map((id) => ({
          id,
          name:
            id === "off"
              ? "Off"
              : `${id.charAt(0).toUpperCase()}${id.slice(1)}`,
        })),
      };
    }
    return out;
  };

  try {
    llm.resolveModelInfo = decorated;
  } catch {
    return undefined;
  }
  return () => {
    if (llm.resolveModelInfo === decorated) {
      llm.resolveModelInfo = original;
    }
  };
};
