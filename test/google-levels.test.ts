import {
  stream as piStream,
  streamSimple as piStreamSimple,
} from "@earendil-works/pi-ai/api/google-generative-ai";
/**
 * The Google protocol's level wrapper, one branch at a time
 * (`src/host/google-levels.ts`, D16).
 *
 * pi 1.1.0 sends Google's discrete `thinkingLevel` only to ids its own pattern
 * recognizes, and a token `thinkingBudget` to every other id — which a model
 * that thinks in levels refuses (measured live on Go gemini-4-argon). The
 * wrapper serves the ids the CATALOG describes by level the way pi serves a
 * level id, and hands every other call to pi untouched.
 *
 * The pieces are pi's own public exports from this repository's install; in
 * the branch cases only `stream` is a recorder, so each reads the options pi's
 * request builder would have been handed. One differential case runs the real
 * pieces end to end against pi's own `streamSimple` as the oracle, so a pi
 * bump that changes the level path fails here. The wire itself is pinned by
 * the mock suite (`test/mock/plane-dispatch.mock.ts`).
 *
 * @module test/google-levels.test
 */
import {
  resolveGoogleThinkingLevel,
  toGoogleSdkThinkingLevel,
  toGoogleThinkingLevel,
  usesGoogleThinkingLevel,
} from "@earendil-works/pi-ai/api/google-shared";
import { lazyStream } from "@earendil-works/pi-ai/api/lazy";
import { buildBaseOptions } from "@earendil-works/pi-ai/api/simple-options";
import { clampThinkingLevel } from "@earendil-works/pi-ai/models";
import { describe, expect, it, vi } from "vitest";

import {
  type GoogleLevelPieces,
  type GoogleLevelSource,
  withCatalogThinkingLevels,
} from "./support/src.ts";

/** A level model the catalog describes and pi's pattern misses. */
const ARGON = {
  api: "google-generative-ai",
  baseUrl: "https://opencode.ai/inference/go/google/v1beta",
  contextWindow: 1_048_576,
  id: "gemini-4-argon",
  maxTokens: 65_536,
  provider: "opencode-go",
  reasoning: true,
  thinkingLevelMap: {
    high: "high",
    low: "low",
    max: null,
    medium: "medium",
    minimal: null,
    off: null,
    xhigh: null,
  },
} as const;

/**
 * The level path's fixture: ARGON under an id no pi pattern can name, so the
 * mechanism cases exercise the wrapper on any pi. Which REAL ids pi's pattern
 * misses is one characterization row below, not a premise of every case.
 */
const LEVEL = { ...ARGON, id: "level-only-model" } as const;

const CONTEXT = {
  messages: [{ content: "hi", role: "user", timestamp: 0 }],
};

/** pi's pieces, with `stream` recording what it is handed. */
const piecesWith = (
  stream: GoogleLevelPieces["stream"]
): GoogleLevelPieces => ({
  buildBaseOptions:
    buildBaseOptions as unknown as GoogleLevelPieces["buildBaseOptions"],
  clampThinkingLevel:
    clampThinkingLevel as unknown as GoogleLevelPieces["clampThinkingLevel"],
  resolveGoogleThinkingLevel:
    resolveGoogleThinkingLevel as unknown as GoogleLevelPieces["resolveGoogleThinkingLevel"],
  stream,
  toGoogleSdkThinkingLevel:
    toGoogleSdkThinkingLevel as unknown as GoogleLevelPieces["toGoogleSdkThinkingLevel"],
  toGoogleThinkingLevel:
    toGoogleThinkingLevel as unknown as GoogleLevelPieces["toGoogleThinkingLevel"],
  usesGoogleThinkingLevel:
    usesGoogleThinkingLevel as unknown as GoogleLevelPieces["usesGoogleThinkingLevel"],
});

/** pi's Google API as a recorder: which entry point answered, with what. */
const fakeApi = () => {
  const calls: { via: string; args: unknown[] }[] = [];
  const api = {
    marker: "kept",
    stream: (...args: unknown[]) => {
      calls.push({ args, via: "stream" });
      return "pi-stream";
    },
    streamSimple: (...args: unknown[]) => {
      calls.push({ args, via: "streamSimple" });
      return "pi-streamSimple";
    },
  };
  return { api, calls };
};

/** A source whose `lazyStream` runs the setup and answers its promise. */
const sourceOf = (
  pieces?: GoogleLevelPieces
): GoogleLevelSource & { setups: number } => {
  const source = {
    lazyStream: (_model: unknown, setup: () => Promise<unknown>) => {
      source.setups += 1;
      return setup();
    },
    load: () => Promise.resolve(pieces),
    setups: 0,
  };
  return source;
};

type Simple = (model: unknown, context: unknown, options?: unknown) => unknown;

const simpleOf = (wrapped: unknown): Simple =>
  (wrapped as { streamSimple: Simple }).streamSimple;

describe("google-levels · what stays pi's", () => {
  it("answers the api itself without a source, an empty set, or no streamSimple", () => {
    const { api } = fakeApi();
    const source = sourceOf(piecesWith(vi.fn()));
    expect(withCatalogThinkingLevels(api, new Set([ARGON.id]))).toBe(api);
    expect(withCatalogThinkingLevels(api, new Set(), source)).toBe(api);
    const noSimple = { stream: api.stream };
    expect(
      withCatalogThinkingLevels(noSimple, new Set([ARGON.id]), source)
    ).toBe(noSimple);
    expect(
      withCatalogThinkingLevels(undefined, new Set([ARGON.id]), source)
    ).toBeUndefined();
  });

  it("keeps every other member, and hands any other id to pi's streamSimple with the same arguments, synchronously", () => {
    const { api, calls } = fakeApi();
    const source = sourceOf(piecesWith(vi.fn()));
    const wrapped = withCatalogThinkingLevels(
      api,
      new Set([ARGON.id]),
      source
    ) as typeof api;
    expect(wrapped).not.toBe(api);
    expect(wrapped.stream).toBe(api.stream);
    expect(wrapped.marker).toBe("kept");
    const other = { ...ARGON, id: "gemini-2.5-pro" };
    const options = { apiKey: "k", reasoning: "high" };
    expect(simpleOf(wrapped)(other, CONTEXT, options)).toBe("pi-streamSimple");
    // A model that is not a record, or does not reason, is pi's too.
    expect(simpleOf(wrapped)(undefined, CONTEXT, options)).toBe(
      "pi-streamSimple"
    );
    expect(
      simpleOf(wrapped)({ ...ARGON, reasoning: false }, CONTEXT, options)
    ).toBe("pi-streamSimple");
    expect(calls.map((call) => call.args[0])).toEqual([
      other,
      undefined,
      { ...ARGON, reasoning: false },
    ]);
    expect(calls[0]?.args).toEqual([other, CONTEXT, options]);
    expect(calls[0]?.args[2]).toBe(options);
    expect(source.setups).toBe(0);
  });

  it("hands a listed id pi's own pattern already serves by level back to pi", async () => {
    const stream = vi.fn();
    const { api, calls } = fakeApi();
    const flash = { ...ARGON, id: "gemini-3-flash" };
    const source = sourceOf(piecesWith(stream));
    const wrapped = withCatalogThinkingLevels(api, new Set([flash.id]), source);
    const options = { apiKey: "k" };
    expect(await simpleOf(wrapped)(flash, CONTEXT, options)).toBe(
      "pi-streamSimple"
    );
    expect(calls).toEqual([
      { args: [flash, CONTEXT, options], via: "streamSimple" },
    ]);
    expect(stream).not.toHaveBeenCalled();
  });

  it("hands a listed id to pi when the host's pi lacks the level pieces", async () => {
    const { api, calls } = fakeApi();
    const wrapped = withCatalogThinkingLevels(
      api,
      new Set([ARGON.id]),
      sourceOf()
    );
    expect(await simpleOf(wrapped)(ARGON, CONTEXT, { apiKey: "k" })).toBe(
      "pi-streamSimple"
    );
    expect(calls.map((call) => call.via)).toEqual(["streamSimple"]);
  });
});

describe("google-levels · characterization of the installed pi", () => {
  it("pi 1.1.0's pattern misses gemini-4-argon (the live case), and the fixture id on any pi", () => {
    // The row a pi bump flips: once pi's own pattern names argon, the wrapper
    // hands it back to pi and serves no current catalog id. The mechanism
    // cases below run on `level-only-model` and stay green either way.
    expect(usesGoogleThinkingLevel({ id: ARGON.id } as never)).toBe(false);
    expect(usesGoogleThinkingLevel({ id: LEVEL.id } as never)).toBe(false);
    expect(usesGoogleThinkingLevel({ id: "gemini-3-flash" } as never)).toBe(
      true
    );
  });
});

describe("google-levels · a catalog level model, the way pi serves a level model", () => {
  /** One call through the wrapper; answers the options `stream` was handed. */
  const optionsFor = async (
    model: Record<string, unknown>,
    options: Record<string, unknown> | undefined
  ): Promise<Record<string, unknown>> => {
    const stream = vi.fn(() => "level-stream");
    const { api, calls } = fakeApi();
    const wrapped = withCatalogThinkingLevels(
      api,
      new Set([String(model.id)]),
      sourceOf(piecesWith(stream as unknown as GoogleLevelPieces["stream"]))
    );
    expect(await simpleOf(wrapped)(model, CONTEXT, options)).toBe(
      "level-stream"
    );
    expect(calls).toEqual([]);
    expect(stream).toHaveBeenCalledTimes(1);
    const [streamed, context, handed] = stream.mock.calls[0] as unknown as [
      unknown,
      unknown,
      Record<string, unknown>,
    ];
    expect(streamed).toBe(model);
    expect(context).toBe(CONTEXT);
    return handed;
  };

  it("a chosen level is sent as that level, clamped to what the model offers, with pi's base options", async () => {
    const { signal } = new AbortController();
    const high = await optionsFor(LEVEL, {
      apiKey: "k",
      maxTokens: 1000,
      reasoning: "high",
      signal,
      toolChoice: "auto",
    });
    expect(high).toMatchObject({
      apiKey: "k",
      maxTokens: 1000,
      signal,
      thinking: { enabled: true, level: "HIGH" },
      toolChoice: "auto",
    });
    expect(high).toEqual({
      ...buildBaseOptions(
        LEVEL as never,
        CONTEXT as never,
        { apiKey: "k", maxTokens: 1000, reasoning: "high", signal } as never,
        "k"
      ),
      thinking: { enabled: true, level: "HIGH" },
      toolChoice: "auto",
    });
    const xhigh = await optionsFor(LEVEL, { apiKey: "k", reasoning: "xhigh" });
    expect(xhigh.thinking).toEqual({ enabled: true, level: "HIGH" });
    const minimal = await optionsFor(LEVEL, {
      apiKey: "k",
      reasoning: "minimal",
    });
    expect(minimal.thinking).toEqual({ enabled: true, level: "LOW" });
  });

  it("no level chosen sends the level pi falls back to, as pi's disabled config for a level model, before the caller's onPayload", async () => {
    // An Off the model does not offer clamps to its lowest level, as pi's
    // own level path clamps it.
    const off = await optionsFor(LEVEL, { apiKey: "k", reasoning: "off" });
    expect(off.thinking).toEqual({ enabled: true, level: "LOW" });
    for (const reasoning of [undefined, ""]) {
      const seen: unknown[] = [];
      const handed = await optionsFor(LEVEL, {
        apiKey: "k",
        onPayload: (params: unknown) => {
          seen.push(params);
        },
        ...(reasoning === undefined ? {} : { reasoning }),
      });
      expect(handed.thinking).toEqual({ enabled: false });
      const onPayload = handed.onPayload as (
        params: unknown,
        model: unknown
      ) => Promise<unknown>;
      // pi's builder answers `thinkingBudget: 0` for the disabled path of an
      // id its pattern misses; the payload hook replaces it before anything
      // else reads the request.
      const params = {
        config: { temperature: 1, thinkingConfig: { thinkingBudget: 0 } },
        contents: [],
        model: LEVEL.id,
      };
      const sent = await onPayload(params, LEVEL);
      expect(sent).toEqual({
        config: { temperature: 1, thinkingConfig: { thinkingLevel: "LOW" } },
        contents: [],
        model: LEVEL.id,
      });
      expect(seen).toEqual([sent]);
      expect(params.config.thinkingConfig).toEqual({ thinkingBudget: 0 });
    }
  });

  it("the caller's onPayload still has the last word, and a hook without a caller answers the rewrite", async () => {
    const replaced = { replaced: true };
    const handed = await optionsFor(LEVEL, {
      apiKey: "k",
      onPayload: () => Promise.resolve(replaced),
    });
    const hook = handed.onPayload as (
      params: unknown,
      model: unknown
    ) => Promise<unknown>;
    expect(await hook({ config: {} }, LEVEL)).toBe(replaced);
    const bareOptions = await optionsFor(LEVEL, { apiKey: "k" });
    const bare = bareOptions.onPayload as (
      params: unknown,
      model: unknown
    ) => Promise<unknown>;
    expect(await bare({ config: { thinkingConfig: {} } }, LEVEL)).toEqual({
      config: { thinkingConfig: { thinkingLevel: "LOW" } },
    });
    // A payload that is not the shape pi builds passes through untouched.
    expect(await bare("opaque", LEVEL)).toBe("opaque");
    expect(await bare({ config: "opaque" }, LEVEL)).toEqual({
      config: "opaque",
    });
  });

  it("the lowest offered level is the fallback, and a declared Off is pi's disabled config (thinkingBudget: 0 for an id pi's pattern misses)", async () => {
    const minimal = {
      ...LEVEL,
      thinkingLevelMap: { ...LEVEL.thinkingLevelMap, minimal: "minimal" },
    };
    const minimalOptions = await optionsFor(minimal, { apiKey: "k" });
    const hook = minimalOptions.onPayload as (
      params: unknown,
      model: unknown
    ) => Promise<unknown>;
    expect(await hook({ config: {} }, minimal)).toEqual({
      config: { thinkingConfig: { thinkingLevel: "MINIMAL" } },
    });
    // A declared Off (no `off: null`): pi's own disable, and the caller's
    // hook untouched — exactly pi's level path. pi's request builder then
    // sends `thinkingBudget: 0` for an id its pattern misses, which a model
    // that cannot turn thinking off refuses: a profile that declares Off for
    // such a model is a profile error (the mock suite pins the wire).
    const { off: _off, ...offered } = LEVEL.thinkingLevelMap;
    const withOff = { ...LEVEL, thinkingLevelMap: offered };
    const caller = (): undefined => undefined;
    const handed = await optionsFor(withOff, {
      apiKey: "k",
      onPayload: caller,
    });
    expect(handed.thinking).toEqual({ enabled: false });
    expect(handed.onPayload).toBe(caller);
  });

  it("refuses a call without a key the way pi's streamSimple does", async () => {
    const stream = vi.fn();
    const { api } = fakeApi();
    const wrapped = withCatalogThinkingLevels(
      api,
      new Set([LEVEL.id]),
      sourceOf(piecesWith(stream))
    );
    await expect(simpleOf(wrapped)(LEVEL, CONTEXT, {})).rejects.toThrow(
      "No API key for provider: opencode-go"
    );
    await expect(simpleOf(wrapped)(LEVEL, CONTEXT)).rejects.toThrow(
      "No API key for provider: opencode-go"
    );
    expect(stream).not.toHaveBeenCalled();
  });
});

describe("google-levels · the request matches pi's own streamSimple for a level id", () => {
  /**
   * The oracle is pi, not the wrapper's recipe: pi's real `streamSimple` on a
   * level id its pattern names, against the wrapper — real pieces, real
   * `stream`, real `lazyStream` — on the same model under an id the pattern
   * misses. Each pair differs ONLY by id, and neither id of a pair splits
   * pi's other id-keyed rules (the Gemini major version decides strict tool
   * sampling and tool-call ids): `gemini-flash-latest` and `level-only-model`
   * carry no version, `gemini-3-flash` and `gemini-4-argon` are both 3+.
   *
   * This compares what reaches the request body — the params pi's caller
   * hook is handed — and nothing pi's `stream` uses without writing it there
   * (headers, retries, timeouts). The hook throws, so no request is sent.
   */
  const PAIRS = [
    { piId: "gemini-flash-latest", wrappedId: LEVEL.id },
    { piId: "gemini-3-flash", wrappedId: ARGON.id },
  ] as const;

  const DIFF_CONTEXT = {
    messages: [
      {
        content: "Be brief.",
        role: "system",
        timestamp: 0,
        toolsAdded: [
          {
            constrainedSampling: { type: "json_schema" },
            description: "Read a file",
            name: "read",
            parameters: {
              properties: { path: { type: "string" } },
              required: ["path"],
              type: "object",
            },
          },
        ],
      },
      { content: "hi", role: "user", timestamp: 0 },
    ],
  };

  type Run = (
    model: unknown,
    context: unknown,
    options: Record<string, unknown>
  ) => unknown;

  /** The params one call hands the caller's hook, minus the id and signal. */
  const requestOf = async (
    run: Run,
    model: Record<string, unknown>,
    reasoning: string | undefined
  ): Promise<unknown> => {
    const seen: unknown[] = [];
    const events = run(model, DIFF_CONTEXT, {
      apiKey: "k",
      maxTokens: 1000,
      onPayload: (params: unknown) => {
        seen.push(params);
        throw new Error("captured before the wire");
      },
      signal: new AbortController().signal,
      temperature: 0.5,
      toolChoice: "auto",
      ...(reasoning === undefined ? {} : { reasoning }),
    }) as AsyncIterable<{ type: string }>;
    const types: string[] = [];
    for await (const event of events) {
      types.push(event.type);
    }
    expect(types).toEqual(["error"]);
    expect(seen).toHaveLength(1);
    const {
      config,
      model: id,
      ...rest
    } = seen[0] as {
      config: Record<string, unknown>;
      model: unknown;
    };
    expect(id).toBe(model.id);
    const { abortSignal, ...kept } = config;
    expect(abortSignal).toBeInstanceOf(AbortSignal);
    return { ...rest, config: kept };
  };

  const wrapperRun = (model: Record<string, unknown>): Run => {
    const wrapped = withCatalogThinkingLevels(
      { streamSimple: piStreamSimple },
      new Set([String(model.id)]),
      {
        lazyStream: lazyStream as unknown as GoogleLevelSource["lazyStream"],
        load: () =>
          Promise.resolve(
            piecesWith(piStream as unknown as GoogleLevelPieces["stream"])
          ),
      }
    );
    return simpleOf(wrapped) as Run;
  };

  const { off: _off, ...withOffMap } = LEVEL.thinkingLevelMap;
  const MODELS = [
    { name: "levels only", thinkingLevelMap: LEVEL.thinkingLevelMap },
    { name: "a declared Off", thinkingLevelMap: withOffMap },
  ] as const;

  for (const { piId, wrappedId } of PAIRS) {
    for (const { name, thinkingLevelMap } of MODELS) {
      for (const reasoning of ["high", "minimal", "off", undefined]) {
        it(`${wrappedId} as ${piId}, ${name}, reasoning ${String(reasoning)}`, async () => {
          const base = { ...LEVEL, input: ["text"], thinkingLevelMap };
          const piModel = { ...base, id: piId };
          const wrappedModel = { ...base, id: wrappedId };
          // The premise of the pair: pi serves one id by level, not the other.
          expect(usesGoogleThinkingLevel(piModel as never)).toBe(true);
          expect(usesGoogleThinkingLevel(wrappedModel as never)).toBe(false);
          const fromPi = await requestOf(
            piStreamSimple as unknown as Run,
            piModel,
            reasoning
          );
          const fromWrapper = await requestOf(
            wrapperRun(wrappedModel),
            wrappedModel,
            reasoning
          );
          expect(fromWrapper).toEqual(fromPi);
          // And the comparison has teeth: the request carries a thinking
          // config, and pi's own path on the wrapped id would differ.
          expect(fromPi).toHaveProperty("config.thinkingConfig");
          const unwrapped = await requestOf(
            piStreamSimple as unknown as Run,
            wrappedModel,
            reasoning
          );
          if (name === "levels only") {
            expect(unwrapped).not.toEqual(fromPi);
          }
        });
      }
    }
  }
});
