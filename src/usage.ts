/**
 * Host-side service that queries OpenCode Go usage statistics without exposing credentials to the client.
 *
 * @module dsh-opencode-patch/usage
 */

import { randomUUID } from "node:crypto";

import {
  RemoteError,
  TypertRemoteService,
} from "@deepseek-ai/dsh-typert-protocol";

import { parseGoUsage, type GoUsage, usageRemote } from "./usage-contract.ts";

const USAGE_MAX_BYTES = 1024 * 1024;

export interface UsageOptions {
  baseURL?: () => string;
  resolveApiKey?: () => Promise<string | undefined>;
}

export interface DiscoveredGoConfig {
  baseURL?: string;
  keyEnv?: string;
  literalKey?: string;
}

interface LoaderEntry {
  options?: {
    config?: Record<string, unknown>;
    id?: string;
    name?: string;
  };
}

interface ContextWithLoader {
  loader?: {
    entries: () => Iterable<LoaderEntry>;
  };
}

interface CredentialsHost {
  get?: (name: string) =>
    | {
        resolve?: (ref: string) => Promise<{ value?: string } | undefined>;
      }
    | undefined;
}

/**
 * Auto-discover OpenCode Go provider configuration from loaded Cordis entries (e.g. llm-pi-ai).
 */
export const discoverGoConfig = (ctx: unknown): DiscoveredGoConfig => {
  const result: DiscoveredGoConfig = {};
  const context = ctx as ContextWithLoader | undefined;
  if (!context?.loader || typeof context.loader.entries !== "function") {
    return result;
  }

  for (const entry of context.loader.entries()) {
    const config = entry?.options?.config;
    if (!config || typeof config !== "object") {
      continue;
    }

    // 1. Check `providers["opencode-go"]` in provider registries like llm-pi-ai
    const { providers } = config;
    if (providers && typeof providers === "object") {
      const goProvider = (providers as Record<string, unknown>)["opencode-go"];
      if (goProvider && typeof goProvider === "object") {
        const row = goProvider as Record<string, unknown>;
        if (typeof row.apiKeyEnv === "string" && row.apiKeyEnv.length > 0) {
          result.keyEnv = row.apiKeyEnv;
        }
        if (typeof row.apiKey === "string" && row.apiKey.length > 0) {
          result.literalKey = row.apiKey;
        }
        if (typeof row.baseURL === "string" && row.baseURL.length > 0) {
          result.baseURL = row.baseURL;
        }
      }
    }

    // 2. Check standalone provider entries like id: opencode-go
    const { id, name } = entry.options ?? {};
    if (id === "opencode-go" || name === "dsh-opencode-go") {
      if (typeof config.apiKeyEnv === "string" && config.apiKeyEnv.length > 0) {
        result.keyEnv = config.apiKeyEnv;
      }
      if (typeof config.apiKey === "string" && config.apiKey.length > 0) {
        result.literalKey = config.apiKey;
      }
      if (typeof config.baseURL === "string" && config.baseURL.length > 0) {
        result.baseURL = config.baseURL;
      }
    }
  }

  return result;
};

export class GoUsageService extends TypertRemoteService {
  private identity?: { baseURL: string; key: string; source: string };
  private readonly options: UsageOptions;

  constructor(ctx: unknown, options: UsageOptions = {}) {
    // TypertRemoteService expects Context and service identifier
    super(ctx as never, "opencodeGoUsage");
    this.options = options;
  }

  async read(): Promise<GoUsage> {
    const discovered = discoverGoConfig(this.ctx);
    const rawBaseURL =
      this.options.baseURL?.() ??
      discovered.baseURL ??
      "https://opencode.ai/zen/go/v1";
    const baseURL = rawBaseURL.replace(/\/$/, "");

    let key: string | undefined;
    try {
      key = this.options.resolveApiKey
        ? await this.options.resolveApiKey()
        : await this.resolveDefaultKey();
    } catch (error: unknown) {
      this.identity = undefined;
      const missing =
        error instanceof Error &&
        "code" in error &&
        error.code === "MISSING_CREDENTIAL";
      throw new RemoteError(
        "opencode-go/usage-unavailable",
        missing
          ? "OpenCode Go API key is not configured"
          : "Could not resolve OpenCode Go API key",
        { retainPrevious: false, retryable: !missing },
        { cause: error }
      );
    }

    if (key === undefined || key.length === 0) {
      this.identity = undefined;
      throw new RemoteError(
        "opencode-go/usage-unavailable",
        "OpenCode Go API key is not configured",
        { retainPrevious: false, retryable: false }
      );
    }

    if (this.identity?.baseURL !== baseURL || this.identity.key !== key) {
      this.identity = { baseURL, key, source: randomUUID() };
    }
    const { source } = this.identity;
    const url = `${baseURL}/usage`;

    let response: Response;
    let text: string;
    try {
      response = await fetch(url, {
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${key}`,
          "User-Agent": "opencode/1.18.33 dsh-opencode-patch",
        },
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      });
      text = await response.text();
    } catch (error: unknown) {
      throw new RemoteError(
        "opencode-go/usage-unavailable",
        `Could not read ${url}: ${error instanceof Error ? error.message : String(error)}`,
        { retainPrevious: true, retryable: true, source },
        { cause: error }
      );
    }

    if (text.length > USAGE_MAX_BYTES) {
      throw new RemoteError(
        "opencode-go/usage-unavailable",
        `Response from ${url} exceeds ${USAGE_MAX_BYTES} byte limit`,
        { retainPrevious: false, retryable: true, source }
      );
    }

    if (!response.ok) {
      const temporary =
        response.status === 408 ||
        response.status === 429 ||
        response.status >= 500;
      throw new RemoteError(
        "opencode-go/usage-unavailable",
        `OpenCode Go usage unavailable (HTTP ${response.status})`,
        { retainPrevious: temporary, retryable: temporary, source }
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error: unknown) {
      throw new RemoteError(
        "opencode-go/usage-unavailable",
        "Invalid JSON in OpenCode Go usage response",
        { retainPrevious: false, retryable: true, source },
        { cause: error }
      );
    }

    try {
      const usage = parseGoUsage(parsed);
      return { ...usage, source };
    } catch (error: unknown) {
      throw new RemoteError(
        "opencode-go/usage-unavailable",
        "Invalid OpenCode Go usage response structure",
        { retainPrevious: false, retryable: true, source },
        { cause: error }
      );
    }
  }

  private async resolveDefaultKey(): Promise<string | undefined> {
    const discovered = discoverGoConfig(this.ctx);
    if (
      typeof discovered.literalKey === "string" &&
      discovered.literalKey.length > 0
    ) {
      return discovered.literalKey;
    }

    const keyRef = discovered.keyEnv ?? "OPENCODE_GO_API_KEY";
    const creds = (this.ctx as unknown as CredentialsHost | undefined)?.get?.(
      "credentials"
    );
    if (creds && typeof creds.resolve === "function") {
      try {
        const hit = await creds.resolve(keyRef);
        if (hit?.value && hit.value.length > 0) return hit.value;
      } catch {
        // Fall through
      }
    }

    if (process.env[keyRef]) {
      return process.env[keyRef];
    }
    if (process.env.OPENCODE_GO_API_KEY) {
      return process.env.OPENCODE_GO_API_KEY;
    }
    return process.env.OPENCODE_API_KEY;
  }
}

/**
 * Register the typert remote descriptor with the host registry if available.
 */
export const registerUsageRemotes = (ctx: unknown): void => {
  const context = ctx as
    | {
        inject?: (deps: string[], cb: (scope: unknown) => void) => void;
      }
    | undefined;
  if (typeof context?.inject === "function") {
    context.inject(["typert"], (scope: unknown) => {
      const typertScope = scope as
        | {
            effect?: (fn: () => void) => void;
            typert?: {
              register?: (desc: unknown) => void;
            };
          }
        | undefined;
      typertScope?.effect?.(() => {
        typertScope.typert?.register?.({
          face: "host",
          invocations: usageRemote.descriptors,
          model: { events: [], objects: [], services: [] },
          package: usageRemote.package,
          schemas: [],
        });
      });
    });
  }
};
