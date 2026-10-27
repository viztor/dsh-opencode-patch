/**
 * `go-discovery.ts` — how a Zen base URL is rewritten onto the Go plane, and
 * which base the meter reads.
 *
 * @module test/go-discovery-base-url.test
 */
import { afterEach, describe, expect, it } from "vitest";

import {
  composition,
  GO_BASE,
  registry,
  registryEntry,
  ZEN_BASE,
} from "./support/loader-rows.ts";
import {
  DEFAULT_USAGE_BASE_URL,
  clearCapturedApiKeys,
  resolveGoBaseURL,
  toGoBaseURL,
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
