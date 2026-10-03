/**
 * patchFetch.
 *
 * Split out of the former monolithic `plugin.test.ts`.
 *
 * @module test/fetch-patch.test
 */

import { AsyncLocalStorage } from "node:async_hooks";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DUMMY_BASH_TOOL,
  DUMMY_READ_TOOL,
  OPENCODE_UA,
  SESSION_HEADER,
  openCodeSessionIdFor,
  patchFetch,
  resolveConfig,
  type ActiveTurnState,
} from "../src/index.ts";
import {
  createCaptureFetch,
  headerOf,
  parseJsonBody,
  toolNamesOf,
} from "./test-helpers.ts";

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.OPENCODE_SESSION_ID;
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

  it("restores configurable origin header values", async () => {
    const als = new AsyncLocalStorage<ActiveTurnState>();
    const { capture, mockFetch } = createCaptureFetch();
    const patched = patchFetch(
      mockFetch,
      als,
      resolveConfig({ originClient: "desktop", injectProject: true })
    );

    await als.run(
      { provider: "opencode", value: "ses_origins_1" },
      async () => {
        await patched("https://opencode.ai/zen/v1/chat/completions", {
          method: "POST",
        });
      }
    );
    expect(headerOf(capture.init, "x-opencode-client")).toBe("desktop");
    expect(headerOf(capture.init, "x-opencode-project")).toBe("global");
  });

  it("dynamically resolves x-opencode-project from workspace when injectProject is on, and omits when off", async () => {
    const als = new AsyncLocalStorage<ActiveTurnState>();
    const { capture: c1, mockFetch: m1 } = createCaptureFetch();
    const patched1 = patchFetch(m1, als, resolveConfig());

    // When default (injectProject: true), dynamic project from workspace turn state is used:
    await als.run(
      {
        project: "my-web-workspace",
        provider: "opencode",
        value: "ses_dyn_proj",
      },
      async () => {
        await patched1("https://opencode.ai/zen/v1/chat/completions", {
          method: "POST",
        });
      }
    );
    expect(headerOf(c1.init, "x-opencode-project")).toBe("my-web-workspace");

    // When injectProject: false, header is completely omitted:
    const { capture: c2, mockFetch: m2 } = createCaptureFetch();
    const patched2 = patchFetch(
      m2,
      als,
      resolveConfig({ injectProject: false })
    );
    await als.run(
      {
        project: "my-web-workspace",
        provider: "opencode",
        value: "ses_dyn_proj",
      },
      async () => {
        await patched2("https://opencode.ai/zen/v1/chat/completions", {
          method: "POST",
        });
      }
    );
    expect(headerOf(c2.init, "x-opencode-project")).toBeNull();
  });

  it("scopes the core-tool fallback to the configured model marker", async () => {
    const runWith = async (
      modelName: string,
      config: Parameters<typeof resolveConfig>[0]
    ) => {
      const als = new AsyncLocalStorage<ActiveTurnState>();
      const { capture, mockFetch } = createCaptureFetch();
      const patched = patchFetch(mockFetch, als, resolveConfig(config));
      await als.run({ provider: "opencode", value: "ses_marker" }, async () => {
        await patched("https://opencode.ai/zen/v1/responses", {
          body: JSON.stringify({ input: "hi", model: modelName }),
          method: "POST",
        });
      });
      return capture.init?.body;
    };

    // Custom marker: only models carrying it fall back.
    const customHit = await runWith("acct-preview-9", {
      freeModelMarker: "preview",
    });
    expect(toolNamesOf(parseJsonBody(customHit))).toEqual(["read", "bash"]);
    const customMiss = await runWith("muse-spark-1.3-contributor-free", {
      freeModelMarker: "preview",
    });
    expect(toolNamesOf(parseJsonBody(customMiss))).toBeUndefined();

    // `*` applies to every model on the path.
    const allModels = await runWith("gpt-5-paid", { freeModelMarker: "*" });
    expect(toolNamesOf(parseJsonBody(allModels))).toEqual(["read", "bash"]);

    // A blank marker falls back to the default instead of disabling injection.
    const blank = await runWith("muse-spark-1.3-contributor-free", {
      freeModelMarker: "",
    });
    expect(toolNamesOf(parseJsonBody(blank))).toEqual(["read", "bash"]);
  });

  it("uses the configured session id env outside a turn", async () => {
    const als = new AsyncLocalStorage<ActiveTurnState>();
    const { capture, mockFetch } = createCaptureFetch();
    process.env.MY_SESSION_ID = "ses_envprovided000000000";
    try {
      const patched = patchFetch(
        mockFetch,
        als,
        resolveConfig({ sessionIdEnv: "MY_SESSION_ID" })
      );
      await patched("https://opencode.ai/zen/v1/chat/completions", {
        method: "POST",
      });
      expect(headerOf(capture.init, SESSION_HEADER)).toBe(
        "ses_envprovided000000000"
      );
    } finally {
      delete process.env.MY_SESSION_ID;
    }
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

  it("injects x-opencode-parent-session-id when parent session is present", async () => {
    const als = new AsyncLocalStorage<ActiveTurnState>();
    const { capture, mockFetch } = createCaptureFetch();
    const testSession = openCodeSessionIdFor("child-subagent");
    const testParentSession = openCodeSessionIdFor("parent-lead");
    const patched = patchFetch(mockFetch, als, resolveConfig());

    await als.run(
      {
        parentValue: testParentSession,
        provider: "opencode",
        value: testSession,
      },
      async () => {
        await patched("https://opencode.ai/zen/v1/chat/completions", {
          method: "POST",
        });
      }
    );

    expect(headerOf(capture.init, SESSION_HEADER)).toBe(testSession);
    expect(headerOf(capture.init, "x-opencode-session-id")).toBe(testSession);
    expect(headerOf(capture.init, "x-session-affinity")).toBe(testSession);
    expect(headerOf(capture.init, "x-opencode-parent-session-id")).toBe(
      testParentSession
    );
    expect(headerOf(capture.init, "x-parent-session-id")).toBe(
      testParentSession
    );
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
