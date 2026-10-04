/**
 * `debug.ts` — the append-only JSONL stream-debug log.
 *
 * The contract worth pinning is the failure path: a debug write must NEVER
 * fail a turn, whatever the path or the logger look like. The success path is
 * asserted against a real temporary file so the line format (one JSON object
 * per line, newline-terminated) is verified rather than assumed.
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { recordDebug } from "../src/debug.ts";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "dsh-opencode-debug-"));
});

afterEach(async () => {
  await rm(dir, { force: true, recursive: true });
});

describe("recordDebug", () => {
  it("appends one JSON line per entry", async () => {
    const file = join(dir, "stream.jsonl");
    await recordDebug({}, file, { session: "ses_a", value: 1 });
    await recordDebug({}, file, { session: "ses_b", value: 2 });

    const text = await readFile(file, "utf-8");
    const lines = text.split("\n").filter((line) => line.length > 0);
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0] ?? "")).toEqual({ session: "ses_a", value: 1 });
    expect(JSON.parse(lines[1] ?? "")).toEqual({ session: "ses_b", value: 2 });
    // Every line is newline-terminated, so a partial write never merges rows.
    expect(text.endsWith("\n")).toBe(true);
  });

  it("creates the file when it does not exist yet", async () => {
    const file = join(dir, "nested-not-created", "stream.jsonl");
    const warn = vi.fn<(...args: unknown[]) => void>();

    // The parent directory is missing: this must warn, not throw.
    await expect(
      recordDebug({ logger: { warn } }, file, { a: 1 })
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledOnce();
    const [message] = warn.mock.calls[0] ?? [];
    expect(String(message)).toContain("debugFile write failed");
  });

  it("reports a write failure through the logger instead of rejecting", async () => {
    const warn = vi.fn<(...args: unknown[]) => void>();
    // A directory is not writable as a file.
    await expect(
      recordDebug({ logger: { warn } }, dir, { a: 1 })
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0]?.[0])).toBe(
      "[dsh-opencode-patch] debugFile write failed: %s"
    );
  });

  it("stays silent and resolves when the context has no logger", async () => {
    await expect(recordDebug({}, dir, { a: 1 })).resolves.toBeUndefined();
    await expect(
      recordDebug({ logger: {} }, dir, { a: 1 })
    ).resolves.toBeUndefined();
  });

  it("serializes a non-Error throw as a string message", async () => {
    // A path whose parent is a file (not a directory) fails with ENOTDIR.
    const file = join(dir, "plain.txt");
    await recordDebug({}, file, { ok: true });
    const warn = vi.fn<(...args: unknown[]) => void>();
    await recordDebug({ logger: { warn } }, join(file, "child.jsonl"), {
      a: 1,
    });
    expect(warn).toHaveBeenCalledOnce();
    const [, detail] = warn.mock.calls[0] ?? [];
    assert.ok(typeof detail === "string" && detail.length > 0);
  });
});
