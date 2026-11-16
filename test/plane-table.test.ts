/**
 * The plane a route or a URL belongs to, read through every caller (P7's pin).
 *
 * The rule "which plane is this" was written several times over: the
 * catalog's route rule, the meter's Zen test, the captured key's tier, the
 * discovery wrapper's plane, the core-tool fallback's URL read. P7 folds them
 * into one table without changing any answer, so this file pins each
 * caller's OUTPUT, through names that exist before and after the refactor,
 * and it is not edited while the refactor lands.
 *
 * The callers do not all agree, and that is pinned too rather than
 * reconciled: the meter's `isZenProvider` is case-insensitive and needs
 * "opencode" in the name, while the catalog's route rule is case-sensitive and
 * answers Zen for anything that is not the Go route or a `opencode-go-*`
 * relay. `OpenCode-Go` is therefore not Zen to the meter and Zen to the
 * catalog, on both trees.
 *
 * @module test/plane-table.test
 */
import { AsyncLocalStorage } from "node:async_hooks";

import { afterEach, describe, expect, it, vi } from "vitest";

import { payload } from "./support/catalogs.ts";
import {
  clearSessionUsageStore,
  createStreamHook,
  DEFAULT_FREE_MODEL_MARKER,
  getSessionUsage,
  isCoreToolModel,
  isZenProvider,
  maybeInjectCoreTools,
  recordTurnUsage,
  refreshCatalog,
  resolveConfig,
  resolveDiscoveryProvider,
  tierForRequest,
} from "./support/src.ts";
import { okBody, serviceWithKey, stubFetch } from "./support/usage-fixture.ts";

afterEach(() => {
  vi.unstubAllGlobals();
  clearSessionUsageStore();
});

/** The relay route a deployment may add for the Go plane. */
const GO_RELAY = "opencode-go-relay";

/** Every route the pin reads, with each caller's answer on both trees. */
const ROUTES: readonly {
  readonly route: string | undefined;
  readonly isZen: boolean;
  readonly tier: "go" | "zen" | "unknown";
}[] = [
  { isZen: true, route: "opencode", tier: "zen" },
  { isZen: false, route: "opencode-go", tier: "go" },
  { isZen: false, route: GO_RELAY, tier: "unknown" },
  // Starts with `opencode-go` but not with `opencode-go-`: Zen's google family.
  { isZen: true, route: "opencode-google", tier: "unknown" },
  { isZen: false, route: "OpenCode-Go", tier: "unknown" },
  { isZen: true, route: "OPENCODE", tier: "unknown" },
  { isZen: false, route: "my-relay", tier: "unknown" },
  { isZen: false, route: "", tier: "unknown" },
  { isZen: false, route: undefined, tier: "unknown" },
  // An inherited key of every object is never a route.
  { isZen: false, route: "constructor", tier: "unknown" },
];

describe("plane table · every caller reads the same plane for a route (pin)", () => {
  it("the meter's Zen test and the captured key's tier, per route", () => {
    for (const { isZen, route, tier } of ROUTES) {
      expect(isZenProvider(route), `isZenProvider(${String(route)})`).toBe(
        isZen
      );
      expect(
        tierForRequest(undefined, route),
        `tierForRequest(undefined, ${String(route)})`
      ).toBe(tier);
    }
  });

  it("the discovery wrapper's plane, for the routes it claims", () => {
    const config = resolveConfig({
      providers: ["opencode", "opencode-go", GO_RELAY],
    });
    expect(resolveDiscoveryProvider({ provider: "opencode" }, config)).toBe(
      "zen"
    );
    expect(resolveDiscoveryProvider({ provider: "opencode-go" }, config)).toBe(
      "go"
    );
    // A claimed relay with no base URL: only the two exact routes decide by
    // name, so there is nothing to read its plane from.
    expect(
      resolveDiscoveryProvider({ provider: GO_RELAY }, config)
    ).toBeUndefined();
    expect(
      resolveDiscoveryProvider({ provider: "constructor" }, config)
    ).toBeUndefined();
  });
});

describe("plane table · a decorated turn is billed to its route's plane, relays included (pin)", () => {
  const PRICE_PROBE = "plane-table-price-probe";
  const RATES = { go: 0.15, zen: 0.3 } as const;

  /**
   * One turn's usage, the way the gateway reports it: a million input tokens,
   * so the cost IS the plane's input rate.
   *
   * @yields {unknown} one usage chunk
   */
  const usageStream = async function* usageStream() {
    yield {
      type: "usage",
      usage: {
        inputTokens: 1_000_000,
        outputTokens: 0,
        totalTokens: 1_000_000,
      },
    };
  };

  it("bills each route to the plane the catalog's route rule names", async () => {
    await refreshCatalog(
      async () =>
        Response.json(
          payload({
            go: [{ id: PRICE_PROBE, input: RATES.go }],
            zen: [{ id: PRICE_PROBE, input: RATES.zen }],
          })
        ),
      true
    );
    const hook = createStreamHook(
      { logger: { info: () => {} } } as never,
      resolveConfig({
        providers: [
          "opencode",
          "opencode-go",
          GO_RELAY,
          "opencode-google",
          "OpenCode-Go",
          "my-relay",
        ],
        usageEnabled: true,
      } as never),
      new AsyncLocalStorage()
    );
    const billed = async (provider: string): Promise<unknown> => {
      const sessionId = `plane-table-${provider}`;
      const result = hook({ model: PRICE_PROBE, provider, sessionId }, () =>
        usageStream()
      );
      for await (const _chunk of result as AsyncGenerator) {
        void _chunk;
      }
      return getSessionUsage(sessionId)?.costByPlane;
    };
    expect(await billed("opencode")).toEqual({ go: 0, zen: RATES.zen });
    expect(await billed("opencode-go")).toEqual({ go: RATES.go, zen: 0 });
    expect(await billed(GO_RELAY)).toEqual({ go: RATES.go, zen: 0 });
    expect(await billed("opencode-google")).toEqual({ go: 0, zen: RATES.zen });
    // Case-sensitive: not the Go route, so Zen to the catalog (the header's
    // `OpenCode-Go` claim).
    expect(await billed("OpenCode-Go")).toEqual({ go: 0, zen: RATES.zen });
    expect(await billed("my-relay")).toEqual({ go: 0, zen: RATES.zen });
  });
});

describe("plane table · the URL decides before the route, in both endpoint families (pin)", () => {
  it("files a captured key by the URL's plane first, then by the exact route", () => {
    expect(
      tierForRequest("https://opencode.ai/zen/v1/messages", "opencode-go")
    ).toBe("zen");
    expect(
      tierForRequest(
        "https://opencode.ai/inference/go/openai/v1/chat/completions",
        "opencode"
      )
    ).toBe("go");
    expect(
      tierForRequest("https://opencode.ai/inference/google/v1beta/models")
    ).toBe("zen");
    expect(
      tierForRequest("https://relay.example/v1/chat/completions", "opencode-go")
    ).toBe("go");
    expect(
      tierForRequest("https://relay.example/v1/chat/completions", "my-relay")
    ).toBe("unknown");
  });

  it("reads a gateway draft's plane from its base URL's path", () => {
    const config = resolveConfig({ providers: ["opencode", "opencode-go"] });
    expect(
      resolveDiscoveryProvider(
        { baseURL: "https://opencode.ai/inference/go/openai/v1" },
        config
      )
    ).toBe("go");
    expect(
      resolveDiscoveryProvider(
        { baseURL: "https://opencode.ai/inference/google/v1beta" },
        config
      )
    ).toBe("zen");
  });

  it("reads the core-tool fallback's row from the URL's plane, and with no plane the plane-blind lookup's Go row", async () => {
    // Free on Zen, paid on Go: the plane's own row decides when the request
    // names a plane. With none, the plane-blind lookup answers, and it reads
    // Go first (pinned on its own in `test/plane-lookup.test.ts`); the
    // fallback for a plane whose row is absent is `test/tool-fallback.test.ts`'s.
    const ZEN_ONLY_FREE = "plane-table-tool-probe";
    await refreshCatalog(
      async () =>
        Response.json(
          payload({
            go: [{ id: ZEN_ONLY_FREE, name: "Probe" }],
            zen: [{ free: true, id: ZEN_ONLY_FREE, name: "Probe" }],
          })
        ),
      true
    );
    expect(ZEN_ONLY_FREE).not.toContain(DEFAULT_FREE_MODEL_MARKER);
    expect(isCoreToolModel(ZEN_ONLY_FREE, "", "zen")).toBe(true);
    expect(isCoreToolModel(ZEN_ONLY_FREE, "", "go")).toBe(false);
    // No plane: the plane-blind row, which reads Go first, so paid.
    expect(isCoreToolModel(ZEN_ONLY_FREE, DEFAULT_FREE_MODEL_MARKER)).toBe(
      false
    );

    const body = JSON.stringify({ model: ZEN_ONLY_FREE });
    const options = { enabled: true, modelMarker: "none" };
    expect(
      maybeInjectCoreTools(
        "https://opencode.ai/zen/v1/chat/completions",
        body,
        new Headers(),
        options
      )
    ).not.toBe(body);
    expect(
      maybeInjectCoreTools(
        "https://opencode.ai/zen/go/v1/chat/completions",
        body,
        new Headers(),
        options
      )
    ).toBe(body);
  });
});

describe("plane table · a prospective model is priced from the asking route's plane only, with no other-plane fallback (pin)", () => {
  const GO_ONLY = "plane-table-go-only";
  const GO_RATE = { input: 0.4, output: 1.6 } as const;

  const seedAndRecord = async (): Promise<void> => {
    await refreshCatalog(
      async () =>
        Response.json(
          payload({
            go: [{ id: GO_ONLY, input: GO_RATE.input, output: GO_RATE.output }],
          })
        ),
      true
    );
    // A Go turn of $0.15: a million input tokens at 0.15.
    recordTurnUsage(
      "plane-table-session",
      { inputTokens: 1_000_000, outputTokens: 0, totalTokens: 1_000_000 },
      { input: 0.15, output: 0 },
      "plane-table-ran",
      false,
      "go"
    );
  };

  it("prices the picked model on the route's own plane, and says — where that plane has no row", async () => {
    await seedAndRecord();
    stubFetch(() => new Response(okBody()));
    const service = serviceWithKey("sk-live-key");
    const read = async (provider: string) => {
      const reading = await service.read({
        model: GO_ONLY,
        provider,
        sessionId: "plane-table-session",
      });
      return reading.session;
    };

    const zen = await read("opencode");
    expect(zen?.activeModel).toBe(GO_ONLY);
    expect(zen?.activeRateFormatted).toBe("—");
    expect(zen?.planeCostFormatted).toBe("$0.00");

    const go = await read("opencode-go");
    expect(go?.activeModel).toBe(GO_ONLY);
    expect(go?.activeRateFormatted).toBe(
      `$${String(GO_RATE.input)} / $${String(GO_RATE.output)} per 1M`
    );
    expect(go?.planeCostFormatted).toBe("$0.15");

    const relay = await read(GO_RELAY);
    expect(relay?.activeRateFormatted).toBe(go?.activeRateFormatted);
    expect(relay?.planeCostFormatted).toBe("$0.15");
  });
});
