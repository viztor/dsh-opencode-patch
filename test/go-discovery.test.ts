/**
 * `go-discovery.ts` — the credential and base-URL precedence policy.
 *
 * This module decides *which secret goes to which endpoint*: which entry the
 * Go key and gateway come from, how a Zen base URL is rewritten onto the Go
 * plane, and which of the four credential sources (composition literal,
 * captured route key, credentials/env reference, any captured key) the row's
 * `keySource` policy lets win. Every other consumer — the meter's
 * `resolveGoApiKey` and `patchFetch`'s Authorization fallback — inherits its
 * answer from here, so a wrong answer sends the wrong key to the wrong
 * endpoint and fails as an outage the user cannot act on.
 *
 * The cases are written around the *absences*, because that is where the policy
 * lives: what each source contributes when it is missing, which reference a
 * lookup is actually asked for, and which route id a lookup is scoped to.
 * `go-discovery-keys` characterises four gaps found while writing these cases
 * — a placeholder or whitespace credential discovered as a literal, a Zen key
 * captured under the Go route id, and a duplicated reference lookup — each
 * characterised rather than endorsed; see the comments for the reason.
 *
 * Offline and deterministic: no network, no clocks, and every case restores
 * `process.env` and the captured-key store in `afterEach`, because a leaked env
 * var silently breaks every file that runs after this one.
 *
 * This file holds which entry and which row field the Go config is read from;
 * its siblings hold the base URL (`go-discovery-base-url`), the key ladder
 * (`go-discovery-keys`) and the installation's own store
 * (`go-discovery-store`).
 *
 * @module test/go-discovery.test
 */
import { Context } from "@deepseek-ai/cordis";
import { afterEach, describe, expect, it } from "vitest";

import {
  composition,
  GO_BASE,
  registry,
  registryEntry,
  standaloneEntry,
  ZEN_BASE,
} from "./support/loader-rows.ts";
import { clearCapturedApiKeys, discoverGoConfig } from "./support/src.ts";

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

describe("discoverGoConfig: which entry the credential comes from", () => {
  it("finds nothing in a context that serves no loader entry list", () => {
    // The plugin must load against any context shape — a client bundle, a
    // half-built headless composition, a bare object. Discovery then reports
    // nothing rather than throwing, which is what lets the meter degrade to
    // "Go is not configured" instead of failing at mount.
    for (const ctx of [
      new Context(),
      null,
      undefined,
      "ctx",
      42,
      [],
      { loader: null },
      { loader: {} },
      { loader: { entries: "not-callable" } },
    ]) {
      expect(discoverGoConfig(ctx)).toEqual({});
    }
  });

  it("skips every entry shape the loader cannot present as a row config", () => {
    // Real entry lists carry non-config entries (plugins with no config, the
    // plugin's own row, entries whose config is a schemastery node). Each of
    // these must be skipped rather than mis-shaped into a credential.
    const entries: unknown[] = [
      null,
      "entry",
      7,
      [],
      {},
      { options: null },
      { options: "x" },
      { options: [] },
      { options: {} },
      { options: { config: null } },
      { options: { config: "x" } },
      { options: { config: [] } },
      { options: { config: 7 } },
      // …while a well-formed entry in the same list is still read, proving the
      // skip is per entry rather than an early bail-out.
      registryEntry("opencode-go", { apiKeyEnv: "READ_ANYWAY" }),
    ];
    expect(discoverGoConfig(composition(entries)).keyEnv).toBe("READ_ANYWAY");
  });

  it("prefers the targeted route's row over the well-known ids", () => {
    // The client selects the route it is metering; that route's own row is the
    // authority, or a composition declaring both planes would read the wrong
    // plane's key.
    const entries: unknown[] = [
      registry({
        "my-relay": { apiKeyEnv: "RELAY_KEY", baseURL: "https://relay.test" },
        "opencode-go": { apiKeyEnv: "GO_KEY", baseURL: GO_BASE },
      }),
    ];
    expect(discoverGoConfig(composition(entries), "my-relay")).toEqual({
      baseURL: "https://relay.test",
      keyEnv: "RELAY_KEY",
    });
  });

  it("falls back to the Go row when the targeted route is not declared", () => {
    // A renamed or unknown route id must not blind discovery: the well-known
    // rows are still consulted, which is what keeps a route rename from
    // silently un-configuring the meter.
    const entries: unknown[] = [
      registry({ "opencode-go": { apiKeyEnv: "GO_KEY", baseURL: GO_BASE } }),
    ];
    expect(discoverGoConfig(composition(entries), "renamed-route")).toEqual({
      baseURL: GO_BASE,
      keyEnv: "GO_KEY",
    });
  });

  it("reads the Zen row when the composition declares no Go row", () => {
    // A pay-as-you-go-only setup still has a gateway to meter Go against.
    const entries: unknown[] = [
      registry({ opencode: { apiKeyEnv: "ZEN_KEY", baseURL: ZEN_BASE } }),
    ];
    expect(discoverGoConfig(composition(entries))).toEqual({
      baseURL: ZEN_BASE,
      keyEnv: "ZEN_KEY",
    });
  });

  it("finds an OpenCode gateway behind a route id the plugin never names", () => {
    // Self-hosted relays and mirrors keep arbitrary ids. The only signal that
    // a row is ours is its base URL pointing at the vendor host.
    const entries: unknown[] = [
      registry({
        "my-relay": {
          apiKeyEnv: "RELAY_KEY",
          baseURL: "https://opencode.ai/zen",
        },
        unrelated: { apiKeyEnv: "OTHER_KEY", baseURL: "https://other.test/v1" },
      }),
    ];
    expect(discoverGoConfig(composition(entries))).toEqual({
      baseURL: "https://opencode.ai/zen",
      keyEnv: "RELAY_KEY",
    });
  });

  it("stops at the first gateway row the scan finds", () => {
    // Composition order decides, and the scan breaks rather than continuing:
    // a second OpenCode row must not overwrite the first one's key.
    const entries: unknown[] = [
      registry({
        first: { apiKeyEnv: "FIRST_KEY", baseURL: ZEN_BASE },
        second: { apiKeyEnv: "SECOND_KEY", baseURL: GO_BASE },
      }),
    ];
    const discovered = discoverGoConfig(composition(entries));
    expect(discovered.keyEnv).toBe("FIRST_KEY");
    expect(discovered.baseURL).toBe(ZEN_BASE);
  });

  it("ignores a row with no usable base URL while scanning", () => {
    // The scan keys on the base URL alone, so a row that names only a
    // credential must not be mistaken for the gateway.
    const entries: unknown[] = [
      registry({
        "no-url": { apiKeyEnv: "WRONG_KEY" },
        notARow: "string",
        real: { apiKeyEnv: "RIGHT_KEY", baseURL: ZEN_BASE },
      }),
    ];
    expect(discoverGoConfig(composition(entries)).keyEnv).toBe("RIGHT_KEY");
  });

  it("reads a standalone entry under any id or name the plugin knows", () => {
    // The Go gateway ships both as a standalone entry and inside a registry, and
    // the historical row names are all still in the wild.
    for (const options of [
      { id: "opencode-go", name: "dsh-opencode-go" },
      { id: "opencode", name: "dsh-opencode" },
      { id: "legacy-zen", name: "dsh-opencode" },
      { id: "legacy-go", name: "dsh-opencode-go" },
    ]) {
      const discovered = discoverGoConfig(
        composition([
          standaloneEntry({ ...options, config: { apiKeyEnv: "X" } }),
        ])
      );
      expect(discovered.keyEnv).toBe("X");
    }
  });

  it("ignores a standalone entry filed under an unrelated id", () => {
    // Reading every entry's config would take whatever credential any plugin
    // in the composition happened to declare.
    const entries: unknown[] = [
      standaloneEntry({ config: { apiKey: "sk-someone-elses" }, id: "other" }),
    ];
    expect(discoverGoConfig(composition(entries))).toEqual({});
  });

  it("lets a target id disable the well-known standalone fallback", () => {
    // Once a route has been named explicitly, an unrelated well-known entry
    // must not answer for it — otherwise a stale `opencode-go` row would win
    // over the route the caller actually asked about.
    const entries: unknown[] = [
      standaloneEntry({
        config: { apiKey: "sk-well-known" },
        id: "opencode-go",
      }),
    ];
    expect(discoverGoConfig(composition(entries), "my-relay")).toEqual({});
    // The same entry still answers when nothing is named.
    expect(discoverGoConfig(composition(entries)).literalKey).toBe(
      "sk-well-known"
    );
  });

  it("matches a standalone entry by name as well as by id", () => {
    // The client's route id can be either; both must reach the row.
    for (const options of [
      { config: { apiKey: "sk-by-id" }, id: "opencode-go" },
      { config: { apiKey: "sk-by-name" }, name: "opencode-go" },
    ]) {
      const discovered = discoverGoConfig(
        composition([standaloneEntry(options)]),
        "opencode-go"
      );
      expect(discovered.literalKey).toMatch(/^sk-by-/);
    }
  });

  it("lets a later entry win, mirroring composition order", () => {
    // Two rows can declare the same field; the one loaded last is the one the
    // user most recently declared, and a patch replaces a row's whole config.
    const entries: unknown[] = [
      standaloneEntry({ config: { apiKeyEnv: "FIRST" }, id: "opencode-go" }),
      standaloneEntry({ config: { apiKeyEnv: "SECOND" }, id: "opencode-go" }),
    ];
    expect(discoverGoConfig(composition(entries)).keyEnv).toBe("SECOND");
  });
});

describe("discoverGoConfig: the provider row's own fields", () => {
  it("reads the three declared fields the row may carry", () => {
    // `apiKeyEnv` is the reference, `apiKey` the literal secret, `baseURL` the
    // gateway — one row can carry any subset, so each must survive on its own.
    const entries: unknown[] = [
      registryEntry("opencode-go", {
        apiKey: "sk-literal",
        apiKeyEnv: "GO_REF",
        baseURL: "https://relay.test/v1",
      }),
    ];
    expect(discoverGoConfig(composition(entries))).toEqual({
      baseURL: "https://relay.test/v1",
      keyEnv: "GO_REF",
      literalKey: "sk-literal",
    });
  });

  it("ignores a declared field that is blank or not a string", () => {
    // An empty `apiKeyEnv` must not become the credential reference, or the
    // lookup would be asked for a reference named "" and find nothing.
    const entries: unknown[] = [
      registryEntry("opencode-go", {
        apiKey: "",
        apiKeyEnv: 42,
        baseURL: null,
      }),
    ];
    expect(discoverGoConfig(composition(entries))).toEqual({});
  });

  it("rejects a whitespace-only credential, but keeps the other fields verbatim", () => {
    // A YAML row whose secret was blanked but left indented yields `apiKey:
    // "   "`, which passed a bare `length > 0`. Since `literal` is the FIRST step
    // of both `auto` and `configured`, that whitespace outranked a working
    // stored credential — the same class of bug as the placeholder below, and
    // fixed by the same guard.
    //
    // `keyEnv` and `baseURL` are deliberately NOT trimmed: they are references,
    // not secrets, and silently rewriting a reference would make the discovered
    // value disagree with the row that declared it.
    const entries: unknown[] = [
      registryEntry("opencode-go", {
        apiKey: "   ",
        apiKeyEnv: "  ",
        baseURL: "  ",
      }),
    ];
    expect(discoverGoConfig(composition(entries))).toEqual({
      baseURL: "  ",
      keyEnv: "  ",
    });
  });

  it("reads a literal key out of the row's own credential headers", () => {
    // pi-ai accepts the credential as a bearer header or as a vendor header,
    // and a `Headers` instance is as likely as a plain record in a hand-written
    // row. All three shapes must yield the bare key, not the whole header.
    for (const headers of [
      { authorization: "Bearer sk-from-authorization" },
      { Authorization: "bearer sk-from-capitalised" },
      { "x-api-key": "sk-from-x-api-key" },
      { "api-key": "sk-from-api-key" },
    ]) {
      const discovered = discoverGoConfig(
        composition([registryEntry("opencode-go", { headers })])
      );
      expect(discovered.literalKey).toMatch(/^sk-from-/);
    }
    const instance = new Headers();
    instance.set("authorization", "Bearer sk-from-headers-instance");
    expect(
      discoverGoConfig(
        composition([registryEntry("opencode-go", { headers: instance })])
      ).literalKey
    ).toBe("sk-from-headers-instance");
  });

  it("lets an explicit apiKey outrank a header carrying the same secret", () => {
    // Both names point at the same field in pi-ai; when a row carries both, the
    // explicit key is the one the user typed.
    const entries: unknown[] = [
      registryEntry("opencode-go", {
        apiKey: "sk-explicit",
        headers: { authorization: "Bearer sk-from-header" },
      }),
    ];
    expect(discoverGoConfig(composition(entries)).literalKey).toBe(
      "sk-explicit"
    );
  });

  it("reads the nested options block only when the row itself carries no key", () => {
    // Some rows nest their settings one level deeper. The nested value is a
    // fallback, so it must never displace one declared at the row's top level.
    const nested = (options: Record<string, unknown>): unknown =>
      composition([
        registryEntry("opencode-go", { apiKey: "sk-top", options }),
      ]);

    expect(discoverGoConfig(nested({ apiKey: "sk-nested" })).literalKey).toBe(
      "sk-top"
    );
    expect(
      discoverGoConfig(
        composition([
          registryEntry("opencode-go", { options: { apiKey: "sk-nested" } }),
        ])
      ).literalKey
    ).toBe("sk-nested");
    expect(
      discoverGoConfig(
        composition([
          registryEntry("opencode-go", {
            options: { headers: { "x-api-key": "sk-nested-header" } },
          }),
        ])
      ).literalKey
    ).toBe("sk-nested-header");
    // A blank nested key falls through to the nested headers rather than
    // stopping the walk on an unusable value.
    expect(
      discoverGoConfig(
        composition([
          registryEntry("opencode-go", {
            options: { apiKey: "", headers: { "x-api-key": "sk-after-blank" } },
          }),
        ])
      ).literalKey
    ).toBe("sk-after-blank");
    // A *whitespace* nested key is unusable by the same rule as a blank one, so
    // the walk continues to the nested headers instead of answering with it.
    expect(
      discoverGoConfig(
        composition([
          registryEntry("opencode-go", {
            options: { apiKey: "  ", headers: { "x-api-key": "sk-after-ws" } },
          }),
        ])
      ).literalKey
    ).toBe("sk-after-ws");
  });

  it("ignores an options block that is not a record", () => {
    // A half-built options block must not be indexed into; the row simply
    // carries no literal key.
    const entries: unknown[] = [
      registryEntry("opencode-go", { options: "not-a-record" }),
    ];
    expect(discoverGoConfig(composition(entries))).toEqual({});
  });
});
