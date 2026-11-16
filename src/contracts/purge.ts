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
   * Whether the catalog had anything to say at all.
   *
   * `false` means the refresh did not land (offline, or a rejected reply) — the
   * distinction matters because "nothing was deprecated" and "the catalog could
   * not be read" otherwise produce the same empty list and the same sentence.
   */
  readonly catalogRead: boolean;
}

/** The remote namespace the host mounts and the card calls. */
export const PURGE_NAMESPACE = "opencodeModelPurge";

/** Whether a value is one `PurgedModel` row. */
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
      ...(typeof (row as { site?: unknown }).site === "string"
        ? { site: (row as { site: PurgedSite }).site }
        : {}),
    });
  }
  return { catalogRead, removed: rows };
};

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
  purge: { result: remoteValue("PurgeResult", parsePurgeResult) },
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
    };
  }
}
