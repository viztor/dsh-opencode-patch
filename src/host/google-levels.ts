/**
 * The plane's Google protocol, for a model the catalog describes by thinking
 * LEVEL that pi's own pattern does not (D16).
 *
 * Google has two thinking controls, and a model accepts only its own: a
 * discrete `thinkingLevel`, or a token `thinkingBudget`. pi 1.1.0 picks the
 * level control only for ids its pattern names (`usesGoogleThinkingLevel`:
 * `gemini-3[.N]-pro|flash`, `gemini-flash[-lite]-latest`, `gemma-4`) and sends
 * every other id a budget — on the enabled path (`thinkingBudget: -1`) and on
 * the disabled one (`thinkingBudget: 0`). A level model outside the pattern
 * refuses both with 400 INVALID_ARGUMENT ("Thinking budget is not supported
 * for this model. Use thinking level instead."), measured live on Go
 * `gemini-4-argon`.
 *
 * So `streamSimple` is wrapped for the ids the catalog describes by level
 * (`usesCatalogThinkingLevels` in `utils/model-metadata.ts`), and each such call is built the way pi
 * builds one for a level id, from pi's own PUBLIC exports
 * (`api/simple-options`, `models`, `api/google-shared`,
 * `api/google-generative-ai`), loaded from the host's pi:
 *
 * - a chosen level: `thinking: { enabled: true, level }`, clamped and mapped
 *   as pi clamps and maps it;
 * - no level, or Off: pi's disabled config for a level model — the level pi
 *   falls back to (`clampThinkingLevel(model, "off")`), sent as
 *   `thinkingConfig: { thinkingLevel }` through the payload hook, since pi's
 *   request builder decides the disabled config by the same pattern. Only a
 *   model that offers Off is disabled outright, as pi disables one — which
 *   for an id pi's pattern misses is `thinkingBudget: 0`, exactly what pi
 *   sends its own level ids. The catalog never offers Off on Google
 *   (`reasoningFor` pins `off: null`); only a profile that declares one does,
 *   and a model that cannot turn thinking off (`gemini-4-argon`) refuses it,
 *   so declaring Off there is a profile error.
 *
 * Every other id, every other entry point and every other protocol is pi's,
 * with the same arguments; an id pi's pattern already serves by level is
 * handed back to pi too, so the wrapper retires itself when pi learns the id.
 *
 * @module dsh-opencode-patch/host/google-levels
 */

import { isFunctionLike, isRecord } from "../utils/guards.ts";

/** A pi model, as far as this module reads one; the rest is pi's. */
type PiModel = Readonly<Record<string, unknown>>;

/** pi's stream options, as far as this module reads them. */
type StreamOptions = Readonly<Record<string, unknown>>;

/** pi's public pieces a level request is built from. */
export interface GoogleLevelPieces {
  /** `api/google-generative-ai` `stream`. */
  readonly stream: (
    model: PiModel,
    context: unknown,
    options: StreamOptions
  ) => unknown;
  /** `api/simple-options` `buildBaseOptions`. */
  readonly buildBaseOptions: (
    model: PiModel,
    context: unknown,
    options: StreamOptions | undefined,
    apiKey: unknown
  ) => Readonly<Record<string, unknown>>;
  /** `models` `clampThinkingLevel`. */
  readonly clampThinkingLevel: (model: PiModel, level: string) => string;
  /** `api/google-shared` `usesGoogleThinkingLevel`: pi's id pattern. */
  readonly usesGoogleThinkingLevel: (model: PiModel) => boolean;
  /** `api/google-shared` `resolveGoogleThinkingLevel`. */
  readonly resolveGoogleThinkingLevel: (
    model: PiModel,
    level: string
  ) => string;
  /** `api/google-shared` `toGoogleThinkingLevel`. */
  readonly toGoogleThinkingLevel: (level: string) => string;
  /** `api/google-shared` `toGoogleSdkThinkingLevel`. */
  readonly toGoogleSdkThinkingLevel: (level: string) => unknown;
}

/**
 * Where the pieces come from: pi's `lazyStream` (`api/lazy`), which answers a
 * stream synchronously and ends it with an error event when the setup throws,
 * and a loader for the pieces, which pull in the Google SDK and so load only
 * on a level model's first call, as pi's own lazy Google API does.
 */
export interface GoogleLevelSource {
  readonly lazyStream: (
    model: PiModel,
    setup: () => Promise<unknown>
  ) => unknown;
  readonly load: () => Promise<GoogleLevelPieces | undefined>;
}

/** The value pi's builder accepts as a Google thinking level, for one pi level. */
const sdkLevel = (
  pieces: GoogleLevelPieces,
  model: PiModel,
  level: string
): unknown =>
  pieces.toGoogleSdkThinkingLevel(
    pieces.toGoogleThinkingLevel(
      pieces.resolveGoogleThinkingLevel(model, level)
    )
  );

/**
 * pi's `streamSimple` for the Google protocol, as pi runs it for an id its
 * pattern names (`google-generative-ai.js` `streamSimple`, and
 * `google-shared.js` `getDisabledGoogleThinkingConfig` for the disabled path).
 */
const levelStreamSimple = (
  pieces: GoogleLevelPieces,
  model: PiModel,
  context: unknown,
  options: StreamOptions | undefined
): unknown => {
  const apiKey = options?.apiKey;
  if (typeof apiKey !== "string" || apiKey.length === 0) {
    throw new Error(`No API key for provider: ${String(model.provider)}`);
  }
  const base = {
    ...pieces.buildBaseOptions(model, context, options, apiKey),
    toolChoice: options?.toolChoice,
  };
  const chosen =
    typeof options?.reasoning === "string" && options.reasoning.length > 0
      ? pieces.clampThinkingLevel(model, options.reasoning)
      : "off";
  if (chosen !== "off") {
    return pieces.stream(model, context, {
      ...base,
      thinking: {
        enabled: true,
        level: pieces.toGoogleThinkingLevel(
          pieces.resolveGoogleThinkingLevel(model, chosen)
        ),
      },
    });
  }
  const fallback = pieces.clampThinkingLevel(model, "off");
  if (fallback === "off") {
    return pieces.stream(model, context, {
      ...base,
      thinking: { enabled: false },
    });
  }
  const thinkingConfig = { thinkingLevel: sdkLevel(pieces, model, fallback) };
  const caller = options?.onPayload;
  return pieces.stream(model, context, {
    ...base,
    onPayload: async (params: unknown, payloadModel: unknown) => {
      const next =
        isRecord(params) && isRecord(params.config)
          ? { ...params, config: { ...params.config, thinkingConfig } }
          : params;
      const answered: unknown = isFunctionLike(caller)
        ? await Reflect.apply(caller, undefined, [next, payloadModel])
        : undefined;
      return answered === undefined ? next : answered;
    },
    thinking: { enabled: false },
  });
};

/**
 * pi's Google API with `streamSimple` serving the catalog's level models by
 * level. Answers the api itself when there is nothing to wrap.
 *
 * @param api - pi's Google API (`googleGenerativeAIApi()`).
 * @param levelModels - the ids on this plane the catalog describes by level
 *   (`usesCatalogThinkingLevels`).
 * @param source - the host's pi pieces; `undefined` leaves the api pi's.
 */
export const withCatalogThinkingLevels = (
  api: unknown,
  levelModels: ReadonlySet<string>,
  source?: GoogleLevelSource
): unknown => {
  if (
    source === undefined ||
    levelModels.size === 0 ||
    !isRecord(api) ||
    !isFunctionLike(api.streamSimple)
  ) {
    return api;
  }
  const piStreamSimple = api.streamSimple;
  const toPi = (args: readonly unknown[]): unknown =>
    Reflect.apply(piStreamSimple, api, args);
  return {
    ...api,
    streamSimple: (...args: unknown[]): unknown => {
      const [model, context, options] = args;
      if (
        !isRecord(model) ||
        model.reasoning !== true ||
        typeof model.id !== "string" ||
        !levelModels.has(model.id)
      ) {
        return toPi(args);
      }
      return source.lazyStream(model, async () => {
        const pieces = await source.load();
        if (pieces === undefined || pieces.usesGoogleThinkingLevel(model)) {
          return toPi(args);
        }
        return levelStreamSimple(
          pieces,
          model,
          context,
          isRecord(options) ? options : undefined
        );
      });
    },
  };
};
