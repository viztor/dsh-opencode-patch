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

import { getAsyncIterator } from "./utils/guards.ts";

/** What one active streamed turn contributes to outgoing requests. */
export interface ActiveTurnState {
  /**
   * A turn on a plane pi-ai serves for another plugin (D27): every request it
   * issues is that plugin's, and the fetch patch passes it through untouched,
   * whatever its URL. No other field is read for such a turn.
   */
  foreign?: true;
  model?: string;
  parentValue?: string;
  project?: string;
  provider: string;
  /**
   * The `x-opencode-request` value for the turn: the id of the user message the
   * turn answers, in the client's own `msg_` shape. Minted once per turn
   * (`newOpenCodeMessageId` in `session.ts`) so every request the turn issues
   * carries one id, as the client's own do; absent for requests issued outside
   * any tracked turn — the usage and discovery calls — which send no such
   * header.
   */
  requestValue?: string;
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
