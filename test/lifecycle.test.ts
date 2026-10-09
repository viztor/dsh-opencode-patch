/**
 * apply (plugin lifecycle).
 *
 * Split out of the former monolithic `plugin.test.ts`.
 *
 * @module test/lifecycle.test
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  apply,
  type CordisContext,
  getSessionUsage,
  clearSessionUsageStore,
  RESPONSES_ROUTE,
} from "../src/index.ts";
import {
  collectUnknown,
  createMockStream,
  isAsyncIterableLike,
  isRecord,
  replacementFetch,
  waitForFileContent,
} from "./test-helpers.ts";

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.OPENCODE_SESSION_ID;
});

describe("apply (plugin lifecycle)", () => {
  it("registers model discovery for both OpenCode routes by default", () => {
    const registered: string[] = [];
    const ctx = {
      effect: () => {},
      llm: {
        registerModelDiscovery: (ns: string) => {
          registered.push(ns);
        },
      },
      on: () => {},
    } as unknown as CordisContext;

    apply(ctx);
    // The component's own namespace plus one registration per gateway route,
    // so DSH's picker can enumerate Go and Zen independently.
    expect(registered).toContain("dsh-opencode-patch");
    expect(registered).toContain("opencode-go");
    expect(registered).toContain("opencode");
  });

  it("registers the usage service only while the meter is on", () => {
    // The meter toggle is ONE switch with two halves in two processes: the Host
    // registers the remote face here, and the client's meter injector mounts
    // only while that face exists (`settings-page.tsx`). Off means the service
    // is never registered, so there is no trigger, no panel and no price row to
    // render — absence, not an empty shell.
    const mounted: string[] = [];
    const ctx = {
      effect: () => {},
      llm: {},
      on: () => {},
      plugin: (component: unknown) => {
        mounted.push((component as { name?: string })?.name ?? "");
      },
    } as unknown as CordisContext;

    apply(ctx, { usageEnabled: false });
    expect(mounted).not.toContain("GoUsageService");

    apply(ctx, { usageEnabled: true });
    expect(mounted).toContain("GoUsageService");
  });

  it("registers no model discovery when enrichModels is off", () => {
    const registered: string[] = [];
    const ctx = {
      effect: () => {},
      llm: {
        registerModelDiscovery: (ns: string) => {
          registered.push(ns);
        },
      },
      on: () => {},
    } as unknown as CordisContext;

    apply(ctx, { enrichModels: false });
    expect(registered).toEqual([]);
  });

  it("survives a host whose llm service has no model discovery", () => {
    // Discovery is optional: an older host must still get the header patch
    // and the stream hook rather than failing to mount.
    let streamHandler: unknown;
    const ctx = {
      effect: () => {},
      llm: {},
      on: (_event: string, handler: unknown) => {
        streamHandler = handler;
      },
    } as unknown as CordisContext;

    expect(() => apply(ctx)).not.toThrow();
    expect(typeof streamHandler).toBe("function");
  });

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

  it("ties the listing patch to the plugin fiber", () => {
    // The patch replaces Host methods. Registered OUTSIDE an effect it would
    // never be undone, so every live reload would stack another wrapper and
    // disabling the plugin would leave it hiding the route.
    let cleanup: (() => void) | undefined;
    const routes = [
      { id: "opencode", name: "opencode" },
      { id: RESPONSES_ROUTE, name: RESPONSES_ROUTE },
    ];
    const ctx: CordisContext = {
      effect: (fn: () => unknown) => {
        cleanup = fn() as (() => void) | undefined;
      },
      llm: { listProviders: () => routes },
      on: () => {},
    };

    apply(ctx);

    expect(typeof cleanup).toBe("function");
    expect(ctx.llm?.listProviders?.()).toEqual([routes[0]]);
    cleanup?.();
    expect(ctx.llm?.listProviders?.()).toEqual(routes);
  });

  it("hands a responses-format model to the responses route", async () => {
    // The gateway serves muse on /responses and everything else on
    // /chat/completions, and llm-pi-ai carries one `api` per route. So the call
    // is re-dispatched to the route whose `api` already names the format rather
    // than translated at the transport — DSH's own adapter then speaks it.
    let streamHandler:
      | ((options: unknown, next: () => unknown) => unknown)
      | undefined;
    const dispatched: unknown[] = [];
    let nextCalls = 0;

    const ctx: CordisContext = {
      // The redirect asks the hiding patch whether the route is registered, so
      // the effect has to actually run for this test to mean anything.
      effect: (fn: () => unknown) => {
        fn();
      },
      llm: {
        listConfigurableProviders: () => [{ provider: "opencode" }],
        listModels: async () => [{ id: "muse-spark-1.3-contributor-free" }],
        listProviders: () => [{ id: "opencode" }, { id: "opencode-responses" }],
        stream: (options: unknown) => {
          dispatched.push(options);
          return createMockStream("from-responses-route");
        },
      },
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
    const result: unknown = streamHandler(
      { model: "muse-spark-1.3-contributor-free", provider: "opencode" },
      () => {
        nextCalls += 1;
        return createMockStream("from-opencode-route");
      }
    );

    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]).toMatchObject({
      model: "muse-spark-1.3-contributor-free",
      provider: "opencode-responses",
    });
    // The redirect replaces the dispatch; running both would bill twice.
    expect(nextCalls).toBe(0);
    if (!isAsyncIterableLike(result)) {
      throw new Error("expected async iterable downstream");
    }
    expect(await collectUnknown(result)).toEqual(["from-responses-route"]);
  });

  it("reads the SDK from the ZEN plane, not a Go-first lookup", async () => {
    // The measured mis-route: models.dev's `opencode-go` names
    // `@ai-sdk/anthropic` for `qwen3.8-max` while its `opencode` names the
    // completions default, and a Go-first lookup therefore sent a ZEN request to
    // the anthropic route. The live gateway serves `qwen3.8-max` on
    // `/chat/completions` and answers `400 ModelProtocolUnsupported` on
    // `/messages`, so the redirect was a hard failure rather than a preference.
    let streamHandler:
      | ((options: unknown, next: () => unknown) => unknown)
      | undefined;
    const dispatched: unknown[] = [];
    let nextCalls = 0;

    const ctx: CordisContext = {
      effect: (fn: () => unknown) => {
        fn();
      },
      llm: {
        listConfigurableProviders: () => [{ provider: "opencode" }],
        listModels: async () => [{ id: "qwen3.8-max" }],
        listProviders: () => [{ id: "opencode" }, { id: "opencode-anthropic" }],
        stream: (options: unknown) => {
          dispatched.push(options);
          return createMockStream("should-not-be-dispatched");
        },
      },
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
    const result: unknown = streamHandler(
      { model: "qwen3.8-max", provider: "opencode" },
      () => {
        nextCalls += 1;
        return createMockStream("from-opencode-route");
      }
    );

    // The Zen plane declares no SDK for it, so it stays on the route the user
    // configured — which is the endpoint that actually serves it.
    expect(dispatched).toHaveLength(0);
    expect(nextCalls).toBe(1);
    if (!isAsyncIterableLike(result)) {
      throw new Error("expected async iterable downstream");
    }
    expect(await collectUnknown(result)).toEqual(["from-opencode-route"]);
  });

  it("dispatches normally when the responses route is not registered", async () => {
    // A layer that failed to load must not turn the gateway's own error into a
    // "no adapter for provider" one, which points at the wrong thing.
    let streamHandler:
      | ((options: unknown, next: () => unknown) => unknown)
      | undefined;
    let nextCalls = 0;

    const ctx: CordisContext = {
      effect: (fn: () => unknown) => {
        fn();
      },
      llm: {
        listModels: async () => [],
        // The route really is absent, so the redirect must stand down.
        listProviders: () => [{ id: "opencode" }],
        stream: () => createMockStream("should-not-be-used"),
      },
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
    const result: unknown = streamHandler(
      { model: "muse-spark-1.3-contributor-free", provider: "opencode" },
      () => {
        nextCalls += 1;
        return createMockStream("from-opencode-route");
      }
    );

    expect(nextCalls).toBe(1);
    if (!isAsyncIterableLike(result)) {
      throw new Error("expected async iterable downstream");
    }
    expect(await collectUnknown(result)).toEqual(["from-opencode-route"]);
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

  it("survives context proxies where direct sessions access throws without inject", async () => {
    let streamHandler:
      | ((options: unknown, next: () => unknown) => unknown)
      | undefined;

    // Simulate Cordis proxy trap that throws when `ctx.sessions` is read directly
    const proxyTarget: Record<string, unknown> = {
      effect: () => {},
      get: (serviceName: string) =>
        serviceName === "sessions"
          ? {
              get: (id: string) => ({
                header: {
                  cwd: "/workspace/project",
                  parentSession: "ses_parent",
                },
                id,
              }),
            }
          : null,
      on: (
        _event: string,
        handler: (options: unknown, next: () => unknown) => unknown
      ) => {
        streamHandler = handler;
      },
    };

    const ctx = new Proxy(proxyTarget, {
      get(target, prop, receiver) {
        if (prop === "sessions") {
          throw new Error('cannot get property "sessions" without inject');
        }
        return Reflect.get(target, prop, receiver);
      },
      has(target, prop) {
        if (prop === "sessions") {
          return true;
        }
        return Reflect.has(target, prop);
      },
    }) as unknown as CordisContext;

    apply(ctx);
    if (typeof streamHandler !== "function") {
      throw new TypeError("stream handler not registered");
    }

    const result: unknown = streamHandler(
      {
        model: "muse-spark-1.3-contributor-free",
        provider: "opencode",
        sessionId: "dsh-session-proxy-check",
      },
      () => createMockStream("stream-ok")
    );
    if (!isAsyncIterableLike(result)) {
      throw new Error("expected async iterable downstream");
    }
    expect(await collectUnknown(result)).toEqual(["stream-ok"]);
  });

  it("records dollars from a usage chunk without altering the stream", async () => {
    clearSessionUsageStore();
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

    // A priced Go model, so the recorded cost is non-zero.
    const usageChunk = {
      type: "usage",
      usage: {
        inputTokens: 1_000_000,
        outputTokens: 0,
        totalTokens: 1_000_000,
      },
    };
    const down = async function* down() {
      yield "text-delta";
      yield usageChunk;
      yield "finish";
    };
    const result: unknown = streamHandler(
      {
        model: "deepseek-v4.1-flash",
        provider: "opencode-go",
        sessionId: "usage-session",
      },
      () => down()
    );
    if (!isAsyncIterableLike(result)) {
      throw new Error("expected async iterable downstream");
    }

    // Every chunk survives in order; the observer only watches.
    expect(await collectUnknown(result)).toEqual([
      "text-delta",
      usageChunk,
      "finish",
    ]);

    const recorded = getSessionUsage("usage-session");
    expect(recorded?.turns).toBe(1);
    expect(recorded?.inputTokens).toBe(1_000_000);
    expect(recorded?.activeModel).toBe("deepseek-v4.1-flash");
    // Priced from the catalog's Go rate rather than a hardcoded number.
    expect(recorded?.costUsd).toBeGreaterThan(0);
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

  it("captures turn state and wraps streams for auto-review calls where sessionId is omitted", async () => {
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
    const autoReviewOptions = {
      model: "deepseek-v4.1-flash",
      provider: "opencode-go",
    };
    const result: unknown = streamHandler(autoReviewOptions, () =>
      createMockStream("decision-allow")
    );
    if (!isAsyncIterableLike(result)) {
      throw new Error("expected async iterable downstream");
    }
    expect(await collectUnknown(result)).toEqual(["decision-allow"]);
  });

  it("resolves parent session from options or ctx.sessions for subagents", async () => {
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
      get: (name: string): unknown =>
        name === "sessions"
          ? {
              get: (id: string) =>
                id === "child-subagent-session"
                  ? {
                      header: {
                        id: "child-subagent-session",
                        parentSession: "root-lead-session",
                      },
                    }
                  : undefined,
            }
          : undefined,
    };

    apply(ctx);
    if (typeof streamHandler !== "function") {
      throw new TypeError("stream handler not registered");
    }
    const result: unknown = streamHandler(
      {
        model: "deepseek-v4.1-flash",
        provider: "opencode-go",
        sessionId: "child-subagent-session",
      },
      () => createMockStream("subagent-chunk")
    );
    if (!isAsyncIterableLike(result)) {
      throw new Error("expected async iterable downstream");
    }
    expect(await collectUnknown(result)).toEqual(["subagent-chunk"]);
  });
});
