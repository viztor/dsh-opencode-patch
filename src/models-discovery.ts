/**
 * Settings' model discovery, complemented by the plugin's catalog (D3).
 *
 * Settings → Models → Fetch asks the namespace a provider is configured under
 * — pi-ai's, for both planes — and pi-ai answers a plane from pi's packaged
 * catalog without calling the gateway. On a plane the plugin serves, this
 * wrapper answers pi's list plus every servable, non-deprecated catalog model
 * pi lacks, so a model newer than pi's vintage can be adopted from the fetch
 * rather than typed in; while pi-ai restarts it answers the catalog alone.
 *
 * It is candidate metadata, as the host's own answer is: nothing is written
 * until the user adopts a row and saves (D8), and the composer still shows
 * only the declared list.
 *
 * @module dsh-opencode-patch/models-discovery
 */

import type { ResolvedPluginConfig } from "./config.ts";
import type { CordisContext } from "./cordis-context.ts";
import { patchMethod } from "./host/patch-method.ts";
import type { RouteClaim } from "./host/route-claim.ts";
import {
  type CatalogModelSpec,
  type CatalogProvider,
  DSH_SUPPORTED_MODALITIES,
  findModelSpecOn,
  getLiveGoCatalog,
  getLiveZenCatalog,
  isDeprecatedModelOn,
} from "./models-catalog.ts";
import { isRecord } from "./utils/guards.ts";
import { isPlaneRoute, isServableSdk } from "./utils/protocols.ts";
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

/**
 * One row of a discovery answer: exactly the host's `LlmDiscoveredModel`.
 *
 * The host normalizes inside the method this module wraps, so what the wrapper
 * returns reaches the Remote as it is; its codec strips an unknown key and
 * refuses a modality other than text/image. A field nobody supplied is ABSENT,
 * never `undefined`: absent modalities mean "unknown", not "text" — and so
 * does a supplied list in which no text or image entry survives.
 */
export interface DiscoveredRow {
  readonly id: string;
  readonly name?: string;
  readonly contextWindow?: number;
  readonly maxTokens?: number;
  readonly inputModalities?: ("text" | "image")[];
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
 * A supplied modality list narrowed to what the Remote carries, or
 * `undefined` when nothing survives: an audio-only list says nothing about
 * text, so the row leaves the field absent ("unknown"), as the composer's own
 * plane model does for the same spec.
 */
const remoteModalities = (
  modalities: readonly string[]
): ("text" | "image")[] | undefined => {
  const kept = modalities.filter((modality): modality is "text" | "image" =>
    DSH_SUPPORTED_MODALITIES.has(modality)
  );
  return kept.length > 0 ? kept : undefined;
};

/**
 * One row in the Remote's shape: each field from the candidate first, then
 * from the catalog spec, and only when one of them has it.
 */
const rowFrom = (
  candidate: DiscoveryCandidate | undefined,
  spec: CatalogModelSpec | undefined,
  id: string
): DiscoveredRow => {
  const name = candidate?.name ?? spec?.name;
  const contextWindow = candidate?.contextWindow ?? spec?.context_window;
  const maxTokens = candidate?.maxTokens ?? spec?.max_output_tokens;
  const supplied = candidate?.inputModalities ?? spec?.input_modalities;
  const modalities =
    supplied === undefined ? undefined : remoteModalities(supplied);
  return {
    id,
    ...(name === undefined ? {} : { name }),
    ...(contextWindow === undefined ? {} : { contextWindow }),
    ...(maxTokens === undefined ? {} : { maxTokens }),
    ...(modalities === undefined ? {} : { inputModalities: modalities }),
  };
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
 * The adapter’s own rows keep their values and order; a field a row lacks is
 * filled from the catalog, and every row is cut to the Remote's five fields.
 * **Nothing is appended**: this is what a route the plugin does NOT serve gets
 * — another pi-ai row's planes, a custom relay, a gateway-URL draft — and
 * pi-ai, which serves those, cannot serve an id it does not list. A plane the
 * plugin serves is complemented by {@link complementDiscoveredModels} instead.
 */
export const mergeDiscoveredModels = (
  discovered: unknown,
  provider: CatalogProvider
): DiscoveredRow[] => {
  const seen = new Set<string>();
  const merged: DiscoveredRow[] = [];

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
      merged.push(
        rowFrom(
          candidate,
          findModelSpecOn(provider, candidate.id),
          candidate.id
        )
      );
    }
  }

  // **Offering is not overriding.** An earlier revision seeded the whole
  // catalog into the PICKER, and that is how a deployment that had declared
  // four models saw eighty-six. The picker still lists the declared models
  // alone (D3). What widens is Settings' fetch on a plane the plugin serves,
  // which offers candidates for the user to adopt: nothing is saved until they
  // do (D8), and that widening is {@link complementDiscoveredModels}, not this.
  return merged;
};

/**
 * Settings' fetch on a plane the plugin serves: pi's rows first, in pi's
 * order and enriched as {@link mergeDiscoveredModels} enriches them, then
 * every catalog model of the plane that is servable, not deprecated and
 * missing from pi's answer, in catalog order (D3).
 *
 * @param discovered - pi-ai's answer, or `[]` when it has none.
 * @param plane - the catalog plane the route serves.
 * @returns the rows, each id once, in the Remote's shape.
 */
export const complementDiscoveredModels = (
  discovered: unknown,
  plane: CatalogProvider
): DiscoveredRow[] => {
  const rows = mergeDiscoveredModels(discovered, plane);
  const seen = new Set(rows.map((row) => row.id));
  const catalog = plane === "go" ? getLiveGoCatalog() : getLiveZenCatalog();
  for (const spec of catalog) {
    if (
      seen.has(spec.id) ||
      !isServableSdk(spec.provider_npm) ||
      isDeprecatedModelOn(plane, spec.id)
    ) {
      continue;
    }
    seen.add(spec.id);
    rows.push(rowFrom(undefined, spec, spec.id));
  }
  return rows;
};

/** What the wrapper reads from the route claim. */
export type DiscoveryClaim = Pick<RouteClaim, "claiming" | "piAiNamespace">;

/**
 * The catalog plane a discovery request is complemented from, or `undefined`.
 *
 * Only a plane route asked on the namespace of the pi-ai row the claim serves,
 * and only while the claim has not stood down (from install on, before the
 * mount settles, too — see {@link RouteClaim.claiming}): there, the plugin's
 * adapter validates and serves a saved id whatever pi lists (D15). Anywhere
 * else — after a stand-down, or on a second pi-ai row serving its own planes —
 * pi-ai refuses at save an id it does not list, so offering one would offer a
 * refusal.
 */
const servedPlane = (
  settingsNs: unknown,
  request: unknown,
  claim: DiscoveryClaim
): CatalogProvider | undefined => {
  if (
    !claim.claiming() ||
    settingsNs !== claim.piAiNamespace() ||
    !isRecord(request) ||
    !isPlaneRoute(request.provider)
  ) {
    return undefined;
  }
  return request.provider === "opencode-go" ? "go" : "zen";
};

/**
 * Wrap the Host’s model-discovery method so Settings' fetch on a plane the
 * plugin serves offers the catalog's models pi does not list (D3), and answers
 * the catalog alone while pi-ai restarts instead of `NO_DISCOVERY`.
 *
 * Any other request the plugin can classify keeps the enrich-only merge, and
 * everything else passes through. The original method keeps ownership of every
 * other error and of cancellation. The returned disposer restores it.
 *
 * The wrapper never reads `signal`. On a plane route neither does pi-ai, which
 * answers from its installed catalog, and the host throws `NO_DISCOVERY` before
 * it looks at the signal; so a cancelled fetch resolves during the restart
 * window exactly as it does outside it, and the Remote discards the answer.
 */
export const decorateModelDiscovery = (
  ctx: CordisContext,
  config: ResolvedPluginConfig,
  claim: DiscoveryClaim
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
      async function discoverModels(
        this: unknown,
        settingsNs: unknown,
        request?: unknown,
        signal?: unknown
      ): Promise<unknown> {
        const plane = servedPlane(settingsNs, request, claim);
        let discovered: unknown;
        try {
          // The receiver is the caller's, as the host's own method would get
          // it: the gateway calls through a view of the service.
          discovered = await Reflect.apply(discover, this, [
            settingsNs,
            request,
            signal,
          ]);
        } catch (error) {
          // pi-ai's discovery is withdrawn while it restarts. The catalog
          // still answers for the plane, so the fetch does not fail on a
          // window the user cannot see.
          if (
            plane !== undefined &&
            isRecord(error) &&
            error.code === "NO_DISCOVERY"
          ) {
            return complementDiscoveredModels([], plane);
          }
          throw error;
        }
        if (plane !== undefined) {
          return complementDiscoveredModels(discovered, plane);
        }
        const other = resolveDiscoveryProvider(request, config);
        return other === undefined
          ? discovered
          : mergeDiscoveredModels(discovered, other);
      },
    { id: PATCH_SITE.discovery }
  );
};
