/**
 * patchFetch · the identity and session headers a claimed request carries.
 *
 * @module test/fetch-patch-headers.test
 */
import { AsyncLocalStorage } from "node:async_hooks";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  GO_FREE_PROBE,
  seedDivergentCatalog,
} from "./support/catalog-fixture.ts";
import {
  ANTHROPIC_VERSION,
  OPENCODE_UA,
  SESSION_AFFINITY_HEADER,
  SESSION_HEADER,
  SESSION_ID_HEADER,
  clearCapturedApiKeys,
  hasSessionHeader,
  isOpenCodeSessionId,
  openCodeSessionIdFor,
  patchFetch,
  resolveConfig,
  type ActiveTurnState,
} from "./support/src.ts";
import {
  createCaptureFetch,
  headerOf,
  parseJsonBody,
  toolNamesOf,
} from "./test-helpers.ts";

/** A session id a deployment pinned in its environment, valid by derivation. */
const PINNED = openCodeSessionIdFor("pinned-env");

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.OPENCODE_API_KEY;
  delete process.env.OPENCODE_GO_API_KEY;
  delete process.env.OPENCODE_SESSION_ID;
  delete process.env.XDG_DATA_HOME;
  clearCapturedApiKeys();
});

describe("patchFetch · headers", () => {
  it("fills anthropic-version on a Messages request that lacks it, keeps a caller's own, and adds none on an Authorization protocol", async () => {
    // Nothing below the plugin sends the version (pi-ai's anthropic adapter
    // does not), and the gateway treats a Messages call without it as a client
    // error, so the plugin supplies it — and only where the protocol reads its
    // credential from x-api-key.
    process.env.OPENCODE_API_KEY = "sk-zen-version-test";
    const als = new AsyncLocalStorage<ActiveTurnState>();
    const versionOn = async (
      url: string,
      headers: Record<string, string> = {}
    ): Promise<string | null> => {
      const { capture, mockFetch } = createCaptureFetch();
      const patched = patchFetch(mockFetch, als, resolveConfig());
      await patched(url, { body: "{}", headers, method: "POST" });
      return headerOf(capture.init, "anthropic-version");
    };

    const messages = "https://opencode.ai/zen/v1/messages";
    expect(await versionOn(messages)).toBe(ANTHROPIC_VERSION);
    expect(
      await versionOn(messages, { "anthropic-version": "2099-01-01" })
    ).toBe("2099-01-01");
    expect(
      await versionOn("https://opencode.ai/zen/v1/chat/completions")
    ).toBeNull();
  });

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

  it("uses the configured session id env outside a turn", async () => {
    const als = new AsyncLocalStorage<ActiveTurnState>();
    const { capture, mockFetch } = createCaptureFetch();
    process.env.MY_SESSION_ID = PINNED;
    try {
      const patched = patchFetch(
        mockFetch,
        als,
        resolveConfig({ sessionIdEnv: "MY_SESSION_ID" })
      );
      await patched("https://opencode.ai/zen/v1/chat/completions", {
        method: "POST",
      });
      expect(headerOf(capture.init, SESSION_HEADER)).toBe(PINNED);
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

  it("keeps a real session header, replaces a malformed one, and honours a pinned env id", async () => {
    const als = new AsyncLocalStorage<ActiveTurnState>();
    const config = resolveConfig();
    // A real id: ses_ + 12 hex + 14 base62, which is what the client sends.
    const real = openCodeSessionIdFor("caller");

    const { capture: keep, mockFetch: keepFetch } = createCaptureFetch();
    await patchFetch(
      keepFetch,
      als,
      config
    )("https://opencode.ai/zen/v1/responses", {
      headers: { [SESSION_HEADER]: real },
    });
    expect(headerOf(keep.init, SESSION_HEADER)).toBe(real);

    // A header that merely starts with `ses_` is not a session id. Sending it
    // earns a 401 Invalid API key, which reads like a credential fault — so it
    // is replaced by a derived id instead. Measured: `ses_dsh_default` is a real
    // value a deployment pinned, and the auto-review pass, which runs outside any
    // tracked turn, is where it would have been used.
    const { capture: malformed, mockFetch: malformedFetch } =
      createCaptureFetch();
    await patchFetch(
      malformedFetch,
      als,
      config
    )("https://opencode.ai/zen/v1/responses", {
      headers: { [SESSION_HEADER]: "ses_dsh_default" },
    });
    const replaced = headerOf(malformed.init, SESSION_HEADER);
    expect(replaced).not.toBe("ses_dsh_default");
    expect(replaced).toMatch(/^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/u);

    process.env.OPENCODE_SESSION_ID = PINNED;
    const { capture: envCap, mockFetch: envFetch } = createCaptureFetch();
    await patchFetch(
      envFetch,
      als,
      config
    )("https://opencode.ai/zen/v1/responses", {
      headers: { [SESSION_HEADER]: "bogus" },
    });
    expect(headerOf(envCap.init, SESSION_HEADER)).toBe(PINNED);
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

    // The four session headers are not one value. The client's own source
    // (`packages/core/src/session/model-request.ts`) sends the CHILD's id in
    // `x-opencode-session-id` and the affinity - `parentID ?? fork ?? id` - in
    // the other three, so a subagent identifies itself while its cache grouping
    // follows the parent. This plugin used the child's id for all four, which
    // put a subagent in its own cache group; the affinity pair belongs to the
    // relay branch instead.
    expect(headerOf(capture.init, "x-opencode-session-id")).toBe(testSession);
    expect(headerOf(capture.init, SESSION_HEADER)).toBe(testSession);
    expect(headerOf(capture.init, "x-session-affinity")).toBeNull();
    expect(headerOf(capture.init, SESSION_ID_HEADER)).toBeNull();
    expect(headerOf(capture.init, "x-opencode-parent-session-id")).toBe(
      testParentSession
    );
    expect(headerOf(capture.init, "x-parent-session-id")).toBe(
      testParentSession
    );
  });

  it("sends the affinity pair for a relay and not for an OpenCode plane", async () => {
    // The same split 1.19.4 makes, read from
    // `packages/opencode/src/session/llm/request.ts:190-202`: for a provider that
    // starts with `opencode` the client sends `x-opencode-session`; for anything
    // else - a relay a deployment claimed by URL - it sends `x-session-affinity`
    // and `X-Session-Id`. This plugin used to send all three everywhere, which is
    // neither generation's behaviour.
    const als = new AsyncLocalStorage<ActiveTurnState>();
    const { capture, mockFetch } = createCaptureFetch();
    const patched = patchFetch(mockFetch, als, resolveConfig());
    const session = openCodeSessionIdFor("relay-turn");

    await als.run({ provider: "my-relay", value: session }, async () => {
      await patched("https://opencode.ai/zen/v1/chat/completions", {
        headers: {},
        method: "POST",
      });
    });

    expect(headerOf(capture.init, "x-opencode-session-id")).toBe(session);
    expect(headerOf(capture.init, SESSION_AFFINITY_HEADER)).toBe(session);
    expect(headerOf(capture.init, SESSION_ID_HEADER)).toBe(session);
  });

  it("reads the plane from the URL first and the turn's route off a gateway", async () => {
    // `route` has two arms. A gateway URL names its plane and wins over the
    // turn's provider; a URL that names no plane (a relay the turn's provider
    // claims) falls back to the turn's route.
    await seedDivergentCatalog();
    const als = new AsyncLocalStorage<ActiveTurnState>();
    const config = resolveConfig({ freeModelMarker: "none-of-these" });
    const send = async (provider: string, url: string): Promise<unknown> => {
      const { capture, mockFetch } = createCaptureFetch();
      const value = openCodeSessionIdFor(`route-${provider}-${url}`);
      await als.run({ provider, value }, async () => {
        await patchFetch(
          mockFetch,
          als,
          config
        )(url, {
          body: JSON.stringify({ input: "hi", model: GO_FREE_PROBE }),
          headers: { "Content-Type": "application/json" },
          method: "POST",
        });
      });
      return toolNamesOf(parseJsonBody(capture.init?.body));
    };

    // Off a gateway: the turn's route decides.
    expect(
      await send("opencode-go", "https://relay.example/v1/responses")
    ).toEqual(["read", "bash"]);
    expect(
      await send("opencode", "https://relay.example/v1/responses")
    ).toBeUndefined();
    // On a gateway: the URL's plane decides, whatever the turn says.
    expect(
      await send("opencode", "https://opencode.ai/zen/go/v1/responses")
    ).toEqual(["read", "bash"]);
    expect(
      await send("opencode-go", "https://opencode.ai/zen/v1/responses")
    ).toBeUndefined();
  });

  it("hasSessionHeader answers false for a header list the platform refuses to read", () => {
    expect(
      hasSessionHeader("https://opencode.ai/zen/v1/responses", {
        headers: [["not a header name", "x"]],
      })
    ).toBe(false);
  });

  it('sessionIdEnv "" reads no variable: a pinned OPENCODE_SESSION_ID is ignored outside a turn', async () => {
    // `resolveConfig` turns a blank name into the default, so the blank reaches
    // the patch only as a resolved config handed over directly: the patch still
    // reads it as "no variable", never as the empty name.
    process.env.OPENCODE_SESSION_ID = PINNED;
    const { capture, mockFetch } = createCaptureFetch();
    await patchFetch(mockFetch, new AsyncLocalStorage<ActiveTurnState>(), {
      ...resolveConfig(),
      sessionIdEnv: "",
    })("https://opencode.ai/zen/v1/models");
    const sent = headerOf(capture.init, SESSION_HEADER);
    expect(sent).not.toBe(PINNED);
    expect(isOpenCodeSessionId(sent)).toBe(true);
  });
});
