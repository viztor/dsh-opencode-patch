import { describe, expect, it, vi } from "vitest";

import {
  backoffOver,
  retryUntilAnswered,
  type RetryOptions,
  type RetryTimer,
} from "./support/src.ts";

describe("utils/retry: retryUntilAnswered", () => {
  const noSleep = () => Promise.resolve();

  const run = <T>(
    read: () => Promise<T | undefined>,
    attempts: number,
    extra: Partial<RetryOptions> = {}
  ): Promise<T | undefined> =>
    retryUntilAnswered(read, {
      attempts,
      sleep: noSleep,
      ...extra,
    });

  it("returns the first answer without retrying when immediately defined", async () => {
    let calls = 0;
    const read = () => {
      calls += 1;
      return Promise.resolve("ready");
    };
    const result = await run(read, 5);
    expect(result).toBe("ready");
    expect(calls).toBe(1);
  });

  it("retries when read returns undefined until an answer arrives", async () => {
    let calls = 0;
    const read = () => {
      calls += 1;
      return Promise.resolve(calls < 3 ? undefined : "finally");
    };
    const result = await run(read, 5);
    expect(result).toBe("finally");
    expect(calls).toBe(3);
  });

  it("retries when read throws an error on intermediate attempts and returns answer", async () => {
    let calls = 0;
    const read = () => {
      calls += 1;
      if (calls === 1) {
        throw new Error("transient socket glitch");
      }
      if (calls === 2) {
        return Promise.reject(new Error("cold-start timeout"));
      }
      return Promise.resolve("recovered");
    };
    const result = await run(read, 5);
    expect(result).toBe("recovered");
    expect(calls).toBe(3);
  });

  it("returns undefined after exhausting all attempts when read continuously returns undefined", async () => {
    let calls = 0;
    const read = async () => {
      calls += 1;
    };
    const result = await run(read, 4);
    expect(result).toBeUndefined();
    expect(calls).toBe(4);
  });

  it("returns undefined and tells the caller's logger when all attempts throw errors", async () => {
    let calls = 0;
    const warn = vi.fn<(message: string, error: unknown) => void>();
    const read = () => {
      calls += 1;
      return Promise.reject(new Error("repeated outage"));
    };
    const result = await run(read, 3, { warn });
    expect(result).toBeUndefined();
    expect(calls).toBe(3);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      "[dsh-opencode-patch] retry: all attempts failed",
      expect.any(Error)
    );
  });

  it("stays silent when every attempt throws and no logger is supplied", async () => {
    // Silence is the claim, so the console is watched: a fallback to
    // `console.warn` when `warn` is omitted would answer the same result.
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    try {
      let calls = 0;
      const read = () => {
        calls += 1;
        return Promise.reject(new Error("repeated outage"));
      };
      await expect(run(read, 2)).resolves.toBeUndefined();
      expect(calls).toBe(2);
      expect(consoleWarn).not.toHaveBeenCalled();
      expect(consoleError).not.toHaveBeenCalled();
    } finally {
      consoleWarn.mockRestore();
      consoleError.mockRestore();
    }
  });

  it("aborts early without calling sleep or further attempts when live() returns false initially", async () => {
    let calls = 0;
    const sleep = vi.fn(() => Promise.resolve());
    const read = async () => {
      calls += 1;
      return "unreached";
    };
    const result = await run(read, 5, { live: () => false, sleep });
    expect(result).toBeUndefined();
    expect(calls).toBe(0);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("aborts during retry progression when live() transitions to false", async () => {
    let calls = 0;
    let alive = true;
    const read = async () => {
      calls += 1;
      alive = false;
    };
    const result = await run(read, 5, { live: () => alive });
    expect(result).toBeUndefined();
    expect(calls).toBe(1);
  });

  it("defaults to five attempts", async () => {
    let calls = 0;
    const read = async () => {
      calls += 1;
    };
    const result = await retryUntilAnswered(read, { sleep: noSleep });
    expect(result).toBeUndefined();
    expect(calls).toBe(5);
  });

  it("waits on the schedule backoffOver builds over the caller's timer", async () => {
    // No wall clock: the timer runs its callback at once and records the delay
    // it was asked for, so the default schedule is observed rather than waited.
    let calls = 0;
    const delays: number[] = [];
    const immediateTimer: RetryTimer = (callback, delayMs) => {
      delays.push(delayMs);
      callback();
    };
    const read = () => {
      calls += 1;
      return Promise.resolve(calls < 2 ? undefined : "done");
    };
    const result = await retryUntilAnswered(read, {
      attempts: 2,
      sleep: backoffOver(immediateTimer),
    });
    expect(result).toBe("done");
    expect(calls).toBe(2);
    expect(delays).toEqual([300]);
  });
});

describe("utils/retry: backoffOver", () => {
  /** A timer that records each request and runs nothing until told to. */
  const recordingTimer = () => {
    const scheduled: { callback: () => void; delayMs: number }[] = [];
    const timer: RetryTimer = (callback, delayMs) => {
      scheduled.push({ callback, delayMs });
    };
    return { scheduled, timer };
  };

  it("schedules a linear backoff and resolves only when the timer fires", async () => {
    const { scheduled, timer } = recordingTimer();
    const sleep = backoffOver(timer);
    const settled: number[] = [];
    const pending = [0, 1, 2].map((attempt) =>
      sleep(attempt).then(() => {
        settled.push(attempt);
      })
    );

    expect(scheduled.map((entry) => entry.delayMs)).toEqual([300, 600, 900]);
    await Promise.resolve();
    expect(settled).toEqual([]);

    scheduled[1]?.callback();
    await pending[1];
    expect(settled).toEqual([1]);

    scheduled[0]?.callback();
    scheduled[2]?.callback();
    await Promise.all(pending);
    expect(settled.toSorted((a, b) => a - b)).toEqual([0, 1, 2]);
  });

  it("takes its base delay as a parameter", () => {
    const { scheduled, timer } = recordingTimer();
    const sleep = backoffOver(timer, 100);
    void sleep(0);
    void sleep(1);
    expect(scheduled.map((entry) => entry.delayMs)).toEqual([100, 200]);
  });
});
