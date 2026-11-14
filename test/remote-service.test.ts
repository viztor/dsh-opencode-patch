/**
 * `installRemoteService`: the one installer for the plugin's remote services.
 *
 * On a bare cordis `Context`, with a probe service of its own rather than the
 * plugin's three: one service per root while a live activation holds it, the
 * latest live activation's options, the last activation's dispose withdrawing
 * it, and every outcome reported through the activation's own logger once the
 * mount has settled. The stand-in compositions at the end are the shapes a
 * real `Context` cannot take: a `plugin` that throws, answers no fiber, or
 * answers a fiber whose settling (and dispose) the case controls; no
 * `plugin`; no `effect`. They are this file's own, for the installer's
 * clauses, as the route claim keeps its stand-in host: `degradedHost` stands
 * for the plugin's composition, not for this module.
 *
 * @module test/remote-service.test
 */
import { Context, type Fiber } from "@deepseek-ai/cordis";
import { TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { logLines } from "./support/cordis-wait.ts";
import {
  type CordisContext,
  installRemoteService,
  type RemoteContract,
} from "./support/src.ts";

interface ProbeOptions {
  readonly value?: string;
  readonly extra?: number;
}

/** A remote service that answers the options it was handed. */
class Probe extends TypertRemoteService {
  static made = 0;
  static last: Probe | undefined;
  readonly options: ProbeOptions | undefined;

  constructor(ctx: unknown, options?: ProbeOptions) {
    super(ctx as never, "probeRemote");
    Probe.made += 1;
    Probe.last = this;
    this.options = options;
  }

  read(): string | undefined {
    return this.options?.value;
  }
}

const contract: RemoteContract = {
  descriptors: [
    { method: "read", namespace: "probeRemote", service: "probeRemote" },
  ],
};

/** The plugin each activation is: one runtime, as the Loader's rows are. */
const Act = {
  apply: (ctx: CordisContext, config: ProbeOptions) =>
    installRemoteService(ctx, Probe, contract, config),
  name: "act",
};

const activate = async (root: Context, value: string): Promise<Fiber> => {
  const fiber = root.plugin(Act as never, { value } as never);
  await fiber.await();
  return fiber;
};

/** The probe as the root answers it now, or `undefined`. */
const probeOn = (root: Context): Probe | undefined =>
  root.get("probeRemote" as never) as Probe | undefined;

const bindingOf = (root: Context): unknown => probeOn(root)?.typertRemote;

beforeEach(() => {
  Probe.made = 0;
  Probe.last = undefined;
});

describe("installRemoteService · on a real context", () => {
  it("mounts one activation's service on the root, and withdraws it with that activation", async () => {
    const root = new Context();
    const log = logLines(root);
    const act = await activate(root, "a");
    expect(probeOn(root)?.read()).toBe("a");
    expect(Probe.made).toBe(1);
    expect(
      log.lines().some((line) => line.includes("probeRemote is reachable")),
      log.lines().join("\n")
    ).toBe(true);
    await act.dispose();
    expect(probeOn(root) === undefined, "the service outlived its holder").toBe(
      true
    );
  });

  it("shares one service between overlapping activations, reading the latest live one's options, in either disposal order", async () => {
    const root = new Context();
    const first = await activate(root, "a");
    const second = await activate(root, "b");
    expect(probeOn(root)?.read()).toBe("b");
    expect(Probe.made).toBe(1);
    const binding = bindingOf(root);
    await second.dispose();
    expect(probeOn(root)?.read()).toBe("a");
    expect(bindingOf(root), "the same service").toBe(binding);
    await first.dispose();
    expect(probeOn(root) === undefined).toBe(true);

    // The other order, on a root of its own.
    Probe.made = 0;
    const other = new Context();
    const early = await activate(other, "a");
    const late = await activate(other, "b");
    await early.dispose();
    expect(probeOn(other)?.read()).toBe("b");
    await late.dispose();
    expect(probeOn(other) === undefined).toBe(true);
    expect(Probe.made).toBe(1);
  });

  it("mounts anew on a reload, with the reloaded options", async () => {
    const root = new Context();
    const act = await activate(root, "a");
    await act.update({ value: "b" } as never);
    expect(probeOn(root)?.read()).toBe("b");
    expect(Probe.made).toBe(2);
  });

  it("hands the service a view of the latest live activation's options", async () => {
    const root = new Context();
    const first = await activate(root, "a");
    const probe = Probe.last;
    const view = probe?.options ?? {};
    const second = root.plugin(Act as never, { extra: 1, value: "b" } as never);
    await second.await();
    expect(Object.keys(view)).toEqual(["extra", "value"]);
    expect("extra" in view).toBe(true);
    expect(Object.getOwnPropertyDescriptor(view, "extra")).toEqual({
      configurable: true,
      enumerable: true,
      value: 1,
      writable: true,
    });
    await second.dispose();
    expect(Object.keys(view)).toEqual(["value"]);
    expect("extra" in view).toBe(false);
    expect(Object.getOwnPropertyDescriptor(view, "extra")).toBeUndefined();
    // With no live holder left, the view reads the mounting activation's.
    await first.dispose();
    expect(probe?.read()).toBe("a");
  });

  it("reports a refused mount on the activation's logger, and lets the next activation retry", async () => {
    const root = new Context();
    const log = logLines(root);
    const occupant = root.plugin((ctx: Context) => {
      ctx.provide("probeRemote" as never, {} as never);
    });
    await occupant.await();
    await activate(root, "a");
    const lines = log.lines();
    expect(
      lines.some(
        (line) =>
          line.startsWith("warn act:") &&
          line.includes("probeRemote did not mount") &&
          line.includes("has been registered")
      ),
      lines.join("\n")
    ).toBe(true);
    expect(lines.some((line) => line.includes("reachable"))).toBe(false);

    await occupant.dispose();
    await activate(root, "b");
    expect(probeOn(root)?.read()).toBe("b");
  });
});

/** A stand-in composition: a logger that records, and what the case gives. */
const standIn = (
  parts: Record<string, unknown> = {}
): {
  readonly ctx: CordisContext;
  readonly warned: string[];
  readonly infos: string[];
  readonly release: () => Promise<void>;
} => {
  const warned: string[] = [];
  const infos: string[] = [];
  const disposers: (() => unknown)[] = [];
  const ctx = {
    effect: (callback: () => unknown) => {
      const disposer = callback();
      if (typeof disposer === "function") {
        disposers.push(disposer as () => unknown);
      }
    },
    logger: {
      info: (...args: unknown[]) => infos.push(args.map(String).join(" ")),
      warn: (...args: unknown[]) => warned.push(args.map(String).join(" ")),
    },
    ...parts,
  } as unknown as CordisContext;
  return {
    ctx,
    infos,
    release: async () => {
      for (const disposer of disposers.splice(0).toReversed()) {
        await disposer();
      }
    },
    warned,
  };
};

/**
 * A fiber whose settling the case controls, and, with `holdDispose`, whose
 * dispose stays pending until the case calls `finishDispose`.
 */
const heldFiber = ({
  holdDispose = false,
}: { readonly holdDispose?: boolean } = {}): {
  readonly fiber: {
    await: () => Promise<void>;
    dispose: () => Promise<void>;
  };
  readonly settle: (error?: Error) => void;
  readonly disposed: () => number;
  readonly finishDispose: () => void;
} => {
  let disposals = 0;
  let finishDispose: () => void = () => {
    // replaced below when the dispose is held
  };
  const disposeGate = holdDispose
    ? new Promise<void>((resolve) => {
        finishDispose = resolve;
      })
    : Promise.resolve();
  let settle: (error?: Error) => void = () => {
    throw new Error("the promise below assigns this synchronously");
  };
  const settled = new Promise<void>((resolve, reject) => {
    settle = (error) => {
      if (error === undefined) {
        resolve();
      } else {
        reject(error);
      }
    };
  });
  return {
    disposed: () => disposals,
    fiber: {
      await: async () => settled,
      dispose: async () => {
        disposals += 1;
        await disposeGate;
      },
    },
    finishDispose: () => {
      finishDispose();
    },
    settle: (error) => {
      settle(error);
    },
  };
};

describe("installRemoteService · stand-in compositions", () => {
  it("reports a throwing plugin, and tries again on the next install", async () => {
    const plugin = vi.fn(() => {
      throw new Error("refused");
    });
    const host = standIn({ plugin });
    await expect(
      installRemoteService(host.ctx, Probe, contract)
    ).resolves.toBeUndefined();
    expect(host.warned).toEqual([
      "[dsh-opencode-patch] probeRemote did not mount Error: refused",
    ]);
    await installRemoteService(host.ctx, Probe, contract);
    expect(plugin).toHaveBeenCalledTimes(2);
  });

  it("reports a composition with no plugin, and never provides", async () => {
    const provide = vi.fn();
    const host = standIn({ provide });
    await expect(
      installRemoteService(host.ctx, Probe, contract)
    ).resolves.toBeUndefined();
    expect(host.warned).toEqual([
      "[dsh-opencode-patch] probeRemote did not mount: this composition has no ctx.plugin the client's probeRemote.read will find nothing",
    ]);
    expect(provide).not.toHaveBeenCalled();
  });

  it("mounts nothing for a contract that names no single service", async () => {
    const plugin = vi.fn();
    const host = standIn({ plugin });
    for (const descriptors of [
      [
        { method: "read", namespace: "x", service: "x" },
        { method: "read", namespace: "x", service: "y" },
      ],
      // One service, but bound under two namespaces.
      [
        { method: "read", namespace: "x", service: "x" },
        { method: "list", namespace: "y", service: "x" },
      ],
      [],
    ]) {
      await expect(
        installRemoteService(host.ctx, Probe, { descriptors })
      ).resolves.toBeUndefined();
    }
    expect(host.warned).toEqual([
      "[dsh-opencode-patch] a remote contract naming no single service and namespace was not mounted x,y x",
      "[dsh-opencode-patch] a remote contract naming no single service and namespace was not mounted x x,y",
      "[dsh-opencode-patch] a remote contract naming no single service and namespace was not mounted  ",
    ]);
    expect(plugin).not.toHaveBeenCalled();
  });

  it("holds for good in a composition with no effect", async () => {
    const plugin = vi.fn();
    const host = standIn({ effect: undefined, plugin });
    await installRemoteService(host.ctx, Probe, contract, { value: "a" });
    await installRemoteService(host.ctx, Probe, contract, { value: "b" });
    expect(plugin).toHaveBeenCalledTimes(1);
    const [, view] = plugin.mock.calls[0] as unknown as [unknown, ProbeOptions];
    expect(view.value).toBe("b");
  });

  it("reports each verification outcome", async () => {
    const outcome = async (
      get: () => unknown
    ): Promise<{ warned: string[]; infos: string[] }> => {
      const host = standIn({ get, plugin: vi.fn() });
      await installRemoteService(host.ctx, Probe, contract);
      return host;
    };
    const unregistered = await outcome(() => {
      throw new Error("unregistered");
    });
    expect(unregistered.warned).toEqual([
      "[dsh-opencode-patch] probeRemote did not register: ctx.get('probeRemote') answered nothing the client's probeRemote.read will find nothing",
    ]);
    const unbound = await outcome(() => ({ read: () => "x" }));
    expect(unbound.warned.join(" ")).toContain("no typertRemote binding");
    expect(unbound.warned.join(" ")).toContain("ctx.provide()");
    const elsewhere = await outcome(() => ({
      typertRemote: { namespace: "other" },
    }));
    expect(elsewhere.warned).toEqual([
      "[dsh-opencode-patch] probeRemote is bound for namespace other, not probeRemote, the one the client calls",
    ]);
    const numbered = await outcome(() => ({ typertRemote: { namespace: 42 } }));
    expect(numbered.warned).toEqual([
      "[dsh-opencode-patch] probeRemote is bound for namespace 42, not probeRemote, the one the client calls",
    ]);
    const reachable = await outcome(() => ({
      typertRemote: { namespace: "probeRemote" },
    }));
    expect(reachable.warned).toEqual([]);
    expect(reachable.infos).toEqual([
      "[dsh-opencode-patch] probeRemote is reachable with a typertRemote binding for namespace %s probeRemote",
    ]);

    // A composition with no `get` reads as nothing answered.
    const host = standIn({ plugin: vi.fn() });
    await installRemoteService(host.ctx, Probe, contract);
    expect(host.warned.join(" ")).toContain("did not register");

    // An answer with `await` but no `dispose` is no fiber: nothing is waited
    // for, and the read-back still runs.
    const halfFiber = standIn({
      plugin: () => ({ await: () => new Promise(() => {}) }),
    });
    await installRemoteService(halfFiber.ctx, Probe, contract);
    expect(halfFiber.warned.join(" ")).toContain("did not register");
  });

  it("says nothing for an activation that went before its mount settled", async () => {
    const held = heldFiber();
    const host = standIn({ get: vi.fn(), plugin: () => held.fiber });
    const reported = installRemoteService(host.ctx, Probe, contract);
    await host.release();
    expect(held.disposed()).toBe(1);
    held.settle();
    await expect(reported).resolves.toBeUndefined();
    expect([...host.warned, ...host.infos]).toEqual([]);
  });

  it("reports a fiber that fails, disposing it once while another activation waits on it too", async () => {
    const held = heldFiber();
    const plugin = vi.fn(() => held.fiber);
    const host = standIn({ plugin });
    const first = installRemoteService(host.ctx, Probe, contract);
    const second = installRemoteService(host.ctx, Probe, contract);
    held.settle(new Error("refused late"));
    await expect(Promise.all([first, second])).resolves.toEqual([
      undefined,
      undefined,
    ]);
    expect(plugin).toHaveBeenCalledTimes(1);
    expect(host.warned).toEqual([
      "[dsh-opencode-patch] probeRemote did not mount Error: refused late",
      "[dsh-opencode-patch] probeRemote did not mount Error: refused late",
    ]);
    expect(held.disposed()).toBe(1);
    // The mount was cleared, so the next install mounts again (and, on the
    // same refused fiber, reports and disposes it again).
    await installRemoteService(host.ctx, Probe, contract);
    expect(plugin).toHaveBeenCalledTimes(2);
    expect(held.disposed()).toBe(2);

    // Releasing every holder of a cleared mount disposes nothing a second
    // time: the report already disposed each failed fiber.
    await host.release();
    expect(held.disposed()).toBe(2);
    expect(
      host.warned.filter((line) => line.includes("did not dispose"))
    ).toEqual([]);
  });

  it("releases a mount that answered no fiber without disposing anything", async () => {
    const plugin = vi.fn();
    const host = standIn({
      get: () => ({ typertRemote: { namespace: "probeRemote" } }),
      plugin,
    });
    await installRemoteService(host.ctx, Probe, contract);
    await expect(host.release()).resolves.toBeUndefined();
    expect(plugin).toHaveBeenCalledTimes(1);
    // A dispose of the missing fiber would have thrown and been reported.
    expect(host.warned).toEqual([]);
  });

  it("reports a fiber whose await throws, and a dispose that throws", async () => {
    const throwing = {
      await: () => {
        throw new Error("no await");
      },
      dispose: () => {
        throw new Error("no dispose");
      },
    };
    const host = standIn({ plugin: () => throwing });
    await installRemoteService(host.ctx, Probe, contract);
    expect(host.warned).toEqual([
      "[dsh-opencode-patch] probeRemote did not mount Error: no await",
      "[dsh-opencode-patch] probeRemote did not dispose cleanly Error: no dispose",
    ]);
  });

  it("disposes only with the last holder, and returns the dispose for the unload to await", async () => {
    const held = heldFiber({ holdDispose: true });
    const host = standIn({
      get: () => ({ typertRemote: { namespace: "probeRemote" } }),
      plugin: () => held.fiber,
    });
    const other = standIn({ root: host.ctx });
    const first = installRemoteService(host.ctx, Probe, contract);
    const second = installRemoteService(other.ctx, Probe, contract);
    held.settle();
    await Promise.all([first, second]);
    expect(other.infos.join(" ")).toContain("probeRemote is reachable");
    await host.release();
    expect(held.disposed()).toBe(0);

    // The last release starts the dispose, and does not settle before it.
    let released = false;
    const releasing = (async () => {
      await other.release();
      released = true;
    })();
    for (let tick = 0; tick < 5; tick += 1) {
      await new Promise((resolve) => {
        setImmediate(resolve);
      });
    }
    expect(held.disposed()).toBe(1);
    expect(released, "the release settled before the dispose").toBe(false);
    held.finishDispose();
    await releasing;
    expect(released).toBe(true);
  });

  it("checks the binding against the contract's namespace, and reads the service by its key", async () => {
    // A wire namespace that differs from the Cordis key: the Gateway checks
    // the binding against the descriptor's `namespace`, and the service is
    // registered under its `service`.
    const wire: RemoteContract = {
      descriptors: [
        { method: "read", namespace: "probeWire", service: "probeRemote" },
      ],
    };
    const outcome = async (
      namespace: string
    ): Promise<{ warned: string[]; infos: string[]; asked: unknown[] }> => {
      const asked: unknown[] = [];
      const host = standIn({
        get: (name: unknown) => {
          asked.push(name);
          return { typertRemote: { namespace } };
        },
        plugin: vi.fn(),
      });
      await installRemoteService(host.ctx, Probe, wire);
      return { ...host, asked };
    };
    const reachable = await outcome("probeWire");
    expect(reachable.asked).toEqual(["probeRemote"]);
    expect(reachable.warned).toEqual([]);
    expect(reachable.infos).toEqual([
      "[dsh-opencode-patch] probeRemote is reachable with a typertRemote binding for namespace %s probeWire",
    ]);
    const keyed = await outcome("probeRemote");
    expect(keyed.warned).toEqual([
      "[dsh-opencode-patch] probeRemote is bound for namespace probeRemote, not probeWire, the one the client calls",
    ]);
  });

  it("reads frozen and non-configurable options through the view", async () => {
    // The view's target is its own empty object, so a frozen mounting
    // activation's options, or a later holder's non-configurable property,
    // break no Proxy invariant: every trap reads the latest live holder's.
    const plugin = vi.fn();
    const host = standIn({ plugin });
    await installRemoteService(
      host.ctx,
      Probe,
      contract,
      Object.freeze({ value: "a" })
    );
    const later: ProbeOptions = {};
    Object.defineProperty(later, "value", {
      configurable: false,
      enumerable: true,
      value: "b",
      writable: false,
    });
    Object.defineProperty(later, "extra", {
      configurable: false,
      enumerable: true,
      value: 2,
      writable: false,
    });
    await installRemoteService(host.ctx, Probe, contract, later);
    const [, view] = plugin.mock.calls[0] as unknown as [unknown, ProbeOptions];
    expect(view.value).toBe("b");
    expect(view.extra).toBe(2);
    expect("extra" in view).toBe(true);
    expect(Object.keys(view)).toEqual(["value", "extra"]);
    expect(Object.getOwnPropertyDescriptor(view, "value")).toEqual({
      configurable: true,
      enumerable: true,
      value: "b",
      writable: false,
    });
    expect({ ...view }).toEqual({ extra: 2, value: "b" });
  });

  it("refuses a write, a define, a delete and a freeze on the view", async () => {
    // A writable key the holder carries is the case a write would poison:
    // reaching the empty target, it would land there non-configurable and
    // every later read of it would break a Proxy invariant.
    const plugin = vi.fn();
    const host = standIn({ plugin });
    await installRemoteService(host.ctx, Probe, contract, { value: "a" });
    const [, view] = plugin.mock.calls[0] as unknown as [
      unknown,
      { value?: string; extra?: number },
    ];
    expect(() => {
      view.value = "x";
    }).toThrow(TypeError);
    expect(() => {
      view.extra = 1;
    }).toThrow(TypeError);
    expect(() =>
      Object.defineProperty(view, "value", { value: "y", writable: true })
    ).toThrow(TypeError);
    expect(() => {
      delete view.value;
    }).toThrow(TypeError);
    expect(() => Object.freeze(view)).toThrow(TypeError);
    expect(view.value).toBe("a");
    expect("extra" in view).toBe(false);
    expect(Object.keys(view)).toEqual(["value"]);
    expect(Object.getOwnPropertyDescriptor(view, "value")).toEqual({
      configurable: true,
      enumerable: true,
      value: "a",
      writable: true,
    });
    expect({ ...view }).toEqual({ value: "a" });
  });
});
