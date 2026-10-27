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

import { freeZenModel, shimFor } from "./support/catalog-fixture.ts";
import { createOpencodeStore } from "./support/opencode-store-fixture.ts";
import {
  clearCapturedApiKeys,
  getCapturedApiKey,
  recordCapturedApiKey,
  patchFetch,
  resolveConfig,
  type ActiveTurnState,
} from "./support/src.ts";
import { createCaptureFetch, headerOf } from "./test-helpers.ts";

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.OPENCODE_API_KEY;
  delete process.env.OPENCODE_GO_API_KEY;
  delete process.env.OPENCODE_SESSION_ID;
  delete process.env.XDG_DATA_HOME;
  clearCapturedApiKeys();
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
    // forwarded (P6 owns the fill).
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

  /**
   * The warning's report, once per patched fetch and plane. Every case below
   * builds its own patch, so the one-per-plane gate never hides a line.
   */
  const reportFor = async (
    config: ReturnType<typeof resolveConfig>,
    url: string,
    init: RequestInit
  ): Promise<{ authorization: string | null; line: string | undefined }> => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { capture, mockFetch } = createCaptureFetch();
    let lines: string[] = [];
    try {
      await patchFetch(
        mockFetch,
        new AsyncLocalStorage<ActiveTurnState>(),
        config
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
    recordCapturedApiKey("sk-captured", "opencode", url);
    const { authorization, line } = await reportFor(
      resolveConfig({ keySource: "configured" }),
      url,
      { body: JSON.stringify({ model: paidZenModel() }), method: "POST" }
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
