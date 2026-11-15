/**
 * The inspection service: what the settings card's "check this machine" button
 * actually asks the host.
 *
 * Two properties are asserted, and both are about the seam rather than the UI:
 * the answer carries an identity and never a secret, and the path it reports is
 * `~`-relative so a home directory never reaches the client.
 *
 * The database is built here rather than found, so the suite does not need an
 * OpenCode installation — the path is injected for exactly that reason.
 *
 * @module test/opencode-store-service.test
 */
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import { DatabaseSync } from "node:sqlite";

import { Context } from "@deepseek-ai/cordis";
import { afterEach, describe, expect, it } from "vitest";

import { OpencodeStoreService } from "./support/src.ts";

const temporary: string[] = [];

afterEach(() => {
  for (const directory of temporary.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

/** A database holding one OAuth credential, shaped like a live installation's. */
const oauthDatabase = (expires: number): string => {
  const directory = mkdtempSync(nodePath.join(os.tmpdir(), "opencode-svc-"));
  temporary.push(directory);
  const path = nodePath.join(directory, "opencode.db");
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE credential (
      id TEXT PRIMARY KEY, integration_id TEXT, label TEXT, value TEXT,
      active INTEGER, time_created INTEGER, time_updated INTEGER
    );
    CREATE TABLE account (
      id TEXT PRIMARY KEY, email TEXT, token_expiry INTEGER, time_updated INTEGER
    );
  `);
  db.prepare(
    "INSERT INTO credential (id, integration_id, label, value, active) VALUES (?, ?, ?, ?, ?)"
  ).run(
    "a",
    "opencode",
    "Default",
    JSON.stringify({
      type: "oauth",
      access: "st_fixture_access",
      refresh: "rt_fixture_refresh",
      expires,
      metadata: { email: "someone@example.com", orgName: "Fixture Org" },
    }),
    1
  );
  db.prepare(
    "INSERT INTO account (id, email, token_expiry) VALUES (?, ?, ?)"
  ).run("acc_fixture", "someone@example.com", expires);
  db.close();
  return path;
};

/** The service over an injected path, which is what the seam allows. */
const serviceFor = (path: string): OpencodeStoreService =>
  new OpencodeStoreService(new Context(), {
    resolveStorePath: () => path,
  });

describe("opencode-store-service: the inspection seam", () => {
  it("answers the account, and never the token", async () => {
    const service = serviceFor(oauthDatabase(Date.now() + 86_400_000));
    const result = await service.inspect();
    expect(result.found).toBe(true);
    expect(result.account?.email).toBe("someone@example.com");
    expect(result.account?.orgName).toBe("Fixture Org");
    expect(result.account?.type).toBe("oauth");
    // The one assertion this seam exists for: whatever the store holds, the
    // answer is an identity, not a credential.
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("st_fixture_access");
    expect(serialized).not.toContain("rt_fixture_refresh");
  });

  it("reports the store path without the machine's layout", async () => {
    // A home directory is a fact about this machine. The card may say WHERE it
    // looked — that is what makes a not-found answer actionable — but not the
    // user's layout. A fixture database lives under the temp directory, which is
    // outside the home tree, so this asserts the stricter rule: only the basename.
    const path = oauthDatabase(Date.now() + 86_400_000);
    const result = await serviceFor(path).inspect();
    expect(result.path).toBe("opencode.db");
  });

  it("answers not-found when the injected path holds no database", async () => {
    const result = await serviceFor("/nonexistent/opencode.db").inspect();
    expect(result.found).toBe(false);
    expect(result.account).toBeUndefined();
  });

  it("reports an expired credential as expired", async () => {
    const result = await serviceFor(
      oauthDatabase(Date.now() - 86_400_000)
    ).inspect();
    expect(result.account?.expired).toBe(true);
  });

  it("refuses a context that is not an object, rather than mounting blind", () => {
    expect(() => new OpencodeStoreService(undefined)).toThrow(TypeError);
  });

  it("falls back to the installation's own path when nothing is injected", async () => {
    // The ordinary case: the host mounts the service with no options, so the
    // resolver has to be the default one. Asserted through the answer's shape
    // rather than the path's value — this machine may or may not have OpenCode,
    // and either answer is a correct one for "did it look somewhere".
    const service = new OpencodeStoreService(new Context());
    const result = await service.inspect();
    expect(typeof result.found).toBe("boolean");
  });

  it("ignores an injected resolver that is not a function", async () => {
    // `mountByProvide` passes its `options` through untouched, so a composition
    // that hands over something else must not turn into a crash at call time.
    const service = new OpencodeStoreService(new Context(), {
      resolveStorePath: "not a function",
    });
    const result = await service.inspect();
    expect(typeof result.found).toBe("boolean");
  });

  it("declares `inspect` as a Remote method", async () => {
    // The decorator cannot be used in this build (see `usage.ts`), so the marker
    // is written by hand — and a hand-written marker is exactly the kind that
    // goes missing without a test. `remoteMethods` reads the prototype of the
    // INSTANCE it is given, so an instance is what it gets.
    const { remoteMethods } = await import("@deepseek-ai/dsh-typert-protocol");
    const service = serviceFor(oauthDatabase(Date.now() + 86_400_000));
    const declared = remoteMethods(service).map(
      (method: { method: string }) => method.method
    );
    expect(declared).toContain("inspect");
  });
});
