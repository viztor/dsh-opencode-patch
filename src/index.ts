import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { appendFile } from "node:fs/promises";

/**
 * Package vs component identity (do not conflate):
 *
 * - npm package `@viztor/dsh-opencode`: the installable unit. The host
 *   resolves a cordis row to `node_modules/<row name>`, so the row's `name`
 *   must equal this string exactly (see cordis.patch.yml).
 * - cordis row: one *instance* of the package. `id` is the instance id and
 *   doubles as the settings namespace the client card binds (`dsh-opencode`).
 *   One package can back N rows with different ids/configs.
 * - `name` below: this component's cordis plugin identity (log lines,
 *   service scoping). It matches the default row id by convention only.
 */
export const name = "dsh-opencode";

export const inject = ["llm"];

export const SESSION_HEADER = "x-opencode-session";
export const OPENCODE_UA =
  "opencode/1.18.33 ai-sdk/provider-utils/4.0.40 runtime/bun/1.3.14";

export const DUMMY_READ_TOOL = {
  description: "Read a file or directory from the local filesystem.",
  name: "read",
  parameters: {
    properties: {
      filePath: {
        description: "The absolute path to the file",
        type: "string",
      },
    },
    required: ["filePath"],
    type: "object",
  },
  type: "function",
} as const;

export const DUMMY_BASH_TOOL = {
  description: "Execute a bash command.",
  name: "bash",
  parameters: {
    properties: {
      command: { description: "The command to execute", type: "string" },
    },
    required: ["command"],
    type: "object",
  },
  type: "function",
} as const;

/** Derive a valid OpenCode session ID (`ses_<12hex><14base62>`) deterministically from a DSH sessionId. */
export const openCodeSessionIdFor = (sessionId: string | number): string => {
  const hash = createHash("sha256").update(String(sessionId)).digest();
  const hexPart = hash.subarray(0, 6).toString("hex");
  const chars =
    "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let randPart = "";
  for (let i = 6; i < 20; i += 1) {
    const byte = hash[i];
    if (byte !== undefined) {
      randPart += chars[byte % chars.length];
    }
  }
  return `ses_${hexPart}${randPart}`;
};

export const DEFAULT_PROVIDERS = ["opencode", "opencode-go"];

export interface PluginConfig {
  debug?: boolean;
  debugFile?: string;
  injectCoreTools?: boolean;
  injectOriginHeaders?: boolean;
  injectUserAgent?: boolean;
  providers?: string[];
  userAgent?: string;
}

export interface ResolvedPluginConfig {
  debug: boolean;
  debugFile?: string;
  injectCoreTools: boolean;
  injectOriginHeaders: boolean;
  injectUserAgent: boolean;
  providers: Set<string>;
  userAgent?: string;
}

export const resolveConfig = (
  config: PluginConfig = {}
): ResolvedPluginConfig => {
  const rawProviders: unknown = config.providers;
  const listed: string[] = Array.isArray(rawProviders)
    ? rawProviders.filter(
        (item: unknown): item is string =>
          typeof item === "string" && item.length > 0
      )
    : [];
  const providers = listed.length > 0 ? listed : [...DEFAULT_PROVIDERS];
  const debug = config.debug === true;
  const rawDebugFile: unknown = config.debugFile;
  const debugFile =
    typeof rawDebugFile === "string" && rawDebugFile.length > 0
      ? rawDebugFile
      : undefined;
  const injectUserAgent = config.injectUserAgent !== false;
  const rawUserAgent: unknown = config.userAgent;
  const userAgent =
    typeof rawUserAgent === "string" && rawUserAgent.trim().length > 0
      ? rawUserAgent.trim()
      : undefined;
  const injectOriginHeaders = config.injectOriginHeaders !== false;
  const injectCoreTools = config.injectCoreTools !== false;

  return {
    debug,
    debugFile,
    injectCoreTools,
    injectOriginHeaders,
    injectUserAgent,
    providers: new Set(providers),
    userAgent,
  };
};

interface DebugContext {
  logger?: { warn?: (msg: string, ...args: unknown[]) => void };
}

const recordDebug = async (
  ctx: DebugContext,
  file: string,
  entry: unknown
): Promise<void> => {
  try {
    await appendFile(file, `${JSON.stringify(entry)}\n`, "utf-8");
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    ctx.logger?.warn?.("[dsh-opencode] debugFile write failed: %s", msg);
  }
};

export const headerValueFor = (
  sessionId: string | number | undefined | null
): string | undefined => {
  if (sessionId === undefined || sessionId === null) {
    return undefined;
  }
  const raw = String(sessionId);
  if (raw.length === 0) {
    return undefined;
  }
  // Always derive: a pure SHA-256 mapping, stable across turns and restarts.
  // There is no uuid passthrough mode — raw DSH UUIDs satisfy no gateway,
  // while derived ses_… values route stably everywhere a UUID would.
  return openCodeSessionIdFor(raw);
};

export interface ActiveTurnState {
  model?: string;
  provider: string;
  value: string;
}

const isAsyncIteratorLike = <T>(value: unknown): value is AsyncIterator<T> => {
  if (value === null || value === undefined) {
    return false;
  }
  if (typeof value !== "object" && typeof value !== "function") {
    return false;
  }
  if (!("next" in value)) {
    return false;
  }
  const next: unknown = value.next;
  return typeof next === "function";
};

const getAsyncIterator = <T>(
  iterable: AsyncIterable<T>
): AsyncIterator<T> | undefined => {
  const candidate: unknown = iterable;
  if (candidate === null || candidate === undefined) {
    return undefined;
  }
  if (typeof candidate !== "object" && typeof candidate !== "function") {
    return undefined;
  }
  if (!(Symbol.asyncIterator in candidate)) {
    return undefined;
  }
  const factory: unknown = candidate[Symbol.asyncIterator];
  if (typeof factory !== "function") {
    return undefined;
  }
  const iterator: unknown = factory.call(candidate);
  if (!isAsyncIteratorLike<T>(iterator)) {
    return undefined;
  }
  return iterator;
};

const isAsyncIterableLike = (
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
  const factory: unknown = value[Symbol.asyncIterator];
  return typeof factory === "function";
};

const isRecord = (value: unknown): value is Record<string, unknown> => {
  if (value === null || value === undefined) {
    return false;
  }
  if (typeof value !== "object") {
    return false;
  }
  if (Array.isArray(value)) {
    return false;
  }
  return true;
};

const isUnknownArray = (value: unknown): value is unknown[] =>
  Array.isArray(value);

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

const extractUrl = (input: RequestInfo | URL): string => {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.toString();
  }
  if (typeof input === "object" && input !== null && "url" in input) {
    const urlProp: unknown = input.url;
    if (typeof urlProp === "string") {
      return urlProp;
    }
    if (urlProp instanceof URL) {
      return urlProp.toString();
    }
  }
  return "";
};

const readHeaderSource = (
  input: RequestInfo | URL,
  init?: RequestInit
): HeadersInit | undefined => {
  if (init?.headers !== undefined) {
    return init.headers;
  }
  if (typeof Request !== "undefined" && input instanceof Request) {
    return input.headers;
  }
  return undefined;
};

export const hasSessionHeader = (
  input: RequestInfo | URL,
  init?: RequestInit
): boolean => {
  const source = readHeaderSource(input, init);
  if (source === undefined) {
    return false;
  }
  try {
    return new Headers(source).has(SESSION_HEADER);
  } catch {
    return false;
  }
};

/** Determines if a request targets an OpenCode API endpoint. */
export const isOpenCodeRequest = (
  url: string,
  state: ActiveTurnState | undefined,
  providers: Set<string>
): boolean => {
  if (url.includes("opencode.ai/zen")) {
    return true;
  }
  if (state !== undefined && providers.has(state.provider)) {
    return true;
  }
  return false;
};

const defaultSessionId = (): string => {
  const envId: unknown = process.env.OPENCODE_SESSION_ID;
  if (typeof envId === "string" && envId.length > 0) {
    return envId;
  }
  return openCodeSessionIdFor("default");
};

const toolNames = (
  tools: unknown[]
): { hasBash: boolean; hasRead: boolean } => {
  let hasBash = false;
  let hasRead = false;
  for (const tool of tools) {
    if (!isRecord(tool)) {
      continue;
    }
    const toolName: unknown = tool.name;
    if (toolName === "read") {
      hasRead = true;
    }
    if (toolName === "bash") {
      hasBash = true;
    }
  }
  return { hasBash, hasRead };
};

const maybeInjectCoreTools = (
  url: string,
  body: RequestInit["body"],
  headers: Headers,
  injectCoreTools: boolean
): RequestInit["body"] => {
  if (!injectCoreTools) {
    return body;
  }
  if (!url.includes("/responses")) {
    return body;
  }
  if (body === undefined || body === null) {
    return body;
  }
  let bodyStr: string | undefined;
  if (typeof body === "string") {
    bodyStr = body;
  } else if (Buffer.isBuffer(body)) {
    bodyStr = body.toString("utf-8");
  } else {
    return body;
  }
  if (bodyStr.length === 0) {
    return body;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyStr);
  } catch {
    return body;
  }
  if (!isRecord(parsed)) {
    return body;
  }
  const modelProp: unknown = parsed.model;
  if (typeof modelProp !== "string" || !modelProp.includes("free")) {
    return body;
  }
  const toolsProp: unknown = parsed.tools;
  let tools: unknown[];
  if (toolsProp === undefined) {
    tools = [];
  } else if (isUnknownArray(toolsProp)) {
    tools = [...toolsProp];
  } else {
    tools = [];
  }
  const { hasBash, hasRead } = toolNames(tools);
  if (!hasRead) {
    tools.push(DUMMY_READ_TOOL);
  }
  if (!hasBash) {
    tools.push(DUMMY_BASH_TOOL);
  }
  parsed.tools = tools;
  const newBodyStr = JSON.stringify(parsed);
  headers.set("content-length", Buffer.byteLength(newBodyStr).toString());
  return newBodyStr;
};

const isFetchFunction = (value: unknown): value is typeof fetch =>
  typeof value === "function";

export const patchFetch = (
  original: typeof fetch,
  als: AsyncLocalStorage<ActiveTurnState>,
  config: ResolvedPluginConfig
): typeof fetch => {
  const patchedFetch = function patchedFetch(
    this: unknown,
    input: RequestInfo | URL,
    init?: RequestInit
  ): Promise<Response> {
    const state = als.getStore();
    const url = extractUrl(input);

    if (!isOpenCodeRequest(url, state, config.providers)) {
      return original.call(this, input, init);
    }

    const headers = new Headers(readHeaderSource(input, init));

    // 1. Session header: ALWAYS injected for OpenCode requests
    if (state === undefined) {
      const existing = headers.get(SESSION_HEADER);
      if (existing === null || !existing.startsWith("ses_")) {
        headers.set(SESSION_HEADER, defaultSessionId());
      }
    } else {
      headers.set(SESSION_HEADER, state.value);
    }

    // 2. User-Agent: injected / restored when enabled, with user override support
    if (config.injectUserAgent) {
      headers.set("User-Agent", config.userAgent ?? OPENCODE_UA);
    }

    // 3. Client & Project origin headers: injected when enabled
    if (config.injectOriginHeaders) {
      headers.set("x-opencode-client", "cli");
      headers.set("x-opencode-project", "global");
    }

    const newInit: RequestInit = { ...init, headers };

    // 4. Core tool schema fallback for free-tier /responses models
    if (init?.body !== undefined) {
      const newBody = maybeInjectCoreTools(
        url,
        init.body,
        headers,
        config.injectCoreTools
      );
      if (newBody !== init.body) {
        newInit.body = newBody;
      }
    }
    return original.call(this, input, newInit);
  };
  return patchedFetch;
};

export interface CordisContext {
  effect?: (fn: () => unknown, name?: string) => void;
  logger?: {
    info?: (msg: string, ...args: unknown[]) => void;
    warn?: (msg: string, ...args: unknown[]) => void;
  };
  on?: (
    event: string,
    callback: (
      options: unknown,
      next: () => unknown,
      ...rest: unknown[]
    ) => unknown,
    options?: { prepend?: boolean }
  ) => void;
}

interface StreamOptions {
  model?: unknown;
  provider?: unknown;
  sessionId?: unknown;
}

const isStreamOptions = (value: unknown): value is StreamOptions =>
  typeof value === "object" && value !== null;

export const apply = (
  ctx: CordisContext,
  rawConfig: PluginConfig = {}
): void => {
  const config = resolveConfig(rawConfig);
  const { debug, debugFile, providers } = config;
  const als = new AsyncLocalStorage<ActiveTurnState>();

  const originalFetch: unknown = globalThis.fetch;
  if (!isFetchFunction(originalFetch)) {
    ctx.logger?.warn?.(
      "[dsh-opencode] globalThis.fetch is unavailable; cannot inject x-opencode-session"
    );
    return;
  }

  const patched = patchFetch(originalFetch, als, config);

  ctx.effect?.(() => {
    globalThis.fetch = patched;
    ctx.logger?.info?.(
      "[dsh-opencode] active for providers [%s]",
      [...providers].join(", ")
    );
    return () => {
      if (globalThis.fetch === patched) {
        globalThis.fetch = originalFetch;
      }
    };
  }, "dsh-opencode.fetch-patch");

  ctx.on?.(
    "llm/stream",
    (options: unknown, next: () => unknown) => {
      if (!isStreamOptions(options)) {
        return next();
      }
      const providerProp: unknown = options.provider;
      if (
        typeof providerProp !== "string" &&
        typeof providerProp !== "number"
      ) {
        return next();
      }
      const providerKey = String(providerProp);
      if (!providers.has(providerKey)) {
        return next();
      }
      const sessionProp: unknown = options.sessionId;
      if (typeof sessionProp !== "string" && typeof sessionProp !== "number") {
        return next();
      }
      const rawSession = String(sessionProp);
      if (rawSession.length === 0) {
        return next();
      }
      const value = headerValueFor(rawSession);
      if (value === undefined) {
        return next();
      }

      const downstream: unknown = next();
      if (!isAsyncIterableLike(downstream)) {
        return downstream;
      }

      if (debug || debugFile !== undefined) {
        const entry = {
          header: SESSION_HEADER,
          model: options.model,
          provider: providerKey,
          session: rawSession,
          ts: new Date().toISOString(),
          value,
        };
        if (debugFile !== undefined) {
          void recordDebug(ctx, debugFile, entry);
        }
        if (debug) {
          ctx.logger?.info?.(
            '[dsh-opencode] streaming provider "%s" with %s=%s',
            providerKey,
            SESSION_HEADER,
            value
          );
        }
      }
      const modelProp: unknown = options.model;
      return withStore(
        downstream,
        {
          model: typeof modelProp === "string" ? modelProp : undefined,
          provider: providerKey,
          value,
        },
        als
      );
    },
    { prepend: true }
  );
};

export default { apply, inject, name };
