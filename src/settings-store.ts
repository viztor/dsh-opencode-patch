/**
 * Safe client-side Remote caller for inspecting the local OpenCode installation.
 *
 * Reads through the Cordis remote guard, handles unavailable remote/service,
 * and formats the outcome without throwing or leaking.
 *
 * @module dsh-opencode-patch/settings-store
 */

import {
  parseStoreInspection,
  STORE_NAMESPACE,
  type OpencodeStoreInspection,
} from "./opencode-store-contract.ts";
import { remoteNamespace, remoteNamespaceOf } from "./settings-remote.ts";
import { isRecord } from "./utils/guards.ts";

export type StoreInspectOutcome =
  | { readonly kind: "inspected"; readonly inspection: OpencodeStoreInspection }
  | { readonly kind: "unavailable" }
  | { readonly kind: "failed"; readonly message: string };

const namespaceOf = (scope: unknown) =>
  remoteNamespaceOf(scope, STORE_NAMESPACE) ??
  remoteNamespace(isRecord(scope) ? scope.remote : undefined, STORE_NAMESPACE);

/**
 * Ask the host to inspect the local OpenCode installation.
 *
 * @param scope - the settings scope the card was rendered with.
 * @returns the outcome; never throws.
 */
export const inspectStore = async (
  scope: unknown
): Promise<StoreInspectOutcome> => {
  const namespace = namespaceOf(scope);
  const call = namespace?.inspect;
  if (typeof call !== "function") {
    console.warn(
      "[dsh-opencode-patch] store inspection: no opencodeStore service on the remote"
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
            : "the host could not inspect the installation",
      };
    }
    const value = isRecord(answer) && "value" in answer ? answer.value : answer;
    const inspection: OpencodeStoreInspection | undefined =
      parseStoreInspection(value);
    if (inspection === undefined) {
      return {
        kind: "failed",
        message: "host returned an invalid inspection shape",
      };
    }
    return { inspection, kind: "inspected" };
  } catch (error: unknown) {
    return {
      kind: "failed",
      message: error instanceof Error ? error.message : String(error),
    };
  }
};
