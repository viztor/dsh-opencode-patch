/**
 * The plane adapter and its auth seams, one clause at a time
 * (`src/host/plane-provider.ts`).
 *
 * The adapter is built over the host's own `PiAiAdapter` and pi's own provider
 * pieces (`hostModulesForTests`), so a case here runs the class the plugin
 * registers. The real-host behaviour — which key a turn carries, what a
 * missing one does on the wire — is pinned in `test/host-planes.test.ts`; this
 * file covers the branches a host composition does not reach.
 *
 * @module test/plane-provider.test
 */
import { LlmError } from "@deepseek-ai/dsh-llm";
import { afterEach, describe, expect, it, vi } from "vitest";

import { fakeCredentials, hostModulesForTests } from "./support/host.ts";
import {
  createOpencodeStore,
  type FixtureStore,
} from "./support/opencode-store-fixture.ts";
import {
  buildPlaneProvider,
  createPlaneAdapter,
  type HostLibraries,
  type HostModules,
  hostError,
  OPENCODE_FAMILY_API,
  OPENCODE_ZEN_CATALOG,
  type PiAiModule,
  planeApiKeyResolver,
  planeAuth,
  planeProfileFor,
  relabelEfforts,
} from "./support/src.ts";

/** The ids of a listing, in order. */
const modelIds = (models: readonly { id: string }[]): string[] =>
  models.map((model) => model.id);

afterEach(() => {
  vi.unstubAllEnvs();
});

const modules = async (): Promise<HostModules> => {
  const source = hostModulesForTests();
  const [piAi, libraries] = await Promise.all([
    source.piAi({}),
    source.libraries(),
  ]);
  if (piAi === undefined || libraries === undefined) {
    throw new Error("no host modules");
  }
  return { libraries, piAi };
};

/** A plane profile over the real pieces. */
const profileFor = (
  libraries: HostLibraries,
  piAi: PiAiModule,
  entry: unknown
): Record<string, unknown> =>
  planeProfileFor({
    buildProvider: buildPlaneProvider(libraries),
    catalog: OPENCODE_ZEN_CATALOG,
    endpoint: "auto",
    entry,
    familyApi: OPENCODE_FAMILY_API.zen,
    normalize: (raw) =>
      (
        piAi.Config({ providers: { opencode: raw } }) as {
          providers: { get: () => Record<string, unknown> };
        }
      ).providers.get().opencode,
    piModels: libraries.builtinModels("opencode"),
    resolveRetryPolicy: libraries.resolveRetryPolicy,
    route: "opencode",
  }).profile;

/** The adapter, typed as far as the cases call it. */
interface AdapterLike {
  listModels: (
    provider: string
  ) => Promise<{ id: string; name: string; inputModalities?: string[] }[]>;
  resolveModel: (
    provider: string,
    model: string
  ) => Promise<Record<string, unknown>>;
  prepareCall: (
    provider: string,
    model: string
  ) => Promise<Record<string, unknown>>;
}

const adapterOver = async (
  profiles: ReadonlyMap<string, Record<string, unknown>>,
  resolveApiKey: () => Promise<string | undefined>,
  names?: Readonly<Record<string, string>>
): Promise<AdapterLike> => {
  const host = await modules();
  return createPlaneAdapter({
    auth: planeAuth({}, host.piAi.recordKeyFor, host.libraries),
    effortNames: () => names,
    modules: host,
    profiles: () => profiles,
    resolveApiKey,
  }) as unknown as AdapterLike;
};

describe("plane-provider · the adapter", () => {
  it("is a PlaneAdapter over the host's PiAiAdapter, and lists the declared ids when a key resolves or is missing", async () => {
    const { libraries, piAi } = await modules();
    const profiles = new Map([
      [
        "opencode",
        profileFor(libraries, piAi, { models: [{ id: "gpt-5.4" }] }),
      ],
    ]);
    const keyed = await adapterOver(profiles, async () => "k");
    expect(keyed.constructor.name).toBe("PlaneAdapter");
    expect(keyed).toBeInstanceOf(piAi.PiAiAdapter);
    expect(modelIds(await keyed.listModels("opencode"))).toEqual(["gpt-5.4"]);
    const missing = await adapterOver(profiles, async () => {
      throw new LlmError("no key", "MISSING_CREDENTIAL");
    });
    expect(await missing.listModels("opencode")).toEqual([
      {
        id: "gpt-5.4",
        inputModalities: ["text", "image"],
        name: "GPT-5.4",
        provider: "opencode",
      },
    ]);
    const broken = await adapterOver(profiles, async () => {
      throw new Error("vault down");
    });
    await expect(broken.listModels("opencode")).rejects.toThrow(/vault down/u);
    // A route it does not own is pi-ai's own refusal.
    await expect(keyed.listModels("elsewhere")).rejects.toMatchObject({
      code: "NO_ADAPTER",
    });
  });

  it("answers what a route without a provider can, and reads odd models defensively", async () => {
    const odd = {
      getModels: () => [
        { id: "a", input: "text", name: 5 },
        { name: "no id" },
        null,
      ],
    };
    const profiles = new Map<string, Record<string, unknown>>([
      [
        "opencode",
        {
          catalogError: "broken",
          configuredMaxTokens: new Map(),
          displayName: "opencode",
          modelErrors: new Map(),
          provider: "opencode",
        },
      ],
      [
        "opencode-go",
        {
          configuredMaxTokens: new Map(),
          displayName: "opencode-go",
          modelErrors: new Map(),
          piProvider: odd,
          provider: "opencode-go",
        },
      ],
    ]);
    const adapter = await adapterOver(profiles, async () => {
      throw new LlmError("no key", "MISSING_CREDENTIAL");
    });
    expect(await adapter.listModels("opencode")).toEqual([]);
    expect(await adapter.listModels("opencode-go")).toEqual([
      {
        id: "a",
        inputModalities: ["text"],
        name: "a",
        provider: "opencode-go",
      },
    ]);
    const noModels = await adapterOver(
      new Map([
        [
          "opencode",
          {
            configuredMaxTokens: new Map(),
            displayName: "opencode",
            modelErrors: new Map(),
            piProvider: { getModels: () => "nope" },
            provider: "opencode",
          },
        ],
      ]),
      async () => {
        throw new LlmError("no key", "MISSING_CREDENTIAL");
      }
    );
    expect(await noModels.listModels("opencode")).toEqual([]);
  });

  it("relabels a toggle model's efforts as Off/On in model info and in a prepared call, ids untouched", async () => {
    const { libraries } = await modules();
    const goProfile = planeProfileFor({
      buildProvider: buildPlaneProvider(libraries),
      catalog: [],
      endpoint: "auto",
      entry: {
        models: [
          { id: "toggle", reasoningEfforts: { high: "high", off: null } },
        ],
      },
      familyApi: OPENCODE_FAMILY_API.go,
      piModels: [],
      resolveRetryPolicy: libraries.resolveRetryPolicy,
      route: "opencode-go",
    }).profile;
    const adapter = await adapterOver(
      new Map([["opencode-go", goProfile]]),
      async () => "k",
      { high: "On", off: "Off" }
    );
    const info = await adapter.resolveModel("opencode-go", "toggle");
    expect(info.reasoning).toMatchObject({
      efforts: [
        { id: "off", name: "Off" },
        { id: "high", name: "On" },
      ],
    });
    const prepared = await adapter.prepareCall("opencode-go", "toggle");
    expect((prepared.model as { reasoning: unknown }).reasoning).toEqual(
      info.reasoning
    );
    expect(typeof prepared.stream).toBe("function");
    // Without names the host's own labels stand.
    const plain = await adapterOver(
      new Map([["opencode-go", goProfile]]),
      async () => "k"
    );
    const plainInfo = await plain.resolveModel("opencode-go", "toggle");
    expect(plainInfo.reasoning).toMatchObject({
      efforts: [{ name: "Off" }, { name: "High" }],
    });
  });

  it("relabelEfforts leaves anything it does not recognize as it was", () => {
    const names = { high: "On" };
    for (const info of [
      null,
      5,
      {},
      { reasoning: 5 },
      { reasoning: { efforts: 5 } },
    ]) {
      expect(relabelEfforts(info, names)).toBe(info);
    }
    expect(relabelEfforts({ reasoning: { efforts: [] } })).toEqual({
      reasoning: { efforts: [] },
    });
    expect(
      relabelEfforts(
        {
          reasoning: { efforts: [null, { id: 1 }, { id: "low", name: "Low" }] },
        },
        names
      )
    ).toEqual({
      reasoning: { efforts: [null, { id: 1 }, { id: "low", name: "Low" }] },
    });
  });
});

describe("plane-provider · planeAuth (pi-ai's auth.ts, restated)", () => {
  const recordKeyFor = (id: string): string => `llm-pi-ai/${id}`;
  const withService = (service: unknown) => ({
    get: (name: string) => (name === "credentials" ? service : undefined),
  });

  it("env asks the credentials service for a ref name, then the launch environment", async () => {
    const credentials = fakeCredentials({ refs: { OPENCODE_API_KEY: "svc" } });
    const launch = {
      get: (name: string) => (name === "OTHER" ? { value: "env" } : undefined),
    };
    const services: Record<string, unknown> = {
      credentials: credentials.service,
      launchEnvironment: launch,
    };
    const ctx = { get: (name: string) => services[name] };
    const auth = planeAuth(ctx, recordKeyFor);
    expect(await auth.authContext.env("OPENCODE_API_KEY")).toBe("svc");
    expect(await auth.authContext.env("OTHER")).toBe("env");
    expect(await auth.authContext.env("not a ref")).toBeUndefined();
    expect(credentials.calls.map(([method]) => method)).toEqual([
      "resolve",
      "resolve",
    ]);
    // A hit without a string value is no value.
    const odd = planeAuth(
      withService({ resolve: async () => ({ value: 5 }) }),
      recordKeyFor
    );
    expect(await odd.authContext.env("X")).toBeUndefined();
    // No credentials service and no snapshot: the process environment.
    vi.stubEnv("PLANE_AUTH_PROBE", "from-process");
    expect(
      await planeAuth({}, recordKeyFor).authContext.env("PLANE_AUTH_PROBE")
    ).toBe("from-process");
    expect(await auth.authContext.fileExists("/anything")).toBe(false);
  });

  it("reads records under pi-ai's key, mapping an api-key record and a grant payload", async () => {
    const credentials = fakeCredentials({
      records: {
        "llm-pi-ai/opencode": { env: { A: "1" }, key: "k", kind: "api-key" },
        "llm-pi-ai/opencode-go": { kind: "grant", payload: { type: "oauth" } },
        "llm-pi-ai/plain": { kind: "api-key" },
        "llm-pi-ai/odd": { kind: "grant", payload: 5 },
        "other-scope/opencode": { kind: "api-key", key: "x" },
      },
    });
    const auth = planeAuth(withService(credentials.service), recordKeyFor);
    expect(await auth.credentials.read("opencode")).toEqual({
      env: { A: "1" },
      key: "k",
      type: "api_key",
    });
    expect(await auth.credentials.read("opencode-go")).toEqual({
      type: "oauth",
    });
    expect(await auth.credentials.read("plain")).toEqual({ type: "api_key" });
    expect(await auth.credentials.read("odd")).toBeUndefined();
    expect(await auth.credentials.read("missing")).toBeUndefined();
    expect(await auth.credentials.read("Not Valid")).toBeUndefined();
    expect(
      await planeAuth({}, recordKeyFor).credentials.read("opencode")
    ).toBeUndefined();
    expect(await auth.credentials.list()).toEqual([
      { providerId: "opencode", type: "api_key" },
      { providerId: "opencode-go", type: "oauth" },
      { providerId: "plain", type: "api_key" },
      { providerId: "odd", type: "oauth" },
    ]);
    expect(await planeAuth({}, recordKeyFor).credentials.list()).toEqual([]);
    expect(
      await planeAuth(
        withService({ listRecords: async () => [null, { key: 5 }] }),
        recordKeyFor
      ).credentials.list()
    ).toEqual([]);
  });

  it("modifies and deletes through the service, refusing what pi-ai refuses", async () => {
    const credentials = fakeCredentials();
    const libraries = { LlmError } as unknown as HostLibraries;
    const auth = planeAuth(
      withService(credentials.service),
      recordKeyFor,
      libraries
    );
    expect(
      await auth.credentials.modify("opencode", async () => ({
        key: "new",
        type: "api_key",
      }))
    ).toEqual({ key: "new", type: "api_key" });
    expect(
      await auth.credentials.modify("opencode-go", async () => ({
        list: [1, undefined],
        nested: { gone: undefined, kept: 1 },
        type: "oauth",
      }))
    ).toEqual({ list: [1, null], nested: { kept: 1 }, type: "oauth" });
    expect(
      await auth.credentials.modify("opencode", async () => ({
        env: { B: "2" },
        type: "api_key",
      }))
    ).toEqual({ env: { B: "2" }, type: "api_key" });
    // A mutation that answers nothing writes nothing.
    await auth.credentials.modify("fresh", async (current) => {
      expect(current).toBeUndefined();
    });
    await expect(
      auth.credentials.modify("Not Valid", async () => {})
    ).rejects.toMatchObject({ code: "UNSTORABLE_PROVIDER_ID" });
    await auth.credentials.delete("opencode");
    await auth.credentials.delete("Not Valid");
    expect(
      credentials.calls.filter(([method]) => method === "deleteRecord")
    ).toEqual([["deleteRecord", "llm-pi-ai/opencode"]]);
    const none = planeAuth({}, recordKeyFor, libraries);
    await expect(
      none.credentials.modify("opencode", async () => {})
    ).rejects.toMatchObject({ code: "NO_CREDENTIAL_STORE" });
    await expect(none.credentials.delete("opencode")).rejects.toBeInstanceOf(
      LlmError
    );
  });

  it("hostError carries the code in dsh-llm's class, or on a plain Error with a frozen failure", () => {
    const typed = hostError({ LlmError } as unknown as HostLibraries, "m", "C");
    expect(typed).toBeInstanceOf(LlmError);
    expect(typed).toMatchObject({ code: "C", message: "m" });
    const plain = hostError(undefined, "m", "C") as Error & {
      code?: string;
      failure?: object;
    };
    expect(plain).not.toBeInstanceOf(LlmError);
    expect(plain.code).toBe("C");
    expect(plain.failure).toEqual({ code: "C", message: "m" });
    expect(Object.isFrozen(plain.failure)).toBe(true);
  });
});

describe("plane-provider · planeApiKeyResolver (D20)", () => {
  it("defers to pi's own discovery with no ref, resolves a named ref through the service or the launch environment, and fails loudly on a miss", async () => {
    const host = await modules();
    const service = fakeCredentials({ refs: { OPENCODE_API_KEY: " svc " } });
    const viaService = planeApiKeyResolver(
      {
        get: (name: string) =>
          name === "credentials" ? service.service : undefined,
      },
      host,
      { readOpencodeStore: false }
    );
    expect(await viaService("opencode", {})).toBeUndefined();
    expect(
      await viaService("opencode", { apiKeyEnv: "OPENCODE_API_KEY" })
    ).toBe("svc");
    await expect(
      viaService("opencode", { apiKeyEnv: "NOT_SET" })
    ).rejects.toMatchObject({ code: "MISSING_CREDENTIAL" });
    const viaLaunch = planeApiKeyResolver(
      {
        get: (name: string) =>
          name === "launchEnvironment"
            ? {
                get: (ref: string) =>
                  ref === "K" ? { value: "launch" } : undefined,
              }
            : undefined,
      },
      host,
      { readOpencodeStore: false }
    );
    expect(await viaLaunch("opencode", { apiKeyEnv: "K" })).toBe("launch");
    // Without dsh-llm's helpers the key is trimmed and the miss is a plain coded Error.
    const bare = planeApiKeyResolver(
      {
        get: (name: string) =>
          name === "credentials"
            ? { resolve: async () => ({ value: " v " }) }
            : undefined,
      },
      {
        ...host,
        libraries: {
          ...host.libraries,
          assertUsableApiKey: undefined,
          LlmError: undefined,
        },
      },
      { readOpencodeStore: false }
    );
    expect(await bare("opencode", { apiKeyEnv: "K" })).toBe("v");
    const odd = planeApiKeyResolver(
      {
        get: (name: string) =>
          name === "credentials" ? { resolve: async () => 5 } : undefined,
      },
      { ...host, libraries: { ...host.libraries, LlmError: undefined } },
      { readOpencodeStore: false }
    );
    await expect(odd("opencode", { apiKeyEnv: "K" })).rejects.toMatchObject({
      code: "MISSING_CREDENTIAL",
    });
  });
});

describe("plane-provider · planeApiKeyResolver's two refinements of D20", () => {
  const stores: FixtureStore[] = [];

  afterEach(() => {
    for (const store of stores.splice(0)) {
      store.cleanup();
    }
    delete process.env.XDG_DATA_HOME;
  });

  it("with a credentials service mounted, a ref it misses is MISSING_CREDENTIAL even when the launch environment holds it (pi-ai's rule)", async () => {
    const host = await modules();
    const service = fakeCredentials();
    const ctx = {
      get: (name: string) => {
        if (name === "credentials") {
          return service.service;
        }
        return name === "launchEnvironment"
          ? {
              get: (ref: string) =>
                ref === "OPENCODE_API_KEY" ? { value: "launch" } : undefined,
            }
          : undefined;
      },
    };
    const resolve = planeApiKeyResolver(ctx, host, {
      readOpencodeStore: false,
    });
    await expect(
      resolve("opencode", { apiKeyEnv: "OPENCODE_API_KEY" })
    ).rejects.toMatchObject({ code: "MISSING_CREDENTIAL" });
    // The same launch environment answers once no service is mounted.
    const without = planeApiKeyResolver(
      {
        get: (name: string) =>
          name === "credentials" ? undefined : ctx.get(name),
      },
      host,
      { readOpencodeStore: false }
    );
    await expect(
      without("opencode", { apiKeyEnv: "OPENCODE_API_KEY" })
    ).resolves.toBe("launch");
  });

  it("with no ref named, OpenCode's own store answers only when the deployment opted in, and only for its own plane", async () => {
    const host = await modules();
    const store = createOpencodeStore([
      { integrationId: "opencode", value: "oc_sk_store_zen" },
    ]);
    stores.push(store);
    process.env.XDG_DATA_HOME = store.root;
    // A launch environment that answers nothing: pi's own lookup reads
    // OPENCODE_API_KEY through it, and a bare context would fall back to
    // `process.env`, so a contributor who exports the key would see pi's
    // lookup answer and the resolver step aside. The case measures the
    // keyless deployment whatever the shell holds.
    const keyless = {
      get: (name: string) =>
        name === "launchEnvironment" ? { get: () => {} } : undefined,
    };
    const optedIn = planeApiKeyResolver(keyless, host, {
      readOpencodeStore: true,
    });
    expect(await optedIn("opencode", {})).toBe("oc_sk_store_zen");
    expect(await optedIn("opencode-go", {})).toBeUndefined();
    // A named ref never falls back to the store.
    await expect(
      optedIn("opencode", { apiKeyEnv: "UNSET_REF" })
    ).rejects.toMatchObject({ code: "MISSING_CREDENTIAL" });
    const off = planeApiKeyResolver(keyless, host, {
      readOpencodeStore: false,
    });
    expect(await off("opencode", {})).toBeUndefined();
    // The store is the LAST resort: an OPENCODE_API_KEY the launch
    // environment exports is pi's own lookup, so the resolver steps aside
    // (an explicit key would win over it).
    const exported = planeApiKeyResolver(
      {
        get: (name: string) =>
          name === "launchEnvironment"
            ? {
                get: (ref: string) =>
                  ref === "OPENCODE_API_KEY"
                    ? { value: "exported" }
                    : undefined,
              }
            : undefined,
      },
      host,
      { readOpencodeStore: true }
    );
    expect(await exported("opencode", {})).toBeUndefined();
  });
});

describe("plane-provider · buildPlaneProvider", () => {
  it("builds each plane with pi's own OpenCode auth and all four protocols", async () => {
    const { libraries } = await modules();
    const zen = buildPlaneProvider(libraries)({
      id: "opencode",
      models: [],
      name: "Zen",
    }) as {
      auth: unknown;
      id: string;
      name: string;
    };

    const go = buildPlaneProvider(libraries)({
      id: "opencode-go",
      models: [],
      name: "Go",
    }) as {
      auth: unknown;
    };
    expect(zen).toMatchObject({ id: "opencode", name: "Zen" });
    expect(zen.auth).toBe(libraries.opencodeAuth);
    expect(go.auth).toBe(libraries.opencodeGoAuth);
    // What `createProvider` is handed: all four protocols on either plane
    // (Google on Go too, which pi's own Go provider lacks), each one pi's
    // own factory wrapped with pi's OpenCode session header.
    const inputs: Record<string, unknown>[] = [];
    const wrapped = new Set<unknown>();
    const spied = {
      ...libraries,
      createProvider: (input: Record<string, unknown>) => {
        inputs.push(input);
        return libraries.createProvider(input);
      },
      withOpenCodeSessionHeader: (api: unknown) => {
        const header = libraries.withOpenCodeSessionHeader(api);
        wrapped.add(header);
        return header;
      },
    };
    for (const id of ["opencode", "opencode-go"] as const) {
      buildPlaneProvider(spied)({ id, models: [], name: id });
    }
    expect(inputs).toHaveLength(2);
    for (const input of inputs) {
      const api = input.api as Record<string, unknown>;
      expect(Object.keys(api).toSorted()).toEqual([
        "anthropic-messages",
        "google-generative-ai",
        "openai-completions",
        "openai-responses",
      ]);
      for (const factory of Object.values(api)) {
        expect(wrapped.has(factory)).toBe(true);
      }
    }
  });

  it("wraps Google, and only Google, for the catalog's level ids, inside pi's session header (D16)", async () => {
    const { libraries } = await modules();
    const made = new Map<string, Record<string, unknown>>();
    const handed: unknown[] = [];
    const spied: HostLibraries = {
      ...libraries,
      apis: Object.fromEntries(
        Object.entries(libraries.apis).map(([protocol, factory]) => [
          protocol,
          () => {
            const api = factory() as Record<string, unknown>;
            made.set(protocol, api);
            return api;
          },
        ])
      ) as HostLibraries["apis"],
      withOpenCodeSessionHeader: (api: unknown) => {
        handed.push(api);
        return libraries.withOpenCodeSessionHeader(api);
      },
    };
    const build = (levelThinkingModels?: ReadonlySet<string>) => {
      made.clear();
      handed.length = 0;
      buildPlaneProvider(spied)({
        id: "opencode-go",
        models: [],
        name: "Go",
        ...(levelThinkingModels === undefined ? {} : { levelThinkingModels }),
      });
      // Each factory is made and then handed to the header, one protocol at
      // a time, so the two lists line up.
      expect(handed).toHaveLength(made.size);
      return Object.fromEntries(
        [...made.keys()].map((protocol, index) => [protocol, handed[index]])
      );
    };
    // No level ids: every factory's api reaches the session header as pi made it.
    for (const level of [undefined, new Set<string>()]) {
      const reached = build(level);
      for (const [protocol, api] of made) {
        expect(reached[protocol], protocol).toBe(api);
      }
    }
    // A level id: Google reaches it wrapped, its other entry points pi's own;
    // the other three as pi made them.
    const reached = build(new Set(["gemini-4-argon"]));
    for (const [protocol, api] of made) {
      if (protocol === "google-generative-ai") {
        expect(reached[protocol]).not.toBe(api);
        const google = reached[protocol] as Record<string, unknown>;
        expect(google.stream).toBe(api.stream);
        expect(google.streamSimple).not.toBe(api.streamSimple);
      } else {
        expect(reached[protocol], protocol).toBe(api);
      }
    }
    // Without the host's level pieces the Google api stays pi's.
    const { googleLevels: _pieces, ...withoutPieces } = spied;
    made.clear();
    handed.length = 0;
    buildPlaneProvider(withoutPieces)({
      id: "opencode-go",
      levelThinkingModels: new Set(["gemini-4-argon"]),
      models: [],
      name: "Go",
    });
    expect(handed).toContain(made.get("google-generative-ai"));
  });
});
