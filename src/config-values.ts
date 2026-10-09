/**
 * Coercion readers shared by the host config resolver and the client card, so
 * both apply the same "absent or invalid means default" rule. Dependency-free by
 * design: importing schemastery would ship the validator to the browser.
 *
 * @module dsh-opencode-patch/config-values
 */

import { isUnknownArray } from "./guards.ts";

/** Marker meaning "apply to every model" instead of a literal substring. */
export const ALL_MODELS_MARKER = "*";

/**
 * Provider routes the plugin claims: intercepted for headers, and the routes
 * whose quota the meter reports. One list, because they are the same set — a
 * route we do not intercept carries no OpenCode headers and has no quota to
 * show.
 *
 * `opencode-responses` is the gateway's Responses-API plane. It has to be a
 * separate route because `llm-pi-ai` carries one `api` per route and offers no
 * per-model override, and the gateway serves exactly one Zen model
 * (`muse-spark-1.3-contributor-free`) on `/responses` — everything else on
 * `/chat/completions`. The plugin declares that route in its own layer
 * (`cordis.patch.yml`), so it must claim it here too: an unclaimed route gets
 * no session header, no origin headers, and no key injection.
 *
 * Shared here rather than in `config.ts` so the client bundle can read the same
 * default without importing schemastery.
 */
export const DEFAULT_PROVIDERS = [
  "opencode",
  "opencode-go",
  "opencode-responses",
  "opencode-anthropic",
  "opencode-mistral",
  "opencode-go-responses",
  "opencode-go-anthropic",
];

/**
 * Whether the meter shows session spend and the active model's rate. Shared
 * here because the host schema's default and the client pill's fallback gate
 * must agree on the same value.
 */

/**
 * Which credential source wins when more than one resolves.
 *
 * Declared here rather than in `config.ts` so the client card can read the same
 * list without importing schemastery. `AGENTS.md` → "Key resolution" records what
 * each policy orders, and why the default is not a behaviour change.
 */
export const KEY_SOURCE_POLICIES = ["auto", "request", "configured"] as const;

/** One accepted {@link KEY_SOURCE_POLICIES} value. */
export type KeySourcePolicy = (typeof KEY_SOURCE_POLICIES)[number];

/** Policy applied when a row does not name one. */
export const DEFAULT_KEY_SOURCE: KeySourcePolicy = "auto";

/** Whether `value` is one of the accepted policies. */
export const isKeySourcePolicy = (value: unknown): value is KeySourcePolicy =>
  typeof value === "string" &&
  (KEY_SOURCE_POLICIES as readonly string[]).includes(value);

/**
 * Unwrap a schemastery volatile `.get()` node to its current value.
 *
 * Idempotent: plain values pass through untouched, so the host behaves
 * identically whether the row carries explicit values, schema-defaulted
 * nodes, or raw JSON.
 */
export const unwrapNode = (val: unknown): unknown => {
  if (
    val !== null &&
    typeof val === "object" &&
    "get" in val &&
    typeof val.get === "function"
  ) {
    return Reflect.apply(val.get, val, []);
  }
  return val;
};

/**
 * Read a boolean: an explicit boolean wins, non-boolean junk degrades to
 * `fallback` rather than toggling the feature by accident.
 */
export const readBoolean = (value: unknown, fallback: boolean): boolean => {
  const raw: unknown = unwrapNode(value);
  return typeof raw === "boolean" ? raw : fallback;
};

/**
 * Read a trimmed string, or `undefined` when absent/blank.
 *
 * @param value - raw value, possibly a volatile node.
 */
export const readString = (value: unknown): string | undefined => {
  const raw: unknown = unwrapNode(value);
  if (typeof raw !== "string") {
    return undefined;
  }
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

/**
 * Read a trimmed list of non-blank strings, dropping anything else.
 *
 * @param value - raw value, possibly a volatile node.
 * @returns the valid trimmed entries; empty when the value is not a usable list.
 */
export const readStringList = (value: unknown): string[] => {
  const raw: unknown = unwrapNode(value);
  if (!isUnknownArray(raw)) {
    return [];
  }
  return raw
    .filter(
      (item: unknown): item is string =>
        typeof item === "string" && item.trim().length > 0
    )
    .map((item: string) => item.trim());
};
