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
  PURGE_NAMESPACE,
  parsePurgeResult,
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
    if (isRecord(answer) && answer.ok === false) {
      // The remote's own failure, said in its own words rather than as a shape
      // error about the envelope it arrived in.
      const { error } = answer;
      return {
        kind: "failed",
        message:
          isRecord(error) && typeof error.message === "string"
            ? error.message
            : "the host refused the purge",
      };
    }
    const value = isRecord(answer) && "value" in answer ? answer.value : answer;
    // The contract's own parser, so the card renders only the fields it whitelists.
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
