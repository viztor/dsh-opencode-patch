import { createProvider } from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { googleGenerativeAIApi } from "@earendil-works/pi-ai/api/google-generative-ai.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { describe, expect, it } from "vitest";

import { OPENCODE_PLANE_API } from "../src/catalog-data.ts";
import type { CatalogModelSpec } from "../src/catalog-data.ts";
import { ENDPOINT_FAMILIES } from "../src/config-values.ts";
import { OPENCODE_USER_AGENT } from "../src/identity.ts";
import {
  BASE_FOR_PROTOCOL,
  baseForProtocol,
  piModelFor,
  planeBaseFor,
  protocolFor,
  thinkingLevelMapFor,
} from "../src/pi-provider.ts";

/**
 * The headers this test feeds the model.
 *
 * A fixture, and it lives here because that is what it is. It was exported from
 * `pi-provider.ts` and called only from this file, and it had drifted: it hardcodes
 * `x-opencode-client` and `x-opencode-project` where `fetch-patch.ts`, which
 * actually sends those headers, reads both from config. A fixture that disagrees
 * with the thing it stands in for is worse than no fixture, and production should
 * not carry one.
 */
const gatewayHeaders = (
  sessionId: string | undefined,
  userAgent: string
): Record<string, string> => ({
  "user-agent": userAgent,
  "x-opencode-client": "cli",
  "x-opencode-project": "global",
  ...(sessionId === undefined ? {} : { "x-opencode-session": sessionId }),
});

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
          ...gatewayHeaders(sessionId, "opencode/1.19.4 dsh-opencode-patch"),
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
    expect(url).toBe(`${OPENCODE_PLANE_API.zen}/responses`);
  });

  it("sends a Messages model to the messages endpoint", async () => {
    const { url } = await requestFor(
      "opencode",
      spec("claude-opus-5", "@ai-sdk/anthropic")
    );
    // The Anthropic family has its own base, one level shorter than its
    // declared `…/anthropic/v1` because this SDK appends /v1/messages.
    expect(url).toBe(
      "https://opencode.ai/inference/anthropic/v1/messages?beta=true"
    );
  });

  it("sends a model with no SDK to the completions endpoint", async () => {
    const { url } = await requestFor("opencode", spec("big-pickle"));
    expect(url).toBe(`${OPENCODE_PLANE_API.zen}/chat/completions`);
  });

  it("sends a Google model to the endpoint a hand-declared route cannot name", async () => {
    const { url } = await requestFor(
      "opencode",
      spec("gemini-3.8-flash", "@ai-sdk/google")
    );
    expect(url).toBe(
      "https://opencode.ai/inference/google/v1beta/models/gemini-3.8-flash:streamGenerateContent?alt=sse"
    );
  });

  it("sends a Go-plane model to the Go base", async () => {
    const { url } = await requestFor(
      "opencode-go",
      spec("deepseek-v4-flash", "@ai-sdk/openai")
    );
    expect(url).toBe(`${OPENCODE_PLANE_API.go}/responses`);
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

  it("gives each wire family its own base on the inference family", () => {
    // **Measured from the vendor's `GET /console/api/config`**, not derived. The
    // inference family is NOT one base per plane: anthropic and google each live
    // at their own path, and 26 of the zen catalog's models (18 anthropic, 8
    // google) are reachable only through theirs. Deriving them by stripping `/v1`
    // off one plane URL sent every one of them to `…/inference/openai`.
    expect(BASE_FOR_PROTOCOL).toEqual({
      opencode: {
        "anthropic-messages": "https://opencode.ai/inference/anthropic",
        "google-generative-ai": "https://opencode.ai/inference/google/v1beta",
        "openai-completions": "https://opencode.ai/inference/openai/v1",
        "openai-responses": "https://opencode.ai/inference/openai/v1",
      },
      "opencode-go": {
        "anthropic-messages": "https://opencode.ai/inference/go/anthropic",
        "google-generative-ai":
          "https://opencode.ai/inference/go/google/v1beta",
        "openai-completions": "https://opencode.ai/inference/go/openai/v1",
        "openai-responses": "https://opencode.ai/inference/go/openai/v1",
      },
    });
    // The Anthropic entry is the family's declared base minus its version
    // segment, because pi-ai's SDK appends `/v1/messages` itself.
  });

  it("keeps the legacy family on one base for every protocol", () => {
    // The older family genuinely is one address, which is why it keeps the old
    // derivation while the inference family no longer does.
    for (const plane of ["opencode", "opencode-go"] as const) {
      const zen =
        plane === "opencode"
          ? "https://opencode.ai/zen/v1"
          : "https://opencode.ai/zen/go/v1";
      for (const protocol of [
        "openai-completions",
        "openai-responses",
        "google-generative-ai",
      ]) {
        expect(
          baseForProtocol(plane, protocol, "legacy"),
          `${plane}/${protocol}`
        ).toBe(zen);
      }
      // Anthropic is the one protocol whose base is the family's minus `/v1`.
      expect(baseForProtocol(plane, "anthropic-messages", "legacy")).toBe(
        zen.replace(/\/v1$/, "")
      );
    }
  });

  it("resolves each endpoint family to its own base, and auto as modern", () => {
    // `auto` is an alias of `modern` (the copy says so, test/endpoint-copy);
    // `legacy` pins the older single base per plane, which is the whole point
    // of the setting — the two families are separately entitled.
    expect(baseForProtocol("opencode", "openai-completions", "auto")).toBe(
      OPENCODE_PLANE_API.zen
    );
    expect(baseForProtocol("opencode-go", "openai-completions", "auto")).toBe(
      OPENCODE_PLANE_API.go
    );

    expect(baseForProtocol("opencode", "openai-completions", "legacy")).toBe(
      "https://opencode.ai/zen/v1"
    );
    expect(baseForProtocol("opencode-go", "openai-completions", "legacy")).toBe(
      "https://opencode.ai/zen/go/v1"
    );

    expect(baseForProtocol("opencode", "openai-completions", "modern")).toBe(
      OPENCODE_PLANE_API.zen
    );
    expect(baseForProtocol("opencode-go", "openai-completions", "modern")).toBe(
      OPENCODE_PLANE_API.go
    );
  });

  it("resolves auto exactly as modern on every protocol and plane", () => {
    for (const plane of ["opencode", "opencode-go"] as const) {
      expect(planeBaseFor(plane, "auto")).toBe(planeBaseFor(plane, "modern"));
      const protocols = Object.keys(BASE_FOR_PROTOCOL[plane]);
      expect(protocols.length).toBe(4);
      for (const protocol of protocols) {
        expect(baseForProtocol(plane, protocol, "auto"), protocol).toBe(
          baseForProtocol(plane, protocol, "modern")
        );
      }
    }
  });

  it("keeps the Anthropic base one level shorter on every family", () => {
    for (const family of ENDPOINT_FAMILIES) {
      for (const plane of ["opencode", "opencode-go"] as const) {
        const base = baseForProtocol(plane, "anthropic-messages", family);
        expect(base?.endsWith("/v1"), `${plane}/${family}`).toBe(false);
        expect(base?.endsWith("/v1/messages"), `${plane}/${family}`).toBe(
          false
        );
      }
    }
  });

  it("returns undefined for a plane the table does not carry", () => {
    expect(
      baseForProtocol("nope", "openai-completions", "modern")
    ).toBeUndefined();
  });

  it("hands the model the base its family names", () => {
    const model = {
      context_window: 1000,
      id: "x",
      input_modalities: ["text"],
      max_output_tokens: 100,
      name: "X",
    };
    expect(
      piModelFor("opencode", model, "openai-completions", {}, "legacy").baseUrl
    ).toBe("https://opencode.ai/zen/v1");
    expect(
      piModelFor("opencode", model, "openai-completions", {}, "modern").baseUrl
    ).toBe(OPENCODE_PLANE_API.zen);
    // No family named means the default, auto, which resolves as modern.
    expect(
      piModelFor("opencode", model, "openai-completions", {}).baseUrl
    ).toBe(OPENCODE_PLANE_API.zen);
  });
});

describe("pi-provider · the User-Agent the stream hook sends", () => {
  // 1.19.4's client sends `opencode/<version>` and nothing more -
  // `packages/opencode/src/session/llm/request.ts:18`. The AI SDK stamps its own
  // `ai-sdk/provider-utils/… runtime/bun/…` tail on a request it sends, which is
  // a different transport's signature, not the client's; and 2.x changed the
  // shape again to `opencode/<channel>/<version>/<client>`.
  it("is the CLI's version and nothing else", () => {
    expect(OPENCODE_USER_AGENT).toBe("opencode/1.19.4");
  });
});

describe("pi-provider · the object pi requires", () => {
  // pi's `Model` declares `reasoning: boolean` and `thinkingLevelMap?`, and a
  // model built here may have no entry in pi's installed catalog at all - the
  // spread that was supposed to carry those fields is then an empty object. So
  // the fields pi requires have to be set, not inherited.
  const requiredSpec = {
    context_window: 1_048_576,
    cost: { input: 1, output: 2 },
    id: "x",
    input_modalities: ["text"],
    max_output_tokens: 65_536,
    name: "X",
    reasoning: true,
    reasoning_options: [{ type: "effort", values: ["low", "high"] }],
  };

  it("sets every required field, with no catalog entry to inherit from", () => {
    const model = piModelFor(
      "opencode",
      requiredSpec as never,
      "openai-completions"
    );
    for (const field of [
      "api",
      "baseUrl",
      "contextWindow",
      "cost",
      "id",
      "input",
      "maxTokens",
      "name",
      "provider",
      "reasoning",
    ]) {
      expect(model, field).toHaveProperty(field);
    }
    expect(typeof model.reasoning).toBe("boolean");
  });

  it("says false rather than nothing when a model declares no reasoning", () => {
    const model = piModelFor(
      "opencode",
      {
        ...requiredSpec,
        reasoning: undefined,
        reasoning_options: undefined,
      } as never,
      "openai-completions"
    );
    expect(model.reasoning).toBe(false);
    expect(model.thinkingLevelMap).toBeUndefined();
  });

  it("provides standard thinking levels for models declaring reasoning: true with empty options", () => {
    const map = thinkingLevelMapFor({
      context_window: 204_800,
      id: "minimax-m2.7",
      input_modalities: ["text"],
      max_output_tokens: 131_072,
      name: "MiniMax-M2.7",
      reasoning: true,
      reasoning_options: [],
    });
    expect(map).toEqual({
      off: null,
      minimal: null,
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: null,
      max: null,
    });
  });

  it("provides toggle mapping for models with toggle reasoning option", () => {
    const map = thinkingLevelMapFor({
      context_window: 1_000_000,
      id: "minimax-m3",
      input_modalities: ["text", "image"],
      max_output_tokens: 131_072,
      name: "MiniMax-M3",
      reasoning: true,
      reasoning_options: [{ type: "toggle" }],
    });
    expect(map?.off).toBeNull();
    expect(map?.high).toBe("on");
  });
});
