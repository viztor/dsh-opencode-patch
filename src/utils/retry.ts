/**
 * Generic retry loop over an asynchronous operation that may return undefined or throw.
 *
 * This is a pure algorithm: it takes the operation, the retry limit, the sleep
 * between attempts, an optional liveness probe and an optional logger as
 * parameters. No context, no globals, no I/O — and no clock: the caller owns the
 * wait, and {@link backoffOver} builds the usual one over a timer the caller
 * supplies.
 *
 * @module dsh-opencode-patch/retry
 */

/** A `setTimeout`-shaped scheduler: run `callback` after `delayMs`. */
export type RetryTimer = (callback: () => void, delayMs: number) => unknown;

/** How {@link retryUntilAnswered} retries, and what it may touch. */
export interface RetryOptions {
  /** Maximum number of attempts (defaults to 5). */
  attempts?: number;
  /** Polled before each attempt; returning false aborts. */
  live?: () => boolean;
  /**
   * Takes the attempt index (0-based) and resolves after the delay. Required,
   * because a utility has no clock of its own: pass `backoffOver(timer)` for the
   * default schedule.
   */
  sleep: (attempt: number) => Promise<void>;
  /** Told when every attempt failed with an error; omitted means silent. */
  warn?: (message: string, error: unknown) => void;
}

/**
 * The usual schedule: a linear backoff of `baseMs` per attempt, on `timer`.
 *
 * @param timer - the scheduler the delay runs on.
 * @param baseMs - the first delay; attempt `n` waits `baseMs * (n + 1)`.
 * @returns a `sleep` for {@link RetryOptions}.
 */
export const backoffOver =
  (timer: RetryTimer, baseMs = 300) =>
  (attempt: number): Promise<void> =>
    new Promise((resolve) => {
      timer(resolve, baseMs * (attempt + 1));
    });

/**
 * Attempt to read a defined value until an answer arrives or attempts are exhausted.
 *
 * Each attempt awaits the reader. If the reader resolves a defined value, that value
 * is returned immediately. If the reader returns undefined or throws an error, the attempt
 * is considered unfulfilled:
 * - If `live()` returns false, the loop aborts immediately without further attempts.
 * - Otherwise, it sleeps for the duration determined by `sleep(attempt)` and tries again.
 * - If all attempts are exhausted, it returns `undefined`.
 *
 * @param read - the async reader operation.
 * @param options - the attempt limit, the sleep, the liveness probe and the
 * logger, all owned by the caller.
 * @returns the first defined answer, or `undefined` if unfulfilled.
 */
export const retryUntilAnswered = async <T>(
  read: () => Promise<T | undefined>,
  options: RetryOptions
): Promise<T | undefined> => {
  const attempts = options.attempts ?? 5;
  const live = options.live ?? (() => true);
  const { sleep } = options;
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (!live()) {
      return undefined;
    }
    try {
      // oxlint-disable-next-line no-await-in-loop -- sequential retry by design
      const next = await read();
      if (next !== undefined) {
        return next;
      }
    } catch (error: unknown) {
      lastError = error;
    }
    if (attempt < attempts - 1) {
      // oxlint-disable-next-line no-await-in-loop -- delay between attempts
      await sleep(attempt);
    }
  }
  if (lastError !== undefined) {
    options.warn?.(
      "[dsh-opencode-patch] retry: all attempts failed",
      lastError
    );
  }
  return undefined;
};
