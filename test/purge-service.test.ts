/**
 * The purge action: it deletes the deployment's own declaration entries, and it
 * says which of the several ways it can refuse happened.
 *
 * The catalog is the only source of "retired": the purge judges by the
 * retired ids its own forced refresh answers (`CatalogRefresh.deprecated`), so
 * each case stubs `fetch` with the registry it means and seeds nothing else.
 */
import { Context } from "@deepseek-ai/cordis";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ModelPurgeService,
  parseModelsDevCatalog,
  purgeEntryConfig,
  refreshCatalog,
  replaceHostModuleSource,
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
    // Not even a no-op write: on the real host one still validates, rewrites
    // the profile document and reconciles.
    expect(editor.edit).not.toHaveBeenCalled();
  });
  it("judges each plane route on its own plane: an id retired on Go only stays declared on Zen", async () => {
    // One id, live on Zen and retired on Go, declared on both routes. The
    // route-to-plane table decides which plane's retirement applies, so a
    // swapped or constant plane fails one way or the other. Go carries a live
    // row beside the retired one: a plane lands only with an active row (L12).
    const split = {
      opencode: {
        models: { "split-probe": { name: "Probe", limit: { context: 1000 } } },
      },
      "opencode-go": {
        models: {
          "go-live": { name: "Live" },
          "split-probe": { status: "deprecated" },
        },
      },
    };
    vi.stubGlobal("fetch", () =>
      Promise.resolve({ json: async () => split, ok: true })
    );
    const editor = editorWith({
      go: [{ id: "split-probe" }],
      zen: [{ id: "split-probe" }],
    });

    const result = await new ModelPurgeService(ctxWith(editor)).purge();

    expect(result.removed).toEqual([
      { id: "split-probe", provider: "opencode-go" },
    ]);
    const written = editor.entry.options.config.providers;
    expect(written.opencode.models).toEqual([{ id: "split-probe" }]);
    expect(written["opencode-go"].models).toEqual([]);
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
    // A made-up id, so a regenerated shim's own retirements cannot touch it.
    const editor = editorWith({ zen: [{ id: "offline-probe-model" }], go: [] });

    const result = await new Fresh(ctxWith(editor)).purge();

    expect(result.catalogRead).toBe(false);
    expect(result.removed).toEqual([]);
  });
  it("a shim that carries retired ids seeds a cold start with them, and an offline purge removes them", async () => {
    // The shipped shim carries no `OPENCODE_DEPRECATED_IDS` until CI
    // regenerates it, so the export is planted here: the runtime reader's
    // export name, `shimState`'s seeding and the offline purge, performed.
    vi.resetModules();
    vi.doMock("../src/catalog-data.ts", async (importOriginal) => ({
      ...(await importOriginal<typeof import("../src/catalog-data.ts")>()),
      OPENCODE_DEPRECATED_IDS: {
        go: ["shim-retired-go"],
        zen: ["shim-retired-zen", 7],
      },
    }));
    try {
      vi.stubGlobal("fetch", () => Promise.reject(new Error("offline")));
      const catalog = await import("../src/models-catalog.ts");
      expect(catalog.shippedDeprecatedIds()).toEqual({
        go: ["shim-retired-go"],
        zen: ["shim-retired-zen"],
      });
      expect(catalog.isDeprecatedModelOn("go", "shim-retired-go")).toBe(true);
      expect(catalog.isDeprecatedModelOn("zen", "shim-retired-zen")).toBe(true);
      expect(catalog.isDeprecatedModelOn("zen", "shim-retired-go")).toBe(false);
      const failed = await catalog.refreshCatalog(undefined, true);
      expect(failed.ok).toBe(false);
      expect(failed.deprecated).toEqual({
        go: ["shim-retired-go"],
        zen: ["shim-retired-zen"],
      });

      const { ModelPurgeService: Fresh } =
        await import("../src/purge-service.ts");
      const editor = editorWith({
        go: [{ id: "shim-retired-go" }, { id: "kept-go" }],
        zen: [{ id: "shim-retired-zen" }],
      });
      const result = await new Fresh(ctxWith(editor)).purge();
      expect(result).toEqual({
        catalogRead: false,
        removed: [
          { id: "shim-retired-zen", provider: "opencode" },
          { id: "shim-retired-go", provider: "opencode-go" },
        ],
      });
      expect(editor.edit).toHaveBeenCalledTimes(1);
      expect(
        editor.entry.options.config.providers["opencode-go"].models
      ).toEqual([{ id: "kept-go" }]);
    } finally {
      vi.doUnmock("../src/catalog-data.ts");
      vi.resetModules();
    }
  });

  it("reports nothing when the edit was rejected", async () => {
    // `configEditor.edit` throws after the change has been computed — "Profile
    // patch must be a YAML sequence" on a damaged document, "Configuration
    // entry is no longer available" after a reload. Pushing into `removed` from
    // inside the callback meant those ids were reported as purged for an edit
    // that never landed.
    answersRegistry();
    // A retired id, so the entry is judged to change and the edit is made:
    // an entry with nothing retired is never edited at all.
    const { entry } = editorWith({
      zen: [{ id: "fledge-alpha-free" }],
      go: [],
    });
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

    // Neither entry is touched: each is judged before its write, so an entry
    // with nothing retired is never rewritten — an unconditional edit would
    // mark every entry dirty on every click.
    expect(edit).toHaveBeenCalledTimes(0);
    expect(JSON.stringify(untouched.options.config)).toBe(before);
  });
});

describe("purge: an entry another plugin owns is left to it (D27)", () => {
  /** An editor whose `edit` applies the change to the entry it is handed. */
  const applyingEditor = (entries: readonly unknown[]) => {
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
    return { edit, entries: () => entries };
  };

  const MARKER = { "x-opencode-plugin": "vendor/1.0.0" } as const;

  it("rewrites the unmarked plane and never the marked one beside it, nor a row in a realm the plugin does not share, nor a reference to a route only they declare", async () => {
    answersRegistry();
    // The user's own row: a marked `opencode` beside an unmarked `opencode-go`.
    const split = {
      options: {
        config: {
          providers: {
            opencode: {
              headers: { ...MARKER },
              models: [{ id: "fledge-alpha-free" }, { id: "live-a" }],
            },
            "opencode-go": {
              models: [{ id: "step-5-preview-free" }, { id: "live-b" }],
            },
          },
        },
        id: "llm-pi-ai",
      },
    };
    // A second pi-ai row whose credentials resolve in another plugin's realm.
    const realmRow = {
      options: {
        config: {
          providers: {
            opencode: { models: [{ id: "fledge-alpha-free" }] },
          },
        },
        id: "llm-pi-ai:vendor",
        isolate: { credentials: "vendor-realm" },
      },
    };
    // References on both routes: `opencode` is declared only by entries the
    // plugin leaves alone, so its references are not the plugin's to judge.
    const subagent = {
      options: {
        config: {
          allowedModels: [
            { model: "fledge-alpha-free", provider: "opencode" },
            { model: "step-5-preview-free", provider: "opencode-go" },
          ],
        },
        id: "subagent",
      },
    };
    const realmBefore = structuredClone(realmRow.options.config);
    const editor = applyingEditor([split, realmRow, subagent]);

    const result = await new ModelPurgeService(ctxWith(editor)).purge();

    expect(result.removed).toEqual([
      { id: "step-5-preview-free", provider: "opencode-go" },
      { id: "step-5-preview-free", provider: "opencode-go", site: "subagent" },
    ]);
    expect(split.options.config.providers.opencode.models).toEqual([
      { id: "fledge-alpha-free" },
      { id: "live-a" },
    ]);
    expect(split.options.config.providers["opencode-go"].models).toEqual([
      { id: "live-b" },
    ]);
    expect(realmRow.options.config).toEqual(realmBefore);
    expect(editor.edit.mock.calls.map(([entry]) => entry)).not.toContain(
      realmRow
    );
    expect(subagent.options.config.allowedModels).toEqual([
      { model: "fledge-alpha-free", provider: "opencode" },
    ]);
  });

  it("refuses, writing nothing, when every plane entry is another plugin's", async () => {
    answersRegistry();
    const marked = {
      options: {
        config: {
          providers: {
            opencode: {
              headers: { "X-OpenCode-Plugin": "vendor/1.0.0" },
              models: [{ id: "fledge-alpha-free" }],
            },
          },
        },
        id: "llm-pi-ai",
      },
    };
    const realmRow = {
      options: {
        config: {
          providers: {
            "opencode-go": { models: [{ id: "step-5-preview-free" }] },
          },
        },
        id: "llm-pi-ai:vendor",
        isolate: { credentials: true },
      },
    };
    const editor = applyingEditor([marked, realmRow]);
    await expect(
      new ModelPurgeService(ctxWith(editor)).purge()
    ).rejects.toMatchObject({ code: "opencode/purge-unavailable" });
    expect(editor.edit).not.toHaveBeenCalled();
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

describe("purge: one edit per entry, judged by its own read", () => {
  /** An editor whose `edit` applies the change to the entry it is handed. */
  const applying = (entries: readonly unknown[]) => {
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
    return { edit, entries: () => entries };
  };

  const twoModelRegistry = () => ({
    opencode: {
      models: {
        "live-free": { name: "Live", limit: { context: 1_000 } },
        "retired-free": { status: "deprecated" },
      },
    },
  });

  it("a retired declaration and two retired references in one entry are one write", async () => {
    vi.stubGlobal("fetch", () =>
      Promise.resolve(Response.json(twoModelRegistry()))
    );
    const entry = {
      options: {
        config: {
          allowedModels: [{ model: "retired-free", provider: "opencode" }],
          providers: {
            opencode: { models: [{ id: "retired-free" }, { id: "live-free" }] },
          },
          summarizationModel: "retired-free",
          summarizationProvider: "opencode",
        },
      },
    };
    const editor = applying([entry]);

    const result = await new ModelPurgeService(ctxWith(editor)).purge();

    expect(editor.edit).toHaveBeenCalledTimes(1);
    expect(result.removed).toEqual([
      { id: "retired-free", provider: "opencode" },
      { id: "retired-free", provider: "opencode", site: "subagent" },
      { id: "retired-free", provider: "opencode", site: "summarizer" },
    ]);
    expect(entry.options.config).toEqual({
      allowedModels: [],
      providers: { opencode: { models: [{ id: "live-free" }] } },
    });
  });

  it("an entry with nothing retired is not edited", async () => {
    vi.stubGlobal("fetch", () =>
      Promise.resolve(Response.json(twoModelRegistry()))
    );
    const editor = applying([
      {
        options: {
          config: {
            providers: { opencode: { models: [{ id: "live-free" }] } },
          },
        },
      },
      {
        options: {
          config: {
            allowedModels: [{ model: "live-free", provider: "opencode" }],
          },
        },
      },
    ]);

    const result = await new ModelPurgeService(ctxWith(editor)).purge();

    expect(editor.edit).not.toHaveBeenCalled();
    expect(result.removed).toEqual([]);
  });

  it("a parse made while the purge runs does not change what it removes", async () => {
    vi.stubGlobal("fetch", () =>
      Promise.resolve(Response.json(twoModelRegistry()))
    );
    const entry = {
      options: {
        config: {
          providers: {
            opencode: { models: [{ id: "retired-free" }, { id: "live-free" }] },
          },
        },
      },
    };
    const editor = applying([entry]);
    const { entries } = editor;
    editor.entries = () => {
      // Any parse — a generator, an e2e file — used to clear the live
      // retirements the purge was about to judge by.
      parseModelsDevCatalog({ opencode: { models: { x: { name: "x" } } } });
      return entries();
    };

    const result = await new ModelPurgeService(ctxWith(editor)).purge();

    expect(result.removed).toEqual([
      { id: "retired-free", provider: "opencode" },
    ]);
    expect(result.catalogRead).toBe(true);
  });

  it("a read that fails is judged by what the process already holds, and says the catalog was not read", async () => {
    await refreshCatalog(
      async () =>
        Response.json({
          opencode: {
            models: { "r-free": { status: "deprecated" }, "z-live": {} },
          },
        }),
      true
    );
    vi.stubGlobal("fetch", () => Promise.reject(new Error("offline")));
    const editor = editorWith({
      zen: [{ id: "r-free" }, { id: "z-live" }],
      go: [],
    });

    const result = await new ModelPurgeService(ctxWith(editor)).purge();

    expect(result.removed).toEqual([{ id: "r-free", provider: "opencode" }]);
    expect(result.catalogRead).toBe(false);
  });
});

describe("purge: an entry that changed between the judgement and its write", () => {
  it("writes what the editor hands the change, and reports only what that removed", async () => {
    vi.stubGlobal("fetch", () =>
      Promise.resolve(
        Response.json({
          opencode: {
            models: {
              "live-free": { name: "Live" },
              "retired-free": { status: "deprecated" },
            },
          },
        })
      )
    );
    const entry = {
      options: {
        config: {
          providers: { opencode: { models: [{ id: "retired-free" }] } },
        },
      },
    };
    // A reload between the pre-check and the write: the config the editor
    // hands the change no longer declares the retired id.
    let written: unknown;
    const edit = vi.fn(
      async (
        _entry: unknown,
        change: (current: Record<string, unknown>) => Record<string, unknown>
      ) => {
        written = change({
          providers: { opencode: { models: [{ id: "live-free" }] } },
        });
      }
    );

    const result = await new ModelPurgeService(
      ctxWith({ edit, entries: () => [entry] })
    ).purge();

    expect(edit).toHaveBeenCalledTimes(1);
    expect(written).toEqual({
      providers: { opencode: { models: [{ id: "live-free" }] } },
    });
    expect(result.removed).toEqual([]);
  });
});

describe("purge: the pure rewrite of one entry (purgeEntryConfig)", () => {
  const retired = (_route: string, id: string): boolean =>
    id === "retired-free";

  it("answers the config itself when nothing is retired", () => {
    const config = {
      allowedModels: [{ model: "live", provider: "opencode" }],
      providers: { opencode: { models: [{ id: "live" }] } },
    };
    const { next, removed } = purgeEntryConfig(config, ["opencode"], retired);
    expect(next).toBe(config);
    expect(removed).toEqual([]);
  });

  it("filters only the routes it owns, declarations before references", () => {
    const config = {
      allowedModels: [{ model: "retired-free", provider: "opencode-go" }],
      providers: {
        opencode: { models: [{ id: "retired-free" }] },
        "opencode-go": {
          api: "x",
          models: ["retired-free", { name: "no id" }, { id: "live" }],
        },
      },
    };
    const { next, removed } = purgeEntryConfig(
      config,
      ["opencode-go"],
      retired
    );
    expect(removed).toEqual([
      { id: "retired-free", provider: "opencode-go" },
      { id: "retired-free", provider: "opencode-go", site: "subagent" },
    ]);
    expect(next).toEqual({
      allowedModels: [],
      providers: {
        opencode: { models: [{ id: "retired-free" }] },
        "opencode-go": {
          api: "x",
          models: [{ name: "no id" }, { id: "live" }],
        },
      },
    });
    // The input is not mutated.
    expect(config.providers["opencode-go"].models).toHaveLength(3);
  });

  it("reads past an owned route whose block is not a record", () => {
    const config = { providers: { opencode: "not a block" } };
    expect(purgeEntryConfig(config, ["opencode"], retired).next).toBe(config);
  });

  it("reads past a provider block with no models and a providers value that is not a dict", () => {
    const bare = { providers: { opencode: { api: "x" } } };
    expect(purgeEntryConfig(bare, ["opencode"], retired).next).toBe(bare);
    const odd = { providers: "nope" };
    expect(purgeEntryConfig(odd, ["opencode"], retired).next).toBe(odd);
  });
});

describe("purge: the ids pi cannot serve (review and removeUnserved)", () => {
  /** The routes the service asked pi's installed catalog for, in order. */
  const asked: string[] = [];

  /**
   * Hand the service a pi whose installed catalog is `models` per route, or
   * none. Each route answers its own list, and a route it does not hold
   * answers none, so a lookup under the wrong key judges every declared id
   * unserved and over-lists.
   */
  const piCatalog = (
    models?: Readonly<Record<string, readonly { id: string; api: string }[]>>
  ): (() => void) => {
    asked.length = 0;
    return replaceHostModuleSource({
      libraries: async () =>
        models === undefined
          ? undefined
          : ({
              builtinModels: (route: string) => {
                asked.push(route);
                return models[route] ?? [];
              },
            } as never),
      piAi: async () => {},
    });
  };

  const PI = {
    opencode: [
      { api: "a", id: "known" },
      { api: "b", id: "other" },
    ],
    "opencode-go": [
      { api: "a", id: "go-known" },
      { api: "b", id: "go-other" },
    ],
  };

  const MARKER = { "x-opencode-plugin": "vendor/1.0.0" } as const;

  /** An editor whose `edit` applies the change to the entry it is handed. */
  const applying = (entries: readonly unknown[]) => {
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
    return { edit, entries: () => entries };
  };

  const declaring = (providers: Record<string, unknown>) => ({
    options: { config: { providers }, id: "llm-pi-ai" },
  });

  it("review lists the declared ids pi cannot serve, per owned route, and writes nothing", async () => {
    const restore = piCatalog(PI);
    const fetchSpy = vi.fn(() => Promise.reject(new Error("no network")));
    vi.stubGlobal("fetch", fetchSpy);
    try {
      const editor = applying([
        declaring({
          opencode: { models: [{ id: "known" }, { id: "gap-1" }] },
          "opencode-go": { models: ["go-known", "gap-2", "known"] },
        }),
        // Another plugin's entry (D27): its ids are not listed.
        declaring({
          opencode: {
            headers: { "x-opencode-plugin": "vendor/1.0.0" },
            models: [{ id: "theirs" }],
          },
        }),
      ]);
      const review = await new ModelPurgeService(ctxWith(editor)).review();
      // Each route judged by its own list: `known` is pi's on `opencode`
      // only, so it is listed on `opencode-go`, and `go-known` is not.
      expect(review).toEqual({
        piRead: true,
        unserved: [
          { id: "gap-1", provider: "opencode" },
          { id: "gap-2", provider: "opencode-go" },
          { id: "known", provider: "opencode-go" },
        ],
      });
      expect(asked).toEqual(["opencode", "opencode-go"]);
      expect(editor.edit).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it("review says when pi's catalog could not be read, and carries the catalog's last error", async () => {
    const restore = piCatalog();
    try {
      vi.stubGlobal("fetch", () => Promise.reject(new Error("offline")));
      await refreshCatalog(undefined, true);
      const editor = applying([
        declaring({ opencode: { models: [{ id: "gap-1" }] } }),
      ]);
      const review = await new ModelPurgeService(ctxWith(editor)).review();
      expect(review.piRead).toBe(false);
      expect(review.unserved).toEqual([]);
      expect(review.catalogError).toContain("offline");
    } finally {
      restore();
    }
  });

  it("review reads a pi whose libraries throw as unread", async () => {
    const restore = replaceHostModuleSource({
      libraries: () => Promise.reject(new Error("no pi here")),
      piAi: async () => {},
    });
    try {
      const editor = applying([
        declaring({ opencode: { models: [{ id: "gap-1" }] } }),
      ]);
      await expect(
        new ModelPurgeService(ctxWith(editor)).review()
      ).resolves.toEqual({ piRead: false, unserved: [] });
    } finally {
      restore();
    }
  });

  it("review answers the catalog's last error when no plane entry is the plugin's, and lists nothing", async () => {
    const restore = piCatalog(PI);
    try {
      vi.stubGlobal("fetch", () => Promise.reject(new Error("offline")));
      await refreshCatalog(undefined, true);
      const profiles: [string, unknown[]][] = [
        ["no plane entry", [{ options: { config: { other: 1 } } }]],
        [
          "only another plugin's",
          [
            declaring({
              opencode: { headers: { ...MARKER }, models: [{ id: "gap-1" }] },
            }),
          ],
        ],
      ];
      for (const [label, entries] of profiles) {
        const editor = applying(entries);
        // oxlint-disable-next-line no-await-in-loop -- one profile at a time.
        const review = await new ModelPurgeService(ctxWith(editor)).review();
        expect(review.piRead, label).toBe(true);
        expect(review.unserved, label).toEqual([]);
        expect(review.catalogError, label).toContain("offline");
        expect(editor.edit, label).not.toHaveBeenCalled();
      }
    } finally {
      restore();
    }
    // The same profile with pi unreadable says so, and still carries the error.
    const unread = piCatalog();
    try {
      const review = await new ModelPurgeService(
        ctxWith(applying([{ options: { config: {} } }]))
      ).review();
      expect(review).toMatchObject({ piRead: false, unserved: [] });
      expect(review.catalogError).toContain("offline");
    } finally {
      unread();
    }
  });

  it("review refuses with no editor, as the purge does", async () => {
    await expect(
      new ModelPurgeService(ctxWith(undefined)).review()
    ).rejects.toMatchObject({ code: "opencode/purge-unavailable" });
  });

  it("removeUnserved removes those ids and references to them, one edit per entry, with no catalog read", async () => {
    const restore = piCatalog(PI);
    const fetchSpy = vi.fn(() => Promise.reject(new Error("no network")));
    vi.stubGlobal("fetch", fetchSpy);
    try {
      const a = declaring({
        opencode: { models: [{ id: "known" }, { id: "gap-1" }] },
      });
      const b = {
        options: {
          config: {
            allowedModels: [
              { model: "gap-1", provider: "opencode" },
              { model: "known", provider: "opencode" },
            ],
          },
        },
      };
      const c = {
        options: {
          config: {
            summarizationModel: "known",
            summarizationProvider: "opencode",
          },
        },
      };
      const cBefore = structuredClone(c.options.config);
      const editor = applying([a, b, c]);

      const result = await new ModelPurgeService(
        ctxWith(editor)
      ).removeUnserved();

      expect(result).toEqual({
        catalogRead: true,
        removed: [
          { id: "gap-1", provider: "opencode" },
          { id: "gap-1", provider: "opencode", site: "subagent" },
        ],
      });
      expect(editor.edit).toHaveBeenCalledTimes(2);
      expect(editor.edit.mock.calls.map(([entry]) => entry)).toEqual([a, b]);
      expect(c.options.config).toEqual(cBefore);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it("removeUnserved judges each entry's declarations by its own block, and review lists an id two entries declare once", async () => {
    const restore = piCatalog(PI);
    try {
      const a = declaring({
        opencode: { models: [{ id: "known" }, { id: "gap-1" }] },
      });
      // A route-level `api`: pi-ai serves every id on it, so it lists none
      // and keeps `gap-1`, which `a` and `c` cannot serve.
      const b = declaring({
        opencode: { api: "openai-completions", models: [{ id: "gap-1" }] },
      });
      const c = declaring({ opencode: { models: ["gap-1"] } });
      // The subagent's reference goes although `b` keeps `gap-1`: three owned
      // entries on one route is a composition the host's registry refuses
      // (DUPLICATE_ADAPTER), so which one serves `opencode` once the plugin
      // is gone depends on apply order, and a reference, which names a route
      // and not an entry, is judged route-wide.
      const subagent = {
        options: {
          config: { allowedModels: [{ model: "gap-1", provider: "opencode" }] },
        },
      };
      const bBefore = structuredClone(b.options.config);
      const editor = applying([a, b, c, subagent]);
      const service = new ModelPurgeService(ctxWith(editor));

      await expect(service.review()).resolves.toEqual({
        piRead: true,
        unserved: [{ id: "gap-1", provider: "opencode" }],
      });

      const result = await service.removeUnserved();

      expect(result).toEqual({
        catalogRead: true,
        removed: [
          { id: "gap-1", provider: "opencode" },
          { id: "gap-1", provider: "opencode" },
          { id: "gap-1", provider: "opencode", site: "subagent" },
        ],
      });
      expect(editor.edit.mock.calls.map(([entry]) => entry)).toEqual([
        a,
        c,
        subagent,
      ]);
      expect(b.options.config).toEqual(bBefore);
      expect(a.options.config.providers).toEqual({
        opencode: { models: [{ id: "known" }] },
      });
    } finally {
      restore();
    }
  });

  it("removeUnserved leaves another plugin's entry and a reference to a route only it declares alone (D27)", async () => {
    const restore = piCatalog(PI);
    try {
      const marked = declaring({
        opencode: { headers: { ...MARKER }, models: [{ id: "gap-1" }] },
      });
      const owned = declaring({ "opencode-go": { models: [{ id: "gap-1" }] } });
      const subagent = {
        options: {
          config: {
            allowedModels: [
              { model: "gap-1", provider: "opencode" },
              { model: "gap-1", provider: "opencode-go" },
            ],
          },
        },
      };
      const markedBefore = structuredClone(marked.options.config);
      const editor = applying([marked, owned, subagent]);

      const result = await new ModelPurgeService(
        ctxWith(editor)
      ).removeUnserved();

      expect(result).toEqual({
        catalogRead: true,
        removed: [
          { id: "gap-1", provider: "opencode-go" },
          { id: "gap-1", provider: "opencode-go", site: "subagent" },
        ],
      });
      expect(marked.options.config).toEqual(markedBefore);
      expect(editor.edit.mock.calls.map(([entry]) => entry)).toEqual([
        owned,
        subagent,
      ]);
      expect(subagent.options.config.allowedModels).toEqual([
        { model: "gap-1", provider: "opencode" },
      ]);
      expect(asked).toEqual(["opencode-go"]);
    } finally {
      restore();
    }
  });

  it("removeUnserved removes nothing when pi's catalog cannot be read", async () => {
    const restore = piCatalog();
    try {
      const editor = applying([
        declaring({ opencode: { models: [{ id: "gap-1" }] } }),
      ]);
      const result = await new ModelPurgeService(
        ctxWith(editor)
      ).removeUnserved();
      expect(result).toEqual({ catalogRead: false, removed: [] });
      expect(editor.edit).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });
});
