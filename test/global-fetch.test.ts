/**
 * `host/global-fetch.ts` — the plugin's one write to `globalThis.fetch`, on
 * real cordis contexts.
 *
 * Each activation is a fiber of a real `Context`, so its effect runs and its
 * disposer is cordis's own. The patch each one installs is a tagging wrapper
 * that passes through once its activation is gone, which is what the
 * installer hands it `live` for; a request through the chain reports which
 * live links it went through.
 *
 * @module test/global-fetch.test
 */
import { Context, type Fiber } from "@deepseek-ai/cordis";
import { afterEach, describe, expect, it, vi } from "vitest";

import { offlineFetch } from "./support/offline.ts";
import { type CordisContext, installGlobalFetch } from "./support/src.ts";

/** The links a request went through, outermost first. */
const TRAIL = "x-trail";

/** The stub every case starts from: it answers the trail it was handed. */
const stub = (async (_input: RequestInfo | URL, init?: RequestInit) =>
  new Response(new Headers(init?.headers).get(TRAIL) ?? "")) as typeof fetch;

/** A patch that adds its name to the trail while live, and passes through once not. */
const tagging =
  (name: string) =>
  (original: typeof fetch, live: () => boolean): typeof fetch =>
    (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (!live()) {
        return original(input, init);
      }
      const headers = new Headers(init?.headers);
      headers.set(TRAIL, `${headers.get(TRAIL) ?? ""}${name}`);
      return original(input, { ...init, headers });
    }) as typeof fetch;

/** The trail a request through the current fetch reports. */
const trail = async (): Promise<string> => {
  const response = await globalThis.fetch("http://127.0.0.1:9/");
  return response.text();
};

const fibers: Fiber[] = [];

afterEach(async () => {
  for (const fiber of fibers.splice(0).toReversed()) {
    await fiber.dispose();
  }
  vi.restoreAllMocks();
  globalThis.fetch = offlineFetch;
});

/** One activation on `root`, installing a tagging patch named `name`. */
const activate = async (
  root: Context,
  name: string,
  logs: string[] = []
): Promise<{ fiber: Fiber; inPlace: (() => boolean) | undefined }> => {
  let inPlace: (() => boolean) | undefined;
  const fiber = root.plugin(
    {
      apply: (ctx: unknown) => {
        const context = ctx as CordisContext;
        inPlace = installGlobalFetch(
          {
            effect: context.effect?.bind(context),
            logger: {
              warn: (line: string) => {
                logs.push(line);
              },
            },
          } as CordisContext,
          tagging(name),
          () => {
            logs.push(`announce ${name}`);
          }
        );
      },
      name: `activation-${name}`,
    } as never,
    {} as never
  );
  fibers.push(fiber);
  await fiber.await();
  return { fiber, inPlace };
};

describe("installGlobalFetch", () => {
  it("one activation: wraps the fetch in place, announces, and restores it on dispose", async () => {
    globalThis.fetch = stub;
    const root = new Context();
    const logs: string[] = [];
    const a = await activate(root, "A", logs);
    expect(logs).toEqual(["announce A"]);
    expect(await trail()).toBe("A");
    expect(a.inPlace?.()).toBe(true);
    await a.fiber.dispose();
    expect(globalThis.fetch).toBe(stub);
    expect(a.inPlace?.()).toBe(false);
  });

  it.each([
    ["the earlier first", 0],
    ["the later first", 1],
  ] as const)(
    "apply A, apply B, dispose both (%s) ends at the fetch that was there",
    async (_order, first) => {
      globalThis.fetch = stub;
      const root = new Context();
      const a = await activate(root, "A");
      const b = await activate(root, "B");
      expect(await trail()).toBe("BA");
      const [early, late] = first === 0 ? [a, b] : [b, a];
      await early.fiber.dispose();
      // The remaining activation's patch still runs; the disposed one passes
      // through wherever it sits.
      expect(await trail()).toBe(first === 0 ? "B" : "A");
      expect(late.inPlace?.()).toBe(true);
      await late.fiber.dispose();
      expect(globalThis.fetch).toBe(stub);
    }
  );

  it("three activations, the middle one disposed first and then the latest: the first is current again", async () => {
    globalThis.fetch = stub;
    const root = new Context();
    const a = await activate(root, "A");
    const b = await activate(root, "B");
    const c = await activate(root, "C");
    await b.fiber.dispose();
    expect(await trail()).toBe("CA");
    await c.fiber.dispose();
    expect(await trail()).toBe("A");
    expect(a.inPlace?.()).toBe(true);
    await a.fiber.dispose();
    expect(globalThis.fetch).toBe(stub);
  });

  it("a third party's function on top is left alone on dispose, and still reaches the original through the pass-through link", async () => {
    globalThis.fetch = stub;
    const root = new Context();
    const a = await activate(root, "A");
    const underneath = globalThis.fetch;
    const theirs = vi.fn((input: RequestInfo | URL, init?: RequestInit) =>
      underneath(input, init)
    ) as unknown as typeof fetch;
    globalThis.fetch = theirs;
    expect(a.inPlace?.()).toBe(false);
    await a.fiber.dispose();
    expect(globalThis.fetch).toBe(theirs);
    expect(await trail()).toBe("");
    expect(theirs).toHaveBeenCalledTimes(1);
  });

  it("wraps the fetch in place when the effect runs, not when it was installed", async () => {
    globalThis.fetch = stub;
    const root = new Context();
    const swapped = (async () => new Response("swapped")) as typeof fetch;
    let inPlace: (() => boolean) | undefined;
    const fiber = root.plugin(
      {
        apply: (ctx: unknown) => {
          const context = ctx as CordisContext;
          inPlace = installGlobalFetch(
            {
              effect: (callback: () => unknown, label?: string) => {
                globalThis.fetch = swapped;
                context.effect?.(callback, label);
              },
            } as CordisContext,
            tagging("A"),
            () => {
              // announced
            }
          );
        },
        name: "activation-late",
      } as never,
      {} as never
    );
    fibers.push(fiber);
    await fiber.await();
    expect(await trail()).toBe("swapped");
    expect(inPlace?.()).toBe(true);
    await fiber.dispose();
    expect(globalThis.fetch).toBe(swapped);
  });

  it("installs nothing, and warns, when there is no fetch at install or by effect time", async () => {
    const logs: string[] = [];
    vi.stubGlobal("fetch", undefined);
    const root = new Context();
    const none = await activate(root, "A", logs);
    expect(none.inPlace).toBeUndefined();
    expect(logs).toEqual([
      "[dsh-opencode-patch] globalThis.fetch is unavailable; cannot inject x-opencode-session",
    ]);
    vi.unstubAllGlobals();

    globalThis.fetch = stub;
    const gone: string[] = [];
    const fiber = root.plugin(
      {
        apply: (ctx: unknown) => {
          const context = ctx as CordisContext;
          installGlobalFetch(
            {
              effect: (callback: () => unknown, label?: string) => {
                globalThis.fetch = undefined as unknown as typeof fetch;
                context.effect?.(callback, label);
              },
              logger: {
                warn: (line: string) => {
                  gone.push(line);
                },
              },
            } as CordisContext,
            tagging("B"),
            () => {
              gone.push("announce B");
            }
          );
        },
        name: "activation-gone",
      } as never,
      {} as never
    );
    fibers.push(fiber);
    await fiber.await();
    expect(gone).toEqual([
      "[dsh-opencode-patch] globalThis.fetch is unavailable; cannot inject x-opencode-session",
    ]);
    expect(globalThis.fetch).toBeUndefined();
  });
});
