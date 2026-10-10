import { createProvider } from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { googleGenerativeAIApi } from "@earendil-works/pi-ai/api/google-generative-ai.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { describe, expect, it } from "vitest";

import type { CatalogModelSpec } from "../src/catalog-data.ts";
import {
  BASE_FOR_PROTOCOL,
  gatewayHeaders,
  piModelFor,
  protocolFor,
} from "../src/pi-provider.ts";

/** A catalogued model, shaped exactly as `catalog-data.ts` ships them. */
const spec = (id: string, providerNpm?: string): CatalogModelSpec => ({
  context_window: 200_000,
  cost: { cache_read: 0.01, input: 0.1, output: 0.5 },
  id,
  input_modalities: ["text"],
  max_output_tokens: 64_000,
  name: id,
  ...(providerNpm === undefined ? {} : { provider_npm: providerNpm }),
});

/** Wrap one api so every request carries the plugin's gateway headers. */
const withHeaders = (
  streams: Record<string, (...args: never[]) => unknown>,
  sessionId: string
) => {
  const wrap =
    (fn: (...args: never[]) => unknown) =>
    (model: never, context: never, options: Record<string, unknown>) =>
      fn(model, context, {
        ...options,
        headers: {
          ...gatewayHeaders(sessionId, "opencode/1.18.35 dsh-opencode-patch"),
          ...(options?.headers as Record<string, string> | undefined),
        },
      } as never);
  return {
    ...streams,
    stream: wrap(streams.stream as (...args: never[]) => unknown),
    streamSimple: wrap(streams.streamSimple as (...args: never[]) => unknown),
  };
};

/**
 * The request a provider would send for one model, captured before it leaves.
 *
 * The spike that designed this module did the same thing by hand; this is that
 * spike, kept.
 */
const requestFor = async (
  plane: "opencode" | "opencode-go",
  model: CatalogModelSpec
): Promise<{ headers: Record<string, string>; url: string }> => {
  const protocol = protocolFor(model);
  expect(protocol).toBeDefined();
  const provider = createProvider({
    api: {
      "anthropic-messages": withHeaders(
        anthropicMessagesApi() as never,
        "ses_test"
      ),
      "google-generative-ai": withHeaders(
        googleGenerativeAIApi() as never,
        "ses_test"
      ),
      "openai-completions": withHeaders(
        openAICompletionsApi() as never,
        "ses_test"
      ),
      "openai-responses": withHeaders(
        openAIResponsesApi() as never,
        "ses_test"
      ),
    },
    auth: { apiKey: { name: "OpenCode API key" } },
    id: plane,
    models: [piModelFor(plane, model, protocol ?? "")],
    name: plane,
  } as never);

  const seen: { headers: Record<string, string>; url: string }[] = [];
  const real = globalThis.fetch;
  // Some protocols call fetch with a Request rather than a URL plus init, so
  // the headers have to be read off whichever shape arrived.
  globalThis.fetch = (async (input: unknown, init?: { headers?: unknown }) => {
    const url = typeof input === "string" ? input : String(input);
    const request = typeof input === "object" && input !== null ? input : {};
    const raw =
      init?.headers ?? (request as { headers?: unknown }).headers ?? {};
    // A `Headers` instance carries its entries behind a method, not as own
    // properties, so reading it with Object.entries yields nothing at all.
    const headers: Record<string, string> = {};
    if (raw instanceof Headers) {
      for (const [key, value] of raw.entries()) {
        headers[key.toLowerCase()] = value;
      }
    } else {
      for (const [key, value] of Object.entries(
        raw as Record<string, string>
      )) {
        headers[key.toLowerCase()] = value;
      }
    }
    seen.push({ headers, url });
    throw new Error("captured");
  }) as typeof globalThis.fetch;
  try {
    const [only] = provider.getModels();
    expect(only).toBeDefined();
    const stream = provider.stream(
      only as never,
      { messages: [{ role: "user", content: "hi" }] } as never,
      { apiKey: "sk-test", sessionId: "ses_test" } as never
    );
    const iterable = stream as unknown as AsyncIterable<unknown>;
    for await (const _ of iterable) {
      // The capture throws on the first request; nothing arrives here.
    }
  } catch {
    // Expected: the capture refuses the call.
  } finally {
    globalThis.fetch = real;
  }
  expect(seen.length).toBe(1);
  return seen[0] ?? { headers: {}, url: "" };
};

describe("pi-provider · the URL each protocol reaches", () => {
  it("sends a Responses model to the responses endpoint", async () => {
    const { url } = await requestFor(
      "opencode",
      spec("gpt-5.4", "@ai-sdk/openai")
    );
    expect(url).toBe("https://opencode.ai/zen/v1/responses");
  });

  it("sends a Messages model to the messages endpoint", async () => {
    const { url } = await requestFor(
      "opencode",
      spec("claude-opus-5", "@ai-sdk/anthropic")
    );
    // One level shorter than the others, because this SDK appends /v1/messages.
    expect(url).toBe("https://opencode.ai/zen/v1/messages?beta=true");
  });

  it("sends a model with no SDK to the completions endpoint", async () => {
    const { url } = await requestFor("opencode", spec("big-pickle"));
    expect(url).toBe("https://opencode.ai/zen/v1/chat/completions");
  });

  it("sends a Google model to the endpoint a hand-declared route cannot name", async () => {
    const { url } = await requestFor(
      "opencode",
      spec("gemini-3.8-flash", "@ai-sdk/google")
    );
    expect(url).toBe(
      "https://opencode.ai/zen/v1/models/gemini-3.8-flash:streamGenerateContent?alt=sse"
    );
  });

  it("sends a Go-plane model to the Go base", async () => {
    const { url } = await requestFor(
      "opencode-go",
      spec("deepseek-v4-flash", "@ai-sdk/openai")
    );
    expect(url).toBe("https://opencode.ai/zen/go/v1/responses");
  });
});

describe("pi-provider · the headers every protocol carries", () => {
  it("puts the session id on all four protocols", async () => {
    const cases: [string, string | undefined][] = [
      ["gpt-5.4", "@ai-sdk/openai"],
      ["claude-opus-5", "@ai-sdk/anthropic"],
      ["big-pickle", undefined],
      ["gemini-3.8-flash", "@ai-sdk/google"],
    ];
    for (const [id, sdk] of cases) {
      const { headers } = await requestFor("opencode", spec(id, sdk));
      expect(headers["x-opencode-session"]).toBe("ses_test");
      expect(headers["x-opencode-client"]).toBe("cli");
      expect(headers["x-opencode-project"]).toBe("global");
    }
  });
});

describe("pi-provider · the tables themselves", () => {
  it("keeps the Anthropic base one level shorter on both planes", () => {
    for (const plane of ["opencode", "opencode-go"] as const) {
      const base = BASE_FOR_PROTOCOL[plane];
      expect(base["anthropic-messages"]?.endsWith("/v1")).toBe(false);
      expect(base["openai-responses"]?.endsWith("/v1")).toBe(true);
    }
  });

  it("names a base for every protocol it can route", () => {
    for (const plane of ["opencode", "opencode-go"] as const) {
      for (const [protocol, base] of Object.entries(BASE_FOR_PROTOCOL[plane])) {
        expect(base.startsWith("https://opencode.ai/zen"), protocol).toBe(true);
      }
    }
  });
});
