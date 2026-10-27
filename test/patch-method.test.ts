/**
 * The one way the plugin wraps a method on a host object.
 *
 * Each case is one clause of the contract: (a) a dispose restores only while its
 * wrapper is still the current value, (b) an inherited original comes back by
 * deleting the own property, (c) a second install of the same site wraps the
 * unpatched method rather than the first install, and (d) a site can follow the
 * adapter registry. Identity is read from own descriptors throughout, because on
 * the real host a property read is a fresh proxy every time (the tier-A case).
 *
 * @module test/patch-method.test
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  adaptersOf,
  mountTierA,
  s0Providers,
  type TierA,
} from "./support/host.ts";
import {
  type CordisContext,
  inspectPatch,
  patchMethod,
  rewrapOnAdaptersUpdated,
} from "./support/src.ts";

/** A host whose method is a class method: inherited, and reading `this`. */
class Host {
  calls = 0;
  greet(this: Host, name: string): string {
    this.calls += 1;
    return `hi ${name}`;
  }
}

type Unpatched = (...args: unknown[]) => unknown;

/** A wrapper that appends `suffix`, keeping the caller's receiver. */
const suffixed = (suffix: string) => (unpatched: Unpatched) =>
  function greet(this: unknown, name: string): string {
    return `${String(Reflect.apply(unpatched, this, [name]))}${suffix}`;
  };

const bang = suffixed("!");

/** Call `greet` on any target, with the target as its receiver. */
const greetOn = (target: object, name = "a"): unknown => {
  const method: unknown = Reflect.get(target, "greet");
  if (typeof method !== "function") {
    throw new TypeError("no greet on the target");
  }
  return Reflect.apply(method, target, [name]);
};

/** Call a method by name on its host, with the host as the receiver. */
const greetLike = (
  target: object,
  key: string,
  ...args: unknown[]
): unknown => {
  const method: unknown = Reflect.get(target, key);
  if (typeof method !== "function") {
    throw new TypeError(`no ${key} on the target`);
  }
  return Reflect.apply(method, target, args);
};

/** An object whose `greet` is an own data property with these attributes. */
const ownGreet = (attributes: Partial<PropertyDescriptor> = {}): object => {
  const target = {};
  Object.defineProperty(target, "greet", {
    configurable: true,
    enumerable: true,
    value(name: string): string {
      return `hi ${name}`;
    },
    writable: true,
    ...attributes,
  });
  return target;
};

const SHAPES = {
  inherited: (): object => new Host(),
  own: (): object => ownGreet(),
} as const;

let tier: TierA | undefined;

afterEach(async () => {
  await tier?.dispose();
  tier = undefined;
});

describe("patchMethod", () => {
  it("(b) an inherited method is wrapped with an own property, keeps its receiver, and is deleted on dispose", () => {
    const host = new Host();
    const stop = patchMethod(host, "greet", bang, { id: "t" });

    expect(stop).toBeTypeOf("function");
    expect(Object.hasOwn(host, "greet")).toBe(true);
    // Synchronous in, synchronous out: the trampoline is not `async`.
    expect(host.greet("a")).toBe("hi a!");
    // It ran ON the instance: the counter lives on `this`.
    expect(host.calls).toBe(1);

    stop?.();
    expect(Object.hasOwn(host, "greet")).toBe(false);
    expect(Reflect.get(host, "greet")).toBe(
      Reflect.get(Host.prototype, "greet")
    );
  });

  it("an own method keeps its attributes while installed and gets its exact descriptor back", () => {
    const target = ownGreet({ enumerable: false });
    const original = Reflect.getOwnPropertyDescriptor(target, "greet");
    const stop = patchMethod(target, "greet", bang, { id: "t" });

    const installed = Reflect.getOwnPropertyDescriptor(target, "greet");
    expect(installed?.value).not.toBe(original?.value);
    expect(installed?.enumerable).toBe(false);
    expect(greetOn(target)).toBe("hi a!");

    stop?.();
    const restored = Reflect.getOwnPropertyDescriptor(target, "greet");
    expect(restored).toEqual(original);
    expect(restored?.value).toBe(original?.value);
  });

  it("(a) leaves a wrapper set on top of it in place, and becomes a pass-through under it", () => {
    const host = new Host();
    const stop = patchMethod(host, "greet", bang, { id: "t" });
    const ours: unknown = Reflect.getOwnPropertyDescriptor(
      host,
      "greet"
    )?.value;
    if (typeof ours !== "function") {
      throw new TypeError("nothing installed");
    }
    const foreign = function foreign(this: unknown, name: string): string {
      return `[${String(Reflect.apply(ours, this, [name]))}]`;
    };
    Reflect.set(host, "greet", foreign);

    stop?.();
    expect(Reflect.getOwnPropertyDescriptor(host, "greet")?.value).toBe(
      foreign
    );
    // Ours still runs under the foreign wrapper, and no longer decorates.
    expect(greetOn(host)).toBe("[hi a]");
  });

  it.each(Object.entries(SHAPES))(
    "(c) a second install of the same site wraps the unpatched method, never the first install (%s)",
    (_shape, make) => {
      const target = make();
      const original: unknown = Reflect.get(target, "greet");
      const first = patchMethod(target, "greet", bang, { id: "t" });
      const seen: unknown[] = [];
      const second = patchMethod(
        target,
        "greet",
        (unpatched) => {
          seen.push(unpatched);
          return bang(unpatched);
        },
        { id: "t" }
      );

      expect(seen).toEqual([original]);
      expect(seen[0]).toBe(original);
      // One decoration, not two.
      expect(greetOn(target)).toBe("hi a!");
      second?.();
      first?.();
    }
  );

  it.each(
    Object.entries(SHAPES).flatMap(([shape, make]) => [
      [shape, "first-in first-out", make, true] as const,
      [shape, "last-in first-out", make, false] as const,
    ])
  )("%s · %s ends at the exact original", (_shape, _order, make, fifo) => {
    const target = make();
    const before = Reflect.getOwnPropertyDescriptor(target, "greet");
    const a = patchMethod(target, "greet", bang, { id: "t" });
    const installedA: unknown = Reflect.getOwnPropertyDescriptor(
      target,
      "greet"
    )?.value;
    const b = patchMethod(target, "greet", bang, { id: "t" });
    const installedB: unknown = Reflect.getOwnPropertyDescriptor(
      target,
      "greet"
    )?.value;
    expect(installedB).not.toBe(installedA);

    (fifo ? a : b)?.();
    // The survivor is installed and decorates exactly once.
    expect(Reflect.getOwnPropertyDescriptor(target, "greet")?.value).toBe(
      fifo ? installedB : installedA
    );
    expect(greetOn(target)).toBe("hi a!");

    (fifo ? b : a)?.();
    expect(Reflect.getOwnPropertyDescriptor(target, "greet")).toEqual(before);
    expect(Reflect.getOwnPropertyDescriptor(target, "greet")?.value).toBe(
      before?.value
    );
    expect(greetOn(target)).toBe("hi a");
  });

  it.each([
    ["the outer first", true],
    ["the inner first", false],
  ] as const)(
    "two different sites compose, and disposing %s ends with no own property",
    (_order, outerFirst) => {
      const host = new Host();
      const inner = patchMethod(host, "greet", bang, { id: "inner" });
      const outer = patchMethod(host, "greet", suffixed("?"), { id: "outer" });
      expect(greetOn(host)).toBe("hi a!?");

      if (outerFirst) {
        outer?.();
        expect(greetOn(host)).toBe("hi a!");
        inner?.();
      } else {
        inner?.();
        // The inner one is retired under the outer one: a pass-through.
        expect(greetOn(host)).toBe("hi a?");
        outer?.();
      }
      expect(Object.hasOwn(host, "greet")).toBe(false);
      expect(greetOn(host)).toBe("hi a");
    }
  );

  it("collapses a retired same-site wrapper it finds as the original, back to what that one replaced", () => {
    // A (site t) is replaced by B (site t); a foreign site wraps B; B retires
    // under it. Retired, B hands the call to A, which is still live, so the
    // answer stays decorated. When the foreign site goes, B is nobody's
    // original: A is what comes back.
    const host = new Host();
    const a = patchMethod(host, "greet", bang, { id: "t" });
    const installedA: unknown = Reflect.getOwnPropertyDescriptor(
      host,
      "greet"
    )?.value;
    const b = patchMethod(host, "greet", bang, { id: "t" });
    const other = patchMethod(host, "greet", suffixed("?"), { id: "other" });
    b?.();
    expect(greetOn(host)).toBe("hi a!?");

    other?.();
    expect(Reflect.getOwnPropertyDescriptor(host, "greet")?.value).toBe(
      installedA
    );
    expect(greetOn(host)).toBe("hi a!");
    a?.();
    expect(Object.hasOwn(host, "greet")).toBe(false);
  });

  it("refuses a key that holds no method, without calling wrap", () => {
    const wrap = vi.fn(bang);
    const missing = new Host();
    const notAMethod = { greet: 42 };

    expect(patchMethod(missing, "absent", wrap, { id: "t" })).toBeUndefined();
    expect(Object.hasOwn(missing, "absent")).toBe(false);
    expect(patchMethod(notAMethod, "greet", wrap, { id: "t" })).toBeUndefined();
    expect(notAMethod.greet).toBe(42);
    expect(
      patchMethod(Object.create(null), "greet", wrap, { id: "t" })
    ).toBeUndefined();
    expect(wrap).not.toHaveBeenCalled();
  });

  it("refuses an inherited accessor without running it, and adds no own property", () => {
    let reads = 0;
    class Getter {
      get greet(): () => string {
        reads += 1;
        return () => "hi";
      }
    }
    const target = new Getter();

    expect(patchMethod(target, "greet", bang, { id: "t" })).toBeUndefined();
    expect(reads).toBe(0);
    expect(Object.hasOwn(target, "greet")).toBe(false);
  });

  it("finds an inherited method more than one prototype up", () => {
    class Child extends Host {}
    const host = new Child();
    const stop = patchMethod(host, "greet", bang, { id: "t" });

    expect(host.greet("a")).toBe("hi a!");
    stop?.();
    expect(Object.hasOwn(host, "greet")).toBe(false);
    expect(host.greet("a")).toBe("hi a");
  });

  it("refuses an own accessor, and leaves it untouched", () => {
    const target = {
      get greet(): () => string {
        return () => "hi";
      },
    };
    const before = Reflect.getOwnPropertyDescriptor(target, "greet");

    expect(patchMethod(target, "greet", bang, { id: "t" })).toBeUndefined();
    expect(Reflect.getOwnPropertyDescriptor(target, "greet")).toEqual(before);
  });

  it.each([
    ["a frozen own method", () => Object.freeze(ownGreet())],
    [
      "a non-extensible object over an inherited method",
      () => Object.preventExtensions(new Host()),
    ],
    [
      "a proxy whose defineProperty trap throws",
      () =>
        new Proxy(ownGreet(), {
          defineProperty: () => {
            throw new TypeError("refused");
          },
        }),
    ],
  ])("refuses %s, and leaves it untouched", (_case, make) => {
    const target = make();
    const before = Reflect.getOwnPropertyDescriptor(target, "greet");

    expect(patchMethod(target, "greet", bang, { id: "t" })).toBeUndefined();
    expect(Reflect.getOwnPropertyDescriptor(target, "greet")).toEqual(before);
    expect(greetOn(target)).toBe("hi a");
  });

  it("treats a wrapper of ours copied under another key as foreign there", () => {
    const host = new Host();
    const stop = patchMethod(host, "greet", bang, { id: "t" });
    const copied: unknown = Reflect.getOwnPropertyDescriptor(
      host,
      "greet"
    )?.value;
    Reflect.set(host, "other", copied);

    const seen: unknown[] = [];
    const stopOther = patchMethod(
      host,
      "other",
      (unpatched) => {
        seen.push(unpatched);
        return suffixed("?")(unpatched);
      },
      { id: "t" }
    );
    // It wraps the copy as it found it, rather than reaching for a slot that
    // belongs to `greet`.
    expect(seen).toEqual([copied]);
    stopOther?.();
    expect(Reflect.getOwnPropertyDescriptor(host, "other")?.value).toBe(copied);
    stop?.();
  });

  it("a repeated dispose leaves a later install alone", () => {
    const host = new Host();
    const first = patchMethod(host, "greet", bang, { id: "t" });
    first?.();
    const later = patchMethod(host, "greet", bang, { id: "t" });
    const installed: unknown = Reflect.getOwnPropertyDescriptor(
      host,
      "greet"
    )?.value;

    first?.();
    expect(Reflect.getOwnPropertyDescriptor(host, "greet")?.value).toBe(
      installed
    );
    expect(greetOn(host)).toBe("hi a!");
    later?.();
    expect(Object.hasOwn(host, "greet")).toBe(false);
  });

  it("a retired wrapper a foreign one puts back is collapsed by the next dispose", () => {
    // Ours retires under a foreign wrapper, which then restores what it
    // captured: ours, retired. That is nobody's wrapper any more, so a dispose
    // that finds it current collapses it to the original.
    const host = new Host();
    const stop = patchMethod(host, "greet", bang, { id: "t" });
    const ours: unknown = Reflect.getOwnPropertyDescriptor(
      host,
      "greet"
    )?.value;
    Reflect.set(host, "greet", (): string => "foreign");
    stop?.();
    Reflect.set(host, "greet", ours);
    expect(greetOn(host)).toBe("hi a");

    stop?.();
    expect(Object.hasOwn(host, "greet")).toBe(false);
  });

  it("disposes quietly when the property was deleted under it", () => {
    const host = new Host();
    const stop = patchMethod(host, "greet", bang, { id: "t" });
    Reflect.deleteProperty(host, "greet");

    stop?.();
    expect(Object.hasOwn(host, "greet")).toBe(false);
    expect(greetOn(host)).toBe("hi a");
  });

  it("three live installs of one site hand back newest first, and end at the original", () => {
    // Each install answers with its own suffix, so the answer names which one
    // ran; a same-site install wraps the unpatched method, never another one.
    const host = new Host();
    const current = (): unknown =>
      Reflect.getOwnPropertyDescriptor(host, "greet")?.value;
    const a = patchMethod(host, "greet", suffixed("A"), { id: "t" });
    const b = patchMethod(host, "greet", suffixed("B"), { id: "t" });
    const installedB = current();
    const c = patchMethod(host, "greet", suffixed("C"), { id: "t" });
    expect(greetOn(host)).toBe("hi aC");

    // The newest goes first while TWO predecessors are live: the newest of
    // them, B, is the heir, not the oldest.
    c?.();
    expect(current()).toBe(installedB);
    expect(greetOn(host)).toBe("hi aB");
    a?.();
    expect(current()).toBe(installedB);
    expect(greetOn(host)).toBe("hi aB");
    b?.();
    expect(Object.hasOwn(host, "greet")).toBe(false);
    expect(greetOn(host)).toBe("hi a");
  });

  it("the middle install of three goes first: the newest stays and hands back to the oldest", () => {
    const host = new Host();
    const current = (): unknown =>
      Reflect.getOwnPropertyDescriptor(host, "greet")?.value;
    const liveIn = (value: unknown): number =>
      (inspectPatch(value, "greet") ?? []).filter((entry) => entry.live).length;
    const a = patchMethod(host, "greet", suffixed("A"), { id: "t" });
    const installedA = current();
    const b = patchMethod(host, "greet", suffixed("B"), { id: "t" });
    const c = patchMethod(host, "greet", suffixed("C"), { id: "t" });
    const installedC = current();
    expect(liveIn(installedC)).toBe(3);

    b?.();
    expect(current()).toBe(installedC);
    expect(liveIn(installedC)).toBe(2);
    expect(greetOn(host)).toBe("hi aC");
    c?.();
    expect(current()).toBe(installedA);
    expect(greetOn(host)).toBe("hi aA");
    a?.();
    expect(Object.hasOwn(host, "greet")).toBe(false);
  });

  it("under a foreign wrapper, a retired newest install falls through to the newest live one", () => {
    // The trampoline twin of the heir choice above: C is captured by a foreign
    // wrapper, so its dispose cannot restore and C turns into a pass-through.
    const host = new Host();
    const a = patchMethod(host, "greet", suffixed("A"), { id: "t" });
    const b = patchMethod(host, "greet", suffixed("B"), { id: "t" });
    const c = patchMethod(host, "greet", suffixed("C"), { id: "t" });
    const inner: unknown = Reflect.getOwnPropertyDescriptor(
      host,
      "greet"
    )?.value;
    if (typeof inner !== "function") {
      throw new TypeError("nothing installed");
    }
    Reflect.set(
      host,
      "greet",
      function foreign(this: unknown, name: string): string {
        return `[${String(Reflect.apply(inner, this, [name]))}]`;
      }
    );
    expect(greetOn(host)).toBe("[hi aC]");

    c?.();
    expect(greetOn(host)).toBe("[hi aB]");
    b?.();
    expect(greetOn(host)).toBe("[hi aA]");
    a?.();
    expect(greetOn(host)).toBe("[hi a]");
  });

  it("a retired install keeps no wrapper alive, and live installs skip it", () => {
    // A long-running host reloads the plugin many times. A retired record
    // drops what `wrap` built (which closes over an activation's context and
    // config), and the chain from the current install no longer reaches it.
    const host = new Host();
    const current = (): unknown =>
      Reflect.getOwnPropertyDescriptor(host, "greet")?.value;
    const a = patchMethod(host, "greet", bang, { id: "t" });
    const installedA = current();
    const b = patchMethod(host, "greet", bang, { id: "t" });
    expect(inspectPatch(current(), "greet")).toEqual([
      { holdsWrapper: true, id: "t", live: true },
      { holdsWrapper: true, id: "t", live: true },
    ]);

    a?.();
    expect(inspectPatch(installedA, "greet")).toEqual([
      { holdsWrapper: false, id: "t", live: false },
    ]);
    const c = patchMethod(host, "greet", bang, { id: "t" });
    // C, then B: A is not in the chain.
    expect(inspectPatch(current(), "greet")).toEqual([
      { holdsWrapper: true, id: "t", live: true },
      { holdsWrapper: true, id: "t", live: true },
    ]);
    expect(greetOn(host)).toBe("hi a!");

    c?.();
    b?.();
    expect(Object.hasOwn(host, "greet")).toBe(false);
    expect(inspectPatch(Reflect.get(host, "greet"), "greet")).toBeUndefined();
    expect(inspectPatch(installedA, "other")).toBeUndefined();
  });

  it(
    "through the real cordis service proxy (tier A): a method read is never the same function twice, and the helper still restores",
    { timeout: 15_000 },
    async () => {
      tier = await mountTierA({ providers: s0Providers() });
      const { llm } = tier;
      // The host fact the helper is built around.
      expect(Reflect.get(llm, "listProviders")).not.toBe(
        Reflect.get(llm, "listProviders")
      );
      const base = llm.listProviders();

      const stop = patchMethod(
        llm,
        "listProviders",
        (unpatched) =>
          function listProviders(this: unknown): unknown {
            const listed: unknown = Reflect.apply(unpatched, this, []);
            return [
              ...(Array.isArray(listed) ? listed : []),
              { id: "x", name: "x" },
            ];
          },
        { id: "t" }
      );
      expect(llm.listProviders()).toContainEqual({ id: "x", name: "x" });

      stop?.();
      expect(Object.hasOwn(llm, "listProviders")).toBe(false);
      expect(llm.listProviders()).toEqual(base);
    }
  );

  it(
    "a foreign wrap and unwrap through ctx.llm (tier A) puts back a shadow proxy: the recorded limit, a correct pass-through left as an own property that the next install wraps once",
    { timeout: 15_000 },
    async () => {
      tier = await mountTierA({ providers: s0Providers() });
      const { llm } = tier;
      const base = llm.listProviders();
      const stop = patchMethod(
        llm,
        "listProviders",
        (unpatched) =>
          function listProviders(this: unknown): unknown {
            const listed: unknown = Reflect.apply(unpatched, this, []);
            return [
              ...(Array.isArray(listed) ? listed : []),
              { id: "x", name: "x" },
            ];
          },
        { id: "t" }
      );
      const installed: unknown = Reflect.getOwnPropertyDescriptor(
        llm,
        "listProviders"
      )?.value;

      // Another plugin, through the same proxy: read, wrap, later put back.
      const captured: unknown = Reflect.get(llm, "listProviders");
      expect(captured).not.toBe(installed);
      Reflect.set(llm, "listProviders", (): unknown => []);
      Reflect.set(llm, "listProviders", captured);
      // What came back is cordis's shadow proxy around ours, not ours.
      expect(
        Reflect.getOwnPropertyDescriptor(llm, "listProviders")?.value
      ).not.toBe(installed);
      expect(llm.listProviders()).toContainEqual({ id: "x", name: "x" });

      // Our dispose sees a foreign value and leaves it; the answer is the
      // host's own, through the retired trampoline.
      stop?.();
      expect(Object.hasOwn(llm, "listProviders")).toBe(true);
      expect(llm.listProviders()).toEqual(base);

      // The next activation, which is how the limit reaches a real host
      // (cordis disposes, then re-applies): it wraps the proxy as a foreign
      // original, decorates exactly once, and its dispose puts the proxy back.
      const leftover: unknown = Reflect.getOwnPropertyDescriptor(
        llm,
        "listProviders"
      )?.value;
      const again = patchMethod(
        llm,
        "listProviders",
        (unpatched) =>
          function listProviders(this: unknown): unknown {
            const listed: unknown = Reflect.apply(unpatched, this, []);
            return [
              ...(Array.isArray(listed) ? listed : []),
              { id: "x", name: "x" },
            ];
          },
        { id: "t" }
      );
      const listed = llm.listProviders() as { id?: unknown }[];
      expect(listed.filter((entry) => entry.id === "x")).toHaveLength(1);
      again?.();
      expect(
        Reflect.getOwnPropertyDescriptor(llm, "listProviders")?.value
      ).toBe(leftover);
      expect(llm.listProviders()).toEqual(base);
    }
  );
});

describe("rewrapOnAdaptersUpdated", () => {
  /** A stand-in `on` that records each subscription and counts disposals. */
  const fakeOn = () => {
    const subscriptions: {
      event: string;
      listener: () => unknown;
    }[] = [];
    let offCalls = 0;
    const ctx: Pick<CordisContext, "on"> = {
      on: (event, listener) => {
        subscriptions.push({
          event,
          listener: () => listener({}, () => null),
        });
        return () => {
          offCalls += 1;
          return true;
        };
      },
    };
    return { ctx, offCalls: () => offCalls, subscriptions };
  };

  it("reinstalls on llm/adapters-updated and stops listening on dispose", () => {
    const { ctx, offCalls, subscriptions } = fakeOn();
    const t1 = new Host();
    const t2 = new Host();
    let target: object = t1;
    const stop = rewrapOnAdaptersUpdated(ctx, () =>
      patchMethod(target, "greet", bang, { id: "r" })
    );

    expect(subscriptions).toHaveLength(1);
    const [subscription] = subscriptions;
    if (subscription === undefined) {
      throw new TypeError("no subscription");
    }
    const { event, listener } = subscription;
    expect(event).toBe("llm/adapters-updated");
    expect(Object.hasOwn(t1, "greet")).toBe(true);

    target = t2;
    listener();
    expect(Object.hasOwn(t1, "greet")).toBe(false);
    expect(Object.hasOwn(t2, "greet")).toBe(true);
    expect(t2.greet("a")).toBe("hi a!");

    listener();
    expect(t2.greet("a")).toBe("hi a!");

    stop();
    expect(offCalls()).toBe(1);
    expect(Object.hasOwn(t2, "greet")).toBe(false);

    listener();
    expect(Object.hasOwn(t2, "greet")).toBe(false);
    stop();
    expect(offCalls()).toBe(1);
  });

  it("without an event source it installs once, and dispose restores", () => {
    const host = new Host();
    const install = vi.fn(() => patchMethod(host, "greet", bang, { id: "r" }));
    const stop = rewrapOnAdaptersUpdated({}, install);

    expect(install).toHaveBeenCalledTimes(1);
    expect(host.greet("a")).toBe("hi a!");
    stop();
    expect(Object.hasOwn(host, "greet")).toBe(false);
  });

  it("an install that found nothing is retried on the next update", () => {
    const { ctx, subscriptions } = fakeOn();
    let target: object = Object.create(null);
    const stop = rewrapOnAdaptersUpdated(ctx, () =>
      patchMethod(target, "greet", bang, { id: "r" })
    );

    const host = new Host();
    target = host;
    subscriptions[0]?.listener();
    expect(host.greet("a")).toBe("hi a!");
    stop();
    expect(Object.hasOwn(host, "greet")).toBe(false);
  });

  it(
    "on the real host (tier A): a registry change reinstalls over pi-ai's plane adapter, once",
    { timeout: 15_000 },
    async () => {
      tier = await mountTierA({ providers: s0Providers() });
      const adapter = adaptersOf(tier.llm).get("opencode")?.adapter;
      if (adapter === undefined) {
        throw new TypeError("no adapter behind the opencode route");
      }
      let installs = 0;
      let decorations = 0;
      const stop = rewrapOnAdaptersUpdated(
        tier.ctx as unknown as CordisContext,
        () => {
          installs += 1;
          return patchMethod(
            adapter,
            "resolveModel",
            (unpatched) =>
              function resolveModel(
                this: unknown,
                ...args: unknown[]
              ): unknown {
                decorations += 1;
                return Reflect.apply(unpatched, this, args);
              },
            { id: "rewrap-probe" }
          );
        }
      );
      expect(installs).toBe(1);

      const handle = tier.llm.registerAdapter(["reload-probe"], {
        providerInfo: (provider: string) => ({ id: provider, name: provider }),
        providerRetryPolicy: () => null,
      } as never);
      expect(installs).toBe(2);
      handle();
      expect(installs).toBe(3);

      // An emit whose `thisArg` carries a cordis filter that rejects every
      // context still reaches the listener: it is registered `global`.
      // Today's emitter passes no `thisArg`; this is the case `global` is for.
      tier.ctx.emit(
        { [Symbol.for("cordis.filter")]: () => false },
        "llm/adapters-updated"
      );
      expect(installs).toBe(4);

      await greetLike(adapter, "resolveModel", "opencode", "deepseek-v4-pro");
      // One layer, though it was reinstalled on every update.
      expect(decorations).toBe(1);

      stop();
      expect(Object.hasOwn(adapter, "resolveModel")).toBe(false);
    }
  );
});
