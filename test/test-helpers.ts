/**
 * Shared test helpers, fixtures, and predicates for dsh-opencode-patch tests.
 *
 * @module test/test-helpers
 */

import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import os from "node:os";
import nodePath from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as sleep } from "node:timers/promises";

import type { CredentialsWriter } from "../src/cordis-context.ts";
import type { ActiveTurnState } from "../src/index.ts";

/** An in-memory host seam with the same atomic grant path as the real service. */
export const createCredentialsSeam = () => {
  const records = new Map<string, { kind: string; payload: unknown }>();
  const refs = new Map<string, { value: string }>();
  const credentials: CredentialsWriter & {
    modifyRecord: (
      key: string,
      mutate: (current?: unknown) => Promise<unknown>
    ) => Promise<unknown>;
  } = {
    deleteRecord: async (key) => {
      records.delete(key);
    },
    modifyRecord: async (key, mutate) => {
      const next = await mutate(records.get(key));
      if (next === undefined) {
        records.delete(key);
      } else {
        records.set(key, next as { kind: string; payload: unknown });
      }
      return next;
    },
    readRecord: async (key) => records.get(key),
    resolve: async (ref) => refs.get(ref),
    set: async (ref, value) => {
      refs.set(ref, { value });
    },
    unset: async (ref) => {
      refs.delete(ref);
    },
    writeGrant: async (key, payload) => {
      records.set(key, { kind: "grant", payload });
    },
  };
  return {
    credentials,
    ctx: {
      get: (key: string) => (key === "credentials" ? credentials : undefined),
    },
    records,
  };
};

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

/* ------------------------------------------------- OpenCode credential store */

/** One row of the installation's `credential` table, as a fixture. */
export interface FixtureCredential {
  /** The integration the credential belongs to: `opencode`, `opencode-go`, … */
  integrationId: string;
  /** The credential's own name; defaults to the integration id. */
  label?: string;
  /** The secret. A fixture shaped like one, never a real credential. */
  value: string;
  /** `1` for the credential in use, `0` for one the user already replaced. */
  active?: number;
}

/** One row of the installation's `account` table, plus the state that owns it. */
export interface FixtureAccount {
  /** The access token. A fixture shaped like one, never a real credential. */
  accessToken: string;
  /** The account's email; not a secret, and not required. */
  email?: string;
  /** The org the account is active in, written to `account_state`. */
  orgId?: string;
  /** The refresh token, when the fixture should carry one. */
  refreshToken?: string;
  /**
   * The stored expiry, in epoch milliseconds.
   *
   * Deliberately a knob: the plugin uses a stored account whatever this says,
   * and a fixture has to be able to put it in the past to prove that.
   */
  tokenExpiry?: number;
}

/** A credential store the test owns, and the way to point the reader at it. */
export interface FixtureStore {
  /** Set this as `$XDG_DATA_HOME`: the reader resolves its path from it. */
  root: string;
  /** Remove the whole root. Call from `afterEach`. */
  cleanup: () => void;
}

/**
 * Build an OpenCode credential database in a temporary XDG data root.
 *
 * The reader resolves its own path from the environment, so a fixture is not a
 * mock: this writes the real schema to a real SQLite file and hands back the
 * root to export, which is the only thing that makes the store this test's
 * rather than whatever the machine happens to have installed.
 *
 * @param credentials - the rows to insert, in order.
 * @param account - the stored login, when the fixture should have one.
 * @returns the data root and its cleanup.
 */
export const createOpencodeStore = (
  credentials: readonly FixtureCredential[],
  account?: FixtureAccount
): FixtureStore => {
  const root = mkdtempSync(
    nodePath.join(os.tmpdir(), "opencode-store-fixture-")
  );
  const directory = nodePath.join(root, "opencode");
  mkdirSync(directory, { recursive: true });
  const database = new DatabaseSync(nodePath.join(directory, "opencode.db"));
  database.exec(`
    CREATE TABLE credential (
      id TEXT PRIMARY KEY, integration_id TEXT, label TEXT, value TEXT,
      connector_id TEXT, method_id TEXT, active INTEGER,
      time_created INTEGER, time_updated INTEGER
    );
    CREATE TABLE account (
      id TEXT PRIMARY KEY, email TEXT, url TEXT, access_token TEXT,
      refresh_token TEXT, token_expiry INTEGER,
      time_created INTEGER, time_updated INTEGER
    );
    CREATE TABLE account_state (
      id INTEGER PRIMARY KEY, active_account_id TEXT, active_org_id TEXT
    );
  `);
  const insert = database.prepare(
    "INSERT INTO credential (id, integration_id, label, value, active) VALUES (?, ?, ?, ?, ?)"
  );
  for (const [index, credential] of credentials.entries()) {
    insert.run(
      `fixture-${index}`,
      credential.integrationId,
      credential.label ?? credential.integrationId,
      credential.value,
      credential.active ?? 1
    );
  }
  if (account !== undefined) {
    database
      .prepare(
        "INSERT INTO account (id, email, url, access_token, refresh_token, token_expiry) VALUES (?, ?, ?, ?, ?, ?)"
      )
      .run(
        "fixture-account",
        account.email ?? "you@example.com",
        "https://opencode.ai/console",
        account.accessToken,
        account.refreshToken ?? "",
        account.tokenExpiry ?? null
      );
    // The org lives in its own table, and only the active row is read.
    database
      .prepare(
        "INSERT INTO account_state (id, active_account_id, active_org_id) VALUES (?, ?, ?)"
      )
      .run(1, "fixture-account", account.orgId ?? null);
  }
  database.close();
  return {
    cleanup: () => {
      rmSync(root, { force: true, recursive: true });
    },
    root,
  };
};

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
