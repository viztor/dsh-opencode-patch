import { createRequire } from "node:module";

import { expect, it, vi } from "vitest";

import { hostModulesForTests } from "./support/host.ts";
import {
  attachmentResolvers,
  buildPlaneProvider,
  createPlaneAdapter,
  OPENCODE_FAMILY_API,
  OPENCODE_GO_CATALOG,
  planeAuth,
  planeProfileFor,
} from "./support/src.ts";

/**
 * The plane adapter over the host's own `PiAiAdapter`, serving one Go Gemini
 * model, with the image hooks of `images` — the way the route claim builds it.
 */
const goGeminiAdapter = async (
  images: ReturnType<typeof attachmentResolvers>,
  apiKey: string
) => {
  const source = hostModulesForTests();
  const [piAi, libraries] = await Promise.all([
    source.piAi({}),
    source.libraries(),
  ]);
  if (piAi === undefined || libraries === undefined) {
    throw new Error("no host modules");
  }
  const { profile } = planeProfileFor({
    buildProvider: buildPlaneProvider(libraries),
    catalog: OPENCODE_GO_CATALOG,
    endpoint: "auto",
    entry: { models: [{ id: "gemini-4-argon" }] },
    familyApi: OPENCODE_FAMILY_API.go,
    piModels: libraries.builtinModels("opencode-go"),
    resolveRetryPolicy: libraries.resolveRetryPolicy,
    route: "opencode-go",
  });
  const profiles = new Map([["opencode-go", profile]]);
  // No effort renames: this model's reasoning is not what the case is about.
  const noNames = new Map<string, Readonly<Record<string, string>>>();
  return createPlaneAdapter({
    auth: planeAuth({}, piAi.recordKeyFor, libraries),
    effortNames: (_provider, model) => noNames.get(model),
    modules: { libraries, piAi },
    profiles: () => profiles,
    resolveApiKey: () => Promise.resolve(apiKey),
    resolveAttachments: images.resolveAttachments,
    resolveImageAccess: images.resolveImageAccess,
  }) as unknown as {
    stream: (options: unknown) => AsyncIterable<unknown>;
  };
};

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

it("releases both optional service scopes when the resolvers are disposed", () => {
  // The route claim builds one pair per activation and disposes it in its
  // teardown, whether or not an adapter was ever registered with it.
  const dispose = vi.fn();
  const images = attachmentResolvers({ inject: () => ({ dispose }) });
  expect(dispose).not.toHaveBeenCalled();
  images.dispose();
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

it("streams a durable image through the plane adapter's Go Gemini model", async () => {
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
  const images = attachmentResolvers(ctx);
  const adapter = await goGeminiAdapter(images, "fixture-image-key");
  const original = globalThis.fetch;
  const bodies: Record<string, unknown>[] = [];
  globalThis.fetch = vi.fn(async (_input, init) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    throw new Error("captured image request");
  });
  try {
    for await (const _chunk of adapter.stream({
      provider: "opencode-go",
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
    images.dispose();
    ctx.dispose();
  }
  expect(readImageRequest).toHaveBeenCalledOnce();
  expect(bodies).toHaveLength(1);
  expect(JSON.stringify(bodies[0])).toContain(bytes.toString("base64"));
});
