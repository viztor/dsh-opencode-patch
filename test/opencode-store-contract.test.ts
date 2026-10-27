/**
 * `opencode-store-contract.ts` · the inspection's whitelist and its Remote.
 *
 * The contract is the one place a field the host did not mean to send — a
 * token, say — is dropped before it can reach the card, so the whitelist is
 * asserted field by field, and the descriptor the client mounts is asserted
 * against the parser it carries rather than against a copy of it.
 *
 * @module test/opencode-store-contract.test
 */

import { describe, expect, it } from "vitest";

import {
  type OpencodeStoreAccount,
  parseStoreInspection,
  STORE_NAMESPACE,
  storeRemote,
} from "./support/src.ts";

describe("opencode-store-contract · parseStoreInspection", () => {
  it("parseStoreInspection keeps the whitelisted fields and drops a token the host never meant to send", () => {
    // Every field of the contract's own account, through `satisfies Required`:
    // a field the type loses fails the excess-property check, and a field it
    // gains fails the check until the fixture carries it. The input is built
    // from the fixture, so a gained field then reaches the parser too, and the
    // comparison fails until the whitelist keeps it.
    const whitelisted = {
      accountId: "acc_1",
      email: "you@example.com",
      expired: true,
      expiresAt: "2026-01-01T00:00:00.000Z",
      label: "Work",
      orgName: "Org",
      refreshable: false,
      type: "oauth",
    } satisfies Required<OpencodeStoreAccount>;
    const result = parseStoreInspection({
      account: { ...whitelisted, token: "secret" },
      found: true,
      message: "m",
      path: "opencode.db",
    });
    expect(result).toEqual({
      account: whitelisted,
      found: true,
      message: "m",
      path: "opencode.db",
    });
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  it("parseStoreInspection drops account fields of the wrong type rather than refusing the account", () => {
    expect(
      parseStoreInspection({
        account: { email: 7, expired: "yes", refreshable: 1, type: "key" },
        found: true,
      })
    ).toEqual({ account: { type: "key" }, found: true });
  });

  it("parseStoreInspection answers undefined for anything that is not an inspection", () => {
    for (const value of [
      undefined,
      null,
      "x",
      7,
      {},
      { found: "yes" },
      { account: "oauth", found: true },
      { account: {}, found: true },
      { account: { type: "nope" }, found: true },
    ]) {
      expect(
        parseStoreInspection(value),
        JSON.stringify(value)
      ).toBeUndefined();
    }
    expect(
      parseStoreInspection({ found: false, message: 5, path: null })
    ).toEqual({ found: false });
  });
});

describe("opencode-store-contract · storeRemote", () => {
  it("storeRemote declares one direct inspect descriptor whose codec is parseStoreInspection", () => {
    expect(STORE_NAMESPACE).toBe("opencodeStore");
    expect(storeRemote.package).toBe("dsh-opencode-patch");
    expect(storeRemote.descriptors).toHaveLength(1);
    const [descriptor] = storeRemote.descriptors;
    expect(descriptor).toMatchObject({
      id: "dsh-opencode-patch#opencodeStore/inspect",
      invocation: { kind: "direct" },
      method: "inspect",
      namespace: "opencodeStore",
      parameters: [],
      service: "opencodeStore",
    });
    const result = descriptor?.result as {
      create: () => { parse: (value: unknown) => unknown };
      mode: string;
      schema: { parse: (value: unknown) => unknown };
      typeSymbol: string;
    };
    expect(result.mode).toBe("strict");
    expect(result.typeSymbol).toBe(
      "dsh-opencode-patch#OpencodeStoreInspection"
    );
    for (const value of [{ found: true }, { found: "no" }]) {
      expect(result.create().parse(value)).toEqual(parseStoreInspection(value));
      expect(result.schema.parse(value)).toEqual(parseStoreInspection(value));
    }
  });
});
