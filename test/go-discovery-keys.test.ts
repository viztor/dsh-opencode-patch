/**
 * `go-discovery.ts` — the key ladder: which credential source each `keySource`
 * policy lets win, which reference a lookup is asked for, the Zen credit
 * check, and the gaps characterised while pinning the policy.
 *
 * Offline and deterministic: every case restores `process.env` and the
 * captured-key store in `afterEach`.
 *
 * @module test/go-discovery-keys.test
 */
import { Context } from "@deepseek-ai/cordis";
import { afterEach, describe, expect, it } from "vitest";

import {
  composition,
  GO_REQUEST,
  registryEntry,
  withCredentials,
  ZEN_REQUEST,
} from "./support/loader-rows.ts";
import {
  DEFAULT_USAGE_KEY_ENV,
  type DiscoveredGoConfig,
  KEY_SOURCE_POLICIES,
  clearCapturedApiKeys,
  discoverGoConfig,
  effectiveGoKeyRef,
  getCapturedApiKey,
  isPlaceholderApiKey,
  recordCapturedApiKey,
  resolveGoApiKey,
  resolveGoKeyForRef,
  resolveZenCreditInfo,
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
    const ctx = composition([llmRow]);
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
    const { asked, context } = withCredentials(
      { OPENCODE_GO_API_KEY: "go-key-from-store" },
      [llmRow]
    );
    await expect(resolveGoApiKey(context)).resolves.toBe("go-key-from-store");
    expect(asked).toContain("OPENCODE_GO_API_KEY");
  });

  it("answers nothing rather than throwing when the loader is unreachable", () => {
    // A context that serves no loader has no routes to read, and the
    // resolution says so instead of failing a request over it.
    expect(discoverGoConfig(new Context())).toEqual({});
  });
});
