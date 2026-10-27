/**
 * End-to-end header contract: what `patchFetch` actually puts on the wire.
 *
 * The live gateway cannot echo a request back, so the *outgoing* header set is
 * proven against a local `node:http` listener instead — a real socket, a real
 * request, the real `patchFetch`. Everywhere else in the suite the injected
 * headers are asserted against a captured `fetch`; here they cross a socket.
 *
 * It binds a loopback port and nothing else, so it runs in the mock suite on
 * every push rather than in the unit run.
 *
 * @module test/mock/patched-fetch-headers.mock
 */

import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { once } from "node:events";
import { createServer, type Server } from "node:http";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  type ActiveTurnState,
  OPENCODE_UA,
  PARENT_SESSION_ALT_HEADER,
  PARENT_SESSION_HEADER,
  SESSION_AFFINITY_HEADER,
  SESSION_HEADER,
  newOpenCodeMessageId,
  openCodeSessionIdFor,
  patchFetch,
  resolveConfig,
} from "../support/src.ts";

let server: Server;
let origin: string;
/** Headers of every request the listener received, in order. */
const received: Record<string, string | string[] | undefined>[] = [];

beforeAll(async () => {
  server = createServer((request, response) => {
    received.push(request.headers);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true }));
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

beforeEach(() => {
  received.length = 0;
});

const headerOf = (index: number, name: string): string | undefined => {
  const value = received[index]?.[name];
  return Array.isArray(value) ? value[0] : value;
};

describe("patched fetch over a real socket", () => {
  const als = new AsyncLocalStorage<ActiveTurnState>();
  const config = resolveConfig({});
  const patched = patchFetch(fetch, als, config);

  /** The turn's own ids, derived rather than written, so each is in band. */
  const TURN_VALUE = openCodeSessionIdFor("e2e-turn");
  const PARENT_VALUE = openCodeSessionIdFor("e2e-parent");
  const REQUEST_VALUE = newOpenCodeMessageId();

  const turn = (overrides: Partial<ActiveTurnState> = {}): ActiveTurnState => ({
    model: "deepseek-v4.1-flash",
    provider: "opencode",
    requestValue: REQUEST_VALUE,
    value: TURN_VALUE,
    ...overrides,
  });

  it("injects the full affinity header set for a claimed provider", async () => {
    const state = turn({
      parentValue: PARENT_VALUE,
      project: "dsh-opencode",
    });
    const response = await als.run(state, () => patched(`${origin}/models`));
    expect(response.status).toBe(200);

    // The session headers carry ONE value in the generation this plugin emulates.
    // Read from the 1.x line's last release, v1.19.4, in
    // `packages/opencode/src/session/llm/request.ts`: `x-opencode-session-id` and
    // `x-opencode-session` both carry `sessionID`. 2.x splits the second into an
    // affinity id, and this case asserted that for a round - from the wrong
    // generation, while the plugin emulates 1.19.4.
    expect(headerOf(0, "x-opencode-session-id")).toBe(state.value);
    expect(headerOf(0, SESSION_HEADER)).toBe(state.value);
    expect(headerOf(0, SESSION_AFFINITY_HEADER)).toBeUndefined();
    expect(headerOf(0, "x-session-id")).toBeUndefined();

    // Parent lineage, in both spellings.
    expect(headerOf(0, PARENT_SESSION_HEADER)).toBe(PARENT_VALUE);
    expect(headerOf(0, PARENT_SESSION_ALT_HEADER)).toBe(PARENT_VALUE);

    // Origin identity, including the turn's message id — the header 1.19.4's
    // `request.ts` sends beside the client and project headers.
    expect(headerOf(0, "x-opencode-client")).toBe("cli");
    expect(headerOf(0, "x-opencode-project")).toBe("dsh-opencode");
    expect(headerOf(0, "x-opencode-request")).toBe(REQUEST_VALUE);
    expect(headerOf(0, "user-agent")).toBe(OPENCODE_UA);
  });

  it("falls back to 'global' when the turn carries no project", async () => {
    await als.run(turn(), () => patched(`${origin}/models`));
    expect(headerOf(0, "x-opencode-project")).toBe("global");
    // No parent means no parent header at all, rather than an empty one.
    expect(headerOf(0, PARENT_SESSION_HEADER)).toBeUndefined();
    expect(headerOf(0, PARENT_SESSION_ALT_HEADER)).toBeUndefined();
  });

  it("derives a stable ses_ value for a caller-supplied session id", async () => {
    const value = openCodeSessionIdFor("e2e-session");
    await als.run(turn({ value }), () => patched(`${origin}/models`));
    expect(headerOf(0, SESSION_HEADER)).toBe(value);
    expect(value.startsWith("ses_")).toBe(true);
  });

  it("leaves an unclaimed provider's traffic completely untouched", async () => {
    // A localhost URL matches no gateway marker, and `deepseek` is not in
    // `providers`, so this must be a byte-for-byte pass-through.
    await als.run(turn({ provider: "deepseek" }), () =>
      patched(`${origin}/models`)
    );
    expect(received[0]?.[SESSION_HEADER]).toBeUndefined();
    expect(received[0]?.["x-opencode-client"]).toBeUndefined();
    expect(received[0]?.["user-agent"]).not.toBe(OPENCODE_UA);
  });

  it("a turn's own session id outranks a caller's valid header, which is kept outside a turn", async () => {
    const caller = openCodeSessionIdFor("e2e-caller");
    await als.run(turn(), () =>
      patched(`${origin}/models`, {
        headers: { [SESSION_HEADER]: caller },
      })
    );
    // The turn's own value wins while a turn is active…
    expect(headerOf(0, SESSION_HEADER)).toBe(TURN_VALUE);

    // …and with no turn, the caller's valid id is what goes on the wire. A
    // request outside a turn is claimed by its URL alone, so this patch names
    // the listener as a gateway the way a deployment names a relay.
    const byUrl = patchFetch(
      fetch,
      als,
      resolveConfig({ gatewayUrls: [origin] })
    );
    await byUrl(`${origin}/models`, { headers: { [SESSION_HEADER]: caller } });
    expect(headerOf(1, "x-opencode-client"), "the request was claimed").toBe(
      "cli"
    );
    expect(headerOf(1, SESSION_HEADER)).toBe(caller);
  });

  it("preserves the caller's unrelated headers", async () => {
    await als.run(turn(), () =>
      patched(`${origin}/models`, {
        headers: { "x-custom-e2e": "kept" },
      })
    );
    expect(headerOf(0, "x-custom-e2e")).toBe("kept");
  });
});
