import { AsyncLocalStorage } from "node:async_hooks";

import { PiAiAdapter } from "@deepseek-ai/dsh-llm-pi-ai";
import { describe, expect, it } from "vitest";

import { OPENCODE_GO_CATALOG } from "../src/catalog-data.ts";
import { resolveConfig } from "../src/config.ts";
import { patchFetch } from "../src/fetch-patch.ts";
import {
  registerGoogleBridge,
  GO_GOOGLE_BASE_URL,
} from "../src/google-bridge.ts";
import { hideResponsesRoute } from "../src/models-discovery.ts";
import {
  GO_GOOGLE_INTERNAL_ROUTE,
  internalRouteFor,
} from "../src/responses-routes.ts";
import { getSessionUsage } from "../src/session-cost.ts";
import { createStreamHook } from "../src/stream-hook.ts";
import type { ActiveTurnState } from "../src/turn-store.ts";
import { testPi } from "./google-runtime-fixture.ts";

interface WirePart {
  functionCall?: { name: string };
  functionResponse?: { name: string };
  thoughtSignature?: string;
}
interface Chunk {
  type: string;
  text: string;
  block: { type: string; id: string; arguments: string };
  reason: { kind: string };
  replayState: { blocks: unknown[] };
}

const createCredentialsSeam = () => {
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

const model = "gemini-4-argon";
const specs = OPENCODE_GO_CATALOG.filter((spec) => spec.id === model);

describe("Go Gemini native bridge", () => {
  it("keeps the picker limited to declared models and hides the bridge", async () => {
    const existing = [{ provider: "opencode-go", id: "kimi-k3", name: "Kimi" }];
    const ctx = {
      llm: {
        listProviders: () => [
          { id: "opencode-go", name: "Go" },
          { id: GO_GOOGLE_INTERNAL_ROUTE, name: "Google" },
        ],
        listModels: async (_provider: string) => existing,
      },
    };
    const stop = hideResponsesRoute(ctx, resolveConfig());
    try {
      expect(await ctx.llm.listModels("opencode-go")).toEqual(existing);
      expect(await ctx.llm.listModels(GO_GOOGLE_INTERNAL_ROUTE)).toEqual([]);
      expect(existing).toHaveLength(1);
    } finally {
      stop?.();
    }
  });
  it("preserves Go authentication, session affinity and signed tool replay across two turns", async () => {
    expect(specs).toHaveLength(1);
    expect(internalRouteFor("opencode-go", model)).toBe(
      GO_GOOGLE_INTERNAL_ROUTE
    );
    const seam = createCredentialsSeam();
    await seam.credentials.set("CUSTOM_GO_KEY", "go-fixture-key");
    await seam.credentials.set("OPENCODE_API_KEY", "zen-must-not-be-used");
    let adapter: PiAiAdapter | undefined;
    registerGoogleBridge({
      pi: testPi(),
      ctx: seam.ctx,
      host: { PiAiAdapter },
      specs,
      plane: "opencode-go",
      apiKeyRef: "CUSTOM_GO_KEY",
      llm: {
        registerAdapter(routes, instance) {
          expect(routes).toEqual([GO_GOOGLE_INTERNAL_ROUTE]);
          adapter = instance as PiAiAdapter;
        },
      },
    });
    const als = new AsyncLocalStorage<ActiveTurnState>();
    const config = resolveConfig({
      userAgent: "dsh-desktop-go-gemini/1.0",
      injectOriginHeaders: false,
    });
    const ctx = {
      llm: {
        listProviders: () => [
          { id: GO_GOOGLE_INTERNAL_ROUTE, name: "Go Google" },
        ],
        stream: (options: unknown): unknown =>
          hook(options, () => adapter!.stream(options as never)),
      },
    };
    const hook = createStreamHook(ctx, config, als);
    const stopHiding = hideResponsesRoute(ctx, config);
    const requests: {
      url: string;
      headers: Headers;
      body: { contents: { parts: WirePart[] }[] };
    }[] = [];
    const real = globalThis.fetch;
    globalThis.fetch = patchFetch(
      (async (input, init) => {
        requests.push({
          url: input instanceof Request ? input.url : String(input),
          headers: new Headers(init?.headers),
          body: JSON.parse(typeof init?.body === "string" ? init.body : "{}"),
        });
        const parts =
          requests.length === 1
            ? [
                {
                  functionCall: { name: "lookup", args: { item: "sample" } },
                  thoughtSignature: "c2lnbmVkLXRvb2wtZml4dHVyZQ==",
                },
              ]
            : [{ text: "The result is 42." }];
        return new Response(
          `data: ${JSON.stringify({
            candidates: [
              { content: { role: "model", parts }, finishReason: "STOP" },
            ],
            usageMetadata: {
              promptTokenCount: 10,
              candidatesTokenCount: 3,
              totalTokenCount: 13,
            },
          })}\n\n`,
          { headers: { "content-type": "text/event-stream" } }
        );
      }) as typeof fetch,
      als,
      config
    );
    const messages: unknown[] = [
      { role: "user", content: [{ type: "text", text: "Look up sample." }] },
    ];
    const run = async () => {
      const options = {
        provider: "opencode-go",
        model,
        sessionId: "go-google-session-fixture",
        messages,
        tools: [
          {
            name: "lookup",
            description: "Read a sample value",
            parameters: {
              type: "object",
              properties: { item: { type: "string" } },
              required: ["item"],
            },
          },
        ],
      };
      const chunks: Chunk[] = [];
      const stream = hook(options, () =>
        adapter!.stream(options as never)
      ) as AsyncIterable<unknown>;
      for await (const chunk of stream) chunks.push(chunk as Chunk);
      return chunks;
    };
    try {
      const first = await run();
      expect(
        getSessionUsage("go-google-session-fixture")?.inputTokens
      ).toBeGreaterThan(0);
      const finish = first.find((chunk) => chunk.type === "finish")!;
      expect(finish.reason.kind).toBe("tool-calls");
      const blocks = first
        .filter((chunk) => chunk.type === "block-end")
        .map((chunk) => chunk.block);
      const call = blocks.find((block) => block.type === "tool-call")!;
      expect(JSON.parse(call.arguments)).toEqual({ item: "sample" });
      expect(finish.replayState.blocks).toContainEqual({
        type: "tool-call",
        thoughtSignature: "c2lnbmVkLXRvb2wtZml4dHVyZQ==",
      });
      messages.push(
        {
          role: "assistant",
          content: blocks,
          source: {
            provider: "opencode-go",
            model,
            replayState: finish.replayState,
          },
        },
        {
          role: "tool",
          toolCallId: call.id,
          content: [{ type: "text", text: "42" }],
        }
      );
      const second = await run();
      expect(second.find((chunk) => chunk.type === "finish")!.reason.kind).toBe(
        "stop"
      );
      expect(
        second.some(
          (chunk) => chunk.type === "text-delta" && chunk.text.includes("42")
        )
      ).toBe(true);
      expect(requests).toHaveLength(2);
      for (const request of requests) {
        expect(request.url).toBe(
          `${GO_GOOGLE_BASE_URL}/models/${model}:streamGenerateContent?alt=sse`
        );
        expect(request.headers.get("x-goog-api-key")).toBe("go-fixture-key");
        expect(request.headers.get("user-agent")).toBe(
          "dsh-desktop-go-gemini/1.0"
        );
        expect(request.headers.get("x-opencode-session")).toMatch(/^ses_/);
      }
      expect(requests[0]!.headers.get("x-opencode-session")).toBe(
        requests[1]!.headers.get("x-opencode-session")
      );
      const replayParts = requests[1]!.body.contents.flatMap(
        (content) => content.parts
      );
      expect(
        replayParts.some(
          (part) =>
            part.functionCall &&
            part.thoughtSignature === "c2lnbmVkLXRvb2wtZml4dHVyZQ=="
        )
      ).toBe(true);
      expect(
        replayParts.some((part) => part.functionResponse?.name === "lookup")
      ).toBe(true);
    } finally {
      stopHiding?.();
      globalThis.fetch = real;
    }
  });

  it("does not fall through to Zen when the configured Go key is missing", async () => {
    const seam = createCredentialsSeam();
    await seam.credentials.set("OPENCODE_API_KEY", "zen-must-not-be-used");
    let adapter: PiAiAdapter | undefined;
    registerGoogleBridge({
      pi: testPi(),
      ctx: seam.ctx,
      host: { PiAiAdapter },
      specs,
      plane: "opencode-go",
      apiKeyRef: "MISSING_GO_FIXTURE_KEY",
      llm: {
        registerAdapter(_routes, instance) {
          adapter = instance as PiAiAdapter;
        },
      },
    });
    let requests = 0;
    const real = globalThis.fetch;
    globalThis.fetch = (() => {
      requests += 1;
      throw new Error("network must not be used");
    }) as typeof fetch;
    try {
      await expect(async () => {
        for await (const _ of adapter!.stream({
          provider: GO_GOOGLE_INTERNAL_ROUTE,
          model,
          messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        } as never)) {
          /* consume */
        }
      }).rejects.toThrow(/MISSING_CREDENTIAL/);
      expect(requests).toBe(0);
    } finally {
      globalThis.fetch = real;
    }
  });
});
