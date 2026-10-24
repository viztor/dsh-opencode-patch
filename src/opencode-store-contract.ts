/**
 * Contract for inspecting a local OpenCode installation's credentials.
 *
 * Pure data types, no I/O, no context, safely imported by host and client.
 *
 * @module dsh-opencode-patch/opencode-store-contract
 */

import type { TypertRemoteContribution } from "@deepseek-ai/dsh-typert-protocol";

import { isRecord } from "./utils/guards.ts";

export const STORE_NAMESPACE = "opencodeStore";

/** Sanitized summary of an account found in the local OpenCode installation. */
export interface OpencodeStoreAccount {
  readonly accountId?: string;
  readonly email?: string;
  readonly expired?: boolean;
  readonly expiresAt?: string;
  readonly label?: string;
  readonly orgName?: string;
  /**
   * Whether the store also holds a refresh token.
   *
   * It changes what an expired access token MEANS: a session that can refresh is
   * renewed the next time the CLI uses it, so reporting it as a failure would be
   * a false alarm on the ordinary state of a working installation.
   */
  readonly refreshable?: boolean;
  readonly type: "oauth" | "key" | "unknown";
}

/** Result of inspecting the local OpenCode installation. */
export interface OpencodeStoreInspection {
  readonly account?: OpencodeStoreAccount;
  readonly found: boolean;
  readonly message?: string;
  readonly path?: string;
}

const ACCOUNT_TYPES: ReadonlySet<string> = new Set(["oauth", "key", "unknown"]);

/** The string fields of an account summary the client may read. */
const ACCOUNT_STRINGS = [
  "accountId",
  "email",
  "expiresAt",
  "label",
  "orgName",
] as const;

/**
 * Parse an account summary through a whitelist, or `undefined` when its shape
 * is not one. Unknown fields are dropped rather than passed on: whatever the host
 * adds later reaches the client only by being named here.
 */
const parseAccount = (value: unknown): OpencodeStoreAccount | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }
  const raw = value;
  if (typeof raw.type !== "string" || !ACCOUNT_TYPES.has(raw.type)) {
    return undefined;
  }
  const account: Record<string, unknown> = { type: raw.type };
  for (const field of ACCOUNT_STRINGS) {
    if (typeof raw[field] === "string") {
      account[field] = raw[field];
    }
  }
  for (const field of ["expired", "refreshable"] as const) {
    if (typeof raw[field] === "boolean") {
      account[field] = raw[field];
    }
  }
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- built field by field from the whitelist above.
  return account as unknown as OpencodeStoreAccount;
};

/**
 * Parse an inspection answer, or `undefined` when it is not one.
 *
 * The same rule as the login contract's: a whitelist, so a field the host did
 * not mean to send — a token, say — cannot reach the card by accident.
 *
 * @param value - what the remote answered.
 * @returns the inspection, or `undefined`.
 */
export const parseStoreInspection = (
  value: unknown
): OpencodeStoreInspection | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }
  const raw = value;
  if (typeof raw.found !== "boolean") {
    return undefined;
  }
  const account =
    raw.account === undefined ? undefined : parseAccount(raw.account);
  if (raw.account !== undefined && account === undefined) {
    return undefined;
  }
  return {
    found: raw.found,
    ...(account === undefined ? {} : { account }),
    ...(typeof raw.message === "string" ? { message: raw.message } : {}),
    ...(typeof raw.path === "string" ? { path: raw.path } : {}),
  };
};

/** The wire codec for one inspection, in the shape `usageCodec` uses. */
const storeInspectionCodec = {
  create: () => ({ parse: parseStoreInspection }),
  mode: "strict" as const,
  schema: { parse: parseStoreInspection },
  typeSymbol: "dsh-opencode-patch#OpencodeStoreInspection",
};

/**
 * The store-inspection namespace, as a contribution the client mounts.
 *
 * **Without it the card's inspection row could never answer.** A Remote is only
 * reachable from the browser when a contribution carrying its descriptor was
 * mounted on the client — the same finding `purgeRemote` records — and this one
 * was not: the host mounted the service, and the row reported "unavailable".
 */
export const storeRemote: TypertRemoteContribution = {
  descriptors: [
    {
      id: "dsh-opencode-patch#opencodeStore/inspect",
      invocation: { kind: "direct" },
      method: "inspect",
      namespace: STORE_NAMESPACE,
      parameters: [],
      result: storeInspectionCodec,
      service: STORE_NAMESPACE,
    },
  ],
  package: "dsh-opencode-patch",
};
