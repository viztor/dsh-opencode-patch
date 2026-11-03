/**
 * The reader, against databases this test builds rather than one that exists.
 *
 * Every case makes its own SQLite file with the schema the installation uses, so
 * the queries are exercised for real — `node:sqlite` is the same driver the plugin
 * uses — without depending on a machine that has OpenCode installed.
 *
 * The values here are fixtures. They are shaped like secrets because the reader's
 * job is to carry them, and they are not secrets because nothing in this repository
 * ever holds a real one.
 *
 * @module dsh-opencode-patch/opencode-store.test
 */

import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import {
  inspectOpencodeStore,
  readOpencodeCredentials,
  summarizeCredential,
} from "../src/opencode-store.ts";

const temporary: string[] = [];

/** A database at a fresh path, built by `create`. */
const database = (create: (db: DatabaseSync) => void): string => {
  const directory = mkdtempSync(nodePath.join(os.tmpdir(), "opencode-store-"));
  temporary.push(directory);
  const path = nodePath.join(directory, "opencode.db");
  const db = new DatabaseSync(path);
  create(db);
  db.close();
  return path;
};

/** The schema, as the installation ships it, trimmed to the columns read. */
const schema = (db: DatabaseSync): void => {
  db.exec(`
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
      id TEXT PRIMARY KEY, active_account_id TEXT, active_org_id TEXT
    );
  `);
};

const addCredential = (
  db: DatabaseSync,
  id: string,
  integrationId: string,
  value: string,
  active: number,
  label?: string
): void => {
  db.prepare(
    "INSERT INTO credential (id, integration_id, label, value, active) VALUES (?, ?, ?, ?, ?)"
  ).run(id, integrationId, label ?? integrationId, value, active);
};

afterEach(() => {
  for (const directory of temporary.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("opencode-store: credentials", () => {
  it("returns the active rows, keyed by integration", () => {
    const path = database((db) => {
      schema(db);
      addCredential(db, "a", "opencode", "oc_sk_fixture_zen", 1, "Zen");
      addCredential(db, "b", "opencode-go", "sk-fixture-go", 1, "Go");
    });
    const found = readOpencodeCredentials(path);
    expect(found).toHaveLength(2);
    const integrations = found?.map((entry) => entry.integrationId) ?? [];
    expect(integrations).toHaveLength(2);
    expect(integrations).toEqual(
      expect.arrayContaining(["opencode", "opencode-go"])
    );
    expect(
      found?.find((entry) => entry.integrationId === "opencode")?.label
    ).toBe("Zen");
  });

  it("reads legacy rows that carry no active flag at all", () => {
    // Measured on a real installation: every row has `active IS NULL`, written
    // before the flag existed. Filtering on `active = 1` alone answered nothing
    // there, which is the difference between this reader working and not.
    const path = database((db) => {
      schema(db);
      db.prepare(
        "INSERT INTO credential (id, integration_id, label, value, active, time_updated) VALUES (?, ?, ?, ?, NULL, ?)"
      ).run("legacy", "opencode", "Zen", "oc_sk_fixture_legacy", 100);
    });
    const found = readOpencodeCredentials(path);
    expect(found).toHaveLength(1);
    expect(found?.[0]?.value).toBe("oc_sk_fixture_legacy");
  });

  it("prefers an explicit active flag over legacy rows", () => {
    // Legacy rows are the fallback, not an addition: once any row sets the flag,
    // that is the user's selection and the unflagged rows are the old ones.
    const path = database((db) => {
      schema(db);
      db.prepare(
        "INSERT INTO credential (id, integration_id, label, value, active, time_updated) VALUES (?, ?, ?, ?, NULL, ?)"
      ).run("legacy", "opencode", "Old", "oc_sk_fixture_legacy", 100);
      addCredential(db, "new", "opencode", "oc_sk_fixture_new", 1);
    });
    const found = readOpencodeCredentials(path);
    expect(found).toHaveLength(1);
    expect(found?.[0]?.value).toBe("oc_sk_fixture_new");
  });

  it("falls back to legacy rows per integration, not across the table", () => {
    // A flagged Go row is the Go selection only. Read across the table, it hid
    // the legacy Zen row and the reader answered with no Zen key at all.
    const path = database((db) => {
      schema(db);
      addCredential(db, "go", "opencode-go", "oc_sk_fixture_go", 1);
      db.prepare(
        "INSERT INTO credential (id, integration_id, label, value, active, time_updated) VALUES (?, ?, ?, ?, NULL, ?)"
      ).run("legacy", "opencode", "Zen", "oc_sk_fixture_zen_legacy", 100);
    });
    const found = readOpencodeCredentials(path);
    expect(
      found?.map((row) => `${row.integrationId}=${row.value}`).toSorted()
    ).toEqual([
      "opencode-go=oc_sk_fixture_go",
      "opencode=oc_sk_fixture_zen_legacy",
    ]);
  });

  it("extracts the key from the JSON every real row carries", () => {
    // Measured against a live installation: EVERY value is a JSON document, not a
    // bare key. Returning the document puts JSON in the Bearer header, and the
    // gateway answers `Invalid credential` - or, on the free tier, a refusal that
    // reads as though the model were unusable. That is the wrong conclusion to
    // draw, and this is the reader that caused it.
    const path = database((db) => {
      schema(db);
      db.prepare(
        "INSERT INTO credential (id, integration_id, label, value, active, time_updated) VALUES (?, ?, ?, ?, NULL, ?)"
      ).run(
        "a",
        "opencode",
        "Zen",
        JSON.stringify({ type: "apiKey", key: "oc_sk_fixture_zen" }),
        100
      );
    });
    const found = readOpencodeCredentials(path);
    expect(found).toHaveLength(1);
    expect(found?.[0]?.value).toBe("oc_sk_fixture_zen");
  });

  it("carries an OAuth grant's access token rather than the whole grant", () => {
    // `xai` is shaped differently - { type, methodID, refresh, access, expires } -
    // so the reader claims only the two fields OpenCode itself declares.
    const path = database((db) => {
      schema(db);
      db.prepare(
        "INSERT INTO credential (id, integration_id, label, value, active, time_updated) VALUES (?, ?, ?, ?, NULL, ?)"
      ).run(
        "x",
        "xai",
        "xAI",
        JSON.stringify({
          type: "oauth",
          methodID: "token",
          refresh: "fixture-refresh",
          access: "fixture-access",
          expires: 1_700_000_000_000,
        }),
        100
      );
    });
    expect(readOpencodeCredentials(path)?.[0]?.value).toBe("fixture-access");
  });

  it("drops a row whose value shape it does not claim", () => {
    const path = database((db) => {
      schema(db);
      db.prepare(
        "INSERT INTO credential (id, integration_id, label, value, active, time_updated) VALUES (?, ?, ?, ?, NULL, ?)"
      ).run(
        "u",
        "mystery",
        "?",
        JSON.stringify({ type: "whatever", token: "nope" }),
        100
      );
    });
    expect(readOpencodeCredentials(path)).toBeUndefined();
  });

  it("leaves an inactive credential behind", () => {
    // A retired key is one the user already replaced; offering it would resurrect
    // the thing they retired.
    const path = database((db) => {
      schema(db);
      addCredential(db, "old", "opencode", "oc_sk_fixture_old", 0);
      addCredential(db, "new", "opencode", "oc_sk_fixture_new", 1);
    });
    const found = readOpencodeCredentials(path);
    expect(found).toHaveLength(1);
    expect(found?.[0]?.value).toBe("oc_sk_fixture_new");
  });

  it("skips a row with no integration or no value rather than inventing one", () => {
    const path = database((db) => {
      schema(db);
      db.prepare(
        "INSERT INTO credential (id, integration_id, label, value, active) VALUES (?, ?, ?, ?, ?)"
      ).run("c", "", "", "orphan", 1);
      addCredential(db, "d", "opencode", "oc_sk_fixture_ok", 1);
    });
    const found = readOpencodeCredentials(path);
    expect(found).toHaveLength(1);
    expect(found?.[0]?.value).toBe("oc_sk_fixture_ok");
  });

  it("answers undefined for an installation with none", () => {
    const path = database(schema);
    expect(readOpencodeCredentials(path)).toBeUndefined();
  });
});

describe("opencode-store: inspection", () => {
  /** An OAuth row shaped exactly like a live installation's. */
  const oauthValue = (expires: number): string =>
    JSON.stringify({
      type: "oauth",
      methodID: "device",
      refresh: "rt_fixture_refresh",
      access: "st_fixture_access",
      expires,
      metadata: {
        accountID: "acc_fixture",
        email: "someone@example.com",
        orgID: "wrk_fixture",
        orgName: "Fixture Org",
      },
    });

  it("summarizes the account without ever carrying the token", () => {
    // The whole point of this reader: the switch is a permission, and the answer
    // to "what would it read?" must be an identity, never a secret.
    const future = Date.now() + 86_400_000;
    const path = database((db) => {
      schema(db);
      addCredential(db, "a", "opencode", oauthValue(future), 1, "Default");
      db.prepare(
        "INSERT INTO account (id, email, token_expiry) VALUES (?, ?, ?)"
      ).run("acc_fixture", "someone@example.com", future);
    });
    const result = inspectOpencodeStore(path);
    expect(result.found).toBe(true);
    expect(result.account?.email).toBe("someone@example.com");
    expect(result.account?.orgName).toBe("Fixture Org");
    expect(result.account?.type).toBe("oauth");
    expect(result.account?.expired).toBe(false);
    expect(result.account?.expiresAt).toBe(new Date(future).toISOString());
    // Nothing that looks like key material survived into the answer.
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("st_fixture_access");
    expect(serialized).not.toContain("rt_fixture_refresh");
  });

  it("reports an expired credential as expired", () => {
    // Reachable in normal use: a session that lapsed still sits in the store, and
    // a switch that reads it would resolve nothing. The card has to be able to say
    // that rather than showing a green check.
    const past = Date.now() - 86_400_000;
    const path = database((db) => {
      schema(db);
      addCredential(db, "a", "opencode", oauthValue(past), 1);
    });
    const result = inspectOpencodeStore(path);
    expect(result.found).toBe(true);
    expect(result.account?.expired).toBe(true);
  });

  it("reads a bare API key row as an API key", () => {
    const path = database((db) => {
      schema(db);
      addCredential(db, "a", "opencode", "oc_sk_fixture_key", 1, "API key");
    });
    const result = inspectOpencodeStore(path);
    expect(result.account?.type).toBe("key");
    expect(result.account?.label).toBe("API key");
  });

  it("says the store exists when it holds no OpenCode credential", () => {
    const path = database((db) => {
      schema(db);
      addCredential(db, "a", "opencode-go", "sk-fixture-go", 1);
    });
    const result = inspectOpencodeStore(path);
    expect(result.found).toBe(true);
    expect(result.account).toBeUndefined();
    expect(result.message).toBe("no_credentials_in_store");
  });

  it("answers not-found for a path that does not exist", () => {
    expect(inspectOpencodeStore("/nonexistent/opencode.db")).toEqual({
      found: false,
      message: "not_found",
    });
  });

  it("answers not-found for :memory: rather than opening a throwaway database", () => {
    expect(inspectOpencodeStore(":memory:")).toEqual({
      found: false,
      message: "not_found",
    });
  });

  it("still answers when the database carries no account table", () => {
    // A store from a version that wrote only credentials. `rows` answers
    // `undefined` for a query that cannot run, and the inspection has to read
    // that as "no account row" rather than as "nothing here".
    const path = database((db) => {
      db.exec(`
        CREATE TABLE credential (
          id TEXT PRIMARY KEY, integration_id TEXT, label TEXT, value TEXT,
          active INTEGER, time_created INTEGER, time_updated INTEGER
        );
      `);
      addCredential(db, "a", "opencode", "oc_sk_fixture_bare", 1, "API key");
    });
    const result = inspectOpencodeStore(path);
    expect(result.found).toBe(true);
    expect(result.account?.type).toBe("key");
    expect(result.account?.label).toBe("API key");
  });

  it("answers no-credential-in-store when the database carries no credential table", () => {
    const path = database((db) => {
      db.exec(
        "CREATE TABLE account (id TEXT PRIMARY KEY, email TEXT, token_expiry INTEGER, time_updated INTEGER)"
      );
    });
    const result = inspectOpencodeStore(path);
    expect(result.found).toBe(true);
    expect(result.account).toBeUndefined();
  });

  it("prefers the account row's expiry over the credential's copy", () => {
    // Both records carry an expiry and they can disagree (one is written on
    // refresh, the other on login). The account row is the installation's own
    // record of the session, so it wins.
    const accountExpiry = Date.now() + 86_400_000;
    const credentialExpiry = Date.now() - 86_400_000;
    const path = database((db) => {
      schema(db);
      addCredential(
        db,
        "a",
        "opencode",
        JSON.stringify({ type: "oauth", expires: credentialExpiry }),
        1
      );
      db.prepare(
        "INSERT INTO account (id, email, token_expiry) VALUES (?, ?, ?)"
      ).run("acc_fixture", "someone@example.com", accountExpiry);
    });
    const result = inspectOpencodeStore(path);
    expect(result.account?.expired).toBe(false);
    expect(result.account?.expiresAt).toBe(
      new Date(accountExpiry).toISOString()
    );
  });

  it("omits an expiry the account row does not carry", () => {
    const path = database((db) => {
      schema(db);
      db.prepare(
        "INSERT INTO account (id, email, token_expiry) VALUES (?, ?, NULL)"
      ).run("acc_fixture", "someone@example.com");
    });
    const result = inspectOpencodeStore(path);
    expect(result.account?.email).toBe("someone@example.com");
    expect(result.account?.expiresAt).toBeUndefined();
  });
});

describe("opencode-store: one credential document", () => {
  it("reads an OAuth document's identity, and its expiry", () => {
    const expires = Date.now() + 86_400_000;
    const summary = summarizeCredential(
      JSON.stringify({
        type: "oauth",
        access: "st_fixture_access",
        refresh: "rt_fixture_refresh",
        expires,
        metadata: { email: "someone@example.com", orgName: "Fixture Org" },
      })
    );
    expect(summary).toEqual({
      email: "someone@example.com",
      expired: false,
      expiresAt: new Date(expires).toISOString(),
      orgName: "Fixture Org",
      refreshable: true,
      type: "oauth",
    });
  });

  it("never returns the token fields it was handed", () => {
    const summary = summarizeCredential(
      JSON.stringify({
        type: "key",
        key: "oc_sk_fixture_secret",
        metadata: { email: "someone@example.com" },
      })
    );
    expect(JSON.stringify(summary)).not.toContain("oc_sk_fixture_secret");
    expect(summary.type).toBe("key");
  });

  it("reads a bare key from an older installation as a key", () => {
    expect(summarizeCredential("oc_sk_fixture_bare")).toEqual({ type: "key" });
  });

  it("calls a malformed document unknown rather than guessing", () => {
    // Truncated JSON is what a crashed write leaves behind. Calling it a key
    // would put a Bearer header on a document that is not one.
    expect(summarizeCredential('{"type":"oauth",')).toEqual({
      type: "unknown",
    });
  });

  it("calls a document whose kind it cannot place unknown", () => {
    expect(summarizeCredential(JSON.stringify({ type: "mystery" }))).toEqual({
      type: "unknown",
    });
  });

  it("calls a JSON document that is not an object unknown", () => {
    expect(summarizeCredential("null")).toEqual({ type: "unknown" });
  });

  it("survives metadata that is not an object", () => {
    expect(
      summarizeCredential(JSON.stringify({ type: "key", metadata: "junk" }))
    ).toEqual({ type: "key" });
  });
});
