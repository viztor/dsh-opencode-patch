/**
 * Host-side service that queries OpenCode Go usage statistics without
 * exposing credentials to the client, plus its Typert remote registration.
 *
 * Credential and gateway resolution live in `go-discovery.ts` (shared with
 * the `apply()` wiring); this module owns the service lifecycle, the quota
 * fetch, and the typed errors the client meter reacts to.
 *
 * @module dsh-opencode-patch/usage
 */

import { randomUUID } from "node:crypto";

import {
  RemoteError,
  TypertRemoteService,
} from "@deepseek-ai/dsh-typert-protocol";

import { DEFAULT_USAGE_BASE_URL } from "./config.ts";
import {
  discoverGoConfig,
  effectiveGoKeyRef,
  resolveGoApiKey,
  resolveZenCreditInfo,
} from "./go-discovery.ts";
import { isFunctionLike, isRecord } from "./guards.ts";
import { parseGoUsage, type GoUsage, usageRemote } from "./usage-contract.ts";

const USAGE_MAX_BYTES = 1024 * 1024;
const USAGE_USER_AGENT = "opencode/1.18.33 dsh-opencode-patch";

/** Stable failure code shared by every quota-fetch failure path. */
const USAGE_UNAVAILABLE = "opencode-go/usage-unavailable";

export interface UsageOptions {
  /** Explicit quota endpoint getter; discovery/defaults apply when absent. */
  baseURL?: () => string;
  /** Explicit key reference (env var / credential name) from plugin config. */
  keyEnv?: string;
  /** Escape hatch for callers that resolve the key themselves. */
  resolveApiKey?: () => Promise<string | undefined>;
}

const isMissingCredential = (error: unknown): boolean => {
  if (!(error instanceof Error)) {
    return false;
  }
  if (!("code" in error)) {
    return false;
  }
  const code: unknown = error.code;
  return code === "MISSING_CREDENTIAL";
};

export class GoUsageService extends TypertRemoteService {
  private identity?: { baseURL: string; key: string; source: string };
  private readonly options: UsageOptions;

  constructor(ctx: unknown, options: UsageOptions = {}) {
    if (!isRecord(ctx)) {
      throw new TypeError("GoUsageService requires a Cordis context object");
    }
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- `TypertRemoteService` takes cordis `Context`, whose types ship only from the Harness installation and are not nameable from this package; the object guard above is the runtime check this cast stands in for.
    super(ctx as never, "opencodeGoUsage");
    this.options = options;
  }

  async read(query?: { provider?: string }): Promise<GoUsage> {
    const targetProvider = query?.provider;
    const discovered = discoverGoConfig(this.ctx, targetProvider);
    const rawBaseURL =
      this.options.baseURL?.() ?? discovered.baseURL ?? DEFAULT_USAGE_BASE_URL;
    const normalizedBaseURL = rawBaseURL.includes("opencode.ai/zen/v1")
      ? rawBaseURL.replace("opencode.ai/zen/v1", "opencode.ai/zen/go/v1")
      : rawBaseURL;
    const baseURL = normalizedBaseURL.replace(/\/$/, "");
    const keyRef = effectiveGoKeyRef(discovered, this.options.keyEnv);

    let key: string | undefined;
    try {
      key = this.options.resolveApiKey
        ? await this.options.resolveApiKey()
        : await resolveGoApiKey(this.ctx, this.options.keyEnv, targetProvider);
    } catch (error: unknown) {
      this.identity = undefined;
      const missing = isMissingCredential(error);
      throw new RemoteError(
        USAGE_UNAVAILABLE,
        missing
          ? "OpenCode Go API key is not configured"
          : "Could not resolve OpenCode Go API key",
        {
          // A missing credential is a configuration state, not a fault: there
          // is no quota to display, so the client hides the meter instead of
          // showing an unavailable one. Any other resolution failure stays
          // visible and retryable.
          ...(missing ? { configured: false } : {}),
          retainPrevious: false,
          retryable: !missing,
        },
        { cause: error }
      );
    }

    if (key === undefined || key.length === 0) {
      const zenInfo = await resolveZenCreditInfo(this.ctx);
      if (zenInfo.isConfigured || targetProvider === "opencode") {
        const now = new Date().toISOString();
        return {
          monthly: { percent: 0, resetsAt: now, status: "ok" },
          rolling: { percent: 0, resetsAt: now, status: "ok" },
          source: randomUUID(),
          weekly: { percent: 0, resetsAt: now, status: "ok" },
          ...(zenInfo.credit === undefined
            ? {}
            : { zenCredit: zenInfo.credit }),
          zenOverflow: true,
        };
      }
      this.identity = undefined;
      throw new RemoteError(
        USAGE_UNAVAILABLE,
        "OpenCode Go API key is not configured",
        { configured: false, retainPrevious: false, retryable: false }
      );
    }

    // One opaque identity per endpoint/account for this process; regenerated
    // whenever either half changes. Never derived from the credential itself,
    // so it cannot leak key material to the client.
    if (this.identity?.baseURL !== baseURL || this.identity.key !== keyRef) {
      this.identity = { baseURL, key: keyRef, source: randomUUID() };
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
          "User-Agent": USAGE_USER_AGENT,
          "x-opencode-client": "cli",
          "x-opencode-project": "global",
        },
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      });
      text = await response.text();
    } catch (error: unknown) {
      throw new RemoteError(
        USAGE_UNAVAILABLE,
        `Could not read ${url}: ${error instanceof Error ? error.message : String(error)}`,
        { retainPrevious: true, retryable: true, source },
        { cause: error }
      );
    }

    if (text.length > USAGE_MAX_BYTES) {
      throw new RemoteError(
        USAGE_UNAVAILABLE,
        `Response from ${url} exceeds ${USAGE_MAX_BYTES} byte limit`,
        { retainPrevious: false, retryable: true, source }
      );
    }

    if (!response.ok) {
      if (response.status === 403 && text.includes("EntitlementError")) {
        const zenInfo = await resolveZenCreditInfo(this.ctx);
        if (zenInfo.isConfigured) {
          const now = new Date().toISOString();
          return {
            monthly: { percent: 0, resetsAt: now, status: "ok" },
            rolling: { percent: 0, resetsAt: now, status: "ok" },
            source,
            weekly: { percent: 0, resetsAt: now, status: "ok" },
            ...(zenInfo.credit === undefined
              ? {}
              : { zenCredit: zenInfo.credit }),
            zenOverflow: true,
          };
        }
        throw new RemoteError(
          USAGE_UNAVAILABLE,
          "OpenCode Go subscription required",
          { configured: false, retainPrevious: false, retryable: false }
        );
      }
      const temporary =
        response.status === 408 ||
        response.status === 429 ||
        response.status >= 500;
      throw new RemoteError(
        USAGE_UNAVAILABLE,
        `OpenCode Go usage unavailable (HTTP ${response.status})`,
        { retainPrevious: temporary, retryable: temporary, source }
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error: unknown) {
      throw new RemoteError(
        USAGE_UNAVAILABLE,
        "Invalid JSON in OpenCode Go usage response",
        { retainPrevious: false, retryable: true, source },
        { cause: error }
      );
    }

    try {
      const usage = parseGoUsage(parsed);
      const zenInfo = await resolveZenCreditInfo(this.ctx);
      return {
        ...usage,
        source,
        ...(zenInfo.credit === undefined ? {} : { zenCredit: zenInfo.credit }),
        zenOverflow: zenInfo.isConfigured,
      };
    } catch (error: unknown) {
      throw new RemoteError(
        USAGE_UNAVAILABLE,
        "Invalid OpenCode Go usage response structure",
        { retainPrevious: false, retryable: true, source },
        { cause: error }
      );
    }
  }
}

/** Structural claim: a context exposing `inject`. */
const hasInject = (
  ctx: unknown
): ctx is { inject: (deps: string[], cb: (scope: unknown) => void) => void } =>
  isRecord(ctx) && isFunctionLike(ctx.inject);

/**
 * Register the typert remote descriptor with the host registry if available.
 *
 * Degrades silently when the composition serves no Typert scope: the plugin
 * still works headless, just without a remote face for the quota meter.
 */
export const registerUsageRemotes = (ctx: unknown): void => {
  if (!hasInject(ctx)) {
    return;
  }
  ctx.inject(["typert"], (scope: unknown) => {
    if (!isRecord(scope) || !isFunctionLike(scope.effect)) {
      return;
    }
    const { effect } = scope;
    const registerDescriptor = (): void => {
      const typert: unknown = scope.typert;
      if (!isRecord(typert) || !isFunctionLike(typert.register)) {
        return;
      }
      const { register } = typert;
      Reflect.apply(register, typert, [
        {
          face: "host",
          invocations: usageRemote.descriptors,
          model: { events: [], objects: [], services: [] },
          package: usageRemote.package,
          schemas: [],
        },
      ]);
    };
    Reflect.apply(effect, scope, [registerDescriptor]);
  });
};
