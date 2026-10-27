/**
 * The settings page: `apply`, its dictionaries and its slots.
 *
 * The card's rendering, the field register and the remote mounts are their
 * own files (`settings-page-card`, `settings-page-fields`,
 * `settings-page-remotes`).
 *
 * @module test/settings-page.test
 */
import { describe, expect, it, vi } from "vitest";

import {
  applySettingsPage as apply,
  LEGACY_NS,
  NS,
  PKG,
  SCOPED_PKG,
} from "./support/src.ts";

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
