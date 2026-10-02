/**
 * Structural type guards over `unknown` values.
 *
 * Every narrow step in the plugin goes through a predicate declared here so
 * the lint's `no-unsafe-type-assertion` stays honest: the code proves the
 * shape instead of casting to it. The module is dependency-free and
 * side-effect-free, so host and client bundles can both import it.
 *
 * @module dsh-opencode-patch/guards
 */

/** True for a non-null, non-array object usable as a property bag. */
export const isRecord = (value: unknown): value is Record<string, unknown> => {
  if (value === null || value === undefined) {
    return false;
  }
  if (typeof value !== "object") {
    return false;
  }
  if (Array.isArray(value)) {
    return false;
  }
  return true;
};

/** True for any array, regardless of element type. */
export const isUnknownArray = (value: unknown): value is unknown[] =>
  Array.isArray(value);

/** True for a string with at least one character. */
export const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

/** True for any callable value (method guard for `Reflect.apply`). */
export const isFunctionLike = (
  value: unknown
): value is (...args: unknown[]) => unknown => typeof value === "function";

/** True when `value` carries a callable `next`, i.e. an async iterator. */
export const isAsyncIteratorLike = <T>(
  value: unknown
): value is AsyncIterator<T> => {
  if (value === null || value === undefined) {
    return false;
  }
  if (typeof value !== "object" && typeof value !== "function") {
    return false;
  }
  if (!("next" in value)) {
    return false;
  }
  const next: unknown = value.next;
  return typeof next === "function";
};

/** Pull the live async iterator out of an iterable, or `undefined` if none. */
export const getAsyncIterator = <T>(
  iterable: AsyncIterable<T>
): AsyncIterator<T> | undefined => {
  const candidate: unknown = iterable;
  if (candidate === null || candidate === undefined) {
    return undefined;
  }
  if (typeof candidate !== "object" && typeof candidate !== "function") {
    return undefined;
  }
  if (!(Symbol.asyncIterator in candidate)) {
    return undefined;
  }
  const factory: unknown = candidate[Symbol.asyncIterator];
  if (typeof factory !== "function") {
    return undefined;
  }
  const iterator: unknown = factory.call(candidate);
  if (!isAsyncIteratorLike<T>(iterator)) {
    return undefined;
  }
  return iterator;
};

/** True for anything exposing a callable `Symbol.asyncIterator`. */
export const isAsyncIterableLike = (
  value: unknown
): value is AsyncIterable<unknown> => {
  if (value === null || value === undefined) {
    return false;
  }
  if (typeof value !== "object" && typeof value !== "function") {
    return false;
  }
  if (!(Symbol.asyncIterator in value)) {
    return false;
  }
  const factory: unknown = value[Symbol.asyncIterator];
  return typeof factory === "function";
};

/** True for a callable `fetch`. */
export const isFetchFunction = (value: unknown): value is typeof fetch =>
  typeof value === "function";
