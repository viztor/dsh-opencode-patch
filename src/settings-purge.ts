/**
 * The card's destructive actions: ask the host to delete the retired models
 * this deployment declares, and the ids pi cannot serve; and the review that
 * lists those ids beside the purge row.
 *
 * The calls are Remotes, like the quota read: they need the profile and the
 * config editor, neither of which a browser has. Every failure is named rather
 * than collapsed into `undefined`, because "no service", "no config editor" and
 * "the host refused" are three different problems for whoever clicks it.
 *
 * @module dsh-opencode-patch/settings-purge
 */

import {
  purgeRemote,
  type PurgeResult,
  type PurgeReview,
} from "./contracts/purge.ts";
import { callRemote, type RemoteOutcome } from "./settings-remote.ts";

/** What one click produced, in a shape the card can render without guessing. */
export type PurgeOutcome =
  | { readonly kind: "purged"; readonly result: PurgeResult }
  | { readonly kind: "unavailable" }
  | { readonly kind: "failed"; readonly message: string };

/** What the review answered, in the same three shapes. */
export type ReviewOutcome =
  | { readonly kind: "review"; readonly review: PurgeReview }
  | { readonly kind: "unavailable" }
  | { readonly kind: "failed"; readonly message: string };

/** One call's outcome, before it is named for its caller. */
type Settled<Value> =
  | { readonly kind: "value"; readonly value: Value }
  | { readonly kind: "unavailable" }
  | { readonly kind: "failed"; readonly message: string };

/**
 * Call one purge method through the one unwrap (`callRemote`) and name the
 * outcome: the host's own failure first, in its own words, and the result
 * PARSED by the contract's whitelist, never cast.
 *
 * @param call - the call, as `callRemote` answers it.
 * @param invalid - the sentence for an answer the contract rejects.
 * @returns the outcome; never throws.
 */
const settle = async <Value>(
  call: () => Promise<RemoteOutcome<Value>>,
  invalid: string
): Promise<Settled<Value>> => {
  let outcome: RemoteOutcome<Value>;
  try {
    outcome = await call();
  } catch (error: unknown) {
    return {
      kind: "failed",
      message: error instanceof Error ? error.message : String(error),
    };
  }
  if (outcome.kind === "unavailable") {
    return { kind: "unavailable" };
  }
  if (outcome.kind === "refused") {
    return {
      kind: "failed",
      message: outcome.reason ?? "the host refused the purge",
    };
  }
  if (outcome.kind === "invalid") {
    return { kind: "failed", message: invalid };
  }
  return { kind: "value", value: outcome.value };
};

/** A settled purge result, named for the card. */
const asPurge = (settled: Settled<PurgeResult>): PurgeOutcome =>
  settled.kind === "value"
    ? { kind: "purged", result: settled.value }
    : settled;

/**
 * Ask the host to purge, once.
 *
 * @param scope - the settings scope the card was rendered with.
 * @returns the outcome; never throws.
 */
export const purgeDeprecatedModels = async (
  scope: unknown
): Promise<PurgeOutcome> => {
  const settled = await settle(
    () => callRemote<"purge", PurgeResult>(scope, purgeRemote, "purge"),
    "the host answered something that is not a purge result"
  );
  if (settled.kind === "unavailable") {
    console.warn(
      "[dsh-opencode-patch] purge: no opencodeModelPurge service on the remote"
    );
  }
  return asPurge(settled);
};

/**
 * Ask the host which declared ids pi cannot serve. Says nothing in the console
 * when the service is absent: the purge row's own call already says it once.
 *
 * @param scope - the settings scope the card was rendered with.
 * @returns the outcome; never throws.
 */
export const reviewPurge = async (scope: unknown): Promise<ReviewOutcome> => {
  const settled = await settle(
    // Named: the contract's methods answer different results, so the
    // result type is the method's, not one inferred across them.
    () => callRemote<"review", PurgeReview>(scope, purgeRemote, "review"),
    "the host answered something that is not a purge review"
  );
  return settled.kind === "value"
    ? { kind: "review", review: settled.value }
    : settled;
};

/**
 * Ask the host to remove the ids pi cannot serve, once.
 *
 * @param scope - the settings scope the card was rendered with.
 * @returns the outcome; never throws.
 */
export const removeUnservedModels = async (
  scope: unknown
): Promise<PurgeOutcome> =>
  asPurge(
    await settle(
      () =>
        callRemote<"removeUnserved", PurgeResult>(
          scope,
          purgeRemote,
          "removeUnserved"
        ),
      "the host answered something that is not a purge result"
    )
  );
