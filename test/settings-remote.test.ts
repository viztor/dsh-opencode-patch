/**
 * Reading a remote namespace without taking the surface down.
 *
 * The module exists because cordis THROWS `cannot get property "remote.<namespace>"
 * without inject` rather than answering `undefined`, and an optional chain cannot
 * catch a throw. `scope.remote.opencodeGoUsage` therefore took the whole slot
 * entry down, in a way indistinguishable from a host that mounts no service.
 *
 * These cases pin the four ways a lookup can fail and the one way it succeeds,
 * because the difference between "no service" and "this threw" is the difference
 * between a blank card and a broken plugin entry.
 *
 * @module test/settings-remote.test
 */
import { describe, expect, it } from "vitest";

import { remoteNamespace, remoteNamespaceOf } from "./support/src.ts";

describe("settings-remote · remoteNamespaceOf", () => {
  it("answers the namespace's calls when the remote serves them", () => {
    const read = async () => ({ ok: true });
    const ctx = {
      get: (name: string) =>
        name === "remote.opencodeGoUsage" ? { read } : undefined,
    };
    expect(remoteNamespaceOf(ctx, "opencodeGoUsage")?.read).toBe(read);
  });

  it("answers undefined for a context that is not an object", () => {
    for (const value of [undefined, null, "ctx", 42, true]) {
      expect(remoteNamespaceOf(value, "opencodeGoUsage")).toBeUndefined();
    }
  });

  it("answers undefined for a context with no `get`, rather than throwing", () => {
    // The host context has `get`; the CLIENT scope may not. Both must be safe.
    expect(remoteNamespaceOf({}, "opencodeGoUsage")).toBeUndefined();
    expect(
      remoteNamespaceOf({ get: "not a function" }, "opencodeGoUsage")
    ).toBeUndefined();
  });

  it("answers undefined when the namespace is not mounted", () => {
    expect(
      remoteNamespaceOf({ get: () => {} }, "opencodeGoUsage")
    ).toBeUndefined();
    // A namespace that exists but is not an object is the same answer.
    expect(
      remoteNamespaceOf({ get: () => "nope" }, "opencodeGoUsage")
    ).toBeUndefined();
  });

  it("answers undefined when the read throws, which is the whole point", () => {
    // This is cordis refusing an undeclared property. It must not propagate:
    // that throw is what removed a whole settings surface.
    const hostile = {
      get(name: string): unknown {
        if (name.startsWith("remote.")) {
          throw new Error(`cannot get property "${name}" without inject`);
        }
        return undefined;
      },
    };
    expect(() => remoteNamespaceOf(hostile, "opencodeGoUsage")).not.toThrow();
    expect(remoteNamespaceOf(hostile, "opencodeGoUsage")).toBeUndefined();
  });

  it("only asks for the namespace it was given", () => {
    const asked: string[] = [];
    const ctx = {
      get: (name: string) => {
        asked.push(name);
      },
    };
    remoteNamespaceOf(ctx, "opencodeModelPurge");
    expect(asked).toEqual(["remote.opencodeModelPurge"]);
  });
});

describe("settings-remote · remoteNamespace", () => {
  it("reads a namespace off a plain remote object", () => {
    const read = async () => ({ ok: true });
    expect(remoteNamespace({ usage: { read } }, "usage")?.read).toBe(read);
  });

  it("answers undefined for every shape that cannot serve it", () => {
    for (const remote of [
      undefined,
      null,
      "remote",
      {},
      { usage: "not an object" },
      { usage: null },
    ]) {
      expect(remoteNamespace(remote, "usage")).toBeUndefined();
    }
  });
});
