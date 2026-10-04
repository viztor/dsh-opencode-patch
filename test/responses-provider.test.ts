/**
 * `responses-provider.ts` — the plugin registering the Responses route itself,
 * so the user keeps their existing provider and key and changes nothing.
 */

import { describe, expect, it, vi } from "vitest";

import {
  registerResponsesProvider,
  modelsForSdk,
  RESPONSES_SDK,
} from "../src/index.ts";
import type { CordisContext } from "../src/index.ts";

const MUSE = "muse-spark-1.3-contributor-free";

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
});

describe("responses-provider: registration is best-effort", () => {
  it("stands down when the Host has no adapter registry", async () => {
    const ctx = { llm: {}, logger: {} } as unknown as CordisContext;
    await expect(registerResponsesProvider(ctx)).resolves.toBeUndefined();
  });

  it("does not throw when llm-pi-ai cannot be imported", async () => {
    // This repository does not depend on `llm-pi-ai`; a deployment that lacks
    // it must degrade to "a route declared in the profile still works" rather
    // than failing the boot. Every failure is reported, never silent.
    const warn = vi.fn();
    const ctx = {
      llm: { registerAdapter: vi.fn() },
      logger: { warn },
    } as unknown as CordisContext;
    await expect(registerResponsesProvider(ctx)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    expect(ctx.llm?.registerAdapter).not.toHaveBeenCalled();
  });

  it("names the SDK it dispatches on", () => {
    // The constant the whole split hangs off; a typo here would silently stop
    // redirecting every Responses model.
    expect(RESPONSES_SDK).toBe("@ai-sdk/openai");
  });
});
