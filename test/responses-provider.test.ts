/**
 * `responses-provider.ts` — the plugin registering the gateway's non-default
 * planes itself, so the user keeps their existing provider and key.
 */

import { createRequire } from "node:module";

import { describe, expect, it, vi } from "vitest";

import {
  modelsForSdk,
  registerResponsesProvider,
  RESPONSES_SDK,
} from "../src/index.ts";
import type { CordisContext } from "../src/index.ts";

const MUSE = "muse-spark-1.3-contributor-free";

/**
 * Whether the host plugin this module mounts is reachable from here.
 *
 * Resolved rather than imported: the package is deliberately not a dependency
 * (see the module header), so a static import would be a type error and a
 * build-time requirement the plugin must not have.
 */
const hostPluginReachable = ((): boolean => {
  try {
    createRequire(import.meta.url).resolve("@deepseek-ai/dsh-llm-pi-ai");
    return true;
  } catch {
    return false;
  }
})();

describe("responses-provider: the model list", () => {
  it("comes from the catalog, not from a hand-written list", () => {
    // Every model whose provider.npm names the OpenAI SDK is served on
    // /responses, so the route covers all of them. The bundled shim seeds one;
    // a live refresh widens it without a code change.
    const models = modelsForSdk(RESPONSES_SDK);
    expect(models.length).toBeGreaterThan(0);
    expect(models.map((m) => m.id)).toContain(MUSE);
    for (const model of models) {
      expect(model.contextWindow).toBeGreaterThan(0);
      expect(model.maxTokens).toBeGreaterThan(0);
      expect(model.input.length).toBeGreaterThan(0);
    }
  });

  it("lists each model once, even across both planes", () => {
    const ids = modelsForSdk(RESPONSES_SDK).map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("serves nothing for a protocol no model names", () => {
    expect(modelsForSdk("@ai-sdk/does-not-exist")).toEqual([]);
  });
});

describe("responses-provider: registration is best-effort", () => {
  it("stands down when the Host has no adapter registry", async () => {
    const ctx = { llm: {}, logger: {} } as unknown as CordisContext;
    await expect(registerResponsesProvider(ctx)).resolves.toBeUndefined();
  });

  it("does not throw when the host plugin cannot be reached", async () => {
    // `llm-pi-ai` is a profile bundle, so it is not always resolvable from a
    // plugin's own location. A deployment where it is not must degrade to "the
    // route you declared still works", not fail the boot — and must say so at
    // INFO, because that is an expected state rather than a fault.
    const info = vi.fn();
    const ctx = {
      llm: { listProviders: () => [], registerAdapter: vi.fn() },
      logger: { info },
    } as unknown as CordisContext;
    await expect(registerResponsesProvider(ctx)).resolves.toBeUndefined();
    expect(ctx.llm?.registerAdapter).not.toHaveBeenCalled();
    if (!hostPluginReachable) {
      expect(info).toHaveBeenCalled();
    }
  });

  it("defers to routes the profile already declares", async () => {
    const plugin = vi.fn();
    const ctx = {
      isolate: () => ({ plugin }),
      llm: {
        listProviders: () => [
          { id: "opencode" },
          { id: "opencode-responses" },
          { id: "opencode-anthropic" },
        ],
        registerAdapter: vi.fn(),
      },
      logger: {},
    } as unknown as CordisContext;
    await expect(registerResponsesProvider(ctx)).resolves.toBeUndefined();
    expect(plugin).not.toHaveBeenCalled();
  });

  it("names the SDK it dispatches on", () => {
    // The constant the whole split hangs off; a typo here would silently stop
    // redirecting every Responses model.
    expect(RESPONSES_SDK).toBe("@ai-sdk/openai");
  });
});

// The mount itself is only meaningful where the host plugin is reachable, which
// is not the case in this repository: it is a profile bundle, and declaring it
// here drags in ~1000 lockfile lines and a pnpm install failure over ignored
// build scripts. Verified by hand against a real cordis app; see AGENTS.md.
describe.skipIf(!hostPluginReachable)("responses-provider: the mount", () => {
  it("mounts below an isolated authorization scope", async () => {
    // The whole reason this works: `llm-pi-ai` registers an authorization flow
    // per installed catalog provider, and `authorization.registerFlow` throws
    // DUPLICATE_FLOW on a second instance. Its own comment says a composition
    // without that seam "still works" — and cordis's `isolate` creates exactly
    // such a scope, so the inject never resolves.
    const isolated: string[] = [];
    const mounted: unknown[] = [];
    const ctx = {
      isolate: (name: string) => {
        isolated.push(name);
        return {
          plugin: (plugin: unknown, config: unknown) => {
            mounted.push({ plugin, config });
            return { dispose: () => {} };
          },
        };
      },
      llm: { listProviders: () => [], registerAdapter: vi.fn() },
      logger: {},
    } as unknown as CordisContext;

    const stop = await registerResponsesProvider(ctx);

    expect(isolated).toEqual(["authorization"]);
    expect(mounted.length).toBeGreaterThan(0);
    expect(typeof stop).toBe("function");
    stop?.();
  });
});
