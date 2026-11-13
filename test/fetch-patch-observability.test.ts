/**
 * patchFetch · what a claimed request reports, and the answers it passes on.
 *
 * @module test/fetch-patch-observability.test
 */
import { AsyncLocalStorage } from "node:async_hooks";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  OPENCODE_UA,
  SESSION_HEADER,
  clearCapturedApiKeys,
  getLiveGoCatalog,
  isOpenCodeSessionId,
  openCodeSessionIdFor,
  patchFetch,
  resolveConfig,
  type ActiveTurnState,
} from "./support/src.ts";
import { createCaptureFetch } from "./test-helpers.ts";

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.OPENCODE_API_KEY;
  delete process.env.OPENCODE_GO_API_KEY;
  delete process.env.OPENCODE_SESSION_ID;
  delete process.env.XDG_DATA_HOME;
  clearCapturedApiKeys();
});

describe("patchFetch · observability", () => {
  it("answers a relay's Go listing with the Go catalog", async () => {
    // The listing is claimed against the deployment's own markers. The
    // enrichment then re-asked with the DEFAULT markers, so a relay's Go
    // listing was filled from the Zen catalog.
    const als = new AsyncLocalStorage<ActiveTurnState>();
    const upstream = vi.fn(async () => Response.json({ data: [] }));
    const patched = patchFetch(
      upstream as unknown as typeof fetch,
      als,
      resolveConfig({ gatewayUrls: ["relay.example/zen"] }),
      {}
    );
    const response = await patched("https://relay.example/zen/go/v1/models", {
      headers: { authorization: "Bearer test-go-key" },
      method: "GET",
    });
    const body = (await response.json()) as { data: { id: string }[] };
    const ids = body.data.map((row) => row.id).toSorted();
    expect(ids.length).toBeGreaterThan(0);
    expect(ids).toEqual(
      getLiveGoCatalog()
        .map((spec) => spec.id)
        .toSorted()
    );
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

  it("passes a 403 through untouched, message and status", async () => {
    // A 403 from this gateway is a refusal it understood, not a rejected
    // credential (that is a 401) — but the status is the gateway's to choose and
    // this interceptor does not rewrite it. An earlier revision remapped it to
    // 400 so DSH's classifier would stop labelling it AUTH; the trade was wrong.
    // The classifier's label is its own reading; the message underneath is the
    // gateway's and is accurate, and that is what was asked for.
    const body = JSON.stringify({
      error: {
        message: "OpenCode's free tier can only be used from within OpenCode",
        type: "FreeTierError",
      },
    });
    const als = new AsyncLocalStorage<ActiveTurnState>();
    const patched = patchFetch(
      (async () =>
        new Response(body, { status: 403 })) as unknown as typeof fetch,
      als,
      resolveConfig()
    );
    const response = await patched(
      "https://opencode.ai/zen/v1/chat/completions",
      { body: "{}", method: "POST" }
    );
    expect(response.status).toBe(403);
    const parsed = (await response.json()) as {
      error: { message: string; type: string };
    };
    expect(parsed.error.type).toBe("FreeTierError");
    expect(parsed.error.message).toContain("from within OpenCode");
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

  it("the debug entry carries org, request and user agent as null when the request has none", async () => {
    const entries: Record<string, unknown>[] = [];
    const { mockFetch } = createCaptureFetch();
    await patchFetch(
      mockFetch,
      new AsyncLocalStorage<ActiveTurnState>(),
      resolveConfig({ injectUserAgent: false }),
      {
        debug: (entry) => {
          entries.push(entry);
        },
      }
    )("https://opencode.ai/zen/v1/models");
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      org: null,
      request: null,
      userAgent: null,
    });
    // The session is never null: the patch always sends one.
    expect(isOpenCodeSessionId(entries[0]?.session)).toBe(true);
  });
});
