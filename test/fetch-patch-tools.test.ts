/**
 * patchFetch · the free-tier core-tool fallback, on every body shape.
 *
 * @module test/fetch-patch-tools.test
 */
import { AsyncLocalStorage } from "node:async_hooks";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  freeZenModel,
  GO_FREE_PROBE,
  seedDivergentCatalog,
  ZEN_FREE_PROBE,
} from "./support/catalog-fixture.ts";
import {
  DUMMY_BASH_TOOL,
  DUMMY_READ_TOOL,
  SESSION_HEADER,
  clearCapturedApiKeys,
  findModelSpecOn,
  openCodeSessionIdFor,
  patchFetch,
  resolveConfig,
  type ActiveTurnState,
} from "./support/src.ts";
import {
  createCaptureFetch,
  headerOf,
  parseJsonBody,
  toolNamesOf,
} from "./test-helpers.ts";

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.OPENCODE_API_KEY;
  delete process.env.OPENCODE_GO_API_KEY;
  delete process.env.OPENCODE_SESSION_ID;
  delete process.env.XDG_DATA_HOME;
  clearCapturedApiKeys();
});

describe("patchFetch · core tools", () => {
  it("scopes the core-tool fallback to the configured model marker", async () => {
    const runWith = async (
      modelName: string,
      config: Parameters<typeof resolveConfig>[0]
    ) => {
      const als = new AsyncLocalStorage<ActiveTurnState>();
      const { capture, mockFetch } = createCaptureFetch();
      const patched = patchFetch(mockFetch, als, resolveConfig(config));
      await als.run({ provider: "opencode", value: "ses_marker" }, async () => {
        await patched("https://opencode.ai/zen/v1/responses", {
          body: JSON.stringify({ input: "hi", model: modelName }),
          method: "POST",
        });
      });
      return capture.init?.body;
    };

    // Custom marker: only models carrying it fall back — plus any model the
    // catalog calls free, which bypasses the marker entirely.
    const customHit = await runWith("acct-preview-9", {
      freeModelMarker: "preview",
    });
    expect(toolNamesOf(parseJsonBody(customHit))).toEqual(["read", "bash"]);
    const customCatalogFree = await runWith(freeZenModel("preview"), {
      freeModelMarker: "preview",
    });
    expect(toolNamesOf(parseJsonBody(customCatalogFree))).toEqual([
      "read",
      "bash",
    ]);
    const customMiss = await runWith("gpt-5-paid", {
      freeModelMarker: "preview",
    });
    expect(toolNamesOf(parseJsonBody(customMiss))).toBeUndefined();

    // `*` applies to every model on the path.
    const allModels = await runWith("gpt-5-paid", { freeModelMarker: "*" });
    expect(toolNamesOf(parseJsonBody(allModels))).toEqual(["read", "bash"]);

    // A blank marker falls back to the default instead of disabling injection.
    // The id is one no shim carries but that holds the default marker, so only
    // the fallback can inject (a catalog-free id would inject regardless), and
    // an uncatalogued id without it stays bare, so the default is "free", not
    // "*".
    const uncatalogued = "acct-preview-free";
    expect(findModelSpecOn("zen", uncatalogued)).toBeUndefined();
    const blank = await runWith(uncatalogued, { freeModelMarker: "" });
    expect(toolNamesOf(parseJsonBody(blank))).toEqual(["read", "bash"]);
    const blankMiss = await runWith("gpt-5-paid", { freeModelMarker: "" });
    expect(toolNamesOf(parseJsonBody(blankMiss))).toBeUndefined();
  });

  it("injects read and bash tools for free-tier /responses models", async () => {
    const als = new AsyncLocalStorage<ActiveTurnState>();
    const { capture, mockFetch } = createCaptureFetch();
    const testSession = openCodeSessionIdFor("test-free-turn");
    const patched = patchFetch(mockFetch, als, resolveConfig());

    await als.run({ provider: "opencode", value: testSession }, async () => {
      await patched("https://opencode.ai/zen/v1/responses", {
        body: JSON.stringify({
          input: [{ content: "hi", role: "user" }],
          model: "muse-spark-1.2-contributor-free",
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
    });

    expect(headerOf(capture.init, "content-length")).not.toBeNull();
    expect(typeof capture.init?.body).toBe("string");
    const names = toolNamesOf(parseJsonBody(capture.init?.body));
    expect(names).toEqual([DUMMY_READ_TOOL.name, DUMMY_BASH_TOOL.name]);
  });

  it("classifies a free model by the plane the request is on", async () => {
    // The catalog's free flag is per plane, and the two planes can disagree.
    // The seeded probe is free on Zen and paid on Go, under a marker nothing
    // matches, so only the plane's own row can admit it: a Zen request gains
    // the schemas, the same body on the Go plane is left alone.
    await seedDivergentCatalog();
    const als = new AsyncLocalStorage<ActiveTurnState>();
    const config = resolveConfig({ freeModelMarker: "none-of-these" });
    const send = async (
      provider: string,
      url: string,
      model = ZEN_FREE_PROBE
    ): Promise<unknown> => {
      const { capture, mockFetch } = createCaptureFetch();
      const value = openCodeSessionIdFor(`plane-${provider}`);
      await als.run({ provider, value }, async () => {
        await patchFetch(
          mockFetch,
          als,
          config
        )(url, {
          body: JSON.stringify({ input: "hi", model }),
          headers: { "Content-Type": "application/json" },
          method: "POST",
        });
      });
      return toolNamesOf(parseJsonBody(capture.init?.body));
    };

    expect(
      await send("opencode", "https://opencode.ai/zen/v1/responses")
    ).toEqual(["read", "bash"]);
    expect(
      await send("opencode-go", "https://opencode.ai/zen/go/v1/responses")
    ).toBeUndefined();
    // The reverse probe, so a Go-first lookup is red in both directions.
    expect(
      await send(
        "opencode-go",
        "https://opencode.ai/zen/go/v1/responses",
        GO_FREE_PROBE
      )
    ).toEqual(["read", "bash"]);
    expect(
      await send(
        "opencode",
        "https://opencode.ai/zen/v1/responses",
        GO_FREE_PROBE
      )
    ).toBeUndefined();
  });

  it("skips tool injection for paid models, other paths, and invalid JSON", async () => {
    const als = new AsyncLocalStorage<ActiveTurnState>();
    const testSession = openCodeSessionIdFor("skip-cases");
    const run = async (url: string, body: string) => {
      const { capture, mockFetch } = createCaptureFetch();
      await als.run({ provider: "opencode", value: testSession }, async () => {
        await patchFetch(
          mockFetch,
          als,
          resolveConfig()
        )(url, {
          body,
          headers: { "Content-Type": "application/json" },
          method: "POST",
        });
      });
      return capture.init?.body;
    };

    const paid = await run(
      "https://opencode.ai/zen/v1/responses",
      JSON.stringify({ input: "hi", model: "gpt-5-paid" })
    );
    expect(toolNamesOf(parseJsonBody(paid))).toBeUndefined();

    const chat = await run(
      "https://opencode.ai/zen/v1/chat/completions",
      JSON.stringify({ input: "hi", model: "muse-spark-1.2-contributor-free" })
    );
    // The gateway checks read+bash on completions too, so a free completions
    // body gains both; a non-JSON route stays untouched (covered below by the
    // models-listing case in tool-fallback tests).
    expect(toolNamesOf(parseJsonBody(chat))).toEqual(["read", "bash"]);

    const invalid = await run(
      "https://opencode.ai/zen/v1/responses",
      "{not-json"
    );
    expect(invalid).toBe("{not-json");
  });

  it("respects injectCoreTools false", async () => {
    const als = new AsyncLocalStorage<ActiveTurnState>();
    const { capture, mockFetch } = createCaptureFetch();
    const patched = patchFetch(
      mockFetch,
      als,
      resolveConfig({ injectCoreTools: false })
    );
    await als.run({ provider: "opencode", value: "ses_test" }, async () => {
      await patched("https://opencode.ai/zen/v1/responses", {
        body: JSON.stringify({
          input: [{ content: "hi", role: "user" }],
          model: "muse-spark-1.2-contributor-free",
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
    });
    expect(toolNamesOf(parseJsonBody(capture.init?.body))).toBeUndefined();
  });

  it("does not duplicate tools and handles Buffer bodies", async () => {
    const als = new AsyncLocalStorage<ActiveTurnState>();
    const testSession = openCodeSessionIdFor("test-partial-turn");
    const { capture, mockFetch } = createCaptureFetch();
    const patched = patchFetch(mockFetch, als, resolveConfig());

    await als.run({ provider: "opencode", value: testSession }, async () => {
      await patched("https://opencode.ai/zen/v1/responses", {
        body: JSON.stringify({
          input: "run command",
          model: "muse-spark-1.2-contributor-free",
          tools: [{ name: "bash", type: "function" }],
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
    });
    const names = toolNamesOf(parseJsonBody(capture.init?.body));
    expect(names?.filter((n) => n === "bash")).toHaveLength(1);
    expect(names?.filter((n) => n === "read")).toHaveLength(1);

    const { capture: bufCap, mockFetch: bufFetch } = createCaptureFetch();
    const bufPatched = patchFetch(bufFetch, als, resolveConfig());
    const payload = Buffer.from(
      JSON.stringify({
        input: "test buffer",
        model: "muse-spark-1.2-contributor-free",
      }),
      "utf-8"
    );
    await als.run({ provider: "opencode", value: testSession }, async () => {
      await bufPatched("https://opencode.ai/zen/v1/responses", {
        body: payload,
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
    });
    expect(typeof bufCap.init?.body).toBe("string");
    expect(toolNamesOf(parseJsonBody(bufCap.init?.body))).toHaveLength(2);

    const { capture: fullCap, mockFetch: fullFetch } = createCaptureFetch();
    await als.run({ provider: "opencode", value: testSession }, async () => {
      await patchFetch(
        fullFetch,
        als,
        resolveConfig()
      )("https://opencode.ai/zen/v1/responses", {
        body: JSON.stringify({
          input: "hi",
          model: "muse-spark-1.2-contributor-free",
          tools: [
            { name: "read", type: "function" },
            { name: "bash", type: "function" },
          ],
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
    });
    expect(toolNamesOf(parseJsonBody(fullCap.init?.body))).toHaveLength(2);
  });

  it("sends a Request whose body is already spent, unread and unrebuilt", async () => {
    // A caller can hand over a Request it has already read; clone() throws on
    // a disturbed stream, and the interceptor must fall back to sending the
    // request as it stands - not with a guessed body, and not a dropped one.
    const als = new AsyncLocalStorage<ActiveTurnState>();
    const seen: unknown[] = [];
    const entries: Record<string, unknown>[] = [];
    const mockFetch = async (input: RequestInfo | URL): Promise<Response> => {
      seen.push(input);
      return new Response("{}", { status: 200 });
    };
    const patched = patchFetch(mockFetch, als, resolveConfig(), {
      debug: (entry) => {
        entries.push(entry);
      },
    });
    const request = new Request("https://opencode.ai/zen/v1/responses", {
      body: JSON.stringify({ model: "muse-spark-1.2-contributor-free" }),
      method: "POST",
    });
    await request.text();

    await patched(request);

    expect(seen).toHaveLength(1);
    expect(seen[0], "the same object went out, untouched").toBe(request);
    expect(entries.at(-1)?.bodySource).toBe("none");
  });

  it("injects into a Request input by rebuilding it with the same method", async () => {
    // The body source the bug was about: DSH sends inference as
    // fetch(new Request(url, { body })). Injection has to produce a NEW
    // Request - a Request's body cannot be swapped in place - and the patch's
    // headers must still ride along in the init.
    const als = new AsyncLocalStorage<ActiveTurnState>();
    const testSession = openCodeSessionIdFor("request-rebuild");
    const seen: unknown[] = [];
    let sentInit: RequestInit | undefined;
    const entries: Record<string, unknown>[] = [];
    const mockFetch = async (
      input: RequestInfo | URL,
      init?: RequestInit
    ): Promise<Response> => {
      seen.push(input);
      sentInit = init;
      return new Response("{}", { status: 200 });
    };
    const patched = patchFetch(mockFetch, als, resolveConfig(), {
      debug: (entry) => {
        entries.push(entry);
      },
    });
    const request = new Request("https://opencode.ai/zen/v1/responses", {
      body: JSON.stringify({
        input: "hi",
        model: "muse-spark-1.2-contributor-free",
      }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });

    await als.run({ provider: "opencode", value: testSession }, async () => {
      await patched(request);
    });

    expect(seen[0]).not.toBe(request);
    expect(seen[0]).toBeInstanceOf(Request);
    const wire = seen[0] as Request;
    expect(wire.method).toBe("POST");
    expect(wire.headers.get("content-type")).toBe("application/json");
    expect(toolNamesOf(parseJsonBody(await wire.text()))).toEqual([
      DUMMY_READ_TOOL.name,
      DUMMY_BASH_TOOL.name,
    ]);
    expect(headerOf(sentInit, SESSION_HEADER)).toBe(testSession);
    expect(entries.at(-1)?.bodySource).toBe("request");
    expect(entries.at(-1)?.toolNames).toBe(
      [DUMMY_READ_TOOL.name, DUMMY_BASH_TOOL.name].join(",")
    );
  });
});
