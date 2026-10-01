import { AsyncLocalStorage } from "node:async_hooks";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  type ActiveTurnState,
  type CordisContext,
  apply,
  discoverGoConfig,
  DUMMY_BASH_TOOL,
  DUMMY_READ_TOOL,
  GoUsageService,
  headerValueFor,
  hasSessionHeader,
  isOpenCodeRequest,
  name as PLUGIN_NAME,
  openCodeSessionIdFor,
  OPENCODE_UA,
  parseGoUsage,
  patchFetch,
  resolveConfig,
  SESSION_HEADER,
  usageRemote,
  withStore,
} from "../src/index.ts";

const SESSION_RE = /^ses_[0-9a-f]{12}[A-Za-z0-9]{14}$/;

const createMockStream = async function* createMockStream(chunk: string) {
  yield chunk;
};

const createMockStoreStream = async function* createMockStoreStream(
  als: AsyncLocalStorage<ActiveTurnState>
) {
  yield als.getStore()?.value;
  yield als.getStore()?.value;
};

const isRecord = (value: unknown): value is Record<string, unknown> => {
  if (value === null || value === undefined) {
    return false;
  }
  if (typeof value !== "object") {
    return false;
  }
  return !Array.isArray(value);
};

const toolNamesOf = (body: unknown): string[] | undefined => {
  if (!isRecord(body)) {
    return undefined;
  }
  const tools: unknown = body.tools;
  if (!Array.isArray(tools)) {
    return undefined;
  }
  const names: string[] = [];
  for (const tool of tools) {
    if (isRecord(tool) && typeof tool.name === "string") {
      names.push(tool.name);
    }
  }
  return names;
};

const parseJsonBody = (body: unknown): unknown => {
  if (typeof body !== "string") {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(body);
    return parsed;
  } catch {
    return undefined;
  }
};

const isAsyncIterableLike = (
  value: unknown
): value is AsyncIterable<unknown> => {
  if (value === null || value === undefined) {
    return false;
  }
  if (typeof value !== "object" && typeof value !== "function") {
    return false;
  }
  if (!(Symbol.asyncIterator in value)) {
    return false;
  }
  return typeof value[Symbol.asyncIterator] === "function";
};

const collectUnknown = async (
  iterable: AsyncIterable<unknown>
): Promise<unknown[]> => {
  const out: unknown[] = [];
  for await (const chunk of iterable) {
    out.push(chunk);
  }
  return out;
};

const waitForFileContent = async (
  file: string,
  minLines = 1,
  timeoutMs = 5000
): Promise<string> => {
  const start = Date.now();
  let last = "";
  while (Date.now() - start < timeoutMs) {
    try {
      const content = await readFile(file, "utf-8");
      const lines = content
        .trim()
        .split("\n")
        .filter((l) => l.length > 0);
      if (lines.length >= minLines) {
        return content;
      }
      last = content;
    } catch {
      // not yet written
    }
    await sleep(25);
  }
  throw new Error(
    `timed out waiting for ${minLines} line(s) in ${file} (last: ${JSON.stringify(last)})`
  );
};

interface Capture {
  init: RequestInit | undefined;
  url: string;
}

const replacementFetch = (): Promise<Response> =>
  Promise.resolve(new Response("replacement"));

const createCaptureFetch = (text = "ok") => {
  const capture: Capture = { init: undefined, url: "" };
  const mockFetch = (
    input: RequestInfo | URL,
    init?: RequestInit
  ): Promise<Response> => {
    if (typeof input === "string") {
      capture.url = input;
    } else if (input instanceof URL) {
      capture.url = input.toString();
    } else {
      capture.url = input.url;
    }
    capture.init = init;
    return Promise.resolve(new Response(text));
  };
  return { capture, mockFetch };
};

const headerOf = (init: RequestInit | undefined, field: string) =>
  new Headers(init?.headers).get(field);

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.OPENCODE_SESSION_ID;
});

describe("openCodeSessionIdFor", () => {
  it("generates a valid OpenCode session ID matching the exact regex format", () => {
    const id = openCodeSessionIdFor("c2a51fb0-578c-4019-80c4-868eff95fd08");
    expect(id).toMatch(SESSION_RE);
    expect(id.length).toBe(30);
  });

  it("is deterministic for identical inputs", () => {
    expect(openCodeSessionIdFor("conversation-alpha-123")).toBe(
      openCodeSessionIdFor("conversation-alpha-123")
    );
  });

  it("handles numeric session IDs identically to their string form", () => {
    const id = openCodeSessionIdFor(123_456_789);
    expect(id).toBe(openCodeSessionIdFor("123456789"));
    expect(id).toMatch(/^ses_/);
  });

  it("produces a valid ID for empty input without throwing", () => {
    expect(openCodeSessionIdFor("")).toMatch(SESSION_RE);
  });

  it("generates unique session IDs across deterministic inputs", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i += 1) {
      const id = openCodeSessionIdFor(`deterministic-session-${i}`);
      expect(seen.has(id)).toBe(false);
      seen.add(id);
    }
    expect(seen.size).toBe(200);
  });

  it("maps distinct conversations to distinct session IDs", () => {
    expect(openCodeSessionIdFor("session-a")).not.toBe(
      openCodeSessionIdFor("session-b")
    );
  });
});

describe("resolveConfig", () => {
  it("fills default providers, toggles, and debug flags", () => {
    const resolved = resolveConfig({});
    expect([...resolved.providers]).toEqual(["opencode", "opencode-go"]);
    expect(resolved.debug).toBe(false);
    expect(resolved.debugFile).toBeUndefined();
    expect(resolved.injectUserAgent).toBe(true);
    expect(resolved.userAgent).toBeUndefined();
    expect(resolved.injectOriginHeaders).toBe(true);
    expect(resolved.injectCoreTools).toBe(true);
  });

  it("preserves custom providers and configuration overrides", () => {
    const resolved = resolveConfig({
      debug: true,
      debugFile: "/tmp/debug.log",
      injectCoreTools: false,
      injectOriginHeaders: false,
      injectUserAgent: false,
      providers: ["custom-opencode", "opencode-dev"],
      userAgent: "my-custom-ua/1.0",
    });
    expect([...resolved.providers]).toEqual([
      "custom-opencode",
      "opencode-dev",
    ]);
    expect(resolved.debug).toBe(true);
    expect(resolved.debugFile).toBe("/tmp/debug.log");
    expect(resolved.injectUserAgent).toBe(false);
    expect(resolved.userAgent).toBe("my-custom-ua/1.0");
    expect(resolved.injectOriginHeaders).toBe(false);
    expect(resolved.injectCoreTools).toBe(false);
  });

  it("falls back to defaults when providers list is empty or blank", () => {
    expect([...resolveConfig({ providers: [] }).providers]).toEqual([
      "opencode",
      "opencode-go",
    ]);
    expect([...resolveConfig({ providers: [""] }).providers]).toEqual([
      "opencode",
      "opencode-go",
    ]);
  });

  it("trims userAgent and treats blank debugFile as unset", () => {
    const resolved = resolveConfig({
      debugFile: "",
      userAgent: "  custom-ua/2.0  ",
    });
    expect(resolved.userAgent).toBe("custom-ua/2.0");
    expect(resolved.debugFile).toBeUndefined();
  });
});

describe("isOpenCodeRequest (endpoint differentiation)", () => {
  const providers = new Set(["opencode", "opencode-go"]);

  it("identifies opencode.ai/zen endpoints", () => {
    expect(
      isOpenCodeRequest(
        "https://opencode.ai/zen/v1/responses",
        undefined,
        providers
      )
    ).toBe(true);
    expect(
      isOpenCodeRequest(
        "https://opencode.ai/zen/go/v1/chat/completions",
        undefined,
        providers
      )
    ).toBe(true);
  });

  it("identifies zen endpoints even when providers set is empty", () => {
    expect(
      isOpenCodeRequest(
        "https://opencode.ai/zen/v1/responses",
        undefined,
        new Set()
      )
    ).toBe(true);
  });

  it("identifies active turn state when routed to matching provider", () => {
    const state: ActiveTurnState = {
      provider: "opencode",
      value: "ses_123",
    };
    expect(
      isOpenCodeRequest("https://my-custom-relay.example/v1", state, providers)
    ).toBe(true);
  });

  it("rejects non-OpenCode requests", () => {
    expect(
      isOpenCodeRequest(
        "https://api.deepseek.com/v1/chat/completions",
        undefined,
        providers
      )
    ).toBe(false);
    expect(
      isOpenCodeRequest(
        "https://api.openai.com/v1/chat/completions",
        undefined,
        providers
      )
    ).toBe(false);
    const nonOpencodeState: ActiveTurnState = {
      provider: "deepseek",
      value: "ses_456",
    };
    expect(
      isOpenCodeRequest(
        "https://api.deepseek.com/v1",
        nonOpencodeState,
        providers
      )
    ).toBe(false);
  });
});

describe("headerValueFor", () => {
  it("derives the same session id on every call without a table", () => {
    const val1 = headerValueFor("dsh-uuid-1");
    expect(val1).toMatch(/^ses_/);

    const val2 = headerValueFor("dsh-uuid-1");
    expect(val2).toBe(val1);
  });

  it("returns undefined for empty, null, or undefined session inputs", () => {
    const missing: string | number | undefined = undefined;
    expect(headerValueFor("")).toBeUndefined();
    expect(headerValueFor(missing)).toBeUndefined();
    expect(headerValueFor(null)).toBeUndefined();
  });

  it("accepts numeric session IDs", () => {
    const value = headerValueFor(987_654);
    expect(value).toMatch(/^ses_/);
  });

  it("derives ses_ IDs even for UUID-shaped input", () => {
    const raw = "c2a51fb0-578c-4019-80c4-868eff95fd08";
    const value = headerValueFor(raw);
    expect(value).toMatch(SESSION_RE);
    expect(value).not.toBe(raw);
  });
});

describe("hasSessionHeader", () => {
  it("detects x-opencode-session in Headers object case-insensitively", () => {
    const headers = new Headers();
    headers.set("X-OpenCode-Session", "ses_mock_header");
    expect(hasSessionHeader("http://example.com", { headers })).toBe(true);
  });

  it("detects x-opencode-session in plain object headers", () => {
    expect(
      hasSessionHeader("http://example.com", {
        headers: { [SESSION_HEADER]: "ses_mock_header" },
      })
    ).toBe(true);
  });

  it("detects x-opencode-session carried by a Request object", () => {
    const req = new Request("http://example.com", {
      headers: { [SESSION_HEADER]: "ses_from_request" },
    });
    expect(hasSessionHeader(req)).toBe(true);
  });

  it("returns false when header is absent", () => {
    expect(
      hasSessionHeader("http://example.com", {
        headers: { "Content-Type": "application/json" },
      })
    ).toBe(false);
    expect(hasSessionHeader("http://example.com")).toBe(false);
  });
});

describe("withStore", () => {
  it("wraps and drives an async iterable inside AsyncLocalStorage context", async () => {
    const als = new AsyncLocalStorage<ActiveTurnState>();
    const wrapped = withStore(
      createMockStoreStream(als),
      { provider: "opencode", value: "store-context-42" },
      als
    );
    const results: unknown[] = [];
    for await (const value of wrapped) {
      results.push(value);
    }
    expect(results).toEqual(["store-context-42", "store-context-42"]);
  });

  it("handles early return on the wrapped iterator", async () => {
    const als = new AsyncLocalStorage<ActiveTurnState>();
    let returned = false;

    const mockIterable: AsyncIterable<number> = {
      [Symbol.asyncIterator]() {
        return {
          next: () => Promise.resolve({ done: false, value: 1 }),
          return: () => {
            returned = true;
            return Promise.resolve({ done: true, value: undefined });
          },
        };
      },
    };

    const wrapped = withStore(
      mockIterable,
      { provider: "opencode", value: "test" },
      als
    );
    const iterator = wrapped[Symbol.asyncIterator]();
    const first = await iterator.next();
    expect(first.value).toBe(1);
    await iterator.return?.();
    expect(returned).toBe(true);
  });

  it("propagates throw through the wrapped iterator with context", async () => {
    const als = new AsyncLocalStorage<ActiveTurnState>();
    const failure = new Error("downstream-boom");
    const mockIterable: AsyncIterable<number> = {
      [Symbol.asyncIterator]() {
        return {
          next: () => Promise.resolve({ done: false, value: 1 }),
          throw: () => Promise.reject(failure),
        };
      },
    };
    const wrapped = withStore(
      mockIterable,
      { provider: "opencode", value: "throw-ctx" },
      als
    );
    const iterator = wrapped[Symbol.asyncIterator]();
    await expect(iterator.throw?.(failure)).rejects.toBe(failure);
  });

  it("passes through iterables whose factory yields no iterator", () => {
    const als = new AsyncLocalStorage<ActiveTurnState>();
    const passthrough: AsyncIterable<string> = {
      // @ts-expect-error -- intentionally broken factory to verify passthrough
      [Symbol.asyncIterator]() {
        return null;
      },
    };
    const wrapped = withStore(
      passthrough,
      { provider: "opencode", value: "x" },
      als
    );
    expect(wrapped).toBe(passthrough);
  });
});

describe("patchFetch", () => {
  it("passes non-OpenCode requests through completely untouched", async () => {
    const als = new AsyncLocalStorage<ActiveTurnState>();
    const { capture, mockFetch } = createCaptureFetch("upstream-ok");

    const patched = patchFetch(mockFetch, als, resolveConfig());
    const res = await patched("https://api.deepseek.com/v1/chat/completions", {
      body: JSON.stringify({ message: "hello" }),
      headers: { "X-Custom-Header": "original" },
      method: "POST",
    });

    expect(await res.text()).toBe("upstream-ok");
    expect(capture.url).toBe("https://api.deepseek.com/v1/chat/completions");
    expect(headerOf(capture.init, "X-Custom-Header")).toBe("original");
    expect(headerOf(capture.init, "User-Agent")).toBeNull();
    expect(headerOf(capture.init, "x-opencode-client")).toBeNull();
    expect(headerOf(capture.init, "x-opencode-project")).toBeNull();
    expect(headerOf(capture.init, SESSION_HEADER)).toBeNull();
  });

  it("injects origin headers and dynamic session ID for zen requests", async () => {
    const als = new AsyncLocalStorage<ActiveTurnState>();
    const { capture, mockFetch } = createCaptureFetch();
    const testSession = openCodeSessionIdFor("test-dynamic-turn");

    const patched = patchFetch(mockFetch, als, resolveConfig());
    await als.run({ provider: "opencode", value: testSession }, async () => {
      await patched("https://opencode.ai/zen/v1/chat/completions", {
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
    });

    expect(headerOf(capture.init, "User-Agent")).toBe(OPENCODE_UA);
    expect(headerOf(capture.init, "x-opencode-client")).toBe("cli");
    expect(headerOf(capture.init, "x-opencode-project")).toBe("global");
    expect(headerOf(capture.init, SESSION_HEADER)).toBe(testSession);
  });

  it("injects for configured custom relays when turn state matches", async () => {
    const als = new AsyncLocalStorage<ActiveTurnState>();
    const { capture, mockFetch } = createCaptureFetch();
    const config = resolveConfig({ providers: ["my-relay"] });
    const patched = patchFetch(mockFetch, als, config);

    await als.run({ provider: "my-relay", value: "ses_relay_1" }, async () => {
      await patched("https://relay.internal/v1/chat", { method: "POST" });
    });
    expect(headerOf(capture.init, SESSION_HEADER)).toBe("ses_relay_1");

    const { capture: capture2, mockFetch: mockFetch2 } = createCaptureFetch();
    const patched2 = patchFetch(mockFetch2, als, config);
    await als.run({ provider: "other", value: "ses_other" }, async () => {
      await patched2("https://relay.internal/v1/chat", { method: "POST" });
    });
    expect(headerOf(capture2.init, SESSION_HEADER)).toBeNull();
  });

  it("supports Request and URL inputs", async () => {
    const als = new AsyncLocalStorage<ActiveTurnState>();
    const testSession = openCodeSessionIdFor("input-shapes");
    const config = resolveConfig();
    const { capture: c1, mockFetch: m1 } = createCaptureFetch();
    const patched1 = patchFetch(m1, als, config);
    await als.run({ provider: "opencode", value: testSession }, async () => {
      await patched1(
        new Request("https://opencode.ai/zen/v1/responses", {
          headers: { "Content-Type": "application/json" },
          method: "POST",
        })
      );
    });
    expect(headerOf(c1.init, SESSION_HEADER)).toBe(testSession);

    const { capture: c2, mockFetch: m2 } = createCaptureFetch();
    const patched2 = patchFetch(m2, als, config);
    await als.run({ provider: "opencode", value: testSession }, async () => {
      await patched2(new URL("https://opencode.ai/zen/v1/responses"), {
        method: "POST",
      });
    });
    expect(c2.url).toBe("https://opencode.ai/zen/v1/responses");
    expect(headerOf(c2.init, SESSION_HEADER)).toBe(testSession);
  });

  it("preserves an existing valid session header and uses env fallback otherwise", async () => {
    const als = new AsyncLocalStorage<ActiveTurnState>();
    const config = resolveConfig();

    const { capture: keep, mockFetch: keepFetch } = createCaptureFetch();
    await patchFetch(
      keepFetch,
      als,
      config
    )("https://opencode.ai/zen/v1/responses", {
      headers: { [SESSION_HEADER]: "ses_existing_valid_01" },
    });
    expect(headerOf(keep.init, SESSION_HEADER)).toBe("ses_existing_valid_01");

    process.env.OPENCODE_SESSION_ID = "ses_env_fallback_02";
    const { capture: envCap, mockFetch: envFetch } = createCaptureFetch();
    await patchFetch(
      envFetch,
      als,
      config
    )("https://opencode.ai/zen/v1/responses", {
      headers: { [SESSION_HEADER]: "bogus" },
    });
    expect(headerOf(envCap.init, SESSION_HEADER)).toBe("ses_env_fallback_02");
  });

  it("respects injectUserAgent false and custom userAgent override", async () => {
    const als = new AsyncLocalStorage<ActiveTurnState>();

    const { capture: kept, mockFetch: keptFetch } = createCaptureFetch();
    await als.run({ provider: "opencode", value: "ses_test" }, async () => {
      await patchFetch(
        keptFetch,
        als,
        resolveConfig({ injectUserAgent: false })
      )("https://opencode.ai/zen/v1/chat/completions", {
        headers: { "User-Agent": "custom-unmodified-ua" },
        method: "POST",
      });
    });
    expect(headerOf(kept.init, "User-Agent")).toBe("custom-unmodified-ua");
    expect(headerOf(kept.init, SESSION_HEADER)).toBe("ses_test");

    const { capture: over, mockFetch: overFetch } = createCaptureFetch();
    await als.run({ provider: "opencode", value: "ses_test" }, async () => {
      await patchFetch(
        overFetch,
        als,
        resolveConfig({
          injectUserAgent: true,
          userAgent: "my-custom-cli/3.0.0",
        })
      )("https://opencode.ai/zen/v1/chat/completions", { method: "POST" });
    });
    expect(headerOf(over.init, "User-Agent")).toBe("my-custom-cli/3.0.0");
  });

  it("respects injectOriginHeaders false", async () => {
    const als = new AsyncLocalStorage<ActiveTurnState>();
    const { capture, mockFetch } = createCaptureFetch();
    const patched = patchFetch(
      mockFetch,
      als,
      resolveConfig({ injectOriginHeaders: false })
    );
    await als.run({ provider: "opencode", value: "ses_test" }, async () => {
      await patched("https://opencode.ai/zen/v1/chat/completions", {
        method: "POST",
      });
    });
    expect(headerOf(capture.init, "x-opencode-client")).toBeNull();
    expect(headerOf(capture.init, "x-opencode-project")).toBeNull();
    expect(headerOf(capture.init, SESSION_HEADER)).toBe("ses_test");
  });

  it("injects read and bash tools for free-tier /responses models", async () => {
    const als = new AsyncLocalStorage<ActiveTurnState>();
    const { capture, mockFetch } = createCaptureFetch();
    const testSession = openCodeSessionIdFor("test-free-turn");
    const patched = patchFetch(mockFetch, als, resolveConfig());

    await als.run({ provider: "opencode", value: testSession }, async () => {
      await patched("https://opencode.ai/zen/v1/responses", {
        body: JSON.stringify({
          input: [{ content: "hi", role: "user" }],
          model: "muse-spark-1.3-contributor-free",
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
    });

    expect(headerOf(capture.init, "content-length")).not.toBeNull();
    expect(typeof capture.init?.body).toBe("string");
    const names = toolNamesOf(parseJsonBody(capture.init?.body));
    expect(names).toEqual([DUMMY_READ_TOOL.name, DUMMY_BASH_TOOL.name]);
  });

  it("skips tool injection for paid models, other paths, and invalid JSON", async () => {
    const als = new AsyncLocalStorage<ActiveTurnState>();
    const testSession = openCodeSessionIdFor("skip-cases");
    const run = async (url: string, body: string) => {
      const { capture, mockFetch } = createCaptureFetch();
      await als.run({ provider: "opencode", value: testSession }, async () => {
        await patchFetch(
          mockFetch,
          als,
          resolveConfig()
        )(url, {
          body,
          headers: { "Content-Type": "application/json" },
          method: "POST",
        });
      });
      return capture.init?.body;
    };

    const paid = await run(
      "https://opencode.ai/zen/v1/responses",
      JSON.stringify({ input: "hi", model: "gpt-5-paid" })
    );
    expect(toolNamesOf(parseJsonBody(paid))).toBeUndefined();

    const chat = await run(
      "https://opencode.ai/zen/v1/chat/completions",
      JSON.stringify({ input: "hi", model: "muse-spark-1.3-contributor-free" })
    );
    expect(toolNamesOf(parseJsonBody(chat))).toBeUndefined();

    const invalid = await run(
      "https://opencode.ai/zen/v1/responses",
      "{not-json"
    );
    expect(invalid).toBe("{not-json");
  });

  it("respects injectCoreTools false", async () => {
    const als = new AsyncLocalStorage<ActiveTurnState>();
    const { capture, mockFetch } = createCaptureFetch();
    const patched = patchFetch(
      mockFetch,
      als,
      resolveConfig({ injectCoreTools: false })
    );
    await als.run({ provider: "opencode", value: "ses_test" }, async () => {
      await patched("https://opencode.ai/zen/v1/responses", {
        body: JSON.stringify({
          input: [{ content: "hi", role: "user" }],
          model: "muse-spark-1.3-contributor-free",
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
    });
    expect(toolNamesOf(parseJsonBody(capture.init?.body))).toBeUndefined();
  });

  it("does not duplicate tools and handles Buffer bodies", async () => {
    const als = new AsyncLocalStorage<ActiveTurnState>();
    const testSession = openCodeSessionIdFor("test-partial-turn");
    const { capture, mockFetch } = createCaptureFetch();
    const patched = patchFetch(mockFetch, als, resolveConfig());

    await als.run({ provider: "opencode", value: testSession }, async () => {
      await patched("https://opencode.ai/zen/v1/responses", {
        body: JSON.stringify({
          input: "run command",
          model: "muse-spark-1.3-contributor-free",
          tools: [{ name: "bash", type: "function" }],
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
    });
    const names = toolNamesOf(parseJsonBody(capture.init?.body));
    expect(names?.filter((n) => n === "bash")).toHaveLength(1);
    expect(names?.filter((n) => n === "read")).toHaveLength(1);

    const { capture: bufCap, mockFetch: bufFetch } = createCaptureFetch();
    const bufPatched = patchFetch(bufFetch, als, resolveConfig());
    const payload = Buffer.from(
      JSON.stringify({
        input: "test buffer",
        model: "muse-spark-1.3-contributor-free",
      }),
      "utf-8"
    );
    await als.run({ provider: "opencode", value: testSession }, async () => {
      await bufPatched("https://opencode.ai/zen/v1/responses", {
        body: payload,
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
    });
    expect(typeof bufCap.init?.body).toBe("string");
    expect(toolNamesOf(parseJsonBody(bufCap.init?.body))).toHaveLength(2);

    const { capture: fullCap, mockFetch: fullFetch } = createCaptureFetch();
    await als.run({ provider: "opencode", value: testSession }, async () => {
      await patchFetch(
        fullFetch,
        als,
        resolveConfig()
      )("https://opencode.ai/zen/v1/responses", {
        body: JSON.stringify({
          input: "hi",
          model: "muse-spark-1.3-contributor-free",
          tools: [
            { name: "read", type: "function" },
            { name: "bash", type: "function" },
          ],
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
    });
    expect(toolNamesOf(parseJsonBody(fullCap.init?.body))).toHaveLength(2);
  });
});

describe("apply (plugin lifecycle)", () => {
  it("patches globalThis.fetch and restores it on disposer call", () => {
    const originalFetch = globalThis.fetch;
    let disposer: unknown;

    const ctx: CordisContext = {
      effect: (fn: () => unknown) => {
        disposer = fn();
      },
      on: () => {},
    };

    apply(ctx);
    expect(globalThis.fetch).not.toBe(originalFetch);

    if (typeof disposer === "function") {
      disposer();
    }
    expect(globalThis.fetch).toBe(originalFetch);
  });

  it("disposer does not clobber a replacement fetch", () => {
    const originalFetch = globalThis.fetch;
    let disposer: unknown;
    const ctx: CordisContext = {
      effect: (fn: () => unknown) => {
        disposer = fn();
      },
      on: () => {},
    };
    apply(ctx);
    globalThis.fetch = replacementFetch;
    if (typeof disposer === "function") {
      disposer();
    }
    expect(globalThis.fetch).toBe(replacementFetch);
    globalThis.fetch = originalFetch;
  });

  it("attaches to llm/stream and derives session ID", async () => {
    let streamHandler:
      | ((options: unknown, next: () => unknown) => unknown)
      | undefined;

    const ctx: CordisContext = {
      effect: () => {},
      on: (
        _event: string,
        handler: (options: unknown, next: () => unknown) => unknown
      ) => {
        streamHandler = handler;
      },
    };

    apply(ctx);
    expect(typeof streamHandler).toBe("function");
    if (typeof streamHandler !== "function") {
      throw new TypeError("stream handler not registered");
    }
    const result: unknown = streamHandler(
      {
        model: "muse-spark-1.3-contributor-free",
        provider: "opencode",
        sessionId: "dsh-session-test-888",
      },
      () => createMockStream("stream-chunk-1")
    );
    if (!isAsyncIterableLike(result)) {
      throw new Error("expected async iterable downstream");
    }
    expect(await collectUnknown(result)).toEqual(["stream-chunk-1"]);
  });

  it("ignores non-opencode providers and invalid session IDs", () => {
    let streamHandler:
      | ((options: unknown, next: () => unknown) => unknown)
      | undefined;
    const ctx: CordisContext = {
      effect: () => {},
      on: (
        _event: string,
        handler: (options: unknown, next: () => unknown) => unknown
      ) => {
        streamHandler = handler;
      },
    };
    apply(ctx);
    if (typeof streamHandler !== "function") {
      throw new TypeError("stream handler not registered");
    }
    const handler = streamHandler;
    const passthrough = (options: unknown) =>
      handler(options, () => "next-value");

    expect(passthrough({ provider: "deepseek", sessionId: "abc" })).toBe(
      "next-value"
    );
    expect(passthrough({ provider: "opencode" })).toBe("next-value");
    expect(passthrough({ provider: "opencode", sessionId: "" })).toBe(
      "next-value"
    );
    expect(passthrough(null)).toBe("next-value");
    expect(passthrough("nope")).toBe("next-value");
  });

  it("warns and skips when globalThis.fetch is unavailable", () => {
    const warnings: string[] = [];
    vi.stubGlobal("fetch", null);
    const ctx: CordisContext = {
      effect: () => {},
      logger: {
        warn: (msg: string) => {
          warnings.push(msg);
        },
      },
      on: () => {
        throw new Error("on must not be called without fetch");
      },
    };
    apply(ctx);
    expect(
      warnings.some((w) => w.includes("globalThis.fetch is unavailable"))
    ).toBe(true);
  });

  it("records debug entries to debugFile when configured", async () => {
    const tmpDir = await mkdtemp(path.join(tmpdir(), "dsh-opencode-test-"));
    try {
      const debugFile = path.join(tmpDir, "stream-debug.jsonl");
      let streamHandler:
        | ((options: unknown, next: () => unknown) => unknown)
        | undefined;

      const ctx: CordisContext = {
        effect: () => {},
        logger: { info: () => {} },
        on: (
          _event: string,
          handler: (options: unknown, next: () => unknown) => unknown
        ) => {
          streamHandler = handler;
        },
      };

      apply(ctx, { debug: true, debugFile });
      if (typeof streamHandler !== "function") {
        throw new TypeError("stream handler not registered");
      }
      const result: unknown = streamHandler(
        {
          model: "muse-spark-1.3-contributor-free",
          provider: "opencode",
          sessionId: "session-debug-999",
        },
        () => createMockStream("done")
      );
      if (!isAsyncIterableLike(result)) {
        throw new Error("expected async iterable downstream");
      }
      expect(await collectUnknown(result)).toEqual(["done"]);

      const content = await waitForFileContent(debugFile);
      const [firstLine] = content.trim().split("\n");
      if (firstLine === undefined) {
        throw new Error("debug file is empty");
      }
      const parsed: unknown = JSON.parse(firstLine);
      if (!isRecord(parsed)) {
        throw new Error("debug entry is not an object");
      }
      expect(parsed.header).toBe("x-opencode-session");
      expect(parsed.model).toBe("muse-spark-1.3-contributor-free");
      expect(parsed.provider).toBe("opencode");
      expect(parsed.session).toBe("session-debug-999");
      expect(typeof parsed.value).toBe("string");
      if (typeof parsed.value === "string") {
        expect(parsed.value).toMatch(/^ses_/);
      }
    } finally {
      await rm(tmpDir, { force: true, recursive: true });
    }
  });

  it("keeps session affinity across turns for the same DSH session", async () => {
    const tmpDir = await mkdtemp(path.join(tmpdir(), "dsh-opencode-aff-"));
    try {
      const debugFile = path.join(tmpDir, "affinity.jsonl");
      let streamHandler:
        | ((options: unknown, next: () => unknown) => unknown)
        | undefined;
      const ctx: CordisContext = {
        effect: () => {},
        logger: { info: () => {} },
        on: (
          _event: string,
          handler: (options: unknown, next: () => unknown) => unknown
        ) => {
          streamHandler = handler;
        },
      };
      apply(ctx, { debugFile });
      if (typeof streamHandler !== "function") {
        throw new TypeError("stream handler not registered");
      }
      const handler = streamHandler;
      const driveTurn = async (label: string) => {
        const result: unknown = handler(
          { model: "m", provider: "opencode", sessionId: "same-dsh-session" },
          () => createMockStream(label)
        );
        if (!isAsyncIterableLike(result)) {
          throw new Error("expected async iterable downstream");
        }
        await expect(collectUnknown(result)).resolves.toEqual([label]);
      };
      await driveTurn("turn-0");
      await driveTurn("turn-1");
      const content = await waitForFileContent(debugFile, 2);
      const values: unknown[] = [];
      for (const line of content.trim().split("\n")) {
        const parsed: unknown = JSON.parse(line);
        if (isRecord(parsed)) {
          values.push(parsed.value);
        }
      }
      expect(values).toHaveLength(2);
      expect(values[0]).toBe(values[1]);
    } finally {
      await rm(tmpDir, { force: true, recursive: true });
    }
  });
});

describe("bundle manifest consistency", () => {
  const root = path.dirname(import.meta.dirname);

  const readText = (rel: string): Promise<string> =>
    readFile(path.join(root, rel), "utf-8");

  it("ships a cordis row whose name equals the npm package name", async () => {
    const pkgRaw: unknown = JSON.parse(await readText("package.json"));
    if (!isRecord(pkgRaw) || typeof pkgRaw.name !== "string") {
      throw new Error("package.json has no string name");
    }
    const patch = await readText("cordis.patch.yml");
    const row =
      /^\s*-\s*id:\s*dsh-opencode-patch\s*\n\s*name:\s*["']?([^"'\s]+)/m.exec(
        patch
      );
    if (row === null || row[1] === undefined) {
      throw new Error("dsh-opencode-patch row not found in cordis.patch.yml");
    }
    // The host resolves row names to node_modules paths.
    expect(row[1]).toBe(pkgRaw.name);
  });

  it("keeps the settings namespace equal to the cordis row id", async () => {
    const patch = await readText("cordis.patch.yml");
    expect(patch).toContain("id: dsh-opencode-patch");
    // Read the NS constant textually: importing settings-page.tsx would
    // drag the React + ui-primitives runtime chain (whose own deps are
    // incomplete for node) into a hermetic suite.
    const page = await readText("src/settings-page.tsx");
    const ns = /^export const NS = "([^"]+)";/m.exec(page);
    if (ns === null || ns[1] === undefined) {
      throw new Error("NS constant not found in src/settings-page.tsx");
    }
    expect(ns[1]).toBe("dsh-opencode-patch");
  });

  it("keeps the component name aligned with the default row id", () => {
    // Package (dsh-opencode-patch) == row id (dsh-opencode-patch) == row name.
    expect(PLUGIN_NAME).toBe("dsh-opencode-patch");
  });

  it("ships a manifest icon the host can display", async () => {
    const pkgRaw: unknown = JSON.parse(await readText("package.json"));
    if (!isRecord(pkgRaw) || typeof pkgRaw.icon !== "string") {
      throw new Error("package.json has no string icon field");
    }
    // Relative to the manifest directory, within the 256 KiB host limit.
    expect(pkgRaw.icon.startsWith("./")).toBe(true);
    const iconStat = await stat(path.join(root, pkgRaw.icon));
    expect(iconStat.size).toBeGreaterThan(0);
    expect(iconStat.size).toBeLessThanOrEqual(256 * 1024);
  });

  it("registers the client bundle under the npm package name", async () => {
    const pkgRaw: unknown = JSON.parse(await readText("package.json"));
    if (!isRecord(pkgRaw) || typeof pkgRaw.name !== "string") {
      throw new Error("package.json has no string name");
    }
    // The web loader drops bundles whose __ModuleLoader__.load id differs
    // from the npm package name ("loaded without registering ...").
    const config = await readText("vite.config.ts");
    const banner = /id:\s*"([^"]+)"/.exec(config);
    if (banner === null || banner[1] === undefined) {
      throw new Error("client banner id not found in vite.config.ts");
    }
    expect(banner[1]).toBe(pkgRaw.name);
  });
});

const createMockContext = () =>
  ({
    reflect: { provide: () => {} },
  }) as never;

describe("OpenCode Go Usage", () => {
  const samplePayload = {
    usage: {
      monthly: {
        percent: 100,
        resetsAt: "2026-10-09T13:53:58.000Z",
        status: "rate-limited",
      },
      rolling: {
        percent: 15,
        resetsAt: "2026-10-01T16:55:56.004Z",
        status: "ok",
      },
      weekly: {
        percent: 42,
        resetsAt: "2026-10-05T00:00:00.000Z",
        status: "ok",
      },
    },
  };

  it("parses valid API usage response with usage wrapper", () => {
    const parsed = parseGoUsage(samplePayload);
    expect(parsed.monthly.status).toBe("rate-limited");
    expect(parsed.monthly.percent).toBe(100);
    expect(parsed.rolling.percent).toBe(15);
    expect(parsed.weekly.percent).toBe(42);
  });

  it("parses unwrapped usage response", () => {
    const parsed = parseGoUsage(samplePayload.usage);
    expect(parsed.monthly.status).toBe("rate-limited");
    expect(parsed.rolling.status).toBe("ok");
    expect(parsed.weekly.percent).toBe(42);
  });

  it("rejects non-object or null payloads", () => {
    expect(() => parseGoUsage(null)).toThrow("expected an object");
    expect(() => parseGoUsage("string")).toThrow("expected an object");
  });

  it("rejects payload missing rolling, weekly, or monthly", () => {
    expect(() =>
      parseGoUsage({
        rolling: { percent: 0, resetsAt: "2026-01-01", status: "ok" },
      })
    ).toThrow();
  });

  it("declares usageRemote contribution with correct package and descriptor", () => {
    expect(usageRemote.package).toBe("dsh-opencode-patch");
    expect(usageRemote.descriptors.length).toBe(1);
    expect(usageRemote.descriptors[0]?.namespace).toBe("opencodeGoUsage");
  });

  it("GoUsageService throws RemoteError when API key is missing", async () => {
    const service = new GoUsageService(createMockContext(), {
      baseURL: () => "https://opencode.ai/zen/go/v1",
      resolveApiKey: () => Promise.resolve(""),
    });
    await expect(service.read()).rejects.toThrow(
      "OpenCode Go API key is not configured"
    );
  });

  it("GoUsageService reads and parses successfully with valid mock fetch", async () => {
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = vi
        .fn()
        .mockResolvedValue(Response.json(samplePayload));

      const service = new GoUsageService(createMockContext(), {
        baseURL: () => "https://opencode.ai/zen/go/v1",
        resolveApiKey: () => Promise.resolve("test_key_123"),
      });

      const usage = await service.read();
      expect(usage.monthly.percent).toBe(100);
      expect(usage.weekly.percent).toBe(42);
      expect(usage.source).toBeDefined();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("GoUsageService handles upstream 429/temporary error with RemoteError", async () => {
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = vi
        .fn()
        .mockResolvedValue(
          new Response("rate limit exceeded", { status: 429 })
        );

      const service = new GoUsageService(createMockContext(), {
        baseURL: () => "https://opencode.ai/zen/go/v1",
        resolveApiKey: () => Promise.resolve("test_key_123"),
      });

      await expect(service.read()).rejects.toThrow(
        "OpenCode Go usage unavailable (HTTP 429)"
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("discoverGoConfig discovers provider config from llm-pi-ai entries", () => {
    const mockCtx = {
      loader: {
        entries: () => [
          {
            options: {
              config: {
                providers: {
                  "opencode-go": {
                    apiKeyEnv: "CUSTOM_GO_KEY_ENV",
                    baseURL: "https://custom-gateway.com/zen/go/v1",
                  },
                },
              },
              id: "llm-pi-ai",
              name: "@deepseek-ai/dsh-llm-pi-ai",
            },
          },
        ],
      },
    };

    const discovered = discoverGoConfig(mockCtx);
    expect(discovered.keyEnv).toBe("CUSTOM_GO_KEY_ENV");
    expect(discovered.baseURL).toBe("https://custom-gateway.com/zen/go/v1");
  });

  it("discoverGoConfig discovers literal apiKey from standalone opencode-go entry", () => {
    const mockCtx = {
      loader: {
        entries: () => [
          {
            options: {
              config: {
                apiKey: "sk-literal-test-key",
              },
              id: "opencode-go",
              name: "dsh-opencode-go",
            },
          },
        ],
      },
    };

    const discovered = discoverGoConfig(mockCtx);
    expect(discovered.literalKey).toBe("sk-literal-test-key");
  });
});
