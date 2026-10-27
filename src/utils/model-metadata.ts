/**
 * A model's reasoning levels, in both of pi's vocabularies at once.
 *
 * Two vocabularies mean opposite things by `null` (docs/improvement-plan.md,
 * "D1 representation"), and a model must say the same thing in both:
 *
 * - pi's `thinkingLevelMap` on the model object: a level mapped to `null` is
 *   NOT offered, and an absent `off` key is what offers Off and lets the
 *   protocol send its explicit disable (`off: null` hides Off);
 * - a profile's `reasoningEfforts` dict: an offered level maps to its wire
 *   value, and `off: null` means "Off is offered, send nothing".
 *
 * A string `off` means the same in both: Off is offered, and that string is
 * the disable the protocol sends.
 *
 * The picker reads the efforts pi derives from the map
 * (`getSupportedThinkingLevels`), so one rule here decides both what the
 * composer offers and what dispatch accepts. A model whose reasoning is only a
 * switch is offered as Off / On (D1), Off only where its protocol can actually
 * disable reasoning.
 *
 * @module dsh-opencode-patch/utils/model-metadata
 */

import { type Protocol, protocolForSdk } from "./protocols.ts";

/** pi's thinking levels, in escalation order, `off` first. */
export const PI_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

/** One of {@link PI_LEVELS}. */
export type PiLevel = (typeof PI_LEVELS)[number];

/**
 * The name pi-ai's adapter shows for a level: `Off`, otherwise the level
 * capitalized.
 *
 * @param level - the pi level.
 */
export const effortName = (level: string): string =>
  level === "off" ? "Off" : `${level.charAt(0).toUpperCase()}${level.slice(1)}`;

/** The completions dialects that send an explicit disable when Off is offered. */
const DISABLING_THINKING_FORMATS: ReadonlySet<string> = new Set([
  "deepseek",
  "openrouter",
  "string-thinking",
  "together",
]);

/**
 * Whether a protocol can turn reasoning off, rather than merely send nothing.
 *
 * Read from pi's own request builders: Anthropic sends `thinking.disabled`,
 * Responses an `effort` of `none`, Google its disabled thinking config, and
 * completions only in the dialects that carry a disable
 * (`openai-completions.js:667-711`).
 *
 * @param protocol - the model's protocol.
 * @param compat - the model's resolved compat block, if any.
 */
export const canDisableReasoning = (
  protocol: Protocol,
  compat?: Readonly<Record<string, unknown>>
): boolean => {
  if (protocol !== "openai-completions") {
    return true;
  }
  const format = compat?.thinkingFormat;
  return typeof format === "string" && DISABLING_THINKING_FORMATS.has(format);
};

/** The slice of a catalog spec the reasoning rule reads. */
export interface ReasoningSpec {
  readonly reasoning?: boolean;
  readonly reasoning_options?: readonly {
    readonly type: string;
    readonly values?: readonly string[];
  }[];
}

/** One model's reasoning, in both vocabularies and the picker's. */
export interface ModelReasoning {
  /** pi's map for the model object. */
  readonly thinkingLevelMap: Readonly<Record<string, string | null>>;
  /** The profile dict that says the same thing. */
  readonly reasoningEfforts: Readonly<Record<string, string | null>>;
  /** The picker's efforts, `Off` first when offered. */
  readonly efforts: readonly { readonly id: string; readonly name: string }[];
  /** Each offered id's display name. */
  readonly effortNames: Readonly<Record<string, string>>;
}

/** The first effort list with values, the one {@link reasoningFor} reads. */
const effortValuesOf = (spec: ReasoningSpec): readonly string[] | undefined =>
  spec.reasoning_options?.find(
    (option) => option.type === "effort" && (option.values?.length ?? 0) > 0
  )?.values;

/** Google's discrete thinking levels (`thinkingConfig.thinkingLevel`). */
const GOOGLE_THINKING_LEVELS: ReadonlySet<string> = new Set([
  "minimal",
  "low",
  "medium",
  "high",
]);

/**
 * Whether the catalog describes a model's reasoning as Google's discrete
 * thinking levels: a reasoning model served on the Google protocol whose
 * effort list names only `minimal`/`low`/`medium`/`high` (D16).
 *
 * Google's two thinking controls are not interchangeable: a model that thinks
 * in levels refuses a token `thinkingBudget` with 400 INVALID_ARGUMENT
 * ("Thinking budget is not supported for this model. Use thinking level
 * instead."), measured live on Go `gemini-4-argon`. pi 1.1.0 decides the
 * control by an id pattern (`usesGoogleThinkingLevel`), which misses any id
 * it was not written for; this answers the same question from the catalog.
 *
 * The first effort list with values decides, the one {@link reasoningFor}
 * turns into the model's levels: a `budget_tokens` option beside it says a
 * budget is ALSO accepted, which leaves the level request valid, so it does
 * not change the answer.
 *
 * @param spec - the catalog spec.
 */
export const usesCatalogThinkingLevels = (
  spec: ReasoningSpec & { readonly provider_npm?: string }
): boolean => {
  if (
    spec.reasoning !== true ||
    protocolForSdk(spec.provider_npm) !== "google-generative-ai"
  ) {
    return false;
  }
  const values = effortValuesOf(spec);
  return (
    values !== undefined &&
    values.every((value) => GOOGLE_THINKING_LEVELS.has(value))
  );
};

/** The values in a catalog effort list that name an explicit disable. */
const DISABLE_VALUES: readonly string[] = ["none", "off"];

/**
 * The levels a catalog spec offers, whether it is a bare switch, and the
 * disable value its effort list names, if any.
 */
const offeredLevels = (
  spec: ReasoningSpec
): { levels: PiLevel[]; toggle: boolean; disable?: string } => {
  const options = spec.reasoning_options ?? [];
  const values = effortValuesOf(spec);
  if (values !== undefined) {
    const levels = PI_LEVELS.filter(
      (level) => level !== "off" && values.includes(level)
    );
    if (levels.length > 0) {
      const disable = DISABLE_VALUES.find((value) => values.includes(value));
      return {
        levels,
        toggle: false,
        ...(disable === undefined ? {} : { disable }),
      };
    }
  }
  if (options.some((option) => option.type === "toggle")) {
    return { levels: ["high"], toggle: true };
  }
  return { levels: ["low", "medium", "high"], toggle: false };
};

/**
 * The reasoning a catalog spec declares, for one protocol.
 *
 * - An `effort` list offers exactly its pi levels. A `none` (or `off`) in it
 *   is the model's explicit disable: on completions it offers Off with that
 *   value as Off's WIRE value, the way pi's own entries carry it
 *   (`thinkingLevelMap.off = "none"`), because pi's completions path sends a
 *   string `off` as `reasoning_effort`, both when Off is picked and when no
 *   effort is (`openai-completions.js:717-721`). On Responses the list's
 *   `none` does not offer Off yet: pi 1.1.0's own entries disagree there
 *   (gpt-5.x pin `off: null`, gpt-6 carry `"none"`), and a string `off`
 *   becomes the request sent when no effort is selected
 *   (`openai-responses.js:278-280`), so that is the owner's call, not this
 *   rule's.
 * - A bare `toggle` offers `high` as "On", and Off where the protocol can
 *   disable (D1).
 * - Any other reasoning model gets `low`/`medium`/`high`.
 *
 * @param spec - the catalog spec.
 * @param protocol - the protocol the model is served on.
 * @param compat - the model's resolved compat block, if any.
 * @returns the reasoning, or `undefined` for a model that declares none.
 */
export const reasoningFor = (
  spec: ReasoningSpec,
  protocol: Protocol,
  compat?: Readonly<Record<string, unknown>>
): ModelReasoning | undefined => {
  if (spec.reasoning !== true) {
    return undefined;
  }
  const { disable, levels, toggle } = offeredLevels(spec);
  const off = toggle && canDisableReasoning(protocol, compat);
  // The explicit disable the effort list names, sent as Off's wire value.
  const offWire =
    disable !== undefined && protocol === "openai-completions"
      ? disable
      : undefined;
  const thinkingLevelMap: Record<string, string | null> = off
    ? {}
    : { off: offWire ?? null };
  for (const level of PI_LEVELS) {
    if (level !== "off") {
      thinkingLevelMap[level] = levels.includes(level) ? level : null;
    }
  }
  // Off offered as "send nothing" (a bare toggle), as a wire value, or not.
  const offEffort: string | null | undefined = off ? null : offWire;
  const reasoningEfforts: Record<string, string | null> =
    offEffort === undefined ? {} : { off: offEffort };
  const efforts: { id: string; name: string }[] =
    off || offWire !== undefined ? [{ id: "off", name: "Off" }] : [];
  for (const level of levels) {
    reasoningEfforts[level] = level;
    efforts.push({ id: level, name: toggle ? "On" : effortName(level) });
  }
  return {
    effortNames: Object.fromEntries(
      efforts.map((effort) => [effort.id, effort.name])
    ),
    efforts,
    reasoningEfforts,
    thinkingLevelMap,
  };
};

/** What {@link piReasoningFromEfforts} answers. */
export type PiReasoning =
  | {
      readonly reasoning: boolean;
      readonly thinkingLevelMap?: Readonly<Record<string, string | null>>;
    }
  | { readonly error: string };

/**
 * A profile's declared `reasoningEfforts`, translated the way pi-ai's own
 * `resolveModelReasoning` translates it (`llm-pi-ai/src/catalog.ts:681-721`),
 * with its messages, so a malformed dict reads the same on a plane.
 *
 * @param model - the model id, for the message.
 * @param route - the route, for the message.
 * @param efforts - the declared dict, or `false` for a non-reasoning model.
 * @returns the reasoning fields, or the error pi-ai would have raised.
 */
export const piReasoningFromEfforts = (
  model: string,
  route: string,
  efforts: Readonly<Record<string, string | null>> | false | null
): PiReasoning => {
  const fail = (detail: string): PiReasoning => ({
    error: `llm-pi-ai: provider "${route}" model "${model}" ${detail}`,
  });
  if (efforts === false) {
    return { reasoning: false };
  }
  if (efforts === null || Object.keys(efforts).length === 0) {
    return fail(
      "has an empty reasoningEfforts; declare the offered levels, set false for a non-reasoning model, or omit the field to keep the installed catalog's capability"
    );
  }
  const declared = PI_LEVELS.flatMap((level) => {
    const wire = efforts[level];
    return wire === undefined ? [] : [[level, wire] as const];
  });
  for (const [level, wire] of declared) {
    if (wire === null) {
      if (level !== "off") {
        return fail(
          `reasoningEfforts.${level} needs the wire value dispatch should send; only "off" may leave it empty`
        );
      }
    } else if (wire.length === 0) {
      return fail(`reasoningEfforts.${level} must not be an empty string`);
    }
  }
  if (!declared.some(([level]) => level !== "off")) {
    return fail(
      'reasoningEfforts offers no level beyond "off"; declare a thinking level, or set reasoningEfforts to false for a non-reasoning model'
    );
  }
  const map: Record<string, string | null> = {};
  for (const level of PI_LEVELS) {
    const wire = efforts[level];
    if (wire === undefined) {
      map[level] = null;
    } else if (wire !== null) {
      map[level] = wire;
    }
  }
  return { reasoning: true, thinkingLevelMap: map };
};
