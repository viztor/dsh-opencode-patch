/**
 * apply (plugin lifecycle), on a real cordis `Context`.
 *
 * Every case mounts the plugin the way the Loader does (`mountPlugin`), drives
 * the stream hook through cordis's own `ctx.waterfall("llm/stream", …)` — the
 * call `LlmRuntime` makes — and tears down through `fiber.dispose()`, so the
 * plugin's effects run and are undone as a deployment runs and undoes them.
 * Only the degraded-composition diagnostics keep a stand-in (`degradedHost`),
 * because a real `Context` registers what it is asked to and always has
 * `plugin`: a `plugin` that registers nothing, with and without `get` (the
 * three unreachable-service diagnostics), and a composition with no `plugin`,
 * or with neither `plugin` nor `provide`.
 *
 * @module test/lifecycle.test
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { Context } from "@deepseek-ai/cordis";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  seedDivergentCatalog,
  ZEN_FREE_PROBE,
} from "./support/catalog-fixture.ts";
import {
  degradedHost,
  disposeMounted,
  mountPlugin,
  until,
} from "./support/composition.ts";
import { offlineFetch } from "./support/offline.ts";
import {
  apply,
  findModelSpecOn,
  getSessionUsage,
  inspectPatch,
  isRecord,
  OPENCODE_GO_CATALOG,
  openCodeSessionIdFor,
  patchFetch,
  resolveConfig,
  STORE_NAMESPACE,
} from "./support/src.ts";
import {
  collectUnknown,
  createMockStream,
  replacementFetch,
  urlOf,
  waitForFileContent,
} from "./test-helpers.ts";

afterEach(async () => {
  // Disposed first: the patch restores the fetch it wrapped. The leak verdict
  // is read BEFORE the stubs are undone, because unstubbing puts the offline
  // fetch back over whatever a case left wrapped around its stub — read after,
  // a case that stubs `fetch` could leak its patch and still pass. The cleanup
  // runs whatever the verdict, and only then is it asserted: a case that
  // leaked its patch fails here, by name, and the cases after it start clean
  // instead of inheriting the leak and being blamed for it.
  let leaked = false;
  let lingering: unknown;
  try {
    await disposeMounted();
    leaked = globalThis.fetch?.name === PATCHED_FETCH;
  } finally {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    delete process.env.OPENCODE_SESSION_ID;
    if (globalThis.fetch !== offlineFetch) {
      lingering = globalThis.fetch;
      globalThis.fetch = offlineFetch;
    }
  }
  expect(leaked, "a mounted plugin left its fetch patch").toBe(false);
  expect(lingering, "a case left a fetch over the offline one").toBeUndefined();
});

/**
 * The name `patchFetch` gives the function it installs, read off the module
 * rather than written out, so renaming it in `src/fetch-patch.ts` cannot
 * quietly turn the leak check above into a no-op.
 */
const PATCHED_FETCH = patchFetch(
  offlineFetch,
  new AsyncLocalStorage(),
  resolveConfig()
).name;

/**
 * The session id a turn with none of its own carries: the derived default of
 * the reserved `"default"` conversation, with no pinned id in the environment
 * (the afterEach clears it).
 */
const DEFAULT_FALLBACK = openCodeSessionIdFor("default");

/** One turn through cordis's own waterfall, as `LlmRuntime` sends it. */
const stream = (
  ctx: Context,
  options: unknown,
  inner: () => unknown
): unknown =>
  (
    ctx as unknown as {
      waterfall: (event: string, ...args: unknown[]) => unknown;
    }
  ).waterfall("llm/stream", options, inner);

/** Drain one turn's stream. */
const drain = (result: unknown): Promise<unknown[]> =>
  collectUnknown(result as AsyncIterable<unknown>);

/**
 * A downstream that yields the turn store it ran under. The plugin's store is
 * an `AsyncLocalStorage` of its own, so the store is read where the fetch
 * patch reads it: through the patched `fetch`, which the turn's request goes
 * out on. The answer echoes the headers the patch put on it.
 *
 * @yields {Record<string, string>} the headers the patched request carried.
 */
const echoTurn = async function* echoTurn() {
  const response = await globalThis.fetch(
    "https://opencode.ai/zen/v1/chat/completions",
    { method: "POST" }
  );
  yield (await response.json()) as Record<string, string>;
};

/** Stub `fetch` with one that echoes the request's headers back. */
const echoHeaders = (): void => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
      Response.json(Object.fromEntries(new Headers(init?.headers)))
    )
  );
};

/** A Host session service answering for the ids it holds. */
const sessionsHolding = (records: Record<string, unknown>) => ({
  get: (id: string): unknown => records[id],
});

describe("apply (plugin lifecycle)", () => {
  it("installs the Settings discovery wrapper in the llm scope by default, and none with enrichModels off", async () => {
    // Three activations, two on one root: their fetch patches nest, so they
    // wrap a stub the case owns (see the usage-service case below).
    vi.stubGlobal("fetch", replacementFetch);
    const original = async () => [];
    const llm = { discoverModels: original, listProviders: () => [] };
    await mountPlugin({ llm });
    const wrapped = (): unknown =>
      Reflect.getOwnPropertyDescriptor(llm, "discoverModels")?.value;
    await until(() => wrapped() !== original, "the llm scope wraps discovery");
    expect(inspectPatch(wrapped(), "discoverModels")?.[0]).toMatchObject({
      id: "dsh-opencode-patch/model-discovery",
      live: true,
    });

    // The off composition's llm scope runs too, and wraps nothing: a sibling
    // mounted after it on the same service settles first, so the off scope has
    // had every chance to install by then.
    const offLlm = { discoverModels: original, listProviders: () => [] };
    const off = await mountPlugin({
      config: { enrichModels: false },
      llm: offLlm,
    });
    await mountPlugin({ ctx: off.ctx });
    await until(
      () =>
        Reflect.getOwnPropertyDescriptor(offLlm, "discoverModels")?.value !==
        original,
      "the sibling activation wraps discovery"
    );
    expect(
      inspectPatch(
        Reflect.getOwnPropertyDescriptor(offLlm, "discoverModels")?.value,
        "discoverModels"
      )
    ).toHaveLength(1);
  });

  it("mounts the usage service once per root, so a reload cannot lose it", async () => {
    // Measured on a live host: the plugin is applied more than once (a live
    // reload does it on every patch). The second activation's registration was
    // refused as a duplicate because the first was still alive, and when that
    // first fiber then disposed it took the service with it — leaving NONE, and
    // the Gateway with nothing to expose. The browser console said exactly that:
    //   "the usage meter is not rendering: no usage service:
    //    remote.opencodeGoUsage.read is missing"
    //
    // The reproduction, on real cordis: apply, apply again on the same root,
    // dispose the first. On the root, once per process, the service survives.
    vi.stubGlobal("fetch", replacementFetch);
    const { ctx, fiber: first } = await mountPlugin({
      config: { usageEnabled: true },
    });
    const { fiber: second } = await mountPlugin({
      config: { usageEnabled: true },
      ctx,
    });
    await first.dispose();
    const usage = ctx.get("opencodeGoUsage" as never) as
      | { read?: unknown }
      | undefined;
    expect(usage, "the reload lost the usage service").toBeDefined();
    expect(typeof usage?.read).toBe("function");
    await second.dispose();

    // KNOWN_DEFECT P6: disposing the first activation while the second's patch
    // is on top skips the first's restore (it restores only while current),
    // and the second then restores to the first's patch — which outlives both.
    // P6 flips this assertion; until then the case owns the stub underneath
    // and removes it, so the leftover cannot reach the next case.
    expect(globalThis.fetch?.name, "KNOWN_DEFECT P6").toBe(PATCHED_FETCH);
    vi.unstubAllGlobals();
  });

  it("the usage service reads the Go usage endpoint of the composition", async () => {
    // The service's base URL is a closure over the composition's config, read
    // per call: with no Go row and no `usageBaseURL` it is the plane's
    // default, and with a `usageBaseURL` it is that base. Each composition
    // mounts on a root of its own, because the service mounts once per root.
    vi.stubEnv("OPENCODE_GO_API_KEY", "sk-go-usage-test");
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        urls.push(urlOf(input));
        return Response.json({});
      })
    );
    const readOn = async (config: Record<string, unknown>): Promise<void> => {
      const { ctx } = await mountPlugin({ config });
      const usage = ctx.get("opencodeGoUsage" as never) as unknown as {
        read: () => Promise<unknown>;
      };
      // The stub answers no usage windows, so the read itself fails; what is
      // asserted is where it went.
      await expect(usage.read()).rejects.toThrow(/usage response/u);
    };

    await readOn({ usageEnabled: true });
    expect(
      urls.some((url) => url.endsWith("/zen/go/v1/usage")),
      urls.join(", ")
    ).toBe(true);

    urls.length = 0;
    await readOn({
      usageBaseURL: "https://relay.example/zen/go/v1",
      usageEnabled: true,
    });
    expect(urls, urls.join(", ")).toContain(
      "https://relay.example/zen/go/v1/usage"
    );
  });

  it("reports WHY the usage service is unreachable, in each of the three ways", async () => {
    // A browser console carried:
    //
    //   the usage meter is not rendering: no usage service:
    //   remote.opencodeGoUsage.read is missing
    //
    // That proves the CLIENT half is fine — the contribution mounts and its
    // descriptor names `service: "opencodeGoUsage"`. What is missing is a Service
    // the Gateway's source-mode discovery can find, and there are three ways that
    // happens with nothing on the client to show it: it never registered, it
    // registered under another key, or it registered as a VALUE (`ctx.provide`)
    // rather than a Service. The three are indistinguishable from outside, so the
    // host now names which one it is. A real `Context` registers the service it
    // is asked to, so the two failures need a composition that does not.
    const messages: string[] = [];
    const logger = {
      info: (...args: unknown[]) => messages.push(args.map(String).join(" ")),
      warn: (...args: unknown[]) => messages.push(args.map(String).join(" ")),
    };
    const applyOn = async (get?: () => unknown): Promise<void> => {
      const host = degradedHost({
        ...(get === undefined ? {} : { get }),
        logger,
        plugin: () => {
          /* the real path; registers nothing here */
        },
      });
      try {
        await apply(host.ctx, { usageEnabled: true });
      } finally {
        host.dispose();
      }
    };

    // 1. Never registered: `ctx.get` answers nothing for the key.
    await applyOn(() => {
      /* an unregistered name */
    });
    expect(
      messages.some(
        (m) => m.includes("did not register") && m.includes("ctx.get")
      )
    ).toBe(true);

    // 1b. A composition with no `get` at all reads the same way: nothing answered.
    messages.length = 0;
    await applyOn();
    expect(
      messages.some(
        (m) => m.includes("did not register") && m.includes("ctx.get")
      )
    ).toBe(true);

    // 2. Registered, but with no `typertRemote` binding — a provided value, which
    //    the Gateway's service scan cannot see.
    messages.length = 0;
    await applyOn(() => ({ read: async () => ({}) }));
    expect(
      messages.some(
        (m) =>
          m.includes("no typertRemote binding") && m.includes("ctx.provide")
      )
    ).toBe(true);

    // 3. Registered and bound — the good case, reported as reachable.
    messages.length = 0;
    const bound = {
      read: async () => ({}),
      typertRemote: {
        namespace: "opencodeGoUsage",
        serviceKey: "opencodeGoUsage",
      },
    };
    await applyOn(() => bound);
    expect(
      messages.some(
        (m) => m.includes("reachable") && m.includes("opencodeGoUsage")
      )
    ).toBe(true);
  });

  it("survives a composition with neither mount path, and reports it (KNOWN_DEFECT P5: the provide fallback never publishes)", async () => {
    // With no `ctx.plugin`, each installer takes the `ctx.provide` fallback —
    // and today that fallback cannot publish anything: it constructs the
    // service first, and a service's constructor registers itself through
    // `ctx.reflect`, which only a real cordis context has (and a real context
    // always has `plugin`). So on this stand-in each service reports, by its
    // own name, that it did not mount, `provide` is never called, and `apply`
    // carries on without throwing. P5 (`installRemoteService`) either drops the
    // provide arm or makes it publish; the empty list below is what it flips.
    const warned: string[] = [];
    const logger = {
      warn: (...args: unknown[]) => warned.push(args.map(String).join(" ")),
    };
    const services = ["opencodeGoUsage", "opencodeModelPurge", STORE_NAMESPACE];
    const provided: string[] = [];
    const withProvide = degradedHost({
      logger,
      provide: (name) => {
        provided.push(name);
      },
    });
    try {
      await expect(
        apply(withProvide.ctx, { usageEnabled: true })
      ).resolves.toBeUndefined();
    } finally {
      withProvide.dispose();
    }
    for (const service of services) {
      expect(warned, service).toContainEqual(
        expect.stringContaining(`${service} did not mount`)
      );
    }
    expect(warned.join(" ")).not.toContain("neither ctx.plugin");
    expect(provided, "KNOWN_DEFECT P5").toEqual([]);

    // Neither `plugin` nor `provide`: the installer says so instead of throwing,
    // which is what keeps one service's absence from taking the rest of `apply`
    // down with it.
    warned.length = 0;
    const neither = degradedHost({ logger });
    try {
      await expect(
        apply(neither.ctx, { usageEnabled: true })
      ).resolves.toBeUndefined();
    } finally {
      neither.dispose();
    }
    for (const service of services) {
      expect(warned, service).toContainEqual(
        expect.stringContaining(
          `${service} did not mount: this composition has neither ctx.plugin nor ctx.provide`
        )
      );
    }
  });

  it("survives a host whose llm service has no discoverModels", async () => {
    // Discovery is optional: an older host must still get the header patch
    // and the stream hook rather than failing to mount. The llm scope runs,
    // so the discovery installer reads this service.
    echoHeaders();
    const llm = { listProviders: () => [] };
    const { ctx } = await mountPlugin({ llm });
    // The stream hook attached: a turn carries its derived session id.
    const [headers] = await drain(
      stream(
        ctx,
        { model: "m", provider: "opencode", sessionId: "older-host" },
        echoTurn
      )
    );
    expect((headers as Record<string, string>)["x-opencode-session"]).toBe(
      openCodeSessionIdFor("older-host")
    );
    // Nothing was installed on a service with no method to wrap.
    expect(Reflect.ownKeys(llm)).toEqual(["listProviders"]);
  });

  it("patches globalThis.fetch and restores it when the fiber disposes", async () => {
    const before = globalThis.fetch;
    const { fiber } = await mountPlugin();
    expect(globalThis.fetch).not.toBe(before);
    await fiber.dispose();
    expect(globalThis.fetch).toBe(before);
  });

  it("disposer does not clobber a replacement fetch", async () => {
    // The case owns the fetch the patch wraps, so removing its stub restores
    // the real one whatever the replacement left behind.
    vi.stubGlobal("fetch", vi.fn(replacementFetch));
    const { fiber } = await mountPlugin();
    globalThis.fetch = replacementFetch;
    await fiber.dispose();
    expect(globalThis.fetch).toBe(replacementFetch);
  });

  it("attaches to llm/stream through cordis's own waterfall and carries the derived session id into the turn", async () => {
    echoHeaders();
    const { ctx } = await mountPlugin();
    const [headers] = await drain(
      stream(
        ctx,
        {
          model: "beam-free",
          provider: "opencode",
          sessionId: "dsh-session-test-888",
        },
        echoTurn
      )
    );
    expect((headers as Record<string, string>)["x-opencode-session"]).toBe(
      openCodeSessionIdFor("dsh-session-test-888")
    );
  });

  it("reads a sessions service it does not inject, through ctx.get", async () => {
    // cordis's own trap: the plugin injects nothing, so `scope.sessions` on its
    // scope throws `cannot get property "sessions" without inject`. `ctx.get`
    // reads the store without consulting `inject`, which is what an optional
    // service needs, so the turn still carries the session's project and parent.
    echoHeaders();
    const { ctx } = await mountPlugin();
    ctx.provide(
      "sessions" as never,
      sessionsHolding({
        "dsh-session-proxy-check": {
          header: { cwd: "/workspace/project", parentSession: "lead" },
        },
      }) as never
    );
    const [headers] = await drain(
      stream(
        ctx,
        {
          model: "beam-free",
          provider: "opencode",
          sessionId: "dsh-session-proxy-check",
        },
        echoTurn
      )
    );
    expect(headers).toMatchObject({
      "x-opencode-parent-session-id": openCodeSessionIdFor("lead"),
      "x-opencode-project": "project",
      "x-opencode-session": openCodeSessionIdFor("dsh-session-proxy-check"),
    });
  });

  it("records dollars from a usage chunk without altering the stream", async () => {
    const { ctx } = await mountPlugin();
    // A paid, priced Go model, so the recorded cost is non-zero. Picked off
    // the shim by the shape the recorder prices by (not flagged free, a
    // non-zero input rate), so a refresh that reprices or retires one id
    // cannot fail it.
    const priced = OPENCODE_GO_CATALOG.find(
      (row) => row.is_free !== true && (row.cost?.input ?? 0) > 0
    );
    if (priced?.cost === undefined) {
      throw new Error("the Go shim carries no paid, priced row");
    }
    const rate = priced.cost.input;
    const model = priced.id;
    const usageChunk = {
      type: "usage",
      usage: {
        inputTokens: 1_000_000,
        outputTokens: 0,
        totalTokens: 1_000_000,
      },
    };
    const down = async function* down() {
      yield "text-delta";
      yield usageChunk;
      yield "finish";
    };
    const result = stream(
      ctx,
      {
        model,
        provider: "opencode-go",
        sessionId: "usage-session",
      },
      () => down()
    );

    // Every chunk survives in order; the observer only watches.
    expect(await drain(result)).toEqual(["text-delta", usageChunk, "finish"]);

    const recorded = getSessionUsage("usage-session");
    expect(recorded?.turns).toBe(1);
    expect(recorded?.inputTokens).toBe(1_000_000);
    expect(recorded?.activeModel).toBe(model);
    // Priced from the catalog's Go rate rather than a hardcoded number: one
    // million input tokens and nothing else cost exactly the per-million rate.
    expect(recorded?.costUsd).toBeCloseTo(rate, 6);
  });

  it("prices a turn at the rate of the plane its route belongs to", async () => {
    // The planes price some shared ids differently. A Go-first lookup billed
    // every Zen turn on those at the Go rate, so each plane is checked here
    // against its own catalog row rather than against a hardcoded number. The
    // id is the seeded probe that is paid on Go and free on Zen by
    // construction, so no vendor refresh can align the two prices.
    const { ctx } = await mountPlugin();
    await seedDivergentCatalog();
    const model = ZEN_FREE_PROBE;
    const go = findModelSpecOn("go", model)?.cost?.input;
    const zen = findModelSpecOn("zen", model)?.cost?.input;
    // The case only means something while the planes disagree.
    expect(go).toBeTypeOf("number");
    expect(zen).toBeTypeOf("number");
    expect(go).not.toBe(zen);

    const runTurn = async (provider: string, sessionId: string) => {
      const down = async function* down() {
        yield {
          type: "usage",
          usage: {
            inputTokens: 1_000_000,
            outputTokens: 0,
            totalTokens: 1_000_000,
          },
        };
      };
      await drain(stream(ctx, { model, provider, sessionId }, () => down()));
      return getSessionUsage(sessionId)?.costUsd;
    };

    expect(await runTurn("opencode-go", "plane-go")).toBeCloseTo(go ?? 0, 6);
    expect(await runTurn("opencode", "plane-zen")).toBeCloseTo(zen ?? 0, 6);
  });

  it("passes non-opencode turns through untouched, and derives a fallback id for an opencode turn without one", async () => {
    echoHeaders();
    const { ctx } = await mountPlugin();
    // The downstream is a stream, which an engaged hook always wraps in a new
    // one: identity is what says the hook stayed out of the turn.
    for (const options of [
      { provider: "deepseek", sessionId: "abc" },
      null,
      "nope",
    ]) {
      const down = createMockStream("x");
      expect(
        stream(ctx, options, () => down),
        JSON.stringify(options)
      ).toBe(down);
    }

    // An opencode turn with no usable session id is not ignored: the hook
    // engages and the request carries the derived default.
    for (const options of [
      { provider: "opencode" },
      { provider: "opencode", sessionId: "" },
    ]) {
      const down = echoTurn();
      const result = stream(ctx, options, () => down);
      expect(result).not.toBe(down);
      const [headers] = await drain(result);
      expect((headers as Record<string, string>)["x-opencode-session"]).toBe(
        DEFAULT_FALLBACK
      );
    }
  });

  it("warns and skips when globalThis.fetch is unavailable", async () => {
    vi.stubGlobal("fetch", null);
    const { ctx, lines } = await mountPlugin();
    expect(
      lines().some((line) => line.includes("globalThis.fetch is unavailable"))
    ).toBe(true);
    // No stream hook either: an engaged hook always wraps a downstream stream
    // in a new one, so the turn's own stream coming back is the proof.
    const down = createMockStream("x");
    expect(
      stream(
        ctx,
        { model: "m", provider: "opencode", sessionId: "no-fetch" },
        () => down
      )
    ).toBe(down);
    expect(globalThis.fetch).toBeNull();
  });

  it("records debug entries to debugFile when configured", async () => {
    const tmpDir = await mkdtemp(path.join(tmpdir(), "dsh-opencode-test-"));
    try {
      const debugFile = path.join(tmpDir, "stream-debug.jsonl");
      const { ctx } = await mountPlugin({ config: { debug: true, debugFile } });
      const result = stream(
        ctx,
        {
          model: "beam-free",
          provider: "opencode",
          sessionId: "session-debug-999",
        },
        () => createMockStream("done")
      );
      expect(await drain(result)).toEqual(["done"]);

      const content = await waitForFileContent(debugFile);
      const [firstLine] = content.trim().split("\n");
      if (firstLine === undefined) {
        throw new Error("debug file is empty");
      }
      const parsed: unknown = JSON.parse(firstLine);
      if (!isRecord(parsed)) {
        throw new Error("debug entry is not an object");
      }
      expect(parsed.header).toBe("x-opencode-session");
      expect(parsed.model).toBe("beam-free");
      expect(parsed.provider).toBe("opencode");
      expect(parsed.session).toBe("session-debug-999");
      expect(parsed.value).toBe(openCodeSessionIdFor("session-debug-999"));
    } finally {
      await rm(tmpDir, { force: true, recursive: true });
    }
  });

  // The debug write is fire-and-forget by design — a request must never wait on
  // the log — so the test polls for the entry. Under full-suite parallelism the
  // append can be starved past the default 5s ceiling, which is a flaky failure
  // rather than a behaviour: the budget is generous, not the polling.
  it("monitors a request that flows through the patched fetch", async () => {
    // The case above drives the stream hook; this one drives the request
    // monitor, whose closure lives in the composition's debugHook and is only
    // called when a request runs through a patch the composition installed.
    // A deployment turns debugging on from the profile, so that wiring — hook
    // created on the fiber, entry written per claimed request — is the
    // behaviour being pinned.
    const tmpDir = await mkdtemp(path.join(tmpdir(), "dsh-opencode-req-"));
    try {
      const debugFile = path.join(tmpDir, "requests.jsonl");
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => Response.json({ ok: true }))
      );
      await mountPlugin({ config: { debug: true, debugFile } });
      const url = "https://opencode.ai/zen/v1/chat/completions";
      const response = await globalThis.fetch(url, {
        body: JSON.stringify({ messages: [] }),
        headers: {},
        method: "POST",
      });
      expect(response.status).toBe(200);

      const content = await waitForFileContent(debugFile, 1, 12_000);
      const entries = content
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as unknown)
        .filter(isRecord);
      const requestEntries = entries.filter((entry) => entry.claimed === true);
      expect(requestEntries).toHaveLength(1);
      const [requestEntry] = requestEntries;
      if (!isRecord(requestEntry)) {
        throw new Error("no request entry in the debug file");
      }
      expect(requestEntry.url).toBe(url);
      expect(requestEntry.plane).toBe("opencode");
      expect(requestEntry.status).toBe(200);
      expect(requestEntry.sessionFormat).toBe(true);
    } finally {
      await rm(tmpDir, { force: true, recursive: true });
    }
  }, 15_000);

  it("keeps session affinity across turns for the same DSH session", async () => {
    const tmpDir = await mkdtemp(path.join(tmpdir(), "dsh-opencode-aff-"));
    try {
      const debugFile = path.join(tmpDir, "affinity.jsonl");
      const { ctx } = await mountPlugin({ config: { debug: true, debugFile } });
      const driveTurn = async (label: string) => {
        const result = stream(
          ctx,
          { model: "m", provider: "opencode", sessionId: "same-dsh-session" },
          () => createMockStream(label)
        );
        await expect(drain(result)).resolves.toEqual([label]);
      };
      await driveTurn("turn-0");
      await driveTurn("turn-1");
      const content = await waitForFileContent(debugFile, 2);
      const values: unknown[] = [];
      for (const line of content.trim().split("\n")) {
        const parsed: unknown = JSON.parse(line);
        if (isRecord(parsed)) {
          values.push(parsed.value);
        }
      }
      expect(values).toHaveLength(2);
      expect(values[0]).toBe(values[1]);
    } finally {
      await rm(tmpDir, { force: true, recursive: true });
    }
  });

  it("captures turn state and wraps streams for auto-review calls where sessionId is omitted", async () => {
    echoHeaders();
    const { ctx } = await mountPlugin();
    const autoReviewOptions = {
      model: "deepseek-v4.1-flash",
      provider: "opencode-go",
    };
    const down = echoTurn();
    const result = stream(ctx, autoReviewOptions, () => down);
    expect(result, "the hook wraps the auto-review turn").not.toBe(down);
    const [headers] = await drain(result);
    // The turn carries the derived default, so the auto-review request keeps
    // affinity with the conversation's fallback rather than going without.
    expect((headers as Record<string, string>)["x-opencode-session"]).toBe(
      DEFAULT_FALLBACK
    );
  });

  it("resolves parent session from options or ctx.sessions for subagents", async () => {
    echoHeaders();
    const { ctx } = await mountPlugin();
    ctx.provide(
      "sessions" as never,
      sessionsHolding({
        "child-subagent-session": {
          header: {
            id: "child-subagent-session",
            parentSession: "root-lead-session",
          },
        },
      }) as never
    );
    const [fromSessions] = await drain(
      stream(
        ctx,
        {
          model: "deepseek-v4.1-flash",
          provider: "opencode-go",
          sessionId: "child-subagent-session",
        },
        echoTurn
      )
    );
    expect(
      (fromSessions as Record<string, string>)["x-opencode-parent-session-id"]
    ).toBe(openCodeSessionIdFor("root-lead-session"));

    // An explicit parent on the options outranks the registry's.
    const [fromOptions] = await drain(
      stream(
        ctx,
        {
          model: "deepseek-v4.1-flash",
          parentSessionId: "explicit-parent",
          provider: "opencode-go",
          sessionId: "child-subagent-session",
        },
        echoTurn
      )
    );
    expect(
      (fromOptions as Record<string, string>)["x-opencode-parent-session-id"]
    ).toBe(openCodeSessionIdFor("explicit-parent"));
  });
});
