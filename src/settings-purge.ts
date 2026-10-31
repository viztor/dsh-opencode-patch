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

import {
  parsePurgeResult,
  PURGE_NAMESPACE,
  type PurgeResult,
} from "./purge-contract.ts";
import { remoteNamespace, remoteNamespaceOf } from "./settings-remote.ts";
import { isRecord } from "./utils/guards.ts";

/** What one click produced, in a shape the card can render without guessing. */
export type PurgeOutcome =
  | { readonly kind: "purged"; readonly result: PurgeResult }
  | { readonly kind: "unavailable" }
  | { readonly kind: "failed"; readonly message: string };

/** The Remote's namespace, read through the shared guard (see settings-remote). */
const namespaceOf = (scope: unknown) =>
  remoteNamespaceOf(scope, PURGE_NAMESPACE) ??
  remoteNamespace(isRecord(scope) ? scope.remote : undefined, PURGE_NAMESPACE);

/**
 * Ask the host to purge, once.
 *
 * @param scope - the settings scope the card was rendered with.
 * @returns the outcome; never throws.
 */
export const purgeDeprecatedModels = async (
  scope: unknown
): Promise<PurgeOutcome> => {
  const namespace = namespaceOf(scope);
  const call = namespace?.purge;
  if (typeof call !== "function") {
    console.warn(
      "[dsh-opencode-patch] purge: no opencodeModelPurge service on the remote"
    );
    return { kind: "unavailable" };
  }
  try {
    const answer: unknown = await call();
    const value = isRecord(answer) && "value" in answer ? answer.value : answer;
    // **The host's own failure comes first.** The host answers a failure as
    // `{ ok: false, … }`, and reading that as "not a purge result" replaced the
    // message that says WHY with a sentence about shape — which tells the reader
    // nothing they can act on.
    if (isRecord(value) && value.ok === false) {
      const { error, message: said } = value;
      let message = "the host refused the purge";
      if (typeof said === "string") {
        message = said;
      } else if (typeof error === "string") {
        message = error;
      }
      return { kind: "failed", message };
    }
    // And the result is PARSED, not cast: the contract's whitelist is the
    // client's only statement about what it is told, and a cast is no statement
    // at all.
    const result = parsePurgeResult(value);
    if (result === undefined) {
      return {
        kind: "failed",
        message: "the host answered something that is not a purge result",
      };
    }
    return { kind: "purged", result };
  } catch (error: unknown) {
    return {
      kind: "failed",
      message: error instanceof Error ? error.message : String(error),
    };
  }
};
