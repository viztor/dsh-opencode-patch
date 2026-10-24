/**
 * pi-ai's credential paths, measured on the real package (tier A).
 *
 * D20 says the plane adapter resolves keys "by pi-ai's rule", and P-R1 builds
 * its credential store from pi-ai's record mapping. Both are only as true as
 * what pi-ai does today, so these cases drive a real turn through
 * `LlmRuntime` and read the wire: which key the credentials service was asked
 * for, whether the launch environment was consulted, and what authorization
 * reached the request. Header values are recorded by LENGTH only, so no key
 * text lands in an assertion or a log.
 *
 * Host references are into `deepseek-harness`'s `packages/llm/llm-pi-ai/src`.
 *
 * @module test/host-credentials.test
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  drainStream,
  fakeCredentials,
  fakeLaunchEnvironment,
  mountTierA,
  recordingFetch,
  type TierA,
} from "./support/host.ts";

let tier: TierA | undefined;

afterEach(async () => {
  await tier?.dispose();
  tier = undefined;
  vi.unstubAllGlobals();
});

/** One completions model on Zen, which pi 1.1.0 serves at its legacy base. */
const ZEN_COMPLETIONS = { models: [{ id: "deepseek-v4-pro" }] };
const LEGACY_COMPLETIONS = "https://opencode.ai/zen/v1/chat/completions";

describe("host · pi-ai's credential paths (tier A)", () => {
  it("maps an api-key record under llm-pi-ai/opencode onto the wire with no apiKeyEnv (auth.ts:74-84,141-148)", async () => {
    const wire = recordingFetch();
    vi.stubGlobal("fetch", wire.fetch);
    const credentials = fakeCredentials({
      records: { "llm-pi-ai/opencode": { key: "stored-k", kind: "api-key" } },
    });
    tier = await mountTierA({
      credentials,
      providers: { opencode: ZEN_COMPLETIONS },
    });
    const drained = await drainStream(tier.llm, "opencode", "deepseek-v4-pro");
    expect(wire.requests.map((request) => request.url)).toEqual([
      LEGACY_COMPLETIONS,
    ]);
    expect(wire.requests[0]?.headers.authorization).toBe(
      "Bearer stored-k".length
    );
    expect(credentials.calls).toContainEqual([
      "readRecord",
      "llm-pi-ai/opencode",
    ]);
    expect(drained.finish).toEqual({ code: "AUTH", kind: "error" });
  });

  it("F18 — a named ref the credentials service misses is MISSING_CREDENTIAL with no request, and listModels answers [] (index.ts:188-211; adapter.ts:295-312)", async () => {
    const wire = recordingFetch();
    vi.stubGlobal("fetch", wire.fetch);
    const credentials = fakeCredentials();
    const launchEnvironment = fakeLaunchEnvironment({
      OPENCODE_API_KEY: "env-k",
    });
    tier = await mountTierA({
      credentials,
      launchEnvironment,
      providers: {
        opencode: { ...ZEN_COMPLETIONS, apiKeyEnv: "OPENCODE_API_KEY" },
      },
    });
    expect(await tier.llm.listModels("opencode")).toEqual([]);
    const drained = await drainStream(tier.llm, "opencode", "deepseek-v4-pro");
    expect(drained.finish).toEqual({
      code: "MISSING_CREDENTIAL",
      kind: "error",
    });
    expect(wire.requests).toEqual([]);
    expect(credentials.calls).toContainEqual(["resolve", "OPENCODE_API_KEY"]);
    // With a credentials service mounted, the launch environment is never the
    // fallback for a NAMED ref (index.ts:199-203).
    expect(launchEnvironment.reads).not.toContain("OPENCODE_API_KEY");
  });

  it("resolves a named ref through the credentials service and sends it (index.ts:199-205)", async () => {
    const wire = recordingFetch();
    vi.stubGlobal("fetch", wire.fetch);
    tier = await mountTierA({
      credentials: fakeCredentials({ refs: { OPENCODE_API_KEY: "ref-k" } }),
      providers: {
        opencode: { ...ZEN_COMPLETIONS, apiKeyEnv: "OPENCODE_API_KEY" },
      },
    });
    const listed = await tier.llm.listModels("opencode");
    expect(listed.map((model) => model.id)).toEqual(["deepseek-v4-pro"]);
    await drainStream(tier.llm, "opencode", "deepseek-v4-pro");
    expect(wire.requests.map((request) => request.url)).toEqual([
      LEGACY_COMPLETIONS,
    ]);
    expect(wire.requests[0]?.headers.authorization).toBe("Bearer ref-k".length);
  });

  it("with no ref, pi's ambient auth asks the credentials service first, then the launch environment (auth.ts:203-215)", async () => {
    const wire = recordingFetch();
    vi.stubGlobal("fetch", wire.fetch);
    // One log for both fakes, so the service calls and the environment read
    // are ordered on the same clock.
    const log: string[] = [];
    const credentials = fakeCredentials({ sharedLog: log });
    const launchEnvironment = fakeLaunchEnvironment(
      { OPENCODE_API_KEY: "env-k" },
      log
    );
    tier = await mountTierA({
      credentials,
      launchEnvironment,
      providers: { opencode: ZEN_COMPLETIONS },
    });
    await drainStream(tier.llm, "opencode", "deepseek-v4-pro");
    expect(wire.requests.map((request) => request.url)).toEqual([
      LEGACY_COMPLETIONS,
    ]);
    expect(wire.requests[0]?.headers.authorization).toBe("Bearer env-k".length);
    // The stored record is read first, then the reference, then the
    // environment: the credentials service is asked before the snapshot.
    const at = (entry: string): number => {
      const index = log.indexOf(entry);
      expect(index, `${entry} in ${log.join(", ")}`).toBeGreaterThan(-1);
      return index;
    };
    expect(at("readRecord:llm-pi-ai/opencode")).toBeLessThan(
      at("resolve:OPENCODE_API_KEY")
    );
    expect(at("resolve:OPENCODE_API_KEY")).toBeLessThan(
      at("env:OPENCODE_API_KEY")
    );
  });
});
