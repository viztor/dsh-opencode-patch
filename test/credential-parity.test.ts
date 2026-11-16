/**
 * Every credential decider in `src/`, side by side: where they agree, and
 * where the design says they differ.
 *
 * Four deciders answer "which key?" today:
 *
 * | decider | where | reads |
 * | :-- | :-- | :-- |
 * | the fill | the fetch patch, for an empty or placeholder wire key | the request, a captured key, the process environment, the installation's store |
 * | the meter | `resolveGoApiKey` | a discovered literal, a captured key, the credentials service then the environment, the store |
 * | Zen credit | `resolveZenCreditInfo` | a captured Zen key, then `OPENCODE_API_KEY` (on the base, without the placeholder filter: row (5) does not cover it, and `go-discovery-keys.test.ts` holds that case) |
 * | the adapter | `PlaneAdapter` (D20) | pi-ai's own rule: the named reference through the credentials service, else pi's lookup, the store last |
 *
 * This file is a PIN: it was written and run against the tree before the
 * resolver was consolidated (P6), and no expectation in it changes with that
 * change. Review edited it twice without touching an expectation (the policy
 * type derived from `KEY_SOURCE_POLICIES`, and `disposeMounted()` in the
 * `afterEach`), and the landed form was run on the base again. It reaches the deciders only through doors that survive the move — the plugin
 * mounted on a real `Context`, a decorated turn through cordis's own
 * `llm/stream` waterfall, the patched `globalThis.fetch`, the meter's and the
 * credit's exported resolvers, and tier A for the adapter — and a captured key
 * is only ever seeded the way the plugin learns one: a decorated turn that
 * sends it.
 *
 * @module test/credential-parity.test
 */
import { Context } from "@deepseek-ai/cordis";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { disposeMounted, mountPlugin } from "./support/composition.ts";
import { offline, turn } from "./support/host-planes.ts";
import {
  fakeCredentials,
  mountTierA,
  type TierA,
  waitForPlaneOwner,
} from "./support/host.ts";
import {
  createOpencodeStore,
  type FixtureStore,
} from "./support/opencode-store-fixture.ts";
import {
  KEY_SOURCE_POLICIES,
  resolveGoApiKey,
  resolveZenCreditInfo,
} from "./support/src.ts";
import { collectUnknown, urlOf } from "./test-helpers.ts";

/**
 * The policy, derived from the list the door has always exported, so the pin
 * type-checks against the base on its own.
 */
type KeySourcePolicy = (typeof KEY_SOURCE_POLICIES)[number];

const GO_URL = "https://opencode.ai/zen/go/v1/chat/completions";
const ZEN_URL = "https://opencode.ai/zen/v1/chat/completions";

/** What the wrapped fetch saw on each request, credential values included. */
let sent: { url: string; authorization: string | null }[] = [];
let stores: FixtureStore[] = [];
let tierA: TierA | undefined;

beforeEach(() => {
  // The process environment the fill and the meter read: blank, so a key a
  // developer exported cannot answer a case.
  vi.stubEnv("OPENCODE_API_KEY", "");
  vi.stubEnv("OPENCODE_GO_API_KEY", "");
  sent = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      sent.push({
        authorization: new Headers(init?.headers).get("authorization"),
        url: urlOf(input),
      });
      return Response.json({});
    })
  );
});

afterEach(async () => {
  try {
    await disposeMounted();
    await tierA?.dispose();
  } finally {
    tierA = undefined;
    for (const store of stores.splice(0)) {
      store.cleanup();
    }
    stores = [];
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  }
});

/** A credentials service answering `refs` by name, or throwing for every ref. */
const credentialsService = (
  refs: Readonly<Record<string, string>>
): { resolve: (ref: string) => Promise<unknown> } => ({
  resolve: async (ref) => {
    const value = refs[ref];
    return value === undefined ? undefined : { source: "fake", value };
  },
});

/** The installation's own store, holding a key per plane, and the reader pointed at it. */
const installationStore = (go: string, zen: string): void => {
  const store = createOpencodeStore([
    { integrationId: "opencode-go", value: go },
    { integrationId: "opencode", value: zen },
  ]);
  stores.push(store);
  vi.stubEnv("XDG_DATA_HOME", store.root);
};

/** The plugin, mounted with `policy`, on a root that may hold a credentials service. */
const compose = async (
  policy: KeySourcePolicy,
  options: {
    readonly refs?: Readonly<Record<string, string>>;
    readonly readOpencodeStore?: boolean;
  } = {}
): Promise<Context> => {
  const ctx = new Context();
  if (options.refs !== undefined) {
    ctx.provide("credentials", credentialsService(options.refs) as never);
  }
  await mountPlugin({
    config: {
      keySource: policy,
      readOpencodeStore: options.readOpencodeStore ?? false,
    },
    ctx,
  });
  return ctx;
};

/**
 * One decorated turn that sends `bearer` to `url`, the way an adapter sends
 * its request: through the patched `globalThis.fetch`, inside the stream
 * hook's turn.
 *
 * @returns the `Authorization` the wrapped fetch saw.
 */
const decoratedTurn = async (
  ctx: Context,
  provider: string,
  url: string,
  bearer: string
): Promise<string | null> => {
  const before = sent.length;
  const downstream = async function* downstream() {
    await globalThis.fetch(url, {
      body: JSON.stringify({ model: "parity-model" }),
      headers: { authorization: `Bearer ${bearer}` },
      method: "POST",
    });
    yield { type: "finish" };
  };
  await collectUnknown(
    (
      ctx as unknown as {
        waterfall: (event: string, ...args: unknown[]) => unknown;
      }
    ).waterfall(
      "llm/stream",
      { provider, sessionId: "parity" },
      downstream
    ) as AsyncIterable<unknown>
  );
  return sent.slice(before).at(-1)?.authorization ?? null;
};

/** The fill's answer for a placeholder Go request inside a decorated turn. */
const goFill = (ctx: Context): Promise<string | null> =>
  decoratedTurn(ctx, "opencode-go", GO_URL, "unused");

describe("credential parity: one table, four deciders (fill, meter, Zen credit, adapter)", () => {
  describe.each(KEY_SOURCE_POLICIES)("policy %s", (policy) => {
    it("(1) only OPENCODE_GO_API_KEY exported: the fill and the meter both answer it", async () => {
      vi.stubEnv("OPENCODE_GO_API_KEY", "env-go");
      const ctx = await compose(policy);
      expect(await goFill(ctx)).toBe("Bearer env-go");
      expect(await resolveGoApiKey(ctx, "opencode-go", policy)).toBe("env-go");
    });

    it("(2) only the credentials service holds the ref: the fill leaves the placeholder and warns once, the meter resolves it", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {
        // captured below
      });
      const ctx = await compose(policy, {
        refs: { OPENCODE_GO_API_KEY: "svc-go" },
      });
      expect(await goFill(ctx)).toBe("Bearer unused");
      expect(await goFill(ctx)).toBe("Bearer unused");
      const reports = warn.mock.calls
        .map(([message]) => String(message))
        .filter((message) => message.includes("no credential resolved"));
      expect(reports).toHaveLength(1);
      for (const source of [
        "a key on the request: none",
        `a key captured from a live request (policy ${policy}): none`,
        "OPENCODE_GO_API_KEY: unset",
        "the installation's own store: not enabled",
      ]) {
        expect(reports[0]).toContain(source);
      }
      expect(await resolveGoApiKey(ctx, "opencode-go", policy)).toBe("svc-go");
    });

    it("(3) a key seen on a decorated Go turn: the fill takes it unless the policy is configured; the meter follows its order", async () => {
      // Without a declared key: `configured` still reaches the captured step
      // in the meter, never in the fill.
      const bare = await compose(policy);
      expect(await decoratedTurn(bare, "opencode-go", GO_URL, "seen-go")).toBe(
        "Bearer seen-go"
      );
      expect(await goFill(bare)).toBe(
        policy === "configured" ? "Bearer unused" : "Bearer seen-go"
      );
      expect(await resolveGoApiKey(bare, "opencode-go", policy)).toBe(
        "seen-go"
      );

      // With a declared key beside it: `request` and `auto` put the captured
      // key first in both, `configured` the declared one.
      vi.stubEnv("OPENCODE_GO_API_KEY", "env-go");
      const declared = await compose(policy);
      await decoratedTurn(declared, "opencode-go", GO_URL, "seen-go");
      const expected = policy === "configured" ? "env-go" : "seen-go";
      expect(await goFill(declared)).toBe(`Bearer ${expected}`);
      expect(await resolveGoApiKey(declared, "opencode-go", policy)).toBe(
        expected
      );
    });

    it("(4) a key seen on a decorated Zen turn never answers a Go lookup, and is Zen credit", async () => {
      const ctx = await compose(policy);
      await decoratedTurn(ctx, "opencode", ZEN_URL, "seen-zen");
      expect(await goFill(ctx)).toBe("Bearer unused");
      expect(await resolveGoApiKey(ctx, "opencode-go", policy)).toBeUndefined();
      expect(await resolveGoApiKey(ctx, undefined, policy)).toBeUndefined();
      const credit = await resolveZenCreditInfo(ctx);
      expect(credit.isConfigured).toBe(true);
    });

    it("(5) placeholders in every declared source: no decider answers", async () => {
      vi.stubEnv("OPENCODE_API_KEY", "unused");
      vi.stubEnv("OPENCODE_GO_API_KEY", "public");
      const ctx = await compose(policy, {
        refs: { OPENCODE_API_KEY: "none", OPENCODE_GO_API_KEY: "unused" },
      });
      // A placeholder on a decorated turn is never recorded either.
      await decoratedTurn(ctx, "opencode-go", GO_URL, "public");
      expect(await goFill(ctx)).toBe("Bearer unused");
      expect(await decoratedTurn(ctx, "opencode", ZEN_URL, "unused")).toBe(
        "Bearer unused"
      );
      expect(await resolveGoApiKey(ctx, "opencode-go", policy)).toBeUndefined();
    });

    it("(6) the installation's store, opted in: last in the fill and in the meter", async () => {
      installationStore("store-go", "store-zen");
      const alone = await compose(policy, { readOpencodeStore: true });
      expect(await goFill(alone)).toBe("Bearer store-go");
      expect(await decoratedTurn(alone, "opencode", ZEN_URL, "unused")).toBe(
        "Bearer store-zen"
      );
      expect(await resolveGoApiKey(alone, "opencode-go", policy, true)).toBe(
        "store-go"
      );

      vi.stubEnv("OPENCODE_GO_API_KEY", "env-go");
      const declared = await compose(policy, { readOpencodeStore: true });
      expect(await goFill(declared)).toBe("Bearer env-go");
      expect(await resolveGoApiKey(declared, "opencode-go", policy, true)).toBe(
        "env-go"
      );
    });

    it("(7) a real key on the wire is never replaced by any source", async () => {
      installationStore("store-go", "store-zen");
      vi.stubEnv("OPENCODE_GO_API_KEY", "env-go");
      vi.stubEnv("OPENCODE_API_KEY", "env-zen");
      const ctx = await compose(policy, {
        readOpencodeStore: true,
        refs: { OPENCODE_GO_API_KEY: "svc-go" },
      });
      await decoratedTurn(ctx, "opencode-go", GO_URL, "seen-go");
      expect(await decoratedTurn(ctx, "opencode-go", GO_URL, "wire-go")).toBe(
        "Bearer wire-go"
      );
      expect(await decoratedTurn(ctx, "opencode", ZEN_URL, "wire-zen")).toBe(
        "Bearer wire-zen"
      );
    });
  });
});

describe(
  "credential parity: the adapter path, its own row (tier A, D20)",
  { timeout: 30_000 },
  () => {
    /** Tier A with the plugin and one Zen plane entry; `entry` extends it. */
    const mount = async (
      credentials: ReturnType<typeof fakeCredentials>,
      entry: Record<string, unknown> = {},
      plugin: Record<string, unknown> = {}
    ): Promise<TierA> => {
      offline();
      tierA = await mountTierA({
        credentials,
        plugin,
        providers: {
          opencode: { models: [{ id: "deepseek-v4-pro" }], ...entry },
        },
      });
      await waitForPlaneOwner(tierA.llm, ["opencode"]);
      return tierA;
    };

    /** One turn on the plane, through the host's own stream path. */
    const planeTurn = (tier: TierA) =>
      turn(tier.llm, "opencode", "deepseek-v4-pro");

    it("a key rotated in the credentials service takes effect on the next call, with no remount", async () => {
      const credentials = fakeCredentials({ refs: { OPENCODE_API_KEY: "k1" } });
      const tier = await mount(credentials, {
        apiKeyEnv: "OPENCODE_API_KEY",
      });
      const first = await planeTurn(tier);
      await (
        credentials.service.set as unknown as (
          ref: string,
          value: string
        ) => Promise<void>
      )("OPENCODE_API_KEY", "k2-longer");
      const second = await planeTurn(tier);
      expect(first.requests[0]?.headers.authorization).toBe("Bearer k1".length);
      expect(second.requests[0]?.headers.authorization).toBe(
        "Bearer k2-longer".length
      );
    });

    it("a credentials-service failure propagates: no request, an error that is not a missing key", async () => {
      const credentials = fakeCredentials();
      (credentials.service as Record<string, unknown>).resolve = () =>
        Promise.reject(new Error("vault down"));
      const tier = await mount(credentials, {
        apiKeyEnv: "OPENCODE_API_KEY",
      });
      const { drained, requests } = await planeTurn(tier);
      expect(requests).toEqual([]);
      expect(drained.finish?.kind).toBe("error");
      expect(drained.finish?.code).not.toBe("MISSING_CREDENTIAL");
      expect(drained.failureMessage ?? drained.error).toMatch(/vault down/u);

      // The contrast the table documents: the meter, over the same failing
      // service, does not throw, and answers the exported variable.
      vi.stubEnv("OPENCODE_GO_API_KEY", "env-go");
      expect(await resolveGoApiKey(tier.ctx, "opencode-go")).toBe("env-go");
    });

    it("a key seen on a turn never answers the adapter for a ref that resolves nothing", async () => {
      const tier = await mount(fakeCredentials(), {
        apiKeyEnv: "OPENCODE_API_KEY",
      });
      // A decorated turn on the plane route that sends its own key: the fill
      // and the meter may learn it, the adapter never reads it.
      const downstream = async function* downstream() {
        await globalThis.fetch(ZEN_URL, {
          body: JSON.stringify({ model: "deepseek-v4-pro" }),
          headers: { authorization: "Bearer seen-zen" },
          method: "POST",
        });
        yield { type: "finish" };
      };
      await collectUnknown(
        (
          tier.ctx as unknown as {
            waterfall: (event: string, ...args: unknown[]) => unknown;
          }
        ).waterfall(
          "llm/stream",
          { provider: "opencode", sessionId: "parity" },
          downstream
        ) as AsyncIterable<unknown>
      );
      const credit = await resolveZenCreditInfo(tier.ctx);
      expect(credit.isConfigured).toBe(true);
      const { drained, requests } = await planeTurn(tier);
      expect(drained.finish?.code).toBe("MISSING_CREDENTIAL");
      expect(requests).toEqual([]);
    });

    it("the installation's store answers the adapter only when no ref is named and pi's own lookup finds nothing", async () => {
      installationStore("store-go", "store-zen-longer");
      const bare = await mount(
        fakeCredentials(),
        {},
        { readOpencodeStore: true }
      );
      const fromStore = await planeTurn(bare);
      expect(fromStore.requests[0]?.headers.authorization).toBe(
        "Bearer store-zen-longer".length
      );
      await bare.dispose();
      tierA = undefined;

      const piLookup = await mount(
        fakeCredentials({ refs: { OPENCODE_API_KEY: "svc-zen" } }),
        {},
        { readOpencodeStore: true }
      );
      const fromPi = await planeTurn(piLookup);
      expect(fromPi.requests[0]?.headers.authorization).toBe(
        "Bearer svc-zen".length
      );
    });
  }
);
