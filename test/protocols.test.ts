/**
 * The protocol tables the plane routes dispatch on (`src/utils/protocols.ts`).
 *
 * The tripwire: every SDK the bundled catalogs name maps to a protocol, so a
 * catalog that grows a new SDK fails here by name instead of shipping a model
 * nothing serves; and the protocol comes from the catalog's SDK, never from a
 * model's name (D16).
 *
 * @module test/protocols.test
 */
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { piKnows } from "./support/host.ts";
import {
  allOfferedCompatFields,
  COMPAT_GATES,
  compatProtocols,
  FAMILY_SDK_KEY,
  GO_GOOGLE_BASE_URL,
  isGatedCompatField,
  isPlaneRoute,
  isProtocol,
  isServableSdk,
  LEGACY_BASE,
  LEGACY_PLANE_API,
  MODERN_FALLBACK,
  OFFERED_COMPAT,
  OPENCODE_FAMILY_API,
  OPENCODE_GO_CATALOG,
  OPENCODE_ZEN_CATALOG,
  PLANE_ROUTES,
  PROTOCOL_FOR_SDK,
  protocolForSdk,
  PROTOCOLS,
} from "./support/src.ts";

describe("protocols · the SDK table", () => {
  it("maps every catalog SDK, mistral as completions as pi's own data does, and nothing is unserved", () => {
    expect(PROTOCOL_FOR_SDK).toEqual({
      "@ai-sdk/anthropic": "anthropic-messages",
      "@ai-sdk/google": "google-generative-ai",
      "@ai-sdk/mistral": "openai-completions",
      "@ai-sdk/openai": "openai-responses",
    });
    const sdks = new Set(
      [...OPENCODE_ZEN_CATALOG, ...OPENCODE_GO_CATALOG].map(
        (spec) => spec.provider_npm
      )
    );
    // The catalog must actually name SDKs, or the loop below proves nothing.
    expect(sdks.size).toBeGreaterThan(2);
    for (const sdk of sdks) {
      expect(isServableSdk(sdk), `catalog SDK ${String(sdk)}`).toBe(true);
    }
    expect(piKnows("opencode", "mistral-large-4")).toBe("openai-completions");
    expect(protocolForSdk()).toBe("openai-completions");
    expect(protocolForSdk("@ai-sdk/cohere")).toBeUndefined();
    expect(protocolForSdk(5)).toBeUndefined();
    expect(protocolForSdk("@ai-sdk/mistral")).toBe("openai-completions");
    expect(isServableSdk("@ai-sdk/cohere")).toBe(false);
    expect(isServableSdk(5)).toBe(false);
    // An inherited key is not an SDK.
    expect(isServableSdk("toString")).toBe(false);
    expect(protocolForSdk("toString")).toBeUndefined();
    // Nothing is withheld by decision any more: no UNSERVED_* table exists.
    const source = readFileSync(
      new URL("../src/utils/protocols.ts", import.meta.url),
      "utf8"
    );
    expect(source).toContain("export const PROTOCOL_FOR_SDK");
    expect(source).not.toMatch(/export const UNSERVED/u);
  });

  it("names the four protocols and the two planes, and recognizes only those", () => {
    expect(PROTOCOLS).toEqual([
      "openai-completions",
      "openai-responses",
      "anthropic-messages",
      "google-generative-ai",
    ]);
    expect(PROTOCOLS.every(isProtocol)).toBe(true);
    expect(isProtocol("mistral-conversations")).toBe(false);
    expect(isProtocol(null)).toBe(false);
    expect(PLANE_ROUTES).toEqual(["opencode", "opencode-go"]);
    expect(PLANE_ROUTES.every(isPlaneRoute)).toBe(true);
    expect(isPlaneRoute("opencode-responses")).toBe(false);
    expect(isPlaneRoute(1)).toBe(false);
  });
});

describe("protocols · the base tables", () => {
  it("pins the legacy family per plane, with Go's Google on the family every plane shares", () => {
    expect(LEGACY_BASE.opencode).toEqual({
      "anthropic-messages": "https://opencode.ai/zen",
      "google-generative-ai": "https://opencode.ai/zen/v1",
      "openai-completions": "https://opencode.ai/zen/v1",
      "openai-responses": "https://opencode.ai/zen/v1",
    });
    expect(LEGACY_BASE["opencode-go"]).toEqual({
      "anthropic-messages": "https://opencode.ai/zen/go",
      "google-generative-ai": "https://opencode.ai/inference/go/google/v1beta",
      "openai-completions": "https://opencode.ai/zen/go/v1",
      "openai-responses": "https://opencode.ai/zen/go/v1",
    });
    expect(GO_GOOGLE_BASE_URL).toBe(OPENCODE_FAMILY_API.go["@ai-sdk/google"]);
    expect(LEGACY_PLANE_API).toEqual({
      opencode: LEGACY_BASE.opencode["openai-completions"],
      "opencode-go": LEGACY_BASE["opencode-go"]["openai-completions"],
    });
  });

  it("keeps the modern fallback equal to the catalog's own family map, key for key", () => {
    for (const [plane, family] of [
      ["opencode", OPENCODE_FAMILY_API.zen],
      ["opencode-go", OPENCODE_FAMILY_API.go],
    ] as const) {
      for (const protocol of PROTOCOLS) {
        expect(MODERN_FALLBACK[plane][protocol], `${plane} ${protocol}`).toBe(
          family[FAMILY_SDK_KEY[protocol]]
        );
      }
    }
  });
});

describe("protocols · pi-ai's compat gates", () => {
  it("offers per protocol exactly the fields pi-ai's gates offer, and google none", () => {
    expect([...OFFERED_COMPAT["openai-responses"]]).toEqual([
      "supportsDeveloperRole",
      "supportsMaxOutputTokens",
      "supportsStrictMode",
      "supportsLongCacheRetention",
    ]);
    expect([...OFFERED_COMPAT["anthropic-messages"]]).toEqual([
      "supportsEagerToolInputStreaming",
      "supportsLongCacheRetention",
      "supportsCacheControlOnTools",
      "supportsTemperature",
      "forceAdaptiveThinking",
      "allowEmptySignature",
      "supportsStrictTools",
    ]);
    expect(OFFERED_COMPAT["openai-completions"].has("thinkingFormat")).toBe(
      true
    );
    expect(OFFERED_COMPAT["openai-completions"].has("openRouterRouting")).toBe(
      false
    );
    expect(OFFERED_COMPAT["openai-completions"].size).toBe(19);
    expect(OFFERED_COMPAT["google-generative-ai"].size).toBe(0);
    expect(Object.keys(COMPAT_GATES)).toContain("bedrock-converse-stream");
  });

  it("answers which protocols take a field, the offered vocabulary, and whether a gate names it", () => {
    expect(compatProtocols("supportsStrictMode")).toEqual([
      "openai-completions",
      "openai-responses",
      "azure-openai-responses",
      "openai-codex-responses",
      "bedrock-converse-stream",
    ]);
    expect(compatProtocols("openRouterRouting")).toEqual([]);
    expect(compatProtocols("noSuchField")).toEqual([]);
    const offered = allOfferedCompatFields();
    expect(offered[0]).toBe("supportsStore");
    expect(new Set(offered).size).toBe(offered.length);
    expect(offered).toContain("supportsStrictTools");
    expect(isGatedCompatField("openRouterRouting")).toBe(true);
    expect(isGatedCompatField("noSuchField")).toBe(false);
  });
});
