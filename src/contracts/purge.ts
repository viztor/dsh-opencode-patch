/**
 * What a purge answers, in a module both bundles may import.
 *
 * The client shows the count; the host computes it. Keeping the shape here
 * rather than in either side means the two cannot drift, and the bundle rule
 * (a client module reaches nothing host-only) is satisfied by construction.
 *
 * @module dsh-opencode-patch/contracts/purge
 */

import type { RemoteResult } from "@deepseek-ai/dsh-typert-protocol";

import { defineRemote, remoteValue } from "./remote.ts";

/**
 * Where a retired model id was found.
 *
 * `provider` is a declaration (the list the picker reads). The other two are
 * REFERENCES to a model by id, in a surface that does not list models at all —
 * and they are the ones a purge used to miss, which made the button report
 * success while a retired id was still the compaction summariser.
 */
export type PurgedSite = "provider" | "subagent" | "summarizer";

/** One retired model reference removed from the deployment's profile. */
export interface PurgedModel {
  /** The provider route it was declared on, e.g. `opencode-go`. */
  readonly provider: string;
  /** The model id, as the profile spelled it. */
  readonly id: string;
  /** Where it was found. Absent is read as `provider`, for older callers. */
  readonly site?: PurgedSite;
}

/** The outcome of one purge. */
export interface PurgeResult {
  /** Every id removed, in declaration order. Empty when nothing was retired. */
  readonly removed: readonly PurgedModel[];
  /**
   * Whether the list the removal judged by was read: the live catalog for
   * `purge`, pi's installed catalog for `removeUnserved`.
   *
   * `false` means that read did not land (offline, a rejected reply, a pi that
   * cannot be loaded) — the distinction matters because "nothing was removed"
   * and "the list could not be read" otherwise produce the same empty list and
   * the same sentence.
   */
  readonly catalogRead: boolean;
}

/**
 * What the card lists beside the purge row: the ids declared on the plugin's
 * planes that pi's installed catalog cannot serve, and the catalog's last
 * refresh error.
 */
export interface PurgeReview {
  /**
   * One row per declared id pi cannot serve, in entry then route order, an id
   * two entries declare on one route once; empty when the profile declares no
   * plane entry this plugin owns.
   */
  readonly unserved: readonly PurgedModel[];
  /**
   * Whether pi's installed catalog was read; `false` lists nothing, and the
   * card says the catalog could not be read.
   */
  readonly piRead: boolean;
  /** Why the catalog's last refresh did not land, when it did not. */
  readonly catalogError?: string;
}

/** The remote namespace the host mounts and the card calls. */
export const PURGE_NAMESPACE = "opencodeModelPurge";

/**
 * Whether a value is one `PurgedModel` row, judged by `id` and `provider`.
 * `site` is not checked here: the codec keeps it only when it is a string,
 * and does not narrow that string to the `PurgedSite` union.
 */
const isPurgedModel = (value: unknown): value is PurgedModel =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as { id?: unknown }).id === "string" &&
  typeof (value as { provider?: unknown }).provider === "string";

/**
 * Parse a purge result, rejecting anything that is not one.
 *
 * A whitelist, like every other codec on this seam: the client renders what it
 * is told, so it must be told only the fields it renders.
 *
 * @param value - the decoded wire value.
 * @returns the result, or `undefined` when it is not one.
 */
export const parsePurgeResult = (value: unknown): PurgeResult | undefined => {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const { removed, catalogRead } = value as {
    catalogRead?: unknown;
    removed?: unknown;
  };
  if (!Array.isArray(removed) || typeof catalogRead !== "boolean") {
    return undefined;
  }
  const rows: PurgedModel[] = [];
  for (const row of removed) {
    if (!isPurgedModel(row)) {
      return undefined;
    }
    rows.push({
      id: row.id,
      provider: row.provider,
      ...(typeof row.site === "string" ? { site: row.site } : {}),
    });
  }
  return { catalogRead, removed: rows };
};

/** The longest catalog error the card renders. */
const CATALOG_ERROR_MAX = 200;

/**
 * Parse a review, rejecting anything that is not one: rows through the same
 * row check as a purge result, kept as `{ id, provider }`; `piRead` must be a
 * boolean; `catalogError` is kept only when a string, cut to 200 characters.
 *
 * @param value - the decoded wire value.
 * @returns the review, or `undefined` when it is not one.
 */
export const parsePurgeReview = (value: unknown): PurgeReview | undefined => {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const { catalogError, piRead, unserved } = value as {
    catalogError?: unknown;
    piRead?: unknown;
    unserved?: unknown;
  };
  if (!Array.isArray(unserved) || typeof piRead !== "boolean") {
    return undefined;
  }
  const rows: PurgedModel[] = [];
  for (const row of unserved) {
    if (!isPurgedModel(row)) {
      return undefined;
    }
    rows.push({ id: row.id, provider: row.provider });
  }
  return {
    piRead,
    unserved: rows,
    ...(typeof catalogError === "string"
      ? { catalogError: catalogError.slice(0, CATALOG_ERROR_MAX) }
      : {}),
  };
};

/** One result codec for the two methods that rewrite the profile. */
const purgeResult = remoteValue("PurgeResult", parsePurgeResult);

/**
 * The purge namespace, as a contribution the client mounts.
 *
 * **Without a descriptor the namespace never reaches the browser.** The host
 * mounts the Service and the card asks `remote.opencodeModelPurge.purge`; a
 * Remote is only reachable when a contribution carrying its descriptor was
 * mounted on the client, so the row reported "unavailable" for a host that had
 * the service all along. Same builder as `usageRemote`, and the card mounts
 * every contract under one package name (`REMOTE_CONTRACTS`).
 */
export const purgeRemote = defineRemote(PURGE_NAMESPACE, {
  purge: { result: purgeResult },
  review: { result: remoteValue("PurgeReview", parsePurgeReview) },
  removeUnserved: { result: purgeResult },
});

/** The one failure a purge reports: the profile cannot be rewritten here. */
export const PURGE_UNAVAILABLE = "opencode/purge-unavailable";

declare module "@deepseek-ai/dsh-typert-protocol" {
  interface RemoteErrorDetailsMap {
    "opencode/purge-unavailable": {
      /**
       * `false` for every rejection: a missing config editor and a profile with
       * no opencode provider are both states of the deployment, not transient
       * faults, so the card reports them instead of offering a retry.
       */
      readonly configured?: boolean;
      readonly retainPrevious?: boolean;
      readonly retryable?: boolean;
    };
  }
  interface TypertRemoteNamespaceMap {
    opencodeModelPurge: {
      purge: () => Promise<RemoteResult<PurgeResult>>;
      review: () => Promise<RemoteResult<PurgeReview>>;
      removeUnserved: () => Promise<RemoteResult<PurgeResult>>;
    };
  }
}
