/**
 * Reading the credentials an OpenCode installation already holds.
 *
 * This is the opt-in half of the credential story: a user who has signed in to
 * OpenCode should not have to sign in again here. It is off by default and a
 * credential declared in DSH always wins — reading another tool's store is
 * something a user turns on, not something that happens to them.
 *
 * Two rules shape everything below.
 *
 * - **Nothing throws.** A missing file, an unreadable file, a database from a
 *   different version and a table that is not there are all the ordinary case, and
 *   every one of them answers `undefined`. A reader that fails loudly on a machine
 *   without OpenCode installed would be a bug in the plugin.
 * - **A value never leaves this module's return value.** No logging, no error
 *   message carrying a token, no shape that reaches the client bundle. The caller
 *   decides what to do with a secret; this module only finds it.
 *
 * `node:sqlite` is a host-only built-in, which is what keeps this module on the host
 * side of the bundle rule rather than in the client.
 *
 * @module dsh-opencode-patch/opencode-store
 */

import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import type { OpencodeStoreInspection } from "./opencode-store-contract.ts";
import { isRecord } from "./utils/guards.ts";

/** A credential as the installation stores it, minus everything unused. */
export interface OpencodeCredential {
  /** The provider the credential is for, as `integration_id` carries it. */
  readonly integrationId: string;
  /** The credential's own name, for a report that names what it found. */
  readonly label: string;
  /** The secret. Never logged, never returned to the client bundle. */
  readonly value: string;
}

/**
 * The bearer token a credential row actually carries.
 *
 * Measured against a real installation: EVERY row's `value` is a JSON document
 * rather than a bare key, and the shape varies by integration. `cf-coding`,
 * `google`, `nvidia`, `opencode` and the two Cloudflare ones carry
 * `{ type, key, metadata? }`; the exception is `xai`, which carries
 * `{ type, methodID, refresh, access, expires }` and is an OAuth grant.
 *
 * So the raw column is not a credential. Handing it to a Bearer header puts a JSON
 * document where a key belongs, and the gateway answers `Invalid credential` or,
 * on the free tier, a refusal that reads as though the model itself were unusable -
 * which is exactly the wrong conclusion to draw from it. The whole document is also
 * how a secret ends up in a log.
 *
 * @param value - the raw `value` column.
 * @returns the key, the OAuth access token, or `undefined` for an unknown shape.
 */
const credentialToken = (value: string): string | undefined => {
  if (!value.trimStart().startsWith("{")) {
    // A bare key, which is what the JSON shapes wrap. Kept because a deployment may
    // legitimately hold one.
    return value;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) {
    return undefined;
  }
  // Only the fields OpenCode itself declares: `key` for an API key, `access` for an
  // OAuth grant. Anything else answers `undefined` rather than being guessed at,
  // because a wrong token and no token are equally useless but only one is honest.
  for (const field of ["key", "access"]) {
    const candidate = parsed[field];
    if (typeof candidate === "string" && candidate.length > 0) {
      return candidate;
    }
  }
  return undefined;
};

/** A text column, or `undefined` when the row holds something else. */
const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

/** The rows a query returned, or `undefined` when anything at all went wrong. */
const rows = (
  path: string,
  sql: string
): readonly Record<string, unknown>[] | undefined => {
  let database: DatabaseSync | undefined;
  try {
    // Read-only, so a reader can never write to another tool's store even if the
    // query below were wrong.
    database = new DatabaseSync(path, { readOnly: true });
    return database.prepare(sql).all();
  } catch {
    // A missing file, a locked file, a different schema version: all ordinary, and
    // all indistinguishable from each other in a way that does not matter here.
    return undefined;
  } finally {
    try {
      database?.close();
    } catch {
      // Closing a connection that already failed is not worth reporting.
    }
  }
};

/**
 * The active credentials the installation holds, or `undefined` when it holds none
 * this module can read.
 *
 * Only active rows are returned: an inactive credential is one the user has already
 * replaced, and offering it would resurrect a key they retired.
 *
 * @param databasePath - the path {@link opencodeDatabasePath} resolved, or `:memory:`.
 * @returns the credentials, or `undefined`.
 */
export const readOpencodeCredentials = (
  databasePath: string
): readonly OpencodeCredential[] | undefined => {
  if (databasePath === ":memory:") {
    return undefined;
  }
  const found = rows(
    databasePath,
    // `active = 1` alone is wrong on a real installation. Measured: every row in
    // the live database has `active IS NULL`, because they are legacy rows written
    // before the flag existed, and OpenCode's own rule is that legacy rows carry no
    // flag and the NEWEST one is selected. So the explicit flag wins when any row
    // sets it, and otherwise the legacy rows are read newest-first rather than
    // being dropped - which is the difference between this reader working and
    // answering nothing on a machine that does have credentials.
    //
    // The fallback is PER INTEGRATION. Uncorrelated, one flagged `opencode-go`
    // row hid every legacy `opencode` row, so the Zen key vanished from the
    // reader while the inspector, which reads `opencode` alone, still said "ok".
    `SELECT c.integration_id AS integrationId, c.label, c.value FROM credential c
     WHERE c.active = 1
        OR (c.active IS NULL AND NOT EXISTS (
              SELECT 1 FROM credential f
              WHERE f.active = 1 AND f.integration_id = c.integration_id))
     ORDER BY c.time_updated DESC`
  );
  if (found === undefined) {
    return undefined;
  }
  const credentials = found.flatMap((row) => {
    const integrationId = text(row.integrationId);
    const token = credentialToken(text(row.value) ?? "");
    if (integrationId === undefined || token === undefined) {
      return [];
    }
    return [
      { integrationId, label: text(row.label) ?? integrationId, value: token },
    ];
  });
  return credentials.length === 0 ? undefined : credentials;
};

/** What one stored credential document contributes to the summary. */
export interface CredentialSummary {
  readonly email?: string;
  readonly expired?: boolean;
  readonly expiresAt?: string;
  readonly orgName?: string;
  readonly refreshable?: boolean;
  readonly type: "oauth" | "key" | "unknown";
}

/**
 * Summarize one credential document, keeping only what identifies it.
 *
 * PURE, and extracted for that reason: every shape a real store can hold — the
 * JSON document an OAuth session is, the JSON document an API key is, a bare key
 * from an older version, and something malformed — is a branch a test can hand
 * this function directly. Buried in the query above, the same branches would only
 * be reachable by building a database per case.
 *
 * The token is never read: `key` and `access` are simply not consulted. `refresh`
 * is looked at only to answer whether one EXISTS — its value never leaves this
 * function — because that is what decides whether a lapsed session is a problem.
 *
 * @param raw - the `value` column, verbatim.
 * @returns the identifying fields, with `type` always present.
 */
export const summarizeCredential = (raw: string): CredentialSummary => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Not JSON. A bare key is what an older installation stored; anything else
    // is a document this module does not understand, and saying so is better
    // than calling it a key.
    return { type: raw.trimStart().startsWith("{") ? "unknown" : "key" };
  }
  if (!isRecord(parsed)) {
    return { type: "unknown" };
  }
  const kind = parsed.type;
  const meta = isRecord(parsed.metadata) ? parsed.metadata : {};
  const { email, orgName } = meta;
  const { expires, refresh } = parsed;
  return {
    ...(typeof email === "string" ? { email } : {}),
    ...(typeof expires === "number"
      ? {
          expired: expires < Date.now(),
          expiresAt: new Date(expires).toISOString(),
        }
      : {}),
    ...(typeof orgName === "string" ? { orgName } : {}),
    ...(typeof refresh === "string" ? { refreshable: true } : {}),
    type: kind === "oauth" || kind === "key" ? kind : "unknown",
  };
};

/**
 * Inspect the local OpenCode installation to summarize stored account information
 * WITHOUT exposing any secret tokens.
 *
 * Checks database existence, parses the primary active credential and/or
 * account row, and extracts email, organization, account type, and expiry date.
 *
 * @param databasePath - path to opencode.db or :memory:
 * @returns inspection summary with zero secrets
 */
export const inspectOpencodeStore = (
  databasePath: string
): OpencodeStoreInspection => {
  if (databasePath === ":memory:" || !existsSync(databasePath)) {
    return { found: false, message: "not_found" };
  }

  const credRows = rows(
    databasePath,
    `SELECT integration_id AS integrationId, label, value FROM credential
     WHERE integration_id = 'opencode'
     ORDER BY active DESC, time_updated DESC`
  );

  const accountRows = rows(
    databasePath,
    `SELECT id, email, token_expiry AS tokenExpiry FROM account
     ORDER BY time_updated DESC LIMIT 1`
  );

  // The account row first: it is the installation's own record of who is signed
  // in, and the credential's metadata is a copy of it. Reading in this order
  // means the credential only fills gaps rather than overwriting.
  const [account] = accountRows ?? [];
  const [primary] = credRows ?? [];
  const summary =
    primary === undefined
      ? undefined
      : summarizeCredential(text(primary.value) ?? "");

  const email = text(account?.email) ?? summary?.email;
  const expiresAt =
    typeof account?.tokenExpiry === "number"
      ? new Date(account.tokenExpiry).toISOString()
      : summary?.expiresAt;
  const expired =
    typeof account?.tokenExpiry === "number"
      ? account.tokenExpiry < Date.now()
      : summary?.expired;
  const label = primary === undefined ? undefined : text(primary.label);
  const accountId = text(account?.id);
  const orgName = summary?.orgName;
  const refreshable = summary?.refreshable;
  const type = summary?.type ?? "unknown";

  if (email === undefined && label === undefined && type === "unknown") {
    return {
      found: true,
      message: "no_credentials_in_store",
      path: databasePath,
    };
  }

  return {
    account: {
      accountId,
      email,
      expired,
      expiresAt,
      label,
      orgName,
      refreshable,
      type,
    },
    found: true,
    message: "ok",
    path: databasePath,
  };
};
