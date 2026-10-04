/**
 * End-to-end header contract: what `patchFetch` actually puts on the wire.
 *
 * The live gateway cannot echo a request back, so the *outgoing* header set is
 * proven against a local `node:http` listener instead — a real socket, a real
 * request, the real `patchFetch`. Everywhere else in the suite the injected
 * headers are asserted against a captured `fetch`; here they cross a socket.
 *
 * Opt-in (`OPENCODE_E2E=1`): it binds a port, so it stays out of the
 * deterministic unit run.
 */

import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { once } from "node:events";
import { createServer, type Server } from "node:http";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  type ActiveTurnState,
  openCodeSessionIdFor,
  OPENCODE_UA,
  PARENT_SESSION_ALT_HEADER,
  PARENT_SESSION_HEADER,
  patchFetch,
  resolveConfig,
  SESSION_AFFINITY_HEADER,
  SESSION_HEADER,
} from "../../src/index.ts";

const ENABLED = process.env.OPENCODE_E2E === "1";

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

describe.skipIf(!ENABLED)("patched fetch over a real socket", () => {
  const als = new AsyncLocalStorage<ActiveTurnState>();
  const config = resolveConfig({});
  const patched = patchFetch(fetch, als, config);

  const turn = (overrides: Partial<ActiveTurnState> = {}): ActiveTurnState => ({
    model: "deepseek-v4.1-flash",
    provider: "opencode",
    value: "ses_e2e00000000",
    ...overrides,
  });

  it("injects the full affinity header set for a claimed provider", async () => {
    const state = turn({
      parentValue: "ses_parent00000",
      project: "dsh-opencode",
    });
    const response = await als.run(state, () => patched(`${origin}/models`));
    expect(response.status).toBe(200);

    // The three session spellings the gateway has accepted over time.
    expect(headerOf(0, SESSION_HEADER)).toBe(state.value);
    expect(headerOf(0, "x-opencode-session-id")).toBe(state.value);
    expect(headerOf(0, SESSION_AFFINITY_HEADER)).toBe(state.value);

    // Parent lineage, in both spellings.
    expect(headerOf(0, PARENT_SESSION_HEADER)).toBe("ses_parent00000");
    expect(headerOf(0, PARENT_SESSION_ALT_HEADER)).toBe("ses_parent00000");

    // Origin identity.
    expect(headerOf(0, "x-opencode-client")).toBe("cli");
    expect(headerOf(0, "x-opencode-project")).toBe("dsh-opencode");
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

  it("keeps a caller's own valid session header", async () => {
    await als.run(turn(), () =>
      patched(`${origin}/models`, {
        headers: { [SESSION_HEADER]: "ses_caller00000" },
      })
    );
    // The turn's own value wins while a turn is active…
    expect(headerOf(0, SESSION_HEADER)).toBe("ses_e2e00000000");
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
