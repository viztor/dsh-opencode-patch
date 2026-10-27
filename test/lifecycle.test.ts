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
  type CordisContext,
  apply,
  clearSessionUsageStore,
  findModelSpecOn,
  getSessionUsage,
  inspectPatch,
} from "./support/src.ts";
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

/**
 * A stand-in whose `inject` hands itself over as the child scope, the way
 * cordis runs an `inject` callback once the service exists: discovery lives in
 * the `llm` scope, because the plugin's root injects nothing.
 */
const withScope = <T extends object>(ctx: T): T =>
  Object.assign(ctx, {
    inject: (_deps: string[], callback: (scope: unknown) => void) => {
      callback(ctx);
    },
  });

describe("apply (plugin lifecycle)", () => {
  it("installs the Settings discovery wrapper in the llm scope by default, and none with enrichModels off", () => {
    const original = async () => [];
    const llm = { discoverModels: original };
    const ctx = withScope({
      effect: () => {},
      llm,
      on: () => {},
    }) as unknown as CordisContext;

    void apply(ctx);
    const installed = Reflect.getOwnPropertyDescriptor(
      llm,
      "discoverModels"
    )?.value;
    expect(installed).not.toBe(original);
    expect(inspectPatch(installed, "discoverModels")?.[0]).toMatchObject({
      id: "dsh-opencode-patch/model-discovery",
      live: true,
    });

    const offLlm = { discoverModels: original };
    const off = withScope({
      effect: () => {},
      llm: offLlm,
      on: () => {},
    }) as unknown as CordisContext;
    void apply(off, { enrichModels: false });
    expect(
      Reflect.getOwnPropertyDescriptor(offLlm, "discoverModels")?.value
    ).toBe(original);
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

    void apply(ctx, { usageEnabled: false });
    expect(mounted).not.toContain("GoUsageService");

    void apply(ctx, { usageEnabled: true });
    expect(mounted).toContain("GoUsageService");
  });

  it("mounts the usage service once per root, so a reload cannot lose it", () => {
    // Measured on a live host: the plugin is applied more than once (a live
    // reload does it on every patch). The second activation's registration was
    // refused as a duplicate because the first was still alive, and when that
    // first fiber then disposed it took the service with it — leaving NONE, and
    // the Gateway with nothing to expose. The browser console said exactly that:
    //   "the usage meter is not rendering: no usage service:
    //    remote.opencodeGoUsage.read is missing"
    //
    // Reproduced on real cordis: apply → present, apply again → present,
    // dispose the first then re-apply → MISSING. On the root, once per process,
    // the service survives that ordering.
    const mounted: string[] = [];
    const ctx = {
      effect: () => {},
      llm: {},
      on: () => {},
      plugin: (component: unknown) => {
        mounted.push((component as { name?: string })?.name ?? "");
      },
    } as unknown as CordisContext;
    // The root IS this context: no `root` property means the composition's own.
    ctx.root = ctx;

    void apply(ctx, { usageEnabled: true });
    void apply(ctx, { usageEnabled: true });
    expect(mounted.filter((name) => name === "GoUsageService")).toHaveLength(1);
  });

  it("reports WHY the usage service is unreachable, in each of the three ways", () => {
    // A browser console carried:
    //
    //   the usage meter is not rendering: no usage service:
    //   remote.opencodeGoUsage.read is missing
    //
    // That proves the CLIENT half is fine — the contribution mounts and its
    // descriptor names `service: "opencodeGoUsage"`. What is missing is a Service
    // the Gateway's source-mode discovery can find, and there are three ways that
    // happens with nothing on the client to show it: it never registered, it
    // registered under another key, or it registered as a VALUE (`ctx.provide`)
    // rather than a Service. The three are indistinguishable from outside, so the
    // host now names which one it is.
    const messages: string[] = [];
    const hostWith = (get: () => unknown): unknown => ({
      effect: () => {},
      get,
      llm: {},
      logger: {
        info: (...args: unknown[]) => messages.push(args.map(String).join(" ")),
        warn: (...args: unknown[]) => messages.push(args.map(String).join(" ")),
      },
      on: () => {},
      plugin: () => {
        /* the real path; not needed for these three cases */
      },
    });

    // 1. Never registered: `ctx.get` answers nothing for the key.
    void apply(
      hostWith(() => {
        /* an unregistered name */
      }) as never,
      { usageEnabled: true }
    );
    expect(
      messages.some(
        (m) => m.includes("did not register") && m.includes("ctx.get")
      )
    ).toBe(true);

    // 2. Registered, but with no `typertRemote` binding — a provided value, which
    //    the Gateway's service scan cannot see.
    messages.length = 0;
    void apply(hostWith(() => ({ read: async () => ({}) })) as never, {
      usageEnabled: true,
    });
    expect(
      messages.some(
        (m) =>
          m.includes("no typertRemote binding") && m.includes("ctx.provide")
      )
    ).toBe(true);

    // 3. Registered and bound — the good case, reported as reachable.
    messages.length = 0;
    const bound = {
      read: async () => ({}),
      typertRemote: {
        namespace: "opencodeGoUsage",
        serviceKey: "opencodeGoUsage",
      },
    };
    void apply(hostWith(() => bound) as never, { usageEnabled: true });
    expect(
      messages.some(
        (m) => m.includes("reachable") && m.includes("opencodeGoUsage")
      )
    ).toBe(true);
  });

  it("survives a composition with neither mount path, and reports it", async () => {
    // The fallback's whole job is to not give up: `ctx.provide` reaches the same
    // lookup the client uses, so a composition with one but not the other still
    // publishes both services. A real cordis context is what the service
    // constructors need, so this asserts the reachable half - the path is taken,
    // and a context with neither mount point is a report rather than a throw.
    const warned: string[] = [];
    const logger = { warn: (msg: string) => warned.push(msg) };
    const withProvide = {
      effect: () => {},
      llm: {},
      logger,
      on: () => {},
      provide: () => {},
    } as unknown as CordisContext;
    await expect(
      apply(withProvide, { usageEnabled: true })
    ).resolves.toBeUndefined();

    // Neither `plugin` nor `provide`: the installer says so instead of throwing,
    // which is what keeps one service's absence from taking the rest of `apply`
    // down with it.
    await expect(
      apply(
        {
          effect: () => {},
          llm: {},
          logger,
          on: () => {},
        } as unknown as CordisContext,
        { usageEnabled: true }
      )
    ).resolves.toBeUndefined();
    expect(warned.join(" ")).toContain("neither ctx.plugin nor ctx.provide");
  });

  it("survives a host whose llm service has no discoverModels", () => {
    // Discovery is optional: an older host must still get the header patch
    // and the stream hook rather than failing to mount. The llm scope runs
    // (`withScope`), so the discovery installer reads this service.
    let streamHandler: unknown;
    const llm = {};
    const ctx = withScope({
      effect: () => {},
      llm,
      on: (_event: string, handler: unknown) => {
        streamHandler = handler;
      },
    }) as unknown as CordisContext;

    expect(() => apply(ctx)).not.toThrow();
    expect(typeof streamHandler).toBe("function");
    // Nothing was installed on a service with no method to wrap.
    expect(Reflect.ownKeys(llm)).toEqual([]);
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

    void apply(ctx);
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
    void apply(ctx);
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

    void apply(ctx);
    expect(typeof streamHandler).toBe("function");
    if (typeof streamHandler !== "function") {
      throw new TypeError("stream handler not registered");
    }
    const result: unknown = streamHandler(
      {
        model: "beam-free",
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

    void apply(ctx);
    if (typeof streamHandler !== "function") {
      throw new TypeError("stream handler not registered");
    }

    const result: unknown = streamHandler(
      {
        model: "beam-free",
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
    void apply(ctx);
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

  it("prices a turn at the rate of the plane its route belongs to", async () => {
    // The planes price some shared ids differently. A Go-first lookup billed
    // every Zen turn on those at the Go rate, so each plane is checked here
    // against its own catalog row rather than against a hardcoded number.
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
    void apply(ctx);
    const model = "deepseek-v4-pro";
    const go = findModelSpecOn("go", model)?.cost?.input;
    const zen = findModelSpecOn("zen", model)?.cost?.input;
    // The case only means something while the planes disagree.
    expect(go).toBeTypeOf("number");
    expect(zen).toBeTypeOf("number");
    expect(go).not.toBe(zen);

    const runTurn = async (provider: string, sessionId: string) => {
      const down = async function* down() {
        yield {
          type: "usage",
          usage: {
            inputTokens: 1_000_000,
            outputTokens: 0,
            totalTokens: 1_000_000,
          },
        };
      };
      const result: unknown = streamHandler?.(
        { model, provider, sessionId },
        () => down()
      );
      if (!isAsyncIterableLike(result)) {
        throw new Error("expected async iterable downstream");
      }
      await collectUnknown(result);
      return getSessionUsage(sessionId)?.costUsd;
    };

    expect(await runTurn("opencode-go", "plane-go")).toBeCloseTo(go ?? 0, 6);
    expect(await runTurn("opencode", "plane-zen")).toBeCloseTo(zen ?? 0, 6);
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
    void apply(ctx);
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
    void apply(ctx);
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

      void apply(ctx, { debug: true, debugFile });
      if (typeof streamHandler !== "function") {
        throw new TypeError("stream handler not registered");
      }
      const result: unknown = streamHandler(
        {
          model: "beam-free",
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
      expect(parsed.model).toBe("beam-free");
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

  // The debug write is fire-and-forget by design — a request must never wait on
  // the log — so the test polls for the entry. Under full-suite parallelism the
  // append can be starved past the default 5s ceiling, which is a flaky failure
  // rather than a behaviour: the budget is generous, not the polling.
  it("monitors a request that flows through the patched fetch", async () => {
    // The case above drives the stream hook; this one drives the request
    // monitor, whose closure lives in the composition's debugHook and is only
    // called when a request runs through a patch the composition installed.
    // A deployment turns debugging on from the profile, so that wiring — hook
    // created on the fiber, entry written per claimed request — is the
    // behaviour being pinned.
    const tmpDir = await mkdtemp(path.join(tmpdir(), "dsh-opencode-req-"));
    try {
      const debugFile = path.join(tmpDir, "requests.jsonl");
      const originalFetch = globalThis.fetch;
      const answering = vi.fn(async () => Response.json({ ok: true }));
      globalThis.fetch = answering as unknown as typeof fetch;
      let disposer: unknown;
      const ctx: CordisContext = {
        effect: (fn: () => unknown) => {
          disposer = fn();
        },
        logger: { info: () => {} },
        on: () => {},
      };
      try {
        void apply(ctx, { debug: true, debugFile });
        const url = "https://opencode.ai/zen/v1/chat/completions";
        const response = await globalThis.fetch(url, {
          body: JSON.stringify({ messages: [] }),
          headers: {},
          method: "POST",
        });
        expect(response.status).toBe(200);

        const content = await waitForFileContent(debugFile, 1, 12_000);
        const entries = content
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line))
          .filter(isRecord);
        const requestEntries = entries.filter(
          (entry) => entry.claimed === true
        );
        expect(requestEntries).toHaveLength(1);
        const [requestEntry] = requestEntries;
        if (!isRecord(requestEntry)) {
          throw new Error("no request entry in the debug file");
        }
        expect(requestEntry.url).toBe(url);
        expect(requestEntry.plane).toBe("opencode");
        expect(requestEntry.status).toBe(200);
        expect(requestEntry.sessionFormat).toBe(true);
      } finally {
        if (typeof disposer === "function") {
          disposer();
        }
        globalThis.fetch = originalFetch;
      }
    } finally {
      await rm(tmpDir, { force: true, recursive: true });
    }
  }, 15_000);

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
      void apply(ctx, { debug: true, debugFile });
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

    void apply(ctx);
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

    void apply(ctx);
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
