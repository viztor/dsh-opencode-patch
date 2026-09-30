import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { describe, it } from "vitest";

import type { PluginConfig } from "../src/index.ts";
import {
  apply,
  DUMMY_BASH_TOOL,
  DUMMY_READ_TOOL,
  headerValueFor,
  hasSessionHeader,
  openCodeSessionIdFor,
  OPENCODE_UA,
  patchFetch,
  resolveConfig,
  SESSION_HEADER,
  withStore,
} from "../src/index.ts";

const createMockStream = async function* createMockStream(chunk: string) {
  yield chunk;
};

const createMockStoreStream = async function* createMockStoreStream(
  als: AsyncLocalStorage<{ value: string }>
) {
  yield als.getStore()?.value;
  yield als.getStore()?.value;
};

describe("openCodeSessionIdFor", () => {
  it("generates a valid OpenCode session ID matching the exact regex format", () => {
    const id = openCodeSessionIdFor("c2a51fb0-578c-4019-80c4-868eff95fd08");
    assert.match(id, /^ses_[0-9a-f]{12}[A-Za-z0-9]{14}$/);
    assert.equal(id.length, 30);
  });

  it("is deterministic for identical inputs", () => {
    const id1 = openCodeSessionIdFor("conversation-alpha-123");
    const id2 = openCodeSessionIdFor("conversation-alpha-123");
    assert.equal(id1, id2);
  });

  it("handles numeric session IDs correctly", () => {
    const id1 = openCodeSessionIdFor(123_456_789);
    const id2 = openCodeSessionIdFor("123456789");
    assert.equal(id1, id2);
    assert.match(id1, /^ses_/);
  });

  it("generates unique session IDs without collision across diverse inputs", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i += 1) {
      const id = openCodeSessionIdFor(`session-turn-${i}-${Math.random()}`);
      assert.equal(seen.has(id), false, `Collision detected at index ${i}`);
      seen.add(id);
    }
    assert.equal(seen.size, 200);
  });
});

describe("resolveConfig", () => {
  it("fills default providers, mode, and debug flags", () => {
    const resolved = resolveConfig({});
    assert.deepEqual([...resolved.providers], ["opencode", "opencode-go"]);
    assert.equal(resolved.mode, "session-id");
    assert.equal(resolved.debug, false);
    assert.equal(resolved.debugFile, undefined);
  });

  it("preserves custom providers list", () => {
    const resolved = resolveConfig({
      debug: true,
      debugFile: "/tmp/debug.log",
      mode: "uuid",
      providers: ["custom-opencode", "opencode-dev"],
    });
    assert.deepEqual(
      [...resolved.providers],
      ["custom-opencode", "opencode-dev"]
    );
    assert.equal(resolved.mode, "uuid");
    assert.equal(resolved.debug, true);
    assert.equal(resolved.debugFile, "/tmp/debug.log");
  });

  it("falls back to session-id mode when unknown mode is provided", () => {
    const resolved = resolveConfig({
      mode: "unknown" as unknown as PluginConfig["mode"],
    });
    assert.equal(resolved.mode, "session-id");
  });
});

describe("headerValueFor", () => {
  it("returns mapped session id and caches it in the provided table", () => {
    const table = new Map<string, string>();
    const val1 = headerValueFor("dsh-uuid-1", "session-id", table);
    assert.ok(val1?.startsWith("ses_"));
    assert.equal(table.get("dsh-uuid-1"), val1);

    // Second call should return the exact cached value from table
    const val2 = headerValueFor("dsh-uuid-1", "session-id", table);
    assert.equal(val2, val1);
  });

  it("returns undefined for empty, null, or undefined session inputs", () => {
    const table = new Map<string, string>();
    assert.equal(headerValueFor("", "session-id", table), undefined);
    assert.equal(headerValueFor(undefined, "session-id", table), undefined);
    assert.equal(headerValueFor(null, "session-id", table), undefined);
    assert.equal(table.size, 0);
  });
});

describe("hasSessionHeader", () => {
  it("detects x-opencode-session in Headers object case-insensitively", () => {
    const headers = new Headers();
    headers.set("X-OpenCode-Session", "ses_mock_header");
    assert.equal(hasSessionHeader("http://example.com", { headers }), true);
  });

  it("detects x-opencode-session in plain object headers", () => {
    assert.equal(
      hasSessionHeader("http://example.com", {
        headers: { [SESSION_HEADER]: "ses_mock_header" },
      }),
      true
    );
  });

  it("returns false when header is absent", () => {
    assert.equal(
      hasSessionHeader("http://example.com", {
        headers: { "Content-Type": "application/json" },
      }),
      false
    );
    assert.equal(hasSessionHeader("http://example.com"), false);
  });
});

describe("withStore", () => {
  it("wraps and drives an async iterable inside AsyncLocalStorage context", async () => {
    const als = new AsyncLocalStorage<{ value: string }>();
    const wrapped = withStore(
      createMockStoreStream(als),
      { value: "store-context-42" },
      als
    );
    const results: (string | undefined)[] = [];
    for await (const val of wrapped) {
      results.push(val);
    }

    assert.deepEqual(results, ["store-context-42", "store-context-42"]);
  });

  it("handles early return on the wrapped iterator", async () => {
    const als = new AsyncLocalStorage<{ value: string }>();
    let returned = false;

    const mockIterable: AsyncIterable<number> = {
      [Symbol.asyncIterator]() {
        return {
          next() {
            return Promise.resolve({ done: false, value: 1 });
          },
          return() {
            returned = true;
            return Promise.resolve({ done: true, value: undefined });
          },
        };
      },
    };

    const wrapped = withStore(mockIterable, { value: "test" }, als);
    const iterator = wrapped[Symbol.asyncIterator]();
    const first = await iterator.next();
    assert.equal(first.value, 1);
    await iterator.return?.();
    assert.equal(returned, true);
  });
});

describe("patchFetch", () => {
  it("passes non-OpenCode requests through completely untouched", async () => {
    const als = new AsyncLocalStorage<{ value: string }>();
    let capturedInit: RequestInit | undefined;
    let capturedUrl = "";

    const mockFetch = async (
      input: RequestInfo | URL,
      init?: RequestInit
    ): Promise<Response> => {
      let targetUrl = "";
      if (typeof input === "string") {
        targetUrl = input;
      } else if (input instanceof URL) {
        targetUrl = input.toString();
      } else {
        targetUrl = input.url;
      }
      capturedUrl = targetUrl;
      capturedInit = init;
      await Promise.resolve();
      return new Response("upstream-ok");
    };

    const patched = patchFetch(mockFetch, als);

    const res = await patched("https://api.external.com/v1/chat", {
      body: JSON.stringify({ message: "hello" }),
      headers: { "X-Custom-Header": "original" },
      method: "POST",
    });

    assert.equal(await res.text(), "upstream-ok");
    assert.equal(capturedUrl, "https://api.external.com/v1/chat");
    assert.ok(capturedInit);
    const headers = new Headers(capturedInit.headers);
    assert.equal(headers.get("X-Custom-Header"), "original");
    assert.equal(headers.get("User-Agent"), null);
    assert.equal(headers.get("x-opencode-client"), null);
  });

  it("injects OpenCode origin headers and dynamic session ID for opencode.ai/zen requests", async () => {
    const als = new AsyncLocalStorage<{ value: string }>();
    let capturedInit: RequestInit | undefined;
    const testSession =
      process.env.TEST_OPENCODE_SESSION ??
      openCodeSessionIdFor("test-dynamic-turn");

    const mockFetch = async (
      _input: RequestInfo | URL,
      init?: RequestInit
    ): Promise<Response> => {
      capturedInit = init;
      await Promise.resolve();
      return Response.json({ status: "success" });
    };

    const patched = patchFetch(mockFetch, als);

    await als.run({ value: testSession }, async () => {
      await patched("https://opencode.ai/zen/v1/chat/completions", {
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
    });

    assert.ok(capturedInit);
    const headers = new Headers(capturedInit.headers);
    assert.equal(headers.get("User-Agent"), OPENCODE_UA);
    assert.equal(headers.get("x-opencode-client"), "cli");
    assert.equal(headers.get("x-opencode-project"), "global");
    assert.equal(headers.get(SESSION_HEADER), testSession);
  });

  it("injects DUMMY_READ_TOOL and DUMMY_BASH_TOOL when missing for free-tier /responses models", async () => {
    const als = new AsyncLocalStorage<{ value: string }>();
    let capturedInit: RequestInit | undefined;
    const testSession =
      process.env.TEST_OPENCODE_SESSION ??
      openCodeSessionIdFor("test-free-turn");

    const mockFetch = async (
      _input: RequestInfo | URL,
      init?: RequestInit
    ): Promise<Response> => {
      capturedInit = init;
      await Promise.resolve();
      return Response.json({ ok: true });
    };

    const patched = patchFetch(mockFetch, als);

    await als.run({ value: testSession }, async () => {
      await patched("https://opencode.ai/zen/v1/responses", {
        body: JSON.stringify({
          input: [{ content: "hi", role: "user" }],
          model: "muse-spark-1.3-contributor-free",
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
    });

    assert.ok(capturedInit);
    const headers = new Headers(capturedInit.headers);
    assert.ok(headers.get("content-length"));

    assert.equal(typeof capturedInit.body, "string");
    const bodyStr =
      typeof capturedInit.body === "string" ? capturedInit.body : "{}";
    const body = JSON.parse(bodyStr) as {
      tools?: { name?: string }[];
    };
    assert.ok(Array.isArray(body.tools));
    assert.equal(body.tools.length, 2);
    assert.equal(body.tools[0]?.name, DUMMY_READ_TOOL.name);
    assert.equal(body.tools[1]?.name, DUMMY_BASH_TOOL.name);
  });

  it("does not duplicate read or bash tools when one is already provided", async () => {
    const als = new AsyncLocalStorage<{ value: string }>();
    let capturedInit: RequestInit | undefined;
    const testSession =
      process.env.TEST_OPENCODE_SESSION ??
      openCodeSessionIdFor("test-partial-turn");

    const mockFetch = async (
      _input: RequestInfo | URL,
      init?: RequestInit
    ): Promise<Response> => {
      capturedInit = init;
      await Promise.resolve();
      return Response.json({ ok: true });
    };

    const patched = patchFetch(mockFetch, als);

    await als.run({ value: testSession }, async () => {
      await patched("https://opencode.ai/zen/v1/responses", {
        body: JSON.stringify({
          input: [{ content: "run command", role: "user" }],
          model: "muse-spark-1.3-contributor-free",
          tools: [{ name: "bash", type: "function" }],
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
    });

    assert.ok(capturedInit);
    assert.equal(typeof capturedInit.body, "string");
    const bodyStr =
      typeof capturedInit.body === "string" ? capturedInit.body : "{}";
    const body = JSON.parse(bodyStr) as {
      tools?: { name?: string }[];
    };
    assert.ok(Array.isArray(body.tools));
    assert.equal(body.tools.length, 2);
    assert.equal(body.tools.filter((t) => t.name === "bash").length, 1);
    assert.equal(body.tools.filter((t) => t.name === "read").length, 1);
  });

  it("does not inject dummy tools for non-free models", async () => {
    const als = new AsyncLocalStorage<{ value: string }>();
    let capturedInit: RequestInit | undefined;
    const testSession =
      process.env.TEST_OPENCODE_SESSION ??
      openCodeSessionIdFor("test-paid-turn");

    const mockFetch = async (
      _input: RequestInfo | URL,
      init?: RequestInit
    ): Promise<Response> => {
      capturedInit = init;
      await Promise.resolve();
      return Response.json({ ok: true });
    };

    const patched = patchFetch(mockFetch, als);

    await als.run({ value: testSession }, async () => {
      await patched("https://opencode.ai/zen/v1/responses", {
        body: JSON.stringify({
          input: [{ content: "hello", role: "user" }],
          model: "claude-sonnet-5",
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
    });

    assert.ok(capturedInit);
    assert.equal(typeof capturedInit.body, "string");
    const bodyStr =
      typeof capturedInit.body === "string" ? capturedInit.body : "{}";
    const body = JSON.parse(bodyStr) as {
      tools?: unknown;
    };
    assert.equal(body.tools, undefined);
  });

  it("handles Buffer bodies correctly without breaking", async () => {
    const als = new AsyncLocalStorage<{ value: string }>();
    let capturedInit: RequestInit | undefined;
    const testSession =
      process.env.TEST_OPENCODE_SESSION ??
      openCodeSessionIdFor("test-buffer-turn");

    const mockFetch = async (
      _input: RequestInfo | URL,
      init?: RequestInit
    ): Promise<Response> => {
      capturedInit = init;
      await Promise.resolve();
      return Response.json({ ok: true });
    };

    const patched = patchFetch(mockFetch, als);

    const payload = Buffer.from(
      JSON.stringify({
        input: [{ content: "test buffer", role: "user" }],
        model: "muse-spark-1.3-contributor-free",
      }),
      "utf-8"
    );

    await als.run({ value: testSession }, async () => {
      await patched("https://opencode.ai/zen/v1/responses", {
        body: payload,
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
    });

    assert.ok(capturedInit);
    assert.equal(typeof capturedInit.body, "string");
    const bodyStr =
      typeof capturedInit.body === "string" ? capturedInit.body : "{}";
    const body = JSON.parse(bodyStr) as {
      tools?: { name?: string }[];
    };
    assert.ok(Array.isArray(body.tools));
    assert.equal(body.tools.length, 2);
  });
});

describe("apply (plugin lifecycle)", () => {
  it("registers ctx.effect, patches globalThis.fetch, and restores it on disposer call", () => {
    const originalFetch = globalThis.fetch;
    let effectDisposer: (() => void) | undefined;

    const ctx = {
      effect: (fn: () => unknown) => {
        effectDisposer = fn() as () => void;
      },
      on: () => {},
    };

    apply(ctx);
    assert.notEqual(globalThis.fetch, originalFetch);

    // Call disposer
    effectDisposer?.();
    assert.equal(globalThis.fetch, originalFetch);
  });

  it("attaches to llm/stream event and derives session ID", async () => {
    let streamHandler:
      | ((options: unknown, next: () => unknown) => unknown)
      | undefined;

    const ctx = {
      effect: () => {},
      on: (
        _event: string,
        handler: (options: unknown, next: () => unknown) => unknown
      ) => {
        streamHandler = handler;
      },
    };

    apply(ctx);
    assert.ok(streamHandler);

    const result = streamHandler(
      {
        model: "muse-spark-1.3-contributor-free",
        provider: "opencode",
        sessionId: "dsh-session-test-888",
      },
      () => createMockStream("stream-chunk-1")
    ) as AsyncIterable<string>;

    assert.ok(result);
    const chunks: string[] = [];
    for await (const chunk of result) {
      chunks.push(chunk);
    }
    assert.deepEqual(chunks, ["stream-chunk-1"]);
  });

  it("records debug entries to debugFile when configured", async () => {
    const tmpDir = await mkdtemp(path.join(tmpdir(), "dsh-opencode-test-"));
    const debugFile = path.join(tmpDir, "stream-debug.jsonl");

    let streamHandler:
      | ((options: unknown, next: () => unknown) => unknown)
      | undefined;

    const ctx = {
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
    assert.ok(streamHandler);

    const result = streamHandler(
      {
        model: "muse-spark-1.3-contributor-free",
        provider: "opencode",
        sessionId: "session-debug-999",
      },
      () => createMockStream("done")
    ) as AsyncIterable<string>;

    for await (const _ of result) {
      // consume
    }

    // Give file append a moment
    await sleep(50);

    const content = await readFile(debugFile, "utf-8");
    const entry = JSON.parse(content.trim()) as {
      header: string;
      model: string;
      provider: string;
      session: string;
      value: string;
    };

    assert.equal(entry.header, "x-opencode-session");
    assert.equal(entry.model, "muse-spark-1.3-contributor-free");
    assert.equal(entry.provider, "opencode");
    assert.equal(entry.session, "session-debug-999");
    assert.ok(entry.value.startsWith("ses_"));

    await rm(tmpDir, { force: true, recursive: true });
  });
});
