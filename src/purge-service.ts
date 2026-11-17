/**
 * Host-side "purge deprecated models": rewrites the deployment's own provider
 * declaration, deleting the model entries the catalog has retired. Its
 * sibling, the ids pi cannot serve (`review`, `removeUnserved`), runs the
 * same rewrite with another judge: the ids declared on the plugin's planes
 * that pi's installed catalog does not describe, which pi-ai drops from the
 * composer, and refuses the next Settings edit of, once the plugin is gone.
 *
 * **What "retired" is judged by.** The forced refresh's own answer
 * (`CatalogRefresh.deprecated`): the registry's retired ids when the read
 * lands, and what the process already holds when it does not — the shipped
 * shim's own retirements, or an earlier refresh's. `catalogRead` says which.
 *
 * **One write per entry.** Every entry is judged before its write, and an
 * entry with nothing to remove is not edited at all: on the real host a no-op
 * edit still validates, rewrites the profile document and reconciles. An
 * entry with something to remove gets exactly one edit, declarations and
 * references together (`purgeEntryConfig`).
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
  PURGE_NAMESPACE,
  PURGE_UNAVAILABLE,
  purgeRemote,
  type PurgeResult,
  type PurgeReview,
  type PurgedModel,
} from "./contracts/purge.ts";
import { loadHostLibraries } from "./cordis-context.ts";
import { markRemote } from "./host/remote.ts";
import { catalogLastError, refreshCatalog } from "./models-catalog.ts";
import { isRecord } from "./utils/guards.ts";
import {
  foreignCredentialsRealm,
  pluginMarkerOf,
  type RealmSide,
} from "./utils/plane-ownership.ts";
import { piUnservedIds } from "./utils/plane-profile.ts";
import { type Plane, PLANE_OF_ROUTE } from "./utils/planes.ts";
import { PLANE_ROUTES, type PlaneRoute } from "./utils/protocols.ts";

/** A provider route the plugin knows how to read a plane from, in route order. */
const PLANES: readonly { route: string; plane: Plane }[] = PLANE_ROUTES.map(
  (route) => ({ plane: PLANE_OF_ROUTE[route], route })
);

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

/** Whether one `(route, id)` reference is to be removed. */
type Judge = (route: string, id: string) => boolean;

/**
 * Whether `id` is retired on a route this plugin owns.
 *
 * A route this plugin does not own answers `false`: another vendor's model ids
 * are not ours to retire, and guessing would delete references we cannot check.
 * That includes a plane route only another plugin's entries declare (D27).
 *
 * @param foreign - the plane routes only another plugin's entries declare.
 * @param retired - the ids retired on each plane, from one catalog answer.
 * @returns the judge for one `(route, id)` reference.
 */
const isRetiredOnOwnedRoute =
  (
    foreign: ReadonlySet<string>,
    retired: ReadonlyMap<Plane, ReadonlySet<string>>
  ): Judge =>
  (route, id) => {
    const plane = PLANES.find((candidate) => candidate.route === route)?.plane;
    return (
      plane !== undefined &&
      !foreign.has(route) &&
      retired.get(plane)?.has(id) === true
    );
  };

/** Rows of `{ id, provider }` as a `(route, id)` judge. */
const judgeOf =
  (rows: readonly PurgedModel[]): Judge =>
  (route, id) =>
    rows.some((row) => row.provider === route && row.id === id);

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

/**
 * One entry's config with every judged id removed: its declarations on the
 * routes it owns, then every reference to one (`stripRetiredReferences`).
 *
 * PURE, so the purge can judge an entry before writing it and write it with
 * one edit: the pre-check and the edit's own callback run the same function.
 *
 * @param config - the entry's config, verbatim.
 * @param ownedRoutes - the plane routes this entry declares that the plugin
 *   may rewrite; a route not listed is never filtered.
 * @param isRetired - whether `id` is to be removed from `route`'s declaration
 *   in THIS entry.
 * @param isReferenced - whether a reference to `(route, id)` is to be
 *   removed; the declaration judge when omitted. The removal of the ids pi
 *   cannot serve passes a route-wide judge here, because a reference names a
 *   route and not the entry that declares it.
 * @returns the config to write (`config` itself when nothing matched), and
 *   what went, declarations first.
 */
export const purgeEntryConfig = (
  config: Record<string, unknown>,
  ownedRoutes: readonly string[],
  isRetired: Judge,
  isReferenced: Judge = isRetired
): { next: Record<string, unknown>; removed: PurgedModel[] } => {
  const removed: PurgedModel[] = [];
  let next = config;
  const providers = isRecord(config.providers) ? config.providers : undefined;
  if (providers !== undefined) {
    const rewritten: Record<string, unknown> = { ...providers };
    for (const { route } of PLANES) {
      const entry = ownedRoutes.includes(route) ? providers[route] : undefined;
      const declared = modelsOf(entry);
      if (!isRecord(entry) || declared === undefined) {
        continue;
      }
      const kept = declared.filter((model) => {
        const id = idOf(model);
        if (id === undefined || !isRetired(route, id)) {
          return true;
        }
        removed.push({ id, provider: route });
        return false;
      });
      if (kept.length !== declared.length) {
        rewritten[route] = { ...entry, models: kept };
      }
    }
    if (removed.length > 0) {
      next = { ...config, providers: rewritten };
    }
  }
  const references = stripRetiredReferences(next, isReferenced);
  return {
    next: references.next,
    removed: [...removed, ...references.removed],
  };
};

/** The config an editor entry carries, when its options hold one. */
const configOf = (entry: unknown): Record<string, unknown> | undefined => {
  const options = readSafely(entry, "options");
  const config = isRecord(options) ? options.config : undefined;
  return isRecord(config) ? config : undefined;
};

/** Which entries' plane routes the plugin may rewrite, and a judge's guard. */
interface Ownership {
  /** Each entry that declares an owned plane route, with those routes. */
  readonly ownedRoutes: ReadonlyMap<unknown, readonly string[]>;
  /** The plane routes only another plugin's entries declare (D27). */
  readonly foreignOnly: ReadonlySet<string>;
}

/** What `rewrite` removes: declarations judged per entry, references per route. */
interface Judges {
  /** The judge for one entry's own declarations. */
  readonly declarations: (entry: unknown) => Judge;
  /** The judge for a reference, which names a route and not an entry. */
  readonly references: Judge;
}

/**
 * Rewrite every entry the judges find something in: one loop over the
 * editor's entries, a pure pre-check, and exactly one edit for an entry that
 * changes.
 *
 * @param editor - the config editor.
 * @param ownership - which entries' plane routes the plugin may rewrite.
 * @param judges - whether one `(route, id)` declaration or reference is to go.
 * @returns every reference removed, in entry order.
 */
const rewrite = async (
  editor: ConfigEditorFace,
  ownership: Ownership,
  judges: Judges
): Promise<PurgedModel[]> => {
  const removed: PurgedModel[] = [];
  for (const entry of editor.entries()) {
    const config = configOf(entry);
    if (config === undefined) {
      continue;
    }
    const routes = ownership.ownedRoutes.get(entry) ?? [];
    const judge = judges.declarations(entry);
    const purgeOf = (current: Record<string, unknown>) =>
      purgeEntryConfig(current, routes, judge, judges.references);
    // Decided before the write, so an entry with nothing to remove is not
    // rewritten at all: on the real host a no-op edit still validates,
    // rewrites the profile document and reconciles.
    if (purgeOf(config).removed.length === 0) {
      continue;
    }
    // Recomputed on the config the editor hands the change, which is the one
    // it writes, and appended only once the edit resolved: an edit that
    // throws propagates before the append, so a rejected edit reports nothing.
    let entryRemoved: PurgedModel[] = [];
    // oxlint-disable-next-line no-await-in-loop -- one write at a time, in entry order: each edit locks and rewrites the same profile document.
    await editor.edit(entry, (current) => {
      const { next, removed: gone } = purgeOf(current);
      entryRemoved = gone;
      return next;
    });
    removed.push(...entryRemoved);
  }
  return removed;
};

export class ModelPurgeService extends TypertRemoteService {
  constructor(ctx: unknown) {
    if (!isRecord(ctx)) {
      throw new TypeError("ModelPurgeService requires a Cordis context object");
    }
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- `TypertRemoteService` takes cordis `Context`, whose types ship only from the Harness installation; the guard above is the runtime check.
    super(ctx as never, PURGE_NAMESPACE);
  }

  /** The config editor, or the refusal every method answers without one. */
  private editor(): ConfigEditorFace {
    const editor = asEditor(this.ctx.get?.("configEditor"));
    if (editor === undefined) {
      throw new RemoteError(
        PURGE_UNAVAILABLE,
        "This composition has no config editor, so the profile cannot be rewritten",
        { configured: false, retainPrevious: false, retryable: false }
      );
    }
    return editor;
  }

  /**
   * Which entries' plane routes the plugin may rewrite, or the refusal when it
   * may rewrite none.
   */
  private ownership(editor: ConfigEditorFace): Ownership {
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
    return {
      foreignOnly: new Set(
        [...declaredForeign].filter((route) => !declaredOwned.has(route))
      ),
      ownedRoutes,
    };
  }

  /**
   * The ids each owned plane route declares that pi's installed catalog cannot
   * serve, per entry: each entry is judged by its own block (its own `api`
   * among it), so an id one entry cannot serve is never judged unserved in
   * another. `undefined` when pi cannot be read.
   */
  private async unserved(
    ownership: Ownership
  ): Promise<ReadonlyMap<unknown, readonly PurgedModel[]> | undefined> {
    const libraries = await loadHostLibraries(this.ctx);
    if (libraries === undefined) {
      return undefined;
    }
    const byEntry = new Map<unknown, readonly PurgedModel[]>();
    for (const [entry, routes] of ownership.ownedRoutes) {
      const providers = providersOf(entry);
      const rows: PurgedModel[] = [];
      for (const route of routes) {
        for (const id of piUnservedIds(
          providers?.[route],
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- `routes` holds only `PLANE_ROUTES` members (`planeRoutesOf` filters by them); the cast names that.
          libraries.builtinModels(route as PlaneRoute)
        )) {
          rows.push({ id, provider: route });
        }
      }
      byEntry.set(entry, rows);
    }
    return byEntry;
  }

  /**
   * Delete every declared model, and every reference to one, that the catalog
   * marks `deprecated`.
   *
   * One network read first, forced, and the removal is judged by that read's
   * own answer: the registry's retired ids when it lands, and what the
   * process already holds when it does not (the shipped shim's retirements,
   * or an earlier refresh's). `catalogRead` reports whether the read landed,
   * so the card can say "the catalog reports none" only when it did.
   */
  async purge(): Promise<PurgeResult> {
    const editor = this.editor();
    const refresh = await refreshCatalog(undefined, true);
    const ownership = this.ownership(editor);
    const retired = new Map<Plane, ReadonlySet<string>>(
      PLANES.map(({ plane }) => [plane, new Set(refresh.deprecated[plane])])
    );
    const judge = isRetiredOnOwnedRoute(ownership.foreignOnly, retired);
    const removed = await rewrite(editor, ownership, {
      declarations: () => judge,
      references: judge,
    });
    return { catalogRead: refresh.ok, removed };
  }

  /**
   * The ids declared on the plugin's own plane entries that pi's installed
   * catalog cannot serve, and the catalog's last refresh error.
   *
   * pi-ai refuses such an id once the plugin is gone ("needs an api"), so this
   * is what the card lists before the plugin is removed. No network, no edit.
   *
   * An id two entries declare on one route is listed once. A profile with no
   * plane entry this plugin owns lists nothing and still answers the
   * catalog's last error, which does not depend on what the profile declares;
   * only a composition with no config editor refuses.
   */
  async review(): Promise<PurgeReview> {
    const catalogError = catalogLastError();
    const ownership = this.ownershipOrNone(this.editor());
    const byEntry = await this.unserved(ownership);
    const seen = new Set<string>();
    const unserved: PurgedModel[] = [];
    for (const rows of byEntry?.values() ?? []) {
      for (const row of rows) {
        const key = `${row.provider}\u0000${row.id}`;
        if (!seen.has(key)) {
          seen.add(key);
          unserved.push(row);
        }
      }
    }
    return {
      piRead: byEntry !== undefined,
      unserved,
      ...(catalogError === undefined ? {} : { catalogError }),
    };
  }

  /** {@link ownership}, or no owned entry where it refuses for want of one. */
  private ownershipOrNone(editor: ConfigEditorFace): Ownership {
    try {
      return this.ownership(editor);
    } catch (error: unknown) {
      if (error instanceof RemoteError && error.code === PURGE_UNAVAILABLE) {
        return { foreignOnly: new Set(), ownedRoutes: new Map() };
      }
      throw error;
    }
  }

  /**
   * Remove the ids {@link review} lists, and every reference to one, with one
   * edit per entry that changes. Nothing is removed when pi's installed
   * catalog cannot be read, and `catalogRead` then says so. No catalog read.
   */
  async removeUnserved(): Promise<PurgeResult> {
    const editor = this.editor();
    const ownership = this.ownership(editor);
    const byEntry = await this.unserved(ownership);
    if (byEntry === undefined) {
      return { catalogRead: false, removed: [] };
    }
    // A declaration is judged by its own entry's rows: an entry that sets a
    // route-level `api` lists none, so it keeps an id another entry on the
    // same route cannot serve. A reference names a route only, so it is
    // judged by every owned entry's rows; those hold owned routes only, so a
    // reference to a route only another plugin's entries declare is never
    // judged (D27). Route-wide on purpose: two owned entries declaring one
    // route is a composition the host's registry refuses (the second
    // registration of a provider is a DUPLICATE_ADAPTER), so which entry
    // serves the route once the plugin is gone depends on apply order, and a
    // reference cannot be attributed to the one that keeps the id.
    const removed = await rewrite(editor, ownership, {
      declarations: (entry) => judgeOf(byEntry.get(entry) ?? []),
      references: judgeOf([...byEntry.values()].flat()),
    });
    return { catalogRead: true, removed };
  }
}

markRemote(ModelPurgeService, purgeRemote);
