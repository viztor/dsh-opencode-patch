/**
 * Comprehensive Testing Kit & Simulator Utilities for dsh-opencode-patch.
 *
 * Provides full end-to-end testing fixtures and simulators covering:
 * - Authentication Methods (API key, OAuth grants, local SQLite store across channels)
 * - API Endpoints (LLM streaming/unary, models catalog, console auth, usage)
 * - Response Types (SSE streams, unary JSON, error formats 400/401/403/404/429/500, tool fallbacks)
 * - OpenCode Client Types & Channels (stable, insider, dev, custom, user-agents, session affinity)
 * - DeepSeek Harness Versions (legacy namespace loader vs modern fiber-only loader, Cordis context)
 *
 * @module test/mock/testing-kit
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  type ActiveTurnState,
  type FetchPatchHooks,
  OPENCODE_UA,
  PARENT_SESSION_ALT_HEADER,
  PARENT_SESSION_HEADER,
  type PluginConfig,
  SESSION_AFFINITY_HEADER,
  patchFetch,
  resolveConfig,
} from "../support/src.ts";
import { startMockGateway, type MockGateway } from "./gateway-server.ts";
import {
  GO_KEY,
  MOCK_SESSION,
  MOCK_TEXT,
  ZEN_KEY,
  type TestPlane,
} from "./helpers.ts";
import type {
  GatewayRequest,
  OpenCodeGatewayOptions,
} from "./opencode-gateway.ts";

export { MOCK_SESSION, MOCK_TEXT, GO_KEY, ZEN_KEY };

const GATEWAY_ORIGIN = "https://opencode.ai";

const stringifyInput = (input: RequestInfo | URL): string => {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.href;
  }
  return input.url;
};

const redirectUrl = (url: string, origin: string): string => {
  if (url.startsWith(GATEWAY_ORIGIN)) {
    return url.replace(GATEWAY_ORIGIN, origin);
  }
  if (url.startsWith("http://mock.invalid")) {
    return url.replace("http://mock.invalid", origin);
  }
  if (url.startsWith("/")) {
    return `${origin}${url}`;
  }
  return url;
};

/* -------------------------------------------------------------------------- */
/*                               Auth Simulator                               */
/* -------------------------------------------------------------------------- */

export type AuthMethodType = "apiKey" | "localStore" | "missing" | "oauthGrant";

export interface LocalStoreChannelOptions {
  activeOrgId?: string;
  channel?: string;
  credentials?: readonly {
    active?: number;
    integrationId: string;
    label?: string;
    value: string;
  }[];
  customDbName?: string;
  email?: string;
  platform?: "linux" | "macos" | "windows";
  token?: string;
}

export interface LocalStoreHandle {
  cleanup: () => void;
  dbPath: string;
  env: Record<string, string>;
  rootDir: string;
}

export const AuthSimulator = {
  /**
   * Create OAuth grant details for test authentication hooks.
   */
  createOAuthGrant(
    plane: TestPlane = "opencode",
    options: {
      accessToken?: string;
      email?: string;
      orgId?: string;
      refreshToken?: string;
    } = {}
  ): { token: string; orgId: string; email: string; plane: string } {
    const token = options.accessToken ?? "mock-oauth-access-token-xyz";
    const orgId = options.orgId ?? "wrk_mock_org_456";
    const email = options.email ?? "developer@example.com";
    return { email, orgId, plane, token };
  },

  /**
   * Build a real SQLite database for any OpenCode channel, platform, and path layout.
   */
  createLocalStore(options: LocalStoreChannelOptions = {}): LocalStoreHandle {
    const rootDir = mkdtempSync(
      nodePath.join(os.tmpdir(), "opencode-testing-kit-")
    );
    const { channel = "stable", customDbName } = options;

    let dbFileName: string;
    if (customDbName !== undefined) {
      dbFileName = customDbName;
    } else if (
      channel === "stable" ||
      channel === "latest" ||
      channel === "dev" ||
      channel === "beta"
    ) {
      dbFileName = "opencode.db";
    } else {
      dbFileName = `opencode-${channel.replaceAll(/[^a-zA-Z0-9._-]/gu, "-")}.db`;
    }

    const opencodeDir = nodePath.join(rootDir, ".local", "share", "opencode");
    mkdirSync(opencodeDir, { recursive: true });

    const dbPath = nodePath.join(opencodeDir, dbFileName);
    const database = new DatabaseSync(dbPath);

    database.exec(`
      CREATE TABLE IF NOT EXISTS credential (
        id TEXT PRIMARY KEY,
        integration_id TEXT,
        label TEXT,
        value TEXT,
        connector_id TEXT,
        method_id TEXT,
        active INTEGER,
        time_created INTEGER,
        time_updated INTEGER
      );
      CREATE TABLE IF NOT EXISTS account (
        id TEXT PRIMARY KEY,
        email TEXT,
        url TEXT,
        access_token TEXT,
        refresh_token TEXT,
        token_expiry INTEGER,
        time_created INTEGER,
        time_updated INTEGER
      );
      CREATE TABLE IF NOT EXISTS account_state (
        id INTEGER PRIMARY KEY,
        active_account_id TEXT,
        active_org_id TEXT
      );
    `);

    // Insert credentials
    const credentials: readonly {
      active?: number;
      integrationId: string;
      label?: string;
      value: string;
    }[] = options.credentials ?? [
      {
        active: 1,
        integrationId: "opencode",
        label: "OpenCode Zen Key",
        value: JSON.stringify({ key: ZEN_KEY, type: "api_key" }),
      },
      {
        active: 1,
        integrationId: "opencode-go",
        label: "OpenCode Go Key",
        value: JSON.stringify({ key: GO_KEY, type: "api_key" }),
      },
    ];

    const insertCred = database.prepare(
      "INSERT INTO credential (id, integration_id, label, value, active) VALUES (?, ?, ?, ?, ?)"
    );
    for (const [index, cred] of credentials.entries()) {
      insertCred.run(
        `cred-${index}`,
        cred.integrationId,
        cred.label ?? "Key",
        cred.value,
        cred.active ?? 1
      );
    }

    // Insert account
    const token = options.token ?? "mock-store-access-token";
    const email = options.email ?? "stored-user@example.com";
    const orgId = options.activeOrgId ?? "wrk_store_org_789";

    database
      .prepare(
        "INSERT INTO account (id, email, access_token, refresh_token, token_expiry) VALUES (?, ?, ?, ?, ?)"
      )
      .run(
        "acc_store_1",
        email,
        token,
        "mock-refresh-token",
        Date.now() + 3_600_000
      );

    database
      .prepare(
        "INSERT INTO account_state (id, active_account_id, active_org_id) VALUES (?, ?, ?)"
      )
      .run(1, "acc_store_1", orgId);

    database.close();

    const env: Record<string, string> = {
      HOME: rootDir,
      XDG_DATA_HOME: nodePath.join(rootDir, ".local", "share"),
    };
    if (channel !== "stable") {
      env.OPENCODE_CHANNEL = channel;
    }
    if (customDbName !== undefined) {
      env.OPENCODE_DB = dbPath;
    }

    return {
      cleanup: () => {
        try {
          rmSync(rootDir, { force: true, recursive: true });
        } catch {
          // ignore
        }
      },
      dbPath,
      env,
      rootDir,
    };
  },
} as const;

/* -------------------------------------------------------------------------- */
/*                              Client Simulator                              */
/* -------------------------------------------------------------------------- */

export type ClientGeneration = "1.19.4" | "2.x";

export interface ClientSimulatorOptions {
  channel?: string;
  clientType?: "cli" | "desktop" | "web" | "custom";
  generation?: ClientGeneration;
  parentSessionId?: string;
  project?: string;
  sessionId?: string;
  userAgent?: string;
}

export class ClientSimulator {
  readonly options: ClientSimulatorOptions;
  readonly sessionId: string;
  readonly generation: ClientGeneration;

  constructor(options: ClientSimulatorOptions = {}) {
    this.options = options;
    this.sessionId = options.sessionId ?? MOCK_SESSION;
    this.generation = options.generation ?? "1.19.4";
  }

  /**
   * Generate request headers representing this client type and generation.
   */
  buildHeaders(overrides: Record<string, string> = {}): Record<string, string> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "user-agent": this.options.userAgent ?? OPENCODE_UA,
      "x-opencode-session": this.sessionId,
      "x-opencode-session-id": this.sessionId,
      ...overrides,
    };

    if (this.options.clientType !== undefined) {
      headers["x-opencode-client"] = this.options.clientType;
    }

    if (this.generation === "2.x") {
      headers[SESSION_AFFINITY_HEADER] = this.sessionId;
    }

    if (this.options.parentSessionId !== undefined) {
      headers[PARENT_SESSION_HEADER] = this.options.parentSessionId;
      headers[PARENT_SESSION_ALT_HEADER] = this.options.parentSessionId;
    }

    if (this.options.project !== undefined) {
      headers["x-opencode-project"] = this.options.project;
    }

    if (this.options.channel !== undefined) {
      headers["x-opencode-channel"] = this.options.channel;
    }

    return headers;
  }

  /**
   * Turn state matching this client's active session.
   */
  asTurnState(overrides: Partial<ActiveTurnState> = {}): ActiveTurnState {
    return {
      model: "gpt-5.4",
      parentValue: this.options.parentSessionId,
      project: this.options.project ?? "testing-kit-project",
      provider: "opencode",
      value: this.sessionId,
      ...overrides,
    };
  }
}

/* -------------------------------------------------------------------------- */
/*                             Harness Simulator                              */
/* -------------------------------------------------------------------------- */

export type HarnessLoaderGeneration =
  | "degraded"
  | "fiber-only"
  | "legacy-namespace";

export interface HarnessSimulatorOptions {
  baseUrl?: string;
  loaderGeneration?: HarnessLoaderGeneration;
  remotes?: Record<string, unknown>;
  services?: Record<string, unknown>;
}

export interface MockCordisContext extends Record<string, unknown> {
  baseUrl: string;
  get: (key: string) => unknown;
  inject: (
    deps: readonly string[],
    callback: (scope: unknown) => unknown
  ) => unknown;
  loader: { entries: () => unknown[] };
  remote: Record<string, unknown>;
}

export class HarnessSimulator {
  readonly options: HarnessSimulatorOptions;

  constructor(options: HarnessSimulatorOptions = {}) {
    this.options = options;
  }

  /**
   * Create a mock Cordis context matching a specific DeepSeek Harness version and loader.
   */
  createMockContext(): {
    ctx: MockCordisContext;
    loaderEntries: unknown[];
  } {
    const services = new Map<string, unknown>(
      Object.entries(this.options.services ?? {})
    );
    const remotes = new Map<string, unknown>(
      Object.entries(this.options.remotes ?? {})
    );

    let loaderEntries: unknown[] = [];
    if (this.options.loaderGeneration === "legacy-namespace") {
      loaderEntries = [
        {
          name: "@deepseek-ai/dsh-llm-pi-ai",
          namespace: {
            PiAiAdapter: class MockPiAiAdapter {
              readonly adapterId = "mock-adapter";
            },
            apply() {
              return true;
            },
            inject: ["llm"],
            name: "llm-pi-ai",
          },
          options: { name: "@deepseek-ai/dsh-llm-pi-ai" },
        },
      ];
    } else if (this.options.loaderGeneration === "fiber-only") {
      loaderEntries = [
        {
          fiber: {
            inject: { llm: null },
            runtime: {
              callback() {
                return true;
              },
            },
          },
          options: { name: "@deepseek-ai/dsh-llm-pi-ai" },
        },
      ];
    } else if (this.options.loaderGeneration === "degraded") {
      loaderEntries = [];
    }

    const loader = {
      entries: () => loaderEntries,
    };

    const ctx: MockCordisContext = {
      baseUrl: this.options.baseUrl ?? new URL("../../", import.meta.url).href,
      get: (key: string) => {
        if (key === "loader") return loader;
        return services.get(key);
      },
      inject: (
        _deps: readonly string[],
        callback: (scope: unknown) => unknown
      ) => callback(ctx),
      loader,
      remote: Object.fromEntries(remotes.entries()),
      ...Object.fromEntries(services.entries()),
    };

    return { ctx, loaderEntries };
  }
}

/* -------------------------------------------------------------------------- */
/*                               Matrix Runner                                */
/* -------------------------------------------------------------------------- */

export interface MatrixCase {
  authMethod: AuthMethodType;
  endpoint: string;
  expectedStatus: number;
  family: string;
  model?: string;
  plane: TestPlane;
  protocol?: string;
  responseType: "error" | "streaming" | "unary";
}

export interface GatewayExecutionResult {
  /** The raw client Response object. */
  readonly clientResponse: Response;
  /** Status code from the client response. */
  readonly status: number;
  /** Headers from the client response. */
  readonly headers: Headers;
  /** Whether the response status is 2xx. */
  readonly ok: boolean;
  /** Parsed JSON response body, if valid JSON. */
  readonly parsedBody?: unknown;
  /** The request as recorded by the gateway. */
  readonly recordedRequest?: GatewayRequest;
  /** Semantic alias for recordedRequest. */
  readonly request?: GatewayRequest;
  /** Raw text of the response body. */
  readonly text: string;
  /** Helper to read parsed body with type safety. */
  readonly json: <T>(validate?: (data: unknown) => T) => T;
  /** Optional captured error. */
  readonly error?: unknown;
}

export type MatrixExecutionResult = GatewayExecutionResult;

export class GatewayTestRunner {
  private gateway!: MockGateway;
  private readonly als: AsyncLocalStorage<ActiveTurnState>;

  constructor() {
    this.als = new AsyncLocalStorage<ActiveTurnState>();
  }

  async start(options: OpenCodeGatewayOptions = {}): Promise<void> {
    this.gateway = await startMockGateway(options);
  }

  async close(): Promise<void> {
    if (this.gateway) {
      await this.gateway.close();
    }
  }

  get origin(): string {
    return this.gateway.origin;
  }

  get requests(): GatewayRequest[] {
    return this.gateway.requests;
  }

  clearRequests(): void {
    if (this.gateway) {
      this.gateway.requests.length = 0;
    }
  }

  /**
   * Run one request through patchFetch, capturing both client and gateway sides.
   */
  async execute(
    plane: TestPlane,
    path: string,
    options: {
      authHeaders?: Record<string, string>;
      body?: unknown;
      clientSimulator?: ClientSimulator;
      config?: PluginConfig;
      hooks?: FetchPatchHooks;
      method?: string;
      turnState?: ActiveTurnState | null;
    } = {}
  ): Promise<GatewayExecutionResult> {
    const config = resolveConfig(options.config ?? {});
    const client = options.clientSimulator ?? new ClientSimulator();
    const turnState =
      options.turnState === null
        ? undefined
        : (options.turnState ?? client.asTurnState({ provider: plane }));

    const realFetch = globalThis.fetch;

    const redirectingFetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit
    ) => {
      const url = stringifyInput(input);
      const redirected = redirectUrl(url, this.gateway.origin);
      return realFetch(redirected, init);
    }) as typeof fetch;

    const patched = patchFetch(
      redirectingFetch,
      this.als,
      config,
      options.hooks
    );

    const fullUrl = path.startsWith("http")
      ? path
      : `${GATEWAY_ORIGIN}${path.startsWith("/") ? path : `/${path}`}`;

    const headers = client.buildHeaders(options.authHeaders);

    const method =
      options.method ?? (options.body === undefined ? "GET" : "POST");

    let clientResponse!: Response;
    let text = "";
    let parsedBody: unknown;

    const runFetch = async () => {
      clientResponse = await patched(fullUrl, {
        body:
          options.body === undefined ? undefined : JSON.stringify(options.body),
        headers,
        method,
      });
      text = await clientResponse.text();
      try {
        parsedBody = JSON.parse(text);
      } catch {
        parsedBody = undefined;
      }
    };

    await (turnState === undefined
      ? runFetch()
      : this.als.run(turnState, runFetch));

    const recordedRequest = this.gateway.requests.at(-1);

    return {
      clientResponse,
      headers: clientResponse.headers,
      json: <T>(validate?: (data: unknown) => T): T =>
        validate === undefined ? (parsedBody as T) : validate(parsedBody),
      ok: clientResponse.ok,
      parsedBody,
      recordedRequest,
      request: recordedRequest,
      status: clientResponse.status,
      text,
    };
  }
}

export const MatrixRunner = GatewayTestRunner;
