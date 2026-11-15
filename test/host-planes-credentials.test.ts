/**
 * The plugin owning the plane routes: where a key comes from (D20), that
 * nothing of a sibling route leaks into a plane, and every declared id listed
 * on both planes.
 *
 * @module test/host-planes-credentials.test
 */
import { resolveRetryPolicy } from "@deepseek-ai/dsh-llm";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  disposeBooted,
  offline,
  planeProfile,
  turn,
} from "./support/host-planes.ts";
import {
  adaptersOf,
  bootTierB,
  CHARACTERIZED_MODELS,
  characterizedProviders,
  fakeCredentials,
  modelIds,
  mountTierA,
  PLANES,
  type TierA,
  type TierB,
  waitForPlaneOwner,
} from "./support/host.ts";
import {
  createOpencodeStore,
  type FixtureStore,
} from "./support/opencode-store-fixture.ts";
import {
  clearCapturedApiKeys,
  getCapturedApiKey,
  recordCapturedApiKey,
  resolveGoApiKey,
} from "./support/src.ts";

let tierA: TierA | undefined;

let tierB: TierB | undefined;

afterEach(async () => {
  try {
    await tierA?.dispose();
    await tierB?.dispose();
    await disposeBooted();
  } finally {
    tierA = undefined;
    tierB = undefined;
    clearCapturedApiKeys();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});

describe("host planes · credentials (tier A, D20)", { timeout: 30_000 }, () => {
  const mountWith = async (
    credentials: ReturnType<typeof fakeCredentials>,
    entry: Record<string, unknown> = {}
  ): Promise<TierA> => {
    offline();
    tierA = await mountTierA({
      credentials,
      plugin: {},
      providers: {
        opencode: { models: [{ id: "deepseek-v4-pro" }], ...entry },
      },
    });
    await waitForPlaneOwner(tierA.llm, ["opencode"]);
    return tierA;
  };

  it("with no apiKeyEnv, pi's own discovery reads the credentials service's value", async () => {
    const tier = await mountWith(
      fakeCredentials({ refs: { OPENCODE_API_KEY: "svc-k" } })
    );
    const { requests } = await turn(tier.llm, "opencode", "deepseek-v4-pro");
    expect(requests[0]?.headers.authorization).toBe("Bearer svc-k".length);
  });

  it("a Go plane with no apiKeyEnv authenticates with pi's OPENCODE_API_KEY lookup, on every protocol; naming OPENCODE_GO_API_KEY sends the Go key", async () => {
    // pi 1.1.0's opencode-go provider reads OPENCODE_API_KEY, the same
    // variable as Zen (D20): a Go entry without a reference sends the Zen
    // key. The two keys differ in length, which is what the recorder keeps.
    const refs = {
      OPENCODE_API_KEY: "zen-k-from-the-service",
      OPENCODE_GO_API_KEY: "go-k",
    };
    const sent = async (entry: Record<string, unknown>) => {
      offline();
      tierA = await mountTierA({
        credentials: fakeCredentials({ refs }),
        plugin: {},
        providers: {
          "opencode-go": {
            models: [{ id: "deepseek-v4-pro" }, { id: "minimax-m3" }],
            ...entry,
          },
        },
      });
      await waitForPlaneOwner(tierA.llm, ["opencode-go"]);
      const completions = await turn(
        tierA.llm,
        "opencode-go",
        "deepseek-v4-pro"
      );
      const messages = await turn(tierA.llm, "opencode-go", "minimax-m3");
      await tierA.dispose();
      tierA = undefined;
      return [
        completions.requests[0]?.headers.authorization,
        messages.requests[0]?.headers["x-api-key"],
      ];
    };
    expect(await sent({})).toEqual([
      `Bearer ${refs.OPENCODE_API_KEY}`.length,
      refs.OPENCODE_API_KEY.length,
    ]);
    expect(await sent({ apiKeyEnv: "OPENCODE_GO_API_KEY" })).toEqual([
      `Bearer ${refs.OPENCODE_GO_API_KEY}`.length,
      refs.OPENCODE_GO_API_KEY.length,
    ]);
  });

  it("the Go meter resolves OPENCODE_GO_API_KEY for a no-reference Go entry until a Go turn, then the Zen key that turn carried", async () => {
    // The README's credential-isolation row describes this: the meter never
    // reads an OPENCODE_API_KEY reference, but `auto` puts a key captured on
    // a Go-plane request ahead of the configured one, so a Go entry that
    // names no reference hands the meter the Zen key after its first turn.
    const refs = {
      OPENCODE_API_KEY: "zen-k-from-the-service",
      OPENCODE_GO_API_KEY: "go-k",
    };
    offline();
    tierA = await mountTierA({
      credentials: fakeCredentials({ refs }),
      plugin: {},
      providers: { "opencode-go": { models: [{ id: "deepseek-v4-pro" }] } },
    });
    await waitForPlaneOwner(tierA.llm, ["opencode-go"]);
    expect(await resolveGoApiKey(tierA.ctx, "opencode-go")).toBe(
      refs.OPENCODE_GO_API_KEY
    );
    const { requests } = await turn(
      tierA.llm,
      "opencode-go",
      "deepseek-v4-pro"
    );
    expect(requests[0]?.url).toContain("/inference/go/");
    expect(getCapturedApiKey("opencode-go", "go")).toBe(refs.OPENCODE_API_KEY);
    expect(await resolveGoApiKey(tierA.ctx, "opencode-go")).toBe(
      refs.OPENCODE_API_KEY
    );
  });

  it("a Sign-in record under llm-pi-ai/opencode authenticates the plane", async () => {
    const credentials = fakeCredentials({
      records: { "llm-pi-ai/opencode": { key: "stored-k", kind: "api-key" } },
    });
    const tier = await mountWith(credentials);
    const { requests } = await turn(tier.llm, "opencode", "deepseek-v4-pro");
    expect(requests[0]?.headers.authorization).toBe("Bearer stored-k".length);
    expect(credentials.calls).toContainEqual([
      "readRecord",
      "llm-pi-ai/opencode",
    ]);
  });

  describe("OpenCode's own store, opted into, is the LAST resort", () => {
    const stores: FixtureStore[] = [];

    afterEach(() => {
      for (const store of stores.splice(0)) {
        store.cleanup();
      }
      vi.unstubAllEnvs();
    });

    /** A store holding a Zen key, and the plugin opted into reading it. */
    const mountOptedIn = async (
      credentials: ReturnType<typeof fakeCredentials>
    ): Promise<TierA> => {
      const store = createOpencodeStore([
        { integrationId: "opencode", value: "oc_sk_from_the_store" },
      ]);
      stores.push(store);
      vi.stubEnv("XDG_DATA_HOME", store.root);
      offline();
      tierA = await mountTierA({
        credentials,
        plugin: { readOpencodeStore: true },
        providers: { opencode: { models: [{ id: "deepseek-v4-pro" }] } },
      });
      await waitForPlaneOwner(tierA.llm, ["opencode"]);
      return tierA;
    };

    it("answers when pi's own lookup finds nothing (the known answer)", async () => {
      const tier = await mountOptedIn(fakeCredentials());
      const { requests } = await turn(tier.llm, "opencode", "deepseek-v4-pro");
      expect(requests[0]?.headers.authorization).toBe(
        "Bearer oc_sk_from_the_store".length
      );
    });

    it("never pre-empts an OPENCODE_API_KEY the credentials service holds", async () => {
      const tier = await mountOptedIn(
        fakeCredentials({ refs: { OPENCODE_API_KEY: "svc-k" } })
      );
      const { requests } = await turn(tier.llm, "opencode", "deepseek-v4-pro");
      expect(requests[0]?.headers.authorization).toBe("Bearer svc-k".length);
    });

    it("never pre-empts a Sign-in record under llm-pi-ai/opencode", async () => {
      const tier = await mountOptedIn(
        fakeCredentials({
          records: {
            "llm-pi-ai/opencode": { key: "stored-k", kind: "api-key" },
          },
        })
      );
      const { requests } = await turn(tier.llm, "opencode", "deepseek-v4-pro");
      expect(requests[0]?.headers.authorization).toBe("Bearer stored-k".length);
    });
  });

  it("a named ref that resolves nothing still lists the models, and the turn fails MISSING_CREDENTIAL without a request", async () => {
    const tier = await mountWith(fakeCredentials(), {
      apiKeyEnv: "OPENCODE_API_KEY",
    });
    expect(modelIds(await tier.llm.listModels("opencode"))).toEqual([
      "deepseek-v4-pro",
    ]);
    const { drained, requests } = await turn(
      tier.llm,
      "opencode",
      "deepseek-v4-pro"
    );
    expect(drained.finish).toEqual({
      code: "MISSING_CREDENTIAL",
      kind: "error",
    });
    expect(requests).toEqual([]);
  });

  it("a credentials-service failure propagates rather than reading as a missing key", async () => {
    const credentials = fakeCredentials();
    (credentials.service as Record<string, unknown>).resolve = () =>
      Promise.reject(new Error("vault down"));
    const tier = await mountWith(credentials, {
      apiKeyEnv: "OPENCODE_API_KEY",
    });
    await expect(tier.llm.listModels("opencode")).rejects.toThrow(
      /vault down/u
    );
    const { drained, requests } = await turn(
      tier.llm,
      "opencode",
      "deepseek-v4-pro"
    );
    // The turn fails on the service's own error, and nothing is sent: a
    // swallowed rejection would read as a missing key or go out keyless.
    expect(requests).toEqual([]);
    expect(drained.finish?.kind).toBe("error");
    expect(drained.finish?.code).not.toBe("MISSING_CREDENTIAL");
    expect(drained.failureMessage ?? drained.error).toMatch(/vault down/u);
  });

  it("a rotated key takes effect on the next turn", async () => {
    const credentials = fakeCredentials({ refs: { OPENCODE_API_KEY: "k1" } });
    const tier = await mountWith(credentials, {
      apiKeyEnv: "OPENCODE_API_KEY",
    });
    const first = await turn(tier.llm, "opencode", "deepseek-v4-pro");
    await (
      credentials.service.set as unknown as (
        ref: string,
        value: string
      ) => Promise<void>
    )("OPENCODE_API_KEY", "k2-longer");
    const second = await turn(tier.llm, "opencode", "deepseek-v4-pro");
    expect(first.requests[0]?.headers.authorization).toBe("Bearer k1".length);
    expect(second.requests[0]?.headers.authorization).toBe(
      "Bearer k2-longer".length
    );
  });

  it("a captured key never answers for a named ref that resolves nothing", async () => {
    recordCapturedApiKey("opencode", "cap");
    const tier = await mountWith(fakeCredentials(), {
      apiKeyEnv: "OPENCODE_API_KEY",
    });
    const { drained, requests } = await turn(
      tier.llm,
      "opencode",
      "deepseek-v4-pro"
    );
    expect(drained.finish?.code).toBe("MISSING_CREDENTIAL");
    expect(requests).toEqual([]);
  });
});

describe("host planes · isolation (tier A)", { timeout: 30_000 }, () => {
  it("a sibling's headers, base, api, reasoning and retry never reach a plane", async () => {
    offline();
    tierA = await mountTierA({
      credentials: fakeCredentials({ refs: { OPENCODE_API_KEY: "k" } }),
      plugin: {},
      providers: {
        deepseek: {
          api: "openai-responses",
          apiKeyEnv: "DEEPSEEK_API_KEY",
          baseURL: "http://127.0.0.1:9/v1",
          headers: { "x-sib": "1" },
          reasoning: "high",
          retryPolicy: { maxRetries: 1, mode: "normal" },
        },
        opencode: {
          apiKeyEnv: "OPENCODE_API_KEY",
          models: [{ id: "deepseek-v4-pro" }],
        },
      },
    });
    await waitForPlaneOwner(tierA.llm, ["opencode"]);
    const { requests } = await turn(tierA.llm, "opencode", "deepseek-v4-pro");
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe(
      "https://opencode.ai/inference/openai/v1/chat/completions"
    );
    expect(requests[0]?.headers).not.toHaveProperty("x-sib");
    expect(adaptersOf(tierA.llm).get("opencode")?.retryPolicy).toEqual(
      resolveRetryPolicy(undefined, "t")
    );
    const profile = planeProfile(tierA.llm, "opencode");
    expect(profile.headers).toEqual({});
    expect(profile.reasoning).toBeUndefined();
  });
});

describe(
  "host planes · the declared listing (tier B)",
  { timeout: 30_000 },
  () => {
    it("lists every declared id on both planes, keyless or not", async () => {
      offline();
      tierB = await bootTierB({ providers: characterizedProviders() });
      await waitForPlaneOwner(tierB.llm);
      for (const plane of PLANES) {
        expect(modelIds(await tierB.llm.listModels(plane))).toEqual(
          CHARACTERIZED_MODELS[plane]
        );
      }
    });
  }
);
