/**
 * Append-only JSONL stream-debug log.
 *
 * Debugging the gateway handshake needs the exact header set per streamed
 * call, which must not spam the regular logger; a configured `debugFile`
 * gets one JSON line per event, and a failed append degrades to a warning
 * instead of failing the turn.
 *
 * @module dsh-opencode-patch/debug
 */

import { appendFile } from "node:fs/promises";

/** The only context capability the debug writer needs. */
export interface DebugContext {
  logger?: { warn?: (msg: string, ...args: unknown[]) => void };
}

/**
 * Append one JSONL entry to the debug file.
 *
 * Never rejects: an unwritable path is reported through `ctx.logger.warn`
 * (or swallowed when the context has no logger).
 *
 * @param ctx - plugin context used only to report write failures.
 * @param file - absolute server-side path to append to.
 * @param entry - JSON-serializable entry; serialized with today's ISO time
 * added by the caller when timing matters.
 */
export const recordDebug = async (
  ctx: DebugContext,
  file: string,
  entry: unknown
): Promise<void> => {
  try {
    await appendFile(file, `${JSON.stringify(entry)}\n`, "utf-8");
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    ctx.logger?.warn?.("[dsh-opencode-patch] debugFile write failed: %s", msg);
  }
};
