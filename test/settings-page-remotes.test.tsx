/**
 * The settings page: every remote the card reads gets a client mount.
 *
 * @module test/settings-page-remotes.test
 */
import { describe, expect, it } from "vitest";

import {
  applySettingsPage as apply,
  remoteNamespace,
  remoteNamespaceOf,
} from "./support/src.ts";

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
