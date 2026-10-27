import assert from "node:assert/strict";

import { describe, expect, it, vi } from "vitest";

import {
  applySettingsPage as apply,
  CARD_FIELDS,
  Config,
  CONFIG_ONLY_FIELDS,
  en,
  ENDPOINT_FAMILIES,
  KEY_SOURCE_POLICIES,
  LEGACY_NS,
  NS,
  PKG,
  remoteNamespace,
  remoteNamespaceOf,
  SCOPED_PKG,
  SPECS,
} from "./support/src.ts";
import {
  elementName,
  findAll,
  findAllWhere,
  firstOf,
  type TestElement,
} from "./test-helpers.ts";

/** Every control component the card can render, keyed by the register's `kind`. */
const COMPONENT_BY_KIND = {
  boolean: "SettingsBooleanField",
  select: "SettingsChoiceField",
} as const;

const CONTROL_TYPES: ReadonlySet<string> = new Set(
  Object.values(COMPONENT_BY_KIND)
);

/** The card's controls, in document order. */
const controlsInOrder = (tree: unknown): TestElement[] =>
  findAllWhere(tree, (element) => CONTROL_TYPES.has(elementName(element.type)));

describe("settings-page: apply & slots", () => {
  it("registers dictionaries for modern and legacy namespaces without throwing", () => {
    const registered: Record<string, unknown> = {};
    const ctx = {
      effect: (fn: () => unknown) => fn(),
      locale: {
        bind: () => (k: string) => k,
        register: (ns: string, dicts: unknown) => {
          registered[ns] = dicts;
        },
      },
    };

    apply(ctx as never);
    expect(registered[NS]).toBeDefined();
    expect(registered[LEGACY_NS]).toBeDefined();
  });

  it("registers plugins.bundle.config for all 3 package aliases", () => {
    const bundleRegistrations: Array<{
      entry: Record<string, unknown>;
      component: unknown;
    }> = [];
    const dockRegistrations: Array<{
      entry: Record<string, unknown>;
      component: unknown;
    }> = [];
    const inputRegistrations: Array<{
      entry: Record<string, unknown>;
      component: unknown;
    }> = [];

    const snapshot = {
      base: {},
      revision: 1,
      status: "ready",
      user: {},
      value: {},
      writable: true,
    };

    const ctx = {
      configForms: {
        get: () => ({
          getSnapshot: () => snapshot,
          mutate: async () => true,
          subscribe: () => () => {},
        }),
        whileServed: (_namespaces: string[], fn: () => void) => fn(),
      },
      effect: (fn: () => unknown) => fn(),
      locale: {
        bind: () => (k: string) => k,
        register: () => () => {},
      },
      inject: (_deps: string[], callback: (scope: unknown) => unknown) =>
        callback(ctx),
      slots: {
        inject: (name: string, fn: () => void) => fn(),
        register: (entry: Record<string, unknown>, component: unknown) => {
          if (entry.name === "plugins.bundle.config") {
            bundleRegistrations.push({ entry, component });
          } else if (entry.name === "conversation.input.right") {
            inputRegistrations.push({ entry, component });
          } else if (entry.name === "conversation.composer.dock") {
            dockRegistrations.push({ entry, component });
          }
        },
      },
    };

    apply(ctx as never);

    expect(bundleRegistrations).toHaveLength(3);
    const keys = bundleRegistrations.map((r) => r.entry.key);
    expect(keys).toContain(PKG);
    expect(keys).toContain(SCOPED_PKG);
    // The deprecated wrapper is a package, not a page key this bundle answers
    // to — registering it meant the CURRENT scoped name had no card at all.
    expect(keys).not.toContain("@viztor/dsh-opencode");
    expect(keys).toContain(LEGACY_NS);

    expect(inputRegistrations).toHaveLength(1);
    expect(inputRegistrations[0]?.entry.order).toBe(50);
    expect(inputRegistrations[0]?.entry.id).toBe("dsh-opencode-patch-usage");

    // The meter registers in exactly ONE slot — `conversation.input.right`, the
    // seat beside the model selector. It must not also take the dock: both slots
    // render, so a second registration draws two identical meters.
    expect(dockRegistrations).toHaveLength(0);
  });

  it("unregisters every alias when the plugin unloads", () => {
    // The registrations above are only half the contract: a reload (or a profile
    // edit that restarts the entry) tears the bundle down, and the card must go
    // with it. Nothing asserted the disposers, so a card that outlived its
    // plugin — three registrations from one entry — was possible.
    const disposed: string[] = [];
    const stopped: string[] = [];
    const entries: Record<string, unknown>[] = [];
    let teardown: (() => void) | undefined;

    const ctx = {
      configForms: {
        get: () => ({
          getSnapshot: () => ({
            base: {},
            revision: 1,
            status: "ready",
            user: {},
            value: {},
            writable: true,
          }),
          mutate: async () => true,
          subscribe: () => () => {},
        }),
        whileServed: (_namespaces: string[], fn: () => void) => fn(),
      },
      effect: (fn: () => unknown, name?: string) => {
        const dispose = fn();
        // Only the card's effect, not the form subscription's.
        if (name === "dsh-opencode-patch: settings") {
          teardown = dispose as () => void;
        }
        return dispose;
      },
      locale: {
        bind: () => (k: string) => k,
        register: () => () => {},
      },
      inject: (_deps: string[], callback: (scope: unknown) => unknown) =>
        callback(ctx),
      slots: {
        // Faithful to a host that owns the registration's lifetime: the stop it
        // hands back also runs the disposer the registrar returned.
        inject: (name: string, fn: () => unknown) => {
          const disposeRegistration = fn();
          return () => {
            stopped.push(name);
            if (typeof disposeRegistration === "function") {
              (disposeRegistration as () => void)();
            }
          };
        },
        register: (entry: Record<string, unknown>) => {
          entries.push(entry);
          return () => {
            disposed.push(String(entry.key));
          };
        },
      },
    };

    apply(ctx as never);
    expect(disposed).toHaveLength(0);

    // What the card's registration hands the host when it mounts: the store hook
    // plus the four form actions. Asserted here because nothing else calls it —
    // the card renders in a browser, and the registration object does not.
    const card = entries.find(
      (entry) => entry.name === "plugins.bundle.config"
    );
    const mount = (card?.inject as () => Record<string, unknown>)?.();
    expect(Object.keys(mount?.hooks as object)).toEqual(["opencodeCard"]);
    for (const action of ["discard", "edit", "resetField", "save"]) {
      expect(typeof mount?.[action]).toBe("function");
    }

    teardown?.();

    expect(disposed).toEqual([PKG, SCOPED_PKG, LEGACY_NS]);
    expect(stopped).toEqual(["plugins.bundle.config"]);
  });

  it("handles usage injector logic and remote reading", async () => {
    let dockInjector: ((sessionId: unknown) => unknown) | undefined;
    const remoteUsage = vi
      .fn()
      .mockResolvedValue({ ok: true, value: { test: 123 } });

    // Mutable so the switch at the end of this test is actually PERFORMED. It
    // used to hand out zh unconditionally, which is why a dictionary captured at
    // construction went unnoticed: the test asserted the language but never
    // changed it, while its own comment claimed the switch worked.
    const localeState = { active: "zh" };

    const ctx = {
      effect: (fn: () => unknown) => fn(),
      modelDirectories: {
        directoryFor: (id: unknown) =>
          id === "valid" ? { store: { isDirectory: true } } : undefined,
      },
      remote: {
        opencodeGoUsage: {
          read: remoteUsage,
        },
      },
      // The active locale is read PER CALL, so the meter can follow a switch:
      // hand out zh here and the next render is Chinese, with no reload.
      locale: {
        bind: () => (key: string) => key,
        register: () => () => {},
        getLocale: () => ({ active: localeState.active, revision: 1 }),
      },
      inject: (_deps: string[], callback: (scope: unknown) => unknown) =>
        callback(ctx),
      slots: {
        inject: (_name: string, fn: () => void) => fn(),
        register: (entry: Record<string, unknown>) => {
          if (entry.name === "conversation.input.right") {
            dockInjector = entry.inject as (s: unknown) => unknown;
          }
        },
      },
    };

    apply(ctx as never);
    expect(dockInjector).toBeDefined();

    // Invalid session ID returns null
    expect(dockInjector?.("invalid")).toMatchObject({
      reason: expect.any(String),
    });

    // Valid session ID returns injected props
    const injected = dockInjector?.("valid") as {
      directory: unknown;
      meterProviders: string[];
      readUsage: () => Promise<unknown>;
      getLocale: () => string | undefined;
      t: (k: string) => string;
    };
    expect(injected).toBeDefined();
    expect(injected.directory).toEqual({ isDirectory: true });
    // No scope in this context: the meter falls back to the claimed routes.
    expect(injected.meterProviders).toEqual(["opencode", "opencode-go"]);

    const val = await injected.readUsage();
    expect(val).toEqual({ test: 123 });
    // No `locale` service in this context: the meter's translator falls back to
    // the English dictionary rather than echoing a key — the bundle ships its
    // own dictionaries, so a missing locale service costs the language, not the
    // copy. A key nobody wrote would still echo, as the last resort.
    // zh is active, so the lookup reads the bundle's own zh dictionary — not a
    // shared namespace a stale bundle could hold.
    expect(injected.t("usageTitle")).toBe("OpenCode Go 用量");
    expect(injected.t("keyNoOneWrote")).toBe("keyNoOneWrote");

    // The switch the comment above describes, actually performed. `t` is built
    // ONCE — it is a prop — so a dictionary captured at construction would keep
    // answering Chinese here while the panel's `locale`, which feeds `Intl` for
    // the dates and durations, moved to English: one row, two languages.
    localeState.active = "en";
    expect(injected.t("usageTitle")).toBe("OpenCode Go usage");
    localeState.active = "zh";
    expect(injected.t("usageTitle")).toBe("OpenCode Go 用量");

    // The same switch must move the `Intl` locale, and that is a SEPARATE prop:
    // `t` selects the words, `getLocale` feeds every date and duration. Wiring
    // only `t` left the numbers in the browser's own locale, so a Chinese panel
    // read `4h 59m后重置` and `Nov 7 at 8:55 AM重置` — one row, two languages,
    // with the English half coming from the machine rather than the harness.
    expect(injected.getLocale()).toBe("zh");
    localeState.active = "en";
    expect(injected.getLocale()).toBe("en");
    localeState.active = "zh";
    expect(injected.getLocale()).toBe("zh");
  });

  it("boots with no services at all, and tears down cleanly", () => {
    // Every service is optional in the type, and the Host really does boot
    // without some of them. Nothing asserted the empty case, so an
    // over-eager `ctx.locale.register(...)` would throw during boot — before any
    // of the tests that do supply a context could run.
    const teardowns: (() => void)[] = [];
    const ctx = {
      effect: (fn: () => unknown) => {
        const dispose = fn();
        if (typeof dispose === "function") {
          teardowns.push(dispose as () => void);
        }
        return dispose;
      },
    };

    (globalThis as Record<string, unknown>).__rootCtx = ctx;
    (globalThis as Record<string, unknown>).__rootCtx = ctx;
    expect(() => apply(ctx as never)).not.toThrow();
    // Every effect the entry registered handed back a disposer, and each one
    // runs without throwing on a context that has nothing to dispose.
    expect(teardowns.length).toBeGreaterThan(0);
    for (const teardown of teardowns) {
      expect(() => teardown()).not.toThrow();
    }
  });

  it("sends the provider and conversation id with every usage read", async () => {
    let dockInjector: ((sessionId: unknown) => unknown) | undefined;
    const remoteUsage = vi
      .fn()
      .mockResolvedValue({ ok: true, value: { test: 1 } });

    const ctx = {
      effect: (fn: () => unknown) => fn(),
      modelDirectories: { directoryFor: () => ({ store: {} }) },
      remote: { opencodeGoUsage: { read: remoteUsage } },
      inject: (_deps: string[], callback: (scope: unknown) => unknown) =>
        callback(ctx),
      slots: {
        inject: (_name: string, fn: () => void) => fn(),
        register: (entry: Record<string, unknown>) => {
          if (entry.name === "conversation.input.right") {
            dockInjector = entry.inject as (s: unknown) => unknown;
          }
        },
      },
    };

    apply(ctx as never);
    const injected = dockInjector?.("session-xyz") as {
      readUsage: (provider?: string, model?: string) => Promise<unknown>;
    };

    // All three matter: the provider picks the route/account, the session id
    // stops two open conversations from reading one total, and the model lets
    // the Host price the rate for what the picker is ON — the snapshot alone
    // describes the model that ran the last turn.
    await injected.readUsage("opencode-go", "mimo-v2.6-flash-free");
    expect(remoteUsage).toHaveBeenLastCalledWith({
      model: "mimo-v2.6-flash-free",
      provider: "opencode-go",
      sessionId: "session-xyz",
    });

    // An unnamed provider or model omits the key rather than sending "".
    await injected.readUsage();
    expect(remoteUsage).toHaveBeenLastCalledWith({ sessionId: "session-xyz" });
    await injected.readUsage("", "");
    expect(remoteUsage).toHaveBeenLastCalledWith({ sessionId: "session-xyz" });
  });

  it("hides the meter when the Host serves no usage service", () => {
    // The Host registers `opencodeGoUsage` only while Usage Quota Tracking is
    // on, so an absent service is how "switched off" reaches the client. The
    // injector returning null means the slot renders nothing at all, rather
    // than an unavailable meter the user cannot act on.
    let dockInjector: ((sessionId: unknown) => unknown) | undefined;

    const ctx = {
      effect: (fn: () => unknown) => fn(),
      modelDirectories: {
        directoryFor: () => ({ store: {} }),
      },
      inject: (_deps: string[], callback: (scope: unknown) => unknown) =>
        callback(ctx),
      slots: {
        inject: (_name: string, fn: () => void) => fn(),
        register: (entry: Record<string, unknown>) => {
          if (entry.name === "conversation.input.right") {
            dockInjector = entry.inject as (s: unknown) => unknown;
          }
        },
      },
    };

    apply(ctx as never);
    expect(dockInjector).toBeDefined();
    // The entry still mounts; it contributes a diagnostic reason and no meter.
    expect(dockInjector?.("session")).toMatchObject({
      reason: expect.stringContaining("no usage service"),
    });
  });

  it("reports the namespace when cordis refuses the access rather than throwing", () => {
    // The other half of the same guard. An undeclared namespace THROWS on
    // property access, and an optional chain cannot catch it - which is the
    // error the reporter's screenshot showed, and why the meter never appeared
    // for a signed-in Go account.
    let dockInjector: ((sessionId: unknown) => unknown) | undefined;
    const ctx = {
      effect: (fn: () => unknown) => fn(),
      modelDirectories: {
        directoryFor: () => ({ store: {} }),
      },
      inject: (_deps: string[], callback: (scope: unknown) => unknown) =>
        callback(ctx),
      remote: new Proxy(
        {},
        {
          get: (_target, prop) => {
            if (prop === "opencodeGoUsage") {
              throw new TypeError(
                'cannot get property "remote.opencodeGoUsage" without inject'
              );
            }
          },
        }
      ),
      slots: {
        inject: (_name: string, fn: () => void) => fn(),
        register: (entry: Record<string, unknown>) => {
          if (entry.name === "conversation.input.right") {
            dockInjector = entry.inject as (s: unknown) => unknown;
          }
        },
      },
    };

    expect(() => apply(ctx as never)).not.toThrow();
    // The entry still mounts, and the read says why rather than disappearing.
    expect(dockInjector?.("session")).toMatchObject({
      reason: expect.stringContaining("no usage service"),
    });
  });

  it("registers the meter once per slot registry, so a second activation cannot throw", () => {
    // The host may run a plugin's client entry more than once in a page's life.
    // The slot registry THROWS on a duplicate id
    //   list slot "conversation.input.right" already has an entry with id
    //   "dsh-opencode-patch-usage"
    // and that throw happened inside a render — a meter that vanishes rather
    // than one that says why. The guard used to be a per-`apply` boolean, which
    // reset on the second run and let the duplicate through.
    // Attempts, not successes: the guard and the try/catch are different
    // defences, and only the guard stops the second call from happening at all.
    const attempts: string[] = [];
    const registered: string[] = [];
    const slots = {
      inject: (_name: string, fn: () => void) => fn(),
      register: (entry: Record<string, unknown>) => {
        const id = String(entry.id);
        attempts.push(id);
        if (registered.includes(id)) {
          throw new TypeError(
            `list slot "conversation.input.right" already has an entry with id ${id}`
          );
        }
        registered.push(id);
      },
    };
    const ctx: Record<string, unknown> = {
      effect: (fn: () => unknown) => fn(),
      inject: (_deps: string[], callback: (scope: unknown) => unknown) =>
        callback(ctx),
      modelDirectories: { directoryFor: () => ({ store: {} }) },
      remote: {
        opencodeGoUsage: { read: async () => ({ ok: true, value: {} }) },
      },
      slots,
    };

    expect(() => apply(ctx as never)).not.toThrow();
    // The second activation is the case that used to throw.
    expect(() => apply(ctx as never)).not.toThrow();
    expect(registered).toEqual(["dsh-opencode-patch-usage"]);
    // And it was never even ATTEMPTED twice: a try/catch alone would hide the
    // duplicate, and hiding it is not the same as not making it.
    expect(attempts).toEqual(["dsh-opencode-patch-usage"]);
  });

  it("registers the meter even when the inject deps never resolve", () => {
    // `ctx.inject` is a HARD gate: the callback runs only once ALL of the named
    // services exist. A host that mounts no remote face never satisfies it, and
    // the meter is then absent with nothing to tell that from a host that serves
    // no usage service. The documented second path is a bounded fallback that
    // registers anyway so the read can report its own reason; the comment still
    // described it while the code had lost it.
    vi.useFakeTimers();
    try {
      const registered: string[] = [];
      const ctx = {
        effect: (fn: () => unknown) => {
          fn();
        },
        // Never calls back: the gate stays closed.
        inject: () => {
          /* the gate stays closed */
        },
        modelDirectories: { directoryFor: () => ({ store: {} }) },
        remote: {},
        slots: {
          inject: (_name: string, fn: () => void) => {
            fn();
          },
          register: (entry: Record<string, unknown>) => {
            registered.push(String(entry.id));
          },
        },
      };

      apply(ctx as never);
      expect(registered).toHaveLength(0);

      vi.advanceTimersByTime(10_000);
      expect(registered).toEqual(["dsh-opencode-patch-usage"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("registers once even when inject hands a CHILD scope and the mount hands the root", async () => {
    // The exact console failure, measured in a browser after the previous guard:
    //
    //   list slot "conversation.input.right" already has an entry with id
    //   "dsh-opencode-patch-usage" at priority 0 (registered by registerMeter)
    //
    // The scoped inject passes a CHILD scope; the mount-ready path and the
    // ten-second fallback pass the ROOT `ctx`. A guard keyed on the argument
    // therefore sees two different objects, both pass, and the host throws on the
    // duplicate. Keyed on the root context it sees one.
    // Attempts, not successes: the try/catch swallows the duplicate, so only the
    // attempt count shows whether the guard held.
    const attempts: string[] = [];
    const registrations: string[] = [];
    const slots = {
      inject: (_name: string, fn: () => void) => {
        fn();
      },
      register: (entry: Record<string, unknown>) => {
        const id = String(entry.id);
        attempts.push(id);
        if (registrations.includes(id)) {
          throw new TypeError(
            `list slot "conversation.input.right" already has an entry with id ${id}`
          );
        }
        registrations.push(id);
      },
    };
    // A child scope with its OWN `slots` facade over the same underlying
    // registry. That is the shape that broke the previous guard: the facade object
    // differs, so a guard keyed on the argument sees two registries where the host
    // has one — and both pass, and the host throws on the duplicate.
    const childSlots = {
      inject: (_name: string, fn: () => void) => {
        fn();
      },
      register: (entry: Record<string, unknown>) => {
        slots.register(entry);
      },
    };
    const childScope = {
      modelDirectories: { directoryFor: () => ({ store: {} }) },
      remote: {
        opencodeGoUsage: { read: async () => ({ ok: true, value: {} }) },
      },
      slots: childSlots,
    };
    const ctx: Record<string, unknown> = {
      effect: (fn: () => unknown) => fn(),
      inject: (_deps: string[], callback: (scope: unknown) => unknown) =>
        callback(childScope),
      modelDirectories: { directoryFor: () => ({ store: {} }) },
      remote: {
        $mount: async () => () => {
          /* disposer */
        },
        opencodeGoUsage: { read: async () => ({ ok: true, value: {} }) },
      },
      slots,
    };

    (globalThis as Record<string, unknown>).__rootCtx = ctx;
    expect(() => apply(ctx as never)).not.toThrow();
    // Let the mount's `ready` promise settle — it awaits `$mount` inside an async
    // IIFE, so microtasks alone are not enough. A macrotask flushes the chain,
    // which is the second caller.
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
    expect(registrations).toEqual(["dsh-opencode-patch-usage"]);
    // And it was never ATTEMPTED twice — which is what the host logs as an Error.
    expect(attempts).toEqual(["dsh-opencode-patch-usage"]);
  });

  it("degrades to no meter when the model-directory service throws", () => {
    // `directoryFor` throws for a session it cannot resolve yet (a composer
    // rendered before its session is bound). The injector must swallow that
    // rather than take the whole dock slot down with it.
    let dockInjector: ((sessionId: unknown) => unknown) | undefined;

    const ctx = {
      effect: (fn: () => unknown) => fn(),
      modelDirectories: {
        directoryFor: () => {
          throw new Error("ui-model-selection: resolved no scope");
        },
      },
      remote: {
        opencodeGoUsage: { read: async () => ({ ok: true, value: {} }) },
      },
      inject: (_deps: string[], callback: (scope: unknown) => unknown) =>
        callback(ctx),
      slots: {
        inject: (_name: string, fn: () => void) => fn(),
        register: (entry: Record<string, unknown>) => {
          if (entry.name === "conversation.input.right") {
            dockInjector = entry.inject as (s: unknown) => unknown;
          }
        },
      },
    };

    expect(() => apply(ctx as never)).not.toThrow();
    expect(dockInjector).toBeDefined();
    expect(dockInjector?.("session")).toMatchObject({
      reason: expect.any(String),
    });
  });

  it("resolves the model directory from the injected scope, not the root context", () => {
    // The bug this pins: `ctx.modelDirectories` read off the ROOT context is
    // undefined, so the injector bailed and the meter never mounted — silently,
    // because every access was optional. Both services arrive on the scope
    // `ctx.inject` hands over (`ui-model-selection` uses the same idiom), so the
    // root context here carries neither.
    let dockInjector: ((sessionId: unknown) => unknown) | undefined;
    const injectedScope = {
      modelDirectories: {
        directoryFor: () => ({ store: { isDirectory: true } }),
      },
      remote: { opencodeGoUsage: { read: async () => ({ ok: true }) } },
      slots: {
        inject: (_name: string, fn: () => void) => fn(),
        register: (entry: Record<string, unknown>) => {
          if (entry.name === "conversation.input.right") {
            dockInjector = entry.inject as (s: unknown) => unknown;
          }
        },
      },
    };
    const ctx = {
      effect: (fn: () => unknown) => fn(),
      inject: (_deps: string[], callback: (scope: unknown) => unknown) =>
        callback(injectedScope),
      locale: {
        bind: () => (k: string) => k,
        register: () => () => {},
      },
    };

    apply(ctx as never);

    expect(dockInjector).toBeDefined();
    expect(dockInjector?.("valid")).not.toBeNull();
  });

  it("unwraps the remote envelope, throwing the error a failed read carries", async () => {
    // The Host wraps every read in {ok, value | error}; the meter's readUsage
    // is the unwrap. Each shape below is a branch a client can hit.
    let dockInjector: ((sessionId: unknown) => unknown) | undefined;
    const responses: unknown[] = [
      { ok: false, error: new Error("the gateway said no") },
      { ok: false },
      { notAnEnvelope: true },
    ];
    const ctx = {
      effect: (fn: () => unknown) => fn(),
      modelDirectories: { directoryFor: () => ({ store: {} }) },
      remote: {
        opencodeGoUsage: {
          read: async () => responses.shift(),
        },
      },
      slots: {
        inject: (_name: string, fn: () => void) => fn(),
        register: (entry: Record<string, unknown>) => {
          if (entry.name === "conversation.input.right") {
            dockInjector = entry.inject as (s: unknown) => unknown;
          }
        },
      },
    };
    apply(ctx as never);
    const injected = dockInjector?.("valid") as {
      readUsage: () => Promise<unknown>;
    };
    expect(injected).toBeDefined();

    // A typed failure propagates as the throw the pill parses.
    await expect(injected.readUsage()).rejects.toThrow("the gateway said no");
    // An error-less failure throws undefined — which parseFailure renders as the
    // generic unavailable message rather than crash.
    await expect(injected.readUsage()).rejects.toBeUndefined();
    // A non-envelope answer passes through untouched: the pill's parseFailure
    // decides what it means.
    await expect(injected.readUsage()).resolves.toEqual({
      notAnEnvelope: true,
    });
  });

  it("passes the claimed provider routes from the scope to the injector", () => {
    let dockInjector: ((sessionId: unknown) => unknown) | undefined;

    const ctx = {
      configForms: {
        get: () => ({
          getSnapshot: () => ({
            base: {},
            revision: 1,
            status: "ready",
            user: {},
            value: {
              usageModelMarkers: ["custom-go-model"],
              providers: ["custom-go-route"],
            },
            writable: true,
          }),
          mutate: async () => true,
          subscribe: () => () => {},
        }),
        whileServed: (_namespaces: string[], fn: () => void) => fn(),
      },
      effect: (fn: () => unknown) => fn(),
      modelDirectories: {
        directoryFor: () => ({ store: { isDirectory: true } }),
      },
      remote: {
        opencodeGoUsage: {
          read: async () => ({ ok: true, value: {} }),
        },
      },
      inject: (_deps: string[], callback: (scope: unknown) => unknown) =>
        callback(ctx),
      slots: {
        inject: (_name: string, fn: () => void) => fn(),
        register: (entry: Record<string, unknown>) => {
          if (entry.name === "conversation.input.right") {
            dockInjector = entry.inject as (s: unknown) => unknown;
          }
        },
      },
    };

    apply(ctx as never);
    const injected = dockInjector?.("valid") as {
      meterProviders: string[];
    };
    expect(injected.meterProviders).toEqual(["custom-go-route"]);
  });

  it("unpacks remote errors properly in readUsage", async () => {
    let dockInjector: ((sessionId: unknown) => unknown) | undefined;
    const remoteUsage = vi.fn().mockResolvedValue({
      ok: false,
      error: new Error("Rate limit exceeded"),
    });

    const ctx = {
      effect: (fn: () => unknown) => fn(),
      modelDirectories: {
        directoryFor: () => ({ store: {} }),
      },
      remote: {
        opencodeGoUsage: {
          read: remoteUsage,
        },
      },
      inject: (_deps: string[], callback: (scope: unknown) => unknown) =>
        callback(ctx),
      slots: {
        inject: (_name: string, fn: () => void) => fn(),
        register: (entry: Record<string, unknown>) => {
          if (entry.name === "conversation.input.right") {
            dockInjector = entry.inject as (s: unknown) => unknown;
          }
        },
      },
    };

    apply(ctx as never);
    const injected = dockInjector?.("valid") as {
      readUsage: () => Promise<unknown>;
    };

    await expect(injected.readUsage()).rejects.toThrow("Rate limit exceeded");
  });

  it("degrades gracefully if configForms is missing or not a valid scope", () => {
    const ctx = {
      effect: (fn: () => unknown) => fn(),
      inject: (_deps: string[], callback: (scope: unknown) => unknown) =>
        callback(ctx),
      slots: {
        inject: vi.fn(),
        register: vi.fn(),
      },
    };

    expect(() => apply(ctx as never)).not.toThrow();
  });
});

describe("settings-page: OpencodeCard rendering", () => {
  const mountCard = () => {
    let cardComponent:
      | ((props: Record<string, unknown>) => unknown)
      | undefined;
    const snapshot = {
      base: {},
      revision: 1,
      status: "ready",
      user: {},
      value: {
        injectUserAgent: true,
        usageEnabled: true,
      },
      writable: true,
    };

    const ctx = {
      configForms: {
        get: () => ({
          getSnapshot: () => snapshot,
          mutate: async () => true,
          subscribe: () => () => {},
        }),
        whileServed: (_namespaces: string[], fn: () => void) => fn(),
      },
      effect: (fn: () => unknown) => fn(),
      locale: {
        bind: () => (k: string) => k,
        register: () => () => {},
      },
      inject: (_deps: string[], callback: (scope: unknown) => unknown) =>
        callback(ctx),
      slots: {
        inject: (_name: string, fn: () => void) => fn(),
        register: (entry: Record<string, unknown>, component: unknown) => {
          if (entry.key === PKG) {
            cardComponent = component as (
              props: Record<string, unknown>
            ) => unknown;
          }
        },
      },
    };

    apply(ctx as never);
    assert.ok(cardComponent, "card component registered");
    return cardComponent;
  };

  it("renders summary view as the description string", () => {
    const Card = mountCard();
    const result = Card({
      view: "summary",
      t: (k: string) => `translated:${k}`,
    }) as {
      props: { children: unknown };
    };
    expect(result.props.children).toBe("translated:description");
  });

  it("renders page view with SettingsForm and all configuration fields", () => {
    const Card = mountCard();
    const edits: Array<{ field: string; text: string }> = [];
    const resets: string[] = [];
    const saveMock = vi.fn();
    const discardMock = vi.fn();

    const state = {
      fields: {
        injectUserAgent: { invalid: false, overridden: true, text: "true" },
        providers: {
          invalid: false,
          overridden: false,
          text: "opencode, opencode-go",
        },
        usageBaseURL: {
          invalid: false,
          overridden: false,
          text: "https://opencode.ai/zen/go/v1",
        },
        usageEnabled: { invalid: false, overridden: false, text: "true" },
      },
      shell: {
        available: true,
        dirty: false,
        failed: false,
        invalid: false,
        saving: false,
        writable: true,
      },
    };

    const tree = Card({
      discard: discardMock,
      edit: (field: string, text: string) => edits.push({ field, text }),
      resetField: (field: string) => resets.push(field),
      save: saveMock,
      t: (k: string) => k,
      useOpencodeCard: (selector: (s: typeof state) => unknown) =>
        selector(state),
      view: "page",
    });

    const form = firstOf(tree, "SettingsForm");
    expect(form).toBeDefined();

    // Every register entry renders exactly one control: booleans as
    // SettingsBooleanField (with Switch inside), the enum as SettingsChoiceField.
    const boolFields = findAll(tree, "SettingsBooleanField");
    const choiceFields = findAll(tree, "SettingsChoiceField");
    const valueFields = findAll(tree, "SettingsValueField");
    expect(boolFields.length + choiceFields.length + valueFields.length).toBe(
      CARD_FIELDS.length
    );
    // The card shows only the decisions a user makes — 7 toggles and 2 enums.
    // Every literal/marker override is config-only (see CONFIG_ONLY_FIELDS), so
    // no text or list field renders at all.
    // Seven booleans: the meter's own switch is one, and there is no nested
    // price switch inside it.
    expect(boolFields.length).toBe(7);
    expect(choiceFields.length).toBe(2);
    expect(valueFields.length).toBe(0);
    const choiceFieldsById = new Map(
      choiceFields.map((field) => [String(field.props.id), field])
    );
    const choiceField = choiceFieldsById.get(
      "plugin-config-opencode-keySource"
    );
    assert.ok(choiceField, "expected a keySource SettingsChoiceField");
    // The enum's choices are copy-resolved before they reach the control.
    expect(
      (choiceField.props.options as { label: string; value: string }[]).map(
        (option) => option.value
      )
    ).toEqual([...KEY_SOURCE_POLICIES]);
    // The endpoint family's choices, from the same table `config-values` exports.
    const endpointField = choiceFieldsById.get(
      "plugin-config-opencode-endpoint"
    );
    assert.ok(endpointField, "expected an endpoint SettingsChoiceField");
    expect(
      (endpointField.props.options as { label: string; value: string }[]).map(
        (option) => option.value
      )
    ).toEqual([...ENDPOINT_FAMILIES]);

    // No config-only knob may appear as a control: the simplified UI has to stay
    // simplified, and an override must not become editable by accident.
    const renderedIds = [...boolFields, ...choiceFields].map((f) => f.props.id);
    for (const { field } of CONFIG_ONLY_FIELDS) {
      expect(renderedIds).not.toContain(`plugin-config-opencode-${field}`);
    }

    // Test boolean field edit, addressed by id rather than by position: the
    // render order is the card's own decision, and a positional read breaks the
    // moment a field moves between sections.
    const userAgentField = boolFields.find(
      (field) => field.props.id === "plugin-config-opencode-injectUserAgent"
    );
    assert.ok(
      userAgentField,
      "expected an injectUserAgent SettingsBooleanField"
    );
    const onBoolEdit = userAgentField.props.onEdit as (text: string) => void;
    onBoolEdit("false");
    expect(edits).toContainEqual({ field: "injectUserAgent", text: "false" });

    // Test enum edit: the select stages the raw option value.
    const onChoiceEdit = choiceField.props.onEdit as (text: string) => void;
    onChoiceEdit("request");
    expect(edits).toContainEqual({ field: "keySource", text: "request" });

    // Test reset callback
    const onReset = userAgentField.props.onReset as () => void;
    onReset();
    expect(resets).toContain("injectUserAgent");
  });

  it("disables fields when writable is false", () => {
    const Card = mountCard();

    const state = {
      fields: {},
      shell: {
        available: true,
        dirty: false,
        failed: false,
        invalid: false,
        saving: false,
        writable: false,
      },
    };

    const tree = Card({
      discard: () => {},
      edit: () => {},
      resetField: () => {},
      save: () => {},
      t: (k: string) => k,
      useOpencodeCard: (selector: (s: typeof state) => unknown) =>
        selector(state),
      view: "page",
    });

    const valueFields = findAll(tree, "SettingsValueField");
    for (const f of valueFields) {
      expect(f.props.disabled).toBe(true);
    }
    const boolFields = findAll(tree, "SettingsBooleanField");
    for (const f of boolFields) {
      expect(f.props.disabled).toBe(true);
    }
  });

  const renderPage = (Card: ReturnType<typeof mountCard>) => {
    const state = {
      fields: {},
      shell: {
        available: true,
        dirty: false,
        failed: false,
        invalid: false,
        saving: false,
        writable: true,
      },
    };
    return Card({
      discard: () => {},
      edit: () => {},
      resetField: () => {},
      save: () => {},
      t: (k: string) => k,
      useOpencodeCard: (selector: (s: typeof state) => unknown) =>
        selector(state),
      view: "page",
    });
  };

  it("renders one control per register entry, in register order", () => {
    const tree = renderPage(mountCard());
    const controls = controlsInOrder(tree);

    // The card's field list is the register's, so it cannot drift again.
    expect(controls.map((f) => f.props.id)).toEqual(
      CARD_FIELDS.map((entry) => `plugin-config-opencode-${entry.field}`)
    );
    // The control kind follows the register's `kind`, not a second list.
    expect(controls.map((f) => elementName(f.type))).toEqual(
      CARD_FIELDS.map((entry) => COMPONENT_BY_KIND[entry.kind])
    );
    // Labels come from the register's copy keys, through the card's translator,
    // so the two cannot disagree. The mock seat translates nothing (it returns
    // the key), which is why this also pins the bundle fallback: a control whose
    // copy the seat cannot render must still reach the screen as words.
    expect(controls.map((f) => f.props.label)).toEqual(
      CARD_FIELDS.map((entry) => en[entry.labelKey])
    );
  });

  it("offers exactly the key-source policies the host accepts", () => {
    // The select's values and the config enum are two lists in two modules; a
    // value offered here but not accepted there would be silently coerced back
    // to the default on save.
    const entry = CARD_FIELDS.find((field) => field.field === "keySource");
    assert.ok(entry, "expected a keySource register entry");
    expect(entry.kind).toBe("select");
    expect((entry.options ?? []).map((option) => option.value)).toEqual([
      ...KEY_SOURCE_POLICIES,
    ]);
  });

  it("renders the documented enrichModels switch", () => {
    // Regression guard: it was declared in the spec register and translated
    // (en + zh) but omitted from the card's hand-written JSX, so the switch
    // documented in the README could not be reached from the UI.
    const ids = controlsInOrder(renderPage(mountCard())).map((f) => f.props.id);
    expect(ids).toContain("plugin-config-opencode-enrichModels");
  });

  it("renders one heading per group, in register order", () => {
    const headings = findAll(renderPage(mountCard()), "GroupHeading");
    const groups = [...new Set(CARD_FIELDS.map((entry) => entry.group))];
    expect(headings).toHaveLength(groups.length);
    expect(headings.map((heading) => heading.props.label)).toEqual(
      groups.map((group) => en[group])
    );
    // Only the first heading drops the separator rule.
    expect(headings.map((heading) => heading.props.first)).toEqual(
      groups.map((_, index) => index === 0)
    );
  });

  it("wires each control's edit and reset back to the form model", () => {
    // The card hands the host an id, a label and two callbacks per control. The
    // ids and labels were asserted; the callbacks were not, so a control could
    // render perfectly and do nothing.
    const edit = vi.fn();
    const resetField = vi.fn();
    const state = {
      fields: {},
      shell: {
        available: true,
        dirty: false,
        failed: false,
        invalid: false,
        saving: false,
        writable: true,
      },
    };
    const Card = mountCard();
    const tree = Card({
      discard: () => {},
      edit,
      resetField,
      save: () => {},
      t: (k: string) => k,
      useOpencodeCard: (selector: (s: typeof state) => unknown) =>
        selector(state),
      view: "page",
    });

    const [first] = controlsInOrder(tree);
    const name = CARD_FIELDS[0]?.field ?? "";
    assert.ok(first, "expected at least one control");
    (first.props.onEdit as (text: string) => void)("draft");
    (first.props.onReset as () => void)();
    expect(edit).toHaveBeenCalledWith(name, "draft");
    expect(resetField).toHaveBeenCalledWith(name);
  });
});

describe("settings-page: field register", () => {
  it("derives SPECS from CARD_FIELDS in the same order", () => {
    expect(SPECS.map((s) => s.field)).toEqual(CARD_FIELDS.map((f) => f.field));
  });

  it("gives every register entry a usable draft conversion", () => {
    for (const entry of CARD_FIELDS) {
      const spec = SPECS.find((s) => s.field === entry.field);
      assert.ok(spec, `expected a spec for ${entry.field}`);
      expect(typeof spec.format).toBe("function");
      expect(typeof spec.parse).toBe("function");
    }
  });

  it("declares each field at most once", () => {
    const fields = CARD_FIELDS.map((entry) => entry.field);
    expect(new Set(fields).size).toBe(fields.length);
  });
});

describe("settings-page: field specs", () => {
  const specOf = (field: string) => {
    const found = SPECS.find((s) => s.field === field);
    assert.ok(found, `expected a spec for ${field}`);
    return found;
  };

  it("covers every field the card renders, in render order", () => {
    expect(SPECS.map((s) => s.field)).toEqual([
      "endpoint",
      "keySource",
      "readOpencodeStore",
      "injectUserAgent",
      "injectOriginHeaders",
      "injectProject",
      "enrichModels",
      "injectCoreTools",
      "usageEnabled",
    ]);
  });

  it("partitions the schema into card fields and config-only knobs", () => {
    // The card deliberately hides the override knobs, so the two lists must
    // together cover every schema key exactly once. A knob in neither would be
    // unreachable; a knob in both would contradict CONFIG_ONLY_FIELDS.
    //
    // The keys come from `Config.dict`, the schema's own field table.
    // `Config({})` materialises only the keys that carry a default or are
    // `.volatile()`, which is how `debugFile` (neither) went missing from both
    // lists without this test noticing.
    // oxlint-disable-next-line unicorn/no-array-sort -- `Object.keys` returns a fresh array, so in-place sort mutates nothing shared.
    const schemaKeys = Object.keys(Config.dict ?? {}).sort();
    expect(schemaKeys).toContain("debugFile");
    const cardFields = CARD_FIELDS.map((entry) => entry.field);
    const configOnly = CONFIG_ONLY_FIELDS.map((entry) => entry.field);
    const covered = [...cardFields, ...configOnly];

    // oxlint-disable-next-line unicorn/no-array-sort -- the spread above is a fresh array, so nothing shared is mutated.
    expect(covered.sort()).toEqual(schemaKeys);
    expect(new Set(covered).size).toBe(covered.length);
    for (const entry of CONFIG_ONLY_FIELDS) {
      expect(entry.reason.length).toBeGreaterThan(0);
    }
  });

  it("keeps each group's fields contiguous", () => {
    // The card inserts a heading wherever the group changes, so a field whose
    // group is not adjacent to its siblings would render the heading twice.
    const seen = new Set<string>();
    let previous: string | undefined;
    for (const entry of CARD_FIELDS) {
      if (entry.group !== previous) {
        expect(
          seen.has(entry.group),
          `${entry.field} reopens group ${entry.group} after it closed`
        ).toBe(false);
        seen.add(entry.group);
        previous = entry.group;
      }
    }
    expect(seen.size).toBeGreaterThan(1);
  });

  it("keeps the boolean kind on its stock semantics", () => {
    const inject = specOf("injectCoreTools");
    expect(inject.format(true)).toBe("true");
    expect(inject.format("not-a-boolean")).toBe("");
    expect(inject.parse("TRUE")).toEqual({ kind: "set", value: true });
    expect(inject.parse("")).toEqual({ kind: "clear" });
    expect(inject.parse("maybe")).toBeUndefined();
  });

  it("refuses a select draft outside the option set", () => {
    // The enum is the card's only non-boolean kind, so its conversion is the one
    // that must reject a value the schema would not accept.
    const source = specOf("keySource");
    expect(source.format("request")).toBe("request");
    expect(source.format(42)).toBe("");
    expect(source.parse("configured")).toEqual({
      kind: "set",
      value: "configured",
    });
    expect(source.parse("")).toEqual({ kind: "clear" });
    expect(source.parse("hand-edited")).toBeUndefined();
  });
});

describe("settings-page: every remote gets a mount", () => {
  // The bug this exists for: `loginRemote` was exported, tested on its own, and
  // never mounted by the page, so the card's `ctx.remote.opencodeLogin` did not
  // exist and the sign-in row rendered nothing - silently, because a missing
  // remote and a remote with nothing to say look identical from the outside.
  // Nothing asserted which remotes the page mounts, so nothing noticed.
  it("mounts one per surface the card reads, and no surface is left out", async () => {
    const mounted: { package?: string; descriptors: { service: string }[] }[] =
      [];
    const ctx = {
      effect: (fn: () => unknown) => fn(),
      remote: {
        $mount: async (contribution: unknown) => {
          mounted.push(
            contribution as {
              package?: string;
              descriptors: { service: string }[];
            }
          );
          return () => {};
        },
      },
    };

    apply(ctx as never);
    // The mount is async: `mountRemote` starts it and the effect returns the
    // disposer, so let the microtask queue drain before reading the list.
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });

    // Every namespace the CARD actually calls must be mounted here, or its
    // surface reports "unavailable" for a host that has the service — which is
    // exactly what the purge row did before its descriptor existed. The sign-in
    // row and its `opencodeLogin` namespace are v2 work: main carries the API key
    // path only, so nothing here should depend on a login service existing.
    const services = mounted.flatMap((contribution) =>
      contribution.descriptors.map((d) => d.service)
    );
    // `opencodeStore` is the inspection row's; it was the one left out.
    expect(services).toHaveLength(3);
    expect(new Set(services)).toEqual(
      new Set(["opencodeGoUsage", "opencodeModelPurge", "opencodeStore"])
    );
    expect(mounted).toHaveLength(1);
    expect(mounted[0]?.package).toBe("dsh-opencode-patch");
  });

  it("registers the meter when the mount settles, not on a service name that never appears", async () => {
    const injected: { slot: string; inject?: unknown }[] = [];
    const unmounts: (() => void)[] = [];
    // The scope the host hands the inject callback: a child that already sees
    // the three named services. Only `slots` matters here, because the injector
    // the slot registration returns is not called until the Host renders it.
    const scope = {
      slots: {
        inject: (slot: string) => {
          injected.push({ slot });
          return () => {};
        },
        register: (_entry: Record<string, unknown>) => () => {},
      },
    };
    const ctx = {
      effect: (fn: () => unknown) => {
        const dispose = fn();
        if (typeof dispose === "function") {
          unmounts.push(dispose as () => void);
        }
        return dispose;
      },
      inject: (deps: string[], cb: (scope: unknown) => unknown) => {
        // The scoped wait must NOT name the remote namespace: it is a child of
        // the Host remote face, not a service, so naming it waits forever — the
        // meter then only ever appeared through a ten-second timeout.
        expect(deps).not.toContain("remote.opencodeGoUsage");
        return cb(scope);
      },
      locale: { register: () => () => {} },
      remote: {
        $mount: async () => () => {},
      },
      slots: scope.slots,
    };

    apply(ctx as never);
    // Both paths call `registerMeter`: the scoped inject when the three named
    // services exist, and the mount's settlement. The second is a no-op, so the
    // slot is registered exactly once however many paths reach it.
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
    expect(injected.map((entry) => entry.slot)).toEqual([
      "conversation.input.right",
    ]);
    expect(unmounts.length).toBeGreaterThan(0);
    for (const unmount of unmounts) {
      unmount();
    }
  });

  it("reads the usage namespace through ctx.get, not the remote property", async () => {
    // Measured in a browser console, after the contribution mounted:
    //   property read: false; ctx.get('remote.opencodeGoUsage'): object
    //
    // `remote.<ns>` is a Cordis service property, so reading it needs the name in
    // `inject` — a hard gate that deadlocks when this same bundle is what mounts
    // it. The property read throws, the guard answers `undefined`, and the meter
    // reported "no usage service" for a service that was mounted and answering.
    // `ctx.get` does not consult `inject`, so it is the read that works.
    const usage = { read: async () => ({ ok: true, value: {} }) };
    const scope = {
      get: (name: string) =>
        name === "remote.opencodeGoUsage" ? usage : undefined,
      // The property read is REFUSED, exactly as Cordis refuses it.
      remote: new Proxy(
        {},
        {
          get: () => {
            throw new Error(
              'cannot get property "remote.opencodeGoUsage" without inject'
            );
          },
        }
      ),
    };
    expect(remoteNamespaceOf(scope, "opencodeGoUsage")).toBe(usage);
    // And the property path on its own really is unusable here.
    expect(remoteNamespace(scope.remote, "opencodeGoUsage")).toBeUndefined();
  });

  it("does not spend the one registration on a scope without `slots`", async () => {
    // The failure this guards: `registerMeter` is reached from three places, and
    // the mount's settlement hands over the ROOT context, which need not carry
    // `slots`. Marking the one-shot guard before the attempt meant a path that
    // could not register still consumed the registration — the scoped inject then
    // found the guard set and returned, and the pill never appeared anywhere.
    // `?.` swallowed the no-op, so nothing warned.
    const injected: string[] = [];
    const child = {
      slots: {
        inject: (slot: string) => {
          injected.push(slot);
          return () => {};
        },
        register: () => () => {},
      },
    };
    const ctx = {
      effect: (fn: () => unknown) => fn(),
      // The scoped inject fires AFTER the mount has settled, with a scope that
      // does carry `slots` — the ordering that used to lose the meter.
      inject: (_names: string[], cb: (scope: unknown) => void) => {
        setTimeout(() => {
          cb(child);
        }, 5);
        return () => {};
      },
      locale: { register: () => () => {} },
      remote: { $mount: async () => () => {} },
      // The root has no `slots` at all.
    };

    apply(ctx as never);
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });
    expect(injected).toEqual(["conversation.input.right"]);
  });

  it("registers the meter from the mount alone when the scoped inject never fires", async () => {
    // The case the ten-second timeout used to cover. `ctx.inject` is present but
    // its services never appear, so the ONLY way the meter can show up is the
    // mount settling — which is what the timeout used to stand in for.
    const injected: string[] = [];
    const ctx = {
      effect: (fn: () => unknown) => fn(),
      // Registered, never called: the Host has no model directory to hand over.
      inject: () => () => {},
      locale: { register: () => () => {} },
      remote: {
        // A mount that resolves on a later macrotask, so the settlement is
        // genuinely asynchronous rather than already done.
        $mount: async () => {
          await new Promise((resolve) => {
            setTimeout(resolve, 0);
          });
          return () => {};
        },
      },
      slots: {
        inject: (slot: string) => {
          injected.push(slot);
          return () => {};
        },
        register: (_entry: Record<string, unknown>) => () => {},
      },
    };

    apply(ctx as never);
    // Not yet: the mount has not settled.
    expect(injected).toEqual([]);
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
    expect(injected).toEqual(["conversation.input.right"]);
  });
});
