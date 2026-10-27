/**
 * A plane's resolved profile, built from its raw entry the way pi-ai builds
 * one for any route (`llm-pi-ai/src/config.ts` `resolveProfiles`), minus the
 * one refusal the plugin exists to lift: an id pi's catalog does not describe
 * no longer "needs an api" (D15), because {@link planeModelFor} classifies it.
 *
 * Every field comes from the entry or from pi-ai's own defaults, none from a
 * sibling route. Every check pi-ai makes is mirrored with its message, and
 * every one is DEFERRED: a malformed model lands in `modelErrors` (the adapter
 * answers `INVALID_CONFIG` for it and serves the rest), and a malformed route
 * lands in `catalogError` with no `piProvider` (every model on it answers
 * `INVALID_CONFIG`). Nothing here throws, whatever the input: a throw would
 * reach the plugin's reconcile, and through it the route.
 *
 * The host pieces it needs — pi-ai's `Config`, the loader's `interpolate`,
 * dsh-llm's `resolveRetryPolicy`, pi's provider builder — come in as
 * functions, so the module stays pure.
 *
 * @module dsh-opencode-patch/utils/plane-profile
 */

import { isRecord } from "./guards.ts";
import { usesCatalogThinkingLevels } from "./model-metadata.ts";
import {
  type EndpointChoice,
  type PlaneCatalogSpec,
  type PlaneModelEntry,
  type PlanePiModel,
  planeModelFor,
} from "./plane-model.ts";
import {
  allOfferedCompatFields,
  compatProtocols,
  isGatedCompatField,
  isServableSdk,
  PLANE_ROUTES,
  type PlaneRoute,
} from "./protocols.ts";

/** The largest timer delay a stream watchdog can arm (`MAX_TIMER_DELAY_MS`). */
const MAX_TIMER_DELAY_MS = 2_147_483_647;

/** pi-ai's credential-ref grammar (`dsh-credentials` `REF_PATTERN`). */
const REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u;

/** pi-ai's defaults for a profile that states none (`config.ts`). */
const DEFAULTS = {
  contextWindow: 262_144,
  input: ["text"],
  maxRequestImageBytes: 20 * 1024 * 1024,
  maxTokens: 32_768,
  requestImageMaxBytes: 1024 * 1024,
  requestImagePixelBudget: 2048 * 2048,
  streamIdleTimeoutMs: 300_000,
} as const;

/** A plane-copy of a raw config: never the input, never mutated. */
export const withoutPlaneProviders = (raw: unknown): unknown => {
  if (!isRecord(raw) || !isRecord(raw.providers)) {
    return isRecord(raw) ? { ...raw } : raw;
  }
  const { opencode: _zen, "opencode-go": _go, ...rest } = raw.providers;
  return { ...raw, providers: { ...rest } };
};

/** Whether a raw config declares either plane. */
export const hasPlaneEntries = (raw: unknown): boolean => {
  const providers: unknown = isRecord(raw) ? raw.providers : undefined;
  return (
    isRecord(providers) &&
    PLANE_ROUTES.some((plane) => Object.hasOwn(providers, plane))
  );
};

/** The declared planes of a raw config, by route. */
export const planeEntriesOf = (
  raw: unknown
): Partial<Record<PlaneRoute, unknown>> => {
  const out: Partial<Record<PlaneRoute, unknown>> = {};
  if (!isRecord(raw) || !isRecord(raw.providers)) {
    return out;
  }
  for (const plane of PLANE_ROUTES) {
    if (Object.hasOwn(raw.providers, plane)) {
      out[plane] = raw.providers[plane];
    }
  }
  return out;
};

/** The provider builder: pi's `createProvider` over the four protocols. */
export type PlaneProviderBuilder = (input: {
  readonly id: PlaneRoute;
  readonly name: string;
  readonly models: readonly Readonly<Record<string, unknown>>[];
  /**
   * The served ids the catalog describes by Google thinking level
   * ({@link usesCatalogThinkingLevels}, D16); none when absent.
   */
  readonly levelThinkingModels?: ReadonlySet<string>;
}) => unknown;

/** What {@link planeProfileFor} takes. */
export interface PlaneProfileInput {
  readonly route: PlaneRoute;
  /** The raw entry, as the user's file holds it. */
  readonly entry: unknown;
  /** The loader's `interpolate`, bound to a context; absent without a loader. */
  readonly interpolate?: (value: unknown) => unknown;
  /** pi-ai's `Config` for one entry: `(entry) => Config({providers:{[route]: entry}})…[route]`. */
  readonly normalize?: (entry: unknown) => unknown;
  /** The plugin's catalog for the plane, servable or not. */
  readonly catalog: readonly PlaneCatalogSpec[];
  /** pi's installed models for the plane. */
  readonly piModels: readonly PlanePiModel[];
  readonly endpoint: EndpointChoice;
  readonly familyApi: Readonly<Record<string, string>>;
  /** dsh-llm's `resolveRetryPolicy`. */
  readonly resolveRetryPolicy: (policy: unknown, label: string) => unknown;
  readonly buildProvider: PlaneProviderBuilder;
}

/** What {@link planeProfileFor} answers. */
export interface PlaneProfileResult {
  /** The `ResolvedPiAiProviderProfile` the adapter reads. */
  readonly profile: Readonly<Record<string, unknown>> & {
    readonly provider: PlaneRoute;
    readonly displayName: string;
    readonly modelErrors: ReadonlyMap<string, string>;
    readonly configuredMaxTokens: ReadonlyMap<string, number>;
    readonly retryPolicy: unknown;
    readonly piProvider?: unknown;
    readonly catalogError?: string;
  };
  /** Per model, the effort display names the catalog decided (D1's "On"). */
  readonly effortNames: ReadonlyMap<string, Readonly<Record<string, string>>>;
  /** The interpolated, normalized entry, for the Settings graft; absent on a route failure before it. */
  readonly normalized?: Readonly<Record<string, unknown>>;
}

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** Whether a value holds an un-interpolated `{__jsExpr}` node anywhere. */
const holdsJsExpr = (value: unknown): boolean => {
  if (Array.isArray(value)) {
    return value.some(holdsJsExpr);
  }
  if (!isRecord(value)) {
    return false;
  }
  return "__jsExpr" in value || Object.values(value).some(holdsJsExpr);
};

/** pi-ai's route-level checks before any model resolves (`config.ts:370-465`). */
const checkRoute = (
  route: PlaneRoute,
  raw: Readonly<Record<string, unknown>>,
  source: Readonly<Record<string, unknown>>
): void => {
  const fail = (detail: string): never => {
    throw new Error(`llm-pi-ai: provider "${route}" ${detail}`);
  };
  if ("provider" in raw || "provider" in source) {
    fail('sets "provider", which moved to the providers dict key');
  }
  for (const side of [raw, source]) {
    if ("maxRetries" in side || "maxRetryDelayMs" in side) {
      fail(
        "sets maxRetries or maxRetryDelayMs, which were removed; compose agent recovery with dsh-llm-retry"
      );
    }
  }
  if (source.baseURL !== undefined && source.baseURL === "") {
    fail("has an empty baseURL");
  }
  if (source.displayName !== undefined && source.displayName === "") {
    fail("has an empty displayName");
  }
  const { headers } = source;
  if (headers !== undefined) {
    if (!isRecord(headers)) {
      return fail("headers must be a dict of strings");
    }
    for (const [name, value] of Object.entries(headers)) {
      try {
        Reflect.construct(Headers, [[[name, String(value)]]]);
      } catch {
        fail(
          `header "${name}" is not valid for Fetch; use a valid HTTP field name and a single-line value representable as bytes`
        );
      }
    }
  }
  const idle = source.streamIdleTimeoutMs ?? DEFAULTS.streamIdleTimeoutMs;
  if (
    typeof idle !== "number" ||
    !Number.isFinite(idle) ||
    idle <= 0 ||
    idle > MAX_TIMER_DELAY_MS
  ) {
    fail(
      `streamIdleTimeoutMs must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`
    );
  }
  const image = source.maxRequestImageBytes ?? DEFAULTS.maxRequestImageBytes;
  if (typeof image !== "number" || !Number.isInteger(image) || image <= 0) {
    fail("maxRequestImageBytes must be a positive integer");
  }
  for (const [key, fallback] of [
    ["requestImagePixelBudget", DEFAULTS.requestImagePixelBudget],
    ["requestImageMaxBytes", DEFAULTS.requestImageMaxBytes],
  ] as const) {
    const value = source[key] ?? fallback;
    if (
      typeof value !== "number" ||
      !Number.isSafeInteger(value) ||
      value <= 0
    ) {
      fail(`${key} must be a positive safe integer`);
    }
  }
  if (Array.isArray(source.defaultInput) && source.defaultInput.length === 0) {
    fail("defaultInput must name at least one modality");
  }
  if (
    source.apiKeyEnv !== undefined &&
    (typeof source.apiKeyEnv !== "string" ||
      !REF_PATTERN.test(source.apiKeyEnv))
  ) {
    fail(
      `apiKeyEnv: credential ref ${JSON.stringify(source.apiKeyEnv)} must match ${String(REF_PATTERN)}`
    );
  }
  if (source.models !== undefined && !Array.isArray(source.models)) {
    fail("models must be a list of model entries");
  }
};

/** pi-ai's compat vocabulary check (`catalog.ts:566-599`). */
const compatVocabularyError = (
  route: PlaneRoute,
  site: string,
  compat: unknown
): string | undefined => {
  if (compat === undefined) {
    return undefined;
  }
  if (!isRecord(compat)) {
    return `llm-pi-ai: provider "${route}" ${site} compat must be a dict`;
  }
  for (const [field, value] of Object.entries(compat)) {
    if (compatProtocols(field).length === 0) {
      return isGatedCompatField(field)
        ? `llm-pi-ai: provider "${route}" ${site} sets compat "${field}", which is not configurable here: pi-ai's installed catalog sets it for the vendors that need it, so name that provider as the route instead`
        : `llm-pi-ai: provider "${route}" ${site} sets compat "${field}", which no wire protocol declares; the configurable switches are ${allOfferedCompatFields().join(", ")}`;
    }
    if (value === null || value === undefined) {
      return `llm-pi-ai: provider "${route}" ${site} sets compat "${field}" with no value; give it one, or remove the key to leave the field to the next layer — the installed catalog entry, then pi-ai's own detection`;
    }
  }
  return undefined;
};

/** A compat dict's fields that carry a value (an empty dict states nothing). */
const setCompatFields = (compat: unknown): string[] =>
  isRecord(compat)
    ? Object.entries(compat)
        .filter(
          ([, value]) => !(isRecord(value) && Object.keys(value).length === 0)
        )
        .map(([field]) => field)
    : [];

/**
 * The served Google ids whose catalog spec describes thinking by level (D16):
 * the protocol and the levels both come from the catalog, never the id.
 */
const levelThinkingModelsOf = (
  served: readonly Readonly<Record<string, unknown>>[],
  catalog: readonly PlaneCatalogSpec[]
): ReadonlySet<string> => {
  const specs = new Map(catalog.map((spec) => [spec.id, spec]));
  const ids = new Set<string>();
  for (const model of served) {
    const spec = specs.get(String(model.id));
    if (
      model.api === "google-generative-ai" &&
      spec !== undefined &&
      usesCatalogThinkingLevels(spec)
    ) {
      ids.add(spec.id);
    }
  }
  return ids;
};

const numberOr = (value: unknown, fallback: number): number =>
  typeof value === "number" ? value : fallback;

/**
 * The resolved profile of one plane. Never throws.
 *
 * @param input - the raw entry and the host pieces.
 * @returns the profile, the effort names, and the normalized entry.
 */
export const planeProfileFor = (
  input: PlaneProfileInput
): PlaneProfileResult => {
  const { route } = input;
  const modelErrors = new Map<string, string>();
  const configuredMaxTokens = new Map<string, number>();
  const effortNames = new Map<string, Readonly<Record<string, string>>>();
  let routeError: string | undefined;
  let source: Record<string, unknown> = {};
  let normalized: Record<string, unknown> | undefined;
  try {
    let raw: unknown = input.entry;
    if (input.interpolate !== undefined) {
      raw = input.interpolate(raw);
    }
    if (!isRecord(raw)) {
      throw new Error(
        `llm-pi-ai: provider "${route}" profile must be a dict of settings`
      );
    }
    // A `{__jsExpr}` node nothing interpolated is an error of the model that
    // holds it, so the rest of the route still serves; one at route level
    // fails the route.
    const kept: Record<string, unknown> = { ...raw };
    if (Array.isArray(raw.models)) {
      kept.models = raw.models.filter((model: unknown) => {
        if (!holdsJsExpr(model)) {
          return true;
        }
        const id = isRecord(model) ? model.id : undefined;
        modelErrors.set(
          typeof id === "string" ? id : "",
          `llm-pi-ai: provider "${route}" model "${String(id)}" holds a !!js expression no loader interpolated`
        );
        return false;
      });
    }
    if (holdsJsExpr({ ...kept, models: undefined })) {
      throw new Error(
        `llm-pi-ai: provider "${route}" holds a !!js expression no loader interpolated`
      );
    }
    const normal = input.normalize === undefined ? kept : input.normalize(kept);
    if (!isRecord(normal)) {
      throw new Error(
        `llm-pi-ai: provider "${route}" profile must be a dict of settings`
      );
    }
    source = normal;
    normalized = normal;
    checkRoute(route, kept, source);
  } catch (error) {
    routeError = errorText(error);
  }

  let retryPolicy: unknown;
  try {
    retryPolicy = input.resolveRetryPolicy(
      source.retryPolicy,
      `llm-pi-ai: provider "${route}" retryPolicy`
    );
  } catch (error) {
    routeError ??= errorText(error);
    retryPolicy = input.resolveRetryPolicy(
      undefined,
      `llm-pi-ai: provider "${route}" retryPolicy`
    );
  }

  const displayName =
    typeof source.displayName === "string" && source.displayName.length > 0
      ? source.displayName
      : route;
  const models: Readonly<Record<string, unknown>>[] = [];
  if (routeError === undefined) {
    try {
      models.push(
        ...resolveModels(
          input,
          source,
          modelErrors,
          configuredMaxTokens,
          effortNames
        )
      );
    } catch (error) {
      routeError = errorText(error);
    }
  }

  let piProvider: unknown;
  if (routeError === undefined) {
    try {
      const served = models.filter(
        (model) => !modelErrors.has(String(model.id))
      );
      piProvider = input.buildProvider({
        id: route,
        levelThinkingModels: levelThinkingModelsOf(served, input.catalog),
        models: served,
        name: displayName,
      });
    } catch (error) {
      routeError = errorText(error);
    }
  }
  const catalogError: string | undefined =
    modelErrors.values().next().value ?? routeError;

  const {
    apiKeyEnv,
    retryPolicy: _retry,
    models: _models,
    displayName: _display,
    ...rest
  } = source;
  return {
    effortNames,
    ...(normalized === undefined ? {} : { normalized }),
    profile: {
      ...rest,
      provider: route,
      displayName,
      ...(typeof apiKeyEnv === "string" && REF_PATTERN.test(apiKeyEnv)
        ? { apiKeyEnv }
        : {}),
      streamIdleTimeoutMs: numberOr(
        source.streamIdleTimeoutMs,
        DEFAULTS.streamIdleTimeoutMs
      ),
      maxRequestImageBytes: numberOr(
        source.maxRequestImageBytes,
        DEFAULTS.maxRequestImageBytes
      ),
      requestImagePixelBudget: numberOr(
        source.requestImagePixelBudget,
        DEFAULTS.requestImagePixelBudget
      ),
      requestImageMaxBytes: numberOr(
        source.requestImageMaxBytes,
        DEFAULTS.requestImageMaxBytes
      ),
      retryPolicy,
      ...(isRecord(rest.headers) ? { headers: { ...rest.headers } } : {}),
      ...(isRecord(rest.thinkingBudgets)
        ? { thinkingBudgets: { ...rest.thinkingBudgets } }
        : {}),
      configuredMaxTokens,
      modelErrors,
      ...(piProvider === undefined ? {} : { piProvider }),
      ...(catalogError === undefined ? {} : { catalogError }),
    },
  };
};

/**
 * Every model the route serves, as pi-ai's `resolveRouteModels` materializes
 * them (`catalog.ts:780-950`), with {@link planeModelFor} in place of pi-ai's
 * per-model resolution. Model failures go to `modelErrors`; a route failure
 * throws, and the caller records the message as the route's failure.
 */
const resolveModels = (
  input: PlaneProfileInput,
  source: Readonly<Record<string, unknown>>,
  modelErrors: Map<string, string>,
  configuredMaxTokens: Map<string, number>,
  effortNames: Map<string, Readonly<Record<string, string>>>
): Readonly<Record<string, unknown>>[] => {
  const { route } = input;
  const fail = (detail: string): never => {
    throw new Error(`llm-pi-ai: provider "${route}" ${detail}`);
  };
  const specs = new Map(input.catalog.map((spec) => [spec.id, spec]));
  const pis = new Map(input.piModels.map((model) => [model.id, model]));
  const configured = Array.isArray(source.models) ? source.models : [];
  const overrides = isRecord(source.modelOverrides)
    ? source.modelOverrides
    : {};
  for (const [id, override] of Object.entries(overrides)) {
    if (id.length === 0) {
      fail("has a modelOverrides entry with an empty model id");
    }
    if (configured.length > 0) {
      fail(
        `sets modelOverrides for "${id}" beside a models list; models already replaces the served catalog, so declare the fields on its entries`
      );
    }
    if (!specs.has(id) && !pis.has(id)) {
      modelErrors.set(
        id,
        `llm-pi-ai: provider "${route}" modelOverrides names "${id}", which the installed catalog does not describe`
      );
    }
    if (isRecord(override) && "id" in override) {
      fail(`modelOverrides entry "${id}" sets "id", which is the dict key`);
    }
  }
  // D3: no models list serves the plugin's servable catalog for the plane.
  const entries: unknown[] =
    configured.length > 0
      ? configured
      : input.catalog
          .filter((spec) => isServableSdk(spec.provider_npm))
          .map((spec) => ({ id: spec.id }));
  if (entries.length === 0) {
    fail(
      "resolves no models; the installed catalog does not describe this route, so its models must be listed in configuration"
    );
  }
  const routeCompatError = compatVocabularyError(route, "route", source.compat);
  if (routeCompatError !== undefined) {
    throw new Error(routeCompatError);
  }
  const routeCompat = isRecord(source.compat) ? source.compat : undefined;
  const seen = new Set<string>();
  const models: Readonly<Record<string, unknown>>[] = [];
  const defaults = {
    contextWindow: numberOr(
      source.defaultContextWindow,
      DEFAULTS.contextWindow
    ),
    input: Array.isArray(source.defaultInput)
      ? source.defaultInput.filter(
          (item): item is string => typeof item === "string"
        )
      : [...DEFAULTS.input],
    maxTokens: numberOr(source.defaultMaxTokens, DEFAULTS.maxTokens),
  };
  for (const candidate of entries) {
    const entry: PlaneModelEntry = isRecord(candidate) ? candidate : {};
    const id = typeof entry.id === "string" ? entry.id : undefined;
    const key = id ?? "";
    const modelFail = (message: string): void => {
      modelErrors.set(key, message);
    };
    const vocabulary = compatVocabularyError(
      route,
      `model "${String(entry.id)}"`,
      entry.compat
    );
    if (vocabulary !== undefined) {
      modelFail(vocabulary);
      continue;
    }
    if (id === "") {
      modelFail(`llm-pi-ai: provider "${route}" has a model with an empty id`);
      continue;
    }
    if (id !== undefined && seen.has(id)) {
      modelFail(
        `llm-pi-ai: provider "${route}" lists model "${id}" more than once`
      );
      continue;
    }
    if (id !== undefined) {
      seen.add(id);
    }
    const override =
      configured.length === 0 && id !== undefined && isRecord(overrides[id])
        ? (overrides[id] as PlaneModelEntry)
        : undefined;
    const resolved = planeModelFor({
      defaults,
      endpoint: input.endpoint,
      entry,
      familyApi: input.familyApi,
      route,
      ...(override === undefined ? {} : { override }),
      ...(id === undefined || !pis.has(id) ? {} : { pi: pis.get(id) }),
      ...(id === undefined || !specs.has(id) ? {} : { spec: specs.get(id) }),
      ...(typeof source.api === "string" ? { routeApi: source.api } : {}),
      ...(typeof source.baseURL === "string"
        ? { routeBaseURL: source.baseURL }
        : {}),
      ...(routeCompat === undefined ? {} : { routeCompat }),
    });
    if (resolved.error !== undefined) {
      modelFail(resolved.error);
      continue;
    }
    const served = resolved.model.id;
    if (resolved.configuredMaxTokens !== undefined) {
      configuredMaxTokens.set(served, resolved.configuredMaxTokens);
    }
    if (resolved.effortNames !== undefined) {
      effortNames.set(served, resolved.effortNames);
    }
    models.push(resolved.model);
  }
  const serviceable = models.filter(
    (model) => !modelErrors.has(String(model.id))
  );
  for (const field of setCompatFields(routeCompat)) {
    const takers = compatProtocols(field);
    if (!serviceable.some((model) => takers.includes(String(model.api)))) {
      fail(
        `sets compat "${field}", but no model on the route speaks a protocol that takes it; it exists on ${takers.join(", ")}`
      );
    }
  }
  return models;
};
