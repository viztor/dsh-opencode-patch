/**
 * End-to-end refusal contract: what the classifier reads off a real socket.
 *
 * `classifyPiAiError` (`@deepseek-ai/dsh-llm-pi-ai`) reads the failure
 * MESSAGE pi hands it, and asks for a 401 or 403 before it asks for anything
 * else, so a 403 is AUTH whatever its words say, and a rewritten refusal that
 * quotes the code it rewrites away was read as an invalid API key no matter
 * what status it carried. Exactly that shipped
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
 * The classifier is not exported from the package, so the first case drives
 * the INSTALLED pi-ai through a real route against this socket and reads the
 * code it finishes with: the order the verdicts depend on is asserted as
 * behaviour, on whichever bridge the channel installs, never as the text of
 * one bundle (the `0.2.2-rc.2` bridge reads a leading HTTP status first, and
 * a pin on the older branch's source broke on it while the order held).
 *
 * It binds a loopback port and nothing else, like the sibling header suite,
 * so it runs in the mock suite on every push.
 *
 * @module test/mock/refusal-classification.mock
 */

import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { once } from "node:events";
import { createServer, type Server, type ServerResponse } from "node:http";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  drainStream,
  fakeCredentials,
  mountTierA,
  ownerOf,
} from "../support/host.ts";
import {
  type ActiveTurnState,
  openCodeSessionIdFor,
  patchFetch,
  resolveConfig,
} from "../support/src.ts";

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
  /**
   * Not a measured body: words that read as an invalid request, so a
   * classifier that asked for one before AUTH would label a 403 carrying
   * them INVALID_REQUEST (the known answer is the same words at 400).
   */
  probe: JSON.stringify({
    error: {
      message: "Invalid request: this model is not on the free tier",
      type: "invalid_request_error",
    },
  }),
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
  // The classifier probe: pi-ai's own route posts to `<base>/chat/completions`
  // under `/pi-ai/<status>/`, and gets the probe's words at that status.
  const probe = /^\/pi-ai\/(4\d\d)\//u.exec(path);
  if (probe !== null) {
    response.writeHead(Number(probe[1]), {
      "content-type": "application/json",
    });
    response.end(BODY.probe);
    return;
  }
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

  it("pins the oracle to the classifier the deployment runs: the installed pi-ai reads a 403 as AUTH even when its words read as an invalid request", async () => {
    /** One turn on pi-ai's own route, its gateway answering `status`. */
    const classified = async (
      status: number
    ): Promise<{ code: unknown; message: unknown }> => {
      const tier = await mountTierA({
        credentials: fakeCredentials({ refs: { OPENCODE_API_KEY: "k" } }),
        providers: {
          opencode: {
            apiKeyEnv: "OPENCODE_API_KEY",
            baseURL: `${origin}/pi-ai/${String(status)}/v1`,
            models: [{ id: "deepseek-v4-pro" }],
          },
        },
      });
      try {
        // pi-ai serves the route itself: no plugin is mounted to claim it.
        expect(ownerOf(tier.llm, "opencode")).toBe("PiAiAdapter");
        const drained = await drainStream(
          tier.llm,
          "opencode",
          "deepseek-v4-pro"
        );
        expect(drained.finish?.kind).toBe("error");
        return {
          code: drained.finish?.code,
          message: drained.failureMessage,
        };
      } finally {
        await tier.dispose();
      }
    };
    // The known answer: the probe's words, at 400, ARE an invalid request.
    const invalid = await classified(400);
    expect(invalid.code).toBe("INVALID_REQUEST");
    // Order IS the contract: AUTH is asked first, so the same words at 403
    // are AUTH. That reading is accepted now — the pass-through means a
    // free-tier refusal surfaces as AUTH carrying the gateway's own words,
    // which is the honest answer to a request the gateway refused outside the
    // credential.
    const refused = await classified(403);
    expect(refused.code).toBe("AUTH");
    expect(refused.message).toContain("not on the free tier");
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
