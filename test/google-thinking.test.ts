import { PiAiAdapter } from "@deepseek-ai/dsh-llm-pi-ai";
import { describe, expect, it } from "vitest";

import {
  OPENCODE_ZEN_CATALOG,
  type CatalogModelSpec,
} from "../src/catalog-data.ts";
import type { PiRuntime } from "../src/google-bridge.ts";
import {
  googleProviderFor,
  registerGoogleBridge,
} from "../src/google-bridge.ts";
import { GOOGLE_INTERNAL_ROUTE, GOOGLE_SDK } from "../src/responses-routes.ts";
import { testPi } from "./google-runtime-fixture.ts";

const ARGON_ID = "gemini-4-argon";
const argonSpec = OPENCODE_ZEN_CATALOG.find((spec) => spec.id === ARGON_ID);

interface CapturedRequest {
  body: unknown;
  url: string;
}

interface GoogleProviderLike {
  getModels: () => Record<string, unknown>[];
  stream: (
    model: Record<string, unknown>,
    context: unknown,
    options?: unknown
  ) => AsyncIterable<unknown>;
  streamSimple: (
    model: Record<string, unknown>,
    context: unknown,
    options?: unknown
  ) => AsyncIterable<unknown>;
}

/** Reproduce pi 1.2's budget-shaped Argon payload through the real serializer. */
const createLegacyPi = (): PiRuntime => {
  const current = testPi();
  return {
    ...current,
    googleGenerativeAIApi: () => {
      const api = current.googleGenerativeAIApi();
      return {
        ...api,
        streamSimple: (model, context, options) => {
          const thinking = {
            enabled: true,
            budgetTokens: options?.reasoning === undefined ? 0 : -1,
          };
          return api.stream(model, context, {
            ...options,
            thinking,
          });
        },
      };
    },
  };
};

const makeCredentials = () => {
  const refs = new Map<string, string>();
  const credentials = {
    set: (name: string, value: string) =>
      Promise.resolve(refs.set(name, value)),
    resolve: (name: string) => Promise.resolve({ value: refs.get(name) }),
  };
  return {
    credentials,
    ctx: {
      get: (name: string) => (name === "credentials" ? credentials : undefined),
    },
  };
};

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const sseResponse = (): Response =>
  new Response(
    `data: ${JSON.stringify({
      candidates: [
        {
          content: { role: "model", parts: [{ text: "done" }] },
          finishReason: "STOP",
        },
      ],
      usageMetadata: {
        candidatesTokenCount: 1,
        promptTokenCount: 1,
        totalTokenCount: 2,
      },
    })}\n\n`,
    { headers: { "content-type": "text/event-stream" } }
  );

const captureRequests = (): {
  requests: CapturedRequest[];
  restore: () => void;
} => {
  const requests: CapturedRequest[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input, init) => {
    let rawBody = "{}";
    if (typeof init?.body === "string") {
      rawBody = init.body;
    } else if (input instanceof Request) {
      rawBody = await input.clone().text();
    }
    let url: string;
    if (typeof input === "string") {
      url = input;
    } else if (input instanceof URL) {
      url = input.href;
    } else {
      const { url: requestUrl } = input;
      url = requestUrl;
    }
    requests.push({ body: JSON.parse(rawBody) as unknown, url });
    return sseResponse();
  }) as typeof fetch;
  return {
    requests,
    restore: () => {
      globalThis.fetch = originalFetch;
    },
  };
};

const consume = async (stream: AsyncIterable<unknown>): Promise<unknown[]> => {
  const events: unknown[] = [];
  for await (const event of stream) events.push(event);
  return events;
};

const thinkingConfigOf = (
  request: CapturedRequest | undefined
): Record<string, unknown> | undefined => {
  const body = asRecord(request?.body);
  const generation = asRecord(body?.generationConfig) ?? asRecord(body?.config);
  return asRecord(generation?.thinkingConfig);
};

const expectAdapterStop = (events: readonly unknown[]): void => {
  const finish = events.map(asRecord).find((event) => event?.type === "finish");
  expect(asRecord(finish?.reason)?.kind).toBe("stop");
  expect(events.some((event) => asRecord(event)?.type === "error")).toBe(false);
};

const expectPiDone = (events: readonly unknown[]): void => {
  expect(events.some((event) => asRecord(event)?.type === "done")).toBe(true);
  expect(events.some((event) => asRecord(event)?.type === "error")).toBe(false);
};

const providerFor = (
  pi: PiRuntime,
  specs: readonly CatalogModelSpec[]
): GoogleProviderLike =>
  googleProviderFor(
    pi,
    specs,
    "auto",
    "opencode"
  ) as unknown as GoogleProviderLike;

const context = { messages: [{ content: "hi", role: "user" }] };

describe("Gemini 4 thinking payload compatibility", () => {
  it.each([
    { effort: undefined, name: "default", expected: "LOW" },
    { effort: "low", name: "low", expected: "LOW" },
    { effort: "medium", name: "medium", expected: "MEDIUM" },
    { effort: "high", name: "high", expected: "HIGH" },
  ])(
    "sends $name as a Gemini thinking level through PiAiAdapter",
    async ({ effort, expected }) => {
      if (argonSpec === undefined)
        throw new Error("Zen catalog lacks Gemini 4 Argon");
      const seam = makeCredentials();
      await seam.credentials.set("THINKING_FIXTURE_KEY", "fixture-key");
      let adapter: PiAiAdapter | undefined;
      const dispose = registerGoogleBridge({
        apiKeyRef: "THINKING_FIXTURE_KEY",
        ctx: seam.ctx,
        host: { PiAiAdapter },
        llm: {
          registerAdapter(routes, value) {
            expect(routes).toEqual([GOOGLE_INTERNAL_ROUTE]);
            adapter = value as PiAiAdapter;
            return () => {};
          },
        },
        pi: createLegacyPi(),
        specs: [argonSpec],
      });
      const capture = captureRequests();
      try {
        expect(dispose).toBeDefined();
        expect(adapter).toBeDefined();
        const options = {
          messages: [{ content: [{ text: "hi", type: "text" }], role: "user" }],
          model: ARGON_ID,
          provider: GOOGLE_INTERNAL_ROUTE,
          ...(effort === undefined ? {} : { reasoningEffort: effort }),
        };
        const events = await consume(adapter!.stream(options as never));

        expectAdapterStop(events);
        expect(capture.requests).toHaveLength(1);
        expect(capture.requests[0]?.url).toContain(
          `/models/${ARGON_ID}:streamGenerateContent`
        );
        const thinking = thinkingConfigOf(capture.requests[0]);
        expect(thinking?.thinkingLevel).toBe(expected);
        expect(thinking).not.toHaveProperty("thinkingBudget");
      } finally {
        capture.restore();
        if (typeof dispose === "function") dispose();
      }
    }
  );

  it.each([
    { effort: "low", expected: "LOW" },
    { effort: "medium", expected: "MEDIUM" },
    { effort: "high", expected: "HIGH" },
  ])(
    "uses native Gemini thinkingLevel $expected",
    async ({ effort, expected }) => {
      if (argonSpec === undefined)
        throw new Error("Zen catalog lacks Gemini 4 Argon");
      const capture = captureRequests();
      try {
        const provider = providerFor(testPi(), [argonSpec]);
        const [model] = provider.getModels();
        if (model === undefined)
          throw new Error("Google provider has no model");
        const events = await consume(
          provider.streamSimple(model, context, {
            apiKey: "fixture-key",
            reasoning: effort,
          })
        );

        expectPiDone(events);
        const thinking = thinkingConfigOf(capture.requests[0]);
        expect(thinking?.thinkingLevel).toBe(expected);
        expect(thinking).not.toHaveProperty("thinkingBudget");
      } finally {
        capture.restore();
      }
    }
  );

  it.each(["xhigh", "max"])(
    "clamps legacy %s to Argon's highest supported level",
    async (reasoning) => {
      if (argonSpec === undefined) throw new Error("Zen catalog lacks Argon");
      const capture = captureRequests();
      try {
        const provider = providerFor(createLegacyPi(), [argonSpec]);
        const [model] = provider.getModels();
        if (model === undefined)
          throw new Error("Google provider has no model");
        expectPiDone(
          await consume(
            provider.streamSimple(model, context, {
              apiKey: "fixture-key",
              reasoning,
            })
          )
        );
        expect(thinkingConfigOf(capture.requests[0])).toEqual({
          includeThoughts: true,
          thinkingLevel: "HIGH",
        });
      } finally {
        capture.restore();
      }
    }
  );

  it.each([false, true])(
    "preserves an async payload hook (replacement: %s)",
    async (replace) => {
      if (argonSpec === undefined) throw new Error("Zen catalog lacks Argon");
      const capture = captureRequests();
      try {
        const provider = providerFor(testPi(), [argonSpec]);
        const [model] = provider.getModels();
        if (model === undefined)
          throw new Error("Google provider has no model");
        const events = await consume(
          provider.streamSimple(model, context, {
            apiKey: "fixture-key",
            reasoning: "medium",
            onPayload: replace
              ? async (payload: unknown) => {
                  await Promise.resolve();
                  const value = asRecord(payload);
                  const config = asRecord(value?.config);
                  if (value === undefined || config === undefined)
                    throw new Error("Invalid payload");
                  return {
                    ...value,
                    config: {
                      ...config,
                      temperature: 0.25,
                      thinkingConfig: {
                        thinkingBudget: -1,
                        includeThoughts: true,
                      },
                    },
                  };
                }
              : async (payload: unknown) => {
                  await Promise.resolve();
                  const config = asRecord(asRecord(payload)?.config);
                  if (config === undefined) throw new Error("Invalid payload");
                  config.temperature = 0.25;
                  config.thinkingConfig = {
                    thinkingBudget: -1,
                    includeThoughts: true,
                  };
                },
          })
        );
        expectPiDone(events);
        const [request] = capture.requests;
        const config = asRecord(asRecord(request?.body)?.generationConfig);
        expect(config?.temperature).toBe(0.25);
        expect(thinkingConfigOf(request)).toEqual({
          includeThoughts: true,
          thinkingLevel: "MEDIUM",
        });
      } finally {
        capture.restore();
      }
    }
  );

  it("preserves an explicit raw-stream thinking level", async () => {
    if (argonSpec === undefined) throw new Error("Zen catalog lacks Argon");
    const capture = captureRequests();
    try {
      const provider = providerFor(testPi(), [argonSpec]);
      const [model] = provider.getModels();
      if (model === undefined) throw new Error("Google provider has no model");
      expectPiDone(
        await consume(
          provider.stream(model, context, {
            apiKey: "fixture-key",
            thinking: { enabled: true, level: "HIGH" },
          })
        )
      );
      expect(thinkingConfigOf(capture.requests[0])).toEqual({
        includeThoughts: true,
        thinkingLevel: "HIGH",
      });
    } finally {
      capture.restore();
    }
  });

  it("leaves Gemini 2.5 on the token-budget protocol", async () => {
    const spec: CatalogModelSpec = {
      context_window: 131_072,
      id: "gemini-2.5-pro",
      input_modalities: ["text"],
      max_output_tokens: 8_192,
      name: "Gemini 2.5 Pro fixture",
      provider_npm: GOOGLE_SDK,
      reasoning: true,
      reasoning_options: [{ min: 1024, type: "budget_tokens" }],
    };
    const capture = captureRequests();
    try {
      const provider = providerFor(testPi(), [spec]);
      const [model] = provider.getModels();
      if (model === undefined) throw new Error("Google provider has no model");
      const events = await consume(
        provider.streamSimple(model, context, {
          apiKey: "fixture-key",
          reasoning: "low",
        })
      );

      expectPiDone(events);
      const thinking = thinkingConfigOf(capture.requests[0]);
      expect(thinking?.thinkingBudget).toBe(2048);
      expect(thinking).not.toHaveProperty("thinkingLevel");
    } finally {
      capture.restore();
    }
  });
});
