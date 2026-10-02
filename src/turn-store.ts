/**
 * Turn-scoped context carried across a streamed `llm/stream` turn.
 *
 * The fetch patch runs deep inside the LLM adapter's request path, long after
 * the `llm/stream` handler returned; `AsyncLocalStorage` is what lets it see
 * the session id of the turn that owns the request instead of guessing.
 *
 * @module dsh-opencode-patch/turn-store
 */

import type { AsyncLocalStorage } from "node:async_hooks";

import { getAsyncIterator } from "./guards.ts";

/** What one active streamed turn contributes to outgoing requests. */
export interface ActiveTurnState {
  model?: string;
  provider: string;
  value: string;
}

/**
 * Drive an async iterable while the turn state is registered in the store.
 *
 * Deliberately synchronous in shape: the wrapper functions return promises
 * without awaiting anything first, so `AsyncLocalStorage.run` binds the turn
 * without an extra async tick that would widen the context window.
 *
 * @param iterable - the downstream stream to carry the store across.
 * @param store - turn state visible to every `next`/`throw` call.
 * @param als - the store's AsyncLocalStorage instance.
 */
export const withStore = <T>(
  iterable: AsyncIterable<T>,
  store: ActiveTurnState,
  als: AsyncLocalStorage<ActiveTurnState>
): AsyncIterable<T> => {
  const iterator = getAsyncIterator(iterable);
  if (iterator === undefined) {
    return iterable;
  }
  const asyncIteratorObj: AsyncIterator<T, unknown, unknown> = {
    next: (): Promise<IteratorResult<T, unknown>> =>
      als.run(store, () => iterator.next()),
    return: (value?: unknown): Promise<IteratorResult<T, unknown>> => {
      if (typeof iterator.return === "function") {
        return iterator.return(value).catch(() => ({ done: true, value }));
      }
      return Promise.resolve({ done: true, value });
    },
    throw: (error?: unknown): Promise<IteratorResult<T, unknown>> => {
      if (typeof iterator.throw !== "function") {
        const err = error instanceof Error ? error : new Error(String(error));
        return Promise.reject(err);
      }
      // oxlint-disable-next-line typescript/unbound-method -- capture guarded method then rebind via .call to keep `this`
      const throwMethod = iterator.throw;
      return als.run(store, () => throwMethod.call(iterator, error));
    },
  };
  return {
    [Symbol.asyncIterator]() {
      return asyncIteratorObj;
    },
  };
};
