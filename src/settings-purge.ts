/**
 * The card's one destructive action: ask the host to delete the retired models
 * this deployment declares.
 *
 * The call is a Remote, like the quota read: the purge needs the profile and the
 * config editor, neither of which a browser has. Every failure is named rather
 * than collapsed into `undefined`, because "no service", "no config editor" and
 * "the host refused" are three different problems for whoever clicks it.
 *
 * @module dsh-opencode-patch/settings-purge
 */

import { purgeRemote, type PurgeResult } from "./contracts/purge.ts";
import { callRemote, type RemoteOutcome } from "./settings-remote.ts";

/** What one click produced, in a shape the card can render without guessing. */
export type PurgeOutcome =
  | { readonly kind: "purged"; readonly result: PurgeResult }
  | { readonly kind: "unavailable" }
  | { readonly kind: "failed"; readonly message: string };

/**
 * Ask the host to purge, once.
 *
 * Through the one unwrap (`callRemote`): the host's own failure comes first,
 * in its own words, and the result is PARSED by the contract's whitelist,
 * never cast.
 *
 * @param scope - the settings scope the card was rendered with.
 * @returns the outcome; never throws.
 */
export const purgeDeprecatedModels = async (
  scope: unknown
): Promise<PurgeOutcome> => {
  let outcome: RemoteOutcome<PurgeResult>;
  try {
    outcome = await callRemote(scope, purgeRemote, "purge");
  } catch (error: unknown) {
    return {
      kind: "failed",
      message: error instanceof Error ? error.message : String(error),
    };
  }
  if (outcome.kind === "unavailable") {
    console.warn(
      "[dsh-opencode-patch] purge: no opencodeModelPurge service on the remote"
    );
    return { kind: "unavailable" };
  }
  if (outcome.kind === "refused") {
    return {
      kind: "failed",
      message: outcome.reason ?? "the host refused the purge",
    };
  }
  if (outcome.kind === "invalid") {
    return {
      kind: "failed",
      message: "the host answered something that is not a purge result",
    };
  }
  return { kind: "purged", result: outcome.value };
};
