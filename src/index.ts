import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { appendFile } from "node:fs/promises";

export const name = "opencode-go-session-header";

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
  mode?: "session-id" | "uuid";
  providers?: string[];
}

export interface ResolvedPluginConfig {
  debug: boolean;
  debugFile?: string;
  mode: "session-id" | "uuid";
  providers: Set<string>;
}

export const resolveConfig = (
  config: PluginConfig = {}
): ResolvedPluginConfig => {
  const providers =
    Array.isArray(config.providers) && config.providers.length > 0
      ? config.providers.map(String)
      : [...DEFAULT_PROVIDERS];
  const mode = config.mode === "uuid" ? "uuid" : "session-id";
  const debug = config.debug === true;
  const debugFile =
    typeof config.debugFile === "string" && config.debugFile.length > 0
      ? config.debugFile
      : undefined;
  return { debug, debugFile, mode, providers: new Set(providers) };
};

const recordDebug = async (
  ctx: { logger?: { warn?: (msg: string, ...args: unknown[]) => void } },
  file: string,
  entry: unknown
): Promise<void> => {
  try {
    await appendFile(file, `${JSON.stringify(entry)}\n`, "utf-8");
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    ctx.logger?.warn?.(
      "[opencode-go-session-header] debugFile write failed: %s",
      msg
    );
  }
};

export const headerValueFor = (
  sessionId: string | number | undefined | null,
  _mode: string,
  table: Map<string, string>
): string | undefined => {
  if (sessionId === undefined || sessionId === null) {
    return undefined;
  }
  const raw = String(sessionId);
  if (raw.length === 0) {
    return undefined;
  }
  let value = table.get(raw);
  if (value === undefined) {
    value = openCodeSessionIdFor(raw);
    table.set(raw, value);
  }
  return value;
};

export const withStore = <T>(
  iterable: AsyncIterable<T>,
  store: { value: string },
  als: AsyncLocalStorage<{ value: string }>
): AsyncIterable<T> => {
  const iterator = (
    iterable as unknown as Record<symbol, () => AsyncIterator<T>>
  )[Symbol.asyncIterator]?.();
  if (!iterator) {
    return iterable;
  }
  const asyncIteratorObj: AsyncIterator<T> = {
    async next() {
      return als.run(store, async () => iterator.next());
    },
    async return(value?: unknown) {
      if (typeof iterator.return === "function") {
        try {
          return await iterator.return(value);
        } catch {
          // Downstream stream may already be torn down
        }
      }
      return { done: true, value } as IteratorReturnResult<unknown>;
    },
    async throw(error?: unknown) {
      if (typeof iterator.throw === "function") {
        return als.run(store, async () => {
          if (typeof iterator.throw === "function") {
            return iterator.throw(error);
          }
          const err = error instanceof Error ? error : new Error(String(error));
          throw err;
        });
      }
      const err = error instanceof Error ? error : new Error(String(error));
      throw err;
    },
  };
  return {
    [Symbol.asyncIterator]() {
      return asyncIteratorObj;
    },
  };
};

export const hasSessionHeader = (
  input: RequestInfo | URL,
  init?: RequestInit
): boolean => {
  const source =
    init?.headers ??
    (typeof Request !== "undefined" && input instanceof Request
      ? input.headers
      : undefined);
  if (source === undefined) {
    return false;
  }
  try {
    return new Headers(source).has(SESSION_HEADER);
  } catch {
    return false;
  }
};

export const patchFetch = (
  original: typeof fetch,
  als: AsyncLocalStorage<{ value: string }>
): typeof fetch =>
  function patchedFetch(
    this: unknown,
    input: RequestInfo | URL,
    init?: RequestInit
  ): Promise<Response> {
    const state = als.getStore();
    let url = "";
    if (typeof input === "string") {
      url = input;
    } else if (input && typeof input === "object" && "url" in input) {
      url = String((input as { url: unknown }).url);
    }

    if (url.includes("opencode.ai/zen")) {
      const headers = new Headers(
        init?.headers ??
          (typeof Request !== "undefined" && input instanceof Request
            ? input.headers
            : undefined)
      );
      headers.set("User-Agent", OPENCODE_UA);
      headers.set("x-opencode-client", "cli");
      headers.set("x-opencode-project", "global");
      if (state) {
        headers.set(SESSION_HEADER, state.value);
      } else {
        const existing = headers.get(SESSION_HEADER);
        if (!existing?.startsWith("ses_")) {
          headers.set(
            SESSION_HEADER,
            process.env.OPENCODE_SESSION_ID ?? openCodeSessionIdFor("default")
          );
        }
      }

      const newInit: RequestInit = { ...init, headers };
      if (url.includes("/responses") && init?.body) {
        try {
          let bodyStr: string | null = null;
          if (typeof init.body === "string") {
            bodyStr = init.body;
          } else if (Buffer.isBuffer(init.body)) {
            bodyStr = (init.body as Buffer).toString("utf-8");
          }
          if (bodyStr && bodyStr.length > 0) {
            const bodyObj = JSON.parse(bodyStr) as {
              model?: unknown;
              tools?: { name?: unknown }[];
            };
            if (
              typeof bodyObj.model === "string" &&
              bodyObj.model.includes("free")
            ) {
              if (!Array.isArray(bodyObj.tools)) {
                bodyObj.tools = [];
              }
              const hasRead = bodyObj.tools.some((t) => t.name === "read");
              const hasBash = bodyObj.tools.some((t) => t.name === "bash");
              if (!hasRead) {
                bodyObj.tools.push(DUMMY_READ_TOOL);
              }
              if (!hasBash) {
                bodyObj.tools.push(DUMMY_BASH_TOOL);
              }
              const newBodyStr = JSON.stringify(bodyObj);
              newInit.body = newBodyStr;
              headers.set(
                "content-length",
                Buffer.byteLength(newBodyStr).toString()
              );
            }
          }
        } catch {
          // ignore parsing error
        }
      }
      return original.call(this, input, newInit);
    }

    if (state && !hasSessionHeader(input, init)) {
      const headers = new Headers(
        init?.headers ??
          (typeof Request !== "undefined" && input instanceof Request
            ? input.headers
            : undefined)
      );
      headers.set(SESSION_HEADER, state.value);
      return original.call(this, input, { ...init, headers });
    }
    return original.call(this, input, init);
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

export const apply = (ctx: CordisContext, config: PluginConfig = {}): void => {
  const { debug, debugFile, mode, providers } = resolveConfig(config);
  const als = new AsyncLocalStorage<{ value: string }>();
  const uuidBySession = new Map<string, string>();

  const originalFetch = globalThis.fetch;
  if (typeof originalFetch !== "function") {
    ctx.logger?.warn?.(
      "[opencode-go-session-header] globalThis.fetch is unavailable; cannot inject x-opencode-session"
    );
    return;
  }

  const patched = patchFetch(originalFetch, als);

  ctx.effect?.(() => {
    globalThis.fetch = patched;
    ctx.logger?.info?.(
      "[opencode-go-session-header] active for providers [%s] with mode %s",
      [...providers].join(", "),
      mode
    );
    return () => {
      if (globalThis.fetch === patched) {
        globalThis.fetch = originalFetch;
      }
    };
  }, "opencode-go-session-header.fetch-patch");

  ctx.on?.(
    "llm/stream",
    (options: unknown, next: () => unknown) => {
      if (!options || typeof options !== "object") {
        return next();
      }
      const opts = options as {
        model?: unknown;
        provider?: unknown;
        sessionId?: unknown;
      };
      const { model, provider, sessionId } = opts;
      if (!providers.has(String(provider))) {
        return next();
      }
      if (typeof sessionId !== "string" && typeof sessionId !== "number") {
        return next();
      }
      const rawSession = String(sessionId);
      const value = headerValueFor(rawSession, mode, uuidBySession);
      if (value === undefined) {
        return next();
      }

      const downstream = next() as AsyncIterable<unknown>;
      if (
        !downstream ||
        typeof (downstream as unknown as Record<symbol, unknown>)[
          Symbol.asyncIterator
        ] !== "function"
      ) {
        return downstream;
      }

      if (debug || debugFile !== undefined) {
        const entry = {
          header: SESSION_HEADER,
          model,
          provider,
          session: rawSession,
          ts: new Date().toISOString(),
          value,
        };
        if (debugFile !== undefined) {
          void recordDebug(ctx, debugFile, entry);
        }
        if (debug) {
          ctx.logger?.info?.(
            '[opencode-go-session-header] streaming provider "%s" with %s=%s',
            String(provider),
            SESSION_HEADER,
            value
          );
        }
      }
      return withStore(downstream, { value }, als);
    },
    { prepend: true }
  );
};

export default { apply, inject, name };
