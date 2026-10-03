/**
 * Shared test helpers, fixtures, and predicates for dsh-opencode-patch tests.
 *
 * @module test/test-helpers
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { readFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";

import type { ActiveTurnState } from "../src/index.ts";

export const SESSION_RE = /^ses_[0-9a-f]{12}[A-Za-z0-9]{14}$/;

export const createMockStream = async function* createMockStream(
  chunk: string
) {
  yield chunk;
};

export const createMockStoreStream = async function* createMockStoreStream(
  als: AsyncLocalStorage<ActiveTurnState>
) {
  yield als.getStore()?.value;
  yield als.getStore()?.value;
};

export const isRecord = (value: unknown): value is Record<string, unknown> => {
  if (value === null || value === undefined) {
    return false;
  }
  if (typeof value !== "object") {
    return false;
  }
  return !Array.isArray(value);
};

export const toolNamesOf = (body: unknown): string[] | undefined => {
  if (!isRecord(body)) {
    return undefined;
  }
  const tools: unknown = body.tools;
  if (!Array.isArray(tools)) {
    return undefined;
  }
  const names: string[] = [];
  for (const tool of tools) {
    if (isRecord(tool) && typeof tool.name === "string") {
      names.push(tool.name);
    }
  }
  return names;
};

export const parseJsonBody = (body: unknown): unknown => {
  if (typeof body !== "string") {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(body);
    return parsed;
  } catch {
    return undefined;
  }
};

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
  return typeof value[Symbol.asyncIterator] === "function";
};

export const collectUnknown = async (
  iterable: AsyncIterable<unknown>
): Promise<unknown[]> => {
  const out: unknown[] = [];
  for await (const chunk of iterable) {
    out.push(chunk);
  }
  return out;
};

export const waitForFileContent = async (
  file: string,
  minLines = 1,
  timeoutMs = 5000
): Promise<string> => {
  const start = Date.now();
  let last = "";
  while (Date.now() - start < timeoutMs) {
    try {
      const content = await readFile(file, "utf-8");
      const lines = content
        .trim()
        .split("\n")
        .filter((l) => l.length > 0);
      if (lines.length >= minLines) {
        return content;
      }
      last = content;
    } catch {
      // not yet written
    }
    await sleep(25);
  }
  throw new Error(
    `timed out waiting for ${minLines} line(s) in ${file} (last: ${JSON.stringify(last)})`
  );
};

export interface Capture {
  init: RequestInit | undefined;
  url: string;
}

export const replacementFetch = (): Promise<Response> =>
  Promise.resolve(new Response("replacement"));

export const createCaptureFetch = (text = "ok") => {
  const capture: Capture = { init: undefined, url: "" };
  const mockFetch = (
    input: RequestInfo | URL,
    init?: RequestInit
  ): Promise<Response> => {
    if (typeof input === "string") {
      capture.url = input;
    } else if (input instanceof URL) {
      capture.url = input.toString();
    } else {
      capture.url = input.url;
    }
    capture.init = init;
    return Promise.resolve(new Response(text));
  };
  return { capture, mockFetch };
};

export const headerOf = (init: RequestInit | undefined, field: string) =>
  new Headers(init?.headers).get(field);

/** No-op disposer: tests register remotes but never tear them down. */
const disposeNoop = (): void => {
  // intentionally empty — nothing to dispose in a test process
};

/**
 * Minimal Cordis-shaped context for services that only need `reflect.provide`
 * to register a remote. Cast is deliberate: the real context is host-owned and
 * unavailable to the test process.
 */
export const createMockContext = () =>
  ({
    // Faithful to Cordis: `provide` returns the disposer that unregisters
    // the contribution.
    reflect: { provide: () => disposeNoop },
  }) as never;
