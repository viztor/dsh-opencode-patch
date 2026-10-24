/**
 * The wire protocols the plane routes speak, and the tables that place each
 * one on the gateway.
 *
 * The catalog names an SDK per model only where the model differs from the
 * provider's default, and that SDK is the vendor's own statement of the
 * protocol (D16): {@link PROTOCOL_FOR_SDK} maps it, and nothing here guesses
 * from a model's name. `@ai-sdk/mistral` maps to completions because that is
 * where pi 1.1.0's own data files `mistral-large-4`.
 *
 * Every value is a constant or a function of its arguments: this module is in
 * `utils/` and the architecture test holds it to that.
 *
 * @module dsh-opencode-patch/utils/protocols
 */

/** The SDK whose models are served on the Responses API. */
export const RESPONSES_SDK = "@ai-sdk/openai";

/** The SDK whose models are served on the Messages API. */
export const ANTHROPIC_SDK = "@ai-sdk/anthropic";

/** The SDK whose models speak pi's `google-generative-ai` protocol. */
export const GOOGLE_SDK = "@ai-sdk/google";

/** The SDK the catalog names for Mistral's models, served as completions. */
export const MISTRAL_SDK = "@ai-sdk/mistral";

/** The four protocols the plane adapter dispatches, in pi's own names. */
export const PROTOCOLS = [
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
  "google-generative-ai",
] as const;

/** One of {@link PROTOCOLS}. */
export type Protocol = (typeof PROTOCOLS)[number];

/** Whether a value names one of the four protocols. */
export const isProtocol = (value: unknown): value is Protocol =>
  typeof value === "string" && (PROTOCOLS as readonly string[]).includes(value);

/**
 * The protocol each SDK a model may name speaks. A model naming no SDK speaks
 * the provider default, completions ({@link protocolForSdk}).
 */
export const PROTOCOL_FOR_SDK: Readonly<Record<string, Protocol>> = {
  [RESPONSES_SDK]: "openai-responses",
  [ANTHROPIC_SDK]: "anthropic-messages",
  [GOOGLE_SDK]: "google-generative-ai",
  [MISTRAL_SDK]: "openai-completions",
};

/**
 * Whether a model's SDK has a protocol here: none named (the default), or one
 * {@link PROTOCOL_FOR_SDK} maps.
 *
 * @param sdk - the model's `provider_npm`, if any.
 */
export const isServableSdk = (sdk?: unknown): boolean =>
  sdk === undefined ||
  (typeof sdk === "string" && Object.hasOwn(PROTOCOL_FOR_SDK, sdk));

/**
 * The protocol a catalog SDK speaks.
 *
 * @param sdk - the model's `provider_npm`, if any.
 * @returns completions for none, the mapped protocol, or `undefined` for an
 *   SDK nothing here serves.
 */
export const protocolForSdk = (sdk?: unknown): Protocol | undefined => {
  if (sdk === undefined) {
    return "openai-completions";
  }
  return typeof sdk === "string" && Object.hasOwn(PROTOCOL_FOR_SDK, sdk)
    ? PROTOCOL_FOR_SDK[sdk]
    : undefined;
};

/** The two routes the plugin owns. */
export const PLANE_ROUTES = ["opencode", "opencode-go"] as const;

/** One of {@link PLANE_ROUTES}. */
export type PlaneRoute = (typeof PLANE_ROUTES)[number];

/** Whether a value names one of the plane routes. */
export const isPlaneRoute = (value: unknown): value is PlaneRoute =>
  value === "opencode" || value === "opencode-go";

/**
 * The older endpoint each plane's completions requests went to. Still served,
 * measured, and what `endpoint: legacy` selects.
 */
export const LEGACY_PLANE_API: Readonly<Record<PlaneRoute, string>> = {
  opencode: "https://opencode.ai/zen/v1",
  "opencode-go": "https://opencode.ai/zen/go/v1",
};

/**
 * Go's Google protocol. The legacy family has no Google base on Go, so this is
 * the one cell every family shares (`OPENCODE_FAMILY_API.go["@ai-sdk/google"]`).
 */
export const GO_GOOGLE_BASE_URL =
  "https://opencode.ai/inference/go/google/v1beta";

/**
 * The legacy family per plane and protocol: one base for every protocol but
 * Anthropic, whose SDK appends `/v1/messages` itself, and Go's Google.
 */
export const LEGACY_BASE: Readonly<
  Record<PlaneRoute, Readonly<Record<Protocol, string>>>
> = {
  opencode: {
    "anthropic-messages": "https://opencode.ai/zen",
    "google-generative-ai": "https://opencode.ai/zen/v1",
    "openai-completions": "https://opencode.ai/zen/v1",
    "openai-responses": "https://opencode.ai/zen/v1",
  },
  "opencode-go": {
    "anthropic-messages": "https://opencode.ai/zen/go",
    "google-generative-ai": GO_GOOGLE_BASE_URL,
    "openai-completions": "https://opencode.ai/zen/go/v1",
    "openai-responses": "https://opencode.ai/zen/go/v1",
  },
};

/**
 * The modern (per-protocol inference) family, for a catalog whose family map
 * names no base for a protocol. Measured from the vendor's own config; the
 * Anthropic entry keeps its `/v1`, which the caller strips.
 */
export const MODERN_FALLBACK: Readonly<
  Record<PlaneRoute, Readonly<Record<Protocol, string>>>
> = {
  opencode: {
    "anthropic-messages": "https://opencode.ai/inference/anthropic/v1",
    "google-generative-ai": "https://opencode.ai/inference/google/v1beta",
    "openai-completions": "https://opencode.ai/inference/openai/v1",
    "openai-responses": "https://opencode.ai/inference/openai/v1",
  },
  "opencode-go": {
    "anthropic-messages": "https://opencode.ai/inference/go/anthropic/v1",
    "google-generative-ai": GO_GOOGLE_BASE_URL,
    "openai-completions": "https://opencode.ai/inference/go/openai/v1",
    "openai-responses": "https://opencode.ai/inference/go/openai/v1",
  },
};

/**
 * The key each protocol's family is filed under in the catalog's family map
 * (`OPENCODE_FAMILY_API`): `""` is the provider default, completions.
 */
export const FAMILY_SDK_KEY: Readonly<Record<Protocol, string>> = {
  "anthropic-messages": ANTHROPIC_SDK,
  "google-generative-ai": GOOGLE_SDK,
  "openai-completions": "",
  "openai-responses": RESPONSES_SDK,
};

/** How pi-ai disposes one compat field: settable by a profile, or not. */
type Disposition = "offer" | "withhold";

/**
 * pi-ai's compat gate of every protocol (`llm-pi-ai/src/catalog.ts`, the
 * `COMPAT_GATES` tables), restated so the plane profile refuses and keeps
 * exactly what pi-ai's own resolution would. Order is pi-ai's, because a
 * diagnostic lists the fields in it.
 */
export const COMPAT_GATES: Readonly<
  Record<string, Readonly<Record<string, Disposition>>>
> = (() => {
  const completions: Record<string, Disposition> = {
    supportsStore: "offer",
    supportsDeveloperRole: "offer",
    supportsReasoningEffort: "offer",
    supportsUsageInStreaming: "offer",
    supportsFinishReason: "offer",
    maxTokensField: "offer",
    requiresToolResultName: "offer",
    requiresAssistantAfterToolResult: "offer",
    requiresThinkingAsText: "offer",
    requiresReasoningContentOnAssistantMessages: "offer",
    thinkingFormat: "offer",
    chatTemplateKwargs: "offer",
    chatTemplateArgs: "offer",
    supportsThinkingTokenBudget: "offer",
    thinkingTokenBudgetField: "offer",
    vllmPriority: "offer",
    supportsStrictMode: "offer",
    cacheControlFormat: "offer",
    supportsLongCacheRetention: "offer",
    openRouterRouting: "withhold",
    vercelGatewayRouting: "withhold",
    zaiToolStream: "withhold",
    supportsOpenAIGrammarTools: "withhold",
    sendSessionAffinityHeaders: "withhold",
    supportsMidConvoSystemMessages: "withhold",
    supportsMidConvoToolAdditions: "withhold",
    sessionAffinityFormat: "withhold",
  };
  const responses: Record<string, Disposition> = {
    supportsDeveloperRole: "offer",
    supportsMaxOutputTokens: "offer",
    supportsStrictMode: "offer",
    supportsLongCacheRetention: "offer",
    sessionAffinityFormat: "withhold",
    supportsOpenAIGrammarTools: "withhold",
    supportsAdditionalTools: "withhold",
    supportsToolSearch: "withhold",
    supportsExplicitPromptCacheMode: "withhold",
    supportsMidConvoSystemMessages: "withhold",
  };
  return {
    "mistral-conversations": { supportsMidConvoSystemMessages: "withhold" },
    "openai-completions": completions,
    "openai-responses": responses,
    "azure-openai-responses": responses,
    "openai-codex-responses": responses,
    "anthropic-messages": {
      supportsEagerToolInputStreaming: "offer",
      supportsLongCacheRetention: "offer",
      supportsCacheControlOnTools: "offer",
      supportsTemperature: "offer",
      forceAdaptiveThinking: "offer",
      allowEmptySignature: "offer",
      supportsStrictTools: "offer",
      sendSessionAffinityHeaders: "withhold",
      sessionAffinityFormat: "withhold",
      supportsMidConvoSystemMessages: "withhold",
      supportsMidConvoToolChanges: "withhold",
      supportsMidConvoEffort: "withhold",
      allowedFallbackModels: "withhold",
    },
    "bedrock-converse-stream": { supportsStrictMode: "offer" },
  };
})();

/** The fields one gate offers, in its order. */
const offeredIn = (
  gate: Readonly<Record<string, Disposition>> = {}
): ReadonlySet<string> =>
  new Set(
    Object.entries(gate).flatMap(([field, disposition]) =>
      disposition === "offer" ? [field] : []
    )
  );

/** The compat fields a profile may set on each plane protocol. */
export const OFFERED_COMPAT: Readonly<Record<Protocol, ReadonlySet<string>>> = {
  "anthropic-messages": offeredIn(COMPAT_GATES["anthropic-messages"]),
  "google-generative-ai": offeredIn(COMPAT_GATES["google-generative-ai"]),
  "openai-completions": offeredIn(COMPAT_GATES["openai-completions"]),
  "openai-responses": offeredIn(COMPAT_GATES["openai-responses"]),
};

/**
 * The protocols offering one compat field, in gate order: empty for a withheld
 * field or one no protocol declares.
 *
 * @param field - the compat field.
 */
export const compatProtocols = (field: string): string[] =>
  Object.entries(COMPAT_GATES).flatMap(([api, gate]) =>
    gate[field] === "offer" ? [api] : []
  );

/** Every offered compat field across the gates, deduplicated, in gate order. */
export const allOfferedCompatFields = (): string[] => {
  const fields = new Set<string>();
  for (const gate of Object.values(COMPAT_GATES)) {
    for (const field of offeredIn(gate)) {
      fields.add(field);
    }
  }
  return [...fields];
};

/**
 * Whether some gate names a field at all (offered or withheld).
 *
 * @param field - the compat field.
 */
export const isGatedCompatField = (field: string): boolean =>
  Object.values(COMPAT_GATES).some((gate) => gate[field] !== undefined);
