/**
 * Build pi-ai providers for the gateway's two planes, from our own catalog.
 *
 * The plugin mounts its routes through `dsh-llm-pi-ai`, which builds a
 * hand-declared route from a three-entry protocol table. That table is why
 * `@ai-sdk/google` could not be served: `google-generative-ai` is implemented
 * by pi-ai but is not one of the three names a route may declare. This module
 * builds the provider directly instead, so every protocol pi implements is
 * reachable and the routing decision moves to each model's `api` field.
 *
 * Two measured facts shape it, neither derivable from the protocol name:
 *
 * - **The base URL is per protocol, not per plane.** The Anthropic SDK appends
 *   its own `/v1/messages`, so its base is one level shorter than the others.
 *   Read off pi's own `opencode` provider, which records it per model.
 * - **The session header must be set on the request.** pi ships its own, but it
 *   defers when the header is already present, so wrapping each `api` here puts
 *   ours on every protocol and leaves pi's a no-op.
 *
 * pi-ai is injected rather than imported: the plugin must not bundle a second
 * copy of it, and the caller is the only place that knows how to reach the one
 * the host already loaded.
 *
 * @module dsh-opencode-patch/pi-provider
 */

import type { CatalogModelSpec } from "./catalog-data.ts";
import { OPENCODE_FAMILY_API, OPENCODE_PLANE_API } from "./catalog-data.ts";
import type { EndpointFamily } from "./config-values.ts";
import {
  ANTHROPIC_SDK,
  GOOGLE_SDK,
  RESPONSES_SDK,
} from "./responses-routes.ts";

/** The gateway plane a provider serves. */
export type Plane = "opencode" | "opencode-go";

/**
 * The base URL each protocol uses on each plane.
 *
 * Read from pi-ai's own `opencode` and `opencode-go` providers rather than
 * inferred: the Anthropic entry is deliberately one level shorter because that
 * SDK appends `/v1/messages` itself.
 */
/**
 * The endpoint each protocol's requests go to, per plane.
 *
 * The base comes from the catalog - the field the client itself consumes
 * (`models-dev.ts:107` lifts the provider's `api` into `settings.baseURL`), and
 * which the shim now carries as `OPENCODE_PLANE_API`. It was hard-coded here
 * instead, and when the vendor moved `models.dev`'s provider entry to
 * the `inference` family the constant was left on `…/zen/v1`: a deployment
 * would have kept using the older endpoint while its own catalog named the
 * newer one.
 *
 * The Anthropic path differs from the others by design (`/messages` not `/chat/
 * completions`), so only the suffix changes, and the suffix is per protocol
 * rather than per model.
 */
const PLANE_BASE: Readonly<Record<Plane, string>> = {
  opencode: OPENCODE_PLANE_API.zen,
  "opencode-go": OPENCODE_PLANE_API.go,
};

/**
 * The older endpoint each plane's requests used to go to.
 *
 * Still served — measured — and the reason an endpoint choice exists at all:
 * the catalog moved to the `inference` family, but a deployment whose account is
 * only entitled on the older one needs `/zen/v1` and no catalog change will say
 * so. `responses-routes.ts`'s `PLANES` is this table, kept as the declared name
 * so the two cannot drift.
 */
export const LEGACY_PLANE_API: Readonly<Record<Plane, string>> = {
  opencode: "https://opencode.ai/zen/v1",
  "opencode-go": "https://opencode.ai/zen/go/v1",
};

/**
 * The base URL one plane's requests go to under one endpoint family.
 *
 * `auto` is the catalog's own value, so following the vendor costs nothing here;
 * `legacy` and `modern` pin the family explicitly. The two families are
 * independently entitled, which is why a user can choose rather than being
 * carried along by whatever the catalog happens to name.
 *
 * @param plane - the gateway plane.
 * @param family - the endpoint family to resolve.
 * @returns that plane's base URL.
 */
export const planeBaseFor = (plane: Plane, family: EndpointFamily): string => {
  if (family === "legacy") {
    return LEGACY_PLANE_API[plane];
  }
  return family === "modern"
    ? OPENCODE_PLANE_API[plane === "opencode-go" ? "go" : "zen"]
    : PLANE_BASE[plane];
};

/**
 * The protocol's path on its family's base, or `null` when the SDK wants the base
 * without its version segment.
 *
 * A family's `api` is the base INCLUDING the version segment - `…/openai/v1`,
 * `…/anthropic/v1`, `…/google/v1beta` - so the versioned protocols are the base
 * with nothing added, and the Anthropic endpoint (`/messages`) is the base
 * without that segment: pi-ai's SDK appends `/v1/messages` itself.
 */
const PROTOCOL_SUFFIX: Readonly<Record<string, string | null>> = {
  "anthropic-messages": null,
  "google-generative-ai": "",
  "openai-completions": "",
  "openai-responses": "",
};

/** The wire family a protocol belongs to. Each family has its own base. */
type WireFamily = "anthropic" | "google" | "openai";

const FAMILY_OF_PROTOCOL: Readonly<Record<string, WireFamily>> = {
  "anthropic-messages": "anthropic",
  "google-generative-ai": "google",
  "openai-completions": "openai",
  "openai-responses": "openai",
};

/**
 * The inference family's base, per plane and per wire family — the FALLBACK.
 *
 * **Measured from the vendor's own `GET /console/api/config`, not derived.** The
 * gateway does not serve one base per plane with the protocol appended: each
 * family lives at its own path, and the vendor's client hands the SDK exactly
 * the `api` its config reports for that model.
 *
 * Deriving these by stripping `/v1` off one plane URL - which is what this
 * module used to do - sent every Anthropic model to `…/inference/openai` and
 * every Google model to `…/inference/openai/v1`. Measured on the live config:
 * `opencode` declares `…/inference/anthropic/v1` for 18 models and
 * `…/inference/google/v1beta` for 8; `opencode-go` declares the `go/` variants
 * for 5 and 1. Thirty-two models, reachable only through their own family.
 *
 * The legacy (`…/zen/v1`) family genuinely IS one base for every protocol, which
 * is why it keeps the old derivation.
 */
/**
 * The SDK package each wire family is named by in the catalog.
 *
 * `""` is the provider default — the completions family names no package at all,
 * so it is looked up under the empty key first and under `@ai-sdk/openai` (the
 * same endpoint, declared for the Responses models) second.
 */
const FAMILY_PACKAGES: Readonly<Record<WireFamily, readonly string[]>> = {
  anthropic: ["@ai-sdk/anthropic"],
  google: ["@ai-sdk/google"],
  openai: ["", "@ai-sdk/openai"],
};

/**
 * A family's endpoint as the CATALOG declares it, or `undefined` when the
 * generated map does not name that package yet.
 *
 * @param plane - the gateway plane.
 * @param family - the wire family.
 * @returns the declared endpoint, when there is one.
 */
const declaredFamilyBase = (
  plane: Plane,
  family: WireFamily
): string | undefined => {
  // The generated map is keyed by the catalog's plane names, not the route names.
  const declared = OPENCODE_FAMILY_API[plane === "opencode-go" ? "go" : "zen"];
  for (const pkg of FAMILY_PACKAGES[family]) {
    const api = declared[pkg];
    if (typeof api === "string" && api.length > 0) {
      return api;
    }
  }
  return undefined;
};

const INFERENCE_BASE: Readonly<
  Record<Plane, Readonly<Record<WireFamily, string>>>
> = {
  opencode: {
    anthropic: "https://opencode.ai/inference/anthropic/v1",
    google: "https://opencode.ai/inference/google/v1beta",
    openai: "https://opencode.ai/inference/openai/v1",
  },
  "opencode-go": {
    anthropic: "https://opencode.ai/inference/go/anthropic/v1",
    google: "https://opencode.ai/inference/go/google/v1beta",
    openai: "https://opencode.ai/inference/go/openai/v1",
  },
};

/**
 * Every protocol on one plane under one endpoint family, sharing the base.
 *
 * Memoised per family: the table is rebuilt at most once per family per process,
 * and the map keys are exactly the accepted {@link EndpointFamily} values, so an
 * unknown family falls through to the catalog's own answer rather than to
 * `undefined`.
 */
const BASES_BY_FAMILY = new Map<EndpointFamily, BaseTable>();

const basesFor = (family: EndpointFamily): BaseTable => {
  const cached = BASES_BY_FAMILY.get(family);
  if (cached !== undefined) {
    return cached;
  }
  const table: BaseTable = {
    opencode: withPlaneBase("opencode", family),
    "opencode-go": withPlaneBase("opencode-go", family),
  };
  BASES_BY_FAMILY.set(family, table);
  return table;
};

/**
 * Every protocol on one plane and family, each on its own family's base.
 *
 * Legacy is one base for all four protocols; the inference family is not, and
 * pretending otherwise is the bug this encodes against.
 */
function withPlaneBase(
  plane: Plane,
  family: EndpointFamily
): Readonly<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [protocol, suffix] of Object.entries(PROTOCOL_SUFFIX)) {
    const wire = FAMILY_OF_PROTOCOL[protocol] ?? "openai";
    const base =
      family === "legacy"
        ? planeBaseFor(plane, "legacy")
        : // The catalog's own field, with the measured table as the fallback for a
          // shim generated before the map existed.
          (declaredFamilyBase(plane, wire) ?? INFERENCE_BASE[plane][wire]);
    out[protocol] =
      suffix === null ? base.replace(/\/v1$/, "") : `${base}${suffix}`;
  }
  return out;
}

/** One plane's protocol table, keyed by protocol. */
type BaseTable = Readonly<Record<Plane, Readonly<Record<string, string>>>>;

/**
 * The base URL each protocol uses on each plane, following the catalog.
 *
 * Kept as the default table for callers that name no family; read
 * {@link baseForProtocol} with an explicit family once one is known.
 */
export const BASE_FOR_PROTOCOL: BaseTable = basesFor("auto");

/**
 * The protocol each SDK names, for a provider built here.
 *
 * Deliberately NOT `PROTOCOL_FOR_SDK`: that table is the wrapper's, and it
 * lists only the protocols a hand-declared route may name. Building the
 * provider ourselves lifts that limit, so this table carries every protocol pi
 * implements that the gateway is measured to serve - which is four, and one
 * more than a route could ever name.
 *
 * `@ai-sdk/mistral` is absent on purpose. pi implements
 * `mistral-conversations`, but driving it at the gateway produces a request
 * whose URL this harness could not even observe, and the account has no
 * entitlement to test it against. It stays unserved until that is measured,
 * rather than being wired on the strength of a protocol existing.
 */
export const GATEWAY_PROTOCOL_FOR_SDK: Readonly<Record<string, string>> = {
  [RESPONSES_SDK]: "openai-responses",
  [ANTHROPIC_SDK]: "anthropic-messages",
  [GOOGLE_SDK]: "google-generative-ai",
};

/** The protocol a model speaks, or undefined when its SDK has no mapping. */
export const protocolFor = (spec: CatalogModelSpec): string | undefined =>
  spec.provider_npm === undefined
    ? "openai-completions"
    : GATEWAY_PROTOCOL_FOR_SDK[spec.provider_npm];

/** Whether a string names a plane this table carries. */
const isPlane = (value: string): value is Plane =>
  value === "opencode" || value === "opencode-go";

/**
 * The base URL one protocol of one plane is served from.
 *
 * The table is keyed by {@link Plane} so a missing plane is a type error where
 * the table is written. Callers walk a route table whose key is a plain string,
 * so they come through here: a plane the table does not carry has no base, and
 * saying so is better than indexing past the end of a record.
 *
 * @param plane - the gateway plane.
 * @param protocol - the protocol the request speaks.
 * @param family - the endpoint family; the catalog's own endpoint by default.
 * @returns the base URL, or undefined when the table does not carry that plane.
 */
export const baseForProtocol = (
  plane: string,
  protocol: string,
  family: EndpointFamily = "auto"
): string | undefined =>
  isPlane(plane) ? basesFor(family)[plane]?.[protocol] : undefined;

/**
 * The pi model object for one catalogued model.
 *
 * pi reads `api` to pick a protocol implementation and `baseUrl` to know where
 * to send it, so both have to be right per model. The cost field is pi's own
 * vocabulary: camelCase where the catalog is snake_case, and its rates are per
 * million tokens, which is what the catalog already carries.
 *
 * **The installed catalog entry is the floor, never the whole object.** Building
 * these models field by field drops everything pi knows that this module does
 * not model — the compatibility switches a Claude or Grok request needs, the
 * `reasoning` flag, the `thinkingLevelMap` that maps a thinking level onto the
 * wire's own spelling, the `inputLimits` that bound an image. The wrapper's own
 * model materialization spreads the catalog entry for the same reason, and says
 * so: enumerating would silently drop every field the package does not model.
 *
 * So the entry is spread first and only then overlaid, which also makes the
 * precedence deliberate: our catalog is fresher than the installed one for the
 * fields we set, and the installed one is the only source for the fields we do
 * not know about.
 *
 * @param plane - the gateway plane this model is served on.
 * @param spec - the catalogued model.
 * @param protocol - the protocol it speaks, from {@link protocolFor}.
 * @param base - pi's installed catalog entry for this id, when it has one.
 * @returns the model object pi's provider dispatches on.
 */
/**
 * The thinking levels a model accepts, as pi's map.
 *
 * pi's `ThinkingLevelMap` is `Partial<Record<ModelThinkingLevel, string | null>>`
 * — each of pi's levels mapped onto the spelling the model's own wire uses, with
 * `null` marking a level it does not take. The catalog says which levels a model
 * has and says nothing about the wire's spelling, so the mapping is the identity
 * where the two agree, and every level the catalog does not list is `null` rather
 * than absent: absent means "use the provider default", which would offer a level
 * the model refuses.
 *
 * Only the shapes the catalog actually uses are handled — `effort` with a value
 * list, and `toggle` for on/off. `budget_tokens` carries a minimum rather than a
 * list of levels, so it contributes no map: pi's token-budget field is a separate
 * mechanism and guessing one here would be worse than offering none.
 *
 * @param spec - the catalogued model.
 * @returns the map, or `undefined` when the model declares no levels.
 */
export const thinkingLevelMapFor = (
  spec: CatalogModelSpec
): Partial<Record<string, string | null>> | undefined => {
  if (spec.reasoning !== true) {
    return undefined;
  }
  const options = spec.reasoning_options ?? [];
  const levels = options.find(
    (option) => option.type === "effort" && (option.values?.length ?? 0) > 0
  )?.values;
  if (levels !== undefined) {
    // `off` is part of the map too, and `null` there means the model has no
    // off switch - which is what the installed catalog says for these models.
    const map: Record<string, string | null> = { off: null };
    for (const level of ALL_THINKING_LEVELS) {
      map[level] = levels.includes(level) ? level : null;
    }
    return map;
  }
  if (options.some((option) => option.type === "toggle")) {
    // On or off: every level is the same "on", and `off` is the model's own.
    const map: Record<string, string | null> = { off: null };
    for (const level of ALL_THINKING_LEVELS) {
      map[level] = "on";
    }
    return map;
  }
  // When a model declares reasoning: true without explicit reasoning_options
  // (e.g. minimax-m2.5, minimax-m2.7, or minimax-m3 on Zen), offer standard
  // thinking levels so DSH harness exposes the thinking controls.
  const map: Record<string, string | null> = { off: null };
  for (const level of ALL_THINKING_LEVELS) {
    map[level] = ["low", "medium", "high"].includes(level) ? level : null;
  }
  return map;
};

/** pi's levels, in its own order, so the map is complete rather than partial. */
const ALL_THINKING_LEVELS = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

/**
 * The pi model object for one catalogued model.
 *
 * pi reads `api` to pick a protocol implementation and `baseUrl` to know where
 * to send it, so both have to be right per model.
 *
 * @param plane - the gateway plane this model is served on.
 * @param spec - the catalogued model.
 * @param protocol - the protocol it speaks, from {@link protocolFor}.
 * @param base - pi's installed catalog entry for this id, when it has one.
 * @param family - the endpoint family to send it to; the catalog's own endpoint
 *   by default.
 * @returns the model object pi's provider dispatches on.
 */
export const piModelFor = (
  plane: Plane,
  spec: CatalogModelSpec,
  protocol: string,
  base?: object,
  family: EndpointFamily = "auto"
) => ({
  ...base,
  api: protocol,
  baseUrl: baseForProtocol(plane, protocol, family),
  contextWindow: spec.context_window,
  cost: {
    cacheRead: spec.cost?.cache_read ?? 0,
    cacheWrite: spec.cost?.cache_write ?? 0,
    input: spec.cost?.input ?? 0,
    output: spec.cost?.output ?? 0,
  },
  id: spec.id,
  input: spec.input_modalities,
  maxTokens: spec.max_output_tokens,
  name: spec.name,
  provider: plane,
  // Explicit, because the spread above is only a floor: pi's installed catalog
  // need not carry these models at all, and when it does not, `reasoning` and
  // `thinkingLevelMap` were simply absent - which is the thinking level the
  // picker could not offer for any model.
  // Required by pi's Model, not optional: a model that declares no reasoning
  // takes none, and `false` is what that means. Omitting it left an object the
  // package's own type says cannot exist.
  reasoning: spec.reasoning === true,
  ...(thinkingLevelMapFor(spec) === undefined
    ? {}
    : { thinkingLevelMap: thinkingLevelMapFor(spec) }),
});
