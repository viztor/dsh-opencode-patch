// oxlint-disable no-barrel-file -- the mock protocols are deliberately re-exported
// from one place so a test imports whichever wire protocol it exercises; splitting
// this file would not change how many modules load.
/**
 * Wire Protocols & Fixtures Library.
 *
 * Implements wire protocol contracts, constants, and mock response fixtures:
 * - OpenAI v1 Chat Completions Wire Protocol & Fixtures (/chat/completions)
 * - OpenAI v2 Responses Wire Protocol & Fixtures (/responses)
 * - Anthropic Messages Wire Protocol & Fixtures (/messages)
 * - Google Generative AI Wire Protocol & Fixtures (/models/{model}:streamGenerateContent & :generateContent)
 * - Models Catalog Wire Protocol & Fixtures (/models)
 * - OpenCode Go Quota & Usage Wire Protocol & Fixtures (/usage)
 *
 * Wire stream parsing is understood by the host's `pi-ai` adapter, not hand-wired here.
 *
 * @module test/mock/protocols/index
 */

export * as OpenAIV1CompletionsProtocol from "./v1-chat-completions.protocol.ts";
export * as V1ChatCompletionsProtocol from "./v1-chat-completions.protocol.ts";
export * as OpenAICompletionsProtocol from "./v1-chat-completions.protocol.ts";

export * as OpenAIV2ResponsesProtocol from "./v2-responses.protocol.ts";
export * as V2ResponsesProtocol from "./v2-responses.protocol.ts";
export * as OpenAIResponsesProtocol from "./v2-responses.protocol.ts";

export * as AnthropicMessagesProtocol from "./anthropic-messages.protocol.ts";
export * as GoogleGenerativeAiProtocol from "./google-generative-ai.protocol.ts";
export * as ModelsCatalogProtocol from "./models-catalog.protocol.ts";
export * as UsageQuotaProtocol from "./usage-quota.protocol.ts";

/* -------------------------------------------------------------------------- */
/*                     v1 Chat Completions Protocol & Fixtures                */
/* -------------------------------------------------------------------------- */

export {
  V1_COMPLETIONS_KIND,
  V1_COMPLETIONS_PROTOCOL,
  V1_COMPLETIONS_WIRE_HEADER,
  V1_MOCK_TEXT,
  v1CompletionsStream,
  v1CompletionsUnary,
  formatV1Chunk,
  formatV1Done,
  COMPLETIONS_KIND,
  COMPLETIONS_PROTOCOL,
  COMPLETIONS_WIRE_HEADER,
  completionsStream,
  completionsUnary,
  type V1Choice,
  type V1CompletionChunk,
  type V1ChunkChoice,
  type V1Delta,
  type V1CompletionsUnaryPayload,
  type CompletionsChoice,
  type CompletionsChunk,
  type CompletionsChunkChoice,
  type CompletionsDelta,
  type CompletionsUnaryPayload,
} from "./v1-chat-completions.protocol.ts";

/* -------------------------------------------------------------------------- */
/*                        v2 Responses Protocol & Fixtures                    */
/* -------------------------------------------------------------------------- */

export {
  V2_RESPONSES_KIND,
  V2_RESPONSES_PROTOCOL,
  V2_RESPONSES_WIRE_HEADER,
  V2_MOCK_TEXT,
  v2ResponsesStream,
  v2ResponsesUnary,
  formatV2Event,
  RESPONSES_KIND,
  RESPONSES_PROTOCOL,
  RESPONSES_WIRE_HEADER,
  MOCK_TEXT,
  responsesStream,
  responsesUnary,
  type V2OutputItem,
  type V2OutputTextContent,
  type V2ResponsesUnaryPayload,
  type V2ResponsesUsage,
  type ResponsesOutputItem,
  type ResponsesUnaryPayload,
  type ResponsesUsage,
} from "./v2-responses.protocol.ts";

/* -------------------------------------------------------------------------- */
/*                       Anthropic Messages Protocol                          */
/* -------------------------------------------------------------------------- */

export {
  MESSAGES_KIND,
  MESSAGES_PROTOCOL,
  MESSAGES_WIRE_HEADER,
  anthropicStream,
  anthropicUnary,
  type MessagesContentItem,
  type MessagesUnaryPayload,
  type MessagesUsage,
} from "./anthropic-messages.protocol.ts";

/* -------------------------------------------------------------------------- */
/*                    Google Generative AI Protocol                           */
/* -------------------------------------------------------------------------- */

export {
  GOOGLE_KIND,
  GOOGLE_PATH_PATTERN,
  GOOGLE_PROTOCOL,
  GOOGLE_WIRE_HEADER,
  extractGoogleModel,
  googleStream,
  googleUnary,
  type GoogleCandidate,
  type GoogleChunk,
  type GooglePart,
  type GoogleUnaryPayload,
  type GoogleUsageMetadata,
} from "./google-generative-ai.protocol.ts";

/* -------------------------------------------------------------------------- */
/*                        Models Catalog Protocol                             */
/* -------------------------------------------------------------------------- */

export {
  CATALOG_KIND,
  CATALOG_PROTOCOL,
  CATALOG_WIRE_HEADER,
  modelsListing,
  type CatalogListingPayload,
  type CatalogModelRow,
  type CatalogPlane,
} from "./models-catalog.protocol.ts";

/* -------------------------------------------------------------------------- */
/*                          Usage Quota Protocol                              */
/* -------------------------------------------------------------------------- */

export {
  USAGE_KIND,
  USAGE_PROTOCOL,
  USAGE_WIRE_HEADER,
  usageResponse,
  type MockUsageOptions,
  type QuotaWindow,
  type UsageQuotaPayload,
  type WireReply,
} from "./usage-quota.protocol.ts";

/**
 * Standard error shape returned by gateway failure responses.
 */
export interface GatewayErrorPayload {
  readonly error: {
    readonly message: string;
    readonly type: string;
  };
}
