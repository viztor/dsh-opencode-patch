/**
 * The purge action: it deletes the deployment's own declaration entries, and it
 * says which of the several ways it can refuse happened.
 *
 * The catalog is the only source of "retired" — `extractSpecs` records a
 * `status: "deprecated"` id and drops it from the active set — so these tests
 * seed the module through the parser rather than inventing a second list.
 */
import { Context } from "@deepseek-ai/cordis";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ModelPurgeService,
  parseModelsDevCatalog,
  stripRetiredReferences,
} from "./support/src.ts";

/** A registry reply with one retired id per plane and one live id beside it. */
const registry = () => ({
  opencode: {
    models: {
      "fledge-alpha-free": { status: "deprecated" },
      "mimo-v2.6-flash-free": { name: "MiMo", limit: { context: 200_000 } },
    },
  },
  "opencode-go": {
    models: {
      "step-5-preview-free": { status: "deprecated" },
      "deepseek-v4.1-flash": { name: "DeepSeek", limit: { context: 200_000 } },
    },
  },
});

/** A fetch that answers the registry, for `refreshCatalog` to land on. */
const answersRegistry = () => {
  vi.stubGlobal("fetch", () =>
    Promise.resolve({ json: async () => registry(), ok: true })
  );
};

/** A config editor holding one entry that declares both opencode routes. */
const editorWith = (models: {
  zen: readonly { id: string }[];
  go: readonly { id: string }[];
}) => {
  const entry = {
    options: {
      config: {
        providers: {
          opencode: { api: "openai-completions", models: [...models.zen] },
          "opencode-go": { api: "openai-completions", models: [...models.go] },
        },
      },
      id: "llm-pi-ai",
    },
  };
  const edit = vi.fn(
    async (
      _entry: unknown,
      change: (current: Record<string, unknown>) => Record<string, unknown>
    ) => {
      const current = (entry.options.config ?? {}) as Record<string, unknown>;
      entry.options.config = change(current) as typeof entry.options.config;
    }
  );
  return { edit, entries: () => [entry], entry };
};

/** A real cordis context, holding the config editor when there is one. */
const ctxWith = (editor: unknown): Context => {
  const ctx = new Context();
  if (editor !== undefined) {
    ctx.provide("configEditor" as never, editor as never);
  }
  return ctx;
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("purge: deleting what the catalog retired", () => {
  it("removes the retired ids and leaves every live one", async () => {
    parseModelsDevCatalog(registry());
    answersRegistry();
    const editor = editorWith({
      zen: [{ id: "fledge-alpha-free" }, { id: "mimo-v2.6-flash-free" }],
      go: [{ id: "step-5-preview-free" }, { id: "deepseek-v4.1-flash" }],
    });

    const result = await new ModelPurgeService(ctxWith(editor)).purge();

    expect(result.removed).toEqual([
      { id: "fledge-alpha-free", provider: "opencode" },
      { id: "step-5-preview-free", provider: "opencode-go" },
    ]);
    const written = editor.entry.options.config.providers;
    expect(written.opencode.models).toEqual([{ id: "mimo-v2.6-flash-free" }]);
    expect(written["opencode-go"].models).toEqual([
      { id: "deepseek-v4.1-flash" },
    ]);
    expect(result.catalogRead).toBe(true);
  });

  it("writes nothing when the deployment declares no retired model", async () => {
    parseModelsDevCatalog(registry());
    answersRegistry();
    const editor = editorWith({
      zen: [{ id: "mimo-v2.6-flash-free" }],
      go: [{ id: "deepseek-v4.1-flash" }],
    });

    const result = await new ModelPurgeService(ctxWith(editor)).purge();

    expect(result.removed).toEqual([]);
    expect(editor.entry.options.config.providers.opencode.models).toEqual([
      { id: "mimo-v2.6-flash-free" },
    ]);
  });
});

describe("purge: the refusals it can report", () => {
  it("refuses when the composition has no config editor", async () => {
    const service = new ModelPurgeService(ctxWith(undefined as never));
    await expect(service.purge()).rejects.toMatchObject({
      code: "opencode/purge-unavailable",
    });
  });

  it("refuses when no entry declares an opencode provider", async () => {
    // `fetch` is stubbed because `purge()` reads the live catalog first: without
    // this the case made a REAL network request, and under a loaded runner it
    // timed out at 5s roughly one run in four. A unit test may not depend on the
    // network for its speed.
    answersRegistry();
    const service = new ModelPurgeService(
      ctxWith({
        edit: vi.fn(),
        entries: () => [{ options: { config: {}, id: "something-else" } }],
      })
    );
    await expect(service.purge()).rejects.toMatchObject({
      code: "opencode/purge-unavailable",
    });
  });

  it("reports a catalog it could not read, instead of 'nothing retired'", async () => {
    // A fresh module has never parsed a registry, so `isCatalogFresh()` is false
    // and the answer must say so — the empty removal list alone cannot.
    vi.resetModules();
    vi.stubGlobal("fetch", () => Promise.reject(new Error("offline")));
    const { ModelPurgeService: Fresh } =
      await import("../src/purge-service.ts");
    const editor = editorWith({
      zen: [{ id: "mimo-v2.6-flash-free" }],
      go: [],
    });

    const result = await new Fresh(ctxWith(editor)).purge();

    expect(result.catalogRead).toBe(false);
    expect(result.removed).toEqual([]);
  });
  it("reports nothing when the edit was rejected", async () => {
    // `configEditor.edit` throws after the change has been computed — "Profile
    // patch must be a YAML sequence" on a damaged document, "Configuration
    // entry is no longer available" after a reload. Pushing into `removed` from
    // inside the callback meant those ids were reported as purged for an edit
    // that never landed.
    answersRegistry();
    const { entry } = editorWith({ zen: [{ id: "ll-alpha-free" }], go: [] });
    const editor = {
      edit: vi.fn(() =>
        Promise.reject(new Error("Profile patch must be a YAML sequence"))
      ),
      entries: () => [entry],
    };
    const service = new ModelPurgeService(
      ctxWith(editor as unknown as Parameters<typeof ctxWith>[0])
    );
    await expect(service.purge()).rejects.toThrow(/YAML sequence/u);
    // The edit was ATTEMPTED (so the decision was made) and then rejected: the
    // ids that decision named must not be reported as purged.
    expect(editor.edit).toHaveBeenCalledTimes(1);
  });

  it("does not inherit an EARLIER refresh's success when this one fails", async () => {
    // The defect this replaces: `catalogRead` read `isCatalogFresh()`, which
    // advances only on success and so stays true for hours. A process that
    // refreshed fine this morning and is offline now reported `catalogRead:
    // true` — telling the card "nothing is deprecated" about a read that never
    // happened. `refreshCatalog` never rejects, so its promise resolving is no
    // evidence either; only the per-attempt flag is.
    vi.resetModules();
    const mod = await import("../src/models-catalog.ts");
    // A successful refresh first...
    vi.stubGlobal("fetch", () => Promise.resolve(Response.json(registry())));
    await mod.refreshCatalog(undefined, true);
    expect(mod.isCatalogFresh()).toBe(true);
    // ...then the network goes away, and a purge must say so.
    vi.stubGlobal("fetch", () => Promise.reject(new Error("offline")));
    const { ModelPurgeService: Live } = await import("../src/purge-service.ts");
    const result = await new Live(
      ctxWith(editorWith({ zen: [{ id: "mimo-v2.6-flash-free" }], go: [] }))
    ).purge();
    expect(result.catalogRead).toBe(false);
  });
});

describe("purge: the shapes a profile row can take", () => {
  it("skips a provider block with no models and a row with no id", async () => {
    parseModelsDevCatalog(registry());
    answersRegistry();
    const entry = {
      options: {
        config: {
          providers: {
            // No `models` array at all: not a declaration this can read.
            opencode: { api: "openai-completions" },
            "opencode-go": {
              models: [
                // A row without an id is left alone rather than dropped.
                { name: "No id" },
                { id: "step-5-preview-free" },
              ],
            },
          },
        },
        id: "llm-pi-ai",
      },
    };
    const editor = {
      edit: vi.fn(
        async (
          _entry: unknown,
          change: (current: Record<string, unknown>) => Record<string, unknown>
        ) => {
          entry.options.config = change(
            entry.options.config as Record<string, unknown>
          ) as typeof entry.options.config;
        }
      ),
      entries: () => [entry],
    };

    const result = await new ModelPurgeService(ctxWith(editor)).purge();

    expect(result.removed).toEqual([
      { id: "step-5-preview-free", provider: "opencode-go" },
    ]);
    expect(entry.options.config.providers["opencode-go"].models).toEqual([
      { name: "No id" },
    ]);
  });

  it("refuses a context that is not an object", () => {
    expect(() => new ModelPurgeService(null)).toThrow(TypeError);
  });
});

describe("purge: the shapes a config editor can take", () => {
  it("refuses an editor that is not one, rather than failing inside it", async () => {
    // `configEditor` is read structurally: any object with `entries` and `edit`.
    // A composition that exposes half of it must be reported as "no editor",
    // which the card can explain, not crash mid-rewrite.
    for (const editor of [
      undefined,
      null,
      "editor",
      {},
      { entries: () => [] },
      { edit: async () => {} },
      { entries: "nope", edit: async () => {} },
    ]) {
      await expect(
        new ModelPurgeService(ctxWith(editor)).purge()
      ).rejects.toMatchObject({ code: "opencode/purge-unavailable" });
    }
  });

  it("skips entries whose options chain is not shaped like a profile row", async () => {
    // Only one entry in a real loader has this shape; the rest must be walked
    // past without throwing. These are the intermediates the filter reads.
    parseModelsDevCatalog(registry());
    answersRegistry();
    const declared = {
      options: {
        config: {
          providers: { opencode: { models: [{ id: "ll-alpha-free" }] } },
        },
        id: "llm-pi-ai",
      },
    };
    const editor = {
      edit: vi.fn(
        async (
          _e: unknown,
          change: (c: Record<string, unknown>) => Record<string, unknown>
        ) => change(declared.options.config as Record<string, unknown>)
      ),
      entries: () => [
        null,
        "string",
        {},
        { options: null },
        { options: { config: null } },
        { options: { config: { providers: null } } },
        { options: { config: { providers: { opencode: "not a block" } } } },
        declared,
      ],
    };
    const result = await new ModelPurgeService(
      ctxWith(editor as unknown as Parameters<typeof ctxWith>[0])
    ).purge();
    // The one well-formed row was still read.
    expect(result.catalogRead).toBe(true);
  });

  it("handles a provider block with no models array", async () => {
    parseModelsDevCatalog(registry());
    answersRegistry();
    const entry = {
      options: {
        config: {
          providers: {
            opencode: { api: "openai-completions" },
            "opencode-go": { models: "not an array" },
          },
        },
        id: "llm-pi-ai",
      },
    };
    const editor = {
      edit: vi.fn(),
      entries: () => [entry],
    };
    const result = await new ModelPurgeService(
      ctxWith(editor as unknown as Parameters<typeof ctxWith>[0])
    ).purge();
    expect(result.removed).toEqual([]);
  });

  it("keeps a model row declared as a bare string", async () => {
    // The profile's rows are objects, but the schema also accepts a bare id.
    // A string row has no `id` field, so the reader must still name it.
    parseModelsDevCatalog(registry());
    answersRegistry();
    const entry = {
      options: {
        config: {
          providers: {
            opencode: { models: ["fledge-alpha-free", { id: "live-id" }] },
          },
        },
        id: "llm-pi-ai",
      },
    };
    const editor = {
      edit: vi.fn(
        async (
          _e: unknown,
          change: (c: Record<string, unknown>) => Record<string, unknown>
        ) => change(entry.options.config as Record<string, unknown>)
      ),
      entries: () => [entry],
    };
    const result = await new ModelPurgeService(
      ctxWith(editor as unknown as Parameters<typeof ctxWith>[0])
    ).purge();
    // A retired bare-string row is removable; a live object row is kept.
    expect(result.removed.map((r) => r.id)).toContain("fledge-alpha-free");
  });
});

describe("purge: references that are not provider declarations", () => {
  /** A catalog where `retired-free` is deprecated on zen and `live-free` is not. */
  /** A fetch that answers with THIS describe's registry, not the file's default. */
  const answers = (payload: unknown) => {
    vi.stubGlobal("fetch", () =>
      Promise.resolve({ json: async () => payload, ok: true })
    );
  };

  const twoModelRegistry = () => ({
    opencode: {
      models: {
        "live-free": { name: "Live", limit: { context: 1_000 } },
        "retired-free": { status: "deprecated" },
      },
    },
  });

  it("drops a subagent entry that names a retired model, and keeps the rest", async () => {
    // The shape that made the button lie: `allowedModels` declares no provider,
    // so the provider sweep never looked at it.
    parseModelsDevCatalog(twoModelRegistry());
    answers(twoModelRegistry());
    const providerEntry = {
      options: {
        config: {
          providers: {
            opencode: { models: [{ id: "retired-free" }, { id: "live-free" }] },
          },
        },
      },
    };
    const subagentEntry = {
      options: {
        config: {
          allowedModels: [
            { model: "retired-free", provider: "opencode" },
            { model: "live-free", provider: "opencode" },
            { model: "something-else", provider: "nvidia" },
          ],
        },
      },
    };
    const edit = vi.fn(
      async (
        entry: unknown,
        change: (current: Record<string, unknown>) => Record<string, unknown>
      ) => {
        const holder = entry as {
          options: { config: Record<string, unknown> };
        };
        holder.options.config = change(holder.options.config);
      }
    );
    const editor = {
      edit,
      entries: () => [providerEntry, subagentEntry],
    };

    const result = await new ModelPurgeService(ctxWith(editor)).purge();

    expect(result.removed).toEqual([
      { id: "retired-free", provider: "opencode" },
      { id: "retired-free", provider: "opencode", site: "subagent" },
    ]);
    const allowed = subagentEntry.options.config.allowedModels as unknown[];
    expect(allowed).toEqual([
      { model: "live-free", provider: "opencode" },
      { model: "something-else", provider: "nvidia" },
    ]);
  });

  it("clears the compaction summariser PAIR when its model was retired", async () => {
    // Leaving `summarizationProvider` behind would ask for a default model on a
    // named route; both keys go so the entry falls back to its own defaults.
    parseModelsDevCatalog(twoModelRegistry());
    answers(twoModelRegistry());
    const providerEntry = {
      options: {
        config: {
          providers: { opencode: { models: [{ id: "live-free" }] } },
        },
      },
    };
    const compactionEntry = {
      options: {
        config: {
          summarizationModel: "retired-free",
          summarizationProvider: "opencode",
          thresholdRatio: 0.8,
        },
      },
    };
    const edit = vi.fn(
      async (
        entry: unknown,
        change: (current: Record<string, unknown>) => Record<string, unknown>
      ) => {
        const holder = entry as {
          options: { config: Record<string, unknown> };
        };
        holder.options.config = change(holder.options.config);
      }
    );
    const editor = { edit, entries: () => [providerEntry, compactionEntry] };

    const result = await new ModelPurgeService(ctxWith(editor)).purge();

    expect(result.removed).toEqual([
      { id: "retired-free", provider: "opencode", site: "summarizer" },
    ]);
    expect(compactionEntry.options.config).toEqual({ thresholdRatio: 0.8 });
  });

  it("does not rewrite an entry with nothing to strip", async () => {
    // An unconditional edit would mark every entry dirty on every click.
    parseModelsDevCatalog(twoModelRegistry());
    answers(twoModelRegistry());
    const providerEntry = {
      options: {
        config: { providers: { opencode: { models: [{ id: "live-free" }] } } },
      },
    };
    const untouched = {
      options: {
        config: {
          allowedModels: [{ model: "live-free", provider: "opencode" }],
          summarizationModel: "live-free",
          summarizationProvider: "opencode",
        },
      },
    };
    const edit = vi.fn(async () => null);
    const editor = { edit, entries: () => [providerEntry, untouched] };

    const before = JSON.stringify(untouched.options.config);

    await new ModelPurgeService(ctxWith(editor)).purge();

    // The provider entry is edited once by the provider sweep (it decides inside
    // the edit). The REFERENCE entry must not be touched at all — an
    // unconditional edit would mark every entry dirty on every click.
    expect(edit).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(untouched.options.config)).toBe(before);
  });
});

describe("purge: the pure reference stripper", () => {
  const retired = (provider: string, id: string): boolean =>
    provider === "opencode" && id === "retired-free";

  it("leaves a config with no references untouched, by identity", () => {
    const config = { other: 1 };
    const { next, removed } = stripRetiredReferences(config, retired);
    expect(next).toBe(config);
    expect(removed).toEqual([]);
  });

  it("ignores malformed allowedModels rows rather than dropping them", () => {
    const config = {
      allowedModels: [null, "x", { model: 42 }, { provider: "opencode" }],
    };
    const { next, removed } = stripRetiredReferences(config, retired);
    expect(next).toBe(config);
    expect(removed).toEqual([]);
  });

  it("strips a retired row and reports where it was", () => {
    const { next, removed } = stripRetiredReferences(
      { allowedModels: [{ model: "retired-free", provider: "opencode" }] },
      retired
    );
    expect(next.allowedModels).toEqual([]);
    expect(removed).toEqual([
      { id: "retired-free", provider: "opencode", site: "subagent" },
    ]);
  });

  it("keeps a summariser whose model is still live", () => {
    const config = {
      summarizationModel: "live-free",
      summarizationProvider: "opencode",
    };
    const { next, removed } = stripRetiredReferences(config, retired);
    expect(next).toBe(config);
    expect(removed).toEqual([]);
  });
});
