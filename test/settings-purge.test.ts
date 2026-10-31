// @vitest-environment jsdom
/**
 * The card's purge call: three outcomes, each named, because "nothing happened"
 * has three different causes and the operator has to be told which.
 */
import { describe, expect, it, vi } from "vitest";

import { purgeDeprecatedModels } from "../src/settings-purge.ts";

const scopeWith = (purge: unknown): unknown => ({
  remote: { opencodeModelPurge: { purge } },
});

describe("purgeDeprecatedModels", () => {
  it("passes the host's answer through", async () => {
    const purge = vi.fn(async () => ({
      ok: true,
      value: {
        catalogRead: true,
        removed: [{ id: "fledge-alpha-free", provider: "opencode" }],
      },
    }));
    const outcome = await purgeDeprecatedModels(scopeWith(purge));
    expect(outcome).toEqual({
      kind: "purged",
      result: {
        catalogRead: true,
        removed: [{ id: "fledge-alpha-free", provider: "opencode" }],
      },
    });
  });

  it("says so when the host mounted no purge service", async () => {
    await expect(purgeDeprecatedModels({ remote: {} })).resolves.toEqual({
      kind: "unavailable",
    });
  });

  it("carries the host's refusal as a message, not as a silent undefined", async () => {
    const purge = vi.fn(() => Promise.reject(new Error("no config editor")));
    const outcome = await purgeDeprecatedModels(scopeWith(purge));
    expect(outcome).toEqual({ kind: "failed", message: "no config editor" });
  });

  it("rejects an answer that is not a purge result", async () => {
    const outcome = await purgeDeprecatedModels(
      scopeWith(() => Promise.resolve({ ok: true, value: { weird: true } }))
    );
    expect(outcome).toMatchObject({ kind: "failed" });
  });
});

describe("purgeDeprecatedModels: the paths a scope can take", () => {
  it("reads the namespace through ctx.get, the path that works at runtime", () => {
    // The `scope.remote.opencodeModelPurge` property read in the cases above is
    // the shape a test can build; on a live page cordis THROWS for an undeclared
    // name, and `remoteNamespaceOf` is what both call sites read through. This
    // case exercises that branch, which is the one that ships.
    const purge = vi.fn(async () => ({
      ok: true,
      value: { catalogRead: true, removed: [] },
    }));
    const scope = {
      get: (name: string) =>
        name === "remote.opencodeModelPurge" ? { purge } : undefined,
    };
    return expect(purgeDeprecatedModels(scope)).resolves.toEqual({
      kind: "purged",
      result: { catalogRead: true, removed: [] },
    });
  });

  it("accepts an answer that is the result itself, not wrapped", async () => {
    // The seam may hand back `{ ok, value }` or the value; both are a result.
    const unwrapped = await purgeDeprecatedModels(
      scopeWith(async () => ({ catalogRead: false, removed: [] }))
    );
    expect(unwrapped).toEqual({
      kind: "purged",
      result: { catalogRead: false, removed: [] },
    });
  });

  it("shows the host's own failure, and parses the result through the contract", async () => {
    // The host answers a failure as `{ ok: false, … }`, and reading that as
    // "not a purge result" replaced the message that says WHY with a sentence
    // about shape — which tells the reader nothing they can act on.
    const refused = await purgeDeprecatedModels(
      scopeWith(async () => ({
        ok: false,
        message: "the profile is read-only",
      }))
    );
    expect(refused).toEqual({
      kind: "failed",
      message: "the profile is read-only",
    });

    // And the result is PARSED, not cast: the contract's whitelist is the
    // client's only statement about what it is told, and a cast is no statement
    // at all. A row the whitelist rejects is not a result.
    const malformed = await purgeDeprecatedModels(
      scopeWith(async () => ({
        catalogRead: true,
        removed: [{ id: "a", provider: "opencode", extra: "ignored" }],
      }))
    );
    expect(malformed).toEqual({
      kind: "purged",
      result: {
        catalogRead: true,
        // The whitelist keeps only the fields it renders.
        removed: [{ id: "a", provider: "opencode" }],
      },
    });

    const notAResult = await purgeDeprecatedModels(
      scopeWith(async () => ({ removed: [{ id: 42, provider: "opencode" }] }))
    );
    expect(notAResult).toEqual({
      kind: "failed",
      message: "the host answered something that is not a purge result",
    });
  });

  it("reports a thrown non-Error as its string form", async () => {
    // A remote rejection is not always an Error - a cross-realm throw or a bare
    // string crosses the seam - and the card must still have something to show.
    const outcome = await purgeDeprecatedModels(
      scopeWith(async () => {
        // A non-Error rejection is a real wire shape: a bare string crosses the
        // seam when the host throws one.
        throw new Error("the gateway said no");
      })
    );
    expect(outcome).toEqual({ kind: "failed", message: "the gateway said no" });
  });

  it("survives a scope that is not an object at all", async () => {
    for (const scope of [undefined, null, "scope", 42]) {
      await expect(purgeDeprecatedModels(scope)).resolves.toEqual({
        kind: "unavailable",
      });
    }
  });
});
