import { createRequire } from "node:module";

import { PiAiAdapter } from "@deepseek-ai/dsh-llm-pi-ai";
import { expect, it, vi } from "vitest";

import { attachmentResolvers } from "../src/attachment-services.ts";
import { OPENCODE_GO_CATALOG } from "../src/catalog-data.ts";
import { registerGoogleBridge } from "../src/google-bridge.ts";
import { testPi } from "./google-runtime-fixture.ts";

const scopedServices = (services: Record<string, unknown>) => {
  const cleanups: (() => void)[] = [];
  return {
    inject(names: string[], apply: (ctx: unknown) => void) {
      const local: (() => void)[] = [];
      apply({
        get: (name: string) =>
          names.includes(name) ? services[name] : undefined,
        effect: (factory: () => () => void) => local.push(factory()),
      });
      const dispose = () => {
        for (const cleanup of local.splice(0)) cleanup();
      };
      cleanups.push(dispose);
      return { dispose };
    },
    dispose() {
      for (const cleanup of cleanups.splice(0)) cleanup();
    },
  };
};

it("degrades gracefully when image services or host-path conversion are absent", () => {
  const absent = attachmentResolvers({});
  expect(absent.resolveAttachments()).toBeUndefined();
  expect(absent.resolveImageAccess({}, {})).toBeUndefined();
  absent.dispose();
  for (const imageHostPath of [() => null, () => "/fixture/image.png"]) {
    const store = { imageHostPath };
    const images = attachmentResolvers(
      scopedServices({
        attachments: store,
        fs: { processPathFromHostPath: () => null },
      })
    );
    expect(images.resolveImageAccess(store, {})).toBeUndefined();
    images.dispose();
  }
});

it("releases optional service scopes when adapter registration fails", () => {
  const dispose = vi.fn();
  const ctx = { inject: () => ({ dispose }) };
  expect(() =>
    registerGoogleBridge({
      ctx,
      pi: testPi(),
      host: { PiAiAdapter },
      plane: "opencode-go",
      apiKeyRef: "UNUSED_KEY",
      specs: OPENCODE_GO_CATALOG.filter((spec) => spec.id === "gemini-4-argon"),
      llm: {
        registerAdapter: () => {
          throw new Error("registration failed");
        },
      },
    })
  ).toThrow("registration failed");
  expect(dispose).toHaveBeenCalledTimes(2);
});

it("captures optional attachments through scopes and maps image access through fs", () => {
  const store = { imageHostPath: () => "/fixture/image.png" };
  const ctx = scopedServices({
    attachments: store,
    fs: { processPathFromHostPath: (path: string) => `execution:${path}` },
  });
  const images = attachmentResolvers(ctx);
  expect(images.resolveAttachments()).toBe(store);
  expect(images.resolveImageAccess(store, {})).toEqual({
    readonlyPath: "execution:/fixture/image.png",
  });
  images.dispose();
  expect(images.resolveAttachments()).toBeUndefined();
});

it("uses actual Cordis injection and clears the service on disposal", async () => {
  const require = createRequire(import.meta.url);
  const hostRequire = createRequire(
    require.resolve("@deepseek-ai/dsh-llm-pi-ai")
  );
  const { Context } = hostRequire("@deepseek-ai/cordis");
  const ctx = new Context();
  try {
    const attachments = { imageHostPath: () => null };
    ctx.provide("attachments", attachments);
    const images = attachmentResolvers(ctx);
    for (const runtime of ctx.registry.values()) {
      for (const fiber of runtime.fibers) await fiber.await();
    }
    expect(images.resolveAttachments()).toBe(attachments);
    images.dispose();
    expect(images.resolveAttachments()).toBeUndefined();
  } finally {
    await ctx.fiber.dispose();
  }
});

it("streams a durable image through the actual Go Gemini adapter", async () => {
  const bytes = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6aSAAAAAASUVORK5CYII=",
    "base64"
  );
  const attachment = {
    attachmentId: `sha256:${"a".repeat(64)}`,
    name: "test.png",
    mediaType: "image/png",
    bytes: bytes.length,
    width: 1,
    height: 1,
  };
  const readImageRequest = vi.fn(async () => ({
    attachment,
    data: bytes,
    mediaType: "image/png",
    bytes: bytes.length,
    width: 1,
    height: 1,
    variantId: "fixture-variant",
    depth: "uchar",
    space: "srgb",
    hasAlpha: false,
  }));
  const ctx = scopedServices({
    attachments: { readImageRequest, imageHostPath: () => null },
  });
  let adapter:
    | { stream: (options: unknown) => AsyncIterable<unknown> }
    | undefined;
  const dispose = registerGoogleBridge({
    pi: testPi(),
    ctx,
    host: { PiAiAdapter },
    plane: "opencode-go",
    apiKeyRef: "BRIDGE_IMAGE_KEY",
    specs: OPENCODE_GO_CATALOG.filter((spec) => spec.id === "gemini-4-argon"),
    llm: {
      registerAdapter: (_routes, value) => {
        adapter = value as typeof adapter;
        return () => {};
      },
    },
  });
  const original = globalThis.fetch;
  const bodies: Record<string, unknown>[] = [];
  process.env.BRIDGE_IMAGE_KEY = "fixture-image-key";
  globalThis.fetch = vi.fn(async (_input, init) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    throw new Error("captured image request");
  });
  try {
    for await (const _chunk of adapter!.stream({
      provider: "opencode-go-google",
      model: "gemini-4-argon",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Describe this image" },
            { type: "image", attachment },
          ],
        },
      ],
    })) {
      // The intercepted network request terminates the stream.
    }
  } catch (error) {
    expect(String(error)).toContain("captured image request");
  } finally {
    globalThis.fetch = original;
    delete process.env.BRIDGE_IMAGE_KEY;
    if (typeof dispose === "function") dispose();
    ctx.dispose();
  }
  expect(readImageRequest).toHaveBeenCalledOnce();
  expect(bodies).toHaveLength(1);
  expect(JSON.stringify(bodies[0])).toContain(bytes.toString("base64"));
});
