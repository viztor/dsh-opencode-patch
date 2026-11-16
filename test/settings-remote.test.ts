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
import { describe, expect, it, vi } from "vitest";

import {
  callRemote,
  callUsageRead,
  defineRemote,
  findRemoteCall,
  remoteNamespace,
  remoteNamespaceOf,
  remoteValue,
  unwrapRemote,
} from "./support/src.ts";

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

describe("settings-remote · callUsageRead", () => {
  it("passes the query through and answers what the namespace answered", async () => {
    const seen: unknown[] = [];
    const read = async (query?: unknown) => {
      seen.push(query);
      return { ok: true, value: { rolling: 15 } };
    };
    const answer = await callUsageRead(read, { provider: "opencode-go" });
    expect(answer).toEqual({ ok: true, value: { rolling: 15 } });
    expect(seen).toEqual([{ provider: "opencode-go" }]);
  });

  it("retries unscoped when the client refuses the sibling's zero-argument read", async () => {
    const seen: unknown[] = [];
    const read = async (query?: unknown) => {
      seen.push(query);
      if (seen.length === 1) {
        throw new Error(
          "client api: opencodeGoUsage/read expected 0 argument(s), got 1"
        );
      }
      return { ok: true };
    };
    await expect(
      callUsageRead(read, { provider: "opencode-go" })
    ).resolves.toEqual({ ok: true });
    expect(seen).toEqual([{ provider: "opencode-go" }, undefined]);
  });

  it("rethrows anything that is not an arity refusal, without a second call", async () => {
    const seen: unknown[] = [];
    const read = async (query?: unknown) => {
      seen.push(query);
      throw new Error("usage call failed");
    };
    await expect(
      callUsageRead(read, { provider: "opencode-go" })
    ).rejects.toThrow("usage call failed");
    expect(seen).toHaveLength(1);
  });
});

/**
 * A probe contract for the one unwrap: its parser answers `undefined` for a
 * string, `null` for `null`, THROWS for `false`, and keeps a record's `n`.
 */
const parseProbe = (value: unknown): { n: number } | null | undefined => {
  if (value === false) {
    throw new TypeError("not a probe");
  }
  if (value === null) {
    return null;
  }
  return typeof value === "object" &&
    "n" in value &&
    typeof value.n === "number"
    ? { n: value.n }
    : undefined;
};
const probe = defineRemote("probeRemote", {
  read: { result: remoteValue("Probe", parseProbe) },
});

describe("settings-remote · findRemoteCall", () => {
  it("reads through ctx.get first, ahead of the property", () => {
    const viaGet = async () => "get";
    const viaProperty = async () => "property";
    const scope = {
      get: (name: string) =>
        name === "remote.probeRemote" ? { read: viaGet } : undefined,
      remote: { probeRemote: { read: viaProperty } },
    };
    expect(findRemoteCall(scope, probe, "read")).toEqual({ call: viaGet });
  });

  it("never reads the remote face when ctx.get resolves, so a throwing getter costs nothing", () => {
    const read = async () => "get";
    let faceReads = 0;
    const scope = {
      get: (name: string) =>
        name === "remote.probeRemote" ? { read } : undefined,
      get remote(): unknown {
        faceReads += 1;
        throw new Error('cannot get property "remote" without inject');
      },
    };
    expect(findRemoteCall(scope, probe, "read")).toEqual({ call: read });
    expect(faceReads).toBe(0);
  });

  it("reads a throwing remote getter as no remote when ctx.get misses", () => {
    const scope = {
      get: (): unknown => null,
      get remote(): unknown {
        throw new Error('cannot get property "remote" without inject');
      },
    };
    expect(findRemoteCall(scope, probe, "read")).toEqual({
      call: undefined,
      exposed: [],
    });
  });

  it("falls back to the guarded property", () => {
    const read = async () => "property";
    expect(
      findRemoteCall({ remote: { probeRemote: { read } } }, probe, "read")
    ).toEqual({ call: read });
  });

  it("answers no call for a guarded read that throws", () => {
    const remote = new Proxy(
      {},
      {
        get: (_target, property) => {
          if (property === "probeRemote") {
            throw new TypeError(
              'cannot get property "remote.probeRemote" without inject'
            );
          }
        },
      }
    );
    expect(findRemoteCall({ remote }, probe, "read")).toEqual({
      call: undefined,
      exposed: [],
    });
  });

  it("names the namespace's keys when the method is missing, and the remote's when the namespace is", () => {
    expect(
      findRemoteCall({ remote: { probeRemote: { peek: 1 } } }, probe, "read")
    ).toEqual({ call: undefined, exposed: ["peek"] });
    expect(
      findRemoteCall({ remote: { other: {}, more: {} } }, probe, "read")
    ).toEqual({ call: undefined, exposed: ["other", "more"] });
    expect(findRemoteCall({ remote: "face" }, probe, "read")).toEqual({
      call: undefined,
      exposed: [],
    });
  });

  it("answers no call and no keys for a scope that is not an object", () => {
    for (const scope of [undefined, null, "scope", 42]) {
      expect(findRemoteCall(scope, probe, "read")).toEqual({
        call: undefined,
        exposed: [],
      });
    }
  });
});

describe("settings-remote · unwrapRemote, the one unwrap", () => {
  const failure = new Error("m");
  const blank = {};
  it.each<{ name: string; answer: unknown; expected: unknown }>([
    {
      answer: { ok: true, value: { n: 1 } },
      expected: { kind: "ok", value: { n: 1 } },
      name: "an ok envelope is its parsed value",
    },
    {
      answer: { ok: true },
      expected: { kind: "invalid", value: undefined },
      name: "an ok envelope with no value is not one",
    },
    {
      answer: { error: failure, ok: false },
      expected: { error: failure, kind: "refused", reason: "m" },
      name: "a refusal carries its error and the error's message",
    },
    {
      answer: { error: "s", ok: false },
      expected: { error: "s", kind: "refused", reason: "s" },
      name: "a string error is its own reason",
    },
    {
      answer: { message: "e", ok: false },
      expected: { error: undefined, kind: "refused", reason: "e" },
      name: "an envelope message is the reason",
    },
    {
      answer: { error: failure, message: "e", ok: false },
      expected: { error: failure, kind: "refused", reason: "e" },
      name: "the envelope's message comes first",
    },
    {
      answer: { ok: false },
      expected: { error: undefined, kind: "refused", reason: undefined },
      name: "a bare refusal has no reason",
    },
    {
      answer: { error: blank, ok: false },
      expected: { error: blank, kind: "refused", reason: undefined },
      name: "an error with no message has no reason",
    },
    {
      answer: { n: 2 },
      expected: { kind: "ok", value: { n: 2 } },
      name: "a bare value is the payload",
    },
    {
      answer: { value: { n: 3 } },
      expected: { kind: "ok", value: { n: 3 } },
      name: "a value without ok is the payload",
    },
    {
      answer: 42,
      expected: { kind: "invalid", value: 42 },
      name: "a payload the parser answers undefined for is invalid",
    },
    {
      answer: null,
      expected: { kind: "invalid", value: null },
      name: "a payload the parser answers null for is invalid",
    },
    {
      answer: { value: { message: "x", ok: false } },
      expected: { kind: "invalid", value: { message: "x", ok: false } },
      name: "a refusal nested inside value is not read as one",
    },
    {
      answer: { ok: true, value: false },
      expected: { kind: "invalid", value: false },
      name: "a parser that throws makes the payload invalid",
    },
    {
      answer: { n: 4, ok: "yes" },
      expected: { kind: "ok", value: { n: 4 } },
      name: "an ok that is not a boolean is no envelope",
    },
  ])("$name", ({ answer, expected }) => {
    const unwrapped = unwrapRemote(probe, "read", answer);
    expect(unwrapped).toEqual(expected);
    if (unwrapped.kind === "refused" && isErrorCase(answer)) {
      // The same object, not a copy: the caller rethrows it.
      expect(unwrapped.error).toBe(answer.error);
    }
  });
});

/** Whether an answer carries an `error` key to compare by identity. */
const isErrorCase = (answer: unknown): answer is { error: unknown } =>
  typeof answer === "object" && answer !== null && "error" in answer;

describe("settings-remote · callRemote", () => {
  it("answers unavailable, with the exposed keys, when there is no call", async () => {
    await expect(
      callRemote({ remote: { other: {} } }, probe, "read")
    ).resolves.toEqual({ exposed: ["other"], kind: "unavailable" });
  });

  it("calls with NO argument when none is given, as the arity check requires", async () => {
    const read = vi.fn(async () => ({ ok: true, value: { n: 5 } }));
    await expect(
      callRemote({ remote: { probeRemote: { read } } }, probe, "read")
    ).resolves.toEqual({ kind: "ok", value: { n: 5 } });
    expect(read.mock.calls[0]).toHaveLength(0);
  });

  it("passes an argument as the one argument", async () => {
    const read = vi.fn(async (_query?: unknown) => ({ n: 6 }));
    await callRemote({ remote: { probeRemote: { read } } }, probe, "read", {
      q: 1,
    });
    expect(read.mock.calls[0]).toEqual([{ q: 1 }]);
  });

  it("rejects with the call's own rejection", async () => {
    const error = new Error("the gateway said no");
    await expect(
      callRemote(
        {
          remote: { probeRemote: { read: () => Promise.reject(error) } },
        },
        probe,
        "read"
      )
    ).rejects.toBe(error);
  });
});
