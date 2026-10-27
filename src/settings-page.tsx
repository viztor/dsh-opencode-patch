/**
 * `dsh-opencode-patch` settings page — DSH Web client bundle entry.
 *
 * Contributes a settings card under DSH Settings → Plugins and a quota pill in
 * the composer dock. Wiring only: copy lives in `settings-copy.ts`, the field
 * register in `settings-fields.ts`, presentation in `settings-card.tsx`. See
 * AGENTS.md for the module map.
 *
 * @module dsh-opencode-patch/settings-page
 */

import {
  SettingsFormModel,
  type SettingsFormScope,
} from "@deepseek-ai/dsh-client-ui-primitives";

import { DEFAULT_PROVIDERS, readStringList } from "./config-values.ts";
import { storeRemote } from "./opencode-store-contract.ts";
import { purgeRemote } from "./purge-contract.ts";
import { OpencodeCard } from "./settings-card.tsx";
import { en, withBundleCopy, zh, type CopyKey } from "./settings-copy.ts";
import { SPECS } from "./settings-fields.ts";
import { purgeDeprecatedModels } from "./settings-purge.ts";
import { remoteNamespace, remoteNamespaceOf } from "./settings-remote.ts";
import { inspectStore } from "./settings-store.ts";
import { readGoUsage } from "./settings-usage.tsx";
import { usageRemote } from "./usage-contract.ts";
import { UsagePill } from "./usage-pill.tsx";
import { isRecord } from "./utils/guards.ts";

// Re-exported so the field register stays reachable from the bundle entry.
export { SPECS };

export const NS = "dsh-opencode-patch";
export const LEGACY_NS = "dsh-opencode";

/**
 * The bundle's npm package name, spelled rather than imported.
 *
 * `plugins.bundle.config` entries are keyed by npm package name (not the
 * cordis row id), so this must equal `package.json`'s `name`. The client
 * half must not depend on the host half, hence the duplication.
 */
export const PKG = "dsh-opencode-patch";

/**
 * The plugin's remote contribution: the meter, under the package name `PKG`.
 *
 * It is a contribution rather than a bare descriptor list because Typert
 * enforces unique package names, and this is the one place the package is
 * registered. It carries every namespace the host mounts — the meter, the purge
 * and the store inspection — and `test/remote-contract.test.ts` fails when a
 * host service declares a method this list does not. The sign-in row and its
 * `opencodeLogin` namespace are v2 work.
 */
export const patchRemote = {
  // ONE contribution, TWO namespaces. Typert enforces a unique package name per
  // contribution, so mounting them separately with the same package throws
  // "already registered" and drops the remote entirely.
  descriptors: [
    ...usageRemote.descriptors,
    ...purgeRemote.descriptors,
    ...storeRemote.descriptors,
  ],
  package: PKG,
};

/**
 * The scoped npm name — published from this same tree, and the one a new
 * install gets. It must answer to the SAME pages as `PKG` or the settings card
 * never appears for whoever installed the name we tell them to. The retired
 * `@viztor/dsh-opencode` is deliberately absent: it is a deprecated wrapper
 * with no client half (see AGENTS.md, "Package vs component").
 */
export const SCOPED_PKG = "@viztor/dsh-opencode-patch";

/**
 * The services this bundle reaches. Cordis refuses access to one the caller has
 * not declared, and the check is on the NAME — so `remote.session` is its own
 * key, not a property of `remote`. `ModelDirectoryResolver.directoryFor` reads
 * it internally, which is why the meter threw
 * `cannot get property "remote.session" without inject` and rendered nothing.
 * The official client plugins declare it the same way
 * (ui-model-selection/src/client/index.ts:107).
 */
/**
 * Read a namespace off the host's remote face, or `undefined` when it is absent.
 *
 * The implementation lives in `settings-remote.ts` and is shared with the
 * settings card, which carried the same unguarded read after the meter was
 * fixed. See that module for why the guard has to exist at all: Cordis guards
 * property access by NAME and throws, and an optional chain cannot catch a
 * throw.
 */

export { remoteNamespace, remoteNamespaceOf } from "./settings-remote.ts";

/** The value a Remote result carries, or a thrown failure. */

/**
 * Mount one remote contribution, reporting why when it cannot.
 *
 * The two optional chains are the point: an absent `remote`, or a remote without
 * `$mount`, evaluates to undefined WITHOUT throwing, so a catch around the call
 * never runs and the surface simply renders nothing - indistinguishable from a
 * surface whose service answered nothing.
 *
 * `ready` settles when the mount is DONE, which is the one observable fact a
 * caller can wait on. Waiting on a service name instead does not work: the
 * namespace the contribution installs (`remote.opencodeGoUsage`) is a child of
 * the Host remote face, not a service a scoped `ctx.inject` resolves, so naming
 * it waits forever and the meter only appeared through a ten-second timeout.
 *
 * @param ctx - the settings context.
 * @param contribution - the remote's descriptors.
 * @param what - what will not render, named in the report.
 * @returns the disposer the effect gives back, and the mount's settlement.
 */
const mountRemote = (
  ctx: ClientContext,
  contribution: unknown,
  what: string
): { dispose: () => void; ready: Promise<void> } => {
  let dispose: (() => void) | undefined;
  const ready = (async (): Promise<void> => {
    if (ctx.remote === undefined || typeof ctx.remote.$mount !== "function") {
      console.warn(
        `[dsh-opencode-patch] ${what}: the settings context has no remote to mount on`,
        Object.keys(ctx)
      );
      return;
    }
    try {
      dispose = await ctx.remote.$mount(contribution);
      // Say what the mount actually produced. A `$mount` that RESOLVES without
      // installing the namespace is otherwise indistinguishable from one that
      // worked: the surface reads `remote.<namespace>`, finds nothing, and
      // reports "no usage service" — which is the same sentence a host with no
      // service at all produces. This line is what tells the two apart.
      // Say something only when the mount did NOT produce a readable namespace.
      // A `$mount` that resolves without installing one is otherwise
      // indistinguishable from a working mount: the surface reads
      // `remote.<namespace>`, finds nothing, and reports "no usage service" —
      // the same sentence a host with no service at all produces.
      if (remoteNamespaceOf(ctx, "opencodeGoUsage") === undefined) {
        const face = isRecord(ctx.remote) ? Object.keys(ctx.remote) : [];
        console.warn(
          `[dsh-opencode-patch] ${what}: the mount settled but ` +
            `remote.opencodeGoUsage is still unreachable; the remote exposes ` +
            `[${face.join(", ")}]`
        );
      }
    } catch (error) {
      console.warn(`[dsh-opencode-patch] ${what} did not mount`, error);
    }
  })();
  return {
    dispose: () => {
      dispose?.();
    },
    ready,
  };
};

export const inject = [
  "slots",
  "locale",
  "configForms",
  "modelDirectories",
  "remote",
  "remote.session",
  // `remote.opencodeGoUsage` is deliberately NOT declared: as an inject key it is
  // a HARD dependency, and declaring it makes the whole plugin wait forever —
  // "web boot: 1 entry did not activate". The host registers the remote face, but
  // that does not put the name in this client's service registry. The meter
  // reads it through `ctx.remote` instead, which needs no declaration.
];

export interface ClientContext {
  /**
   * The composition's service lookup, which does NOT consult `inject`.
   *
   * It is the only way to reach a Remote namespace this bundle mounts itself:
   * `remote.<ns>` is a service property and reading it undeclared throws. See
   * `remoteNamespaceOf` in `settings-remote.ts`.
   */
  get?: (name: string) => unknown;
  configForms?: {
    get: (ns: string) => unknown;
    whileServed: (
      ns: string[],
      fn: () => (() => void) | undefined
    ) => (() => void) | undefined;
  };
  effect?: (fn: () => unknown, name?: string) => void;
  locale?: {
    bind: (ns: string) => (key: string) => string;
    /**
     * The active locale id, read per call. Reading THIS — not a bound
     * translator — is what makes a language switch land without a reload: the
     * meter re-renders on the poll that follows, and its own dictionary is
     * consulted for whichever language is active then.
     */
    getLocale?: () => { active: string; revision: number };
    register: (
      ns: string,
      dicts: Record<string, unknown>
    ) => (() => void) | undefined;
  };
  /**
   * Run `callback` once the named services exist, with them on the scope it
   * receives. The host's own idiom: `ui-model-selection` does
   * `ctx.inject(['slots','modelDirectories'], scope => …)`. Reading a
   * cross-plugin service straight off the root context is not guaranteed.
   */
  inject?: (
    deps: string[],
    callback: (scope: ClientContext) => unknown
  ) => unknown;
  modelDirectories?: {
    directoryFor: (sessionId: unknown) => { store: unknown };
  };
  remote?: {
    $mount?: (contribution: unknown) => Promise<() => void>;
    // Structural view of the Host remote; `query` scopes the reading.
    opencodeGoUsage?: {
      read: (query?: {
        provider?: string;
        sessionId?: string;
      }) => Promise<unknown>;
    };
  };
  slots?: {
    inject: (
      name: string,
      fn: () => (() => void) | undefined
    ) => (() => void) | undefined;
    register: (
      entry: Record<string, unknown>,
      component: unknown
    ) => (() => void) | undefined;
  };
}

const isSettingsFormScope = (
  value: unknown
): value is SettingsFormScope<Record<string, unknown>> => {
  if (value === null || value === undefined) {
    return false;
  }
  if (typeof value !== "object" && typeof value !== "function") {
    return false;
  }
  if (!("getSnapshot" in value && "subscribe" in value && "mutate" in value)) {
    return false;
  }
  const snapshot: unknown = value.getSnapshot;
  const subscribe: unknown = value.subscribe;
  const mutate: unknown = value.mutate;
  return (
    typeof snapshot === "function" &&
    typeof subscribe === "function" &&
    typeof mutate === "function"
  );
};

const noopDisposer = (): void => {
  /* no-op */
};

/**
 * The slot registries this bundle has already put the meter into.
 *
 * Keyed on the REGISTRY, not on a boolean and not on the `apply` call. The host
 * may run a plugin's client entry more than once in a page's life and the slot
 * registry throws on a duplicate id, so a per-`apply` flag resets on the second
 * run and turns that throw into a meter that disappears. A module-level boolean
 * would fix that and then refuse a genuinely fresh registry — a second
 * conversation surface, or a test's own slots — so the identity that matters is
 * the registry itself.
 */
const meterRegisteredOn = new WeakSet<object>();

/**
 * The session's model-directory store, or `undefined` when the service cannot
 * resolve one yet.
 *
 * `ModelDirectoryResolver.directoryFor` **throws** for a session it does not
 * know (e.g. a composer rendered before its session is bound). A throw here
 * would take the whole dock slot down with it, so an unresolved session
 * degrades to "no meter" instead.
 */
const modelDirectoryStore = (
  ctx: ClientContext,
  sessionId: unknown
): { reason?: string; store?: unknown } => {
  if (ctx.modelDirectories === undefined) {
    return { reason: "no modelDirectories service" };
  }
  if (typeof ctx.modelDirectories.directoryFor !== "function") {
    return { reason: "no directoryFor" };
  }
  let directory: unknown;
  try {
    directory = ctx.modelDirectories.directoryFor(sessionId);
  } catch (error) {
    return {
      reason: `directoryFor threw: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (directory === undefined || directory === null) {
    return { reason: "directoryFor returned nothing" };
  }
  const { store } = directory as { store?: unknown };
  if (store === undefined) {
    return { reason: "directory has no store" };
  }
  return { store };
};

/**
 * The meter's translator: this bundle's dictionaries, never the seat's.
 *
 * The locale service allows one dictionary per (namespace, locale) and throws on
 * a second registration, so a stale copy of this bundle holding the namespace
 * starves every key we add: old keys translate, new keys render verbatim, and
 * nothing says why — which is exactly how `goPlanTitle` reached the screen. So
 * the meter does not ask the seat at all; see {@link withBundleCopy} for the
 * fallback the settings card keeps on top of it.
 *
 * A language switch lands on the next call without a reload, because the id is
 * read at call time rather than captured.
 */
const meterTranslate = (active: () => string | undefined) =>
  // An identity seat: there is nothing to prefer over the bundle here.
  withBundleCopy<CopyKey>((key) => key, active);

export const apply = (ctx: ClientContext): void => {
  ctx.effect?.(() => {
    // The locale service allows ONE dictionary per (namespace, locale) and
    // THROWS on a second registration. During development a stale copy of this
    // bundle can hold the namespace — its page registered first, ours lost the
    // race, and the catch swallowed the throw — so the meter then rendered new
    // keys verbatim (`goPlanTitle`) while old keys translated, and nothing said
    // why. Registering through a namespace only we write, and READING BACK what
    // landed, turns that silent starvation into the dictionary that is actually
    // in force being the one this bundle shipped.
    for (const namespace of [NS, LEGACY_NS]) {
      try {
        ctx.locale?.register?.(namespace, { en, zh });
      } catch {
        // Already held — most plausibly by an older copy of this same bundle on
        // a page that has not reloaded. That copy's dictionary is then what the
        // service serves for these namespaces; it is a stale twin of ours, not
        // another plugin's text, so leaving it is the least surprising outcome.
      }
    }
    return noopDisposer;
  }, "dsh-opencode-patch: dictionaries");

  // Both remotes mount as ONE contribution under the plugin's package name.
  // Typert enforces unique package names per contribution (`dsh-typert-registry`:
  // `if (this.packages.has(contribution.package)) throw new Error(...)`).
  // Mounting `usageRemote` and `loginRemote` separately with the same package
  // name ("dsh-opencode-patch") causes the second `$mount` call to throw
  // `Remote package "dsh-opencode-patch" is already registered` — dropping the
  // remote completely.
  //
  // One contribution registers the package ONCE, which is what lets `api-gateway`
  // install the meter's namespace.
  ctx.effect?.(() => {
    const remotes = mountRemote(
      ctx,
      patchRemote,
      "remotes; the meter and sign-in row will render nothing"
    );
    // The meter is registered when the mount is DONE, which is the fact the ten
    // -second timeout used to stand in for. `registerMeter` is idempotent, so
    // the scoped inject below reaching it first is fine and this is then a no-op.
    void (async () => {
      await remotes.ready;
      registerMeter(ctx);
    })();
    return remotes.dispose;
  }, "dsh-opencode-patch: remotes");

  // Resolve the scope first so the meter can read its trigger markers at inject
  // time. The injector still registers without one: the meter only needs the
  // Host's usage service.
  const rawScope: unknown =
    ctx.configForms?.get?.(NS) ?? ctx.configForms?.get?.(LEGACY_NS);
  const scope = isSettingsFormScope(rawScope) ? rawScope : undefined;

  /**
   * The configured quota-meter markers from the scope's current value,
   * falling back to the plugin defaults while the scope is loading or the
   * fields carry no user value.
   */
  /**
   * The meter's client-side knobs, read from the served settings snapshot. The
   * provider list is the SAME one the host claims traffic for: a route we do not
   * intercept carries no OpenCode headers, so it has no quota to report either —
   * which is why there is no separate "which routes show the meter" setting.
   */
  const usageMarkers = (): { meterProviders: string[] } => {
    const value: unknown = scope?.getSnapshot().value;
    const record = isRecord(value) ? value : {};
    const providers = readStringList(record.providers);
    return {
      meterProviders: providers.length > 0 ? providers : DEFAULT_PROVIDERS,
    };
  };

  const createUsageInjector =
    (meterScope: ClientContext) => (sessionId: unknown) => {
      // An EMPTY object, never `null`: the Host hands this return value straight
      // to its own inject binder, which reads `hooks` off it — so a null face
      // throws inside the renderer and takes the whole slot entry, and the
      // composer dock with it. Absence has to be expressed as "no props", which
      // the pill already renders as nothing.
      const probe = modelDirectoryStore(meterScope, sessionId);
      const directory: unknown = probe.store;
      if (directory === undefined || directory === null) {
        return { reason: probe.reason ?? "no directory" };
      }
      // No Host usage service means no meter: it registers only when tracking is
      // on, and an unavailable state the user cannot act on is worse than
      // absence.
      // Through `ctx.get`, which does not consult `inject` — the property read
      // is refused for a namespace this bundle mounts itself, and the refusal is
      // indistinguishable from "no service". Measured: `property read: false;
      // ctx.get('remote.opencodeGoUsage'): object`.
      const usage =
        remoteNamespaceOf(meterScope, "opencodeGoUsage") ??
        remoteNamespace(meterScope.remote, "opencodeGoUsage");
      if (typeof usage?.read !== "function") {
        return {
          reason: "no usage service: remote.opencodeGoUsage.read is missing",
        };
      }
      const markers = usageMarkers();
      // The id the Host must price; the pill also names the active provider,
      // which is how the Host knows which account is on screen.
      const meterSessionId = typeof sessionId === "string" ? sessionId : "";
      return {
        directory,
        ...markers,
        readUsage: async (provider?: string, model?: string) => {
          const read = usage.read as (query?: unknown) => Promise<unknown>;
          const res: unknown = await read({
            ...(provider === undefined || provider.length === 0
              ? {}
              : { provider }),
            ...(model === undefined || model.length === 0 ? {} : { model }),
            ...(meterSessionId.length === 0
              ? {}
              : { sessionId: meterSessionId }),
          });
          // Narrow `ok` to a boolean so the branch reads as truthiness; the lint
          // config rejects coercing an `unknown` in the condition.
          if (isRecord(res) && typeof res.ok === "boolean") {
            if (res.ok) {
              return "value" in res ? res.value : undefined;
            }
            throw "error" in res ? res.error : undefined;
          }
          return res;
        },
        // The dictionary and every `Intl` formatter must agree on the
        // language: `t` selects the words, `getLocale` feeds the dates and
        // durations. One getter, read at call time, so a switch moves both —
        // wiring only `t` left the numbers in the browser's own locale.
        t: meterTranslate(() => ctx.locale?.getLocale?.()?.active),
        getLocale: () => ctx.locale?.getLocale?.()?.active,
      };
    };

  // The meter registers exactly once, whichever way it is reached. Two ways are
  // deliberate: the scoped inject calls this when the host's remote face appears,
  // and a ten-second fallback calls it anyway so the read can report its own
  // reason. Both firing is the normal case, not the exception — and registering
  // the same slot id twice THROWS, which took the meter out entirely:
  //   list slot "conversation.input.right" already has an entry with id
  //   "dsh-opencode-patch-usage" ... (registered by registerMeter)
  // Measured in a browser, after a restart, as the whole of the reported symptom.
  //
  // The flag is MODULE-level, not per-`apply`. It was per-`apply`, and the host
  // re-runs a plugin's client entry on a page load and on a rebind — so the
  // second run started from `registered = false`, registered the same id again,
  // and threw inside a render, which is a meter that vanishes rather than one
  // that says why. The registration is also non-throwing now: a duplicate is a
  // no-op, not an exception out of the entry.
  const registerMeter = (meterScope: ClientContext): void => {
    // Keyed on the ROOT context, captured in this closure — not on the argument.
    // The three callers pass different scopes: the scoped inject hands over a
    // CHILD scope, while the mount-ready path and the ten-second fallback hand
    // over the root `ctx`. Keying on `meterScope.slots ?? meterScope` therefore
    // produced two different keys for one activation, both guards passed, and the
    // host threw on the duplicate:
    //
    //   list slot "conversation.input.right" already has an entry with id
    //   "dsh-opencode-patch-usage" at priority 0 (registered by registerMeter)
    //
    // Measured in a browser console after the previous guard was added, which is
    // what this replaces. Across a genuine re-activation the root context is a
    // different object, so a fresh registration is still allowed.
    if (meterRegisteredOn.has(ctx)) {
      return;
    }
    // **Do not consume the one-shot on a scope that cannot register.**
    // `slots` is optional at every call site, and the ten-second fallback hands
    // over the ROOT context, which need not carry `slots` at all. Marking the
    // guard before the attempt meant that a fallback which could not register
    // still spent the one allowed registration: the scoped inject fired later
    // with a scope that DID have `slots`, found the guard set, returned — and the
    // meter never appeared anywhere, with no warning, because `?.` swallowed the
    // no-op. Measured as "the pill just isn't there".
    const { slots } = meterScope;
    if (slots === undefined || typeof slots.inject !== "function") {
      // Not an error: the other path is expected to carry it. Said once per
      // scope so a composition where NO path has `slots` is not silent.
      return;
    }
    meterRegisteredOn.add(ctx);
    // `conversation.input.right` renders in the composer bar's trailing controls,
    // immediately BEFORE `conversation.input.model` — so it is the seat beside
    // the model selector. `conversation.input.left` is the far end of the leading
    // tools group instead, a whole row away. Both are list slots, so both are
    // open to a plugin; this is the requested position.
    try {
      slots.inject("conversation.input.right", () => {
        // Console, because this is the one line that says the meter exists: the
        // composer slot has no other trace, and a pill that fails to register is
        // otherwise indistinguishable from a usage service that answered nothing.
        console.info(
          "[dsh-opencode-patch] the usage meter registered on conversation.input.right"
        );
        return slots.register?.(
          {
            id: "dsh-opencode-patch-usage",
            inject: createUsageInjector(meterScope),
            name: "conversation.input.right",
            order: 50,
          },
          UsagePill
        );
      });
    } catch (error) {
      // Already registered by an earlier activation of this same bundle. The
      // meter is present; a second registration is the thing that is not, and
      // it must not become an exception out of the plugin entry. The client
      // context carries no logger, so this reports the way the rest of the
      // bundle does.
      console.warn(
        "[dsh-opencode-patch] the usage meter was already registered",
        error
      );
    }
  };

  // `ctx.inject` is the host's own idiom for a cross-plugin service
  // (`ui-model-selection` does exactly this for `slots` + `modelDirectories`),
  // and it is what makes the callback run once those services exist. Reading
  // `ctx.modelDirectories` straight off the root context is not guaranteed —
  // it came back undefined, so the injector bailed and the meter never mounted.
  // An assembly without service injection still gets the old root-context path.
  // `remote` is load-bearing and was missing: `directoryFor()` reaches
  // `remote.session` internally, and cordis refuses that access unless the
  // caller declared the service — so the call threw
  // `cannot get property "remote.session" without inject`, which the try/catch
  // turned into "no directory" and the meter silently rendered nothing.
  //
  // `remote.opencodeGoUsage` is deliberately NOT in this list, and also not in
  // the top-level `inject` export. The namespace the contribution installs is a
  // child of the Host's remote face, not a service a scoped wait resolves, so
  // naming it waits forever: the meter only ever mounted through the ten-second
  // timeout that used to sit here, which is why the console reported
  // "still waiting for remote.opencodeGoUsage after 10s". The effect above waits
  // on the mount's own settlement instead, and the injector below reads the
  // namespace lazily at render time, when it is there.
  if (typeof ctx.inject === "function") {
    ctx.inject(["modelDirectories", "remote", "slots"], registerMeter);
    // `ctx.inject` is a HARD gate: the callback runs only once ALL of those
    // names exist. If one of them never appears — a host that mounts no remote
    // face is the ordinary case — the meter is then absent with nothing to tell
    // it from a host that serves no usage service. This is the documented second
    // path ("a ten-second fallback calls it anyway so the read can report its
    // own reason"); the comment still described it, but the code had lost it.
    // The registration is idempotent per registry, so whichever path wins, the
    // meter is registered once and a duplicate can never throw.
    const fallback = setTimeout(() => {
      registerMeter(ctx);
    }, 10_000);
    ctx.effect?.(() => () => {
      clearTimeout(fallback);
    });
  } else {
    registerMeter(ctx);
  }

  // No served scope means the card cannot render or save; the dock injector
  // above stays registered either way.
  if (scope === undefined) {
    return;
  }

  const model = new SettingsFormModel(scope, SPECS);
  const store = model.bind(() => ({
    fields: Object.fromEntries(
      SPECS.map((spec) => [spec.field, model.field(spec.field)])
    ),
    shell: model.shell(),
  }));

  ctx.effect?.(
    () => () => {
      model.dispose();
    },
    "dsh-opencode-patch: form subscription"
  );

  // `plugins.bundle.config`, keyed by npm package name — NOT `plugins.item`.
  // The hook key becomes the `useOpencodeCard` prop; the actions spread in as
  // `edit` / `resetField` / `save` / `discard`. Registered inside ctx.effect so
  // the card does not wait on the host re-describing its namespaces.
  ctx.effect?.(() => {
    const stop = ctx.slots?.inject?.("plugins.bundle.config", () => {
      const cards: (() => void)[] = [];
      const keepCard = (dispose: (() => void) | undefined): void => {
        if (typeof dispose === "function") {
          cards.push(dispose);
        }
      };
      // One registration per name the page may look the card up by: both names
      // this bundle is PUBLISHED as, plus the pre-rename cordis row id, which is
      // a namespace rather than a package and must keep working for old rows.
      const aliases: { key: string; locale: string }[] = [
        { key: PKG, locale: NS },
        { key: SCOPED_PKG, locale: NS },
        { key: LEGACY_NS, locale: LEGACY_NS },
      ];
      for (const alias of aliases) {
        keepCard(
          ctx.slots?.register?.(
            {
              inject: () => ({
                // The card reads the same Host service the meter does — one
                // owner for credential resolution and the endpoint.
                getLocale: () => ctx.locale?.getLocale?.()?.active,
                hooks: { opencodeCard: store },
                readUsage: () => readGoUsage(ctx),
                // The profile rewrite: needs the host's config editor, so it is a
                // Remote, and the card shows its outcome rather than assuming one.
                purgeDeprecated: () => purgeDeprecatedModels(ctx),
                // What the readOpencodeStore switch would actually read: the
                // host inspects its own OpenCode store and answers a sanitized
                // summary, so the card can show the account without the secret.
                inspectStore: () => inspectStore(ctx),
                // The sign-in remote, when the host mounted one. Same shape as
                // the meter's: the card calls, the host holds the credential.
                ...model.actions(),
              }),
              key: alias.key,
              locale: alias.locale,
              name: "plugins.bundle.config",
            },
            OpencodeCard
          )
        );
      }
      return () => {
        for (const dispose of cards) {
          dispose();
        }
      };
    });
    return () => {
      if (typeof stop === "function") {
        stop();
      }
    };
  }, "dsh-opencode-patch: settings");
};
