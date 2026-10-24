/**
 * Every characterized model, on each plane, through the real `LlmRuntime` and
 * the plugin's `PlaneAdapter`, to the mock gateway (P-R1).
 *
 * The host is tier A (`test/support/host.ts`): a real cordis `Context`, the
 * real `llm` service, pi-ai, and the plugin mounted beside them, reading the
 * host's modules through the seam. `globalThis.fetch` is a rewrite of the
 * gateway's origin to the mock's loopback address, and the plugin's own fetch
 * patch wraps it, exactly as it wraps the transport in production. So each
 * case reads what the GATEWAY received: the path its protocol's SDK built on
 * the endpoint family the plane chose, the model, the credential header its
 * protocol authenticates with, and the session the turn carried.
 *
 * The expected protocols and paths are written out here from the vendor facts
 * (`docs/redirect-planes.md`), never read from the module under test.
 *
 * @module test/mock/plane-dispatch.mock
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  CHARACTERIZED_MODELS,
  characterizedProviders,
  fakeCredentials,
  type HostLlm,
  logLines,
  mountTierA,
  PLANES,
  type TierA,
  waitForPlaneOwner,
} from "../support/host.ts";
import { clearCapturedApiKeys, headerValueFor } from "../support/src.ts";
import { startMockGateway, type MockGateway } from "./gateway-server.ts";
import { GO_KEY, ZEN_KEY } from "./helpers.ts";

type Plane = (typeof PLANES)[number];
type Protocol =
  | "anthropic-messages"
  | "google-generative-ai"
  | "openai-completions"
  | "openai-responses";

/** The protocol each characterized id speaks, per plane, from the catalog's SDK. */
const PROTOCOL_OF: Readonly<Record<Plane, Readonly<Record<string, Protocol>>>> =
  {
    opencode: {
      "claude-haiku-5-5": "anthropic-messages",
      "deepseek-v4-pro": "openai-completions",
      "gemini-3-flash": "google-generative-ai",
      "gpt-5.3-codex-spark": "openai-responses",
      "gpt-5.4": "openai-responses",
      "not-in-any-catalog": "openai-completions",
    },
    "opencode-go": {
      "deepseek-v4-pro": "openai-completions",
      "gemini-4-argon-contributor": "google-generative-ai",
      "minimax-m3": "anthropic-messages",
      "minimax-m3.1-flash": "openai-completions",
      "muse-spark-1.2-contributor": "openai-responses",
      "not-in-any-catalog": "openai-completions",
    },
  };

/** The protocol written for an id; a missing row is a broken fixture. */
const protocolOf = (plane: Plane, model: string): Protocol => {
  const protocol = PROTOCOL_OF[plane][model];
  if (protocol === undefined) {
    throw new Error(`no protocol written for ${plane}/${model}`);
  }
  return protocol;
};

/** The path one protocol's request to `model` lands on, per plane, in the default (modern) family. */
const MODERN_PATH = (
  plane: Plane,
  protocol: Protocol,
  model: string
): string => {
  const go = plane === "opencode-go" ? "/go" : "";
  return {
    "anthropic-messages": `/inference${go}/anthropic/v1/messages`,
    "google-generative-ai": `/inference${go}/google/v1beta/models/${model}:streamGenerateContent`,
    "openai-completions": `/inference${go}/openai/v1/chat/completions`,
    "openai-responses": `/inference${go}/openai/v1/responses`,
  }[protocol];
};

/** The same in the legacy family; Go's Google has only the one base. */
const LEGACY_PATH = (
  plane: Plane,
  protocol: Protocol,
  model: string
): string => {
  if (plane === "opencode-go" && protocol === "google-generative-ai") {
    return MODERN_PATH(plane, protocol, model);
  }
  const root = plane === "opencode-go" ? "/zen/go/v1" : "/zen/v1";
  return {
    "anthropic-messages": `${root}/messages`,
    "google-generative-ai": `${root}/models/${model}:streamGenerateContent`,
    "openai-completions": `${root}/chat/completions`,
    "openai-responses": `${root}/responses`,
  }[protocol];
};

/** The header each protocol carries its credential in, and its value. */
const credentialOf = (
  protocol: Protocol,
  key: string
): readonly [string, string] => {
  if (protocol === "anthropic-messages") {
    return ["x-api-key", key];
  }
  if (protocol === "google-generative-ai") {
    return ["x-goog-api-key", key];
  }
  return ["authorization", `Bearer ${key}`];
};

/** The URL a `fetch` input names. */
const urlOf = (input: RequestInfo | URL): string => {
  if (typeof input === "string") {
    return input;
  }
  return input instanceof URL ? input.href : input.url;
};

const keyOf = (plane: Plane): string =>
  plane === "opencode" ? ZEN_KEY : GO_KEY;

/** The DSH session every turn here runs in, and the header it becomes. */
const SESSION = "plane-dispatch-session";

let gateway: MockGateway;
let tier: TierA | undefined;

beforeAll(async () => {
  gateway = await startMockGateway();
});

afterAll(async () => {
  await gateway.close();
});

beforeEach(() => {
  gateway.requests.length = 0;
  clearCapturedApiKeys();
});

afterEach(async () => {
  await tier?.dispose();
  tier = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const realFetch = globalThis.fetch;

/** Mount tier A with the plugin, the profile and both plane keys. */
const mount = async (
  providers: Record<string, unknown>,
  plugin: Record<string, unknown> = {}
): Promise<HostLlm> => {
  vi.spyOn(console, "info").mockImplementation(() => {
    // Silenced: the activation line.
  });
  vi.stubGlobal("fetch", ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = urlOf(input);
    if (url.startsWith("https://opencode.ai/")) {
      return realFetch(
        url.replace("https://opencode.ai", gateway.origin),
        init
      );
    }
    if (url.startsWith(gateway.origin)) {
      return realFetch(url, init);
    }
    return Promise.reject(
      new TypeError(`plane-dispatch: refused a request to ${url}`)
    );
  }) as typeof fetch);
  tier = await mountTierA({
    credentials: fakeCredentials({
      refs: { OPENCODE_API_KEY: ZEN_KEY, OPENCODE_GO_API_KEY: GO_KEY },
    }),
    plugin,
    providers,
  });
  await waitForPlaneOwner(
    tier.llm,
    PLANES.filter((plane) => plane in providers)
  );
  return tier.llm;
};

/** One turn through the host's stream path; answers its chunks. */
const turn = async (
  llm: HostLlm,
  provider: string,
  model: string,
  extra: Record<string, unknown> = {}
): Promise<Record<string, unknown>[]> => {
  const chunks: Record<string, unknown>[] = [];
  for await (const chunk of llm.stream({
    messages: [{ content: [{ text: "hi", type: "text" }], role: "user" }],
    model,
    provider,
    sessionId: SESSION,
    signal: AbortSignal.timeout(10_000),
    ...extra,
  } as never)) {
    chunks.push(chunk as Record<string, unknown>);
  }
  return chunks;
};

describe("plane dispatch · the default (modern) family", () => {
  it.each(PLANES)(
    "%s: every characterized id reaches its protocol's path with its model, the plane's key and the turn's session",
    async (plane) => {
      const llm = await mount(characterizedProviders());
      for (const model of CHARACTERIZED_MODELS[plane]) {
        const protocol = protocolOf(plane, model);
        const before = gateway.requests.length;
        await turn(llm, plane, model);
        const sent = gateway.requests.slice(before);
        expect(
          sent.map((request) => request.path),
          `${plane}/${model}`
        ).toEqual([MODERN_PATH(plane, protocol, model)]);
        const [request] = sent;
        if (protocol !== "google-generative-ai") {
          expect((request?.body as { model?: string })?.model).toBe(model);
        }
        const [header, value] = credentialOf(protocol, keyOf(plane));
        expect(request?.headers[header], `${plane}/${model} ${header}`).toBe(
          value
        );
        expect(request?.headers["x-opencode-session"]).toBe(
          headerValueFor(SESSION)
        );
      }
    }
  );
});

describe("plane dispatch · the legacy family and a route-level base", () => {
  it.each(PLANES)(
    "%s with endpoint: legacy: the legacy paths, Go's Google on its one base",
    async (plane) => {
      const llm = await mount(characterizedProviders(), { endpoint: "legacy" });
      for (const model of CHARACTERIZED_MODELS[plane]) {
        const protocol = protocolOf(plane, model);
        const before = gateway.requests.length;
        await turn(llm, plane, model);
        expect(
          gateway.requests.slice(before).map((request) => request.path),
          `${plane}/${model}`
        ).toEqual([LEGACY_PATH(plane, protocol, model)]);
      }
    }
  );

  it("a route-level vendor base on /zen selects the legacy family under the default endpoint", async () => {
    const providers = characterizedProviders();
    providers.opencode!.baseURL = "https://opencode.ai/zen/v1";
    const llm = await mount(providers);
    for (const model of ["deepseek-v4-pro", "gpt-5.4", "claude-haiku-5-5"]) {
      const protocol = protocolOf("opencode", model);
      const before = gateway.requests.length;
      await turn(llm, "opencode", model);
      expect(
        gateway.requests.slice(before).map((request) => request.path)
      ).toEqual([LEGACY_PATH("opencode", protocol, model)]);
    }
  });

  it("a foreign route-level base is used as written, Anthropic's without its /v1", async () => {
    const llm = await mount({
      opencode: {
        apiKeyEnv: "OPENCODE_API_KEY",
        baseURL: `${gateway.origin}/proxy/v1`,
        models: [{ id: "deepseek-v4-pro" }, { id: "claude-haiku-5-5" }],
      },
    });
    for (const [model, path] of [
      ["deepseek-v4-pro", "/proxy/v1/chat/completions"],
      ["claude-haiku-5-5", "/proxy/v1/messages"],
    ] as const) {
      const before = gateway.requests.length;
      await turn(llm, "opencode", model);
      expect(
        gateway.requests.slice(before).map((request) => request.path)
      ).toEqual([path]);
    }
  });
});

describe("plane dispatch · the toggle model's Off and On (D1)", () => {
  // One toggle model per protocol the shipped catalog has one for: Anthropic
  // on each plane, and completions in a disabling dialect (pi files Zen
  // kimi-k2.6 with one). The catalog has no toggle model on Responses or
  // Google, so neither is exercised here. The picker's Off is `off` and its
  // On is `high` (D1); each body is asserted whole, so an On that sent no
  // reasoning, or the wrong field, is red.
  it.each([
    ["opencode", "kimi-k2.6", "openai-completions", { type: "enabled" }],
    [
      "opencode",
      "qwen3.5-plus",
      "anthropic-messages",
      { budget_tokens: 16_384, display: "summarized", type: "enabled" },
    ],
    [
      "opencode-go",
      "minimax-m3",
      "anthropic-messages",
      { budget_tokens: 16_384, display: "summarized", type: "enabled" },
    ],
  ] as const)(
    "%s %s (%s) sends an explicit disable for Off and an enable for On",
    async (plane, model, protocol, on) => {
      const llm = await mount({
        [plane]: {
          apiKeyEnv:
            plane === "opencode" ? "OPENCODE_API_KEY" : "OPENCODE_GO_API_KEY",
          models: [{ id: model }],
        },
      });
      const info = (await llm.resolveModelInfo(plane, model)) as {
        reasoning?: { efforts?: { id: string; name: string }[] };
      };
      expect(info.reasoning?.efforts).toEqual([
        { id: "off", name: "Off" },
        { id: "high", name: "On" },
      ]);
      const sent: { path: string; thinking: unknown }[] = [];
      for (const reasoningEffort of ["off", "high"]) {
        const before = gateway.requests.length;
        await turn(llm, plane, model, { reasoningEffort });
        const [request] = gateway.requests.slice(before);
        sent.push({
          path: request?.path ?? "",
          thinking: (request?.body as { thinking?: unknown } | undefined)
            ?.thinking,
        });
      }
      const path = MODERN_PATH(plane, protocol, model);
      expect(sent).toEqual([
        { path, thinking: { type: "disabled" } },
        { path, thinking: on },
      ]);
    }
  );
});

describe("plane dispatch · Go Gemini replay stays on one provider label", () => {
  it("a Go Gemini turn's replay state is the plane's own, and the next turn replays the signed tool call natively", async () => {
    // Driven by its own responder rather than the gateway's canned stream: the
    // first answer is a signed tool call, the second plain text.
    const wire: { url: string; body: { contents?: { parts?: object[] }[] } }[] =
      [];
    vi.spyOn(console, "info").mockImplementation(() => {
      // Silenced: the activation line.
    });
    vi.stubGlobal("fetch", (async (
      input: RequestInfo | URL,
      init?: RequestInit
    ) => {
      const url = urlOf(input);
      if (!url.startsWith("https://opencode.ai/")) {
        throw new TypeError(`plane-dispatch: refused a request to ${url}`);
      }
      wire.push({
        body: JSON.parse(typeof init?.body === "string" ? init.body : "{}"),
        url,
      });
      const parts =
        wire.length === 1
          ? [
              {
                functionCall: { args: { item: "sample" }, name: "lookup" },
                thoughtSignature: "c2lnbmVkLXRvb2wtZml4dHVyZQ==",
              },
            ]
          : [{ text: "The result is 42." }];
      return new Response(
        `data: ${JSON.stringify({
          candidates: [
            { content: { parts, role: "model" }, finishReason: "STOP" },
          ],
          usageMetadata: {
            candidatesTokenCount: 3,
            promptTokenCount: 10,
            totalTokenCount: 13,
          },
        })}\n\n`,
        { headers: { "content-type": "text/event-stream" } }
      );
    }) as typeof fetch);
    let log: ReturnType<typeof logLines> | undefined;
    tier = await mountTierA({
      before: (root) => {
        log = logLines(root);
      },
      credentials: fakeCredentials({ refs: { OPENCODE_GO_API_KEY: GO_KEY } }),
      plugin: {},
      providers: {
        "opencode-go": {
          apiKeyEnv: "OPENCODE_GO_API_KEY",
          models: [{ id: "gemini-4-argon-contributor" }],
        },
      },
    });
    await waitForPlaneOwner(tier.llm, ["opencode-go"]);
    const model = "gemini-4-argon-contributor";
    const tools = [
      {
        description: "Read a sample value",
        name: "lookup",
        parameters: {
          properties: { item: { type: "string" } },
          required: ["item"],
          type: "object",
        },
      },
    ];
    const messages: unknown[] = [
      { content: [{ text: "Look up sample.", type: "text" }], role: "user" },
    ];
    const first = await turn(tier.llm, "opencode-go", model, {
      messages,
      tools,
    });
    const finish = first.find((chunk) => chunk.type === "finish") as {
      reason: { kind: string };
      replayState: { blocks: unknown[]; [key: string]: unknown };
    };
    expect(finish.reason.kind).toBe("tool-calls");
    expect(JSON.stringify(finish.replayState)).toContain('"opencode-go"');
    expect(JSON.stringify(finish.replayState)).not.toContain(
      "opencode-go-google"
    );
    const blocks = first
      .filter((chunk) => chunk.type === "block-end")
      .map((chunk) => chunk.block as { type: string; id: string });
    const call = blocks.find((block) => block.type === "tool-call");
    messages.push(
      {
        content: blocks,
        role: "assistant",
        source: {
          model,
          provider: "opencode-go",
          replayState: finish.replayState,
        },
      },
      {
        content: [{ text: "42", type: "text" }],
        role: "tool",
        toolCallId: call?.id,
      }
    );
    const second = await turn(tier.llm, "opencode-go", model, {
      messages,
      tools,
    });
    expect(
      (
        second.find((chunk) => chunk.type === "finish") as {
          reason: { kind: string };
        }
      ).reason.kind
    ).toBe("stop");
    expect(wire).toHaveLength(2);
    for (const request of wire) {
      expect(request.url).toBe(
        `https://opencode.ai/inference/go/google/v1beta/models/${model}:streamGenerateContent?alt=sse`
      );
    }
    const replayed = (wire[1]?.body.contents ?? []).flatMap(
      (content) =>
        (content.parts ?? []) as {
          thoughtSignature?: string;
          functionCall?: object;
        }[]
    );
    expect(
      replayed.some(
        (part) =>
          part.functionCall !== undefined &&
          part.thoughtSignature === "c2lnbmVkLXRvb2wtZml4dHVyZQ=="
      )
    ).toBe(true);
    // The replay-degrade warning goes through the host logger: read every
    // line it took, and prove the read with a line of our own.
    tier.ctx.logger.info("[plane-dispatch] the log is read");
    const lines = log?.lines() ?? [];
    expect(lines.at(-1)).toContain("[plane-dispatch] the log is read");
    expect(
      lines.filter((line) => line.includes("unusable replay state"))
    ).toEqual([]);
    log?.dispose();
  });
});
