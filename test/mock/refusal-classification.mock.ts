/**
 * End-to-end refusal contract: what the classifier reads off a real socket.
 *
 * `classifyPiAiError` (`@deepseek-ai/dsh-llm-pi-ai`) asks the MESSAGE before
 * it asks anything else — its first branch is `if (/\b(?:401|403)\b/.test(message)) return "AUTH"` —
 * so a rewritten refusal that quotes the code it rewrites away is still read as
 * an invalid API key no matter what status it carries. Exactly that shipped
 * once, with every rewritten body opening `(403 …)`, and the fix moved the text
 * off the token and onto 400 (`fix(errors): the refusal text must not carry the
 * status it rewrites`).
 *
 * The unit suite pins that contract against a stubbed `Response`. This file
 * runs the same decision table where it can actually break: the gateway's bytes
 * arriving over a real `node:http` socket, one shape per refusal the gateway has
 * been measured to send — including a body written in several chunks, which
 * crosses reads the way a refusal on the live gateway does and which no
 * `new Response(body)` fixture produces.
 *
 * The classifier is not exported from the package, so the oracle below is a
 * copy; the first case asserts the installed bundle still carries the branches
 * the verdicts depend on, in their order — a vendor move fails here instead of
 * being absorbed by a stale copy.
 *
 * It binds a loopback port and nothing else, like the sibling header suite,
 * so it runs in the mock suite on every push.
 *
 * @module test/mock/refusal-classification.mock
 */

import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createServer, type Server, type ServerResponse } from "node:http";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  type ActiveTurnState,
  openCodeSessionIdFor,
  patchFetch,
  resolveConfig,
} from "../support/src.ts";

/**
 * The first case reads the INSTALLED `@deepseek-ai/dsh-llm-pi-ai` bundle and
 * pins the branch order the contract below relies on: AUTH is tested FIRST,
 * against the message text, before any status or later branch is consulted —
 * so a pass-through 403 is labelled AUTH by design, with the gateway's own
 * words under it.
 */
/** The gateway's own bodies, as measured. */
const BODY = {
  auth: JSON.stringify({
    error: { message: "Invalid API key", type: "AuthError" },
  }),
  entitlement: JSON.stringify({
    error: {
      message: "Upstream request failed: Model access is disabled",
      type: "server_error",
    },
  }),
  freeTier: JSON.stringify({
    error: {
      message: "OpenCode's free tier can only be used from within OpenCode",
      type: "FreeTierError",
    },
  }),
  ok: JSON.stringify({ ok: true }),
  upstreamNamed: JSON.stringify({
    error: {
      message: "upstream answered 403 to the relay",
      type: "relay_error",
    },
  }),
  usage: JSON.stringify({
    error: { message: "Subscription required", type: "usage_restricted" },
  }),
} as const;

/** Between the free-tier writes, so the body genuinely crosses reads. */
const CHUNK_DELAY_MS = 15;

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

let server: Server;
let origin: string;

/**
 * Answer one request. Wired to the server through a non-async listener,
 * because an `async` listener hands Node a promise where it expects void.
 */
const handle = async (
  url: string | undefined,
  response: ServerResponse
): Promise<void> => {
  const path = new URL(url ?? "/", "http://127.0.0.1").pathname;
  switch (path) {
    case "/refusal/free-tier": {
      // The measured body, written in three chunks with two flushes between
      // them: what `response.clone().text()` in the patch has to assemble is
      // a body that arrives over several reads, not one buffer.
      response.writeHead(403, { "content-type": "application/json" });
      response.write(BODY.freeTier.slice(0, 21));
      await delay(CHUNK_DELAY_MS);
      response.write(BODY.freeTier.slice(21, 64));
      await delay(CHUNK_DELAY_MS);
      response.end(BODY.freeTier.slice(64));
      return;
    }
    case "/refusal/entitlement": {
      response.writeHead(403, { "content-type": "application/json" });
      response.end(BODY.entitlement);
      return;
    }
    case "/refusal/upstream-named": {
      response.writeHead(403, { "content-type": "application/json" });
      response.end(BODY.upstreamNamed);
      return;
    }
    case "/refusal/waf": {
      response.writeHead(403, { "content-type": "text/plain" });
      response.end("error code: 1010");
      return;
    }
    case "/refusal/unrecognized": {
      // Neither JSON nor 1010: a 403 this patch has no rewrite for.
      response.writeHead(403, { "content-type": "text/plain" });
      response.end("Forbidden");
      return;
    }
    case "/zen/go/v1/usage": {
      response.writeHead(403, { "content-type": "application/json" });
      response.end(BODY.usage);
      return;
    }
    case "/auth": {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(BODY.auth);
      return;
    }
    default: {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(BODY.ok);
    }
  }
};

beforeAll(async () => {
  server = createServer((request, response) => {
    void handle(request.url, response);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address !== null && typeof address === "object", "no bound port");
  origin = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  server.close();
  await once(server, "close");
});

interface Refusal {
  error: { message: string; type: string };
}

describe("refusal classification over a real socket", () => {
  const als = new AsyncLocalStorage<ActiveTurnState>();
  const patched = patchFetch(fetch, als, resolveConfig({}));

  const turn = (overrides: Partial<ActiveTurnState> = {}): ActiveTurnState => ({
    model: "gpt-5.4",
    provider: "opencode",
    value: openCodeSessionIdFor("e2e-refusal"),
    ...overrides,
  });

  const call = async (
    path: string,
    overrides: Partial<ActiveTurnState> = {}
  ): Promise<Response> =>
    als.run(turn(overrides), () =>
      patched(`${origin}${path}`, {
        body: JSON.stringify({ model: "gpt-5.4", stream: true }),
        headers: { "content-type": "application/json" },
        method: "POST",
      })
    );

  const get = async (path: string): Promise<Response> =>
    als.run(turn(), () => patched(`${origin}${path}`, { method: "GET" }));

  const refusal = async (
    path: string,
    overrides: Partial<ActiveTurnState> = {}
  ): Promise<{ payload: Refusal; response: Response }> => {
    const response = await call(path, overrides);
    const payload = (await response.json()) as Refusal;
    return { payload, response };
  };

  /**
   * What every 403 must be: UNTOUCHED. `fix: pass 403 through untouched`
   * (2026-10-18) removed the rewrite to 400 — the user asked for the gateway's
   * own status and words back, and the classifier's AUTH reading of a 403 is
   * the classifier's business, not a licence to alter what the gateway said.
   * These cases were written against the rewrite and never reached CI after
   * the policy flipped; they now assert the policy that replaced it, on the
   * same measured bodies.
   */
  const expectPassedThrough = (
    result: { payload: Refusal; response: Response },
    type: string,
    needle: string
  ): void => {
    expect(result.response.status).toBe(403);
    expect(result.payload.error.type).toBe(type);
    expect(result.payload.error.message).toContain(needle);
  };

  it("pins the oracle to the classifier the deployment runs", async () => {
    const source = await readFile(
      new URL(
        "../../node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/index.js",
        import.meta.url
      ),
      "utf8"
    );
    const auth = String.raw`if (/\b(?:401|403)\b/.test(message)) return "AUTH";`;
    const invalid = String.raw`if (/\b400\b|invalid.?request/i.test(message)) return "INVALID_REQUEST";`;
    const authAt = source.indexOf(auth);
    const invalidAt = source.indexOf(invalid);
    expect(
      authAt,
      "the AUTH branch left the installed classifier"
    ).toBeGreaterThanOrEqual(0);
    expect(
      invalidAt,
      "the 400 branch left the installed classifier"
    ).toBeGreaterThanOrEqual(0);
    // Order IS the contract: AUTH runs first, so a 403 body is read as AUTH.
    // That reading is accepted now — the pass-through means a free-tier refusal
    // surfaces as AUTH carrying the gateway's own words, which is the honest
    // answer to a request the gateway refused outside the credential.
    expect(authAt).toBeLessThan(invalidAt);
  });

  it("passes the chunked free-tier refusal through with the gateway's words", async () => {
    // The body still crosses three reads, so this also proves that whatever
    // assembles a streamed answer keeps the gateway's text intact.
    expectPassedThrough(
      await refusal("/refusal/free-tier"),
      "FreeTierError",
      "free tier can only be used from within OpenCode"
    );
  });

  it("keeps the gateway's own words in an entitlement refusal", async () => {
    expectPassedThrough(
      await refusal("/refusal/entitlement"),
      "server_error",
      "Model access is disabled"
    );
  });

  it("keeps the status token the gateway's own message carries", async () => {
    // Inverted from the rewrite era: the upstream NAMED 403, and the answer
    // must still carry it — scrubbing the gateway's words was the old
    // rewrite's doing, and the pass-through keeps them.
    const result = await refusal("/refusal/upstream-named");
    expectPassedThrough(
      result,
      "relay_error",
      "upstream answered 403 to the relay"
    );
  });

  it("passes the Cloudflare client-identity block through verbatim", async () => {
    const response = await call("/refusal/waf");
    expect(response.status).toBe(403);
    expect(response.headers.get("content-type")).toContain("text/plain");
    expect(await response.text()).toBe("error code: 1010");
  });

  it("leaves /usage's 403 alone, because the meter reads that status", async () => {
    const response = await get("/zen/go/v1/usage");
    expect(response.status).toBe(403);
    const payload = (await response.json()) as Refusal;
    expect(payload.error.type).toBe("usage_restricted");
  });

  it("leaves an unclaimed provider's 403 alone", async () => {
    const response = await call("/refusal/entitlement", {
      provider: "deepseek",
    });
    expect(response.status).toBe(403);
    const payload = (await response.json()) as Refusal;
    expect(payload.error.type).toBe("server_error");
  });

  it("leaves a 401 a 401 — that one really is about the key", async () => {
    const response = await call("/auth");
    expect(response.status).toBe(401);
    const payload = (await response.json()) as Refusal;
    expect(payload.error.type).toBe("AuthError");
    expect(payload.error.message).toBe("Invalid API key");
  });

  it("passes a success through with its body intact", async () => {
    const response = await get("/ok");
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(BODY.ok);
  });
});
