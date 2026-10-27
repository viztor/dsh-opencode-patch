/**
 * Provider-aware model-discovery decoration.
 *
 * A configured OpenCode route can be answered from its adapter’s installed
 * catalog without a gateway request. In that path, response enrichment never
 * runs, so decorating the discovery answer is the only way to add a missing
 * catalog row or remove a provider-retired row from “fetch available models.”
 *
 * @module test/models-discovery.test
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  baseForProtocol,
  type CordisContext,
  PI_THINKING_LEVELS,
  RESPONSES_ROUTE,
  decorateModelDiscovery,
  decorateModelInfo,
  decoratePlaneAdapters,
  findModelSpecOn,
  hideResponsesRoute,
  isDeprecatedModelOn,
  isRouteRegistered,
  isServableModel,
  mergeDiscoveredModels,
  parseModelsDevCatalog,
  protocolFor,
  resolveConfig,
  resolveDiscoveryProvider,
  resolveEffectiveContextWindow,
  thinkingLevelMapFor,
} from "./support/src.ts";

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.OPENCODE_SESSION_ID;
});

const providers = new Set(["opencode", "opencode-go"]);
const gatewayUrls = ["opencode.ai/zen"];
const config = { ...resolveConfig(), gatewayUrls, providers };

describe("resolveDiscoveryProvider", () => {
  it("prefers an explicitly claimed route ID", () => {
    expect(resolveDiscoveryProvider({ provider: "opencode" }, config)).toBe(
      "zen"
    );
    expect(resolveDiscoveryProvider({ provider: "opencode-go" }, config)).toBe(
      "go"
    );
  });

  it("ignores unclaimed routes and non-OpenCode gateways", () => {
    expect(resolveDiscoveryProvider({ provider: "other" }, config)).toBe(
      undefined
    );
    expect(
      resolveDiscoveryProvider(
        { baseURL: "https://gateway.example.com/v1" },
        config
      )
    ).toBe(undefined);
    expect(resolveDiscoveryProvider(null, config)).toBe(undefined);
  });

  it("classifies an OpenCode gateway draft by its URL path", () => {
    expect(
      resolveDiscoveryProvider(
        { baseURL: "https://opencode.ai/zen/go/v1", provider: "custom-go" },
        { ...config, providers: new Set(["custom-go"]) }
      )
    ).toBe("go");
    expect(
      resolveDiscoveryProvider(
        { baseURL: "https://opencode.ai/zen/v1", provider: "custom-zen" },
        { ...config, providers: new Set(["custom-zen"]) }
      )
    ).toBe("zen");
  });
});

describe("mergeDiscoveredModels", () => {
  it("drops an adapter row the registry has retired", () => {
    // The adapter's installed snapshot is older than the live catalog and still
    // lists ids the vendor has retired — measured: 5 of pi's 85 opencode ids are
    // deprecated in the live catalog, and 6 live-active ids it lacks. Our own
    // catalog drops the retired ones during parse, so without this filter the
    // MERGE is what puts them back, and the picker leads with models that no
    // longer answer.
    parseModelsDevCatalog({
      opencode: {
        api: "https://opencode.ai/zen/v1",
        models: {
          "still-here": { name: "Still Here" },
          "retired-one": { name: "Retired One", status: "deprecated" },
        },
      },
    });

    // The parser saw the retirement…
    expect(isDeprecatedModelOn("zen", "retired-one")).toBe(true);
    expect(isDeprecatedModelOn("zen", "still-here")).toBe(false);

    // …and the merge honours it for a row the ADAPTER offers.
    const merged = mergeDiscoveredModels(
      [
        {
          contextWindow: 1,
          id: "retired-one",
          inputModalities: ["text"],
          maxTokens: 2,
          name: "Retired One",
        },
        {
          contextWindow: 1,
          id: "adapter-only",
          inputModalities: ["text"],
          maxTokens: 2,
          name: "Adapter Only",
        },
      ],
      "zen"
    );
    const ids = merged.map((m) => m.id);
    expect(ids).not.toContain("retired-one");
    // A model the catalog does not describe is NOT dropped: absent-from-catalog
    // is not the same as retired, and an adapter's own row is still its answer.
    expect(ids).toContain("adapter-only");
  });

  it("keeps adapter rows, drops an empty id, and does NOT append the catalog", () => {
    const merged = mergeDiscoveredModels(
      [
        {
          contextWindow: 1,
          id: "adapter-model",
          inputModalities: ["text"],
          maxTokens: 2,
          name: "Adapter Model",
        },
        { id: "beam-free", name: "Beam Free" },
        { id: "", name: "Nameless" },
      ],
      "zen"
    );

    // **Exactly what the adapter reported.** The catalog supplies metadata, not
    // rows: a refresh must not widen the deployment's list, so `beam-free`
    // — catalogued, servable, and NOT declared here — stays out.
    expect(merged.map((model) => model.id)).toEqual([
      "adapter-model",
      "beam-free",
    ]);
    // The adapter’s own capacities win over the canonical catalog.
    expect(merged[0]).toEqual({
      contextWindow: 1,
      id: "adapter-model",
      inputModalities: ["text"],
      maxTokens: 2,
      name: "Adapter Model",
    });
  });

  it("does not retire Go’s paid Muse 1.2 contributor row", () => {
    const merged = mergeDiscoveredModels(
      [{ id: "muse-spark-1.2-contributor" }],
      "go"
    );

    // Kept — it is not retired — and the catalog appends nothing.
    expect(merged.map((model) => model.id)).toEqual([
      "muse-spark-1.2-contributor",
    ]);
  });

  it("sanitizes candidate modalities to DSH-supported text and image only", () => {
    const merged = mergeDiscoveredModels(
      [
        {
          id: "adapter-multimodal",
          inputModalities: ["text", "image", "video", "audio", "pdf"],
        },
      ],
      "go"
    );

    // Unsupported modalities are stripped from the adapter row, and the catalog
    // row is not appended — the adapter answered.
    expect(merged).toEqual([
      {
        contextWindow: undefined,
        id: "adapter-multimodal",
        inputModalities: ["text", "image"],
        maxTokens: undefined,
        name: undefined,
      },
    ]);
  });

  it("adds nothing when the adapter reported nothing", () => {
    // An empty answer is an ABSENCE, and the previous reading of it — "no
    // preference, so the catalog stands in" — is how a deployment that had
    // declared four models saw eighty-six. The merge enriches what it is given and
    // never widens it, in this case as in every other.
    const merged = mergeDiscoveredModels([], "zen");
    expect(merged).toEqual([]);
  });

  it("enriches candidate rows missing contextWindow or maxTokens from the catalog spec", () => {
    const merged = mergeDiscoveredModels(
      [
        {
          id: "minimax-m3",
          name: "MiniMax-M3",
        },
      ],
      "go"
    );

    expect(merged[0]).toEqual({
      contextWindow: 1_000_000,
      id: "minimax-m3",
      inputModalities: ["text", "image"],
      maxTokens: 131_072,
      name: "MiniMax-M3",
    });
  });
});

describe("decorateModelDiscovery", () => {
  it("leaves discovery alone when enrichment is disabled", () => {
    const original = async () => [{ id: "adapter-model" }];
    const ctx = {
      llm: { discoverModels: original },
    } as unknown as CordisContext;

    expect(
      decorateModelDiscovery(ctx, resolveConfig({ enrichModels: false }))
    ).toBe(undefined);
    expect(ctx.llm?.discoverModels).toBe(original);
  });

  it("leaves a non-extensible discovery service installed", () => {
    const original = async () => [{ id: "adapter-model" }];
    const ctx = {
      llm: Object.freeze({ discoverModels: original }),
    } as unknown as CordisContext;

    expect(decorateModelDiscovery(ctx, resolveConfig())).toBe(undefined);
    expect(ctx.llm?.discoverModels).toBe(original);
  });

  it("forwards adapter errors and unclaimed routes unchanged", async () => {
    const failure = new Error("boom");
    const original = vi.fn().mockRejectedValue(failure);
    const ctx = {
      llm: { discoverModels: original },
    } as unknown as CordisContext;
    const stop = decorateModelDiscovery(ctx, resolveConfig());
    const wrapped = ctx.llm?.discoverModels;
    expect(typeof wrapped).toBe("function");
    if (typeof wrapped !== "function") {
      throw new TypeError("discovery decorator was not installed");
    }

    await expect(wrapped("llm-pi-ai", { provider: "other" })).rejects.toBe(
      failure
    );
    expect(original).toHaveBeenCalledWith(
      "llm-pi-ai",
      { provider: "other" },
      undefined
    );
    stop?.();
    expect(ctx.llm?.discoverModels).toBe(original);
  });

  it("keeps the 1.2 row the zen plane serves and adds nothing on refresh", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("offline catalog test"))
    );
    const original = vi
      .fn()
      .mockResolvedValue([{ id: "beam-free", name: "Beam Free" }]);
    const ctx = {
      llm: { discoverModels: original },
    } as unknown as CordisContext;
    const stop = decorateModelDiscovery(ctx, resolveConfig());
    const wrapped = ctx.llm?.discoverModels;
    expect(typeof wrapped).toBe("function");
    if (typeof wrapped !== "function") {
      throw new TypeError("discovery decorator was not installed");
    }

    const merged = (await wrapped("llm-pi-ai", {
      baseURL: "https://opencode.ai/zen/v1",
      provider: "opencode",
    })) as Array<{ id: string }>;
    const ids = merged.map((model) => model.id);
    expect(original).toHaveBeenCalledWith(
      "llm-pi-ai",
      { baseURL: "https://opencode.ai/zen/v1", provider: "opencode" },
      undefined
    );
    // **Discovery does NOT join the catalog.** It briefly did — reasoning that
    // "browse to pick" is a different surface from "what this route serves" — and
    // the owner's instruction had been explicit: *user can select them from the
    // list, but we shouldn't override the user's config for what is usable*. The
    // join made Settings list models the deployment never declared.
    //
    // The refresh adds nothing the adapter did not answer. The free model the
    // catalog knows is `mimo-v2.6-flash-free` — a DIFFERENT one from the row the
    // adapter answered, so the assertion is about the join and not about a name.
    expect(ids).not.toContain("mimo-v2.6-flash-free");
    expect(ids).toHaveLength(1);
    // Kept, not removed: it answers on zen, so it is not retired.
    expect(ids).toContain("beam-free");
    stop?.();
    expect(ctx.llm?.discoverModels).toBe(original);
  });

  it("calls the host's method with the service as its receiver", async () => {
    // The real registry is a class whose `discoverModels` reads its own
    // discoveries through `this`, so a wrapper that calls it detached fails
    // before any adapter is asked.
    class DiscoveryHost {
      readonly discoveries = new Map([
        ["llm-pi-ai", async () => [{ id: "adapter-model" }]],
      ]);
      async discoverModels(ns: string, _request?: unknown): Promise<unknown> {
        return this.discoveries.get(ns)?.();
      }
    }
    const llm = new DiscoveryHost();
    const stop = decorateModelDiscovery(
      { llm } as unknown as CordisContext,
      resolveConfig()
    );

    await expect(
      llm.discoverModels("llm-pi-ai", { provider: "other" })
    ).resolves.toEqual([{ id: "adapter-model" }]);
    stop?.();
  });

  it("leaves a wrapper installed on top of it in place on dispose", () => {
    const original = async () => [{ id: "adapter-model" }];
    const llm: Record<string, unknown> = { discoverModels: original };
    const stop = decorateModelDiscovery(
      { llm } as unknown as CordisContext,
      resolveConfig()
    );
    const foreign = async () => [];
    llm.discoverModels = foreign;
    stop?.();

    expect(llm.discoverModels).toBe(foreign);
  });
});

describe("models-discovery · an empty list from a route that declares models", () => {
  it("falls back to the declaration, so the picker is not emptied by a missing key", async () => {
    // `dsh-llm-pi-ai` resolves the route's credential before listing and answers
    // [] when it cannot — at boot, the ordinary case. Measured consequence: the
    // composer offered none of that route's models at all, so there was no
    // OpenCode model to select and the usage meter (gated to OpenCode) could
    // never appear.
    const ctx = {
      llm: {
        listProviders: () => [{ id: "opencode" }],
        listConfigurableProviders: () => [],
        listModels: async () => [],
      },
      loader: {
        *entries() {
          yield {
            options: {
              config: {
                providers: {
                  opencode: { models: [{ id: "gpt-5.4", name: "GPT-5.4" }] },
                },
              },
            },
          };
        },
      },
    } as unknown as CordisContext;
    const stop = hideResponsesRoute(ctx, resolveConfig());
    const listed = (await ctx.llm?.listModels?.("opencode")) as Array<{
      id: string;
      name: string;
      provider: string;
    }>;
    expect(listed).toEqual([
      { id: "gpt-5.4", name: "GPT-5.4", provider: "opencode" },
    ]);
    stop?.();
  });

  it("passes a provider it does not claim through untouched", async () => {
    // A direct `anthropic` or `openai` route is the deployment's, not this
    // plugin's. Its ids are not in the OpenCode catalog's routing, and the
    // servability filter used to drop them as "unservable".
    const foreign = [
      { id: "claude-opus-9", name: "Claude Opus 9", provider: "anthropic" },
      { id: "gpt-7", name: "GPT-7", provider: "openai" },
    ];
    const ctx = {
      llm: {
        listProviders: () => [],
        listConfigurableProviders: () => [],
        listModels: async (provider: string) =>
          foreign.filter((row) => row.provider === provider),
      },
    } as unknown as CordisContext;
    const stop = hideResponsesRoute(ctx, resolveConfig());
    expect(await ctx.llm?.listModels?.("anthropic")).toEqual([foreign[0]]);
    expect(await ctx.llm?.listModels?.("openai")).toEqual([foreign[1]]);
    stop?.();
  });

  it("leaves an adapter's own answer alone", async () => {
    const ctx = {
      llm: {
        listProviders: () => [],
        listConfigurableProviders: () => [],
        listModels: async () => [
          { id: "adapter-row", name: "Adapter Row", provider: "opencode" },
        ],
      },
      loader: {
        entries: () => [
          {
            options: {
              config: {
                providers: { opencode: { models: [{ id: "declared" }] } },
              },
            },
          },
        ],
      },
    } as unknown as CordisContext;
    const stop = hideResponsesRoute(ctx, resolveConfig());
    const listed = (await ctx.llm?.listModels?.("opencode")) as Array<{
      id: string;
    }>;
    expect(listed.map((m) => m.id)).toEqual(["adapter-row"]);
    stop?.();
  });
});

describe("models-discovery: hiding the internal Responses route", () => {
  const hostWith = () => {
    const seen: string[] = [];
    const ctx = {
      llm: {
        listConfigurableProviders: () => [
          { provider: "opencode" },
          { provider: RESPONSES_ROUTE },
        ],
        listModels: async (provider: string) => {
          seen.push(provider);
          return [{ id: `${provider}-model` }];
        },
        listProviders: () => [
          { id: "opencode", name: "opencode" },
          { id: RESPONSES_ROUTE, name: RESPONSES_ROUTE },
        ],
      },
    } as unknown as CordisContext;
    return { ctx, seen };
  };

  it("removes the route from every listing a user sees", () => {
    // Three surfaces enumerate providers and there is no hidden flag on any of
    // them. `joinProviderDirectory` (Settings → Models) pushes a row for every
    // REGISTERED provider, so filtering only the configurable directory would
    // leave the route on screen — `listProviders` is the one that matters.
    const { ctx } = hostWith();
    const stop = hideResponsesRoute(ctx, resolveConfig());
    expect(stop).toBeDefined();

    expect(ctx.llm?.listProviders?.()).toEqual([
      { id: "opencode", name: "opencode" },
    ]);
    expect(ctx.llm?.listConfigurableProviders?.()).toEqual([
      { provider: "opencode" },
    ]);
  });

  it("still reports the route as registered, so the redirect fires", () => {
    // The redirect asks whether it has somewhere to go. Asked of the FILTERED
    // listing the answer would always be no and the re-dispatch would never
    // happen — which is why the check reads the original.
    const { ctx } = hostWith();
    const stop = hideResponsesRoute(ctx, resolveConfig());

    expect(isRouteRegistered(RESPONSES_ROUTE)).toBe(true);
    expect(ctx.llm?.listProviders?.()).toHaveLength(1);

    stop?.();
    expect(isRouteRegistered(RESPONSES_ROUTE)).toBe(true);
  });

  it("keeps servable models and empties the internal routes", async () => {
    // Filtering `listModels` is not about hiding the internal routes — nothing
    // reaches it for those. It is about what a user CAN pick: a model whose SDK
    // no route serves must not reach a listing they choose from. A model the
    // catalog does not know names no SDK, which is the route's own api.
    const { ctx, seen } = hostWith();
    const stop = hideResponsesRoute(ctx, resolveConfig());

    await expect(ctx.llm?.listModels?.(RESPONSES_ROUTE)).resolves.toEqual([]);
    // **Exactly the adapter's list — nothing added.** The route's `models:` array
    // is the operator's decision, and a revision that merged the plane's catalog
    // in here silently widened every explicit configuration. That join is gone
    // and this is the guard against it coming back: one declared row in, one row
    // out, even though the catalog knows hundreds more.
    await expect(ctx.llm?.listModels?.("opencode")).resolves.toEqual([
      { id: "opencode-model" },
    ]);
    expect(seen).toEqual(["opencode"]);

    stop?.();
    expect(ctx.llm?.listProviders?.()).toHaveLength(2);
  });

  it("never widens a configured list, even when the catalog knows more", async () => {
    // The operator's `models:` array is the whole list. A model the catalog
    // knows, that the plane could serve, and that the operator did NOT declare
    // must stay out of the picker — otherwise the plugin answers a question the
    // deployment already answered.
    const { ctx } = hostWith();
    const stop = hideResponsesRoute(ctx, resolveConfig());

    const listed = (await ctx.llm?.listModels?.("opencode")) as Array<{
      id: string;
    }>;
    const ids = new Set(listed.map((m) => m.id));
    expect(listed).toHaveLength(1);
    expect(ids.has("opencode-model")).toBe(true);
    // Every one of these is in the live catalog and servable, and none was
    // declared, so none may appear.
    for (const undeclared of ["gpt-5.4", "claude-sonnet-4-5"]) {
      expect(ids.has(undeclared), undeclared).toBe(false);
    }

    stop?.();
  });

  it("degrades to a no-op when the Host exposes no listing at all", () => {
    const ctx = { llm: {} } as unknown as CordisContext;
    expect(hideResponsesRoute(ctx, resolveConfig())).toBeUndefined();
  });

  it("restores each listing method it replaced, by identity, on dispose", () => {
    const { ctx } = hostWith();
    const llm = ctx.llm as Record<string, unknown>;
    const keys = [
      "listProviders",
      "listConfigurableProviders",
      "listModels",
    ] as const;
    const orig = Object.fromEntries(keys.map((key) => [key, llm[key]]));
    const stop = hideResponsesRoute(ctx, resolveConfig());
    for (const key of keys) {
      expect(llm[key], key).not.toBe(orig[key]);
    }

    stop?.();
    for (const key of keys) {
      expect(llm[key], key).toBe(orig[key]);
    }
  });

  it("patches only the listing methods the host has", () => {
    const listModels = async () => [];
    const llm: Record<string, unknown> = { listModels };
    const stop = hideResponsesRoute(
      { llm } as unknown as CordisContext,
      resolveConfig()
    );
    expect(stop).toBeTypeOf("function");
    expect("listProviders" in llm).toBe(false);
    expect("listConfigurableProviders" in llm).toBe(false);
    expect(llm.listModels).not.toBe(listModels);

    stop?.();
    expect(llm.listModels).toBe(listModels);
  });

  it("the patched listing passes the caller's receiver to the host's method", async () => {
    // Both methods read their state through `this`, so either would throw if
    // the patch called the host's method detached.
    const registry = {
      routes: [
        { id: "opencode", name: "opencode" },
        { id: RESPONSES_ROUTE, name: RESPONSES_ROUTE },
      ],
      listProviders(this: { routes: unknown[] }): unknown[] {
        return [...this.routes];
      },
      async listModels(
        this: { routes: unknown[] },
        provider: string
      ): Promise<unknown[]> {
        return this.routes.length > 0 ? [{ id: `${provider}-model` }] : [];
      },
    };
    const stop = hideResponsesRoute(
      { llm: registry } as unknown as CordisContext,
      resolveConfig()
    );

    expect(registry.listProviders()).toEqual([
      { id: "opencode", name: "opencode" },
    ]);
    await expect(registry.listModels("opencode")).resolves.toEqual([
      { id: "opencode-model" },
    ]);
    stop?.();
  });

  it("keeps every listing when the host refuses one of them", () => {
    // All or nothing, a deliberate change in P-H: the three listings must agree
    // on what is hidden, so a host that will not take the `listModels` wrapper
    // keeps all three as they were. Before, a THROWING refusal already rolled
    // back like this, but a SILENT one (`Reflect.set` answering false on a
    // non-writable method) left the other two filtered and returned a disposer.
    const { ctx } = hostWith();
    const llm = ctx.llm as Record<string, unknown>;
    const { listConfigurableProviders, listModels, listProviders } = llm;
    Object.defineProperty(llm, "listModels", {
      configurable: false,
      value: listModels,
      writable: false,
    });

    expect(hideResponsesRoute(ctx, resolveConfig())).toBeUndefined();
    expect(llm.listProviders).toBe(listProviders);
    expect(llm.listConfigurableProviders).toBe(listConfigurableProviders);
    expect(llm.listModels).toBe(listModels);
    expect(ctx.llm?.listProviders?.()).toHaveLength(2);
  });

  it("a reinstall still reads the host's own listing, so the redirect keeps firing", () => {
    // A deliberate change in P-H. Before, the second install destructured the
    // first install's filtered `listProviders` into `registeredRoutes`, so
    // `isRouteRegistered` answered false. A reload's second install is handed
    // the UNPATCHED listing, not the first install's filtered one, so
    // `isRouteRegistered` keeps seeing the hidden route. A second install that stacked on the first would capture the
    // filtered listing, and the redirect would never find its route. (The host
    // here has no `adapters` map, so the listing is the only evidence.)
    const { ctx } = hostWith();
    const a = hideResponsesRoute(ctx, resolveConfig());
    const b = hideResponsesRoute(ctx, resolveConfig());
    expect(ctx.llm?.listProviders?.()).toHaveLength(1);
    expect(isRouteRegistered(RESPONSES_ROUTE)).toBe(true);

    a?.();
    expect(ctx.llm?.listProviders?.()).toHaveLength(1);
    expect(isRouteRegistered(RESPONSES_ROUTE)).toBe(true);
    b?.();
    expect(ctx.llm?.listProviders?.()).toHaveLength(2);
  });

  it("stands down without an llm service", () => {
    expect(
      hideResponsesRoute({} as CordisContext, resolveConfig())
    ).toBeUndefined();
  });
});

describe("models-discovery: the unfiltered registry keeps its receiver", () => {
  it("asks the Host's listing with the service as `this`", () => {
    // The real `listProviders` reads its own state through `this`, so a method
    // read off the service and called detached runs with `this === undefined`
    // and surfaces as "Cannot read properties of undefined (reading 'adapters')"
    // — naming the registry's internals rather than the call that broke the
    // receiver. Every other test here uses an arrow, which cannot catch it.
    const registry = {
      adapters: new Map([["opencode", { id: "opencode" }]]),
      listProviders(this: { adapters: Map<string, unknown> }): unknown {
        return [...this.adapters.values()];
      },
    };
    const ctx = { llm: registry } as unknown as CordisContext;
    const stop = hideResponsesRoute(ctx, resolveConfig());
    expect(stop).toBeTypeOf("function");
    expect(isRouteRegistered("opencode")).toBe(true);
    expect(isRouteRegistered("opencode-responses")).toBe(false);
    stop?.();
  });
});

describe("models-discovery: I1's second clause, for a model no catalog describes", () => {
  it("offers a hand-listed model only where a route can serve it", () => {
    // `undefined` is the completions default, which is right for a model that
    // omits its SDK and wrong for one nobody has described. So the id is asked:
    // a family whose protocol this plane has no route for is not offered.
    // Google models now have a native bridge on both planes.
    expect(isServableModel("gemini-3.8-flash", "opencode-go")).toBe(true);
    // The same model on the plane that DOES carry the route stays offered.
    expect(isServableModel("gemini-3.1-pro", "opencode")).toBe(true);
    // And a family the rule does not name is left alone, because a missing
    // catalog entry is not evidence of anything for it.
    expect(isServableModel("deepseek-v4.1-flash", "opencode-go")).toBe(true);
    expect(isServableModel("some-unknown-model", "opencode-go")).toBe(true);
  });

  it("keeps the catalog's own answer when there is one", () => {
    // A model the catalog describes is answered by its SDK, and the id rule is
    // never consulted - so this cannot change what already worked.
    expect(isServableModel("gemini-3.1-pro", "opencode")).toBe(true);
  });

  it("leaves an undeclared plane alone, so a Go-only deployment is not touched", () => {
    // The plane overrides are keyed on what the deployment DECLARES. Naming
    // `opencode-go` and not `opencode` means the Zen route keeps exactly the
    // behaviour it had, which is the difference between augmenting a route and
    // replacing the user's choice.
    expect(isServableModel("deepseek-v4.1-flash", "opencode")).toBe(true);
    // The route is the only plane input there is; the same id on another plane
    // is answered by that plane's own rules.
    expect(isServableModel("deepseek-v4.1-flash", "opencode-go")).toBe(true);
  });

  it("offers Go Gemini through its native bridge", () => {
    // The Go catalog names the Google protocol, served by the Go bridge.
    expect(isServableModel("gemini-4-argon", "opencode-go")).toBe(true);
  });

  it("offers Zen's free tier models normally", () => {
    expect(isServableModel("beam-free", "opencode")).toBe(true);
    expect(isServableModel("beam-free", "opencode")).toBe(true);
    expect(isServableModel("beam-free", "opencode")).toBe(true);
  });

  it("still offers the Go plane's free models, because Go has no free tier", () => {
    expect(isServableModel("beam-free", "opencode-go")).toBe(true);
    expect(isServableModel("beam-free", "opencode-go")).toBe(true);
    // And a paid Zen model is untouched by the free-tier rule.
    expect(isServableModel("deepseek-v4.1-flash", "opencode")).toBe(true);
  });
});

/**
 * The picker's Effort row. `buildModelCatalog` in the session controller calls
 * `ctx.llm.resolveModelInfo` per model and renders thinking-level choices only
 * from what comes back, so a plane route whose adapter reports no `reasoning`
 * shows the model with NO Effort row at all. These cases are that surface.
 */
describe("models-discovery: the adapter behind a plane route", () => {
  /**
   * A Host LLM service whose registry holds one adapter per route, as the real
   * registry does - `adapters` is a public `Map` keyed by route id.
   *
   * The adapter carries the three methods the real one does. `modelAnswer` is
   * what `modelOf` resolves, which is the object dispatch validates an effort
   * against; it defaults to the same answer `resolveModel` gives.
   */
  const llmWithAdapters = (
    answer: (provider: string, model: string) => unknown,
    modelAnswer: (provider: string, model: string) => unknown = answer
  ): { adapters: Map<string, { adapter: Record<string, unknown> }> } => {
    const adapters = new Map<string, { adapter: Record<string, unknown> }>();
    for (const route of ["opencode", "opencode-go"]) {
      const adapter: Record<string, unknown> = {
        modelOf: (_snapshot: unknown, provider: string, model: string) =>
          modelAnswer(provider, model),
        resolveModel: async (provider: string, model: string) =>
          answer(provider, model),
      };
      adapters.set(route, { adapter });
    }
    return { adapters };
  };

  /** The adapter one route holds, with `resolveModel` typed for the call. */
  const resolveOn = (
    llm: { adapters: Map<string, { adapter: Record<string, unknown> }> },
    route: string
  ): ((provider: string, model: string) => Promise<unknown>) => {
    const adapter = llm.adapters.get(route)?.adapter;
    const fn = adapter?.resolveModel;
    if (typeof fn !== "function") {
      throw new TypeError(`no resolveModel on ${route}`);
    }
    return fn as (provider: string, model: string) => Promise<unknown>;
  };

  /** The adapter one route holds, with `modelOf` typed for the call. */
  const modelOfOn = (
    llm: { adapters: Map<string, { adapter: Record<string, unknown> }> },
    route: string
  ): ((snapshot: unknown, provider: string, model: string) => unknown) => {
    const adapter = llm.adapters.get(route)?.adapter;
    const fn = adapter?.modelOf;
    if (typeof fn !== "function") {
      throw new TypeError(`no modelOf on ${route}`);
    }
    return fn as (
      snapshot: unknown,
      provider: string,
      model: string
    ) => unknown;
  };

  /** The object dispatch reads, as far as the level map is concerned. */
  interface PiModel {
    reasoning?: boolean;
    thinkingLevelMap?: Record<string, string | null>;
  }

  /**
   * The levels `decorateModelInfo` renders as this id's Effort row, from the same
   * derivation it uses: our catalog's map for the model, minus the levels the map
   * pins to `null`. This is the picker half of the promise dispatch has to keep.
   */
  const pickerLevels = (plane: "go" | "zen", id: string): string[] => {
    const spec = findModelSpecOn(plane, id);
    const map = spec === undefined ? undefined : thinkingLevelMapFor(spec);
    if (map === undefined) {
      return [];
    }
    return PI_THINKING_LEVELS.filter((level) => map[level] !== null);
  };

  /**
   * pi's own acceptance rule, which is what `resolveReasoningLevel` throws
   * against - `getSupportedThinkingLevels` in pi-ai, copied verbatim into
   * `dsh-llm-pi-ai`: no map or `reasoning: false` means `off` alone, a `null`
   * entry refuses that level, and `xhigh`/`max` have to have an entry at all.
   */
  const supportedLevels = (model: PiModel): string[] => {
    if (model.reasoning !== true) {
      return ["off"];
    }
    return PI_THINKING_LEVELS.filter((level) => {
      const mapped = model.thinkingLevelMap?.[level];
      if (mapped === null) {
        return false;
      }
      if (level === "xhigh" || level === "max") {
        return mapped !== undefined;
      }
      return true;
    });
  };

  it("fills what the adapter left blank, so dispatch sees the model's reasoning", async () => {
    // The seam the modelOverrides attempt missed, and the half of it that reads
    // this method (`modelOf` is the other - see the case below). The plane
    // route's adapter resolves from pi's installed catalog, which carries no
    // step-5 entry on either plane, so it answers nothing about the model and a
    // saved effort then fails validation with UNSUPPORTED_REASONING_EFFORT.
    const llm = llmWithAdapters(() => ({}));
    const stop = decoratePlaneAdapters(
      llm as never,
      resolveConfig({ enrichModels: true })
    );

    // The adapter answers an EMPTY record, exactly as pi's does for a model it
    // does not carry.
    const resolved = (await resolveOn(llm, "opencode-go")(
      "opencode-go",
      "beam-free"
    )) as {
      id?: string;
      name?: string;
      context?: { contextWindow?: number };
      defaultMaxTokens?: number;
      reasoning?: { efforts: { id: string }[] };
    };

    // Everything dispatch validates against, filled from our catalog.
    expect(resolved.id).toBe("beam-free");
    expect(resolved.name).toBeTruthy();
    expect(resolved.context?.contextWindow).toBeGreaterThan(0);
    expect(resolved.defaultMaxTokens).toBeGreaterThan(0);
    // And the levels the composer offers - so a saved `high` resolves rather
    // than being rejected. `beam-free` declares five efforts, and the point is
    // that they come from OUR catalog rather than from the empty adapter answer.
    expect(resolved.reasoning?.efforts.map((e) => e.id)).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);

    stop?.();
  });

  it("keeps an adapter's own answer, because that is what dispatch honours", async () => {
    // A COMPLETE answer, because the wrapper fills only what is absent and an
    // identity field it adds is not it overriding anything.
    const own = {
      context: { contextWindow: 999 },
      defaultMaxTokens: 12345,
      id: "beam-free",
      inputModalities: ["text"],
      name: "Its Own Name",
      provider: "opencode",
      reasoning: { efforts: [{ id: "high", name: "High" }] },
    };
    const llm = llmWithAdapters(() => own);
    const stop = decoratePlaneAdapters(
      llm as never,
      resolveConfig({ enrichModels: true })
    );
    const resolved = (await resolveOn(llm, "opencode")(
      "opencode",
      "beam-free"
    )) as Record<string, unknown>;
    // Every field the adapter answered is kept: it is what dispatch honours.
    expect(resolved).toMatchObject(own);
    // The ROUTING fields are the plugin's, and they are new here. The host
    // dispatches on `model.api` (`dsh-llm-pi-ai`:
    // `stream: (model, …) => input.api.stream(model, …)`), and it materializes a
    // hand-declared model with the ROUTE's protocol — so a model whose catalog
    // protocol differs is mis-dispatched unless the wrapper says otherwise. This
    // is what lets one provider route serve every protocol its models name,
    // instead of a provider per protocol.
    expect(resolved.api).toBe("openai-completions");
    expect(resolved.baseUrl).toBe("https://opencode.ai/inference/openai/v1");
    stop?.();
  });

  it("applies modelOverrides in decoratePlaneAdapters when declared", async () => {
    const raw = {
      context: { contextWindow: 1_000_000 },
      defaultMaxTokens: 32_000,
      id: "gpt-5.4",
      name: "GPT-5.4",
    };
    const llm = llmWithAdapters(() => raw);
    const stop = decoratePlaneAdapters(
      llm as never,
      resolveConfig({
        enrichModels: true,
        modelOverrides: {
          "gpt-5.4": {
            contextWindow: 65_536,
            inputModalities: ["text"],
            maxTokens: 8_192,
            name: "GPT-5.4 Adapter Override",
            reasoningEfforts: ["none", "medium"],
          },
        },
      })
    );
    const resolved = (await resolveOn(llm, "opencode")(
      "opencode",
      "gpt-5.4"
    )) as {
      context?: { contextWindow?: number };
      defaultMaxTokens?: number;
      inputModalities?: string[];
      name?: string;
      reasoning?: { efforts: { id: string }[] };
    };
    expect(resolved.context?.contextWindow).toBe(65_536);
    expect(resolved.defaultMaxTokens).toBe(8_192);
    expect(resolved.name).toBe("GPT-5.4 Adapter Override");
    expect(resolved.inputModalities).toEqual(["text"]);
    expect(resolved.reasoning?.efforts.map((e) => e.id)).toEqual([
      "none",
      "medium",
    ]);
    stop?.();
  });

  it("restores the adapter's own methods on dispose", () => {
    const llm = llmWithAdapters(() => ({}));
    const before = llm.adapters.get("opencode-go")?.adapter.resolveModel;
    const beforeModelOf = llm.adapters.get("opencode-go")?.adapter.modelOf;
    const stop = decoratePlaneAdapters(
      llm as never,
      resolveConfig({ enrichModels: true })
    );
    const after = llm.adapters.get("opencode-go")?.adapter.resolveModel;
    expect(after).not.toBe(before);
    expect(llm.adapters.get("opencode-go")?.adapter.modelOf).not.toBe(
      beforeModelOf
    );
    stop?.();
    expect(llm.adapters.get("opencode-go")?.adapter.resolveModel).toBe(before);
    expect(llm.adapters.get("opencode-go")?.adapter.modelOf).toBe(
      beforeModelOf
    );
  });

  it("stands down on a frozen adapter: nothing installed, nothing thrown", () => {
    // A deliberate change in P-H. Before, `adapter[method] = wrapped` threw a
    // TypeError out of the fetch-patch effect on a frozen adapter; now a refused
    // method is skipped, and with every method refused there is nothing to
    // dispose.
    const adapter = Object.freeze({
      modelOf: () => ({}),
      prepareCall: async () => ({}),
      resolveModel: async () => ({}),
    });
    const before = { ...adapter };
    const llm = { adapters: new Map([["opencode-go", { adapter }]]) };

    expect(
      decoratePlaneAdapters(llm as never, resolveConfig({ enrichModels: true }))
    ).toBeUndefined();
    expect({ ...adapter }).toEqual(before);
  });

  it("skips one method the adapter refuses and patches the rest, per method", () => {
    // A deliberate change in P-H. Before, `adapter[method] = wrapped` threw a
    // TypeError on the non-writable `prepareCall`. Each adapter fill is
    // independent, so a refused method costs only itself: unlike the listings,
    // which must agree and are all or nothing.
    const prepareCall = async () => ({});
    const adapter: Record<string, unknown> = {
      modelOf: () => ({}),
      resolveModel: async () => ({}),
    };
    Object.defineProperty(adapter, "prepareCall", {
      configurable: false,
      enumerable: true,
      value: prepareCall,
      writable: false,
    });
    const { modelOf, resolveModel } = adapter;
    const llm = { adapters: new Map([["opencode-go", { adapter }]]) };
    const stop = decoratePlaneAdapters(
      llm as never,
      resolveConfig({ enrichModels: true })
    );

    expect(stop).toBeTypeOf("function");
    expect(adapter.prepareCall).toBe(prepareCall);
    expect(adapter.resolveModel).not.toBe(resolveModel);
    expect(adapter.modelOf).not.toBe(modelOf);
    stop?.();
    expect(adapter.resolveModel).toBe(resolveModel);
    expect(adapter.modelOf).toBe(modelOf);
    expect(adapter.prepareCall).toBe(prepareCall);
  });

  it("calls the original on the adapter, because it is a class method that reads `this`", async () => {
    // The registry holds CLASS instances, not bags of arrows: pi-ai's real
    // `resolveModel` opens with `this.current()`. A wrapper that calls the
    // extracted method detached fails the provider's entire catalog load with
    // "Cannot read properties of undefined", which is the live symptom this
    // case exists for.
    class Adapter {
      calls = 0;
      async resolveModel(provider: string, model: string): Promise<unknown> {
        this.calls += 1;
        return { id: model, provider };
      }
    }
    const adapter = new Adapter();
    const llm = { adapters: new Map([["opencode-go", { adapter }]]) };
    const stop = decoratePlaneAdapters(
      llm as never,
      resolveConfig({ enrichModels: true })
    );

    const resolved = (await resolveOn(llm as never, "opencode-go")(
      "opencode-go",
      "beam-free"
    )) as { context?: { contextWindow?: number } };

    // It ran ON the instance - the counter lives on `this` - and the wrapper
    // still filled the context pi does not carry.
    expect(adapter.calls).toBe(1);
    expect(resolved.context?.contextWindow).toBeGreaterThan(0);

    stop?.();
  });

  it("leaves another provider's adapter alone", () => {
    // Only the plane routes' adapters are this plugin's to replace; a foreign
    // adapter in the same registry keeps its methods, and the stand-down says
    // so by restoring nothing.
    const foreign: Record<string, unknown> = {
      modelOf: () => ({}),
      resolveModel: async () => ({}),
    };
    const llm = { adapters: new Map([["commandcode", { adapter: foreign }]]) };
    const stop = decoratePlaneAdapters(
      llm as never,
      resolveConfig({ enrichModels: true })
    );

    expect(llm.adapters.get("commandcode")?.adapter.resolveModel).toBe(
      foreign.resolveModel
    );
    expect(llm.adapters.get("commandcode")?.adapter.modelOf).toBe(
      foreign.modelOf
    );
    expect(stop).toBeUndefined();
  });

  it("accepts at dispatch every level the picker offers, for a model pi does not carry", () => {
    // The failure this exists for, in one case: `glm-5.3-flash-free` is on both
    // planes and in neither of pi's installed catalogs, so the materialized model
    // came back `reasoning: false` with no level map, the only level it took was
    // `off`, and a saved `max` AND `high` were both refused with
    // UNSUPPORTED_REASONING_EFFORT while the picker offered both.
    const llm = llmWithAdapters(
      () => ({}),
      () => ({ id: "glm-5.3-flash-free", reasoning: false })
    );
    const stop = decoratePlaneAdapters(
      llm as never,
      resolveConfig({ enrichModels: true })
    );

    const model = modelOfOn(llm, "opencode")(
      undefined,
      "opencode",
      "glm-5.3-flash-free"
    ) as PiModel;

    expect(model.reasoning).toBe(true);
    // THE invariant, and the whole point of the wrap: every level the Effort row
    // offers is a level this model answers.
    const offered = pickerLevels("zen", "glm-5.3-flash-free");
    expect(offered.length).toBeGreaterThan(0);
    expect(supportedLevels(model)).toEqual(expect.arrayContaining(offered));

    stop?.();
  });

  it("hands back the adapter's own object when it already takes every offered level", () => {
    // The no-op branch: nothing is filled, so dispatch keeps the object the
    // adapter made rather than an equal copy - `beam-free` ships a
    // complete map, so there is nothing to add.
    const own = {
      id: "beam-free",
      reasoning: true,
      thinkingLevelMap: {
        high: "high",
        low: "low",
        max: "max",
        medium: "medium",
        off: null,
        xhigh: "xhigh",
      },
    };
    const llm = llmWithAdapters(
      () => ({}),
      () => own
    );
    const stop = decoratePlaneAdapters(
      llm as never,
      resolveConfig({ enrichModels: true })
    );

    expect(modelOfOn(llm, "opencode")(undefined, "opencode", "beam-free")).toBe(
      own
    );

    stop?.();
  });

  it("fills only what the model refuses, and keeps the spelling the model declared", () => {
    // A model can answer with a map of its own - pi ships one, and a deployment's
    // `reasoningEfforts` row materializes as one - and that map is the adapter's
    // answer about its own protocol, so it is not to be rewritten. Three things
    // it does differently from ours, all of them kept:
    //
    //   `off: "none"`      a level we do not offer at all (never removed)
    //   `medium: "medium-plus"`  a level it spells its own way (kept, not respelled)
    //   `low` absent       a base level it takes implicitly, with `low` on the wire
    //
    // And one thing it refuses that the picker still offers - `xhigh: null` for
    // this id - which is exactly what gets filled, because otherwise the Effort
    // row promises a level `resolveReasoningLevel` throws on.
    const declared = {
      id: "qwen3.8-flash",
      reasoning: true,
      thinkingLevelMap: { medium: "medium-plus", off: "none", xhigh: null },
    };
    const llm = llmWithAdapters(
      () => ({}),
      () => ({ ...declared })
    );
    const stop = decoratePlaneAdapters(
      llm as never,
      resolveConfig({ enrichModels: true })
    );

    const model = modelOfOn(llm, "opencode")(
      undefined,
      "opencode",
      "qwen3.8-flash"
    ) as PiModel;

    expect(model.thinkingLevelMap?.off).toBe("none");
    expect(model.thinkingLevelMap?.medium).toBe("medium-plus");
    expect(model.thinkingLevelMap?.low).toBeUndefined();
    expect(model.thinkingLevelMap?.xhigh).toBe("xhigh");
    const offered = pickerLevels("zen", "qwen3.8-flash");
    expect(offered).toEqual(expect.arrayContaining(["low", "medium", "xhigh"]));
    expect(supportedLevels(model)).toEqual(expect.arrayContaining(offered));

    stop?.();
  });

  it("accepts the levels a deployment's own modelOverrides names", () => {
    // The picker renders an override's ids verbatim, so dispatch has to take
    // them: one promise, not two.
    const llm = llmWithAdapters(
      () => ({}),
      () => ({ id: "glm-5.3-flash-free", reasoning: false })
    );
    const stop = decoratePlaneAdapters(
      llm as never,
      resolveConfig({
        enrichModels: true,
        modelOverrides: {
          "glm-5.3-flash-free": { reasoningEfforts: ["off", "medium"] },
        },
      })
    );

    const model = modelOfOn(llm, "opencode")(
      undefined,
      "opencode",
      "glm-5.3-flash-free"
    ) as PiModel;

    expect(supportedLevels(model)).toEqual(
      expect.arrayContaining(["off", "medium"])
    );

    stop?.();
  });

  it("leaves alone an id the plane's own catalog does not carry", () => {
    // "No opinion" is per PLANE, because the two are different catalogs:
    // `step-5-preview` is Go's, so on Zen there is nothing to fill, and neither
    // is anything invented for an id no catalog knows at all.
    const goOnly = { id: "step-5-preview" };
    const foreign = { id: "not-a-catalogued-id" };
    const llm = llmWithAdapters(
      () => ({}),
      (_provider, model) => (model === goOnly.id ? goOnly : foreign)
    );
    const stop = decoratePlaneAdapters(
      llm as never,
      resolveConfig({ enrichModels: true })
    );

    // On its own plane it is catalogued and filled; on Zen it is left exactly as
    // the adapter answered.
    expect(
      modelOfOn(llm, "opencode-go")(undefined, "opencode-go", goOnly.id)
    ).not.toBe(goOnly);
    expect(modelOfOn(llm, "opencode")(undefined, "opencode", goOnly.id)).toBe(
      goOnly
    );
    expect(modelOfOn(llm, "opencode")(undefined, "opencode", foreign.id)).toBe(
      foreign
    );

    stop?.();
  });

  it("one adapter serving both planes: the later plane's fill wraps the earlier one, in registry order", async () => {
    // pi-ai serves both plane routes from ONE adapter instance, so the wrap is
    // applied once per route and the later route's fill runs over the earlier
    // one's answer. The base the earlier plane wrote is not a retired one, so
    // the later fill keeps it: in registry order [opencode, opencode-go] both
    // routes answer Zen's base. The host characterization's pi-ai-first
    // `[INTENDED_CHANGE]` row pins the same nesting on the real host.
    const specOn = (plane: "go" | "zen") => {
      const spec = findModelSpecOn(plane, "deepseek-v4-pro");
      const protocol = spec === undefined ? undefined : protocolFor(spec);
      if (protocol === undefined) {
        throw new TypeError(`no protocol for deepseek-v4-pro on ${plane}`);
      }
      return protocol;
    };
    const { endpoint } = resolveConfig();
    const zen = baseForProtocol("opencode", specOn("zen"), endpoint);
    const go = baseForProtocol("opencode-go", specOn("go"), endpoint);
    expect(zen).not.toBe(go);

    const baseFor = async (
      order: readonly string[]
    ): Promise<{ calls: number; bases: unknown[] }> => {
      const prepareCall = vi.fn(async () => ({}));
      const adapter: Record<string, unknown> = { prepareCall };
      const llm = {
        adapters: new Map(order.map((route) => [route, { adapter }])),
      };
      const stop = decoratePlaneAdapters(llm as never, resolveConfig());
      const call = adapter.prepareCall as (
        provider: string,
        model: string
      ) => Promise<{ baseUrl?: unknown }>;
      const onGo = await call("opencode-go", "deepseek-v4-pro");
      const onZen = await call("opencode", "deepseek-v4-pro");
      const bases = [onGo.baseUrl, onZen.baseUrl];
      stop?.();
      return { bases, calls: prepareCall.mock.calls.length };
    };

    await expect(baseFor(["opencode", "opencode-go"])).resolves.toEqual({
      bases: [zen, zen],
      calls: 2,
    });
    await expect(baseFor(["opencode-go", "opencode"])).resolves.toEqual({
      bases: [go, go],
      calls: 2,
    });
  });

  it("a class adapter answers from its prototype again after dispose", async () => {
    // A deliberate change in P-H. Before, the disposer assigned the prototype's
    // method back as an OWN property, which answered the same but shadowed the
    // prototype for good; now the own property is deleted.
    class Adapter {
      async resolveModel(_provider: string, model: string): Promise<unknown> {
        return { id: model, marker: "raw" };
      }
    }
    const adapter = new Adapter();
    const llm = { adapters: new Map([["opencode-go", { adapter }]]) };
    const stop = decoratePlaneAdapters(llm as never, resolveConfig());

    const decorated = (await adapter.resolveModel(
      "opencode-go",
      "beam-free"
    )) as {
      context?: { contextWindow?: number };
    };
    expect(decorated.context?.contextWindow).toBeGreaterThan(0);

    stop?.();
    expect(Object.hasOwn(adapter, "resolveModel")).toBe(false);
    await expect(
      adapter.resolveModel("opencode-go", "beam-free")
    ).resolves.toEqual({ id: "beam-free", marker: "raw" });
  });

  it("stands down when the host exposes no adapter registry", () => {
    expect(decoratePlaneAdapters({} as never, resolveConfig())).toBeUndefined();
    expect(
      decoratePlaneAdapters(undefined as never, resolveConfig())
    ).toBeUndefined();
  });
});

describe("models-discovery: the Effort row a model reports", () => {
  /** A minimal Host `llm` service whose `resolveModelInfo` answers per route. */
  const llmWith = (answer: (provider: string, model: string) => unknown) => ({
    llm: {
      resolveModelInfo: async (provider: string, model: string) =>
        answer(provider, model),
    },
  });

  const enrichConfig = resolveConfig({ enrichModels: true });
  const patched = (
    ctx: CordisContext
  ): ((...a: unknown[]) => Promise<unknown>) =>
    (ctx.llm as { resolveModelInfo: (...a: unknown[]) => Promise<unknown> })
      .resolveModelInfo;

  it("survives a model the route's adapter refuses to resolve", async () => {
    // The Host builds a provider's group with `Promise.all` over `listModels`, and
    // a rejection there is caught per PROVIDER — so ONE unresolvable model removes
    // EVERY model on that route from the picker. That became reachable when
    // `listModels` started publishing the whole catalog on the parent route: the
    // route's own adapter never carried the Responses / Messages / Google models,
    // so it may refuse an id it does not know.
    const ctx = {
      llm: {
        // Refuses every id, which is what an adapter does for a model its
        // installed catalog does not carry — and is the worst case for the group.
        resolveModelInfo: async () => {
          throw new Error("unknown model");
        },
      },
    } as never as CordisContext;
    const stop = decorateModelInfo(ctx, enrichConfig);

    // The unknown-to-the-adapter model answers from OUR catalog instead of
    // throwing, so the group survives.
    const resolved = (await patched(ctx)("opencode", "gpt-5.4")) as {
      context?: { contextWindow?: number };
      reasoning?: { efforts: unknown[] };
    };
    expect(resolved.context?.contextWindow).toBeGreaterThan(0);
    expect(resolved.reasoning?.efforts.length).toBeGreaterThan(0);

    // A model the catalog cannot describe either still throws: inventing an answer
    // for an id nobody knows would hide a real problem.
    await expect(patched(ctx)("opencode", "not-a-real-model")).rejects.toThrow(
      "unknown model"
    );

    stop?.();
  });

  it("leaves a provider it does not claim to its own adapter", async () => {
    // The catalog is OpenCode's. A foreign route whose adapter refuses an id the
    // catalog happens to share must keep its own failure, and one that answers
    // must keep its own limits rather than OpenCode's.
    const own = {
      context: { contextWindow: 200_000 },
      id: "claude-sonnet-4-5",
    };
    const ctx = {
      llm: {
        resolveModelInfo: async (provider: string) => {
          if (provider === "anthropic-broken") {
            throw new Error("adapter refused");
          }
          return own;
        },
      },
    } as never as CordisContext;
    const stop = decorateModelInfo(ctx, enrichConfig);
    await expect(
      patched(ctx)("anthropic-broken", "claude-sonnet-4-5")
    ).rejects.toThrow("adapter refused");
    expect(await patched(ctx)("anthropic", "claude-sonnet-4-5")).toBe(own);
    // The claimed route still answers from the catalog, so the guard is not
    // simply switching the decorator off.
    const claimed = (await patched(ctx)("opencode", "claude-sonnet-4-5")) as {
      context?: { contextWindow?: number };
    };
    expect(claimed.context?.contextWindow).not.toBe(200_000);
    stop?.();
  });

  it("turns a NON-RECORD answer into a catalog record, so the group survives", async () => {
    // The quieter half of the same hazard. The Host reads `resolved.reasoning`
    // immediately after `resolveModelInfo` returns, so an `undefined` answer is a
    // TypeError inside the group's `Promise.all` — and the whole provider group
    // goes with it, exactly as a throw would.
    const ctx = {
      llm: {
        // Answers nothing at all for every id, which is what a permissive
        // adapter does for a model its installed catalog does not carry.
        resolveModelInfo: async () => {
          /* answers nothing at all */
        },
      },
    } as never as CordisContext;
    const stop = decorateModelInfo(ctx, enrichConfig);

    const resolved = (await patched(ctx)("opencode", "gpt-5.4")) as {
      context?: { contextWindow?: number };
      defaultMaxTokens?: number;
      reasoning?: { efforts: unknown[] };
    };
    expect(resolved).toBeTypeOf("object");
    expect(resolved.context?.contextWindow).toBeGreaterThan(0);
    expect(resolved.defaultMaxTokens).toBeGreaterThan(0);
    expect(resolved.reasoning?.efforts.length).toBeGreaterThan(0);

    // An id the catalog cannot describe still passes through unchanged: there is
    // nothing honest to build, and the Host's own handling is the better error.
    await expect(
      patched(ctx)("opencode", "not-a-real-model")
    ).resolves.toBeUndefined();

    stop?.();
  });

  it("fills the reasoning a plane route's adapter does not report", async () => {
    const ctx = llmWith(() => ({
      id: "minimax-m3",
      name: "MiniMax-M3",
      provider: "opencode",
    })) as never as CordisContext;
    const stop = decorateModelInfo(ctx, enrichConfig);

    // The plane route is the user's own: it declares no models, so its adapter
    // answers straight from the installed catalog and reports no reasoning.
    const resolved = await patched(ctx)("opencode", "minimax-m3");
    expect(resolved).toMatchObject({
      context: { contextWindow: 512_000 },
      reasoning: { efforts: expect.any(Array) },
    });
    const { efforts } = (
      resolved as { reasoning: { efforts: { id: string; name: string }[] } }
    ).reasoning;
    expect(efforts.length).toBeGreaterThan(0);
    for (const effort of efforts) {
      expect(typeof effort.id).toBe("string");
      expect(typeof effort.name).toBe("string");
      // `off` is never offered: the map pins it to null, which is the
      // adapter's way of saying the model has no off switch.
      expect(effort.id).not.toBe("off");
    }

    stop?.();
  });

  it("leaves the internal routes alone, because their adapter is already right", async () => {
    const answer = (provider: string) => ({
      id: "minimax-m3",
      name: "MiniMax-M3",
      provider,
      reasoning: { efforts: [{ id: "high", name: "High" }] },
    });
    const ctx = llmWith(answer) as never as CordisContext;
    const stop = decorateModelInfo(ctx, enrichConfig);

    const resolved = await patched(ctx)("opencode-anthropic", "minimax-m3");
    // Unchanged: decorating our own route would risk disagreeing with dispatch.
    expect(resolved).toEqual(answer("opencode-anthropic"));

    stop?.();
  });

  it("overrides a STALE adapter answer with the catalog's fresher vintage", async () => {
    // The reason this overrides rather than fills. pi ships its own installed
    // `opencode` catalog the plane routes fall back to, and it is an older
    // snapshot of models.dev: gpt-5.4 at 272k where the vendor and our shim both
    // say 1.05M, claude-sonnet-4-5 at 200k with no thinking map where models.dev
    // declares 1M and a token minimum. Filling only what was BLANK let those
    // stale values survive, and the surfaces reported them.
    const stale = {
      context: { contextWindow: 272_000 },
      defaultMaxTokens: 64_000,
      id: "gpt-5.4",
      name: "GPT-5.4",
      provider: "opencode",
      // pi's stale map offers `medium`; ours says low/medium/high/xhigh.
      reasoning: {
        efforts: [
          { id: "off", name: "Off" },
          { id: "low", name: "Low" },
          { id: "medium", name: "Medium" },
        ],
      },
    };
    const ctx = llmWith(() => stale) as never as CordisContext;
    const stop = decorateModelInfo(ctx, enrichConfig);

    const resolved = (await patched(ctx)("opencode", "gpt-5.4")) as {
      context?: { contextWindow?: number };
      defaultMaxTokens?: number;
      reasoning?: { efforts: { id: string }[] };
    };
    // The window and the cap come from our catalog.
    expect(resolved.context).toEqual({ contextWindow: 1_050_000 });
    expect(resolved.defaultMaxTokens).toBe(128_000);
    // And so do the levels: `off` is not offered and `xhigh` now is.
    expect(resolved.reasoning?.efforts.map((e) => e.id)).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
    // Everything the catalog does not decide is left as the adapter said it.
    expect(resolved).toMatchObject({ id: "gpt-5.4", name: "GPT-5.4" });

    stop?.();
  });

  it("leaves a model the catalog does not describe to its adapter", async () => {
    // The other half of the authority argument: our catalog decides the fields
    // IT carries, and a model it has never heard of is not ours to correct. A
    // hand-declared model in a deployment's profile keeps whatever its adapter
    // says, including a reasoning block this plugin knows nothing about.
    const own = {
      context: { contextWindow: 4096 },
      id: "hand-declared-model",
      name: "Hand Declared",
      provider: "opencode",
      reasoning: { efforts: [{ id: "high", name: "High" }] },
    };
    const ctx = llmWith(() => own) as never as CordisContext;
    const stop = decorateModelInfo(ctx, enrichConfig);

    const resolved = await patched(ctx)("opencode", "hand-declared-model");
    expect(resolved).toEqual(own);

    stop?.();
  });

  it("restores the original method on dispose, and only if it is still ours", () => {
    const before = async () => ({ id: "x" });
    const ctx = { llm: { resolveModelInfo: before } } as never as CordisContext;
    const stop = decorateModelInfo(ctx, enrichConfig);

    expect(patched(ctx)).not.toBe(before);
    stop?.();
    expect(patched(ctx)).toBe(before);
  });

  it("calls the host's method with the service as its receiver", async () => {
    class InfoHost {
      answers = new Map([
        ["hand-declared-model", { id: "hand-declared-model", name: "Mine" }],
      ]);
      async resolveModelInfo(
        _provider: string,
        model: string
      ): Promise<unknown> {
        return this.answers.get(model);
      }
    }
    const llm = new InfoHost();
    const stop = decorateModelInfo(
      { llm } as unknown as CordisContext,
      enrichConfig
    );

    // Uncatalogued, so the answer passes through - read off `this`.
    await expect(
      llm.resolveModelInfo("opencode", "hand-declared-model")
    ).resolves.toEqual({ id: "hand-declared-model", name: "Mine" });
    stop?.();
  });

  it("leaves a wrapper installed on top of it in place on dispose", () => {
    const before = async () => ({ id: "x" });
    const ctx = { llm: { resolveModelInfo: before } } as never as CordisContext;
    const stop = decorateModelInfo(ctx, enrichConfig);
    const foreign = async () => ({ id: "foreign" });
    (ctx.llm as Record<string, unknown>).resolveModelInfo = foreign;
    stop?.();

    expect(patched(ctx)).toBe(foreign);
  });

  it("leaves a non-extensible service installed", () => {
    const before = async () => ({ id: "x" });
    const ctx = {
      llm: Object.freeze({ resolveModelInfo: before }),
    } as never as CordisContext;

    expect(decorateModelInfo(ctx, enrichConfig)).toBeUndefined();
    expect(patched(ctx)).toBe(before);
  });

  it("installs nothing when the plugin is not enriching models", () => {
    const before = async () => ({ id: "x" });
    const ctx = { llm: { resolveModelInfo: before } } as never as CordisContext;
    expect(
      decorateModelInfo(ctx, resolveConfig({ enrichModels: false }))
    ).toBeUndefined();
    expect(patched(ctx)).toBe(before);
  });

  it("clamps context window when a deployment maxContextWindow ceiling is configured", async () => {
    const original = { id: "gpt-5.4", name: "GPT-5.4" };
    const ctx = llmWith(() => original) as never as CordisContext;
    // Set deployment context ceiling to 131,072 tokens (clamping gpt-5.4 from 1,050,000)
    const customConfig = resolveConfig({
      enrichModels: true,
      maxContextWindow: 131_072,
    });
    const stop = decorateModelInfo(ctx, customConfig);

    const resolved = (await patched(ctx)("opencode", "gpt-5.4")) as {
      context?: { contextWindow?: number };
    };
    expect(resolved.context?.contextWindow).toBe(131_072);
    stop?.();
  });

  it("preserves custom properties on existing context objects", async () => {
    const withCustomContext = {
      context: { contextWindow: 65_536, reservedTokens: 4096 },
      id: "gpt-5.4",
      name: "GPT-5.4",
    };
    const ctx = llmWith(() => withCustomContext) as never as CordisContext;
    const stop = decorateModelInfo(ctx, enrichConfig);

    const resolved = (await patched(ctx)("opencode", "gpt-5.4")) as {
      context?: { contextWindow?: number; reservedTokens?: number };
    };
    // Canonical catalog spec for gpt-5.4 (1,050,000) overrides adapter context window,
    // while preserving custom fields on context (like reservedTokens).
    expect(resolved.context?.contextWindow).toBe(1_050_000);
    // Custom context property is preserved rather than wiped
    expect(resolved.context?.reservedTokens).toBe(4096);
    stop?.();
  });

  it("applies per-model configuration overrides for context window, caps, and metadata", async () => {
    const original = (_provider: string, model: string) => ({
      id: model,
      name: model === "gpt-5.4" ? "GPT-5.4" : "Claude Sonnet 4.5",
    });
    const ctx = llmWith(original) as never as CordisContext;
    const configWithOverrides = resolveConfig({
      enrichModels: true,
      modelOverrides: {
        "gpt-5.4": {
          contextWindow: 65_536,
          inputModalities: ["text"],
          maxTokens: 16_384,
          name: "GPT-5.4 Custom Name",
          reasoningEfforts: ["none", "high"],
        },
      },
    });
    const stop = decorateModelInfo(ctx, configWithOverrides);

    const resolved = (await patched(ctx)("opencode", "gpt-5.4")) as {
      context?: { contextWindow?: number };
      defaultMaxTokens?: number;
      inputModalities?: string[];
      name?: string;
      reasoning?: { efforts: { id: string; name: string }[] };
    };
    expect(resolved.context?.contextWindow).toBe(65_536);
    expect(resolved.defaultMaxTokens).toBe(16_384);
    expect(resolved.name).toBe("GPT-5.4 Custom Name");
    expect(resolved.inputModalities).toEqual(["text"]);
    expect(resolved.reasoning?.efforts).toEqual([
      { id: "none", name: "None" },
      { id: "high", name: "High" },
    ]);

    // Unrelated models keep their canonical specs
    const sonnet = (await patched(ctx)("opencode", "claude-sonnet-4-5")) as {
      context?: { contextWindow?: number };
      name?: string;
    };
    expect(sonnet.context?.contextWindow).toBe(1_000_000);
    expect(sonnet.name).toBe("Claude Sonnet 4.5");

    stop?.();
  });
});

describe("models-discovery: resolveEffectiveContextWindow", () => {
  it("returns canonical window when neither requested window nor ceiling is set", () => {
    expect(resolveEffectiveContextWindow(1_050_000)).toBe(1_050_000);
    expect(resolveEffectiveContextWindow(200_000)).toBe(200_000);
  });

  it("clamps requested window to canonical window if requested exceeds physical capability", () => {
    // If user/caller requests 2,000,000 tokens on a 1,050,000 model, it clamps to physical limit
    expect(resolveEffectiveContextWindow(1_050_000, 2_000_000)).toBe(1_050_000);
  });

  it("takes the window the deployment declared, even above the catalog's", () => {
    // The catalog is a bundled snapshot of the vendor's published limits and it is
    // conservative where the vendor is: the free DeepSeek id is listed at 200k
    // while the model serves 1M. A declared window therefore wins outright —
    // `Math.min(requested, canonical)` used to clamp it back down, which made a
    // stale catalog entry unoverridable.
    expect(resolveEffectiveContextWindow(1_000_000)).toBe(1_000_000);
    expect(resolveEffectiveContextWindow(2_000_000)).toBe(2_000_000);
  });

  it("still clamps to an explicitly configured ceiling", () => {
    // `maxContextWindow` is the deployment's own bound, which is a different thing
    // from our estimate of the model's.
    expect(resolveEffectiveContextWindow(2_000_000, 262_144)).toBe(262_144);
    expect(resolveEffectiveContextWindow(100_000, 262_144)).toBe(100_000);
  });

  it("ignores invalid, non-positive or non-finite values", () => {
    expect(resolveEffectiveContextWindow(1_050_000, "invalid")).toBe(1_050_000);
    expect(resolveEffectiveContextWindow(1_050_000, null)).toBe(1_050_000);
    expect(
      resolveEffectiveContextWindow(1_050_000, Number.POSITIVE_INFINITY)
    ).toBe(1_050_000);
    expect(resolveEffectiveContextWindow(0)).toBe(0);
    expect(resolveEffectiveContextWindow(Number.NaN)).toBe(0);
  });
});

describe("models-discovery: a keyless deployment is offered only what it can call", () => {
  /**
   * A host whose parent route lists one priced model and one free one.
   *
   * The official client's rule (`provider/provider.ts:231-237`) is to delete every
   * model whose `cost.input` is not 0 when no credential is present; without it the
   * picker offers rows that answer 401 and says nothing about why.
   */
  const hostListing = (ids: readonly string[]) =>
    ({
      llm: {
        listConfigurableProviders: () => [{ provider: "opencode" }],
        listModels: async (provider: string) =>
          provider === "opencode" ? ids.map((id) => ({ id })) : [],
        listProviders: () => [{ id: "opencode", name: "opencode" }],
      },
    }) as unknown as CordisContext;

  const listedFor = async (
    ctx: CordisContext,
    verify?: (plane: string) => boolean
  ): Promise<string[]> => {
    const stop = hideResponsesRoute(
      ctx,
      resolveConfig(),
      verify === undefined ? {} : { hasCredential: verify }
    );
    const listed = (await ctx.llm?.listModels?.("opencode")) as Array<{
      id: string;
    }>;
    stop?.();
    return listed.map((model) => model.id);
  };

  it("drops the priced model when no credential resolves", async () => {
    const ids = await listedFor(
      hostListing(["gpt-5.4", "beam-free"]),
      () => false
    );
    expect(ids).toEqual(["beam-free"]);
  });

  it("keeps every model when the plane does hold a credential", async () => {
    const ids = await listedFor(
      hostListing(["gpt-5.4", "beam-free"]),
      () => true
    );
    expect(ids).toEqual(["gpt-5.4", "beam-free"]);
  });

  it("leaves the list untouched when the caller does not ask", async () => {
    // The default is "do not narrow": a caller that cannot tell must not hide
    // models a deployment can actually use.
    const ids = await listedFor(hostListing(["gpt-5.4", "beam-free"]));
    expect(ids).toEqual(["gpt-5.4", "beam-free"]);
  });
});

describe("models-discovery · the endpoint a model is dispatched to", () => {
  /** One plane-route adapter answering with a fixed model, then resolve it. */
  const resolveBase = async (
    own: Record<string, unknown>,
    plan: { model?: string; route?: string } = {}
  ): Promise<unknown> => {
    const route = plan.route ?? "opencode";
    const model = plan.model ?? "beam-free";
    const answer = () => ({
      context: { contextWindow: 999 },
      id: model,
      inputModalities: ["text"],
      name: "Space Bunny",
      provider: route,
      ...own,
    });
    const adapter: Record<string, unknown> = {
      modelOf: (_snapshot: unknown) => answer(),
      resolveModel: async () => answer(),
    };
    const llm = { adapters: new Map([[route, { adapter }]]) };
    const stop = decoratePlaneAdapters(
      llm as never,
      resolveConfig({ enrichModels: true })
    );
    const resolveModel = adapter.resolveModel as (
      provider: string,
      model: string
    ) => Promise<unknown>;
    // The MODEL id matters: without one the wrapper has no catalog entry to work
    // from and passes the adapter's answer through untouched.
    const resolved = (await resolveModel(route, model)) as Record<
      string,
      unknown
    >;
    stop?.();
    return resolved.baseUrl;
  };

  it("replaces the vendor's retired base with the current family endpoint", async () => {
    // pi's installed catalog still says `https://opencode.ai/zen`, and a profile
    // written for the old gateway says `…/zen/v1`. Both are aliases today, but the
    // per-family address is what the gateway serves, and an anthropic model on a
    // `/zen` base is simply wrong.
    expect(await resolveBase({ baseUrl: "https://opencode.ai/zen" })).toBe(
      "https://opencode.ai/inference/openai/v1"
    );
    expect(await resolveBase({ baseUrl: "https://opencode.ai/zen/v1" })).toBe(
      "https://opencode.ai/inference/openai/v1"
    );
  });

  it("repairs the OTHER plane's retired base too", async () => {
    // The Go plane's old address used to be exempt, because the set was written
    // out by hand and carried only Zen. A profile declaring `…/zen/go/v1` was
    // therefore never repaired, so `endpoint: auto` followed the catalog on one
    // plane and a pre-move address on the other. Measured against the gateway:
    // both families answer a real completion on Go (200 with a session header),
    // so the exemption bought nothing but the drift.
    expect(
      await resolveBase(
        { baseUrl: "https://opencode.ai/zen/go/v1" },
        { model: "deepseek-v4-pro", route: "opencode-go" }
      )
    ).toBe("https://opencode.ai/inference/go/openai/v1");
    // And the repair is still narrow: a proxy is still nobody's business.
    expect(
      await resolveBase(
        { baseUrl: "https://gateway.internal/zen/go/v1" },
        { model: "deepseek-v4-pro", route: "opencode-go" }
      )
    ).toBe("https://gateway.internal/zen/go/v1");
  });

  it("leaves any other endpoint alone", async () => {
    // A deployment pointing this route at its own proxy must not have the
    // endpoint rewritten by a bundled snapshot.
    expect(
      await resolveBase({ baseUrl: "https://gateway.internal/zen/v1" })
    ).toBe("https://gateway.internal/zen/v1");
  });
});
