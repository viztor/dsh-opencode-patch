/**
 * `turn-store.ts` — the `AsyncLocalStorage` wrapper that carries one streamed
 * turn's state into the adapter's request path.
 *
 * `withStore` is what lets `patchFetch`, running deep inside the adapter long
 * after `llm/stream` returned, name the session of the turn that owns the
 * request. Two properties make that work and both are asserted here: each pull
 * binds the store without widening the context window (the generator's
 * synchronous prologue runs inside `als.run`, and so does everything it awaits
 * afterwards), and the binding belongs to the pull alone — a value written
 * through the store inside a scope is readable through the caller's own
 * reference, but the scope itself does not survive it. Overlapping turns are
 * the load-bearing case: a subagent streams beside its parent, and the two
 * must never see each other's session id.
 *
 * @module test/turn-store.test
 */

import { AsyncLocalStorage } from "node:async_hooks";

import { describe, expect, it } from "vitest";

import { type ActiveTurnState, withStore } from "../src/index.ts";
import { collectUnknown, createMockStoreStream } from "./test-helpers.ts";

/** A fresh store per case: the module has no shared state, and neither should a test. */
const freshAls = (): AsyncLocalStorage<ActiveTurnState> =>
  new AsyncLocalStorage<ActiveTurnState>();

const TURN: ActiveTurnState = {
  provider: "opencode",
  value: "ses_turn_a",
};

describe("withStore: scope binding", () => {
  it("reads no turn state outside any scope", async () => {
    const als = freshAls();

    // Before a turn there is nothing to claim a request with, and that is the
    // answer `patchFetch` falls back on — so it has to be `undefined`, not a
    // stale turn left over from whatever ran last.
    expect(als.getStore()).toBeUndefined();

    const seen = await collectUnknown(
      withStore(createMockStoreStream(als), TURN, als)
    );
    expect(seen).toEqual([TURN.value, TURN.value]);

    // The binding lasts for the pull, not for the rest of the process: the
    // usage poller and any later request with no turn of their own must not
    // inherit a finished turn's session id.
    expect(als.getStore()).toBeUndefined();
  });

  it("binds the store for the synchronous pull and for what it awaits", async () => {
    const als = freshAls();
    const observed: (string | undefined)[] = [];
    const probe = async function* probe() {
      observed.push(als.getStore()?.value);
      await Promise.resolve();
      observed.push(als.getStore()?.value);
      yield "chunk";
    };

    const iterator = withStore(probe(), TURN, als)[Symbol.asyncIterator]();
    const pending = iterator.next();

    // The generator's synchronous prologue has already run by the time `next`
    // returns its promise — inside `als.run`. That is the whole reason the
    // wrapper calls `run` without awaiting first: an await before it would open
    // the context window by a tick and let unrelated work in.
    expect(observed).toEqual([TURN.value]);

    // …and the continuation inherits it too, which is what carries the turn
    // across the request the generator goes on to make.
    await pending;
    expect(observed).toEqual([TURN.value, TURN.value]);
  });

  it("shares the store object, so a value written inside is readable outside", async () => {
    const als = freshAls();
    const state: ActiveTurnState = {
      provider: "opencode",
      value: "ses_written_inside",
    };
    const writer = async function* writer() {
      const active = als.getStore();
      if (active === undefined) {
        yield "no-store";
        return;
      }
      // A turn records what the caller will need after it — a parent id, a
      // model — by writing through the state it was handed.
      active.parentValue = "ses_parent_recorded_inside";
      yield active.value;
    };

    const seen = await collectUnknown(withStore(writer(), state, als));

    expect(seen).toEqual([state.value]);
    // The binding is gone…
    expect(als.getStore()).toBeUndefined();
    // …but the object is not: what the turn wrote is visible through the very
    // reference the caller kept. Binding without sharing would make the turn's
    // own bookkeeping unreadable the moment the scope closed.
    expect(state.parentValue).toBe("ses_parent_recorded_inside");
  });

  it("restores the outer store after a nested scope inside a pull", async () => {
    const als = freshAls();
    const outer: ActiveTurnState = {
      provider: "opencode",
      value: "ses_outer_turn",
    };
    const inner: ActiveTurnState = {
      provider: "opencode-responses",
      value: "ses_inner_turn",
    };
    const seen: (string | undefined)[] = [];
    const nested = async function* nested() {
      seen.push(als.getStore()?.value);
      // A pull that re-enters the store — for a sub-request of its own — must
      // shadow the turn for exactly as long as it is running.
      als.run(inner, () => {
        seen.push(als.getStore()?.value);
      });
      seen.push(als.getStore()?.value);
      yield "chunk";
    };

    const out = await collectUnknown(withStore(nested(), outer, als));

    expect(seen).toEqual([
      "ses_outer_turn",
      "ses_inner_turn",
      "ses_outer_turn",
    ]);
    expect(out).toEqual(["chunk"]);
    expect(als.getStore()).toBeUndefined();
  });

  it("keeps two interleaved turns from seeing each other's store", async () => {
    const als = freshAls();
    const turnB: ActiveTurnState = {
      provider: "opencode-go",
      value: "ses_turn_b",
    };
    // One plugin instance, one store, two turns genuinely in flight at once —
    // a subagent streaming beside its parent.
    const iteratorA = withStore(createMockStoreStream(als), TURN, als)[
      Symbol.asyncIterator
    ]();
    const iteratorB = withStore(createMockStoreStream(als), turnB, als)[
      Symbol.asyncIterator
    ]();

    const firstA = await iteratorA.next();
    const firstB = await iteratorB.next();
    const secondA = await iteratorA.next();
    const secondB = await iteratorB.next();

    // Each pull re-enters `als.run` with its own turn, so an interleaved drive
    // cannot bleed one session id into the other's request.
    expect([firstA.value, firstB.value, secondA.value, secondB.value]).toEqual([
      TURN.value,
      turnB.value,
      TURN.value,
      turnB.value,
    ]);
    expect(als.getStore()).toBeUndefined();
  });

  it("exposes one shared iterator for every asyncIterator call", async () => {
    const als = freshAls();
    const wrapped = withStore(createMockStoreStream(als), TURN, als);

    const first = wrapped[Symbol.asyncIterator]();
    const second = wrapped[Symbol.asyncIterator]();

    // The downstream iterator is pulled once, when the stream is wrapped, and
    // that one object is re-exposed. A second consumer resumes where the first
    // left off rather than starting the turn's stream again.
    expect(second).toBe(first);
    const firstChunk = await first.next();
    expect(firstChunk.value).toBe(TURN.value);
    const secondChunk = await second.next();
    expect(secondChunk.value).toBe(TURN.value);
    const exhausted = await second.next();
    expect(exhausted.done).toBe(true);
  });

  it("hands back a stream whose factory yields no iterator", () => {
    const als = freshAls();
    const passthrough: AsyncIterable<string> = {
      // @ts-expect-error -- a factory that yields no iterator at all, which is
      // exactly what the guard downstream of this has to survive
      [Symbol.asyncIterator]: () => null,
    };

    // There is nothing to drive and so nothing to bind the store to. Wrapping
    // anyway would hand back an object that throws on the first pull, so the
    // caller's own stream is returned untouched.
    expect(withStore(passthrough, TURN, als)).toBe(passthrough);
  });
});

describe("withStore: iterator control", () => {
  it("resolves return() when the downstream iterator has none", async () => {
    const als = freshAls();
    const bare: AsyncIterable<string> = {
      [Symbol.asyncIterator]: () => ({
        next: () => Promise.resolve({ done: false, value: "a" }),
      }),
    };

    const iterator = withStore(bare, TURN, als)[Symbol.asyncIterator]();

    // `for await … break` calls `return` unconditionally, on any iterator, so a
    // downstream without one must still tear down cleanly instead of throwing
    // a TypeError into the consumer's cleanup path.
    await expect(iterator.return?.("stop")).resolves.toEqual({
      done: true,
      value: "stop",
    });
    expect(als.getStore()).toBeUndefined();
  });

  it("swallows a failing downstream return() so cleanup cannot fail the turn", async () => {
    const als = freshAls();
    const failing: AsyncIterable<string> = {
      [Symbol.asyncIterator]: () => ({
        next: () => Promise.resolve({ done: false, value: "a" }),
        return: () => Promise.reject(new Error("downstream return exploded")),
      }),
    };

    const iterator = withStore(failing, TURN, als)[Symbol.asyncIterator]();

    // The stream is already being abandoned — the consumer broke out, or the
    // turn ended — so a downstream that throws on cleanup must not surface as a
    // turn failure. The wrapper reports "done" with the value it was handed.
    await expect(iterator.return?.("aborted")).resolves.toEqual({
      done: true,
      value: "aborted",
    });
  });

  it("rejects with the thrown error when the downstream has no throw()", async () => {
    const als = freshAls();
    const bare: AsyncIterable<string> = {
      [Symbol.asyncIterator]: () => ({
        next: () => Promise.resolve({ done: false, value: "a" }),
      }),
    };

    const iterator = withStore(bare, TURN, als)[Symbol.asyncIterator]();
    const failure = new Error("cancelled by caller");

    // `throw` with no downstream handler is how a consumer cancels a stream it
    // cannot resume. It has to reject: resolving would report a truncated turn
    // as a complete one.
    await expect(iterator.throw?.(failure)).rejects.toBe(failure);
    expect(als.getStore()).toBeUndefined();
  });

  it("wraps a non-Error value thrown into an Error", async () => {
    const als = freshAls();
    const bare: AsyncIterable<string> = {
      [Symbol.asyncIterator]: () => ({
        next: () => Promise.resolve({ done: false, value: "a" }),
      }),
    };

    const iterator = withStore(bare, TURN, als)[Symbol.asyncIterator]();

    // A rejection reason is not guaranteed to be an Error, and a bare string
    // would leave the host's error classifier with nothing to read. An absent
    // reason has to survive the same wrapping.
    await expect(iterator.throw?.("cancelled-as-string")).rejects.toThrow(
      "cancelled-as-string"
    );
    await expect(iterator.throw?.()).rejects.toThrow("undefined");
  });

  it("re-binds the downstream throw() and runs it inside the store", async () => {
    const als = freshAls();
    let observedInside: string | undefined;
    const downstream = async function* downstream() {
      try {
        yield "a";
      } catch (error) {
        observedInside = als.getStore()?.value;
        throw error;
      }
    };

    const iterator = withStore(downstream(), TURN, als)[Symbol.asyncIterator]();
    // Suspended mid-stream first: a throw at the generator's start would reject
    // without ever entering the body, and would prove nothing about `this`.
    const started = await iterator.next();
    expect(started.value).toBe("a");

    const failure = new Error("downstream-throw");
    // A generator's `throw` only works when called with the generator as the
    // receiver — the wrapper's `.call(iterator, error)` exists for exactly
    // that — and the store has to be bound while it runs, or a cancellation
    // could not reach the request that turn already made.
    await expect(iterator.throw?.(failure)).rejects.toBe(failure);
    expect(observedInside).toBe(TURN.value);
    expect(als.getStore()).toBeUndefined();
  });
});
