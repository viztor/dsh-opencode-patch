/**
 * `go-discovery.ts` — the installation's own store, and where it sits in the
 * key ladder.
 *
 * @module test/go-discovery-store.test
 */
import { afterEach, describe, expect, it } from "vitest";

import { composition, GO_REQUEST } from "./support/loader-rows.ts";
import {
  createOpencodeStore,
  type FixtureCredential,
  type FixtureStore,
} from "./support/opencode-store-fixture.ts";
import {
  clearCapturedApiKeys,
  recordCapturedApiKey,
  resolveGoApiKey,
  resolveOpencodeStoreKey,
} from "./support/src.ts";

/**
 * Restore every piece of ambient state these cases touch.
 *
 * A leaked env var or a leftover captured key silently breaks whichever file
 * runs next, so the hook lives in this file and not only in the old monolith.
 */
afterEach(() => {
  // Named deletes rather than a loop: the names are the contract.
  delete process.env.DSH_TEST_GO_KEY;
  delete process.env.OPENCODE_API_KEY;
  delete process.env.OPENCODE_GO_API_KEY;
  clearCapturedApiKeys();
});

describe("go-discovery: the installation's own store, and where it sits", () => {
  /**
   * The stores this file built, so a failure cannot leave one behind.
   *
   * `$XDG_DATA_HOME` is what points the reader at a store this suite owns, so
   * it is also what a leaked value would use to point every later file at a
   * deleted directory.
   */
  const stores: FixtureStore[] = [];

  const withStore = (
    credentials: readonly FixtureCredential[]
  ): FixtureStore => {
    const store = createOpencodeStore(credentials);
    stores.push(store);
    process.env.XDG_DATA_HOME = store.root;
    return store;
  };

  afterEach(() => {
    for (const store of stores.splice(0)) {
      store.cleanup();
    }
    delete process.env.XDG_DATA_HOME;
  });

  it("answers the installation's Go credential when the row opted in", async () => {
    withStore([{ integrationId: "opencode-go", value: "sk-fixture-go" }]);
    await expect(
      resolveGoApiKey(composition(), undefined, "auto", true)
    ).resolves.toBe("sk-fixture-go");
  });

  it("reads nothing while the switch is off, which is the default", async () => {
    // The contract, exercised rather than asserted: the same store that answers
    // above answers nothing here, so the switch is what decided it.
    withStore([{ integrationId: "opencode-go", value: "sk-fixture-go" }]);
    await expect(resolveGoApiKey(composition())).resolves.toBeUndefined();
    await expect(
      resolveGoApiKey(composition(), undefined, "auto", false)
    ).resolves.toBeUndefined();
    await expect(
      resolveGoApiKey(composition(), undefined, "request", false)
    ).resolves.toBeUndefined();
  });

  it("still loses to a credential the deployment declared", async () => {
    // The rule the whole feature is arranged around: everything the user said
    // explicitly outranks anything inferred from another program's files.
    withStore([{ integrationId: "opencode-go", value: "sk-fixture-go" }]);
    process.env.OPENCODE_GO_API_KEY = "sk-declared-go";
    await expect(
      resolveGoApiKey(composition(), undefined, "auto", true)
    ).resolves.toBe("sk-declared-go");
  });

  it("still loses to a key captured from a live request", async () => {
    withStore([{ integrationId: "opencode-go", value: "sk-fixture-go" }]);
    recordCapturedApiKey("sk-captured-go", "opencode-go", GO_REQUEST);
    await expect(
      resolveGoApiKey(composition(), undefined, "auto", true)
    ).resolves.toBe("sk-captured-go");
  });

  it("matches the plane's integration rather than any row", async () => {
    withStore([{ integrationId: "opencode", value: "oc_sk_fixture_zen" }]);
    // The Go lookup asks for the Go integration, so a Zen-only store answers it
    // nothing...
    await expect(
      resolveGoApiKey(composition(), undefined, "auto", true)
    ).resolves.toBeUndefined();
    // ...while the Zen integration resolves that same row. The plane is what
    // the store is keyed by, and a reader that took the first row would hand
    // the Go endpoint a Zen credential.
    expect(resolveOpencodeStoreKey("opencode", true)).toBe("oc_sk_fixture_zen");
  });

  it("answers undefined for a store that holds nothing", async () => {
    // An installation with no credentials, and a machine without one at all,
    // are the same answer: not an error, and not a request failure.
    withStore([]);
    await expect(
      resolveGoApiKey(composition(), undefined, "auto", true)
    ).resolves.toBeUndefined();
  });
});
