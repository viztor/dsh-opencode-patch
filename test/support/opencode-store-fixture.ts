/**
 * A real OpenCode credential database, for the host-side store readers.
 *
 * Kept out of `test-helpers.ts` on purpose: that module is shared with the
 * jsdom (client) tests, and a `node:sqlite` import there drags a host-only
 * built-in into every client test's module graph. The split is the same one
 * `src/` keeps between the store reader and the client bundle.
 *
 * @module test/support/opencode-store-fixture
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import { DatabaseSync } from "node:sqlite";

/** One row of the installation's `credential` table, as a fixture. */
export interface FixtureCredential {
  /** The integration the credential belongs to: `opencode`, `opencode-go`, … */
  integrationId: string;
  /** The credential's own name; defaults to the integration id. */
  label?: string;
  /** The secret. A fixture shaped like one, never a real credential. */
  value: string;
  /** `1` for the credential in use, `0` for one the user already replaced. */
  active?: number;
}

/** One row of the installation's `account` table, plus the state that owns it. */
export interface FixtureAccount {
  /** The access token. A fixture shaped like one, never a real credential. */
  accessToken: string;
  /** The account's email; not a secret, and not required. */
  email?: string;
  /** The org the account is active in, written to `account_state`. */
  orgId?: string;
  /** The refresh token, when the fixture should carry one. */
  refreshToken?: string;
  /**
   * The stored expiry, in epoch milliseconds.
   *
   * Deliberately a knob: the plugin uses a stored account whatever this says,
   * and a fixture has to be able to put it in the past to prove that.
   */
  tokenExpiry?: number;
}

/** A credential store the test owns, and the way to point the reader at it. */
export interface FixtureStore {
  /** Set this as `$XDG_DATA_HOME`: the reader resolves its path from it. */
  root: string;
  /** Remove the whole root. Call from `afterEach`. */
  cleanup: () => void;
}

/**
 * Build an OpenCode credential database in a temporary XDG data root.
 *
 * The reader resolves its own path from the environment, so a fixture is not a
 * mock: this writes the real schema to a real SQLite file and hands back the
 * root to export, which is the only thing that makes the store this test's
 * rather than whatever the machine happens to have installed.
 *
 * @param credentials - the rows to insert, in order.
 * @param account - the stored login, when the fixture should have one.
 * @returns the data root and its cleanup.
 */
export const createOpencodeStore = (
  credentials: readonly FixtureCredential[],
  account?: FixtureAccount
): FixtureStore => {
  const root = mkdtempSync(
    nodePath.join(os.tmpdir(), "opencode-store-fixture-")
  );
  const directory = nodePath.join(root, "opencode");
  mkdirSync(directory, { recursive: true });
  const database = new DatabaseSync(nodePath.join(directory, "opencode.db"));
  database.exec(`
    CREATE TABLE credential (
      id TEXT PRIMARY KEY, integration_id TEXT, label TEXT, value TEXT,
      connector_id TEXT, method_id TEXT, active INTEGER,
      time_created INTEGER, time_updated INTEGER
    );
    CREATE TABLE account (
      id TEXT PRIMARY KEY, email TEXT, url TEXT, access_token TEXT,
      refresh_token TEXT, token_expiry INTEGER,
      time_created INTEGER, time_updated INTEGER
    );
    CREATE TABLE account_state (
      id INTEGER PRIMARY KEY, active_account_id TEXT, active_org_id TEXT
    );
  `);
  const insert = database.prepare(
    "INSERT INTO credential (id, integration_id, label, value, active) VALUES (?, ?, ?, ?, ?)"
  );
  for (const [index, credential] of credentials.entries()) {
    insert.run(
      `fixture-${index}`,
      credential.integrationId,
      credential.label ?? credential.integrationId,
      credential.value,
      credential.active ?? 1
    );
  }
  if (account !== undefined) {
    database
      .prepare(
        "INSERT INTO account (id, email, url, access_token, refresh_token, token_expiry) VALUES (?, ?, ?, ?, ?, ?)"
      )
      .run(
        "fixture-account",
        account.email ?? "you@example.com",
        "https://opencode.ai/console",
        account.accessToken,
        account.refreshToken ?? "",
        account.tokenExpiry ?? null
      );
    // The org lives in its own table, and only the active row is read.
    database
      .prepare(
        "INSERT INTO account_state (id, active_account_id, active_org_id) VALUES (?, ?, ?)"
      )
      .run(1, "fixture-account", account.orgId ?? null);
  }
  database.close();
  return {
    cleanup: () => {
      rmSync(root, { force: true, recursive: true });
    },
    root,
  };
};
