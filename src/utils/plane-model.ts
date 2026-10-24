/**
 * One plane model's pi object, from the sources that describe it, in one
 * precedence (docs/improvement-plan.md, "The design").
 *
 * | field | first source that has it |
 * | :-- | :-- |
 * | protocol | the catalog SDK ({@link protocolForSdk}) > pi's entry > the route's `api` > completions (D16) |
 * | name, context, max tokens, modalities | the user's row > pi-ai's `modelOverrides` > catalog > pi > defaults (D17) |
 * | cost | catalog > pi > zero |
 * | reasoning | the user's `reasoningEfforts` > the override's > the catalog ({@link reasoningFor}, D1) > pi > none |
 * | baseUrl | the route's `baseURL`, shaped > the endpoint family ({@link baseUrlFor}) |
 *
 * A route-level `api` never reclassifies an id the catalog or pi describes:
 * the plane serves every protocol at once, so the route's `api` only says what
 * an id nobody describes speaks.
 *
 * Pure: the catalog spec, pi's entry and the family map come in as values, and
 * nothing here throws — a malformed row comes back as `error`, in pi-ai's
 * words, for the profile to record against the model.
 *
 * @module dsh-opencode-patch/utils/plane-model
 */

import { isRecord } from "./guards.ts";
import {
  piReasoningFromEfforts,
  reasoningFor,
  type ReasoningSpec,
} from "./model-metadata.ts";
import {
  compatProtocols,
  FAMILY_SDK_KEY,
  isProtocol,
  LEGACY_BASE,
  MODERN_FALLBACK,
  OFFERED_COMPAT,
  type PlaneRoute,
  type Protocol,
  protocolForSdk,
} from "./protocols.ts";

/** The endpoint family a plane sends to; `auto` is `modern`. */
export type EndpointChoice = "auto" | "legacy" | "modern";

/** The catalog spec fields this module reads (`CatalogModelSpec`'s shape). */
export interface PlaneCatalogSpec extends ReasoningSpec {
  readonly id: string;
  readonly name?: string;
  readonly context_window?: number;
  readonly max_output_tokens?: number;
  readonly input_modalities?: readonly string[];
  readonly provider_npm?: string;
  readonly cost?: {
    readonly input?: number;
    readonly output?: number;
    readonly cache_read?: number;
    readonly cache_write?: number;
  };
}

/** pi's installed model, as far as this module reads it; the rest is spread. */
export interface PlanePiModel {
  readonly id: string;
  readonly api?: string;
  readonly baseUrl?: string;
  readonly name?: string;
  readonly contextWindow?: number;
  readonly maxTokens?: number;
  readonly input?: readonly string[];
  readonly reasoning?: boolean;
  readonly thinkingLevelMap?: Readonly<Record<string, string | null>>;
  readonly compat?: Readonly<Record<string, unknown>>;
  readonly cost?: Readonly<Record<string, number>>;
  readonly [key: string]: unknown;
}

/** One `models` entry or `modelOverrides` value, after pi-ai's `Config`. */
export interface PlaneModelEntry {
  readonly id?: unknown;
  readonly name?: unknown;
  readonly contextWindow?: unknown;
  readonly maxTokens?: unknown;
  readonly input?: unknown;
  readonly reasoningEfforts?: unknown;
  readonly compat?: unknown;
}

/** What {@link planeModelFor} takes. */
export interface PlaneModelInput {
  readonly route: PlaneRoute;
  readonly entry: PlaneModelEntry;
  readonly override?: PlaneModelEntry;
  readonly spec?: PlaneCatalogSpec;
  readonly pi?: PlanePiModel;
  readonly routeApi?: string;
  readonly routeBaseURL?: string;
  readonly routeCompat?: Readonly<Record<string, unknown>>;
  readonly endpoint: EndpointChoice;
  /** The catalog's family map for this plane (`OPENCODE_FAMILY_API.zen|go`). */
  readonly familyApi: Readonly<Record<string, string>>;
  readonly defaults: {
    readonly contextWindow: number;
    readonly maxTokens: number;
    readonly input: readonly string[];
  };
}

/** A model {@link planeModelFor} could build. */
export interface PlaneModelServed {
  /** The pi model object. */
  readonly model: Readonly<Record<string, unknown>> & {
    readonly id: string;
    readonly api: Protocol;
    readonly baseUrl: string;
  };
  /** Set only when the user's row or override names `maxTokens`. */
  readonly configuredMaxTokens?: number;
  /** Display names for the efforts, when the catalog decided them. */
  readonly effortNames?: Readonly<Record<string, string>>;
  readonly error?: undefined;
}

/** What {@link planeModelFor} answers: the model, or pi-ai's message for a row it cannot serve. */
export type PlaneModelResult =
  | PlaneModelServed
  | {
      readonly error: string;
      readonly model?: undefined;
      readonly configuredMaxTokens?: undefined;
      readonly effortNames?: undefined;
    };

const NO_COST = { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 };

/** The modalities a model may declare. */
const MODALITIES: ReadonlySet<string> = new Set(["text", "image"]);

/** A declared modality list, or `undefined` when it states none. */
const declaredInput = (value: unknown): string[] | undefined =>
  Array.isArray(value) && value.length > 0
    ? value.filter((item): item is string => typeof item === "string")
    : undefined;

/** The catalog's modalities, narrowed to what a request can carry. */
const catalogInput = (spec: PlaneCatalogSpec): string[] | undefined => {
  const input = spec.input_modalities?.filter((item) => MODALITIES.has(item));
  return input === undefined || input.length === 0 ? undefined : input;
};

const isWholePositive = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value > 0;

/** The opencode.ai path of a URL, or `undefined` for another host. */
const vendorPathOf = (url: string): string | undefined => {
  try {
    const parsed = new URL(url);
    return parsed.hostname === "opencode.ai" ? parsed.pathname : undefined;
  } catch {
    return undefined;
  }
};

const trimSlashes = (url: string): string => url.replace(/\/+$/u, "");

/** The Anthropic SDK appends `/v1/messages`, so its base drops a trailing `/v1`. */
const forProtocol = (protocol: Protocol, base: string): string =>
  protocol === "anthropic-messages" ? base.replace(/\/v1$/u, "") : base;

/**
 * The base one model's requests go to.
 *
 * 1. A route-level `baseURL` on opencode.ai selects a family: a `/zen…` path
 *    the legacy one, `/inference(/go)(/openai)/v1` the modern one.
 * 2. Any other route-level `baseURL` is the user's endpoint, used as written
 *    (trailing slashes trimmed, and a trailing `/v1` dropped for Anthropic).
 * 3. Otherwise the `endpoint` choice; `auto` is `modern`.
 * 4. Modern: the catalog's family map for the model's SDK, else for the
 *    protocol's family, else the measured fallback.
 * 5. Legacy: pi's own base when pi files the model under this protocol on a
 *    `/zen` root, else the fixed table — Go's Google cell included.
 *
 * @returns the base URL.
 */
export const baseUrlFor = (
  route: PlaneRoute,
  protocol: Protocol,
  sdk: string | undefined,
  endpoint: EndpointChoice,
  familyApi: Readonly<Record<string, string>>,
  routeBaseURL?: string,
  pi?: PlanePiModel
): string => {
  let family: "legacy" | "modern" = endpoint === "legacy" ? "legacy" : "modern";
  if (routeBaseURL !== undefined && routeBaseURL.length > 0) {
    const path = vendorPathOf(routeBaseURL);
    if (path?.startsWith("/zen") === true) {
      family = "legacy";
    } else if (
      path !== undefined &&
      /^\/inference(?:\/go)?(?:\/openai)?\/v1\/?$/u.test(path)
    ) {
      family = "modern";
    } else {
      return forProtocol(protocol, trimSlashes(routeBaseURL));
    }
  }
  if (family === "legacy") {
    const piPath =
      pi?.api === protocol && typeof pi.baseUrl === "string"
        ? vendorPathOf(pi.baseUrl)
        : undefined;
    return piPath?.startsWith("/zen") === true && pi?.baseUrl !== undefined
      ? pi.baseUrl
      : LEGACY_BASE[route][protocol];
  }
  const declared =
    (sdk === undefined ? undefined : familyApi[sdk]) ??
    familyApi[FAMILY_SDK_KEY[protocol]] ??
    MODERN_FALLBACK[route][protocol];
  return forProtocol(protocol, declared);
};

/** The compat entries a block actually set: an empty dict states nothing. */
const configuredCompat = (compat: unknown): [string, unknown][] =>
  isRecord(compat)
    ? Object.entries(compat).filter(
        ([, value]) => !(isRecord(value) && Object.keys(value).length === 0)
      )
    : [];

/**
 * The compat block, as pi-ai's `resolveModelCompat` builds it
 * (`catalog.ts:738-771`): route switches the protocol takes, then the model's
 * own (one the protocol does not take is an error), over pi's entry when pi
 * files the model under the same protocol.
 */
const compatFor = (
  route: string,
  id: string,
  protocol: Protocol,
  entryCompat: unknown,
  routeCompat: unknown,
  pi: PlanePiModel | undefined
): { compat?: Readonly<Record<string, unknown>>; error?: string } => {
  const offered = OFFERED_COMPAT[protocol];
  const configured: Record<string, unknown> = {};
  for (const [field, value] of configuredCompat(routeCompat)) {
    if (offered.has(field)) {
      configured[field] = value;
    }
  }
  for (const [field, value] of configuredCompat(entryCompat)) {
    if (!offered.has(field)) {
      const fields = [...offered];
      return {
        error: `llm-pi-ai: provider "${route}" model "${id}" sets compat "${field}", but its api is "${protocol}", which does not take it; that switch exists on ${compatProtocols(field).join(", ")}, and "${protocol}" offers ${fields.length === 0 ? "no configurable compat" : fields.join(", ")}`,
      };
    }
    configured[field] = value;
  }
  const inherited = pi?.api === protocol ? pi.compat : undefined;
  if (Object.keys(configured).length === 0) {
    return inherited === undefined ? {} : { compat: inherited };
  }
  return { compat: { ...inherited, ...configured } };
};

/**
 * A declared `reasoningEfforts`, as `piReasoningFromEfforts` reads it: `false`,
 * a dict of wire values (anything else in it is no value), or `null` for a
 * value that is neither — which pi-ai reports as an empty declaration.
 */
const effortsDictOf = (
  value: unknown
): Readonly<Record<string, string | null>> | false | null => {
  if (value === false) {
    return false;
  }
  if (!isRecord(value)) {
    return null;
  }
  const dict: Record<string, string | null> = {};
  for (const [level, wire] of Object.entries(value)) {
    if (typeof wire === "string" || wire === null) {
      dict[level] = wire;
    }
  }
  return dict;
};

/** The protocol an id speaks (D16). */
const protocolOf = (
  spec: PlaneCatalogSpec | undefined,
  pi: PlanePiModel | undefined,
  routeApi: string | undefined
): Protocol => {
  const fromCatalog =
    spec === undefined ? undefined : protocolForSdk(spec.provider_npm);
  if (fromCatalog !== undefined) {
    return fromCatalog;
  }
  if (isProtocol(pi?.api)) {
    return pi.api;
  }
  if (spec === undefined && pi === undefined && isProtocol(routeApi)) {
    return routeApi;
  }
  return "openai-completions";
};

/**
 * The pi model one plane serves for one entry. Never throws.
 *
 * @param input - the entry, its sources and the route's settings.
 * @returns the model, or the error pi-ai would record against it.
 */
export const planeModelFor = (input: PlaneModelInput): PlaneModelResult => {
  const { entry, override, pi, route, spec } = input;
  if (typeof entry.id !== "string") {
    return {
      error: `llm-pi-ai: provider "${route}" has a model whose id is not a string`,
    };
  }
  const { id } = entry;
  const fail = (detail: string): PlaneModelResult => ({
    error: `llm-pi-ai: provider "${route}" model "${id}" ${detail}`,
  });
  const protocol = protocolOf(spec, pi, input.routeApi);
  const compat = compatFor(
    route,
    id,
    protocol,
    entry.compat,
    input.routeCompat,
    pi
  );
  if (compat.error !== undefined) {
    return { error: compat.error };
  }

  const contextWindow =
    entry.contextWindow ??
    override?.contextWindow ??
    spec?.context_window ??
    pi?.contextWindow ??
    input.defaults.contextWindow;
  if (!isWholePositive(contextWindow)) {
    return fail("contextWindow must be a positive integer");
  }
  const maxTokens =
    entry.maxTokens ??
    override?.maxTokens ??
    spec?.max_output_tokens ??
    pi?.maxTokens ??
    input.defaults.maxTokens;
  if (!isWholePositive(maxTokens)) {
    return fail("maxTokens must be a positive integer");
  }
  const configuredMaxTokens = entry.maxTokens ?? override?.maxTokens;

  // Reasoning: the user's dict, the override's, the catalog's, pi's, none.
  const declaredEfforts =
    entry.reasoningEfforts === undefined
      ? override?.reasoningEfforts
      : entry.reasoningEfforts;
  let reasoning: boolean;
  let thinkingLevelMap: Readonly<Record<string, string | null>> | undefined;
  let effortNames: Readonly<Record<string, string>> | undefined;
  if (declaredEfforts === undefined) {
    const fromCatalog =
      spec === undefined
        ? undefined
        : reasoningFor(spec, protocol, compat.compat);
    if (fromCatalog !== undefined) {
      reasoning = true;
      ({ thinkingLevelMap, effortNames } = fromCatalog);
    } else if (spec === undefined && pi?.reasoning === true) {
      reasoning = true;
      ({ thinkingLevelMap } = pi);
    } else {
      reasoning = false;
    }
  } else {
    const declared = piReasoningFromEfforts(
      id,
      route,
      effortsDictOf(declaredEfforts)
    );
    if ("error" in declared) {
      return { error: declared.error };
    }
    ({ reasoning, thinkingLevelMap } = declared);
  }

  const {
    compat: _piCompat,
    thinkingLevelMap: _piMap,
    ...piRest
  } = pi ?? { id };
  const name =
    [entry.name, override?.name, spec?.name, pi?.name].find(
      (candidate): candidate is string => typeof candidate === "string"
    ) ?? id;
  const model = {
    ...piRest,
    api: protocol,
    baseUrl: baseUrlFor(
      route,
      protocol,
      spec?.provider_npm,
      input.endpoint,
      input.familyApi,
      input.routeBaseURL,
      pi
    ),
    contextWindow,
    cost:
      spec?.cost === undefined
        ? (pi?.cost ?? NO_COST)
        : {
            cacheRead: spec.cost.cache_read ?? 0,
            cacheWrite: spec.cost.cache_write ?? 0,
            input: spec.cost.input ?? 0,
            output: spec.cost.output ?? 0,
          },
    id,
    input: declaredInput(entry.input) ??
      declaredInput(override?.input) ??
      (spec === undefined ? undefined : catalogInput(spec)) ??
      declaredInput(pi?.input) ?? [...input.defaults.input],
    maxTokens,
    name,
    provider: route,
    reasoning,
    ...(thinkingLevelMap === undefined ? {} : { thinkingLevelMap }),
    ...(compat.compat === undefined ? {} : { compat: compat.compat }),
  };
  return {
    model,
    ...(isWholePositive(configuredMaxTokens) ? { configuredMaxTokens } : {}),
    ...(effortNames === undefined ? {} : { effortNames }),
  };
};
