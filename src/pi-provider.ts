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
export const BASE_FOR_PROTOCOL: Readonly<
  Record<Plane, Readonly<Record<string, string>>>
> = {
  opencode: {
    "anthropic-messages": "https://opencode.ai/zen",
    "google-generative-ai": "https://opencode.ai/zen/v1",
    "openai-completions": "https://opencode.ai/zen/v1",
    "openai-responses": "https://opencode.ai/zen/v1",
  },
  "opencode-go": {
    "anthropic-messages": "https://opencode.ai/zen/go",
    "openai-completions": "https://opencode.ai/zen/go/v1",
    "openai-responses": "https://opencode.ai/zen/go/v1",
  },
};

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

/**
 * The pi model object for one catalogued model.
 *
 * pi reads `api` to pick a protocol implementation and `baseUrl` to know where
 * to send it, so both have to be right per model. The cost field is pi's own
 * vocabulary: camelCase where the catalog is snake_case, and its rates are per
 * million tokens, which is what the catalog already carries.
 *
 * @param plane - the gateway plane this model is served on.
 * @param spec - the catalogued model.
 * @param protocol - the protocol it speaks, from {@link protocolFor}.
 * @returns the model object pi's provider dispatches on.
 */
export const piModelFor = (
  plane: Plane,
  spec: CatalogModelSpec,
  protocol: string
) => ({
  api: protocol,
  baseUrl: BASE_FOR_PROTOCOL[plane]?.[protocol],
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
});

/**
 * The headers every gateway request carries.
 *
 * The vendor asks clients to identify themselves and to send a stable session
 * id per conversation (`x-opencode-session`); the project attribution is what
 * groups usage in their Console.
 *
 * @param sessionId - the derived session id, when one is known.
 * @param userAgent - the CLI-shaped User-Agent this plugin claims to be.
 * @returns the headers to merge under any the caller already set.
 */
export const gatewayHeaders = (
  sessionId: string | undefined,
  userAgent: string
): Record<string, string> => ({
  "user-agent": userAgent,
  "x-opencode-client": "cli",
  "x-opencode-project": "global",
  ...(sessionId === undefined ? {} : { "x-opencode-session": sessionId }),
});
