import { describe, expect, it, vi } from "vitest";

import { decoratePlaneAdapters, resolveConfig } from "./support/src.ts";

const model = "gemini-4-argon-contributor";
const route = "opencode-go-google";

describe("Go Google preparation", () => {
  it("resolves on the bridge before the source adapter and restores the public identity", async () => {
    const originalResolve = vi.fn(() =>
      Promise.reject(new Error("unknown model"))
    );
    const originalPrepare = vi.fn(() =>
      Promise.reject(new Error("unknown model"))
    );
    const source = {
      resolveModel: originalResolve,
      prepareCall: originalPrepare,
    };
    const bridge = {
      resolveModel: vi.fn(async () => ({ provider: route, id: model })),
      prepareCall: vi.fn(async () => ({
        model: { provider: route, id: model },
        token: "prepared",
      })),
    };
    const adapters = new Map([
      ["opencode-go", { adapter: source }],
      [route, { adapter: bridge }],
    ]);
    const stop = decoratePlaneAdapters(
      { adapters } as Parameters<typeof decoratePlaneAdapters>[0],
      resolveConfig()
    );
    try {
      const { signal } = new AbortController();
      expect(
        await Reflect.apply(source.resolveModel, source, [
          "opencode-go",
          model,
          signal,
        ])
      ).toEqual({ provider: "opencode-go", id: model });
      expect(
        await Reflect.apply(source.prepareCall, source, [
          "opencode-go",
          model,
          signal,
        ])
      ).toEqual({
        model: { provider: "opencode-go", id: model },
        token: "prepared",
      });
      expect(bridge.resolveModel).toHaveBeenCalledWith(route, model, signal);
      expect(bridge.prepareCall).toHaveBeenCalledWith(route, model, signal);
      expect(originalResolve).not.toHaveBeenCalled();
      expect(originalPrepare).not.toHaveBeenCalled();
    } finally {
      stop?.();
    }
    expect(source.resolveModel).toBe(originalResolve);
    expect(source.prepareCall).toBe(originalPrepare);
  });

  it.each([undefined, null])(
    "preserves an absent bridge result: %s",
    async (result) => {
      const source = { resolveModel: async () => ({ id: model }) };
      const bridge = { resolveModel: async () => result };
      const adapters = new Map<string, { adapter: Record<string, unknown> }>([
        ["opencode-go", { adapter: source }],
        [route, { adapter: bridge }],
      ]);
      const stop = decoratePlaneAdapters(
        { adapters } as Parameters<typeof decoratePlaneAdapters>[0],
        resolveConfig()
      );
      try {
        expect(
          await Reflect.apply(source.resolveModel, source, [
            "opencode-go",
            model,
          ])
        ).toBe(result);
      } finally {
        stop?.();
      }
    }
  );

  it("honors a protocol override instead of redirecting to Google", async () => {
    const original = vi.fn(async () => ({
      provider: "opencode-go",
      id: model,
    }));
    const source = { resolveModel: original };
    const bridge = { resolveModel: vi.fn() };
    const adapters = new Map<string, { adapter: Record<string, unknown> }>([
      ["opencode-go", { adapter: source }],
      [route, { adapter: bridge }],
    ]);
    const stop = decoratePlaneAdapters(
      { adapters } as Parameters<typeof decoratePlaneAdapters>[0],
      resolveConfig({
        modelRoutes: {
          [model]: { api: "openai-completions" },
        },
      })
    );
    try {
      await Reflect.apply(source.resolveModel, source, ["opencode-go", model]);
      expect(original).toHaveBeenCalledOnce();
      expect(bridge.resolveModel).not.toHaveBeenCalled();
    } finally {
      stop?.();
    }
  });
});
