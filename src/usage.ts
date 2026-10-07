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

import type { KeySourcePolicy } from "./config-values.ts";
import { DEFAULT_USAGE_BASE_URL } from "./config.ts";
import {
  discoverGoConfig,
  effectiveGoKeyRef,
  resolveGoApiKey,
  resolveZenCreditInfo,
  toGoBaseURL,
} from "./go-discovery.ts";
import { GO_MODEL_LIMITS } from "./go-limits-data.ts";
import { isRecord } from "./guards.ts";
import {
  type CatalogModelSpec,
  type CatalogPlane,
  catalogPlaneForRoute,
  findModelSpecOn,
} from "./models-catalog.ts";
import {
  describeModel,
  getSessionUsage,
  type SessionUsageSnapshot,
} from "./session-cost.ts";
import {
  parseGoUsage,
  type GoUsage,
  type ModelAllowanceSnapshot,
  type UsageQuery,
  type UsageWindow,
} from "./usage-contract.ts";

const USAGE_MAX_BYTES = 1024 * 1024;
const USAGE_USER_AGENT = "opencode/1.18.33 dsh-opencode-patch";

/** Stable failure code shared by every quota-fetch failure path. */
const USAGE_UNAVAILABLE = "opencode-go/usage-unavailable";

export interface UsageOptions {
  /** Explicit quota endpoint getter; discovery/defaults apply when absent. */
  baseURL?: () => string;
  /** Which credential source wins; the composition and capture cover the rest. */
  keySource?: KeySourcePolicy;
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

/**
 * The reading served when the account is on Zen overflow: Go has no quota to
 * report (no key, or a Go subscription the account is not entitled to), so
 * every window sits at zero and the meter hands over to Zen balance.
 *
 * @param source - opaque host identity for the endpoint/account.
 * @param sessionId - conversation whose spend to attach, when known.
 */
const zenOverflowUsage = (
  source: string,
  sessionId?: string,
  query?: UsageQuery
): GoUsage => {
  const resetsAt = new Date().toISOString();
  const window = (): UsageWindow => ({ percent: 0, resetsAt, status: "ok" });
  const session = attachSession(sessionId, query);
  return {
    monthly: window(),
    rolling: window(),
    ...(session === undefined ? {} : { session }),
    source,
    weekly: window(),
    zenOverflow: true,
  };
};

/**
 * Attach session spend, re-described for the model the picker is on.
 *
 * The accumulator's own `active*` fields name the model that ran the LAST turn.
 * The rate shown beside the figure is prospective, so when the caller says which
 * model is selected and it differs, that identity and the catalog rate for it
 * win. The Host owns the catalog — the client ships no rates — so this is the
 * only side that can answer "what does the next turn cost".
 */
const attachSession = (
  sessionId: string | undefined,
  query: UsageQuery | undefined
): SessionUsageSnapshot | undefined => {
  const session = getSessionUsage(sessionId);
  if (session === undefined) {
    return undefined;
  }
  const plane = catalogPlaneForRoute(query?.provider ?? "");
  const selected = query?.model;
  const isProspective =
    selected !== undefined &&
    selected.length > 0 &&
    selected !== session.activeModel;

  // The picker names a model the last turn did not run, so describe the snapshot
  // as THAT model — except for `costUsd`, which is history.
  const spec = isProspective ? catalogFor(plane, selected) : undefined;
  const described =
    spec === undefined || !isProspective
      ? session
      : describeModel(
          session,
          selected,
          spec.cost,
          spec.is_free === true,
          spec.name
        );

  return nameModel(described, plane);
};

/** The catalog spec for a model, or `undefined` when the catalog has none. */
const catalogFor = (
  plane: CatalogPlane,
  model: string
): CatalogModelSpec | undefined => findModelSpecOn(plane, model);

/**
 * Fill in the display name, which a recorded turn never carries.
 *
 * A turn records the model ID — that is what the gateway speaks — so the first
 * reading of a session has no name, and the meter's row falls back to
 * `muse-spark-1.3-contributor-free`: a debug value, in a row that also says the
 * model is free. The catalog is the only thing that knows the other half, and
 * this is the one place that can reach it for the model being described.
 */
const nameModel = (
  snapshot: SessionUsageSnapshot,
  plane: CatalogPlane
): SessionUsageSnapshot => {
  const model = snapshot.activeModel;
  if (
    snapshot.activeModelName !== undefined ||
    model === undefined ||
    model.length === 0
  ) {
    return snapshot;
  }
  const spec = catalogFor(plane, model);
  return spec === undefined
    ? snapshot
    : { ...snapshot, activeModelName: spec.name };
};

/**
 * Attach the selected model's monthly allowance, from the generated limits table.
 *
 * Resolved on the Host for the same reason the rate is: the table is generated
 * from the vendor's docs and belongs beside the catalog it is joined against, so
 * the client ships neither. Unknown models get nothing — the row then simply is
 * not rendered, which is the honest outcome for a model the plan does not list
 * (an unlimited one, or one newer than the table).
 *
 * Both tiers travel together. The plan is not discoverable — `/limits`, `/plan`,
 * `/subscription`, `/account` all 404 — so choosing one here would mean
 * guessing, and a wrong tier misstates the money by 2-3x.
 */
const attachAllowance = (
  query: UsageQuery | undefined
): ModelAllowanceSnapshot | undefined => {
  const model = query?.model?.trim() ?? "";
  if (model.length === 0) {
    return undefined;
  }
  const row = GO_MODEL_LIMITS[model] ?? GO_MODEL_LIMITS[model.toLowerCase()];
  if (row === undefined) {
    return undefined;
  }
  return { go: row.go, goPlus: row.goPlus, model };
};

/** Normalize a base URL to the Go `/usage` endpoint, without a trailing slash. */
const usageEndpointBase = (rawBaseURL: string): string =>
  toGoBaseURL(rawBaseURL).replace(/\/$/, "");

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

  async read(query?: UsageQuery): Promise<GoUsage> {
    const targetProvider = query?.provider;
    // Spend is per conversation: without this the Host can only guess, and
    // every open session would read the same (most recent) total.
    const sessionId = query?.sessionId;
    const discovered = discoverGoConfig(this.ctx, targetProvider);
    const rawBaseURL =
      this.options.baseURL?.() ?? discovered.baseURL ?? DEFAULT_USAGE_BASE_URL;
    const baseURL = usageEndpointBase(rawBaseURL);
    const keyRef = effectiveGoKeyRef(discovered);

    let key: string | undefined;
    try {
      key = this.options.resolveApiKey
        ? await this.options.resolveApiKey()
        : await resolveGoApiKey(
            this.ctx,
            targetProvider,
            this.options.keySource ?? "auto"
          );
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
        return zenOverflowUsage(randomUUID(), sessionId, query);
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
          return zenOverflowUsage(source, sessionId, query);
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
      const session = attachSession(sessionId, query);
      const allowance = attachAllowance(query);
      return {
        ...usage,
        ...(allowance === undefined ? {} : { allowance }),
        ...(session === undefined ? {} : { session }),
        source,
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

/**
 * Prototype key `remoteMethods()` reads Remote markers from. A plain string
 * constant in the protocol package (index.ts:140); not re-exported.
 */
const REMOTE_METHOD_DESCRIPTOR_KEY =
  "@deepseek-ai/dsh-typert-protocol/remote-methods";

/**
 * Declare `read` as a Remote method — exactly what `@Remote()` does.
 *
 * The decorator cannot be used: this build transform is oxc/rolldown based and
 * rejects TC39 decorator syntax outright ("SyntaxError: Invalid or unexpected
 * token"), and `esbuild: { target: "esnext" }` is ignored by it. The decorator has
 * no magic — it registers an instance initializer calling
 * `mark(prototype, method, invocation)`, and `mark` only writes this one property.
 * `remoteMethods()` reads it straight off the prototype, so writing it directly
 * is equivalent. Swap for the decorator once the transform accepts one.
 */
Object.defineProperty(GoUsageService.prototype, REMOTE_METHOD_DESCRIPTOR_KEY, {
  configurable: true,
  value: Object.freeze({
    version: 1,
    methods: Object.freeze([
      { method: "read", invocation: { kind: "direct" } },
    ]),
  }),
});
