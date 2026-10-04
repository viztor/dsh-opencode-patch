/**
 * `guards.ts` — the structural predicates every narrow step in the plugin goes
 * through. Each one is asserted directly, including the shapes it must REJECT:
 * a guard that over-accepts silently mis-shapes a host object, which is exactly
 * what these predicates exist to prevent.
 */

import assert from "node:assert/strict";

import { describe, expect, it } from "vitest";

import {
  getAsyncIterator,
  isAsyncIterableLike,
  isAsyncIteratorLike,
  isFetchFunction,
  isFunctionLike,
  isRecord,
  isUnknownArray,
} from "../src/guards.ts";

/** A value that is genuinely absent, without writing the `undefined` literal. */
const ABSENT: unknown = undefined;

const asyncGenerator = async function* asyncGenerator() {
  yield 1;
};

describe("guards: isRecord", () => {
  it("accepts plain objects and rejects every non-property-bag", () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord({ a: 1 })).toBe(true);
    expect(isRecord(Object.create(null))).toBe(true);

    expect(isRecord(null)).toBe(false);
    expect(isRecord(ABSENT)).toBe(false);
    // Arrays are objects, but never property bags here.
    expect(isRecord([])).toBe(false);
    expect(isRecord([1, 2])).toBe(false);
    expect(isRecord("string")).toBe(false);
    expect(isRecord(42)).toBe(false);
    expect(isRecord(true)).toBe(false);
    // A callable is not a property bag either — this is what keeps the host
    // context predicates from treating a function as a service object.
    expect(isRecord(() => 1)).toBe(false);
  });
});

describe("guards: isUnknownArray / isFunctionLike / isFetchFunction", () => {
  it("isUnknownArray accepts any array, whatever the elements", () => {
    expect(isUnknownArray([])).toBe(true);
    expect(isUnknownArray([1, "a", null, undefined, {}])).toBe(true);
    expect(isUnknownArray({ length: 0 })).toBe(false);
    expect(isUnknownArray("abc")).toBe(false);
    expect(isUnknownArray(ABSENT)).toBe(false);
  });

  it("isFunctionLike accepts any callable", () => {
    const namedFunction = function namedFunction() {
      return 1;
    };
    expect(isFunctionLike(() => 1)).toBe(true);
    expect(isFunctionLike(async () => 1)).toBe(true);
    expect(isFunctionLike(namedFunction)).toBe(true);
    expect(
      isFunctionLike(
        class Counter {
          value = 1;
        }
      )
    ).toBe(true);
    expect(isFunctionLike({})).toBe(false);
    expect(isFunctionLike("fn")).toBe(false);
    expect(isFunctionLike(ABSENT)).toBe(false);
  });

  it("isFetchFunction is the same callable check", () => {
    expect(isFetchFunction(() => Promise.resolve())).toBe(true);
    expect(isFetchFunction({})).toBe(false);
    expect(isFetchFunction(ABSENT)).toBe(false);
  });
});

describe("guards: isAsyncIteratorLike", () => {
  it("accepts anything with a callable next", () => {
    expect(isAsyncIteratorLike({ next: () => ({ done: true }) })).toBe(true);
    // A callable carrying `next` is admitted too (typeof function is allowed).
    const callable = Object.assign(() => 1, { next: () => 1 });
    expect(isAsyncIteratorLike(callable)).toBe(true);
  });

  it("rejects values whose next is absent or not callable", () => {
    expect(isAsyncIteratorLike({})).toBe(false);
    expect(isAsyncIteratorLike({ next: 1 })).toBe(false);
    expect(isAsyncIteratorLike({ next: null })).toBe(false);
    expect(isAsyncIteratorLike(null)).toBe(false);
    expect(isAsyncIteratorLike(ABSENT)).toBe(false);
    expect(isAsyncIteratorLike(ABSENT)).toBe(false);
    expect(isAsyncIteratorLike("iter")).toBe(false);
    expect(isAsyncIteratorLike(42)).toBe(false);
  });
});

describe("guards: getAsyncIterator", () => {
  it("pulls the live iterator out of an async iterable", async () => {
    const iterator = getAsyncIterator(asyncGenerator());
    assert.ok(iterator, "expected an iterator");
    const first = await iterator.next();
    expect(first).toEqual({ done: false, value: 1 });
  });

  it("returns undefined when there is no async iterator protocol", () => {
    expect(getAsyncIterator(null as never)).toBeUndefined();
    expect(getAsyncIterator(ABSENT as never)).toBeUndefined();
    expect(getAsyncIterator("not iterable" as never)).toBeUndefined();
    expect(getAsyncIterator(42 as never)).toBeUndefined();
    // A sync-only iterable is not an async one.
    expect(getAsyncIterator([1, 2, 3] as never)).toBeUndefined();
  });

  it("returns undefined when Symbol.asyncIterator is not callable", () => {
    expect(
      getAsyncIterator({ [Symbol.asyncIterator]: 1 } as never)
    ).toBeUndefined();
  });

  it("returns undefined when the factory yields a non-iterator", () => {
    expect(
      getAsyncIterator({ [Symbol.asyncIterator]: () => ({}) } as never)
    ).toBeUndefined();
    expect(
      getAsyncIterator({ [Symbol.asyncIterator]: () => null } as never)
    ).toBeUndefined();
  });
});

describe("guards: isAsyncIterableLike", () => {
  it("accepts a callable Symbol.asyncIterator, not just any property", () => {
    expect(isAsyncIterableLike(asyncGenerator())).toBe(true);
    expect(
      isAsyncIterableLike({ [Symbol.asyncIterator]: () => asyncGenerator() })
    ).toBe(true);

    expect(isAsyncIterableLike({ [Symbol.asyncIterator]: 1 })).toBe(false);
    expect(isAsyncIterableLike({ [Symbol.asyncIterator]: undefined })).toBe(
      false
    );
  });

  it("rejects non-objects and sync-only iterables", () => {
    expect(isAsyncIterableLike(null)).toBe(false);
    expect(isAsyncIterableLike(ABSENT)).toBe(false);
    expect(isAsyncIterableLike("str")).toBe(false);
    expect(isAsyncIterableLike([1, 2])).toBe(false);
  });
});
