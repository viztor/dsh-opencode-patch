/**
 * Host-side "purge deprecated models": rewrites the deployment's own provider
 * declaration, deleting the model entries the live catalog has retired.
 *
 * **Why it edits the profile instead of filtering at read time.** A filter keeps
 * a second list of "what the user really means", and that list is invisible: the
 * configuration still declares the model, the log still reports it, and the only
 * way to learn why a row is missing is to find the filter. Deleting the entry
 * leaves one source of truth — the profile — and the model is gone from every
 * surface because it is no longer declared anywhere.
 *
 * The write goes through `configEditor`, the same service the settings UI uses:
 * it validates the next config, persists it atomically under the profile's file
 * lock, and lets the Loader reconcile the change. Nothing here writes YAML.
 *
 * **Another plugin's entry is never rewritten** (D27): a plane entry carrying
 * the `x-opencode-plugin` marker, and every plane entry of a row whose
 * credentials resolve in a realm this service's context does not (the route
 * claim's own rule, `utils/plane-ownership.ts`). Such an entry is served by
 * pi-ai for the plugin that wrote it, which judges its models by its own
 * workspace, not by this plugin's catalog; a row of it may also sit in a home
 * patch the editor refuses to write. A reference to a route only such entries
 * declare is left alone for the same reason.
 *
 * @module dsh-opencode-patch/purge-service
 */

import {
  RemoteError,
  TypertRemoteService,
} from "@deepseek-ai/dsh-typert-protocol";

import {
  didCatalogRefreshSucceed,
  isDeprecatedModelOn,
  refreshCatalog,
} from "./models-catalog.ts";
import {
  PURGE_UNAVAILABLE,
  type PurgeResult,
  type PurgedModel,
} from "./purge-contract.ts";
import { isRecord } from "./utils/guards.ts";
import {
  foreignCredentialsRealm,
  pluginMarkerOf,
  type RealmSide,
} from "./utils/plane-ownership.ts";

/** A provider route the plugin knows how to read a plane from. */
const PLANES: readonly { route: string; plane: "go" | "zen" }[] = [
  { route: "opencode", plane: "zen" },
  { route: "opencode-go", plane: "go" },
];

/** The configEditor surface this module uses, narrowed from `unknown`. */
interface ConfigEditorFace {
  entries: () => readonly unknown[];
  edit: (
    entry: unknown,
    change: (current: Record<string, unknown>) => Record<string, unknown>
  ) => Promise<unknown>;
}

const asEditor = (value: unknown): ConfigEditorFace | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }
  const { entries, edit } = value;
  if (typeof entries !== "function" || typeof edit !== "function") {
    return undefined;
  }
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the two methods were just checked; the cast only names their shape.
  return value as unknown as ConfigEditorFace;
};

/** The models a provider block declares, whatever shape the row uses. */
const modelsOf = (provider: unknown): readonly unknown[] | undefined => {
  if (!isRecord(provider)) {
    return undefined;
  }
  const { models } = provider;
  return Array.isArray(models) ? models : undefined;
};

/** One model row's id, when it is a row rather than a bare string. */
const idOf = (model: unknown): string | undefined => {
  if (typeof model === "string") {
    return model;
  }
  if (isRecord(model) && typeof model.id === "string") {
    return model.id;
  }
  return undefined;
};

/**
 * Whether `id` is retired on a route this plugin owns.
 *
 * A route this plugin does not own answers `false`: another vendor's model ids
 * are not ours to retire, and guessing would delete references we cannot check.
 * That includes a plane route only another plugin's entries declare (D27).
 *
 * @param foreign - the plane routes only another plugin's entries declare.
 * @returns the judge for one `(route, id)` reference.
 */
const isRetiredOnOwnedRoute =
  (foreign: ReadonlySet<string>) =>
  (route: string, id: string): boolean => {
    const plane = PLANES.find((candidate) => candidate.route === route)?.plane;
    return (
      plane !== undefined &&
      !foreign.has(route) &&
      isDeprecatedModelOn(plane, id)
    );
  };

/** A property read that a hostile or half-built value cannot throw out of. */
const readSafely = (value: unknown, key: string): unknown => {
  if (!isRecord(value)) {
    return undefined;
  }
  try {
    return Reflect.get(value, key);
  } catch {
    return undefined;
  }
};

/** An editor entry's provider dict, when its options carry one. */
const providersOf = (entry: unknown): Record<string, unknown> | undefined => {
  const options = readSafely(entry, "options");
  const config = isRecord(options) ? options.config : undefined;
  const providers = isRecord(config) ? config.providers : undefined;
  return isRecord(providers) ? providers : undefined;
};

/**
 * The plane routes an entry declares, split by whether this plugin may
 * rewrite them: another plugin owns every route of a row in a realm `own`
 * does not resolve, and a route carrying the marker (D27).
 */
const planeRoutesOf = (
  entry: unknown,
  own: RealmSide,
  root: unknown
): { readonly owned: string[]; readonly foreign: string[] } => {
  const providers = providersOf(entry);
  const declared = PLANES.map(({ route }) => route).filter((route) =>
    isRecord(providers?.[route])
  );
  const realm = foreignCredentialsRealm(
    {
      context: readSafely(entry, "ctx"),
      options: readSafely(entry, "options"),
    },
    own,
    root
  );
  const isForeign = (route: string): boolean =>
    realm !== undefined || pluginMarkerOf(providers?.[route]) !== undefined;
  return {
    foreign: declared.filter((route) => isForeign(route)),
    owned: declared.filter((route) => !isForeign(route)),
  };
};

/**
 * Remove every reference to a retired model from one entry's config.
 *
 * PURE, and exported because this is the half that used to be missing: `purge()`
 * rewrote `providers.<route>.models` and nothing else, so a retired id could
 * disappear from the picker while remaining the compaction summariser — the
 * button said "3 models removed" and left a session-breaking reference behind.
 *
 * Two reference shapes exist in a DSH profile:
 *
 * 1. `allowedModels: [{ provider, model }]` — the subagent tool's selection.
 * 2. `summarizationProvider` / `summarizationModel` — compaction's summariser,
 *    which is a PAIR: removing the model and leaving the provider would ask for a
 *    default model on a named route, so both keys go and the entry falls back to
 *    its own defaults.
 *
 * @param config - the entry's config, verbatim.
 * @param isRetired - whether this plugin's catalog has retired `id` on `provider`.
 * @returns the config to write (unchanged when nothing matched), and what went.
 */
export const stripRetiredReferences = (
  config: Record<string, unknown>,
  isRetired: (provider: string, id: string) => boolean
): { next: Record<string, unknown>; removed: PurgedModel[] } => {
  const removed: PurgedModel[] = [];
  let next = config;

  const { allowedModels } = config;
  if (Array.isArray(allowedModels)) {
    const kept = allowedModels.filter((row) => {
      if (!isRecord(row)) {
        return true;
      }
      const { model, provider } = row;
      if (typeof model !== "string" || typeof provider !== "string") {
        return true;
      }
      if (!isRetired(provider, model)) {
        return true;
      }
      removed.push({ id: model, provider, site: "subagent" });
      return false;
    });
    if (kept.length !== allowedModels.length) {
      next = { ...next, allowedModels: kept };
    }
  }

  const provider = config.summarizationProvider;
  const model = config.summarizationModel;
  if (
    typeof provider === "string" &&
    typeof model === "string" &&
    isRetired(provider, model)
  ) {
    const {
      summarizationModel: _model,
      summarizationProvider: _provider,
      ...rest
    } = next;
    removed.push({ id: model, provider, site: "summarizer" });
    next = rest;
  }

  return { next, removed };
};

export class ModelPurgeService extends TypertRemoteService {
  constructor(ctx: unknown) {
    if (!isRecord(ctx)) {
      throw new TypeError("ModelPurgeService requires a Cordis context object");
    }
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- `TypertRemoteService` takes cordis `Context`, whose types ship only from the Harness installation; the guard above is the runtime check.
    super(ctx as never, "opencodeModelPurge");
  }

  /**
   * Delete every declared model the live catalog marks `deprecated`.
   *
   * One network read first, forced: the shipped shim cannot answer this
   * question, because a retired model is dropped from the active catalog rather
   * than kept with a flag. `catalogRead` reports whether that read landed, so the
   * card can say "the catalog reports none" instead of implying it when the
   * refresh failed.
   */
  async purge(): Promise<PurgeResult> {
    const editor = asEditor(this.ctx.get?.("configEditor"));
    if (editor === undefined) {
      throw new RemoteError(
        PURGE_UNAVAILABLE,
        "This composition has no config editor, so the profile cannot be rewritten",
        { configured: false, retainPrevious: false, retryable: false }
      );
    }

    await refreshCatalog(undefined, true);
    // **Whether THIS attempt read the registry**, not whether one ever did.
    // `refreshCatalog` never rejects, and `isCatalogFresh()` answers "has this
    // process refreshed at all?" — true for hours after a failure. Reporting
    // that as `catalogRead` told the card "nothing is deprecated" for a read
    // that never happened.
    const catalogRead = didCatalogRefreshSucceed();

    // The service's own context decides the realm: it resolves `credentials`
    // in the process-wide realm, where the user's own rows do.
    const own: RealmSide = { context: this.ctx };
    const root = readSafely(this.ctx, "root");
    const ownedRoutes = new Map<unknown, readonly string[]>();
    const declaredOwned = new Set<string>();
    const declaredForeign = new Set<string>();
    for (const entry of editor.entries()) {
      const { owned, foreign } = planeRoutesOf(entry, own, root);
      if (owned.length > 0) {
        ownedRoutes.set(entry, owned);
      }
      for (const route of owned) {
        declaredOwned.add(route);
      }
      for (const route of foreign) {
        declaredForeign.add(route);
      }
    }
    if (ownedRoutes.size === 0) {
      throw new RemoteError(
        PURGE_UNAVAILABLE,
        declaredForeign.size === 0
          ? "No profile entry declares an opencode provider, so there is nothing to purge"
          : "Every opencode provider in the profile is another plugin's, so there is nothing to purge",
        { configured: false, retainPrevious: false, retryable: false }
      );
    }
    const isRetired = isRetiredOnOwnedRoute(
      new Set([...declaredForeign].filter((route) => !declaredOwned.has(route)))
    );

    const removed: PurgedModel[] = [];
    for (const [entry, routes] of ownedRoutes) {
      // Collected per entry, then appended. NOT a fix for anything: an `edit`
      // that throws propagates out of `purge()` before the return, so the report
      // can never describe a rejected edit either way (checked, so this comment
      // does not claim a failure mode that cannot occur). It is simply the
      // narrower scope — each entry's removals stay attributable to that entry,
      // which is what a partial-failure path would need if one is ever added.
      const entryRemoved: PurgedModel[] = [];
      await editor.edit(entry, (current) => {
        const providers = isRecord(current.providers)
          ? { ...current.providers }
          : {};
        for (const { route, plane } of PLANES) {
          if (!routes.includes(route)) {
            continue;
          }
          const declared = modelsOf(providers[route]);
          if (declared === undefined) {
            continue;
          }
          const kept = declared.filter((model) => {
            const id = idOf(model);
            if (id === undefined || !isDeprecatedModelOn(plane, id)) {
              return true;
            }
            entryRemoved.push({ provider: route, id });
            return false;
          });
          if (kept.length !== declared.length) {
            providers[route] = {
              ...(providers[route] as object),
              models: kept,
            };
          }
        }
        return { ...current, providers };
      });
      removed.push(...entryRemoved);
    }

    // **Every other surface that names a model by id.** The provider lists above
    // are what the picker reads; these are what actually CALL a model, and they
    // live in entries that declare no provider at all — which is why the sweep
    // above could not see them. A retired id here is worse than a stale picker
    // row: compaction that cannot resolve its summariser fails the checkpoint,
    // and the session then ends every turn on `max-tokens`.
    for (const entry of editor.entries()) {
      const options = isRecord(entry) ? entry.options : undefined;
      const config = isRecord(options) ? options.config : undefined;
      if (!isRecord(config)) {
        continue;
      }
      // Decided before the write so an entry with nothing to strip is not
      // rewritten at all: an unconditional edit would mark every entry dirty on
      // every click.
      if (stripRetiredReferences(config, isRetired).removed.length === 0) {
        continue;
      }
      const entryRemoved: PurgedModel[] = [];
      await editor.edit(entry, (current) => {
        const { next, removed: gone } = stripRetiredReferences(
          current,
          isRetired
        );
        entryRemoved.push(...gone);
        return next;
      });
      removed.push(...entryRemoved);
    }

    return { removed, catalogRead };
  }
}

/**
 * Prototype key `remoteMethods()` reads Remote markers from — the same constant
 * `usage.ts` uses, spelled here rather than imported because the protocol
 * package does not re-export it.
 */
const REMOTE_METHOD_DESCRIPTOR_KEY =
  "@deepseek-ai/dsh-typert-protocol/remote-methods";

/**
 * Declare `purge` as a Remote method. See `usage.ts` for why the decorator
 * cannot be used in this build.
 */
Object.defineProperty(
  ModelPurgeService.prototype,
  REMOTE_METHOD_DESCRIPTOR_KEY,
  {
    configurable: true,
    value: Object.freeze({
      version: 1,
      methods: Object.freeze([
        { method: "purge", invocation: { kind: "direct" } },
      ]),
    }),
  }
);
