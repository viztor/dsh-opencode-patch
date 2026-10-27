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
  adaptersOf,
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

/** What pi's `Models.getAuth` answers, as far as these cases read it. */
interface PiAuthResult {
  readonly env?: Readonly<Record<string, string>>;
  readonly source?: string;
}

/**
 * pi's own auth answer for a route, through the collection pi-ai's adapter
 * built for its current snapshot (adapter.ts:251-259, private) and pi's public
 * `Models.getAuth` (pi 1.1.0 `dist/models.d.ts`). It is the one place a stored
 * record's `env` is observable on a plane: pi forwards it as the result's
 * `env` (`dist/auth/helpers.js`), and no plane request reads it back.
 *
 * @param current - the tier whose pi-ai adapter to read.
 * @param route - the route to resolve auth for.
 * @returns the source and env, with the key left out.
 */
const piAuthOf = async (
  current: TierA,
  route: string
): Promise<PiAuthResult | undefined> => {
  const adapter = adaptersOf(current.llm).get(route)?.adapter as unknown as {
    current: () => {
      models: { getAuth: (id: string) => Promise<PiAuthResult | undefined> };
    };
  };
  const result = await adapter.current().models.getAuth(route);
  return result === undefined
    ? undefined
    : { env: result.env, source: result.source };
};

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
    // A record with no env hands pi none (auth.ts:80 spreads it only when set).
    expect(await piAuthOf(tier, "opencode")).toEqual({
      env: undefined,
      source: "stored credential",
    });
  });

  it("maps an api-key record carrying env as well: pi's auth carries the stored env, the turn still authenticates with the stored key, and the launch environment is not read (auth.ts:74-84)", async () => {
    const wire = recordingFetch();
    vi.stubGlobal("fetch", wire.fetch);
    const credentials = fakeCredentials({
      records: {
        "llm-pi-ai/opencode": {
          env: { OPENCODE_REGION: "test" },
          key: "stored-k",
          kind: "api-key",
        },
      },
    });
    const launchEnvironment = fakeLaunchEnvironment({
      OPENCODE_API_KEY: "env-key-k",
    });
    tier = await mountTierA({
      credentials,
      launchEnvironment,
      providers: { opencode: ZEN_COMPLETIONS },
    });
    const drained = await drainStream(tier.llm, "opencode", "deepseek-v4-pro");
    expect(wire.requests.map((request) => request.url)).toEqual([
      LEGACY_COMPLETIONS,
    ]);
    // The stored key's length, not the environment's (a different length).
    expect(wire.requests[0]?.headers.authorization).toBe(
      "Bearer stored-k".length
    );
    expect(launchEnvironment.reads).toEqual([]);
    expect(drained.finish).toEqual({ code: "AUTH", kind: "error" });
    // The env branch itself (auth.ts:80): nothing on a plane's wire reads the
    // stored env, so it is asserted where pi hands it on, in its auth answer.
    expect(await piAuthOf(tier, "opencode")).toEqual({
      env: { OPENCODE_REGION: "test" },
      source: "stored credential",
    });
  });

  it("hands a non-api-key record's payload to pi verbatim: on a plane, whose pi auth has no OAuth, the turn fails PI_AI_ERROR with no request and no fallback to the launch environment (auth.ts:74-84)", async () => {
    // Not a record a plane's Sign-in writes (pi 1.1.0's planes offer an API
    // key only); pinned so P-R1's store, which copies this mapping, answers
    // the same for one a user or another plane left behind.
    const wire = recordingFetch();
    vi.stubGlobal("fetch", wire.fetch);
    const credentials = fakeCredentials({
      records: {
        "llm-pi-ai/opencode": {
          kind: "grant",
          payload: {
            access: "grant-access",
            expires: Date.now() + 3_600_000,
            refresh: "grant-refresh",
            type: "oauth",
          },
        },
      },
    });
    const launchEnvironment = fakeLaunchEnvironment({
      OPENCODE_API_KEY: "env-k",
    });
    tier = await mountTierA({
      credentials,
      launchEnvironment,
      providers: { opencode: ZEN_COMPLETIONS },
    });
    const drained = await drainStream(tier.llm, "opencode", "deepseek-v4-pro");
    expect(credentials.calls).toContainEqual([
      "readRecord",
      "llm-pi-ai/opencode",
    ]);
    expect(wire.requests).toEqual([]);
    expect(launchEnvironment.reads).toEqual([]);
    expect(drained.finish).toEqual({ code: "PI_AI_ERROR", kind: "error" });
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
