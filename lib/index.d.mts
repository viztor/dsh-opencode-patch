import { AsyncLocalStorage } from "node:async_hooks";
//#region src/index.d.ts
export declare const name = "dsh-opencode";
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
  injectCoreTools?: boolean;
  injectOriginHeaders?: boolean;
  injectUserAgent?: boolean;
  mode?: "session-id" | "uuid";
  providers?: string[];
  userAgent?: string;
}
export interface ResolvedPluginConfig {
  debug: boolean;
  debugFile?: string;
  injectCoreTools: boolean;
  injectOriginHeaders: boolean;
  injectUserAgent: boolean;
  mode: "session-id" | "uuid";
  providers: Set<string>;
  userAgent?: string;
}
export declare const resolveConfig: (config?: PluginConfig) => ResolvedPluginConfig;
export declare const headerValueFor: (sessionId: string | number | undefined | null, _mode: string, table: Map<string, string>) => string | undefined;
export interface ActiveTurnState {
  model?: string;
  provider: string;
  value: string;
}
export declare const withStore: <T>(iterable: AsyncIterable<T>, store: ActiveTurnState, als: AsyncLocalStorage<ActiveTurnState>) => AsyncIterable<T>;
export declare const hasSessionHeader: (input: RequestInfo | URL, init?: RequestInit) => boolean;
/** Determines if a request targets an OpenCode API endpoint. */
export declare const isOpenCodeRequest: (url: string, state: ActiveTurnState | undefined, providers: Set<string>) => boolean;
export declare const patchFetch: (original: typeof fetch, als: AsyncLocalStorage<ActiveTurnState>, config: ResolvedPluginConfig) => typeof fetch;
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
export declare const apply: (ctx: CordisContext, rawConfig?: PluginConfig) => void;
declare const _default: {
  apply: typeof apply;
  inject: string[];
  name: string;
};
//#endregion
export { _default as default };