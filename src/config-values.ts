/**
 * Coercion readers shared by the host config resolver and the client card, so
 * both apply the same "absent or invalid means default" rule. Dependency-free by
 * design: importing schemastery would ship the validator to the browser.
 *
 * @module dsh-opencode-patch/config-values
 */

import { isUnknownArray } from "./utils/guards.ts";

/** Marker meaning "apply to every model" instead of a literal substring. */
export const ALL_MODELS_MARKER = "*";

/**
 * Provider routes the plugin claims: intercepted for headers, and the routes
 * whose quota the meter reports. One list, because they are the same set — a
 * route we do not intercept carries no OpenCode headers and has no quota to
 * show.
 *
 * **It must cover every route this layer mounts**, which is the invariant the
 * list is for. `llm-pi-ai` carries one `api` per route and offers no per-model
 * override, so each non-default protocol needs its own route: Responses and
 * Messages for each plane, plus the Google bridge's route. An unclaimed route
 * gets no session header, no origin headers, and no key injection.
 *
 * `opencode-google` was missing here while every other internal route was
 * present. It mattered less before the picker began publishing the whole catalog
 * on the parent route; now a Google model is reachable and dispatched to this
 * route, so it has to be claimed like the rest. It is mounted by the Google
 * bridge (`google-bridge.ts`) rather than the wrapper, which is why it is easy to
 * forget: `SELF_MOUNTED_ROUTES` excludes it from the wrapper's mount loop.
 *
 * Shared here rather than in `config.ts` so the client bundle can read the same
 * default without importing schemastery.
 */
export const DEFAULT_PROVIDERS = [
  "opencode",
  "opencode-go",
  "opencode-responses",
  "opencode-anthropic",
  "opencode-google",
  "opencode-go-responses",
  "opencode-go-anthropic",
  "opencode-go-google",
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
 * Which endpoint family the gateway's requests go to.
 *
 * The gateway answers on two families and the user, not the catalog, is the one
 * who knows which their account is entitled to:
 *
 * - `auto` follows the catalog — the `api` the vendor's own entry names, which
 *   today is the `inference` family.
 * - `legacy` forces the older pair, which really is one base per plane
 *   (`…/zen/v1`, `…/zen/go/v1`).
 * - `modern` forces the newer `inference` family, whose base is PER PROTOCOL
 *   (`…/inference/openai/v1`, `…/inference/anthropic/v1`,
 *   `…/inference/google/v1beta`, and the `go/` variants) — so "inference/v1" is
 *   not an address the plugin ever sends, and the copy says `inference/…`.
 *
 * Declared here rather than in `config.ts` so the client card can read the same
 * list without importing schemastery.
 */
export const ENDPOINT_FAMILIES = ["auto", "legacy", "modern"] as const;

/** One accepted {@link ENDPOINT_FAMILIES} value. */
export type EndpointFamily = (typeof ENDPOINT_FAMILIES)[number];

/** Family applied when a row does not name one. */
export const DEFAULT_ENDPOINT_FAMILY: EndpointFamily = "auto";

/** Whether `value` is one of the accepted families. */
export const isEndpointFamily = (value: unknown): value is EndpointFamily =>
  typeof value === "string" &&
  (ENDPOINT_FAMILIES as readonly string[]).includes(value);

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

/**
 * Read a positive finite integer, or `undefined` when absent/invalid.
 *
 * @param value - raw value, possibly a number or string.
 */
export const readPositiveInteger = (value: unknown): number | undefined => {
  const raw: unknown = unwrapNode(value);
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
    return Math.floor(raw);
  }
  if (typeof raw === "string" && raw.trim().length > 0) {
    const parsed = Number(raw.trim());
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.floor(parsed);
    }
  }
  return undefined;
};
