/**
 * Shared test helpers, fixtures, and predicates for dsh-opencode-patch tests.
 *
 * @module test/test-helpers
 */

import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { readFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";

import type { ActiveTurnState } from "./support/src.ts";

export const SESSION_RE = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/;

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

/**
 * The oracle's own object guard. Not exported: a test takes `isRecord` from the
 * door, and this file cannot, because the jsdom tests import it and must not
 * load the host graph the door re-exports.
 */
const isRecord = (value: unknown): value is Record<string, unknown> => {
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
    if (!isRecord(tool)) {
      continue;
    }
    if (typeof tool.name === "string") {
      names.push(tool.name);
      continue;
    }
    // OpenAI-compatible nesting: { type: "function", function: { name } }.
    const fn: unknown = tool.function;
    if (isRecord(fn) && typeof fn.name === "string") {
      names.push(fn.name);
    }
  }
  return names;
};

/** The URL a `fetch` input names, whichever of its three shapes it is. */
export const urlOf = (input: RequestInfo | URL): string => {
  if (typeof input === "string") {
    return input;
  }
  return input instanceof URL ? input.href : input.url;
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
    capture.url = urlOf(input);
    capture.init = init;
    return Promise.resolve(new Response(text));
  };
  return { capture, mockFetch };
};

export const headerOf = (init: RequestInit | undefined, field: string) =>
  new Headers(init?.headers).get(field);

/* ------------------------------------------------ React element tree helpers */

/**
 * A React element as the jsx runtime builds it.
 *
 * The settings card and the quota meter are asserted by walking the element
 * tree their function components return — no DOM, no renderer. `type` is the
 * component function or an intrinsic tag; `props.children` carries the
 * subtree.
 */
export interface TestElement {
  props: { children?: unknown; [key: string]: unknown };
  type: unknown;
}

export const isElement = (node: unknown): node is TestElement =>
  typeof node === "object" &&
  node !== null &&
  "type" in node &&
  "props" in node &&
  typeof (node as { props: unknown }).props === "object";

/** The name a component or intrinsic tag renders under. */
export const elementName = (type: unknown): string => {
  if (typeof type === "string") {
    return type;
  }
  if (typeof type === "function") {
    return type.name || "fn";
  }
  return String(type);
};

/** An element's children as a flat list, however the runtime nested them. */
export const childrenOf = (node: TestElement): unknown[] => {
  const flat: unknown[] = [];
  const walk = (value: unknown): void => {
    // React flattens nested child arrays and drops the values it renders as
    // nothing, so the traversal must too — otherwise a `.map()`ed option list
    // is invisible to these helpers.
    if (Array.isArray(value)) {
      for (const child of value) {
        walk(child);
      }
      return;
    }
    if (value === undefined || value === null || typeof value === "boolean") {
      return;
    }
    flat.push(value);
  };
  walk(node.props.children);
  return flat;
};

/** Every element named `type`, in document order. */
export const findAll = (
  node: unknown,
  type: string,
  acc: TestElement[] = []
): TestElement[] => {
  if (!isElement(node)) {
    return acc;
  }
  if (elementName(node.type) === type) {
    acc.push(node);
  }
  for (const child of childrenOf(node)) {
    findAll(child, type, acc);
  }
  return acc;
};

/** Every element whose name is in `types`, in document order. */
export const findAllOf = (
  node: unknown,
  types: ReadonlySet<string>,
  acc: TestElement[] = []
): TestElement[] => {
  if (!isElement(node)) {
    return acc;
  }
  if (types.has(elementName(node.type))) {
    acc.push(node);
  }
  for (const child of childrenOf(node)) {
    findAllOf(child, types, acc);
  }
  return acc;
};

/** The first element named `type`; throws when the tree has none. */
export const firstOf = (tree: unknown, type: string): TestElement => {
  const [found] = findAll(tree, type);
  assert.ok(found, `expected a ${type} in the tree`);
  return found;
};

/** Every element satisfying `predicate`, in document order. */
export const findAllWhere = (
  node: unknown,
  predicate: (element: TestElement) => boolean,
  acc: TestElement[] = []
): TestElement[] => {
  if (!isElement(node)) {
    return acc;
  }
  if (predicate(node)) {
    acc.push(node);
  }
  for (const child of childrenOf(node)) {
    findAllWhere(child, predicate, acc);
  }
  return acc;
};

/** Every string or number rendered anywhere in the subtree, in order. */
export const collectText = (node: unknown, acc: string[] = []): string[] => {
  if (typeof node === "string" || typeof node === "number") {
    acc.push(String(node));
    return acc;
  }
  if (Array.isArray(node)) {
    for (const child of node) {
      collectText(child, acc);
    }
    return acc;
  }
  if (!isElement(node)) {
    return acc;
  }
  for (const child of childrenOf(node)) {
    collectText(child, acc);
  }
  return acc;
};
