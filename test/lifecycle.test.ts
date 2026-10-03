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

import { apply, type CordisContext } from "../src/index.ts";
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
