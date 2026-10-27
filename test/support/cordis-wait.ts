/**
 * The two context-only helpers every real-context test shares: a deadline
 * wait ({@link until}) and a capture of every logger line ({@link logLines}).
 *
 * They need nothing but a cordis `Context`, so they live apart from the
 * real-host harness (`host.ts`, which re-exports them): a unit file that
 * mounts the plugin on a bare `Context` (`composition.ts`) loads no host
 * package through them.
 *
 * @module test/support/cordis-wait
 */
import type { Context } from "@deepseek-ai/cordis";

/**
 * cordis `FiberState`: the three states a booted row settles in. cordis
 * declares it a `const enum`, which isolated transpilation cannot import at
 * runtime, so the values are mirrored here (as `src/host/route-claim.ts`
 * mirrors `ACTIVE`).
 */
export const FIBER_STATE = { ACTIVE: 2, DISPOSED: 4, FAILED: 3 } as const;

/**
 * Poll until `predicate` holds, or fail by name: the harness's one wait, with a
 * deadline rather than a fixed sleep.
 *
 * @param predicate - the condition, sync or async.
 * @param what - what is awaited, named in the failure.
 * @param deadlineMs - how long to wait before failing.
 */
export const until = async (
  predicate: () => boolean | Promise<boolean>,
  what: string,
  deadlineMs = 10_000
): Promise<void> => {
  const end = Date.now() + deadlineMs;
  while (!(await predicate())) {
    if (Date.now() > end) {
      throw new Error(`never happened: ${what}`);
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
  }
};

/**
 * Every line any logger writes from now on, at every level.
 *
 * cordis's own exporter buffers only up to `info` (its default threshold, so
 * a `warn` is never kept), and tier B adds no console exporter: nothing a
 * plugin logs reaches the console or the default buffer reliably. This
 * exporter takes every level, so an assertion about what was logged reads
 * what was actually logged. A case should log one line of its own through it
 * to prove the input is read.
 *
 * @param root - the host's root context.
 * @returns the lines (`<type> <name>: <args>`) and the exporter's removal.
 */
export const logLines = (
  root: Context
): { readonly lines: () => string[]; readonly dispose: () => void } => {
  const lines: string[] = [];
  const logger = root.logger as unknown as {
    exporter: (exporter: {
      levels: { default: number };
      export: (message: {
        type: string;
        name: string;
        args: unknown[];
      }) => void;
    }) => () => void;
  };
  const off = logger.exporter({
    export: (message) => {
      lines.push(
        `${message.type} ${message.name}: ${message.args.map(String).join(" ")}`
      );
    },
    levels: { default: 3 },
  });
  return {
    dispose: () => {
      off();
    },
    lines: () => [...lines],
  };
};
