/**
 * Safe client-side Remote caller for inspecting the local OpenCode installation.
 *
 * Reads through the Cordis remote guard, handles unavailable remote/service,
 * and formats the outcome without throwing or leaking.
 *
 * @module dsh-opencode-patch/settings-store
 */

import {
  storeRemote,
  type OpencodeStoreInspection,
} from "./contracts/store.ts";
import { callRemote, type RemoteOutcome } from "./settings-remote.ts";

export type StoreInspectOutcome =
  | { readonly kind: "inspected"; readonly inspection: OpencodeStoreInspection }
  | { readonly kind: "unavailable" }
  | { readonly kind: "failed"; readonly message: string };

/**
 * Ask the host to inspect the local OpenCode installation.
 *
 * @param scope - the settings scope the card was rendered with.
 * @returns the outcome; never throws.
 */
export const inspectStore = async (
  scope: unknown
): Promise<StoreInspectOutcome> => {
  let outcome: RemoteOutcome<OpencodeStoreInspection>;
  try {
    outcome = await callRemote(scope, storeRemote, "inspect");
  } catch (error: unknown) {
    return {
      kind: "failed",
      message: error instanceof Error ? error.message : String(error),
    };
  }
  if (outcome.kind === "unavailable") {
    console.warn(
      "[dsh-opencode-patch] store inspection: no opencodeStore service on the remote"
    );
    return { kind: "unavailable" };
  }
  if (outcome.kind === "refused") {
    // The remote's own failure, said in its own words rather than as a
    // shape error about the envelope it arrived in.
    return {
      kind: "failed",
      message: outcome.reason ?? "the host could not inspect the installation",
    };
  }
  if (outcome.kind === "invalid") {
    return {
      kind: "failed",
      message: "host returned an invalid inspection shape",
    };
  }
  return { inspection: outcome.value, kind: "inspected" };
};
