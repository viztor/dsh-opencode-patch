/**
 * The picker, assembled the way the Host assembles it.
 *
 * Every other suite tests one decorator. This one runs the decorators TOGETHER and
 * then builds a model list the way `buildModelCatalog` does, because the bugs that
 * cost the most were not in any single decorator — they were in the seam.
 *
 * The Host's shape is copied from
 * `@deepseek-ai/dsh-api-session-controller/lib/types/catalog.js`, which is not a
 * dependency of this package, so it is reproduced rather than imported:
 *
 * ```js
 * const providers = ctx.llm.listProviders();
 * const catalog = await Promise.all(providers.map(async (provider) => {
 *   const models = await ctx.llm.listModels(provider.id);
 *   const entries = await Promise.all(models.map(async (model) => {
 *     const resolved = await ctx.llm.resolveModelInfo(provider.id, model.id);
 *     return { id: model.id, name: model.name, reasoning: resolved.reasoning };
 *   }));
 *   return { kind: 'group', group: {...}, entries };
 * }));
 * ```
 *
 * **The property under test is that the deployment's list is published exactly.**
 * A revision merged the plane's catalog into `listModels`, which made models the
 * operator never declared appear in the picker — invisible on screen, and it
 * overrode every explicit `models:` array. Nothing here may widen a list.
 *
 * @module test/picker-integration.test
 */

import { describe, expect, it } from "vitest";

import {
  type CordisContext,
  decorateModelInfo,
  hideResponsesRoute,
  resolveConfig,
} from "./support/src.ts";

/** What a deployment declared for its parent route. Three ids, no catalog backfill. */
const DECLARED = [
  { id: "deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash" },
  // A Responses-protocol id and a Messages-protocol id, so the list also proves a
  // declared model keeps working when the plugin has to redirect it.
  { id: "gpt-5.4", name: "GPT-5.4" },
  { id: "claude-haiku-5-5", name: "Claude Haiku 5.5" },
];

/** A catalog id that was NOT declared, used to prove it never appears. */
const UNDECLARED = "claude-sonnet-4-5";

/**
 * A Host `llm` registry shaped like the real one.
 *
 * `resolveModelInfo` refuses any id the adapter does not carry, which is what an
 * adapter backed by an installed catalog does.
 */
const hostRegistry = (declare: readonly { id: string; name: string }[]) => {
  const adapters = new Map([
    ["opencode", { adapter: {} }],
    ["opencode-go", { adapter: {} }],
    ["opencode-responses", { adapter: {} }],
    ["opencode-anthropic", { adapter: {} }],
    ["opencode-google", { adapter: {} }],
    ["opencode-go-responses", { adapter: {} }],
    ["opencode-go-anthropic", { adapter: {} }],
  ]);
  const known = new Set(declare.map((model) => model.id));
  return {
    adapters,
    listConfigurableProviders: () => [{ provider: "opencode" }],
    listModels: async (provider: string) =>
      provider === "opencode" ? declare : [],
    listProviders: () => [...adapters.keys()].map((id) => ({ id, name: id })),
    resolveModelInfo: async (provider: string, model: string) => {
      if (!known.has(model)) {
        throw new Error(`unknown model ${model}`);
      }
      return { id: model, name: model, provider };
    },
  };
};

/** The Host's `buildModelCatalog`, minus the parts this package does not affect. */
const buildModelCatalog = async (llm: {
  listProviders: () => { id: string; name: string }[];
  listModels: (provider: string) => Promise<{ id: string; name: string }[]>;
  resolveModelInfo: (provider: string, model: string) => Promise<unknown>;
}) => {
  const providers = llm.listProviders();
  return Promise.all(
    providers.map(async (provider) => {
      try {
        const models = await llm.listModels(provider.id);
        const entries = await Promise.all(
          models.map(async (model) => {
            const resolved = (await llm.resolveModelInfo(
              provider.id,
              model.id
            )) as { reasoning?: unknown };
            // The Host reads this immediately. An `undefined` answer is a
            // TypeError here, and the catch below turns it into a lost group.
            return {
              id: model.id,
              name: model.name,
              reasoning: resolved.reasoning,
            };
          })
        );
        return { entries, group: provider.id, kind: "group" as const };
      } catch (error) {
        return {
          error: String(error),
          group: provider.id,
          kind: "failure" as const,
        };
      }
    })
  );
};

describe("picker integration: the Host's own assembly", () => {
  const config = resolveConfig({ enrichModels: true });

  it("publishes exactly the declared models, with no failed group", async () => {
    const registry = hostRegistry(DECLARED);
    const ctx = { llm: registry } as never as CordisContext;

    const stopHide = hideResponsesRoute(ctx, config);
    const stopInfo = decorateModelInfo(ctx, config);
    try {
      const groups = await buildModelCatalog(
        registry as never as Parameters<typeof buildModelCatalog>[0]
      );

      // Nothing failed. A `failure` here is the whole route vanishing from the
      // composer, which is what one unresolvable model used to cause.
      expect(groups.filter((group) => group.kind === "failure")).toEqual([]);

      const opencode = groups.find((group) => group.group === "opencode");
      if (opencode?.kind !== "group") {
        throw new TypeError("opencode group missing");
      }
      // **The declaration, verbatim.** Not the catalog, not a superset.
      expect(opencode.entries.map((entry) => entry.id).toSorted()).toEqual(
        DECLARED.map((model) => model.id).toSorted()
      );
      // And a servable, catalogued model the operator did not declare stays out.
      expect(opencode.entries.map((entry) => entry.id)).not.toContain(
        UNDECLARED
      );

      // The internal routes themselves stay out of the picker.
      const seen = groups.map((group) => group.group);
      expect(seen).not.toContain("opencode-responses");
      expect(seen).not.toContain("opencode-anthropic");
      expect(seen).not.toContain("opencode-google");
    } finally {
      stopInfo?.();
      stopHide?.();
    }
  });

  it("keeps a group alive when the adapter cannot resolve a DECLARED model", async () => {
    // The other failure mode at this seam: one throw inside the group's
    // `Promise.all` removes every model on the route, because the Host catches per
    // PROVIDER. A declared model the adapter's installed catalog does not carry is
    // answered from our catalog instead.
    const registry = hostRegistry(DECLARED);
    registry.resolveModelInfo = async () => {
      throw new Error("unknown model");
    };
    const ctx = { llm: registry } as never as CordisContext;

    const stopHide = hideResponsesRoute(ctx, config);
    const stopInfo = decorateModelInfo(ctx, config);
    try {
      const groups = await buildModelCatalog(
        registry as never as Parameters<typeof buildModelCatalog>[0]
      );
      expect(groups.filter((group) => group.kind === "failure")).toEqual([]);

      const opencode = groups.find((group) => group.group === "opencode");
      if (opencode?.kind !== "group") {
        throw new TypeError("opencode group missing");
      }
      // Still the declaration, and every row survived the refusal.
      expect(opencode.entries).toHaveLength(DECLARED.length);
      expect(opencode.entries.map((entry) => entry.id).toSorted()).toEqual(
        DECLARED.map((model) => model.id).toSorted()
      );
    } finally {
      stopInfo?.();
      stopHide?.();
    }
  });
});
