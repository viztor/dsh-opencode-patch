/**
 * `go-discovery.ts` — the credential and base-URL precedence policy.
 *
 * This module decides *which secret goes to which endpoint*: which entry the
 * Go key and gateway come from, how a Zen base URL is rewritten onto the Go
 * plane, and which of the four credential sources (composition literal,
 * captured route key, credentials/env reference, any captured key) the row's
 * `keySource` policy lets win. Every other consumer — the meter's
 * `resolveGoApiKey`, `patchFetch`'s Authorization fallback, the mounted
 * Responses routes' `inheritedCredentialRef` — inherits its answer from here,
 * so a wrong answer sends the wrong key to the wrong endpoint and fails as an
 * outage the user cannot act on.
 *
 * The cases are written around the *absences*, because that is where the policy
 * lives: what each source contributes when it is missing, which reference a
 * lookup is actually asked for, and which route id a lookup is scoped to. The
 * last describe characterises four gaps found while writing this file — a
 * placeholder or whitespace credential discovered as a literal, a Zen key
 * captured under the Go route id, and a duplicated reference lookup — each
 * characterised rather than endorsed; see the comments for the reason.
 *
 * Offline and deterministic: no network, no clocks, and every case restores
 * `process.env` and the captured-key store in `afterEach`, because a leaked env
 * var silently breaks every file that runs after this one.
 *
 * @module test/go-discovery.test
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_USAGE_BASE_URL,
  DEFAULT_USAGE_KEY_ENV,
  KEY_SOURCE_POLICIES,
} from "../src/config.ts";
import {
  declaredProviderModels,
  discoverGoConfig,
  effectiveGoKeyRef,
  resolveGoApiKey,
  resolveGoBaseURL,
  resolveGoKeyForRef,
  resolveRoutedKey,
  resolveZenCreditInfo,
  toGoBaseURL,
  type DiscoveredGoConfig,
} from "../src/go-discovery.ts";
import {
  clearCapturedApiKeys,
  getCapturedApiKey,
  isPlaceholderApiKey,
  recordCapturedApiKey,
} from "../src/key-capture.ts";
import {
  createOpencodeStore,
  type FixtureCredential,
  type FixtureStore,
} from "./support/opencode-store-fixture.ts";
import { createMockContext } from "./test-helpers.ts";

/** The Zen plane, which discovery rewrites onto the Go plane. */
const ZEN_BASE = "https://opencode.ai/zen/v1";
/** The Go plane every rewrite targets. */
const GO_BASE = "https://opencode.ai/zen/go/v1";
/** A request URL that classifies its own tier as Go. */
const GO_REQUEST = "https://opencode.ai/zen/go/v1/chat/completions";
/** A request URL that classifies its own tier as Zen. */
const ZEN_REQUEST = "https://opencode.ai/zen/v1/messages";

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

/** A context serving no credentials service: a headless composition. */
const composition = (entries: readonly unknown[] = []): unknown => ({
  loader: { entries: () => entries },
});

/** One `llm-pi-ai` provider-registry entry carrying a single route row. */
const registryEntry = (
  routeId: string,
  row: Record<string, unknown>
): unknown => ({
  options: { config: { providers: { [routeId]: row } } },
});

/** A registry entry declaring several routes at once, whatever shape each is. */
const registry = (rows: Record<string, unknown>): unknown => ({
  options: { config: { providers: rows } },
});

/** A standalone entry (`id: opencode-go`) declaring its config inline. */
const standaloneEntry = (options: Record<string, unknown>): unknown => ({
  options,
});

/** The context plus the references the credentials service was asked for. */
interface CredentialProbe {
  /** Every `ref` the lookup passed to `resolve`, in call order. */
  asked: string[];
  context: unknown;
}

/**
 * A context serving a credentials service over `store`, recording each lookup.
 *
 * The recording is the point: "which reference was asked for" is not observable
 * from the returned key alone whenever two candidates resolve to the same
 * value, and it is the only way to prove the Zen reference is never offered to
 * the Go endpoint.
 */
const withCredentials = (
  store: Record<string, string>,
  entries: readonly unknown[] = []
): CredentialProbe => {
  const asked: string[] = [];
  const context: unknown = {
    loader: { entries: () => entries },
    get: (name: string): unknown => {
      if (name !== "credentials") {
        return undefined;
      }
      return {
        resolve: (ref: string): Promise<{ value?: string }> => {
          asked.push(ref);
          const value = store[ref];
          return Promise.resolve(value === undefined ? {} : { value });
        },
      };
    },
  };
  return { asked, context };
};

describe("discoverGoConfig: which entry the credential comes from", () => {
  it("finds nothing in a context that serves no loader entry list", () => {
    // The plugin must load against any context shape — a client bundle, a
    // half-built headless composition, a bare object. Discovery then reports
    // nothing rather than throwing, which is what lets the meter degrade to
    // "Go is not configured" instead of failing at mount.
    for (const ctx of [
      createMockContext(),
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

describe("toGoBaseURL and resolveGoBaseURL", () => {
  it("rewrites a Zen base onto the Go plane", () => {
    // The two planes share a host, so the pay-as-you-go base still addresses
    // `/usage` once rewritten. Reading the unrewritten base 404s on every poll.
    expect(toGoBaseURL(ZEN_BASE)).toBe(GO_BASE);
    expect(toGoBaseURL("https://proxy.test/opencode.ai/zen/v1")).toBe(
      "https://proxy.test/opencode.ai/zen/go/v1"
    );
  });

  it("rewrites the INFERENCE family onto the Go plane too", () => {
    // The catalog now names the inference family for the `opencode` provider
    // (`api: https://opencode.ai/inference/openai/v1`), so a base discovered
    // from a provider row is very often that family. Rewriting only `zen/v1`
    // left it untouched and the meter asked `…/inference/openai/v1/usage` — a
    // path that does not exist. Measured: the only public quota route in either
    // 1.19.4 or 2.0.32 is `packages/console/app/src/routes/zen/go/v1/usage.ts`,
    // and the inference proxy table has no `/inference/.../usage` entry.
    expect(toGoBaseURL("https://opencode.ai/inference/openai/v1")).toBe(
      GO_BASE
    );
    expect(toGoBaseURL("https://opencode.ai/inference/v1")).toBe(GO_BASE);
    expect(toGoBaseURL("https://opencode.ai/inference/go/openai/v1")).toBe(
      GO_BASE
    );
  });

  it("leaves an already-Go or entirely custom base alone", () => {
    // The rewrite is a host-level substitution, not a guess: a self-hosted or
    // mirrored gateway must reach its own `/usage`, not the vendor's.
    for (const base of [
      GO_BASE,
      "https://relay.test/v1",
      "https://opencode.ai/api/v1",
      "",
    ]) {
      expect(toGoBaseURL(base)).toBe(base);
    }
  });

  it("preserves a trailing slash — normalising it is the service's job", () => {
    // This module resolves *which* endpoint; `GoUsageService` appends `/usage`
    // and strips the trailing slash itself. Pinning the pass-through here keeps
    // the seam honest: a normaliser added later would have to change both.
    expect(toGoBaseURL(`${ZEN_BASE}/`)).toBe(`${GO_BASE}/`);
    expect(toGoBaseURL("https://relay.test/v1/")).toBe(
      "https://relay.test/v1/"
    );
  });

  it("prefers an explicit non-default base URL, verbatim", () => {
    // `usageBaseURL` is the one endpoint override a row may set, so it must win
    // over anything the composition declares. It is returned unrewritten here;
    // the service applies the Zen→Go rewrite afterwards.
    const entries: unknown[] = [
      registryEntry("opencode-go", { baseURL: "https://discovered.test/v1" }),
    ];
    expect(
      resolveGoBaseURL(composition(entries), "https://explicit.test/v1")
    ).toBe("https://explicit.test/v1");
    expect(
      resolveGoBaseURL(composition(entries), "https://explicit.test/zen/v1")
    ).toBe("https://explicit.test/zen/v1");
  });

  it("falls through to discovery when the configured value is the stock default", () => {
    // The default is the absence of an override, not an override: treating it
    // as one would pin every user to the vendor endpoint even when their own
    // row declares a gateway.
    const entries: unknown[] = [
      registryEntry("opencode-go", { baseURL: ZEN_BASE }),
    ];
    expect(resolveGoBaseURL(composition(entries), DEFAULT_USAGE_BASE_URL)).toBe(
      GO_BASE
    );
  });

  it("returns the configured value when nothing declares an endpoint", () => {
    // With no discovery and no override there is nothing to return but what the
    // caller passed. `resolveConfig` maps a blank `usageBaseURL` to the stock
    // default, so the empty case cannot arrive through the plugin's own config.
    const entries: unknown[] = [
      registryEntry("opencode-go", { apiKeyEnv: "GO_REF" }),
    ];
    expect(resolveGoBaseURL(composition(entries), DEFAULT_USAGE_BASE_URL)).toBe(
      DEFAULT_USAGE_BASE_URL
    );
    expect(resolveGoBaseURL(composition(entries), "")).toBe("");
    expect(resolveGoBaseURL(null, DEFAULT_USAGE_BASE_URL)).toBe(
      DEFAULT_USAGE_BASE_URL
    );
  });

  it("forwards the targeted route so discovery answers for that row", () => {
    // Two rows with different gateways: without the target, discovery would
    // read whichever row it reaches first and meter the wrong endpoint.
    const entries: unknown[] = [
      registry({
        "my-relay": { baseURL: "https://relay.test/v1" },
        "opencode-go": { baseURL: GO_BASE },
      }),
    ];
    expect(
      resolveGoBaseURL(composition(entries), DEFAULT_USAGE_BASE_URL, "my-relay")
    ).toBe("https://relay.test/v1");
  });
});

describe("effectiveGoKeyRef", () => {
  it("uses the composition's reference and defaults when there is none", () => {
    // The reference is never a row setting: it is the provider row's own
    // `apiKeyEnv`, and the built-in default is the fallback. A row that
    // declares nothing is exactly a row that never mentioned it.
    const entries: unknown[] = [
      registryEntry("opencode-go", { apiKeyEnv: "DSH_TEST_GO_KEY" }),
    ];
    expect(effectiveGoKeyRef(discoverGoConfig(composition(entries)))).toBe(
      "DSH_TEST_GO_KEY"
    );
    expect(effectiveGoKeyRef(discoverGoConfig(composition([])))).toBe(
      DEFAULT_USAGE_KEY_ENV
    );
    expect(effectiveGoKeyRef({})).toBe(DEFAULT_USAGE_KEY_ENV);
  });

  it("does not mistake a literal key for a reference", () => {
    // A row declaring `apiKey` has a secret, not a reference. Reading it as one
    // would ask the credentials service for a secret as if it were a name.
    const declared: DiscoveredGoConfig = { literalKey: "sk-literal" };
    expect(effectiveGoKeyRef(declared)).toBe(DEFAULT_USAGE_KEY_ENV);
  });

  it("still reaches the default candidate when the reference is blank", async () => {
    // `readProviderRow` filters an empty `apiKeyEnv`, but this function takes
    // whatever it is handed, so a whitespace reference must not become the only
    // candidate: the built-in default is still tried and still answers.
    const blank = effectiveGoKeyRef({ keyEnv: "  " });
    expect(blank).toBe("  ");
    process.env.OPENCODE_GO_API_KEY = "sk-from-default";
    expect(await resolveGoKeyForRef(composition(), blank)).toBe(
      "sk-from-default"
    );
  });
});

describe("resolveGoApiKey: which source the policy selects", () => {
  /** A row declaring a literal key, the source `auto` puts first. */
  const withLiteral = (): unknown =>
    composition([registryEntry("opencode-go", { apiKey: "sk-literal" })]);

  /** A composition that declares no credential at all. */
  const bare = (): unknown => composition([]);

  it("auto: the composition's literal key wins over a captured key and the env", async () => {
    // The default policy is byte-for-byte the original precedence: what the
    // composition declares is what the user configured on purpose.
    process.env.OPENCODE_GO_API_KEY = "sk-env";
    recordCapturedApiKey("sk-captured", "opencode-go", GO_REQUEST);
    expect(await resolveGoApiKey(withLiteral())).toBe("sk-literal");
  });

  it("request: a captured key is promoted above both declared sources", async () => {
    // The whole point of the policy — a rotated live key beats a pinned one.
    process.env.OPENCODE_GO_API_KEY = "sk-env";
    recordCapturedApiKey("sk-captured", "opencode-go", GO_REQUEST);
    expect(await resolveGoApiKey(withLiteral(), undefined, "request")).toBe(
      "sk-captured"
    );
  });

  it("configured: the credentials/env reference beats a captured key", async () => {
    // The opposite choice, for a pinned or CI deployment: the declared
    // credential is the contract, whatever the last request happened to carry.
    process.env.OPENCODE_GO_API_KEY = "sk-env";
    recordCapturedApiKey("sk-captured", "opencode-go", GO_REQUEST);
    expect(await resolveGoApiKey(withLiteral(), undefined, "configured")).toBe(
      "sk-literal"
    );
    expect(await resolveGoApiKey(bare(), undefined, "configured")).toBe(
      "sk-env"
    );
    expect(await resolveGoApiKey(bare(), undefined, "auto")).toBe(
      "sk-captured"
    );
    expect(await resolveGoApiKey(bare(), undefined, "request")).toBe(
      "sk-captured"
    );
  });

  it("every policy falls back to a key captured under a route it no longer names", async () => {
    // A user who renames their Go route would otherwise lose the only working
    // key they have: the tier lookup must find it by account, not by route id.
    recordCapturedApiKey("sk-rotated", "my-relay", GO_REQUEST);
    for (const policy of KEY_SOURCE_POLICIES) {
      expect(await resolveGoApiKey(bare(), "opencode-go", policy)).toBe(
        "sk-rotated"
      );
    }
  });

  it("hands the Go lookup an oc_sk_ key, because the endpoint accepts one", async () => {
    // This test used to assert the opposite, on the stated premise that "the Go
    // `/usage` endpoint rejects `oc_sk_…` outright". Probed live on 2026-10-08:
    // an `oc_sk_…` key answers `/zen/go/v1/usage` with HTTP 200 and real
    // windows. The prefix is not a tier marker, so a guard that filtered on it
    // discarded the one credential that worked — and the meter, falling through
    // to nothing, drew an overflow card with no quota at all.
    //
    // The endpoint decides entitlement; `usage.ts`'s 403 branch reads that
    // answer. Nothing here guesses from the string.
    process.env.OPENCODE_GO_API_KEY = "oc_sk_go_capable";
    for (const policy of KEY_SOURCE_POLICIES) {
      expect(await resolveGoApiKey(bare(), "opencode-go", policy)).toBe(
        "oc_sk_go_capable"
      );
    }
    // What still keeps a Zen *capture* out of a Go lookup is the TIER it was
    // observed on, not its prefix: `ZEN_REQUEST` classifies as `zen`, and
    // `tierSatisfies` refuses a zen-tier capture for a go target. That rule
    // reads the request, which is evidence, rather than the string, which is
    // not.
    delete process.env.OPENCODE_GO_API_KEY;
    delete process.env.OPENCODE_API_KEY;
    recordCapturedApiKey("oc_sk_zen", "opencode", ZEN_REQUEST);
    expect(await resolveGoApiKey(bare(), "opencode-go", "configured")).toBe(
      undefined
    );
  });

  it("still refuses a placeholder, whatever the prefix", async () => {
    // The guard that remains is the one that was always load-bearing: a dummy
    // is not a credential. Dropping the prefix test must not drop this.
    process.env.OPENCODE_GO_API_KEY = "unused";
    expect(
      await resolveGoApiKey(bare(), "opencode-go", "auto")
    ).toBeUndefined();
  });

  it("resolves nothing at all when every source is empty", async () => {
    // The caller turns `undefined` into the typed MISSING_CREDENTIAL the client
    // renders as "Go is not configured", which is only honest if a genuinely
    // absent credential is not dressed up as an empty string.
    for (const policy of KEY_SOURCE_POLICIES) {
      expect(await resolveGoApiKey(bare(), undefined, policy)).toBeUndefined();
    }
    // A row whose only declared field is a blank literal has not declared one.
    process.env.OPENCODE_GO_API_KEY = "sk-env";
    const blankLiteral = composition([
      registryEntry("opencode-go", { apiKey: "" }),
    ]);
    expect(await resolveGoApiKey(blankLiteral)).toBe("sk-env");
  });

  it("asks the credentials service only when no earlier step answered", async () => {
    // A credentials lookup is a host round trip; consulting it behind a
    // literal that already answered is a wasted call on every poll, and one
    // that would prompt the user for a credential the row already names.
    const store = { [DEFAULT_USAGE_KEY_ENV]: "sk-stored" };
    for (const policy of KEY_SOURCE_POLICIES) {
      const withLiteralKey = withCredentials(store, [
        registryEntry("opencode-go", { apiKey: "sk-literal" }),
      ]);
      expect(
        await resolveGoApiKey(withLiteralKey.context, undefined, policy)
      ).toBe(policy === "request" ? "sk-literal" : "sk-literal");
      expect(withLiteralKey.asked).toEqual([]);

      const withoutLiteral = withCredentials(store, []);
      expect(
        await resolveGoApiKey(withoutLiteral.context, undefined, policy)
      ).toBe("sk-stored");
      // Once, not twice: with no declared `apiKeyEnv` the effective reference IS
      // the default, so the old `[ref, DEFAULT]` ladder asked the same question
      // twice on every poll.
      expect(withoutLiteral.asked).toEqual([DEFAULT_USAGE_KEY_ENV]);
    }
  });

  it("asks for the row's declared reference and the built-in default, in that order", async () => {
    // The reference is the row's own `apiKeyEnv`; the default is the last
    // chance. Which one answered is only visible from the recorded lookups.
    const store = { DSH_TEST_GO_KEY: "sk-declared" };
    const declared = withCredentials(store, [
      registryEntry("opencode-go", { apiKeyEnv: "DSH_TEST_GO_KEY" }),
    ]);
    expect(
      await resolveGoApiKey(declared.context, undefined, "configured")
    ).toBe("sk-declared");
    expect(declared.asked).toEqual(["DSH_TEST_GO_KEY", DEFAULT_USAGE_KEY_ENV]);
  });
});

describe("resolveGoKeyForRef: the reference ladder", () => {
  it("never offers the Zen reference to the Go endpoint", async () => {
    // Asking for `OPENCODE_API_KEY` collapses to the Go reference alone: the
    // Zen secret is never a candidate here, so a caller that mislabels the ref
    // still cannot leak the Zen key to `/usage`.
    const probe = withCredentials({
      OPENCODE_API_KEY: "oc_sk_zen",
      OPENCODE_GO_API_KEY: "sk-go",
    });
    expect(await resolveGoKeyForRef(probe.context, "OPENCODE_API_KEY")).toBe(
      "sk-go"
    );
    expect(probe.asked).toEqual([DEFAULT_USAGE_KEY_ENV]);
  });

  it("takes the declared reference's value even when it is an oc_sk_ key", async () => {
    // This used to assert that a stored `oc_sk_…` value was skipped in favour
    // of the next candidate. It is not skipped: the prefix does not name a
    // tier, and the endpoint accepts these keys (measured, 2026-10-08). The
    // declared reference is the one the user wrote down, so it wins.
    const probe = withCredentials({
      DSH_TEST_GO_KEY: "oc_sk_zen",
      OPENCODE_GO_API_KEY: "sk-go",
    });
    expect(await resolveGoKeyForRef(probe.context, "DSH_TEST_GO_KEY")).toBe(
      "oc_sk_zen"
    );
    expect(probe.asked).toEqual(["DSH_TEST_GO_KEY", DEFAULT_USAGE_KEY_ENV]);
  });

  it("prefers the declared reference over the built-in default", async () => {
    // Two stored credentials, one per candidate: the row's own `apiKeyEnv` is
    // the reference the user declared, so it must win.
    const probe = withCredentials({
      DSH_TEST_GO_KEY: "sk-declared",
      OPENCODE_GO_API_KEY: "sk-default",
    });
    expect(await resolveGoKeyForRef(probe.context, "DSH_TEST_GO_KEY")).toBe(
      "sk-declared"
    );
    process.env.OPENCODE_GO_API_KEY = "sk-env";
    expect(await resolveGoKeyForRef(probe.context, "DSH_TEST_GO_KEY")).toBe(
      "sk-declared"
    );
  });

  it("prefers a stored credential over a stale exported variable", async () => {
    // Every reference is tried through the credentials service before the
    // environment is consulted at all, so a rotated stored key is not shadowed
    // by the value the shell exported months ago.
    process.env.OPENCODE_GO_API_KEY = "sk-stale-export";
    const probe = withCredentials({ [DEFAULT_USAGE_KEY_ENV]: "sk-stored" });
    expect(await resolveGoKeyForRef(probe.context, DEFAULT_USAGE_KEY_ENV)).toBe(
      "sk-stored"
    );
    expect(probe.asked.length).toBeGreaterThan(0);
  });

  it("falls back to the environment when nothing is stored", async () => {
    // The cold-start path, and the one a headless composition lives on: no
    // credentials service at all, just an exported variable.
    process.env.OPENCODE_GO_API_KEY = "sk-env";
    expect(await resolveGoKeyForRef(composition(), DEFAULT_USAGE_KEY_ENV)).toBe(
      "sk-env"
    );
    process.env.DSH_TEST_GO_KEY = "sk-declared-env";
    expect(await resolveGoKeyForRef(composition(), "DSH_TEST_GO_KEY")).toBe(
      "sk-declared-env"
    );
  });

  it("treats a blank stored value and a blank variable as absent", async () => {
    // An empty credential is not a credential: returning it would put
    // `Authorization: Bearer ` on the wire and read as a wrong-key 401.
    expect(
      await resolveGoKeyForRef(composition(), DEFAULT_USAGE_KEY_ENV)
    ).toBeUndefined();
    process.env.OPENCODE_GO_API_KEY = "";
    expect(
      await resolveGoKeyForRef(composition(), DEFAULT_USAGE_KEY_ENV)
    ).toBeUndefined();
    const probe = withCredentials({ [DEFAULT_USAGE_KEY_ENV]: "" });
    expect(
      await resolveGoKeyForRef(probe.context, DEFAULT_USAGE_KEY_ENV)
    ).toBeUndefined();
  });

  it("accepts an oc_sk_ key from the environment, and still refuses a dummy", async () => {
    // The environment is a store like any other, so it follows the same rule
    // the store does: a real credential is handed over whatever its prefix, and
    // only a placeholder is refused.
    process.env.OPENCODE_GO_API_KEY = "oc_sk_zen";
    expect(await resolveGoKeyForRef(composition(), DEFAULT_USAGE_KEY_ENV)).toBe(
      "oc_sk_zen"
    );

    process.env.OPENCODE_GO_API_KEY = "unused";
    expect(
      await resolveGoKeyForRef(composition(), DEFAULT_USAGE_KEY_ENV)
    ).toBeUndefined();
  });
});

describe("resolveZenCreditInfo", () => {
  it("accepts a captured Zen key as configured credit", async () => {
    // The captured Zen key is the rotation-proof answer, and it is checked
    // before any host lookup so a live turn settles the question immediately.
    recordCapturedApiKey("oc_sk_captured", "opencode", ZEN_REQUEST);
    const captured = await resolveZenCreditInfo(composition());
    expect(captured.isConfigured).toBe(true);
    // Even with nothing in the environment, so the capture really did answer.
    const noContext = await resolveZenCreditInfo(null);
    expect(noContext.isConfigured).toBe(true);
  });

  it("does not count a Go key as Zen credit", async () => {
    // Go credit cannot overflow into Zen: the overflow card is only drawn when
    // the Zen plane is the one that would be charged.
    recordCapturedApiKey("sk-go", "opencode-go", GO_REQUEST);
    const goOnly = await resolveZenCreditInfo(composition());
    expect(goOnly.isConfigured).toBe(false);
  });

  it("reads the Zen reference from the credentials service and the environment", async () => {
    // There is no endpoint to ask for a balance, so this answers "can Go
    // overflow into Zen credit?" purely from what the composition holds.
    const probe = withCredentials({ OPENCODE_API_KEY: "oc_sk_stored" });
    const stored = await resolveZenCreditInfo(probe.context);
    expect(stored.isConfigured).toBe(true);
    expect(probe.asked).toEqual(["OPENCODE_API_KEY"]);

    process.env.OPENCODE_API_KEY = "oc_sk_env";
    const fromEnv = await resolveZenCreditInfo(composition());
    expect(fromEnv.isConfigured).toBe(true);
  });

  it("reports nothing configured when neither plane holds a Zen credential", async () => {
    // The honest negative, so the meter hands over to Go instead of promising
    // an overflow card that no balance could ever back.
    process.env.OPENCODE_GO_API_KEY = "sk-go";
    const goOnly = await resolveZenCreditInfo(composition());
    expect(goOnly.isConfigured).toBe(false);
    const probe = withCredentials({ OPENCODE_API_KEY: "" });
    const blank = await resolveZenCreditInfo(probe.context);
    expect(blank.isConfigured).toBe(false);
  });
});

describe("resolveRoutedKey", () => {
  it("calls the Go route Go whatever the resolved key looks like", async () => {
    // The routed provider is authoritative for the tier: a key that is a
    // shared or vendored token still authenticates the Go plane when the route
    // in use *is* the Go route.
    process.env.OPENCODE_GO_API_KEY = "vendor-token-1234";
    const routed = await resolveRoutedKey(composition(), "opencode-go");
    expect(routed.key).toBe("vendor-token-1234");
    expect(routed.tier).toBe("go");
    expect(routed.provider).toBe("opencode-go");
  });

  it("does not classify a renamed route by the key's prefix", async () => {
    // The route decides, and a renamed route names no plane. The prefix used to
    // decide instead, and it is not OpenCode's: `oc_sk_` is issued for Go keys
    // too, and `sk-` is every OpenAI key.
    for (const key of ["sk-rotated-key", "oc_sk_zen-key", "opaque-token"]) {
      clearCapturedApiKeys();
      recordCapturedApiKey(key, "my-relay", "https://relay.test/v1");
      const routed = await resolveRoutedKey(composition(), "my-relay");
      expect(routed.key).toBe(key);
      expect(routed.tier).toBe("unknown");
    }
  });

  it("accepts a Zen key for a route that legitimately owns one", async () => {
    // Unlike `resolveGoApiKey`, this lookup never rejects a Zen key: here the
    // Zen tier is the target rather than a mistake.
    process.env.OPENCODE_API_KEY = "oc_sk_zen-only";
    const routed = await resolveRoutedKey(composition(), "opencode");
    expect(routed.key).toBe("oc_sk_zen-only");
    expect(routed.tier).toBe("zen");
    expect(
      await resolveGoKeyForRef(composition(), "OPENCODE_API_KEY")
    ).toBeUndefined();
  });

  it("reports the tier of the route it was asked about", async () => {
    // A non-Go route is not tier-filtered, so a key captured elsewhere can
    // answer for it; the tier reported is still the route's, never a guess
    // from the key's shape.
    recordCapturedApiKey("sk-go-key-value", "opencode-go", GO_REQUEST);
    const routed = await resolveRoutedKey(composition(), "opencode");
    expect(routed.key).toBe("sk-go-key-value");
    expect(routed.tier).toBe("zen");
  });

  it("uses the route's own declared reference, defaulting each plane differently", async () => {
    // The default reference differs by plane on purpose: a Go route must never
    // silently fall back to the Zen reference.
    const goProbe = withCredentials({});
    await resolveRoutedKey(goProbe.context, "opencode-go");
    expect(goProbe.asked).toEqual([DEFAULT_USAGE_KEY_ENV]);

    const zenProbe = withCredentials({});
    await resolveRoutedKey(zenProbe.context, "opencode");
    expect(zenProbe.asked).toEqual(["OPENCODE_API_KEY"]);

    const declaredProbe = withCredentials({}, [
      registryEntry("opencode-go", { apiKeyEnv: "DSH_TEST_GO_KEY" }),
    ]);
    await resolveRoutedKey(declaredProbe.context, "opencode-go", "configured");
    expect(declaredProbe.asked).toEqual(["DSH_TEST_GO_KEY"]);
  });

  it("reports a ten-character prefix, and none below it", async () => {
    // The prefix identifies the account without disclosing it. The floor is the
    // SAME ten characters as the slice: it used to be 8, so an 8- or 9-character
    // key was reported WHOLE — a "prefix" that leaked the entire secret,
    // precisely the length it was meant to withhold.
    recordCapturedApiKey("sk-abcdefghijkl", "opencode-go", GO_REQUEST);
    const long = await resolveRoutedKey(composition(), "opencode-go");
    expect(long.keyPrefix).toBe("sk-abcdefg");
    clearCapturedApiKeys();
    recordCapturedApiKey("sk-1234567890", "opencode-go", GO_REQUEST);
    const atFloor = await resolveRoutedKey(composition(), "opencode-go");
    expect(atFloor.key).toBe("sk-1234567890");
    // Exactly ten characters, so the ninth and tenth digits stay hidden.
    expect(atFloor.keyPrefix).toBe("sk-1234567");
    clearCapturedApiKeys();
    recordCapturedApiKey("sk-12345", "opencode-go", GO_REQUEST);
    const belowFloor = await resolveRoutedKey(composition(), "opencode-go");
    // The key is still returned — only the derived prefix is withheld.
    expect(belowFloor.key).toBe("sk-12345");
    expect(belowFloor.keyPrefix).toBeUndefined();
  });

  it("carries both optional fields even when nothing resolved", async () => {
    // Consumers destructure `key`/`keyPrefix`, so the fields must be present
    // rather than absent — an absent field is a different shape to narrow.
    const routed = await resolveRoutedKey(composition(), "opencode-go");
    expect(routed.key).toBeUndefined();
    expect(routed.keyPrefix).toBeUndefined();
    expect(Object.hasOwn(routed, "key")).toBe(true);
    expect(Object.hasOwn(routed, "keyPrefix")).toBe(true);
  });

  it("applies the row's keySource policy exactly as the meter does", async () => {
    // Both consumers share `KEY_SOURCE_ORDER`, so a policy that changed the
    // meter's credential would change what every routed request is signed
    // with; the two must not be able to drift.
    const context = composition([
      registryEntry("opencode-go", { apiKey: "sk-literal" }),
    ]);
    process.env.OPENCODE_GO_API_KEY = "sk-env";
    recordCapturedApiKey("sk-captured", "opencode-go", GO_REQUEST);
    const automatic = await resolveRoutedKey(context, "opencode-go", "auto");
    const requested = await resolveRoutedKey(context, "opencode-go", "request");
    const declared = await resolveRoutedKey(
      context,
      "opencode-go",
      "configured"
    );
    expect(automatic.key).toBe("sk-literal");
    expect(requested.key).toBe("sk-captured");
    expect(declared.key).toBe("sk-literal");
  });
});

describe("gaps characterised while pinning the policy", () => {
  it("never lets a placeholder become the credential the meter sends", async () => {
    // This repo's README tells users to write exactly `authorization: Bearer
    // unused` on a keyless route, and `readProviderRow` used to copy that header
    // into `literalKey` with none of the placeholder check
    // `recordCapturedApiKey` applies. Because `literal` is the first step of
    // both `auto` and `configured`, the sentinel outranked a working stored
    // credential AND a working captured key, so the meter authenticated as
    // `Bearer unused` on every poll and the 401 read like a missing
    // subscription. Fixed by the `usableCredential` guard in `readProviderRow`;
    // this now pins the fix rather than the gap.
    const context = composition([
      registryEntry("opencode-go", {
        headers: { authorization: "Bearer unused" },
      }),
    ]);
    process.env.OPENCODE_GO_API_KEY = "sk-real-env-key";
    recordCapturedApiKey("sk-real-captured", "opencode-go", GO_REQUEST);

    expect(isPlaceholderApiKey("unused")).toBe(true);
    // The sentinel is not a credential at any point of discovery…
    expect(discoverGoConfig(context).literalKey).toBeUndefined();
    // …and every policy falls through to a real key, not only the ones that
    // happen to rank the captured steps first. Each policy has its own real
    // answer, which is the point: `configured` puts the credential store ahead
    // of the captured key, so it reaches the env value and not the captured
    // one. Before the fix all three answered "unused".
    expect(await resolveGoApiKey(context, "opencode-go", "auto")).toBe(
      "sk-real-captured"
    );
    expect(await resolveGoApiKey(context, "opencode-go", "configured")).toBe(
      "sk-real-env-key"
    );
    expect(await resolveGoApiKey(context, "opencode-go", "request")).toBe(
      "sk-real-captured"
    );
    const routed = await resolveRoutedKey(context, "opencode-go", "request");
    expect(routed.key).toBe("sk-real-captured");
  });

  it("treats the gateway's keyless sentinel as not a credential", async () => {
    // A keyless request — no key at all, or the literal `public` — is the
    // vendor's own anonymous path: the proxy strips the sentinel before
    // forwarding (`packages/console/app/src/lib/inference-proxy.ts`, both 1.19
    // and 2.x: `const anonymous = !key || key === "public"`).
    // `docs/upstream-findings.md` §1.5. Old code omitted it, so the literal was
    // captured, then forwarded as a real Bearer, turning an anonymous request
    // into an authenticated one.
    expect(isPlaceholderApiKey("public")).toBe(true);
    expect(isPlaceholderApiKey("PUBLIC")).toBe(true);

    // Never captured from a live request, however it arrives.
    clearCapturedApiKeys();
    recordCapturedApiKey("public", "opencode-go", GO_REQUEST);
    expect(getCapturedApiKey("opencode-go")).toBeUndefined();

    // And never used as a declared env credential, so a free turn goes out
    // keyless rather than carrying the sentinel.
    const context = composition([
      registryEntry("opencode-go", {
        headers: { authorization: "Bearer public" },
      }),
    ]);
    process.env.OPENCODE_GO_API_KEY = "public";
    expect(
      await resolveGoApiKey(context, "opencode-go", "auto")
    ).toBeUndefined();
    expect(discoverGoConfig(context).literalKey).toBeUndefined();
  });

  it("filters a Zen key out of the Go endpoint however it was filed", async () => {
    // The `captured` step is scoped to the route in hand and used to return
    // that route's key without consulting the tier, while the declared sources
    // reject `oc_sk_…` unconditionally and the any-route captured step asks
    // for the Go tier. So the same secret was unusable from every source
    // EXCEPT the one that matters most — and it is first in `auto` and
    // `request`. Reachable whenever a request left the Go route carrying a Zen
    // key (a `OPENCODE_GO_API_KEY` mislabelled to the Zen secret, say).
    //
    // Fixed in `getCapturedApiKey`: the route-scoped map now stores the tier
    // alongside the key and applies the same rule as the other two lookups.
    // Naming a route is a PREFERENCE, not a licence to ignore the tier.
    // Under any other route id it was always filtered correctly:
    clearCapturedApiKeys();
    recordCapturedApiKey("oc_sk_zen", "my-relay", ZEN_REQUEST);
    expect(
      await resolveGoApiKey(composition(), "opencode-go", "request")
    ).toBeUndefined();
    expect(
      await resolveGoKeyForRef(composition(), DEFAULT_USAGE_KEY_ENV)
    ).toBeUndefined();

    // Filed under the Go route id it is now filtered identically, so no policy
    // can surface it.
    clearCapturedApiKeys();
    recordCapturedApiKey("oc_sk_zen", "opencode-go", ZEN_REQUEST);
    for (const policy of KEY_SOURCE_POLICIES) {
      expect(
        await resolveGoApiKey(composition(), "opencode-go", policy),
        `policy ${policy} sent a Zen key to the Go endpoint`
      ).toBeUndefined();
    }

    // And a correctly-classified key filed under the same route id still
    // answers — the filter rejects the wrong tier, not the right one.
    clearCapturedApiKeys();
    recordCapturedApiKey("sk-go-key", "opencode-go", GO_REQUEST);
    expect(await resolveGoApiKey(composition(), "opencode-go", "auto")).toBe(
      "sk-go-key"
    );
  });

  it("never sends a whitespace-only credential to the Go endpoint", async () => {
    // CHARACTERISED, NOT ENDORSED. `readProviderRow` and `firstResolved` both
    // ask only whether a value is a non-empty *string*, so a row carrying
    // `apiKey: "   "` — what a YAML value with trailing whitespace parses to —
    // declares a credential that is whitespace. It is the first step of `auto`
    // and `configured`, so it outranks a working stored credential and the
    // meter authenticated as `Bearer    ` on every poll. Same class as the
    // placeholder gap above — a declared value that is not a credential — and
    // fixed by the same `usableCredential` guard.
    const context = composition([
      registryEntry("opencode-go", { apiKey: "   " }),
    ]);
    process.env.OPENCODE_GO_API_KEY = "sk-real-env-key";
    recordCapturedApiKey("sk-real-captured", "opencode-go", GO_REQUEST);

    // Same guard as the placeholder above: a blanked-but-indented secret must
    // not reach the wire under ANY policy, not only the ones that happen to
    // rank the captured steps first.
    expect(await resolveGoApiKey(context, "opencode-go", "auto")).toBe(
      "sk-real-captured"
    );
    expect(await resolveGoApiKey(context, "opencode-go", "configured")).toBe(
      "sk-real-env-key"
    );
    expect(await resolveGoApiKey(context, "opencode-go", "request")).toBe(
      "sk-real-captured"
    );
  });

  it("never asks the credentials service the same reference twice", async () => {
    // `resolveGoKeyForRef` builds `[ref, DEFAULT_USAGE_KEY_ENV]` for every
    // reference, and `effectiveGoKeyRef` FALLS BACK to the default — so the
    // common case, a profile with no declared `apiKeyEnv`, asked the host the
    // same question twice on every meter poll. Fixed by deduplicating the
    // ladder while keeping its order, because order is the policy.
    const probe = withCredentials({ [DEFAULT_USAGE_KEY_ENV]: "sk-stored" });
    expect(await resolveGoApiKey(probe.context, undefined, "configured")).toBe(
      "sk-stored"
    );
    expect(probe.asked).toEqual([DEFAULT_USAGE_KEY_ENV]);

    // A genuinely different declared reference is still asked FIRST, then the
    // default — deduplication must not reorder or drop a real candidate.
    const declared = withCredentials({ DSH_TEST_GO_KEY: "sk-declared" }, [
      registryEntry("opencode-go", { apiKeyEnv: "DSH_TEST_GO_KEY" }),
    ]);
    expect(
      await resolveGoApiKey(declared.context, undefined, "configured")
    ).toBe("sk-declared");
    expect(declared.asked).toEqual(["DSH_TEST_GO_KEY", DEFAULT_USAGE_KEY_ENV]);
  });
});

describe("go-discovery: the key resolution chain, end to end", () => {
  /** The row shape a deployment's LLM plugin carries, with both routes named. */
  const llmRow = {
    options: {
      config: {
        providers: {
          "opencode-go": { apiKeyEnv: "OPENCODE_GO_API_KEY" },
          opencode: { apiKeyEnv: "OPENCODE_API_KEY" },
        },
      },
      name: "@deepseek-ai/dsh-llm-pi-ai",
    },
  };

  it("finds the Go route's reference and resolves it from the environment", async () => {
    // The chain a silent meter would hide: the loader's rows name the route, the
    // route names the reference, and the reference has to resolve. Each link is
    // asserted, because "no data" says nothing about which one broke.
    const ctx = { get: vi.fn(), loader: { entries: () => [llmRow] } };
    const discovered = discoverGoConfig(ctx);
    expect(effectiveGoKeyRef(discovered)).toBe("OPENCODE_GO_API_KEY");

    process.env.OPENCODE_GO_API_KEY = "go-key-from-env";
    try {
      await expect(resolveGoApiKey(ctx)).resolves.toBe("go-key-from-env");
    } finally {
      process.env.OPENCODE_GO_API_KEY = "";
    }
  });

  it("resolves through the credential service when the environment has nothing", async () => {
    // The deployment's actual case: the key lives in the credential store, not
    // the environment. This is the link that fails silently when the service is
    // not reachable from the plugin's context — the environment fallback then
    // answers undefined and the meter has nothing to render.
    const asked: string[] = [];
    const ctx = {
      get: (name: string) =>
        name === "credentials"
          ? {
              resolve: (ref: string) => {
                asked.push(ref);
                return Promise.resolve({ value: "go-key-from-store" });
              },
            }
          : undefined,
      loader: { entries: () => [llmRow] },
    };
    await expect(resolveGoApiKey(ctx)).resolves.toBe("go-key-from-store");
    expect(asked).toContain("OPENCODE_GO_API_KEY");
  });

  it("answers nothing rather than throwing when the loader is unreachable", () => {
    // A composition whose context cannot see the loader has no routes to read,
    // and the resolution says so instead of failing a request over it.
    expect(discoverGoConfig({ get: vi.fn() })).toEqual({});
  });
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
    // ...while the Zen route resolves that same row. The plane is what the
    // store is keyed by, and a reader that took the first row would hand the Go
    // endpoint a Zen credential.
    const routed = await resolveRoutedKey(
      composition(),
      "opencode",
      "auto",
      true
    );
    expect(routed.key).toBe("oc_sk_fixture_zen");
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

describe("go-discovery · the declaration in the loader", () => {
  // **A GENERATOR, because that is what the host returns.** The first version of
  // this reader guarded with `Array.isArray` and rejected a working loader —
  // measured as the routes still not mounting after the fix that was supposed to
  // mount them.
  const loaderWith = (providers: unknown) => ({
    loader: {
      *entries() {
        yield { options: { config: { providers } } };
      },
    },
  });

  it("reads the declared ids and names for one route", () => {
    const ctx = loaderWith({
      opencode: { models: [{ id: "gpt-5.4", name: "GPT-5.4" }, { id: "" }] },
      "opencode-go": { models: [{ id: "deepseek-v4.1-flash" }] },
    });
    expect(declaredProviderModels(ctx, "opencode")).toEqual([
      { id: "gpt-5.4", name: "GPT-5.4" },
    ]);
    // A route the loader does not describe is UNDEFINED, not empty: "cannot
    // read" and "declares nothing" must stay distinguishable.
    expect(declaredProviderModels(ctx, "nvidia")).toBeUndefined();
  });

  it("answers an empty list for a row that declares no models", () => {
    expect(
      declaredProviderModels(loaderWith({ opencode: {} }), "opencode")
    ).toEqual([]);
  });

  it("survives a context it cannot read at all", () => {
    // Not an object, no loader anywhere, and a `get` that throws: each is
    // "cannot read", never an exception out of a boot path.
    expect(declaredProviderModels(undefined, "opencode")).toBeUndefined();
    expect(declaredProviderModels({}, "opencode")).toBeUndefined();
    expect(
      declaredProviderModels(
        {
          get: () => {
            throw new Error("no loader");
          },
        },
        "opencode"
      )
    ).toBeUndefined();
    // A `get` that answers nothing falls through to the property, which here
    // does not exist either.
    expect(
      declaredProviderModels({ get: () => {} }, "opencode")
    ).toBeUndefined();
  });

  it("survives entries that are not an array or not shaped like rows", () => {
    expect(
      declaredProviderModels({ loader: { entries: () => "nope" } }, "opencode")
    ).toBeUndefined();
    expect(
      declaredProviderModels(
        {
          loader: {
            entries: () => [
              null,
              { options: null },
              { options: { config: {} } },
            ],
          },
        },
        "opencode"
      )
    ).toBeUndefined();
  });
});
