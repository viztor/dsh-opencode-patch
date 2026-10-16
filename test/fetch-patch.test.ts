/**
 * patchFetch.
 *
 * Split out of the former monolithic `plugin.test.ts`.
 *
 * @module test/fetch-patch.test
 */

import { AsyncLocalStorage } from "node:async_hooks";

import { afterEach, describe, expect, it, vi } from "vitest";

import { name } from "../src/identity.ts";
import {
  DUMMY_BASH_TOOL,
  DUMMY_READ_TOOL,
  OPENCODE_UA,
  SESSION_AFFINITY_HEADER,
  SESSION_HEADER,
  clearCapturedApiKeys,
  getCapturedApiKey,
  recordCapturedApiKey,
  openCodeSessionIdFor,
  patchFetch,
  resolveConfig,
  type ActiveTurnState,
} from "../src/index.ts";
import { createLoginCredentialReader } from "../src/login-credential.ts";
import { createTokenStore } from "../src/token-store.ts";
import {
  createCaptureFetch,
  createCredentialsSeam,
  createOpencodeStore,
  headerOf,
  parseJsonBody,
  toolNamesOf,
} from "./test-helpers.ts";

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.OPENCODE_API_KEY;
  delete process.env.OPENCODE_GO_API_KEY;
  delete process.env.OPENCODE_SESSION_ID;
  delete process.env.XDG_DATA_HOME;
  clearCapturedApiKeys();
});

describe("patchFetch", () => {
  it("reports a refused credential so a pool can rotate, and only for those", async () => {
    // Rotation is driven from here because this interceptor is the only place
    // that sees the answers of routes the WRAPPER serves and of the Go plane -
    // neither of which passes through a route of ours. So the statuses that mean
    // "this credential is spent" have to arrive here.
    const als = new AsyncLocalStorage<ActiveTurnState>();
    const seen: { plane: string; status: number }[] = [];

    for (const [status, plane] of [
      [401, "opencode"],
      [429, "opencode-go"],
    ] as const) {
      seen.length = 0;
      const failing = vi.fn(async () =>
        Response.json({ error: { message: "no" } }, { status })
      );
      const patched = patchFetch(
        failing as unknown as typeof fetch,
        als,
        resolveConfig(),
        {
          onCredentialFailure: (seenPlane, seenStatus) => {
            seen.push({ plane: seenPlane, status: seenStatus });
          },
        }
      );
      const url =
        plane === "opencode"
          ? "https://opencode.ai/zen/v1/chat/completions"
          : "https://opencode.ai/zen/go/v1/chat/completions";
      await patched(url, {
        body: JSON.stringify({ messages: [] }),
        headers: {},
        method: "POST",
      });
      expect(seen, `status ${status}`).toEqual([{ plane, status }]);
    }
  });

  it("names the sources it consulted when no credential resolves", async () => {
    // The guard for the tier bug. A mis-classified tier made a captured key
    // invisible, the adapter's placeholder went out, and the only symptom was a
    // 401 the user read as an invalid key on a credential that was fine. So the
    // silence is replaced by a line that states what each source answered.
    const als = new AsyncLocalStorage<ActiveTurnState>();
    const warnings: unknown[][] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args);
    };
    try {
      const ok = vi.fn(async () =>
        Response.json({ ok: true }, { status: 200 })
      );
      const patched = patchFetch(
        ok as unknown as typeof fetch,
        als,
        resolveConfig(),
        {}
      );
      // A gateway request with no credential anywhere: no key on the request, no
      // captured key, no env var, no login, and the installation store off.
      await patched("https://opencode.ai/inference/v1/chat/completions", {
        body: JSON.stringify({ messages: [] }),
        headers: {},
        method: "POST",
      });
    } finally {
      console.warn = original;
    }

    const line = warnings
      .map((args) => args.map(String).join(" "))
      .find((text) => text.includes("no credential resolved"));
    expect(line, "the absence must be reported, not passed over").toBeDefined();
    // It states what it consulted and what each answered, so a missing env var
    // reads differently from a missing login.
    expect(line).toContain("opencode");
    expect(line).toContain("OPENCODE_API_KEY: unset");
    expect(line).toContain(
      "a key captured from a live request (policy auto): none"
    );
    expect(line).toContain("not enabled");
  });

  it("does not name the sources when a credential does resolve", async () => {
    const als = new AsyncLocalStorage<ActiveTurnState>();
    const warnings: unknown[][] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args);
    };
    try {
      const ok = vi.fn(async () =>
        Response.json({ ok: true }, { status: 200 })
      );
      const patched = patchFetch(
        ok as unknown as typeof fetch,
        als,
        resolveConfig(),
        {}
      );
      await patched("https://opencode.ai/inference/v1/chat/completions", {
        body: JSON.stringify({ messages: [] }),
        headers: { authorization: "Bearer oc_sk_a_real_key" },
        method: "POST",
      });
    } finally {
      console.warn = original;
    }
    const line = warnings
      .map((args) => args.map(String).join(" "))
      .find((text) => text.includes("no credential resolved"));
    expect(line).toBeUndefined();
  });

  it("does not report a status that is not about the credential", async () => {
    // 403 is the gateway's answer for a model the account has not enabled, and
    // rotating a working credential over that would move a deployment off a
    // good key for a model problem. 200 is obviously not one either.
    const als = new AsyncLocalStorage<ActiveTurnState>();
    const seen: { plane: string; status: number }[] = [];
    for (const status of [200, 403, 404, 500]) {
      seen.length = 0;
      const answering = vi.fn(async () =>
        Response.json({ error: { message: "no" } }, { status })
      );
      const patched = patchFetch(
        answering as unknown as typeof fetch,
        als,
        resolveConfig(),
        {
          onCredentialFailure: (plane, seenStatus) => {
            seen.push({ plane, status: seenStatus });
          },
        }
      );
      await patched("https://opencode.ai/zen/v1/chat/completions", {
        body: JSON.stringify({ messages: [] }),
        headers: {},
        method: "POST",
      });
      expect(seen, `status ${status}`).toEqual([]);
    }
  });

  it("never reports a request that is not gateway traffic, even on a 401", async () => {
    // Stronger than checking the plane is empty: a URL that is not ours is not
    // examined at all, so there is nothing to mis-attribute. Rotation is a side
    // effect and the safest one is the one that does not happen.
    const als = new AsyncLocalStorage<ActiveTurnState>();
    const seen: { plane: string; status: number }[] = [];
    const failing = vi.fn(async () => new Response("{}", { status: 401 }));
    const patched = patchFetch(
      failing as unknown as typeof fetch,
      als,
      resolveConfig(),
      {
        onCredentialFailure: (plane, status) => {
          seen.push({ plane, status });
        },
      }
    );
    await patched("https://api.deepseek.com/v1/chat/completions", {
      body: "{}",
      method: "POST",
    });
    expect(seen).toEqual([]);
  });

  it("reports each claimed request to the debug hook, presence not values", async () => {
    // The request monitor answers "was this request patched, and how?" — the
    // question a run that misbehaves poses and an answer invisible from outside,
    // because the gateway's reply for a malformed session id reads exactly like
    // its reply for a bad credential. What the interceptor SAW and SENT is
    // recorded; the credential itself has no business in a log, so the entry
    // carries presence booleans, never the header values.
    const als = new AsyncLocalStorage<ActiveTurnState>();
    const entries: Record<string, unknown>[] = [];
    const answering = vi.fn(async () => Response.json({ ok: true }));
    const patched = patchFetch(
      answering as unknown as typeof fetch,
      als,
      resolveConfig(),
      {
        debug: (entry) => {
          entries.push(entry);
        },
      }
    );
    const sessionId = openCodeSessionIdFor("session-debug-1");
    const url = "https://opencode.ai/zen/v1/chat/completions";
    await patched(url, {
      body: JSON.stringify({ messages: [] }),
      headers: {
        Authorization: "Bearer unused",
        "User-Agent": "dsh/0.0.0",
        "x-opencode-org-id": "wrk_debug",
        [SESSION_HEADER]: sessionId,
      },
      method: "POST",
    });
    expect(entries).toHaveLength(1);
    const [entry] = entries;
    expect(entry?.auth).toBe(true);
    expect(entry?.claimed).toBe(true);
    expect(entry?.plane).toBe("opencode");
    expect(entry?.session).toBe(sessionId);
    expect(entry?.sessionFormat).toBe(true);
    expect(entry?.org).toBe("wrk_debug");
    // What was SENT, not what the caller offered: the patch installs its own
    // User-Agent on every claimed request, so that is the value the entry
    // records — a caller's UA never reaches the gateway.
    expect(entry?.userAgent).toBe(OPENCODE_UA);
    expect(entry?.status).toBe(200);
    expect(entry?.url).toBe(url);
  });

  it("records an unauthenticated claim as absence, and skips foreign traffic", async () => {
    // A claimed request with no credential is the key deployment's normal state,
    // and the entry has to say so as absence — false and null, never a value
    // that looks like one. What it may NOT do is leave the request bare: a
    // session is always injected (derived when the deployment pinned none) and
    // the CLI User-Agent always replaces the caller's. A request that is not ours
    // is not examined at all, so it produces no entry rather than an empty one.
    const als = new AsyncLocalStorage<ActiveTurnState>();
    const entries: Record<string, unknown>[] = [];
    const answering = vi.fn(async () => Response.json({ ok: true }));
    const patched = patchFetch(
      answering as unknown as typeof fetch,
      als,
      resolveConfig(),
      {
        debug: (entry) => {
          entries.push(entry);
        },
      }
    );
    await patched("https://opencode.ai/zen/v1/chat/completions", {
      body: JSON.stringify({ messages: [] }),
      headers: {},
      method: "POST",
    });
    await patched("https://api.deepseek.com/v1/chat/completions", {
      body: "{}",
      method: "POST",
    });
    expect(entries).toHaveLength(1);
    const [entry] = entries;
    expect(entry?.auth).toBe(false);
    expect(entry?.claimed).toBe(true);
    expect(entry?.session).toBe(openCodeSessionIdFor("default"));
    expect(entry?.sessionFormat).toBe(true);
    expect(entry?.org).toBeNull();
    expect(entry?.userAgent).toBe(OPENCODE_UA);
  });

  it("carries the credential's org, and nothing when it has none", async () => {
    // A session token is half a credential: the gateway gates the free tier on
    // the org that arrived with it, so a request carrying one without the other
    // is answered as though it carried a plain key. And a key deployment has no
    // org, which must not become an empty header.
    const als = new AsyncLocalStorage<ActiveTurnState>();
    const sent: Record<string, string> = {};
    const capture = vi.fn(
      async (_url: unknown, init?: { headers?: unknown }) => {
        const headers = new Headers(init?.headers as HeadersInit | undefined);
        sent.org = headers.get("x-opencode-org-id") ?? "(absent)";
        return new Response("{}", { status: 200 });
      }
    );

    const withOrg = patchFetch(
      capture as unknown as typeof fetch,
      als,
      resolveConfig(),
      { resolveOrg: (plane) => (plane === "opencode" ? "wrk_test" : undefined) }
    );
    await withOrg("https://opencode.ai/zen/v1/chat/completions", {
      body: "{}",
      method: "POST",
    });
    expect(sent.org).toBe("wrk_test");

    // The Go plane's resolver said no, so no header is invented for it.
    await withOrg("https://opencode.ai/zen/go/v1/chat/completions", {
      body: "{}",
      method: "POST",
    });
    expect(sent.org).toBe("(absent)");

    // And with no resolver at all — every key deployment — there is none.
    const withoutOrg = patchFetch(
      capture as unknown as typeof fetch,
      als,
      resolveConfig()
    );
    await withoutOrg("https://opencode.ai/zen/v1/chat/completions", {
      body: "{}",
      method: "POST",
    });
    expect(sent.org).toBe("(absent)");
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

    // Custom marker: only models carrying it fall back — plus any model the
    // catalog calls free, which bypasses the marker entirely.
    const customHit = await runWith("acct-preview-9", {
      freeModelMarker: "preview",
    });
    expect(toolNamesOf(parseJsonBody(customHit))).toEqual(["read", "bash"]);
    const customCatalogFree = await runWith("muse-spark-1.3-contributor-free", {
      freeModelMarker: "preview",
    });
    expect(toolNamesOf(parseJsonBody(customCatalogFree))).toEqual([
      "read",
      "bash",
    ]);
    const customMiss = await runWith("gpt-5-paid", {
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
    process.env.MY_SESSION_ID = "ses_0123456789abZZZZZZZZZZZZZZ";
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
        "ses_0123456789abZZZZZZZZZZZZZZ"
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

  it("keeps a real session header, replaces a malformed one, and honours a pinned env id", async () => {
    const als = new AsyncLocalStorage<ActiveTurnState>();
    const config = resolveConfig();
    // A real id: ses_ + 12 hex + 14 base62, which is what the client sends.
    const real = "ses_ed62aae61ffeA6UwzEFN9YNKk8";

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

    process.env.OPENCODE_SESSION_ID = "ses_0123456789abZZZZZZZZZZZZZZ";
    const { capture: envCap, mockFetch: envFetch } = createCaptureFetch();
    await patchFetch(
      envFetch,
      als,
      config
    )("https://opencode.ai/zen/v1/responses", {
      headers: { [SESSION_HEADER]: "bogus" },
    });
    expect(headerOf(envCap.init, SESSION_HEADER)).toBe(
      "ses_0123456789abZZZZZZZZZZZZZZ"
    );
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
    expect(headerOf(capture.init, "x-session-id")).toBeNull();
    expect(headerOf(capture.init, "x-opencode-parent-session-id")).toBe(
      testParentSession
    );
    expect(headerOf(capture.init, "x-parent-session-id")).toBe(
      testParentSession
    );
  });

  it("sends the affinity pair for a relay and not for an OpenCode plane", async () => {
    // The same split 1.19.3 makes, read from
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
    expect(headerOf(capture.init, "x-session-id")).toBe(session);
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
    // The gateway checks read+bash on completions too, so a free completions
    // body gains both; a non-JSON route stays untouched (covered below by the
    // models-listing case in tool-fallback tests).
    expect(toolNamesOf(parseJsonBody(chat))).toEqual(["read", "bash"]);

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

  it("names the tools a request carries for the debug entry, in either nesting", async () => {
    // The debug entry answers "which tools did the interceptor see?", because
    // the gateway's refusal on a free-tier body is about exactly that. DSH
    // sends both nestings - `{ name }` at the top level and `{ function:
    // { name } }` - and a body the parser cannot read must be absence, not a
    // throw and not a guess.
    const als = new AsyncLocalStorage<ActiveTurnState>();
    const entries: Record<string, unknown>[] = [];
    const answering = vi.fn(async () => Response.json({ ok: true }));
    const patched = patchFetch(
      answering as unknown as typeof fetch,
      als,
      resolveConfig(),
      {
        debug: (entry) => {
          entries.push(entry);
        },
      }
    );
    const named = async (body: RequestInit["body"]) => {
      await patched("https://opencode.ai/zen/v1/responses", {
        body,
        method: "POST",
      });
      return entries.at(-1)?.toolNames;
    };

    // Both nestings, in one list, in order.
    expect(
      await named(
        JSON.stringify({
          input: "hi",
          model: "gpt-5-paid",
          tools: [{ name: "read" }, { function: { name: "bash" } }],
        })
      )
    ).toBe("read,bash");

    // Unusable entries are skipped by shape, never invented.
    expect(
      await named(
        JSON.stringify({
          input: "hi",
          model: "gpt-5-paid",
          tools: [
            "junk",
            7,
            null,
            { name: 5 },
            { function: null },
            { function: { name: 6 } },
          ],
        })
      )
    ).toBe("");

    // Bodies that are not JSON objects (or not strings at all) are absence too.
    expect(await named("42")).toBe("");
    expect(await named("null")).toBe("");
    expect(await named("{not-json")).toBe("");
    expect(await named(Buffer.from("{}", "utf-8"))).toBe("");
    expect(await named("")).toBe("");
  });

  it("sends a Request whose body is already spent, unread and unrebuilt", async () => {
    // A caller can hand over a Request it has already read; clone() throws on
    // a disturbed stream, and the interceptor must fall back to sending the
    // request as it stands - not with a guessed body, and not a dropped one.
    const als = new AsyncLocalStorage<ActiveTurnState>();
    const seen: unknown[] = [];
    const entries: Record<string, unknown>[] = [];
    const mockFetch = async (input: RequestInfo | URL): Promise<Response> => {
      seen.push(input);
      return new Response("{}", { status: 200 });
    };
    const patched = patchFetch(mockFetch, als, resolveConfig(), {
      debug: (entry) => {
        entries.push(entry);
      },
    });
    const request = new Request("https://opencode.ai/zen/v1/responses", {
      body: JSON.stringify({ model: "muse-spark-1.3-contributor-free" }),
      method: "POST",
    });
    await request.text();

    await patched(request);

    expect(seen).toHaveLength(1);
    expect(seen[0], "the same object went out, untouched").toBe(request);
    expect(entries.at(-1)?.bodySource).toBe("none");
  });

  it("injects into a Request input by rebuilding it with the same method", async () => {
    // The body source the bug was about: DSH sends inference as
    // fetch(new Request(url, { body })). Injection has to produce a NEW
    // Request - a Request's body cannot be swapped in place - and the patch's
    // headers must still ride along in the init.
    const als = new AsyncLocalStorage<ActiveTurnState>();
    const testSession = openCodeSessionIdFor("request-rebuild");
    const seen: unknown[] = [];
    let sentInit: RequestInit | undefined;
    const entries: Record<string, unknown>[] = [];
    const mockFetch = async (
      input: RequestInfo | URL,
      init?: RequestInit
    ): Promise<Response> => {
      seen.push(input);
      sentInit = init;
      return new Response("{}", { status: 200 });
    };
    const patched = patchFetch(mockFetch, als, resolveConfig(), {
      debug: (entry) => {
        entries.push(entry);
      },
    });
    const request = new Request("https://opencode.ai/zen/v1/responses", {
      body: JSON.stringify({
        input: "hi",
        model: "muse-spark-1.3-contributor-free",
      }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });

    await als.run({ provider: "opencode", value: testSession }, async () => {
      await patched(request);
    });

    expect(seen[0]).not.toBe(request);
    expect(seen[0]).toBeInstanceOf(Request);
    const wire = seen[0] as Request;
    expect(wire.method).toBe("POST");
    expect(wire.headers.get("content-type")).toBe("application/json");
    expect(toolNamesOf(parseJsonBody(await wire.text()))).toEqual([
      DUMMY_READ_TOOL.name,
      DUMMY_BASH_TOOL.name,
    ]);
    expect(headerOf(sentInit, SESSION_HEADER)).toBe(testSession);
    expect(entries.at(-1)?.bodySource).toBe("request");
    expect(entries.at(-1)?.toolNames).toBe(
      [DUMMY_READ_TOOL.name, DUMMY_BASH_TOOL.name].join(",")
    );
  });

  it("resolves a credential for the Zen free model that gets redirected to /responses", async () => {
    // The reported symptom: a Go-plane free model works, Zen free models do not.
    // `muse-spark-1.3-contributor-free` is the ONE Zen free model naming
    // `@ai-sdk/openai`, so the stream hook redirects it to `opencode-responses` -
    // a route the plugin mounts itself, which therefore carries pi's
    // `Bearer unused` placeholder and depends on THIS injection to authenticate.
    //
    // A key captured from the user's own plane route, on the endpoint family the
    // catalog now names.
    const als = new AsyncLocalStorage<ActiveTurnState>();
    const { capture, mockFetch } = createCaptureFetch();
    const patched = patchFetch(mockFetch, als, resolveConfig());

    recordCapturedApiKey("oc_sk_zen_key", "opencode");
    // Read through `Headers`, because the patch hands the adapter a `Headers`
    // instance rather than the plain object it was given.
    const auth = (init?: RequestInit): string | null =>
      headerOf(init, "authorization");

    await als.run({ provider: "opencode", value: "ses_x" }, async () => {
      await patched("https://opencode.ai/inference/v1/responses", {
        body: JSON.stringify({ model: "muse-spark-1.3-contributor-free" }),
        // The sentinel the mounted route declares; a placeholder must be
        // replaced, never forwarded.
        headers: { authorization: "Bearer unused" },
        method: "POST",
      });
    });

    // The captured Zen key reaches the wire, so the request authenticates rather
    // than going out as `Bearer unused` - which is the 401 that reads as an
    // invalid API key.
    expect(auth(capture.init)).toBe("Bearer oc_sk_zen_key");
  });

  it("captures API key from request headers on intercepted OpenCode requests", async () => {
    const als = new AsyncLocalStorage<ActiveTurnState>();
    const { mockFetch } = createCaptureFetch();
    const patched = patchFetch(mockFetch, als, resolveConfig());

    expect(getCapturedApiKey("opencode-go")).toBeUndefined();

    await als.run(
      { provider: "opencode-go", value: "ses_header_key" },
      async () => {
        await patched("https://opencode.ai/zen/go/v1/chat/completions", {
          headers: {
            Authorization: "Bearer sk-intercepted-go-key-xyz",
            "Content-Type": "application/json",
          },
          method: "POST",
        });
      }
    );

    expect(getCapturedApiKey("opencode-go")).toBe("sk-intercepted-go-key-xyz");
    expect(getCapturedApiKey(undefined, "go")).toBe(
      "sk-intercepted-go-key-xyz"
    );
  });

  it("picks the captured key for the request's TIER, not the most recent one", async () => {
    const als = new AsyncLocalStorage<ActiveTurnState>();
    const { capture, mockFetch } = createCaptureFetch();
    const patched = patchFetch(mockFetch, als, resolveConfig());

    // A Go key captured first…
    recordCapturedApiKey(
      "sk-go-key-aaa",
      "opencode-go",
      "https://opencode.ai/zen/go/v1/chat/completions"
    );
    // …then a Zen key, so "most recently seen" is now the WRONG tier for a Go
    // call. A Zen key sent to the Go quota endpoint is rejected outright.
    recordCapturedApiKey(
      "oc_sk_zen_key_bbb",
      "opencode",
      "https://opencode.ai/zen/v1/messages"
    );

    await als.run(
      // A route the user renamed: the provider-id lookup misses by design, so
      // the tier is what has to save this.
      { provider: "my-renamed-route", value: "ses_renamed" },
      async () => {
        await patched("https://opencode.ai/zen/go/v1/chat/completions", {
          headers: { Authorization: "Bearer unused" },
          method: "POST",
        });
      }
    );

    expect(headerOf(capture.init, "authorization")).toBe(
      "Bearer sk-go-key-aaa"
    );
  });

  it.each(["opencode", "opencode-go"])(
    "fills a keyless %s request from a login written after patch creation",
    async (plane) => {
      const { ctx, credentials } = createCredentialsSeam();
      const store = createTokenStore({
        credentials,
        plane: "opencode",
        scope: name,
      });
      expect(store).toBeDefined();
      const { capture, mockFetch } = createCaptureFetch();
      const patched = patchFetch(
        mockFetch,
        new AsyncLocalStorage<ActiveTurnState>(),
        resolveConfig(),
        {
          loginCredential: createLoginCredentialReader(ctx),
          resolveOrg: () => "org_stale",
        }
      );
      const url = `https://opencode.ai/zen/${plane === "opencode-go" ? "go/" : ""}v1/chat/completions`;
      await patched(url, { headers: { Authorization: "Bearer unused" } });
      expect(headerOf(capture.init, "authorization")).toBe("Bearer unused");
      await store!.write({
        accessToken: "st_login",
        expiresInSeconds: 3600,
        orgId: "org_login",
      });
      await patched(url, { headers: { Authorization: "Bearer unused" } });
      expect(headerOf(capture.init, "authorization")).toBe("Bearer st_login");
      expect(headerOf(capture.init, "x-opencode-org-id")).toBe("org_login");
      await store!.write({
        accessToken: "st_new_owner",
        expiresInSeconds: 3600,
      });
      await patched(url, {
        headers: { "x-opencode-org-id": "org_old_header" },
      });
      expect(headerOf(capture.init, "authorization")).toBe(
        "Bearer st_new_owner"
      );
      expect(headerOf(capture.init, "x-opencode-org-id")).toBeNull();
    }
  );

  it("keeps request, captured, and declared auth ahead of a login", async () => {
    const loginCredential = vi.fn(async () => ({
      accessToken: "st_should_not_run",
      orgId: "org_login",
    }));
    const { capture, mockFetch } = createCaptureFetch();
    const als = new AsyncLocalStorage<ActiveTurnState>();
    const patched = patchFetch(mockFetch, als, resolveConfig(), {
      loginCredential,
    });
    const url = "https://opencode.ai/zen/v1/chat/completions";
    await patched(url, { headers: { Authorization: "Bearer explicit" } });
    expect(headerOf(capture.init, "authorization")).toBe("Bearer explicit");
    clearCapturedApiKeys();
    await patched(url, { headers: { "x-api-key": "anthropic_explicit" } });
    expect(headerOf(capture.init, "authorization")).toBe(
      "Bearer anthropic_explicit"
    );
    clearCapturedApiKeys();
    process.env.OPENCODE_API_KEY = "declared";
    await patched(url, { headers: { Authorization: "Bearer unused" } });
    expect(headerOf(capture.init, "authorization")).toBe("Bearer declared");
    recordCapturedApiKey("captured", "opencode", url);
    await patched(url, { headers: {} });
    expect(headerOf(capture.init, "authorization")).toBe("Bearer captured");
    await patchFetch(
      mockFetch,
      als,
      resolveConfig({ keySource: "configured" }),
      { loginCredential }
    )(url, { headers: {} });
    expect(headerOf(capture.init, "authorization")).toBe("Bearer declared");
    expect(loginCredential).not.toHaveBeenCalled();
  });

  it.each([
    ["/zen/v1/messages", "x-api-key"],
    ["/zen/v1/models/gemini-3.8-flash:streamGenerateContent", "x-goog-api-key"],
    ["/zen/go/v1/chat/completions", "authorization"],
  ])(
    "repairs missing and placeholder auth on %s in its wire header",
    async (path, header) => {
      const { capture, mockFetch } = createCaptureFetch();
      const loginCredential = vi.fn(async () => ({
        accessToken: "st_protocol",
        orgId: "org_protocol",
      }));
      const patched = patchFetch(
        mockFetch,
        new AsyncLocalStorage<ActiveTurnState>(),
        resolveConfig(),
        { loginCredential }
      );
      for (const value of [undefined, "none", "  UNUSED  "]) {
        await patched(`https://opencode.ai${path}`, {
          headers:
            value === undefined
              ? {}
              : {
                  [header]:
                    header === "authorization" ? `bearer ${value}` : value,
                },
        });
        expect(headerOf(capture.init, header)).toBe(
          header === "authorization" ? "Bearer st_protocol" : "st_protocol"
        );
        expect(headerOf(capture.init, "x-opencode-org-id")).toBe(
          "org_protocol"
        );
      }
      expect(loginCredential).toHaveBeenCalledTimes(3);
    }
  );

  it.each(["x-api-key", "x-goog-api-key"])(
    "preserves a real %s even beside a Bearer placeholder",
    async (header) => {
      const { capture, mockFetch } = createCaptureFetch();
      const loginCredential = vi.fn(async () => ({ accessToken: "st_wrong" }));
      const patched = patchFetch(
        mockFetch,
        new AsyncLocalStorage<ActiveTurnState>(),
        resolveConfig({ keySource: "configured" }),
        { loginCredential }
      );
      await patched("https://opencode.ai/zen/v1/messages", {
        headers: {
          authorization: "Bearer unused",
          [header]: "explicit_wire_key",
        },
      });
      expect(headerOf(capture.init, header)).toBe("explicit_wire_key");
      expect(getCapturedApiKey(undefined, "zen")).toBe("explicit_wire_key");
      expect(loginCredential).not.toHaveBeenCalled();
    }
  );

  it("does not infer a gateway plane from query text on a claimed foreign request", async () => {
    const loginCredential = vi.fn(async () => ({ accessToken: "st_secret" }));
    const als = new AsyncLocalStorage<ActiveTurnState>();
    const { mockFetch, capture } = createCaptureFetch();
    await als.run({ provider: "opencode", value: "ses_fixture" }, () =>
      patchFetch(mockFetch, als, resolveConfig(), { loginCredential })(
        "https://example.com/api?next=/zen/go/v1/responses"
      )
    );
    expect(loginCredential).not.toHaveBeenCalled();
    expect(headerOf(capture.init, "authorization")).toBeNull();
  });

  it("selects a declared key from the URL's plane rather than a conflicting turn provider", async () => {
    process.env.OPENCODE_API_KEY = "zen_declared";
    process.env.OPENCODE_GO_API_KEY = "go_declared";
    const als = new AsyncLocalStorage<ActiveTurnState>();
    const { mockFetch, capture } = createCaptureFetch();
    await als.run({ provider: "opencode-go", value: "ses_fixture" }, () =>
      patchFetch(
        mockFetch,
        als,
        resolveConfig()
      )("https://opencode.ai/zen/v1/messages")
    );
    expect(headerOf(capture.init, "x-api-key")).toBe("zen_declared");
  });

  it("does not send a request when login refresh fails", async () => {
    const mockFetch = vi.fn(async () => new Response("unexpected"));
    const loginCredential = async () => {
      throw new Error("MISSING_CREDENTIAL: refresh refused");
    };
    await expect(
      patchFetch(
        mockFetch,
        new AsyncLocalStorage<ActiveTurnState>(),
        resolveConfig(),
        { loginCredential }
      )("https://opencode.ai/zen/v1/responses")
    ).rejects.toThrow(/MISSING_CREDENTIAL/);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("does not resolve a login for unclaimed URLs or an unknown gateway plane", async () => {
    const loginCredential = vi.fn(async () => ({ accessToken: "st_secret" }));
    const als = new AsyncLocalStorage<ActiveTurnState>();
    const { capture, mockFetch } = createCaptureFetch();
    const patched = patchFetch(mockFetch, als, resolveConfig(), {
      loginCredential,
    });
    await patched("https://example.com/api", { headers: {} });
    await als.run({ provider: "opencode", value: "ses_fixture" }, () =>
      patched("https://example.com/api", { headers: {} })
    );
    expect(loginCredential).not.toHaveBeenCalled();
    expect(headerOf(capture.init, "authorization")).toBeNull();
  });

  it("uses the opt-in account before the installation key, with its own org", async () => {
    const fixture = createOpencodeStore(
      [{ integrationId: "opencode-go", value: "sk_fixture" }],
      { accessToken: "st_installation", orgId: "org_installation" }
    );
    process.env.XDG_DATA_HOME = fixture.root;
    const { capture, mockFetch } = createCaptureFetch();
    const als = new AsyncLocalStorage<ActiveTurnState>();
    const url = "https://opencode.ai/zen/go/v1/chat/completions";
    try {
      await patchFetch(
        mockFetch,
        als,
        resolveConfig({ readOpencodeStore: true }),
        {
          loginCredential: createLoginCredentialReader({}, true),
          resolveOrg: () => "org_wrong",
        }
      )(url, { headers: {} });
      expect(headerOf(capture.init, "authorization")).toBe(
        "Bearer st_installation"
      );
      expect(headerOf(capture.init, "x-opencode-org-id")).toBe(
        "org_installation"
      );
      await patchFetch(
        mockFetch,
        als,
        resolveConfig({
          credentialOrg: "org_override",
          readOpencodeStore: true,
        }),
        { loginCredential: createLoginCredentialReader({}, true) }
      )(url, { headers: {} });
      expect(headerOf(capture.init, "x-opencode-org-id")).toBe("org_override");
      await patchFetch(mockFetch, als, resolveConfig(), {
        loginCredential: createLoginCredentialReader({}),
      })(url, { headers: {} });
      expect(headerOf(capture.init, "authorization")).toBeNull();
    } finally {
      fixture.cleanup();
    }
  });

  it("pairs concurrent request tokens with their own org, not the shared cache", async () => {
    const sent: Headers[] = [];
    const mockFetch: typeof fetch = (_input, init) => {
      sent.push(new Headers(init?.headers));
      return Promise.resolve(new Response("ok"));
    };
    const patched = patchFetch(
      mockFetch,
      new AsyncLocalStorage<ActiveTurnState>(),
      resolveConfig(),
      {
        loginCredential: async (plane) => ({
          accessToken: `st_${plane}`,
          orgId: `org_${plane}`,
        }),
        resolveOrg: () => "org_other_request",
      }
    );
    await Promise.all([
      patched("https://opencode.ai/zen/v1/responses"),
      patched("https://opencode.ai/zen/go/v1/chat/completions"),
    ]);
    expect(
      sent.map((headers) => [
        headers.get("authorization"),
        headers.get("x-opencode-org-id"),
      ])
    ).toEqual([
      ["Bearer st_opencode", "org_opencode"],
      ["Bearer st_opencode-go", "org_opencode-go"],
    ]);
  });

  it("fills the Authorization header from the installation's store, last", async () => {
    // The request path, not the meter's: this interceptor is where a claimed
    // request that carries no credential gets one, so a switch that read the
    // store for the meter and not here would look wired and serve nothing.
    const store = createOpencodeStore([
      { integrationId: "opencode", value: "oc_sk_fixture_zen" },
      { integrationId: "opencode-go", value: "sk-fixture-go" },
    ]);
    process.env.XDG_DATA_HOME = store.root;
    const als = new AsyncLocalStorage<ActiveTurnState>();
    const call = async (
      config: ReturnType<typeof resolveConfig>,
      url: string
    ): Promise<string | null> => {
      const { capture, mockFetch } = createCaptureFetch();
      await patchFetch(
        mockFetch,
        als,
        config
      )(url, {
        headers: { Authorization: "Bearer unused" },
        method: "POST",
      });
      return headerOf(capture.init, "authorization");
    };

    try {
      const zen = "https://opencode.ai/zen/v1/chat/completions";
      const go = "https://opencode.ai/zen/go/v1/chat/completions";

      // Off by default: the sentinel the caller sent is the one that stays, so
      // a deployment that never opted in cannot reach another tool's file.
      expect(await call(resolveConfig(), zen)).toBe("Bearer unused");

      // Opted in, the store answers — and it answers per PLANE, because the two
      // integrations hold different accounts.
      expect(await call(resolveConfig({ readOpencodeStore: true }), zen)).toBe(
        "Bearer oc_sk_fixture_zen"
      );
      expect(await call(resolveConfig({ readOpencodeStore: true }), go)).toBe(
        "Bearer sk-fixture-go"
      );

      // And everything the deployment declared still outranks it.
      process.env.OPENCODE_API_KEY = "oc_sk_declared";
      expect(await call(resolveConfig({ readOpencodeStore: true }), zen)).toBe(
        "Bearer oc_sk_declared"
      );
      delete process.env.OPENCODE_API_KEY;

      recordCapturedApiKey("oc_sk_captured", "opencode", zen);
      expect(await call(resolveConfig({ readOpencodeStore: true }), zen)).toBe(
        "Bearer oc_sk_captured"
      );
    } finally {
      store.cleanup();
      delete process.env.XDG_DATA_HOME;
    }
  });
});
