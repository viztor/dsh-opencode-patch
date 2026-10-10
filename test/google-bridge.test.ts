/**
 * `google-bridge.ts` — the route this plugin registers for itself, verified
 * against the real `PiAiAdapter` class and the real Google protocol module
 * rather than a stand-in for either.
 *
 * The bridge exists because every supported path to these models was measured
 * and closed: the wrapper's hand-declared table refuses the protocol, a
 * catalog route may only take the catalog provider's own name, and the
 * registration handle that would hand a route back is never seen by a plugin
 * that loads after the wrapper. What this file proves is that the objects the
 * bridge builds by hand are the ones the real consumer accepts.
 */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

import { PiAiAdapter } from "@deepseek-ai/dsh-llm-pi-ai";
import semver from "semver";
import { describe, expect, it } from "vitest";

import { OPENCODE_ZEN_CATALOG } from "../src/catalog-data.ts";
import {
  type GoogleBridgeInputs,
  googleProviderFor,
  registerGoogleBridge,
  resolveGatewayKey,
} from "../src/google-bridge.ts";
import { GOOGLE_INTERNAL_ROUTE, GOOGLE_SDK } from "../src/responses-routes.ts";

/** The Gemini models of the Zen plane, straight from the generated catalog. */
const geminiSpecs = OPENCODE_ZEN_CATALOG.filter(
  (spec) => spec.provider_npm === GOOGLE_SDK
);

/** One model the provider serves, as this file reads it back. */
interface ModelLike {
  api: string;
  baseUrl: string;
  id: string;
  provider: string;
}

/** The provider surface this file exercises. */
interface ProviderLike {
  getModels: () => ModelLike[];
  stream: (
    model: ModelLike,
    context: unknown,
    options?: unknown
  ) => AsyncIterable<unknown>;
}

/** The bridge's provider, through the one cast the test needs. */
const providerAs = (specs: typeof geminiSpecs): ProviderLike =>
  googleProviderFor(specs) as unknown as ProviderLike;

/** The `llm` the bridge registers on: it records what the service received. */
const recordingLlm = (): {
  llm: GoogleBridgeInputs["llm"];
  registered: { adapter: unknown; routes: readonly string[] }[];
} => {
  const registered: { adapter: unknown; routes: readonly string[] }[] = [];
  return {
    llm: {
      registerAdapter: (routes, adapter) => {
        registered.push({ adapter, routes });
        return () => {};
      },
    },
    registered,
  };
};

/** The bridge's standard inputs, against the real adapter class. */
const bridgeInputs = (
  llm: GoogleBridgeInputs["llm"],
  apiKeyRef = "OPENCODE_API_KEY"
): GoogleBridgeInputs => ({
  apiKeyRef,
  ctx: {},
  host: { PiAiAdapter },
  llm,
  specs: geminiSpecs,
});

describe("google-bridge · the provider it builds", () => {
  it("carries every Gemini model of the Zen plane with the gateway base", () => {
    const models = providerAs(geminiSpecs).getModels();
    expect(models.length).toBe(geminiSpecs.length);
    for (const model of models) {
      // The URL this protocol produces on this base was measured end to end:
      // …/zen/v1/models/<id>:streamGenerateContent?alt=sse.
      expect(model.api).toBe("google-generative-ai");
      expect(model.baseUrl).toBe("https://opencode.ai/zen/v1");
      // The provider field names the route, the way the wrapper's own model
      // resolution sets it — not the plane the model was catalogued on.
      expect(model.provider).toBe(GOOGLE_INTERNAL_ROUTE);
    }
  });

  it("sends each model to the gateway with the resolved key", async () => {
    const provider = providerAs(geminiSpecs);
    const seen: { headers: Record<string, string>; url: string }[] = [];
    const real = globalThis.fetch;
    globalThis.fetch = (async (
      input: unknown,
      init?: { headers?: unknown }
    ) => {
      let raw: Record<string, string> = {};
      const candidate = init?.headers;
      if (candidate instanceof Headers) {
        raw = {};
        for (const [key, value] of candidate.entries()) {
          raw[key] = value;
        }
      } else if (typeof candidate === "object" && candidate !== null) {
        raw = candidate as Record<string, string>;
      }
      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries(raw)) {
        headers[key.toLowerCase()] = value;
      }
      seen.push({
        headers,
        url: typeof input === "string" ? input : String(input),
      });
      throw new Error("captured");
    }) as typeof globalThis.fetch;
    try {
      for (const model of provider.getModels()) {
        seen.length = 0;
        try {
          const stream = provider.stream(
            model,
            { messages: [{ role: "user", content: "hi" }] },
            { apiKey: "oc_sk_resolved" }
          );
          for await (const _ of stream) {
            // The capture refuses the call; nothing arrives.
          }
        } catch {
          // Expected: the capture refuses the request.
        }
        expect(seen.length).toBe(1);
        expect(seen[0]?.url).toBe(
          `https://opencode.ai/zen/v1/models/${model.id}:streamGenerateContent?alt=sse`
        );
        // This protocol's credential header, measured against the gateway:
        // the request-level key rides x-goog-api-key, not Authorization.
        expect(seen[0]?.headers["x-goog-api-key"]).toBe("oc_sk_resolved");
      }
    } finally {
      globalThis.fetch = real;
    }
  });
});

describe("google-bridge · the adapter it registers", () => {
  it("registers the route through the real PiAiAdapter class", () => {
    const { llm, registered } = recordingLlm();
    const handle = registerGoogleBridge(bridgeInputs(llm));
    expect(handle).toBeDefined();
    expect(registered.length).toBe(1);
    expect(registered[0]?.routes).toEqual([GOOGLE_INTERNAL_ROUTE]);
  });

  it("answers the service's questions from the profile the real class consumed", () => {
    const { llm, registered } = recordingLlm();
    registerGoogleBridge(bridgeInputs(llm));
    const adapter = registered[0]?.adapter as {
      providerInfo: (provider: string) => { id: string; name: string };
      providerRetryPolicy: (provider: string) => {
        maxRetries: number;
        mode: string;
      };
    };
    expect(adapter).toBeDefined();
    // A profile the real class rejects would make these throw, not lie.
    expect(adapter.providerInfo(GOOGLE_INTERNAL_ROUTE)).toEqual({
      id: GOOGLE_INTERNAL_ROUTE,
      name: "OpenCode (Google)",
    });
    // The defaults were read from the harness's own retry table: five
    // retries is its number, not ours.
    const policy = adapter.providerRetryPolicy(GOOGLE_INTERNAL_ROUTE);
    expect(policy.mode).toBe("normal");
    expect(policy.maxRetries).toBe(5);
  });

  it("declines to mount where no loaded wrapper handed it an adapter", () => {
    const { llm, registered } = recordingLlm();
    const handle = registerGoogleBridge({
      ...bridgeInputs(llm),
      host: undefined,
    });
    expect(handle).toBeUndefined();
    expect(registered.length).toBe(0);
  });
});

describe("google-bridge · the key it resolves", () => {
  it("reads a set reference from the environment", async () => {
    process.env.BRIDGE_TEST_KEY = "oc_sk_from_env";
    try {
      await expect(
        resolveGatewayKey({}, "BRIDGE_TEST_KEY", "opencode-google")
      ).resolves.toBe("oc_sk_from_env");
    } finally {
      process.env.BRIDGE_TEST_KEY = "";
    }
  });

  it("fails loud when a named reference resolves to nothing", async () => {
    delete process.env.BRIDGE_TEST_ABSENT;
    // The loud miss is the point: pi would treat `undefined` as "resolve
    // ambient auth instead", billing whatever key it finds first.
    await expect(
      resolveGatewayKey({}, "BRIDGE_TEST_ABSENT", "opencode-google")
    ).rejects.toThrow(/MISSING_CREDENTIAL/);
  });

  it("answers undefined only when no reference was named", async () => {
    await expect(
      resolveGatewayKey({}, undefined, "opencode-google")
    ).resolves.toBeUndefined();
  });
});

describe("google-bridge · the pi copy it may load", () => {
  it("pins a pi version the wrapper's requirement accepts", () => {
    // A second pi beside the wrapper's is the failure this guards: two module
    // instances would drift apart the moment either side bumps. The wrapper
    // states a RANGE, so the claim is that our exact pin satisfies it — both
    // read live, so a harness bump that moves either side turns this red.
    const ours = JSON.parse(readFileSync("package.json", "utf8")) as {
      dependencies?: Record<string, string>;
    };
    const require = createRequire(import.meta.url);
    const wrapperRoot = require.resolve("@deepseek-ai/dsh-llm-pi-ai");
    const wrapperDir = wrapperRoot.slice(
      0,
      wrapperRoot.lastIndexOf("/lib/") + 1
    );
    const wrapper = JSON.parse(
      readFileSync(`${wrapperDir}package.json`, "utf8")
    ) as {
      dependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
    };
    const ourVersion = ours.dependencies?.["@earendil-works/pi-ai"];
    const required =
      wrapper.dependencies?.["@earendil-works/pi-ai"] ??
      wrapper.peerDependencies?.["@earendil-works/pi-ai"];
    expect(ourVersion).toBeDefined();
    expect(required).toBeDefined();
    expect(semver.satisfies(ourVersion ?? "", required ?? "")).toBe(true);
  });
});
