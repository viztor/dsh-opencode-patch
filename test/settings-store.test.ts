// @vitest-environment jsdom
/**
 * The card's inspection call: four outcomes, each named, because "nothing
 * happened" has four different causes and the reader has to be told which.
 *
 * The shape mirrors `settings-purge.test.ts` on purpose — both are Remote calls
 * the card makes through the same guard, so a difference between them would be a
 * bug in one of them rather than a decision.
 */
import { describe, expect, it, vi } from "vitest";

import { inspectStore } from "../src/settings-store.ts";

const scopeWith = (inspect: unknown): unknown => ({
  remote: { opencodeStore: { inspect } },
});

describe("inspectStore", () => {
  it("passes the host's answer through", async () => {
    const inspection = {
      account: { email: "someone@example.com", type: "oauth" },
      found: true,
      path: "~/.local/share/opencode/opencode.db",
    };
    const inspect = vi.fn(async () => ({ ok: true, value: inspection }));
    await expect(inspectStore(scopeWith(inspect))).resolves.toEqual({
      kind: "inspected",
      inspection,
    });
  });

  it("accepts a bare value, not only the envelope", async () => {
    const inspection = { found: false, message: "not_found" };
    await expect(
      inspectStore(scopeWith(async () => inspection))
    ).resolves.toEqual({ kind: "inspected", inspection });
  });

  it("says so when the host mounted no store service", async () => {
    await expect(inspectStore({ remote: {} })).resolves.toEqual({
      kind: "unavailable",
    });
  });

  it("survives a scope that is not an object at all", async () => {
    // `null` rather than `undefined`: the guard treats every non-object
    // the same, and a literal `undefined` argument reads as a slip.
    await expect(inspectStore(null)).resolves.toEqual({
      kind: "unavailable",
    });
  });

  it("carries the host's refusal as a message, not as a silent undefined", async () => {
    const inspect = vi.fn(() => Promise.reject(new Error("no sqlite")));
    await expect(inspectStore(scopeWith(inspect))).resolves.toEqual({
      kind: "failed",
      message: "no sqlite",
    });
  });

  it("keeps only the whitelisted fields, so a stray secret cannot reach the card", async () => {
    // The seam's rule is "a credential never crosses it". The parser is what
    // enforces that on this side: a field the host did not mean to send is
    // dropped, not rendered.
    const answer = {
      account: {
        accessToken: "fixture-token-not-real",
        email: "someone@example.com",
        type: "oauth",
      },
      found: true,
      token: "fixture-token-not-real",
    };
    const outcome = await inspectStore(scopeWith(async () => answer));
    expect(outcome).toEqual({
      inspection: {
        account: { email: "someone@example.com", type: "oauth" },
        found: true,
      },
      kind: "inspected",
    });
    expect(JSON.stringify(outcome)).not.toContain("fixture-token-not-real");
  });

  it("reports the remote's own failure from an ok:false envelope", async () => {
    // Read as a shape, this used to surface as "invalid inspection shape" — a
    // message about the envelope instead of the host's reason.
    const inspect = vi.fn(async () => ({
      error: { code: "opencode/store-unavailable", message: "no sqlite here" },
      ok: false,
    }));
    await expect(inspectStore(scopeWith(inspect))).resolves.toEqual({
      kind: "failed",
      message: "no sqlite here",
    });
  });

  it("rejects an answer that is not an inspection", async () => {
    // A shape check, not a wish: the card renders rows off this value, and a
    // half-built answer would print `undefined` beside a label.
    await expect(
      inspectStore(scopeWith(async () => ({ ok: true, value: { path: "x" } })))
    ).resolves.toEqual({
      kind: "failed",
      message: "host returned an invalid inspection shape",
    });
    await expect(inspectStore(scopeWith(async () => 42))).resolves.toEqual({
      kind: "failed",
      message: "host returned an invalid inspection shape",
    });
  });

  it("survives a remote whose guarded access THROWS", async () => {
    // `scope.remote.opencodeStore` is a cordis GUARDED PROPERTY: for a namespace
    // this bundle never declared in `inject` it throws, and a throw out of a
    // render takes the whole settings card down. The shared guard in
    // `settings-remote.ts` is what turns that into "no service".
    const throwing = new Proxy(
      {},
      {
        get: (_target, property) => {
          if (property === "opencodeStore") {
            throw new TypeError(
              'cannot get property "remote.opencodeStore" without inject'
            );
          }
        },
      }
    );
    await expect(inspectStore({ remote: throwing })).resolves.toEqual({
      kind: "unavailable",
    });
  });
});

describe("inspectStore: the envelope shapes, pinned before the remote seam", () => {
  it("names a refusal with no reason, an empty ok envelope, and accepts a value without ok", async () => {
    for (const refusal of [{ ok: false }, { error: {}, ok: false }]) {
      await expect(
        inspectStore(scopeWith(async () => refusal))
      ).resolves.toEqual({
        kind: "failed",
        message: "the host could not inspect the installation",
      });
    }
    await expect(
      inspectStore(scopeWith(async () => ({ ok: true })))
    ).resolves.toEqual({
      kind: "failed",
      message: "host returned an invalid inspection shape",
    });
    await expect(
      inspectStore(scopeWith(async () => ({ value: { found: false } })))
    ).resolves.toEqual({ inspection: { found: false }, kind: "inspected" });
  });

  it("names the missing service on the console, once", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await expect(inspectStore({ remote: {} })).resolves.toEqual({
        kind: "unavailable",
      });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(
        "[dsh-opencode-patch] store inspection: no opencodeStore service on the remote"
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("calls the inspection with no argument, as its descriptor declares none", async () => {
    const inspect = vi.fn(async () => ({ ok: true, value: { found: false } }));
    await inspectStore(scopeWith(inspect));
    expect(inspect).toHaveBeenCalledTimes(1);
    expect(inspect.mock.calls[0]).toHaveLength(0);
  });
});

describe("inspectStore: the one unwrap (P9), on shapes the host does not send", () => {
  // The gateway answers a refusal as `{ ok: false, error: RemoteError }`; an
  // envelope-level `message` or a string `error` is a shape only a test
  // builds. The one unwrap reads every caller's refusal the same way, so the
  // store now shows those words rather than its default sentence.
  it("unifies an envelope message and a string error into the refusal's reason", async () => {
    await expect(
      inspectStore(scopeWith(async () => ({ message: "read-only", ok: false })))
    ).resolves.toEqual({ kind: "failed", message: "read-only" });
    await expect(
      inspectStore(scopeWith(async () => ({ error: "no sqlite", ok: false })))
    ).resolves.toEqual({ kind: "failed", message: "no sqlite" });
  });

  // On the base, `scope.remote` was read unguarded when `ctx.get` missed, so a
  // getter that throws there rejected the inspection. The seam reads it inside
  // a guard: no remote, so "unavailable" with its console line. The host never
  // builds this scope (every caller's scope declares `remote` in `inject`).
  it("reads a throwing remote getter as no service when ctx.get misses", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const scope = {
        get: () => {},
        get remote(): never {
          throw new Error('cannot get property "remote" without inject');
        },
      };
      await expect(inspectStore(scope)).resolves.toEqual({
        kind: "unavailable",
      });
      expect(warn).toHaveBeenCalledWith(
        "[dsh-opencode-patch] store inspection: no opencodeStore service on the remote"
      );
    } finally {
      warn.mockRestore();
    }
  });
});
