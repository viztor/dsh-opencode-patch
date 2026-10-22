import { Context } from "@deepseek-ai/cordis";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CordisContext } from "../src/cordis-context.ts";
import { inject } from "../src/identity.ts";
import {
  clearCapturedApiKeys,
  recordCapturedApiKey,
} from "../src/key-capture.ts";
import { apply } from "../src/lifecycle.ts";

const credential = ["test", "credential"].join("-");
const planes = ["opencode-go", "opencode"] as const;
const defaultRefs = {
  "opencode-go": "OPENCODE_GO_API_KEY",
  opencode: "OPENCODE_API_KEY",
};
const customRefs = {
  "opencode-go": "ISSUE_103_GO_CREDENTIAL",
  opencode: "ISSUE_103_ZEN_CREDENTIAL",
};
const models = [{ id: "deepseek-v4.1-flash" }, { id: "beam-free" }];
const roots: Context[] = [];

const settle = async (root: Context) => {
  for (const runtime of root.registry.values()) {
    for (const fiber of runtime.fibers) await fiber.await();
  }
};

const credentialsService = (values = new Map<string, string>()) => ({
  values,
  async resolve(ref: string) {
    const value = this.values.get(ref);
    return value === undefined ? undefined : { value };
  },
});

const loaderService = (refs: Record<string, string>) => ({
  refs,
  *entries() {
    yield {
      options: {
        config: {
          providers: Object.fromEntries(
            Object.entries(this.refs).map(([plane, apiKeyEnv]) => [
              plane,
              { apiKeyEnv },
            ])
          ),
        },
      },
    };
  },
});

const mount = async (services: Record<string, unknown> = {}) => {
  const root = new Context();
  roots.push(root);
  const llm = {
    models,
    async listModels(_provider: string) {
      return this.models;
    },
  };
  root.provide("llm", llm as never);
  for (const [name, service] of Object.entries(services)) {
    root.provide(name, service as never);
  }
  const originalListModels = Reflect.get(llm, "listModels");
  const originalFetch = globalThis.fetch;
  const plugin = root.plugin({
    inject,
    apply: (scope: unknown) => {
      apply(scope as CordisContext, {
        enrichModels: false,
        usageEnabled: false,
      });
    },
  });
  await plugin.await();
  await settle(root);
  expect(Reflect.get(llm, "listModels")).not.toBe(originalListModels);
  return { root, llm, plugin, originalListModels, originalFetch };
};

const unsetEnv = (ref: string) => {
  // oxlint-disable-next-line unicorn/no-useless-undefined -- Vitest requires undefined to delete the variable.
  vi.stubEnv(ref, undefined);
};

beforeEach(() => {
  clearCapturedApiKeys();
  for (const ref of [
    ...Object.values(defaultRefs),
    ...Object.values(customRefs),
  ]) {
    unsetEnv(ref);
  }
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ data: [] }))
  );
  vi.spyOn(console, "info").mockImplementation(() => {});
});

afterEach(async () => {
  try {
    for (const root of roots.splice(0).toReversed()) await root.fiber.dispose();
  } finally {
    clearCapturedApiKeys();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  }
});

describe("apply credential-aware model listing (Issue #103)", () => {
  it.each(planes)(
    "keeps paid models with a stored default %s reference",
    async (plane) => {
      const credentials = credentialsService(
        new Map([[defaultRefs[plane], credential]])
      );
      const resolve = vi.spyOn(credentials, "resolve");
      const { llm } = await mount({ credentials });
      expect(await llm.listModels(plane)).toEqual(models);
      expect(resolve).toHaveBeenCalledWith(defaultRefs[plane]);
    }
  );

  it.each(planes)(
    "inherits only the exact %s plane's custom stored reference",
    async (plane) => {
      const credentials = credentialsService(
        new Map([[customRefs[plane], credential]])
      );
      const resolve = vi.spyOn(credentials, "resolve");
      const loader = loaderService(customRefs);
      const entries = vi.spyOn(loader, "entries");
      const { llm } = await mount({ credentials, loader });
      expect(await llm.listModels(plane)).toEqual(models);
      expect(resolve).toHaveBeenCalledWith(customRefs[plane]);
      expect(entries).toHaveBeenCalled();
      const other = plane === "opencode-go" ? "opencode" : "opencode-go";
      expect(await llm.listModels(other)).toEqual([models[1]]);
    }
  );

  it.each([
    ["missing", undefined],
    ["empty", ""],
    ["whitespace", "   "],
    ["placeholder", "unused"],
    ["anonymous sentinel", "public"],
  ] as const)(
    "offers free models only for a %s stored credential",
    async (_label, value) => {
      const values = new Map<string, string>();
      if (value !== undefined) {
        for (const ref of Object.values(defaultRefs)) values.set(ref, value);
      }
      const { llm } = await mount({ credentials: credentialsService(values) });
      for (const plane of planes) {
        expect(await llm.listModels(plane)).toEqual([models[1]]);
      }
    }
  );

  it("offers free models only when Credentials is absent or throws", async () => {
    for (const services of [
      {},
      {
        credentials: {
          resolve: async () => {
            throw new Error("unavailable");
          },
        },
      },
    ]) {
      const { llm } = await mount(services);
      for (const plane of planes) {
        expect(await llm.listModels(plane)).toEqual([models[1]]);
      }
    }
  });

  it.each(planes)(
    "does not let a stored %s key unlock the other plane",
    async (plane) => {
      const { llm } = await mount({
        credentials: credentialsService(
          new Map([[defaultRefs[plane], credential]])
        ),
      });
      const other = planes.find((candidate) => candidate !== plane)!;
      expect(await llm.listModels(other)).toEqual([models[1]]);
      expect(await llm.listModels(plane)).toEqual(models);
    }
  );

  it.each(planes)(
    "reads added and removed stored %s keys without restarting",
    async (plane) => {
      const credentials = credentialsService();
      const { llm } = await mount({ credentials });
      const listing = Reflect.get(llm, "listModels");
      expect(await llm.listModels(plane)).toEqual([models[1]]);
      credentials.values.set(defaultRefs[plane], credential);
      expect(await llm.listModels(plane)).toEqual(models);
      credentials.values.delete(defaultRefs[plane]);
      expect(await llm.listModels(plane)).toEqual([models[1]]);
      expect(Reflect.get(llm, "listModels")).toBe(listing);
    }
  );

  it.each(planes)(
    "falls back to the custom %s environment reference after stored lookup",
    async (plane) => {
      vi.stubEnv(customRefs[plane], credential);
      const credentials = credentialsService();
      const resolve = vi.spyOn(credentials, "resolve");
      const { llm } = await mount({
        credentials,
        loader: loaderService(customRefs),
      });
      expect(await llm.listModels(plane)).toEqual(models);
      expect(resolve).toHaveBeenCalledWith(customRefs[plane]);
    }
  );

  it.each(planes)(
    "uses custom %s environment references without Credentials",
    async (plane) => {
      vi.stubEnv(customRefs[plane], credential);
      const { llm } = await mount({ loader: loaderService(customRefs) });
      expect(await llm.listModels(plane)).toEqual(models);
    }
  );

  it.each(planes)(
    "preserves built-in environment and captured %s fast paths",
    async (plane) => {
      const credentials = credentialsService();
      const resolve = vi.spyOn(credentials, "resolve");
      vi.stubEnv(defaultRefs[plane], credential);
      const { llm } = await mount({ credentials });
      expect(await llm.listModels(plane)).toEqual(models);
      expect(resolve).not.toHaveBeenCalled();
      unsetEnv(defaultRefs[plane]);
      recordCapturedApiKey(credential, plane);
      expect(await llm.listModels(plane)).toEqual(models);
      expect(resolve).not.toHaveBeenCalled();
    }
  );

  it("activates and clears optional Credentials and loader child scopes independently", async () => {
    const { root, llm, plugin, originalListModels, originalFetch } =
      await mount();
    const listing = Reflect.get(llm, "listModels");
    expect(await llm.listModels("opencode-go")).toEqual([models[1]]);
    const credentials = credentialsService(
      new Map([[customRefs["opencode-go"], credential]])
    );
    const credentialProvider = root.plugin((scope: Context) => {
      scope.provide("credentials", credentials as never);
    });
    await credentialProvider.await();
    await settle(root);
    expect(await llm.listModels("opencode-go")).toEqual([models[1]]);
    const loaderProvider = root.plugin((scope: Context) => {
      scope.provide("loader", loaderService(customRefs) as never);
    });
    await loaderProvider.await();
    await settle(root);
    expect(await llm.listModels("opencode-go")).toEqual(models);
    await loaderProvider.dispose();
    await settle(root);
    expect(await llm.listModels("opencode-go")).toEqual([models[1]]);
    credentials.values.set(defaultRefs["opencode-go"], credential);
    expect(await llm.listModels("opencode-go")).toEqual(models);
    await credentialProvider.dispose();
    await settle(root);
    expect(await llm.listModels("opencode-go")).toEqual([models[1]]);
    expect(Reflect.get(llm, "listModels")).toBe(listing);
    await plugin.dispose();
    expect(Reflect.get(llm, "listModels")).toBe(originalListModels);
    expect(globalThis.fetch).toBe(originalFetch);
  });
});
