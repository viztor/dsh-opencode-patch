/**
 * patchFetch · the credential a claimed request carries, and the report when
 * none resolves.
 *
 * Its siblings: `fetch-patch-headers` (the identity and session headers),
 * `fetch-patch-tools` (the free-tier core-tool fallback) and
 * `fetch-patch-observability` (the debug hook, pass-through answers and the
 * listing fill).
 *
 * @module test/fetch-patch.test
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { freeZenModel, payload, shimFor } from "./support/catalogs.ts";
import { createOpencodeStore } from "./support/opencode-store-fixture.ts";
import {
  type CaptureStore,
  createCaptureStore,
  createCredentials,
  type FetchPatchHooks,
  findModelSpecOn,
  OPENCODE_UA,
  openCodeSessionIdFor,
  patchFetch,
  refreshCatalog,
  resolveConfig,
  SESSION_HEADER,
  type ActiveTurnState,
} from "./support/src.ts";
import { createCaptureFetch, headerOf } from "./test-helpers.ts";

/** An id only the seeded Zen catalog describes, free there. */
const ZEN_ONLY_FREE = "zen-only-free-probe";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete process.env.OPENCODE_API_KEY;
  delete process.env.OPENCODE_GO_API_KEY;
  delete process.env.OPENCODE_SESSION_ID;
  delete process.env.XDG_DATA_HOME;
});

/**
 * A capture store of the case's own, and the hooks that hand the patch a
 * resolver over it, so a case can seed and read what the patch learned.
 */
const storeFor = (
  config: ReturnType<typeof resolveConfig> = resolveConfig()
): { readonly store: CaptureStore; readonly hooks: FetchPatchHooks } => {
  const store = createCaptureStore();
  return {
    hooks: {
      credentials: createCredentials({
        keySource: config.keySource,
        readOpencodeStore: config.readOpencodeStore,
        store,
      }),
    },
    store,
  };
};

describe("patchFetch · another plugin's request (D27)", () => {
  /**
   * A route another plugin writes through pi-ai carries its
   * `x-opencode-plugin` marker. The request goes out as it was sent: the same
   * arguments reach the wrapped fetch, no header of this plugin's is added, no
   * key is filled from the environment, and the request's own key is never
   * captured. Each case runs inside a turn of a plane the plugin claims, the
   * strongest claim there is.
   */
  const turn = { provider: "opencode-go", value: "ses_turn" } as never;

  it.each([
    ["on the init", "x-opencode-plugin"],
    ["in another case", "X-OpenCode-Plugin"],
  ])(
    "passes a marked request through untouched (%s)",
    async (_where, header) => {
      process.env.OPENCODE_GO_API_KEY = "ambient-go-key";
      const als = new AsyncLocalStorage<ActiveTurnState>();
      const seen: unknown[][] = [];
      const original = (async (...args: unknown[]) => {
        seen.push(args);
        return Response.json({ ok: true });
      }) as unknown as typeof fetch;
      const { hooks, store } = storeFor();
      const patched = patchFetch(original, als, resolveConfig(), hooks);
      const init: RequestInit = {
        body: JSON.stringify({ messages: [], model: "deepseek-v4-pro" }),
        headers: { authorization: "Bearer realm-token", [header]: "x/1" },
        method: "POST",
      };
      const url = "https://opencode.ai/zen/go/v1/chat/completions";
      await als.run(turn, () => patched(url, init));
      expect(seen).toHaveLength(1);
      expect(seen[0]?.[0]).toBe(url);
      expect(seen[0]?.[1]).toBe(init);
      expect(new Headers(init.headers).has(SESSION_HEADER)).toBe(false);
      expect(store.get("opencode-go")).toBeUndefined();
      expect(store.get(undefined, "go")).toBeUndefined();
    }
  );

  it("passes a request made inside another plugin's turn through untouched, marker or not: the realm is enough (the known answer: the same request outside it is claimed by URL)", async () => {
    process.env.OPENCODE_GO_API_KEY = "ambient-go-key";
    const als = new AsyncLocalStorage<ActiveTurnState>();
    const seen: unknown[][] = [];
    const original = (async (...args: unknown[]) => {
      seen.push(args);
      return Response.json({ ok: true });
    }) as unknown as typeof fetch;
    const { hooks, store } = storeFor();
    const patched = patchFetch(original, als, resolveConfig(), hooks);
    const url = "https://opencode.ai/zen/go/v1/chat/completions";
    const init: RequestInit = {
      body: JSON.stringify({ messages: [], model: "deepseek-v4-pro" }),
      headers: { authorization: "Bearer realm-token" },
      method: "POST",
    };
    const foreign = { foreign: true, provider: "opencode-go", value: "" };
    await als.run(foreign as ActiveTurnState, () => patched(url, init));
    expect(seen[0]?.[0]).toBe(url);
    expect(seen[0]?.[1]).toBe(init);
    expect(store.get("opencode-go")).toBeUndefined();
    expect(store.get(undefined, "go")).toBeUndefined();
    // Outside the foreign turn the gateway URL is claimed: headers are
    // written. The key is not captured: no turn of the plugin's sent it
    // (OC3).
    await patched(url, init);
    const sent = seen[1]?.[1] as RequestInit | undefined;
    expect(sent).not.toBe(init);
    expect(new Headers(sent?.headers).get(SESSION_HEADER)).toBeTruthy();
    expect(store.get(undefined, "go")).toBeUndefined();
  });

  it("passes a marked Request through as the same object, and still patches the unmarked one (the known answer)", async () => {
    const als = new AsyncLocalStorage<ActiveTurnState>();
    const seen: unknown[][] = [];
    const original = (async (...args: unknown[]) => {
      seen.push(args);
      return Response.json({ ok: true });
    }) as unknown as typeof fetch;
    const { hooks, store } = storeFor();
    const patched = patchFetch(original, als, resolveConfig(), hooks);
    const url = "https://opencode.ai/zen/go/v1/chat/completions";
    const marked = new Request(url, {
      body: "{}",
      headers: {
        authorization: "Bearer realm-token",
        "x-opencode-plugin": "x",
      },
      method: "POST",
    });
    await als.run(turn, () => patched(marked));
    expect(seen[0]?.[0]).toBe(marked);
    expect(seen[0]?.[1]).toBeUndefined();
    expect(store.get(undefined, "go")).toBeUndefined();
    const plain = new Request(url, {
      body: "{}",
      headers: { authorization: "Bearer user-go-key" },
      method: "POST",
    });
    await als.run(turn, () => patched(plain));
    const sent = seen[1]?.[1] as RequestInit | undefined;
    expect(new Headers(sent?.headers).get(SESSION_HEADER)).toBeTruthy();
    expect(store.get(undefined, "go")).toBe("user-go-key");
  });
});

describe("patchFetch · credentials", () => {
  it("names the sources it consulted when no credential resolves", async () => {
    // The guard for the tier bug. A mis-classified tier made a captured key
    // invisible, the adapter's placeholder went out, and the only symptom was a
    // 401 the user read as an invalid key on a credential that was fine. So the
    // silence is replaced by a line that states what each source answered.
    //
    // The request goes to the Go plane, because the Zen plane offers free models
    // the gateway admits with no key at all, and reporting a missing key there
    // sends the reader to set one they do not need — see
    // `docs/upstream-findings.md` §1.5 and the companion test below.
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
      await patched("https://opencode.ai/zen/go/v1/chat/completions", {
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
    expect(line).toContain("opencode-go");
    expect(line).toContain("OPENCODE_GO_API_KEY: unset");
    expect(line).toContain(
      "a key captured from a live request (policy auto): none"
    );
    expect(line).toContain("not enabled");
    // The advice names a path this build has: there is no sign-in row here.
    expect(line).not.toContain("sign in");
    expect(line).toContain("readOpencodeStore");
  });

  it("does NOT report a missing key on a plane that offers free models", async () => {
    // The gateway admits a free model with no credential at all, or with the
    // literal `public` (per-model `allowAnonymous`;
    // `docs/upstream-findings.md` §1.5). So "no credential resolved" is not a
    // fault on the Zen plane, which offers them, and the warning would name a
    // key the user does not need. The Go plane has no free tier, so the same
    // keyless request there does report — the pair pins the distinction.
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
      await patched("https://opencode.ai/zen/v1/chat/completions", {
        body: JSON.stringify({
          messages: [],
          model: freeZenModel(),
        }),
        headers: {},
        method: "POST",
      });
    } finally {
      console.warn = original;
    }

    const lines = warnings
      .map((args) => args.map(String).join(" "))
      .filter((text) => text.includes("no credential resolved"));
    expect(
      lines,
      "a keyless free turn is a success, not a missing credential"
    ).toHaveLength(0);
  });

  it("reads the free model off a Request body, which is how DSH sends a turn", async () => {
    // DSH calls fetch(new Request(url, { body })), so `init` carries no body.
    // The check used to read `init.body` alone and reported every keyless free
    // turn as a missing credential.
    const als = new AsyncLocalStorage<ActiveTurnState>();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const ok = vi.fn(async () => Response.json({ ok: true }));
      const patched = patchFetch(
        ok as unknown as typeof fetch,
        als,
        resolveConfig(),
        {}
      );
      await patched(
        new Request("https://opencode.ai/zen/v1/chat/completions", {
          body: JSON.stringify({ messages: [], model: freeZenModel() }),
          method: "POST",
        })
      );
      const freeLines = warn.mock.calls
        .map((args) => args.map(String).join(" "))
        .filter((text) => text.includes("no credential resolved"));
      expect(freeLines).toHaveLength(0);

      // The same keyless Request for a PAID model is still reported, so the
      // case is not passing because the warning went quiet altogether.
      await patched(
        new Request("https://opencode.ai/zen/v1/chat/completions", {
          body: JSON.stringify({ messages: [], model: "gpt-5.4" }),
          method: "POST",
        })
      );
      expect(
        warn.mock.calls
          .map((args) => args.map(String).join(" "))
          .some((text) => text.includes("no credential resolved for opencode"))
      ).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it("reads the free flag off the other plane's row when the request's plane does not describe the model", async () => {
    // main's lookup is the plane's own row first, then the plane-blind one
    // (`findModelSpecOn(plane, id) ?? findModelSpec(id)`): a model the
    // request's plane does not describe is still asked, rather than read as
    // paid. Seeded, so the premise is the case's own: an id only Zen
    // describes, free there, sent keyless to the Go plane.
    await refreshCatalog(
      async () =>
        Response.json(payload({ zen: [{ free: true, id: ZEN_ONLY_FREE }] })),
      true
    );
    expect(findModelSpecOn("go", ZEN_ONLY_FREE)).toBeUndefined();
    expect(findModelSpecOn("zen", ZEN_ONLY_FREE)?.is_free).toBe(true);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const patched = patchFetch(
      vi.fn(async () => Response.json({ ok: true })) as unknown as typeof fetch,
      new AsyncLocalStorage<ActiveTurnState>(),
      resolveConfig(),
      {}
    );
    const goReport = (): string[] =>
      warn.mock.calls
        .map((args) => args.map(String).join(" "))
        .filter((text) => text.includes("no credential resolved"));
    const send = async (model: string): Promise<void> => {
      await patched("https://opencode.ai/zen/go/v1/chat/completions", {
        body: JSON.stringify({ messages: [], model }),
        method: "POST",
      });
    };

    await send(ZEN_ONLY_FREE);
    expect(goReport(), "the fallback row says free").toHaveLength(0);
    // The known answer: an id neither catalog describes is not free, so the
    // same keyless Go request reports, and the silence above was the row's.
    await send("described-nowhere-x");
    expect(goReport()).toHaveLength(1);
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

  it("carries the credential's org, and nothing when it has none", async () => {
    // A session token needs the org it belongs to — measured, a paid model
    // answers `200` with the org and `403` without — while the free tier is
    // refused with or without one. And a key deployment has no org, which must
    // not become an empty header.
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

  it("replaces pi's placeholder with the captured Zen key on /responses", async () => {
    // The reported symptom was a Zen request on Responses going out with pi's
    // `Bearer unused` placeholder, which reads as an invalid key. The fill does
    // not look at the model (it reads the request's key, then the captured
    // one, then the declared one), so the id below is a neutral uncatalogued
    // one: the subject is the placeholder, not the tier. A placeholder is never
    // forwarded (the fill's one filter, `usableKey`, in `credentials.ts`).
    //
    // A key captured from the user's own plane route, on the endpoint family the
    // catalog now names.
    const als = new AsyncLocalStorage<ActiveTurnState>();
    const { capture, mockFetch } = createCaptureFetch();
    const { hooks, store } = storeFor();
    const patched = patchFetch(mockFetch, als, resolveConfig(), hooks);

    store.record("oc_sk_zen_key", "opencode");
    // Read through `Headers`, because the patch hands the adapter a `Headers`
    // instance rather than the plain object it was given.
    const auth = (init?: RequestInit): string | null =>
      headerOf(init, "authorization");

    await als.run({ provider: "opencode", value: "ses_x" }, async () => {
      await patched("https://opencode.ai/inference/v1/responses", {
        body: JSON.stringify({ model: "acct-responses-9" }),
        // pi's sentinel for a route with no key; a placeholder must be
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
    const { hooks, store } = storeFor();
    const patched = patchFetch(mockFetch, als, resolveConfig(), hooks);

    expect(store.get("opencode-go")).toBeUndefined();

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

    expect(store.get("opencode-go")).toBe("sk-intercepted-go-key-xyz");
    expect(store.get(undefined, "go")).toBe("sk-intercepted-go-key-xyz");
  });

  it("picks the captured key for the request's TIER, not the most recent one", async () => {
    const als = new AsyncLocalStorage<ActiveTurnState>();
    const { capture, mockFetch } = createCaptureFetch();
    const { hooks, store } = storeFor();
    const patched = patchFetch(mockFetch, als, resolveConfig(), hooks);

    // A Go key captured first…
    store.record(
      "sk-go-key-aaa",
      "opencode-go",
      "https://opencode.ai/zen/go/v1/chat/completions"
    );
    // …then a Zen key, so "most recently seen" is now the WRONG tier for a Go
    // call. A Zen key sent to the Go quota endpoint is rejected outright.
    store.record(
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
    const captured = createCaptureStore();
    const call = async (
      config: ReturnType<typeof resolveConfig>,
      url: string
    ): Promise<string | null> => {
      const { capture, mockFetch } = createCaptureFetch();
      await patchFetch(mockFetch, als, config, {
        credentials: createCredentials({
          keySource: config.keySource,
          readOpencodeStore: config.readOpencodeStore,
          store: captured,
        }),
      })(url, {
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

      captured.record("oc_sk_captured", "opencode", zen);
      expect(await call(resolveConfig({ readOpencodeStore: true }), zen)).toBe(
        "Bearer oc_sk_captured"
      );
    } finally {
      store.cleanup();
      delete process.env.XDG_DATA_HOME;
    }
  });

  /**
   * The warning's report, once per patched fetch and plane. Every case below
   * builds its own patch, so the one-per-plane gate never hides a line.
   */
  const reportFor = async (
    config: ReturnType<typeof resolveConfig>,
    url: string,
    init: RequestInit,
    store: CaptureStore = createCaptureStore()
  ): Promise<{ authorization: string | null; line: string | undefined }> => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { capture, mockFetch } = createCaptureFetch();
    let lines: string[] = [];
    try {
      await patchFetch(
        mockFetch,
        new AsyncLocalStorage<ActiveTurnState>(),
        config,
        {
          credentials: createCredentials({
            keySource: config.keySource,
            readOpencodeStore: config.readOpencodeStore,
            store,
          }),
        }
      )(url, init);
      lines = warn.mock.calls.map((args) => args.map(String).join(" "));
    } finally {
      warn.mockRestore();
    }
    return {
      authorization: headerOf(capture.init, "authorization"),
      line: lines.find((text) => text.includes("no credential resolved")),
    };
  };

  /** A paid Zen id, read off the shim rather than named. */
  const paidZenModel = (): string => {
    const spec = shimFor("opencode").find((m) => m.is_free !== true);
    if (spec === undefined) {
      throw new Error("the Zen shim carries no paid model");
    }
    return spec.id;
  };

  it("a placeholder in the plane's variable is reported as set, and nothing fills the wire", async () => {
    // The variable is SET — to the adapter's placeholder — so the report must
    // not send the reader to set it; it says what the variable held, and the
    // placeholder is not a credential, so nothing goes out.
    process.env.OPENCODE_API_KEY = "unused";
    const { authorization, line } = await reportFor(
      resolveConfig(),
      "https://opencode.ai/zen/v1/responses",
      { body: JSON.stringify({ model: paidZenModel() }), method: "POST" }
    );
    expect(authorization).toBeNull();
    expect(line).toContain("OPENCODE_API_KEY: set");
  });

  it("under the configured policy a captured key never fills the wire, and the report says so", async () => {
    const url = "https://opencode.ai/zen/v1/responses";
    const store = createCaptureStore();
    store.record("sk-captured", "opencode", url);
    const { authorization, line } = await reportFor(
      resolveConfig({ keySource: "configured" }),
      url,
      { body: JSON.stringify({ model: paidZenModel() }), method: "POST" },
      store
    );
    expect(authorization).toBeNull();
    expect(line).toContain(
      "a key captured from a live request (policy configured): none"
    );
  });

  it("a Buffer body and a non-JSON body are not free models, so the missing credential is still reported", async () => {
    // A body the free-model check cannot read answers "not free": the warning
    // is the status quo, never a silence bought by a body it did not parse.
    const url = "https://opencode.ai/zen/v1/chat/completions";
    for (const body of [
      Buffer.from(JSON.stringify({ model: freeZenModel() })),
      "not json",
      "7",
    ]) {
      const { line } = await reportFor(resolveConfig(), url, {
        body: body as BodyInit,
        method: "POST",
      });
      expect(line, String(body)).toContain(
        "no credential resolved for opencode"
      );
    }
  });

  it("the report says the installation's store was read when readOpencodeStore is on", async () => {
    // Read and found nothing: an empty data directory is a real installation
    // state, and the report must say the store was consulted, not skipped.
    const empty = mkdtempSync(join(tmpdir(), "dsh-empty-store-"));
    process.env.XDG_DATA_HOME = empty;
    try {
      const { authorization, line } = await reportFor(
        resolveConfig({ readOpencodeStore: true }),
        "https://opencode.ai/zen/go/v1/chat/completions",
        { body: JSON.stringify({ messages: [] }), method: "POST" }
      );
      expect(authorization).toBeNull();
      expect(line).toContain("the installation's own store: read");
    } finally {
      rmSync(empty, { force: true, recursive: true });
    }
  });
});

describe("patchFetch · whose key, and for how long (P6)", () => {
  const GO = "https://opencode.ai/zen/go/v1/chat/completions";
  const ZEN = "https://opencode.ai/zen/v1/chat/completions";
  /** A decorated Go turn, with a session id the gateway accepts. */
  const goTurn = {
    provider: "opencode-go",
    value: openCodeSessionIdFor("p6-go"),
  };
  const zenTurn = {
    provider: "opencode",
    value: openCodeSessionIdFor("p6-zen"),
  };

  /**
   * A wrapped fetch that records the credential each request carried and
   * answers the next status of `statuses` (200 once they run out).
   */
  const gateway = (statuses: number[] = []) => {
    const auth: (string | null)[] = [];
    const seen: Headers[] = [];
    const original = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      seen.push(headers);
      auth.push(headers.get("authorization") ?? headers.get("x-api-key"));
      return Response.json({}, { status: statuses.shift() ?? 200 });
    }) as unknown as typeof fetch;
    return { auth, original, seen };
  };

  const send = (
    patched: typeof fetch,
    url: string,
    bearer?: string
  ): Promise<Response> =>
    patched(url, {
      body: JSON.stringify({ model: "p6-model" }),
      headers:
        bearer === undefined ? {} : { authorization: `Bearer ${bearer}` },
      method: "POST",
    });

  it("OC3 — a key on a claimed request outside any turn of the plugin's is never recorded", async () => {
    const als = new AsyncLocalStorage<ActiveTurnState>();
    const wire = gateway();
    const { hooks, store } = storeFor();
    const patched = patchFetch(wire.original, als, resolveConfig(), hooks);
    // Turnless: the URL claim still writes the session header.
    await send(patched, GO, "realm-token");
    expect(wire.seen[0]?.get(SESSION_HEADER)).toBeTruthy();
    // …but the key it carried is nobody's to keep, or to replay.
    expect(store.get(undefined, "go")).toBeUndefined();
    expect(store.get("opencode-go")).toBeUndefined();
    await als.run(goTurn, () => send(patched, GO, "unused"));
    expect(wire.auth[1]).toBe("Bearer unused");
    // The known answer: the same key inside a decorated turn is recorded.
    await als.run(goTurn, () => send(patched, GO, "turn-token"));
    expect(store.get("opencode-go", "go")).toBe("turn-token");
    await als.run(goTurn, () => send(patched, GO, "unused"));
    expect(wire.auth[3]).toBe("Bearer turn-token");
  });

  it("OC3 — a key captured on a plane never fills a provider-claimed request to a URL on neither plane", async () => {
    const als = new AsyncLocalStorage<ActiveTurnState>();
    const wire = gateway();
    const patched = patchFetch(
      wire.original,
      als,
      resolveConfig({ providers: ["my-relay"] })
    );
    const relay = { provider: "my-relay", value: openCodeSessionIdFor("r") };
    const relayUrl = "https://relay.example/v1/chat/completions";
    await als.run(goTurn, () => send(patched, GO, "go-key"));
    await als.run(relay, () => send(patched, relayUrl, "unused"));
    expect(wire.auth[1]).toBe("Bearer unused");
    // The known answer: a key the relay route itself sent there fills it.
    await als.run(relay, () => send(patched, relayUrl, "relay-key"));
    await als.run(relay, () => send(patched, relayUrl, "unused"));
    expect(wire.auth[3]).toBe("Bearer relay-key");
  });

  it("OC3 / L8 — a relay route's key never fills a plane request, not even once the plane's own key is dropped", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const als = new AsyncLocalStorage<ActiveTurnState>();
    const statuses: number[] = [];
    const wire = gateway(statuses);
    const { hooks, store } = storeFor(
      resolveConfig({ providers: ["my-relay"] })
    );
    const patched = patchFetch(
      wire.original,
      als,
      resolveConfig({ providers: ["my-relay"] }),
      hooks
    );
    const relay = { provider: "my-relay", value: openCodeSessionIdFor("r") };
    const relayUrl = "https://relay.example/v1/chat/completions";
    await als.run(goTurn, () => send(patched, GO, "go-key"));
    await als.run(relay, () => send(patched, relayUrl, "relay-key"));
    // The known answer: the plane's own key fills a placeholder there.
    await als.run(goTurn, () => send(patched, GO, "unused"));
    expect(wire.auth.at(-1)).toBe("Bearer go-key");
    // Two well-formed 401s drop it…
    statuses.push(401, 401);
    await als.run(goTurn, () => send(patched, GO, "unused"));
    await als.run(goTurn, () => send(patched, GO, "unused"));
    // …and the relay's key, the latest one seen, does not take its place.
    await als.run(goTurn, () => send(patched, GO, "unused"));
    expect(wire.auth.at(-1)).toBe("Bearer unused");
    await send(patched, GO, "unused");
    expect(wire.auth.at(-1)).toBe("Bearer unused");
    // It still fills its own route's request.
    await als.run(relay, () => send(patched, relayUrl, "unused"));
    expect(wire.auth.at(-1)).toBe("Bearer relay-key");
    expect(store.forRoute("my-relay")).toBe("relay-key");
  });

  it("L8 — a captured key is dropped after a second well-formed 401 in a row, per plane, and not before", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const als = new AsyncLocalStorage<ActiveTurnState>();
    const statuses: number[] = [];
    const wire = gateway(statuses);
    const patched = patchFetch(wire.original, als, resolveConfig());
    const fill = async (turn: ActiveTurnState, url: string, status: number) => {
      statuses.push(status);
      await als.run(turn, () => send(patched, url, "unused"));
      return wire.auth.at(-1);
    };
    await als.run(goTurn, () => send(patched, GO, "k"));
    await als.run(zenTurn, () => send(patched, ZEN, "z"));
    // One 401: the key stays.
    expect(await fill(goTurn, GO, 401)).toBe("Bearer k");
    // A 2xx clears the strike, so another single 401 still does not drop it.
    expect(await fill(goTurn, GO, 200)).toBe("Bearer k");
    expect(await fill(goTurn, GO, 401)).toBe("Bearer k");
    // The second 401 in a row drops it.
    expect(await fill(goTurn, GO, 401)).toBe("Bearer k");
    expect(await fill(goTurn, GO, 200)).toBe("Bearer unused");
    expect(
      warn.mock.calls.some(([line]) =>
        String(line).includes("no credential resolved for opencode-go")
      )
    ).toBe(true);
    // Per plane: the Zen key captured beside it still fills a Zen request.
    expect(await fill(zenTurn, ZEN, 200)).toBe("Bearer z");
  });

  /**
   * A patch whose captured Go key `k` was dropped by two well-formed 401s on
   * decorated turns, and a `fill` that sends a placeholder on a decorated Go
   * turn and answers what reached the wire.
   */
  const droppedKey = async () => {
    const als = new AsyncLocalStorage<ActiveTurnState>();
    const statuses: number[] = [];
    const wire = gateway(statuses);
    const { hooks, store } = storeFor();
    const patched = patchFetch(wire.original, als, resolveConfig(), hooks);
    const sendIn = async (
      turn: ActiveTurnState | undefined,
      url: string,
      bearer: string,
      status: number
    ) => {
      statuses.push(status);
      await (turn === undefined
        ? send(patched, url, bearer)
        : als.run(turn, () => send(patched, url, bearer)));
      return wire.auth.at(-1);
    };
    await sendIn(goTurn, GO, "k", 200);
    await sendIn(goTurn, GO, "unused", 401);
    await sendIn(goTurn, GO, "unused", 401);
    expect(await sendIn(goTurn, GO, "unused", 200)).toBe("Bearer unused");
    return {
      fill: () => sendIn(goTurn, GO, "unused", 200),
      sendIn,
      store,
    };
  };

  it("L8 — a dropped key comes back only when a decorated turn's own request carrying it is accepted", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { fill, sendIn } = await droppedKey();
    // Refused: the drop stands, and the turn's observation does not file it.
    await sendIn(goTurn, GO, "k", 401);
    expect(await fill()).toBe("Bearer unused");
    // Accepted: the answer files it again, from the settle and not the
    // observation (which refuses a dropped key).
    await sendIn(goTurn, GO, "k", 200);
    expect(await fill()).toBe("Bearer k");
  });

  it("L8 / OC3 — a dropped key the fill supplied, accepted, stays dropped: the declared variable's rotation is what the next fill sends", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { fill, store } = await droppedKey();
    // The declared variable holds the dropped key: the fill sends it, and the
    // gateway accepts it, but the request did not carry it as its own.
    process.env.OPENCODE_GO_API_KEY = "k";
    expect(await fill()).toBe("Bearer k");
    expect(store.get(undefined, "go")).toBeUndefined();
    // Rotated: had the acceptance filed k again, the captured step would
    // outrank the declared one and send the stale key.
    process.env.OPENCODE_GO_API_KEY = "k2";
    expect(await fill()).toBe("Bearer k2");
  });

  it("L8 — a 401 on a malformed session id strikes nothing, while the same 401s on a well-formed one drop the key", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const als = new AsyncLocalStorage<ActiveTurnState>();
    const statuses: number[] = [];
    const wire = gateway(statuses);
    const { hooks, store } = storeFor();
    const patched = patchFetch(wire.original, als, resolveConfig(), hooks);
    // A turn whose session value the gateway reads as malformed; the patch
    // sends it as it is.
    const malformed = { provider: "opencode-go", value: "ses_x" };
    await als.run(goTurn, () => send(patched, GO, "k"));
    for (const _ of [1, 2, 3]) {
      statuses.push(401);
      // oxlint-disable-next-line no-await-in-loop -- the turns are sequential.
      await als.run(malformed, () => send(patched, GO, "unused"));
    }
    expect(wire.seen.at(-1)?.get(SESSION_HEADER)).toBe("ses_x");
    expect(wire.auth.at(-1)).toBe("Bearer k");
    expect(store.get(undefined, "go")).toBe("k");
    // The known answer: two 401s on a well-formed session drop it.
    statuses.push(401, 401);
    await als.run(goTurn, () => send(patched, GO, "unused"));
    await als.run(goTurn, () => send(patched, GO, "unused"));
    expect(store.get(undefined, "go")).toBeUndefined();
    warn.mockRestore();
  });

  it("OC3 — a turnless placeholder request on a plane URL is still filled with a key a decorated turn sent, and its own token is never kept", async () => {
    const als = new AsyncLocalStorage<ActiveTurnState>();
    const wire = gateway();
    const { hooks, store } = storeFor();
    const patched = patchFetch(wire.original, als, resolveConfig(), hooks);
    await als.run(goTurn, () => send(patched, GO, "k"));
    // Turnless, with the placeholder: the plugin's own key fills it.
    await send(patched, GO, "unused");
    expect(wire.auth.at(-1)).toBe("Bearer k");
    // Turnless, with a token of its own: sent as it is, never kept…
    await send(patched, GO, "realm-token");
    expect(wire.auth.at(-1)).toBe("Bearer realm-token");
    expect(store.get(undefined, "go")).toBe("k");
    // …and never used to fill the next one.
    await send(patched, GO, "unused");
    expect(wire.auth.at(-1)).toBe("Bearer k");
  });

  it("OC3 — a turnless accepted request carrying a dropped key does not lift the drop", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { fill, sendIn } = await droppedKey();
    await sendIn(undefined, GO, "k", 200);
    expect(await fill()).toBe("Bearer unused");
    // Had the turnless answer lifted it, this refused decorated request would
    // have filed it on the way out; it does not.
    await sendIn(goTurn, GO, "k", 401);
    expect(await fill()).toBe("Bearer unused");
  });

  it("OC3 / L8 — the meter's own /usage 401s drop nothing: a turnless refusal is no evidence about a turn's key", async () => {
    const als = new AsyncLocalStorage<ActiveTurnState>();
    const statuses: number[] = [];
    const wire = gateway(statuses);
    const { hooks, store } = storeFor();
    const patched = patchFetch(wire.original, als, resolveConfig(), hooks);
    const usage = "https://opencode.ai/zen/go/v1/usage";
    await als.run(goTurn, () => send(patched, GO, "k"));
    expect(store.get("opencode-go", "go")).toBe("k");
    for (const _ of [1, 2, 3]) {
      statuses.push(401);
      // oxlint-disable-next-line no-await-in-loop -- the polls are sequential.
      await patched(usage, { headers: { authorization: "Bearer k" } });
    }
    // The poll was claimed (it carries the patch's session header)…
    expect(wire.seen.at(-1)?.get(SESSION_HEADER)).toMatch(/^ses_/u);
    // …and the key still fills a Go turn.
    expect(store.get("opencode-go", "go")).toBe("k");
    await als.run(goTurn, () => send(patched, GO, "unused"));
    expect(wire.auth.at(-1)).toBe("Bearer k");
    // The known answer: two refusals on decorated turns do drop it.
    statuses.push(401, 401);
    await als.run(goTurn, () => send(patched, GO, "unused"));
    await als.run(goTurn, () => send(patched, GO, "unused"));
    expect(store.get("opencode-go", "go")).toBeUndefined();
  });

  it("a disposed link passes every request through untouched: no header, no fill, no capture", async () => {
    process.env.OPENCODE_API_KEY = "declared-zen";
    const als = new AsyncLocalStorage<ActiveTurnState>();
    const calls: { input: unknown; init: unknown }[] = [];
    const original = (async (input: unknown, init?: unknown) => {
      calls.push({ init, input });
      return Response.json({});
    }) as unknown as typeof fetch;
    const store = createCaptureStore();
    const credentials = createCredentials({
      keySource: "auto",
      readOpencodeStore: false,
      store,
    });
    let live = false;
    const patched = patchFetch(original, als, resolveConfig(), {
      credentials,
      live: () => live,
    });
    const init = {
      body: JSON.stringify({ model: "p6-model" }),
      headers: { authorization: "Bearer real-key" },
      method: "POST",
    };
    const placeholder = {
      ...init,
      headers: { authorization: "Bearer unused" },
    };
    await als.run(goTurn, () => patched(ZEN, init));
    await als.run(goTurn, () => patched(ZEN, placeholder));
    expect(calls[0]?.input).toBe(ZEN);
    expect(calls[0]?.init).toBe(init);
    expect(calls[1]?.init).toBe(placeholder);
    expect(store.get("opencode-go")).toBeUndefined();
    expect(store.get(undefined, "zen")).toBeUndefined();
    // The known answer: the same link, live, decorates and captures.
    live = true;
    await als.run(goTurn, () => patched(ZEN, init));
    expect(calls[2]?.init).not.toBe(init);
    const decorated = calls[2]?.init as RequestInit | undefined;
    expect(new Headers(decorated?.headers).get(SESSION_HEADER)).toBe(
      goTurn.value
    );
    expect(store.get(undefined, "zen")).toBe("real-key");
  });

  it("the placeholder filter applies to the installation's store: a stored `unused` fills nothing, and the report fires", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const store = createOpencodeStore([
      { integrationId: "opencode-go", value: "unused" },
    ]);
    process.env.XDG_DATA_HOME = store.root;
    try {
      const wire = gateway();
      await send(
        patchFetch(
          wire.original,
          new AsyncLocalStorage<ActiveTurnState>(),
          resolveConfig({ readOpencodeStore: true })
        ),
        GO
      );
      expect(wire.auth[0]).toBeNull();
      expect(
        warn.mock.calls.some(([line]) =>
          String(line).includes("no credential resolved for opencode-go")
        )
      ).toBe(true);
    } finally {
      store.cleanup();
    }
  });

  it("a blank exported key is no key: nothing fills the wire, and the report fires", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env.OPENCODE_API_KEY = "   ";
    const wire = gateway();
    await send(
      patchFetch(
        wire.original,
        new AsyncLocalStorage<ActiveTurnState>(),
        resolveConfig()
      ),
      ZEN
    );
    expect(wire.auth[0]).toBeNull();
    expect(
      warn.mock.calls.some(([line]) =>
        String(line).includes("no credential resolved for opencode;")
      )
    ).toBe(true);
  });

  it("OC5 — on a per-call-shaped turn the patch writes no plane header, still fills the key and the User-Agent, and still replaces a malformed session id", async () => {
    process.env.OPENCODE_API_KEY = "declared-zen";
    const als = new AsyncLocalStorage<ActiveTurnState>();
    const wire = gateway();
    const patched = patchFetch(wire.original, als, resolveConfig());
    const ses = openCodeSessionIdFor("p6-percall");
    const theirs = openCodeSessionIdFor("someone-else");
    const shaped = {
      perCall: true,
      project: "p",
      provider: "opencode",
      value: ses,
    } as ActiveTurnState;
    const request = (session: string) =>
      patched(ZEN, {
        body: "{}",
        headers: {
          authorization: "Bearer unused",
          "x-opencode-project": "theirs",
          "x-opencode-session": session,
        },
        method: "POST",
      });
    await als.run(shaped, () => request(theirs));
    const [kept] = wire.seen;
    expect(kept?.get(SESSION_HEADER)).toBe(theirs);
    expect(kept?.get("x-opencode-project")).toBe("theirs");
    expect(kept?.has("x-opencode-session-id")).toBe(false);
    expect(kept?.get("user-agent")).toBe(OPENCODE_UA);
    expect(kept?.get("authorization")).toBe("Bearer declared-zen");
    // A malformed id is still replaced, with every plane header from the turn.
    await als.run(shaped, () => request("oc5-raw"));
    const [, rewritten] = wire.seen;
    expect(rewritten?.get(SESSION_HEADER)).toBe(ses);
    expect(rewritten?.get("x-opencode-session-id")).toBe(ses);
    expect(rewritten?.get("x-opencode-project")).toBe("p");
    // The known answer: without the flag the first request is rewritten.
    const { perCall: _dropped, ...unshaped } = shaped;
    await als.run(unshaped as ActiveTurnState, () => request(theirs));
    expect(wire.seen[2]?.get(SESSION_HEADER)).toBe(ses);
    expect(wire.seen[2]?.get("x-opencode-project")).toBe("p");
  });
});
