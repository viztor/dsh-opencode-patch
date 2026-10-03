/**
 * resolveConfig · Config schema · isOpenCodeRequest (endpoint differentiation).
 *
 * Split out of the former monolithic `plugin.test.ts`.
 *
 * @module test/config.test
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  Config,
  isOpenCodeRequest,
  resolveConfig,
  type ActiveTurnState,
  type PluginConfig,
} from "../src/index.ts";

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.OPENCODE_SESSION_ID;
});

describe("resolveConfig", () => {
  it("fills default providers, toggles, and debug flags", () => {
    const resolved = resolveConfig({});
    expect([...resolved.providers]).toEqual(["opencode", "opencode-go"]);
    expect(resolved.debug).toBe(false);
    expect(resolved.debugFile).toBeUndefined();
    expect(resolved.injectUserAgent).toBe(true);
    expect(resolved.userAgent).toBeUndefined();
    expect(resolved.injectOriginHeaders).toBe(true);
    expect(resolved.injectCoreTools).toBe(true);
  });

  it("preserves custom providers and configuration overrides", () => {
    const resolved = resolveConfig({
      debug: true,
      debugFile: "/tmp/debug.log",
      injectCoreTools: false,
      injectOriginHeaders: false,
      injectUserAgent: false,
      providers: ["custom-opencode", "opencode-dev"],
      userAgent: "my-custom-ua/1.0",
    });
    expect([...resolved.providers]).toEqual([
      "custom-opencode",
      "opencode-dev",
    ]);
    expect(resolved.debug).toBe(true);
    expect(resolved.debugFile).toBe("/tmp/debug.log");
    expect(resolved.injectUserAgent).toBe(false);
    expect(resolved.userAgent).toBe("my-custom-ua/1.0");
    expect(resolved.injectOriginHeaders).toBe(false);
    expect(resolved.injectCoreTools).toBe(false);
  });

  it("falls back to defaults when providers list is empty or blank", () => {
    expect([...resolveConfig({ providers: [] }).providers]).toEqual([
      "opencode",
      "opencode-go",
    ]);
    expect([...resolveConfig({ providers: [""] }).providers]).toEqual([
      "opencode",
      "opencode-go",
    ]);
  });

  it("trims userAgent and treats blank debugFile as unset", () => {
    const resolved = resolveConfig({
      debugFile: "",
      userAgent: "  custom-ua/2.0  ",
    });
    expect(resolved.userAgent).toBe("custom-ua/2.0");
    expect(resolved.debugFile).toBeUndefined();
  });

  it("resolves the adaptivity knobs with blank-is-default semantics", () => {
    const defaults = resolveConfig({});
    expect(defaults.gatewayUrls).toEqual(["opencode.ai/zen"]);
    expect(defaults.originClient).toBe("cli");
    expect(defaults.injectProject).toBe(true);
    expect(defaults.freeModelMarker).toBe("free");
    expect(defaults.sessionIdEnv).toBe("OPENCODE_SESSION_ID");
    expect(defaults.usageProviderMarkers).toEqual(["opencode-go", "opencode"]);

    const custom = resolveConfig({
      freeModelMarker: "  preview  ",
      gatewayUrls: [" relay.example.com/zen ", ""],
      injectProject: false,
      originClient: "desktop",
      sessionIdEnv: "MY_SESSION",
      usageProviderMarkers: ["go-relay"],
    });
    expect(custom.gatewayUrls).toEqual(["relay.example.com/zen"]);
    expect(custom.originClient).toBe("desktop");
    expect(custom.injectProject).toBe(false);
    expect(custom.freeModelMarker).toBe("preview");
    expect(custom.sessionIdEnv).toBe("MY_SESSION");
    expect(custom.usageProviderMarkers).toEqual(["go-relay"]);

    // Blank strings and empty lists fall back instead of disabling the knob.
    const blank = resolveConfig({
      freeModelMarker: "",
      gatewayUrls: [],
      originClient: "",
      sessionIdEnv: "",
      usageProviderMarkers: ["", " "],
    });
    expect(blank.gatewayUrls).toEqual(["opencode.ai/zen"]);
    expect(blank.originClient).toBe("cli");
    expect(blank.injectProject).toBe(true);
    expect(blank.freeModelMarker).toBe("free");
    expect(blank.sessionIdEnv).toBe("OPENCODE_SESSION_ID");
    expect(blank.usageProviderMarkers).toEqual(["opencode-go", "opencode"]);
  });
});

describe("Config schema", () => {
  it("validates an empty row to the documented defaults", () => {
    // The harness validates the patch row against this schema before the
    // plugin sees it, and the settings UI serves the namespace from it — so
    // the schema is what makes the row a real settings section. An empty row
    // must validate to exactly the keys `resolveConfig` understands.
    const validated = Config({}) as Record<string, unknown>;
    // oxlint-disable-next-line unicorn/no-array-sort -- `Object.keys` returns a fresh array, so in-place sort mutates nothing shared.
    expect(Object.keys(validated).sort()).toEqual(
      [
        "debug",
        "enrichModels",
        "freeModelMarker",
        "gatewayUrls",
        "injectCoreTools",
        "injectOriginHeaders",
        "injectProject",
        "injectUserAgent",
        "originClient",
        "providers",
        "sessionIdEnv",
        "showUsagePrice",
        "usageBaseURL",
        "usageEnabled",
        "usageKeyEnv",
        "usageProviderMarkers",
        "userAgent",
        // oxlint-disable-next-line unicorn/no-array-sort -- array literal is fresh, so in-place sort mutates nothing shared.
      ].sort()
    );
    expect(resolveConfig(validated as PluginConfig)).toMatchObject({
      debug: false,
      freeModelMarker: "free",
      gatewayUrls: ["opencode.ai/zen"],
      injectCoreTools: true,
      injectOriginHeaders: true,
      injectProject: true,
      injectUserAgent: true,
      originClient: "cli",
      providers: new Set(["opencode", "opencode-go"]),
      sessionIdEnv: "OPENCODE_SESSION_ID",
      usageBaseURL: "https://opencode.ai/zen/go/v1",
      usageEnabled: true,
      usageKeyEnv: "OPENCODE_GO_API_KEY",
      usageProviderMarkers: ["opencode-go", "opencode"],
    });
  });

  it("resolves validated and raw rows identically", () => {
    // Validated and raw rows reach `resolveConfig` from different layers, and
    // must not disagree about a default — otherwise the settings page would
    // show one thing and the host would enforce another.
    const cases: PluginConfig[] = [
      {},
      { providers: ["opencode"] },
      { injectUserAgent: false, usageEnabled: false, debug: true },
      { usageKeyEnv: "X", usageBaseURL: "https://example.invalid" },
    ];
    for (const row of cases) {
      expect(resolveConfig(Config(row) as unknown as PluginConfig)).toEqual(
        resolveConfig(row)
      );
    }
  });
});

describe("isOpenCodeRequest (endpoint differentiation)", () => {
  const providers = new Set(["opencode", "opencode-go"]);

  it("identifies opencode.ai/zen endpoints", () => {
    expect(
      isOpenCodeRequest(
        "https://opencode.ai/zen/v1/responses",
        undefined,
        providers
      )
    ).toBe(true);
    expect(
      isOpenCodeRequest(
        "https://opencode.ai/zen/go/v1/chat/completions",
        undefined,
        providers
      )
    ).toBe(true);
  });

  it("identifies zen endpoints even when providers set is empty", () => {
    expect(
      isOpenCodeRequest(
        "https://opencode.ai/zen/v1/responses",
        undefined,
        new Set()
      )
    ).toBe(true);
  });

  it("matches gateway URLs from configuration instead of the built-in one", () => {
    const gatewayUrls = ["relay.example.com/zen", "gateway.corp/api"];
    expect(
      isOpenCodeRequest(
        "https://relay.example.com/zen/v1/responses",
        undefined,
        providers,
        gatewayUrls
      )
    ).toBe(true);
    expect(
      isOpenCodeRequest(
        "https://gateway.corp/api/chat",
        undefined,
        providers,
        gatewayUrls
      )
    ).toBe(true);
    // A configured list replaces the default marker, so the stock gateway no
    // longer matches when the operator pointed the plugin elsewhere.
    expect(
      isOpenCodeRequest(
        "https://opencode.ai/zen/v1/responses",
        undefined,
        providers,
        gatewayUrls
      )
    ).toBe(false);
    // Blank markers never match (an empty substring would claim everything).
    expect(
      isOpenCodeRequest("https://anywhere.example/v1", undefined, providers, [
        "",
      ])
    ).toBe(false);
  });

  it("identifies active turn state when routed to matching provider", () => {
    const state: ActiveTurnState = {
      provider: "opencode",
      value: "ses_123",
    };
    expect(
      isOpenCodeRequest("https://my-custom-relay.example/v1", state, providers)
    ).toBe(true);
  });

  it("rejects non-OpenCode requests", () => {
    expect(
      isOpenCodeRequest(
        "https://api.deepseek.com/v1/chat/completions",
        undefined,
        providers
      )
    ).toBe(false);
    expect(
      isOpenCodeRequest(
        "https://api.openai.com/v1/chat/completions",
        undefined,
        providers
      )
    ).toBe(false);
    const nonOpencodeState: ActiveTurnState = {
      provider: "deepseek",
      value: "ses_456",
    };
    expect(
      isOpenCodeRequest(
        "https://api.deepseek.com/v1",
        nonOpencodeState,
        providers
      )
    ).toBe(false);
  });
});
