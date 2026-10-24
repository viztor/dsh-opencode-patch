/**
 * The plugin owning the plane routes, on the real host (tiers A and B; D13).
 *
 * The P-R1 rows of the plan's test matrix that the characterization does not
 * already carry: who owns the planes and how often pi-ai restarts for it, the
 * claim's lifecycle, how an edit flows through it, which routes are
 * registered, where a key comes from (D20), and that nothing of a sibling
 * route leaks into a plane. Every case boots its own host and reads the
 * registry, the profile file and the wire — never the plugin's own state.
 *
 * @module test/host-planes.test
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  readProfilePatches,
  reconcileProfilePatches,
} from "@deepseek-ai/dsh-app-boot";
import { resolveRetryPolicy } from "@deepseek-ai/dsh-llm";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  adaptersOf,
  type ApplyOrder,
  bootTierB,
  CHARACTERIZED_MODELS,
  characterizedProviders,
  drainStream,
  fakeCredentials,
  type HostLlm,
  logLines,
  mountTierA,
  ownerOf,
  PLANES,
  piAiRestarts,
  recordingFetch,
  type RecordingFetch,
  S0_TODAY,
  s0Providers,
  SAVE_CANDIDATE,
  type TierA,
  type TierB,
  waitForPlaneOwner,
} from "./support/host.ts";
import {
  createOpencodeStore,
  type FixtureStore,
} from "./support/opencode-store-fixture.ts";
import {
  apply,
  clearCapturedApiKeys,
  Config,
  inject,
  name,
  recordCapturedApiKey,
} from "./support/src.ts";

/** The ids of a listing, in order. */
const modelIds = (models: readonly { id: string }[]): string[] =>
  models.map((model) => model.id);

let tierA: TierA | undefined;
let tierB: TierB | undefined;
let wire: RecordingFetch;

afterEach(async () => {
  try {
    await tierA?.dispose();
    await tierB?.dispose();
  } finally {
    tierA = undefined;
    tierB = undefined;
    clearCapturedApiKeys();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});

/** cordis `FiberState`. */
const ACTIVE = 2;
const FAILED = 3;

/** A fiber's state, read as a plain value. */
const stateOf = (fiber: { readonly state: unknown } | undefined): unknown =>
  fiber?.state;

/** Poll until `predicate` holds, or fail by name. */
const until = async (
  predicate: () => boolean | Promise<boolean>,
  what: string,
  deadlineMs = 10_000
): Promise<void> => {
  const end = Date.now() + deadlineMs;
  while (!(await predicate())) {
    if (Date.now() > end) {
      throw new Error(`never happened: ${what}`);
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
  }
};

/** Stub `fetch` with a fresh recorder (before mounting the plugin). */
const offline = (respond?: Parameters<typeof recordingFetch>[0]): void => {
  wire = recordingFetch(respond);
  vi.stubGlobal("fetch", wire.fetch);
};

type Providers = Record<string, Record<string, unknown>>;

/** An edit of one provider entry, the way a settings surface derives one. */
const editProvider =
  (route: string, patch: Record<string, unknown>) =>
  (current: Record<string, unknown>): Record<string, unknown> => {
    const providers = { ...(current.providers as Providers) };
    providers[route] = { ...providers[route], ...patch };
    return { ...current, providers };
  };

/** An edit removing provider entries, the way a settings surface derives one. */
const removeProviders =
  (...routes: string[]) =>
  (current: Record<string, unknown>): Record<string, unknown> => ({
    ...current,
    providers: Object.fromEntries(
      Object.entries(current.providers as Providers).filter(
        ([route]) => !routes.includes(route)
      )
    ),
  });

/** A config-editor mutation appending `id` to a plane's models. */
const appendTo =
  (plane: string, id: string) => (current: Record<string, unknown>) => {
    const entry = (current.providers as Providers)[plane] as
      | { models?: { id: string }[] }
      | undefined;
    return editProvider(plane, {
      models: [...(entry?.models ?? []), { id }],
    })(current);
  };

const routeIds = (llm: HostLlm): string[] =>
  llm
    .listProviders()
    .map((provider) => provider.id)
    .toSorted();

/** The plane adapter's resolved profile for a route (its private `config`). */
const planeProfile = (llm: HostLlm, route: string): Record<string, unknown> => {
  const adapter = adaptersOf(llm).get(route)?.adapter as unknown as {
    config: { profiles: () => ReadonlyMap<string, Record<string, unknown>> };
  };
  const profile = adapter.config.profiles().get(route);
  if (profile === undefined) {
    throw new Error(`no plane profile for ${route}`);
  }
  return profile;
};

/** One turn's gateway requests, the catalog read excluded. */
const turn = async (llm: HostLlm, route: string, model: string) => {
  const before = wire.requests.length;
  const drained = await drainStream(llm, route, model);
  return {
    drained,
    requests: wire.requests
      .slice(before)
      .filter(
        (request) => !request.url.startsWith("https://models.opencode.ai/")
      ),
  };
};

const callConfigOf = async (
  llm: HostLlm,
  route: string,
  model: string
): Promise<string> => {
  try {
    await llm.resolveCallConfig({ model, provider: route } as never);
    return "ok";
  } catch (error) {
    return String((error as { code?: unknown }).code);
  }
};

/** Boot tier B with the characterization profile, counting pi-ai's restarts. */
const bootPlanes = async (
  options: {
    readonly order?: ApplyOrder;
    readonly providers?: Providers;
  } = {}
): Promise<{
  tier: TierB;
  restarts: () => number;
  logged: () => string[];
}> => {
  offline();
  let restarts: ReturnType<typeof piAiRestarts> | undefined;
  let log: ReturnType<typeof logLines> | undefined;
  tierB = await bootTierB({
    credentials: fakeCredentials({
      refs: { OPENCODE_API_KEY: "zen-k", OPENCODE_GO_API_KEY: "go-k" },
    }),
    order: options.order ?? "plugin-first",
    prepare: (root) => {
      restarts = piAiRestarts(root);
      log = logLines(root);
    },
    providers: options.providers ?? characterizedProviders(),
  });
  return {
    logged: () => log?.lines() ?? [],
    restarts: () => restarts?.count() ?? 0,
    tier: tierB,
  };
};

/** Let every queued microtask and timer of a settled host run. */
const settle = async (): Promise<void> => {
  for (let index = 0; index < 10; index += 1) {
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
  }
};

describe(
  "host planes · ownership and restart counts (tier B)",
  { timeout: 30_000 },
  () => {
    it.each([
      ["pi-ai-first", 1],
      ["plugin-first", 0],
    ] as const)(
      "%s: pi-ai restarts %i time(s), both planes are the plugin's, and no registration is ever refused",
      async (order, expected) => {
        const { logged, restarts, tier } = await bootPlanes({ order });
        await waitForPlaneOwner(tier.llm);
        await settle();
        expect(restarts()).toBe(expected);
        expect(routeIds(tier.llm)).toEqual(["deepseek", ...PLANES]);
        // A DUPLICATE_ADAPTER that escaped into pi-ai's apply fails pi-ai; one
        // the claim caught is logged as "still held elsewhere", and any other
        // refusal as "did not register". None of them happens in either order.
        expect(tier.piFiber.state).toBe(ACTIVE);
        expect(tier.pluginEntry?.fiber?.state).toBe(ACTIVE);
        tier.ctx.logger.info("[host-planes] the log is read");
        const lines = logged();
        expect(lines.at(-1)).toContain("[host-planes] the log is read");
        expect(
          lines.filter((line) =>
            /still held elsewhere|plane routes did not register|DUPLICATE_ADAPTER/u.test(
              line
            )
          )
        ).toEqual([]);
      }
    );

    it("pi-ai FAILED for a sibling route while its plane entries are valid: nothing is claimed, the plugin stays active, and no plane is listed", async () => {
      const providers = characterizedProviders();
      // A route-level error on `deepseek` fails pi-ai's whole fiber; the
      // plane entries themselves are well formed and stay in its raw config.
      providers.deepseek = { ...providers.deepseek, api: "nope" };
      const { tier } = await bootPlanes({ order: "pi-ai-first", providers });
      await until(
        () =>
          stateOf(tier.piFiber) === FAILED &&
          stateOf(tier.pluginEntry?.fiber) === ACTIVE,
        "pi-ai fails and the plugin is active"
      );
      // The claim reconciles on every registry change and after its mount;
      // let every one of them run before reading the registry.
      await settle();
      const raw = (
        tier.piFiber as unknown as { _config: { providers: object } }
      )._config.providers;
      expect(Object.keys(raw)).toEqual(expect.arrayContaining([...PLANES]));
      expect(
        tier.llm
          .listProviders()
          .filter((provider) =>
            (PLANES as readonly string[]).includes(provider.id)
          )
      ).toEqual([]);
    });
  }
);

describe("host planes · lifecycle", { timeout: 30_000 }, () => {
  it("disabling the plugin's row hands both planes back to pi-ai, and the next Settings save of a plane holding a gap id is refused with the file unchanged (tier B)", async () => {
    const { tier } = await bootPlanes();
    await waitForPlaneOwner(tier.llm);
    const { pluginEntry } = tier;
    if (pluginEntry === undefined) {
      throw new Error("no plugin row");
    }
    // Disable the row in the profile patch and reload the profile, the way
    // a profile edit reaches a running host: the loader disposes its fiber.
    const rows = JSON.parse(
      readFileSync(tier.profile.patchPath, "utf8")
    ) as unknown[];
    writeFileSync(
      tier.profile.patchPath,
      `${JSON.stringify([...rows, { disabled: true, id: pluginEntry.options.id }], null, 2)}\n`
    );
    await reconcileProfilePatches(
      tier.ctx as never,
      readProfilePatches("dsh", tier.profile),
      "dsh"
    );
    await until(
      () => pluginEntry.fiber === undefined || pluginEntry.fiber.uid === null,
      "the plugin row is disposed"
    );
    await waitForPlaneOwner(tier.llm, PLANES, "PiAiAdapter");
    expect(routeIds(tier.llm)).toEqual(["deepseek", ...PLANES]);
    const before = readFileSync(tier.profile.patchPath);
    await expect(
      tier.ctx.configEditor.edit(
        tier.piEntry,
        appendTo("opencode", SAVE_CANDIDATE)
      )
    ).rejects.toThrow(S0_TODAY.saveBlockedByStoredGap);
    expect(readFileSync(tier.profile.patchPath)).toEqual(before);
  });

  it("dispose, then apply again (tier A): the planes go back to the plugin", async () => {
    offline();
    tierA = await mountTierA({ plugin: {}, providers: s0Providers() });
    await waitForPlaneOwner(tierA.llm);
    await tierA.pluginFiber?.dispose();
    await waitForPlaneOwner(tierA.llm, PLANES, "PiAiAdapter");
    await tierA.ctx.plugin(
      { apply, Config, inject, name } as never,
      {} as never
    );
    await waitForPlaneOwner(tierA.llm);
    expect(routeIds(tierA.llm)).toEqual(["deepseek", ...PLANES]);
  });

  it("an edit of the plugin's own row restarts pi-ai zero times and keeps the planes the plugin's (tier B)", async () => {
    const { restarts, tier } = await bootPlanes();
    await waitForPlaneOwner(tier.llm);
    const before = restarts();
    const { pluginEntry } = tier;
    if (pluginEntry === undefined) {
      throw new Error("no plugin row");
    }
    await tier.ctx.configEditor.edit(pluginEntry, (current) => ({
      ...current,
      debug: true,
    }));
    await until(
      () => (pluginEntry.fiber?.config as { debug?: boolean })?.debug === true,
      "the plugin row reloads"
    );
    await waitForPlaneOwner(tier.llm);
    expect(restarts() - before).toBe(0);
  });

  it("an llm restart registers every route again, the planes the plugin's (tier B)", async () => {
    const { tier } = await bootPlanes();
    await waitForPlaneOwner(tier.llm);
    const llmEntry = tier.ctx.configEditor
      .entries()
      .find((entry) => entry.options.id === "llm");
    await llmEntry?.fiber?.restart();
    await until(
      () => routeIds(tier.ctx.llm).length === 3,
      "every route registers again"
    );
    await waitForPlaneOwner(tier.ctx.llm);
    expect(routeIds(tier.ctx.llm)).toEqual(["deepseek", ...PLANES]);
  });

  it("pi-ai restarting itself while claimed keeps the planes the plugin's, and throws nothing (tier B)", async () => {
    const { tier } = await bootPlanes();
    await waitForPlaneOwner(tier.llm);
    await expect(tier.piFiber.restart()).resolves.toBeUndefined();
    await waitForPlaneOwner(tier.llm);
    expect(ownerOf(tier.llm, "deepseek")).toBe("PiAiAdapter");
  });

  it("a turn in flight completes after the plugin is disposed under it (tier A)", async () => {
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    offline({
      respond: (request) => {
        const chunk = (delta: object, finish: string | null) =>
          `data: ${JSON.stringify({
            choices: [{ delta, finish_reason: finish, index: 0 }],
            created: 1,
            id: "inflight",
            model: request.model,
            object: "chat.completion.chunk",
          })}\n\n`;
        const encoder = new TextEncoder();
        const body = new ReadableStream<Uint8Array>({
          async start(controller) {
            controller.enqueue(
              encoder.encode(chunk({ content: "hi", role: "assistant" }, null))
            );
            await held;
            controller.enqueue(encoder.encode(chunk({}, "stop")));
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();
          },
        });
        return new Response(body, {
          headers: { "content-type": "text/event-stream" },
          status: 200,
        });
      },
    });
    tierA = await mountTierA({
      credentials: fakeCredentials({ refs: { OPENCODE_API_KEY: "k" } }),
      plugin: {},
      providers: {
        opencode: {
          apiKeyEnv: "OPENCODE_API_KEY",
          models: [{ id: "deepseek-v4-pro" }],
        },
      },
    });
    await waitForPlaneOwner(tierA.llm, ["opencode"]);
    const inFlight = drainStream(tierA.llm, "opencode", "deepseek-v4-pro");
    await until(() => wire.requests.length > 0, "the turn is sent");
    await tierA.pluginFiber?.dispose();
    release?.();
    const drained = await inFlight;
    expect(drained.error).toBeUndefined();
    expect(drained.finish?.kind).not.toBe("error");
    expect(drained.types).toContain("text-delta");
  });
});

describe("host planes · config flow (tier B)", { timeout: 30_000 }, () => {
  it("a plane-only save is served with no pi-ai restart; a displayName edit renames the route; a purge edit is accepted", async () => {
    const { restarts, tier } = await bootPlanes();
    await waitForPlaneOwner(tier.llm);
    const before = restarts();
    await tier.ctx.configEditor.edit(
      tier.piEntry,
      appendTo("opencode", SAVE_CANDIDATE)
    );
    await until(async () => {
      const listed = await tier.llm.listModels("opencode");
      return listed.some((model) => model.id === SAVE_CANDIDATE);
    }, "the saved id is listed");
    expect(restarts() - before).toBe(0);
    await tier.ctx.configEditor.edit(
      tier.piEntry,
      editProvider("opencode", { displayName: "Zen X" })
    );
    await until(
      () =>
        tier.llm.listProviders().find((provider) => provider.id === "opencode")
          ?.name === "Zen X",
      "the rename reaches the registry"
    );
    // The purge action's shape: an entry with a model removed.
    await tier.ctx.configEditor.edit(tier.piEntry, (current) => {
      const entry = (current.providers as Providers)["opencode-go"] as {
        models: { id: string }[];
      };
      return editProvider("opencode-go", {
        models: entry.models.filter((model) => model.id !== "minimax-m3"),
      })(current);
    });
    await until(async () => {
      const listed = await tier.llm.listModels("opencode-go");
      return !listed.some((model) => model.id === "minimax-m3");
    }, "the purged id leaves the listing");
  });

  it("a malformed plane candidate is refused in pi-ai's words, and the file is byte-identical", async () => {
    const { tier } = await bootPlanes();
    await waitForPlaneOwner(tier.llm);
    const before = readFileSync(tier.profile.patchPath);
    await expect(
      tier.ctx.configEditor.edit(
        tier.piEntry,
        editProvider("opencode", { models: [{ id: "" }] })
      )
    ).rejects.toThrow(/has a model with an empty id/u);
    expect(readFileSync(tier.profile.patchPath)).toEqual(before);
  });

  it("a save a sibling route refuses changes nothing: not the file, not the plane's listing, not its profile", async () => {
    const { tier } = await bootPlanes();
    await waitForPlaneOwner(tier.llm);
    const before = readFileSync(tier.profile.patchPath);
    const listed = await tier.llm.listModels("opencode");
    const profile = planeProfile(tier.llm, "opencode");
    await expect(
      tier.ctx.configEditor.edit(tier.piEntry, (current) =>
        appendTo(
          "opencode",
          SAVE_CANDIDATE
        )(editProvider("deepseek", { api: "nope" })(current))
      )
    ).rejects.toThrow();
    expect(readFileSync(tier.profile.patchPath)).toEqual(before);
    expect(await tier.llm.listModels("opencode")).toEqual(listed);
    expect(planeProfile(tier.llm, "opencode")).toBe(profile);
  });

  it("a save a home-level patch refuses changes nothing: not the file, not the plane's listing, not its profile", async () => {
    const { tier } = await bootPlanes();
    await waitForPlaneOwner(tier.llm);
    const before = readFileSync(tier.profile.patchPath);
    const listed = await tier.llm.listModels("opencode");
    const profile = planeProfile(tier.llm, "opencode");
    // A home patch pins pi-ai's row to the config it already has; the editor
    // refuses a profile edit whose result the home layer overrides.
    writeFileSync(
      join(tier.home, "cordis.patch.yml"),
      `${JSON.stringify([{ config: { providers: characterizedProviders() }, id: "llm-pi-ai" }], null, 2)}\n`
    );
    await expect(
      tier.ctx.configEditor.edit(
        tier.piEntry,
        appendTo("opencode", SAVE_CANDIDATE)
      )
    ).rejects.toThrow(/overridden by a home patch/u);
    expect(readFileSync(tier.profile.patchPath)).toEqual(before);
    expect(await tier.llm.listModels("opencode")).toEqual(listed);
    expect(planeProfile(tier.llm, "opencode")).toBe(profile);
  });

  it("a stored malformed entry leaves deepseek serving and answers INVALID_CONFIG for that one id only", async () => {
    const providers = s0Providers();
    (providers.opencode as { models: { id: string }[] }).models.push({
      id: "gpt-5.4",
    });
    const { tier } = await bootPlanes({ providers });
    await waitForPlaneOwner(tier.llm);
    expect(await callConfigOf(tier.llm, "opencode", "gpt-5.4")).toBe(
      "INVALID_CONFIG"
    );
    expect(await callConfigOf(tier.llm, "opencode", "deepseek-v4-pro")).toBe(
      "ok"
    );
    // The gap id pi's catalog does not describe resolves: the plugin, not
    // pi-ai, serves the plane.
    expect(
      await callConfigOf(tier.llm, "opencode", "gpt-5.3-codex-spark")
    ).toBe("ok");
    expect(routeIds(tier.llm)).toContain("deepseek");
  });

  it("a stored plane entry malformed at route level, which would fail pi-ai's whole fiber, leaves pi-ai active and deepseek serving, and that plane answers INVALID_CONFIG", async () => {
    const providers = s0Providers();
    // An invalid header name is a route-level error pi-ai raises for the
    // whole providers dict; the listener keeps it away from pi-ai.
    providers.opencode = {
      ...providers.opencode,
      headers: { "bad header": "x" },
    };
    const { tier } = await bootPlanes({ providers });
    await waitForPlaneOwner(tier.llm, ["opencode-go"]);
    await settle();
    expect(tier.piFiber.state).toBe(ACTIVE);
    expect(await callConfigOf(tier.llm, "deepseek", "deepseek-v4-pro")).toBe(
      "ok"
    );
    expect(await callConfigOf(tier.llm, "opencode", "deepseek-v4-pro")).toBe(
      "INVALID_CONFIG"
    );
  });
});

describe("host planes · the route set (tier B)", { timeout: 30_000 }, () => {
  it("only the planes the profile declares are registered", async () => {
    const providers = s0Providers();
    delete providers["opencode-go"];
    const { tier } = await bootPlanes({ providers });
    await waitForPlaneOwner(tier.llm, ["opencode"]);
    expect(routeIds(tier.llm)).toEqual(["deepseek", "opencode"]);
  });

  it("a first plane added at runtime registers; removing both withdraws them through the live handle, and re-adding registers again", async () => {
    const { deepseek } = s0Providers();
    const { tier } = await bootPlanes({
      providers: { deepseek: deepseek ?? {} },
    });
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });
    expect(routeIds(tier.llm)).toEqual(["deepseek"]);
    const zen = s0Providers().opencode ?? {};
    await tier.ctx.configEditor.edit(
      tier.piEntry,
      editProvider("opencode", zen)
    );
    await waitForPlaneOwner(tier.llm, ["opencode"]);
    await tier.ctx.configEditor.edit(
      tier.piEntry,
      removeProviders("opencode", "opencode-go")
    );
    await until(
      () => routeIds(tier.llm).length === 1,
      "the last plane is withdrawn"
    );
    expect(routeIds(tier.llm)).toEqual(["deepseek"]);
    await tier.ctx.configEditor.edit(
      tier.piEntry,
      editProvider("opencode", zen)
    );
    await waitForPlaneOwner(tier.llm, ["opencode"]);
  });
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
