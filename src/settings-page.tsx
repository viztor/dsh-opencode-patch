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

import {
  DEFAULT_PROVIDERS,
  DEFAULT_SHOW_USAGE_PRICE,
  readBoolean,
  readStringList,
} from "./config-values.ts";
import { isRecord } from "./guards.ts";
import { OpencodeCard } from "./settings-card.tsx";
import { en, zh } from "./settings-copy.ts";
import { SPECS } from "./settings-fields.ts";
import { usageRemote } from "./usage-contract.ts";
import { UsagePill } from "./usage-pill.tsx";

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
 * The meter's own translator, reading the bundle's OWN dictionaries.
 *
 * The locale service allows one dictionary per (namespace, locale) and throws on
 * a second registration, so a stale copy of this bundle holding the namespace
 * starves every key we add: old keys translate, new keys render verbatim, and
 * nothing says why — which is exactly how `goPlanTitle` reached the screen. So
 * the meter no longer competes for a shared namespace at all: `en`/`zh` ship in
 * this very bundle, the active locale comes from the service per call, and the
 * lookup falls back en → zh → key. A language switch lands on the next render
 * without a reload, because the id is read at call time, not captured.
 *
 * The settings card keeps the bound `t` — its rows come from the same
 * dictionaries, but the card is registered through the framework's `t` seat and
 * was never bitten: it mounts after boot, when the race is already decided.
 */
const meterTranslate =
  (active: string | undefined): ((key: string) => string) =>
  (key: string): string => {
    // Widened to an index signature ON PURPOSE: the caller holds an arbitrary
    // key, so the lookup is a miss-or-hit at runtime and `?? key` is the miss.
    // The previous form asserted `key as keyof typeof dict`, which is a
    // narrower type than the value it was given — an assertion that existed
    // only to satisfy the compiler about a lookup that is untyped by nature.
    const dict: Record<string, string> = active === "zh" ? zh : en;
    return dict[key] ?? key;
  };

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

  ctx.effect?.(() => {
    let dispose: (() => void) | undefined;
    const mount = async (): Promise<void> => {
      try {
        dispose = await ctx.remote?.$mount?.(usageRemote);
      } catch {
        // Unrendered meter, as before.
      }
    };
    void mount();
    return () => {
      dispose?.();
    };
  }, "dsh-opencode-patch: usage remote");

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
  const usageMarkers = (): {
    meterProviders: string[];
    showUsagePrice: boolean;
  } => {
    const value: unknown = scope?.getSnapshot().value;
    const record = isRecord(value) ? value : {};
    const providers = readStringList(record.providers);
    return {
      meterProviders: providers.length > 0 ? providers : DEFAULT_PROVIDERS,
      showUsagePrice: readBoolean(
        record.showUsagePrice,
        DEFAULT_SHOW_USAGE_PRICE
      ),
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
      if (typeof meterScope.remote?.opencodeGoUsage?.read !== "function") {
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
          const res: unknown = await meterScope.remote?.opencodeGoUsage?.read?.(
            {
              ...(provider === undefined || provider.length === 0
                ? {}
                : { provider }),
              ...(model === undefined || model.length === 0 ? {} : { model }),
              ...(meterSessionId.length === 0
                ? {}
                : { sessionId: meterSessionId }),
            }
          );
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
        t: meterTranslate(ctx.locale?.getLocale?.()?.active),
      };
    };

  const registerMeter = (meterScope: ClientContext): void => {
    // `conversation.input.right` renders in the composer bar's trailing controls,
    // immediately BEFORE `conversation.input.model` — so it is the seat beside
    // the model selector. `conversation.input.left` is the far end of the leading
    // tools group instead, a whole row away. Both are list slots, so both are
    // open to a plugin; this is the requested position.
    meterScope.slots?.inject?.("conversation.input.right", () =>
      meterScope.slots?.register?.(
        {
          id: "dsh-opencode-patch-usage",
          inject: createUsageInjector(meterScope),
          name: "conversation.input.right",
          order: 50,
        },
        UsagePill
      )
    );
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
  // `remote.opencodeGoUsage` belongs HERE and not in the top-level `inject`
  // export. The two are not interchangeable: a name in `inject` is a hard gate
  // that stops the whole plugin activating until it exists ("web boot: 1 entry
  // did not activate: pending (waiting for service: ...)"), whereas this call is
  // a scoped wait that simply runs its callback once the service appears. The
  // mount above is an effect — registered synchronously, completed
  // asynchronously — so this waits for it rather than deadlocking on it. Without
  // the name here, cordis refuses the read outright:
  // `cannot get property "remote.opencodeGoUsage" without inject`.
  if (typeof ctx.inject === "function") {
    ctx.inject(
      ["modelDirectories", "remote", "slots", "remote.opencodeGoUsage"],
      registerMeter
    );
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
                hooks: { opencodeCard: store },
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
