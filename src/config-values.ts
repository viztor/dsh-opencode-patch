/**
 * Coercion readers shared by the host config resolver and the client card.
 *
 * The host reads raw row YAML (possibly carrying schemastery volatile
 * `.get()` nodes); the client reads the schema-resolved snapshot the settings
 * scope serves. Both need the same "absent or invalid means default"
 * semantics, so both call the readers here rather than duplicating the rules.
 * Dependency-free by design: importing schemastery into the client bundle
 * would ship the validator to the browser for no reason.
 *
 * @module dsh-opencode-patch/config-values
 */

import { isUnknownArray } from "./guards.ts";

/** Marker meaning "apply to every model" instead of a literal substring. */
export const ALL_MODELS_MARKER = "*";

/**
 * Provider-route markers that make the Go quota meter visible on the client.
 * A route matches when it contains any marker case-insensitively. Shared
 * here because both the host schema's default and the pill's fallback gate
 * read the same list.
 */
export const DEFAULT_USAGE_PROVIDER_MARKERS = ["opencode-go"];

/**
 * Model-id markers that make the Go quota meter visible even under a
 * custom-routed provider (Go serves some models outside the `opencode-go`
 * route id).
 */
export const DEFAULT_USAGE_MODEL_MARKERS = ["deepseek-v4.1-flash"];

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
 * Read a boolean: an explicit boolean wins, anything else inherits
 * `fallback`. Non-boolean junk degrades to the default instead of toggling
 * the feature off (or on) by accident.
 *
 * @param value - raw value, possibly a volatile node.
 * @param fallback - default applied when the value is not a boolean.
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
