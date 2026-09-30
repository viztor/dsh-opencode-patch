import { AsyncLocalStorage } from "node:async_hooks";
//#region src/index.d.ts
export declare const name = "opencode-go-session-header";
export declare const inject: string[];
export declare const SESSION_HEADER = "x-opencode-session";
export declare const OPENCODE_UA = "opencode/1.18.33 ai-sdk/provider-utils/4.0.40 runtime/bun/1.3.14";
export declare const DUMMY_READ_TOOL: {
  readonly description: "Read a file or directory from the local filesystem.";
  readonly name: "read";
  readonly parameters: {
    readonly properties: {
      readonly filePath: {
        readonly description: "The absolute path to the file";
        readonly type: "string";
      };
    };
    readonly required: readonly ["filePath"];
    readonly type: "object";
  };
  readonly type: "function";
};
export declare const DUMMY_BASH_TOOL: {
  readonly description: "Execute a bash command.";
  readonly name: "bash";
  readonly parameters: {
    readonly properties: {
      readonly command: {
        readonly description: "The command to execute";
        readonly type: "string";
      };
    };
    readonly required: readonly ["command"];
    readonly type: "object";
  };
  readonly type: "function";
};
/** Derive a valid OpenCode session ID (`ses_<12hex><14base62>`) deterministically from a DSH sessionId. */
export declare const openCodeSessionIdFor: (sessionId: string | number) => string;
export declare const DEFAULT_PROVIDERS: string[];
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
export declare const resolveConfig: (config?: PluginConfig) => ResolvedPluginConfig;
export declare const headerValueFor: (sessionId: string | number | undefined | null, _mode: string, table: Map<string, string>) => string | undefined;
export declare const withStore: <T>(iterable: AsyncIterable<T>, store: {
  value: string;
}, als: AsyncLocalStorage<{
  value: string;
}>) => AsyncIterable<T>;
export declare const hasSessionHeader: (input: RequestInfo | URL, init?: RequestInit) => boolean;
export declare const patchFetch: (original: typeof fetch, als: AsyncLocalStorage<{
  value: string;
}>) => typeof fetch;
export interface CordisContext {
  effect?: (fn: () => unknown, name?: string) => void;
  logger?: {
    info?: (msg: string, ...args: unknown[]) => void;
    warn?: (msg: string, ...args: unknown[]) => void;
  };
  on?: (event: string, callback: (options: unknown, next: () => unknown, ...rest: unknown[]) => unknown, options?: {
    prepend?: boolean;
  }) => void;
}
export declare const apply: (ctx: CordisContext, config?: PluginConfig) => void;
declare const _default: {
  apply: typeof apply;
  inject: string[];
  name: string;
};
//#endregion
export { _default as default };