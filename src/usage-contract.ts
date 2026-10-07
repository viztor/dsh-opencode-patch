/**
 * Remote contract and validation for OpenCode Go account usage. A Typert remote,
 * so the host fetches with server-side credentials and never exposes the key.
 *
 * @module dsh-opencode-patch/usage-contract
 */

import type {
  RemoteResult,
  TypertRemoteContribution,
} from "@deepseek-ai/dsh-typert-protocol";

import { isRecord } from "./guards.ts";
import type { SessionUsageSnapshot } from "./session-cost.ts";

/** The active model's published monthly allowance, resolved on the Host. */
export interface ModelAllowanceSnapshot {
  /** Go, the $10/month plan. */
  go: number;
  /** Go Plus, the $40/month plan. */
  goPlus: number;
  /** The model this allowance is for, as the picker spells it. */
  model: string;
}

export interface UsageWindow {
  percent: number;
  resetsAt: string;
  status: "ok" | "rate-limited";
}

export interface GoUsage {
  /**
   * The selected model's monthly allowance, in whole US dollars per plan tier.
   *
   * A **total**, never a balance: `GET /zen/go/v1/usage` takes no model
   * parameter, so its percentages describe the ACCOUNT and cannot be turned into
   * a per-model remainder. See `src/go-limits.ts`.
   */
  allowance?: ModelAllowanceSnapshot;
  monthly: UsageWindow;
  rolling: UsageWindow;
  /** Accumulated token and dollar usage for the current session. */
  session?: SessionUsageSnapshot;
  /** Opaque Host identity for this endpoint/account; never a credential or its hash. */
  source?: string;
  weekly: UsageWindow;
  /** Whether Zen balance overflow fallback is active or configured. */
  zenOverflow?: boolean;
}

const parseWindow = (
  row: Record<string, unknown>,
  label: string
): UsageWindow => {
  const { percent, resetsAt, status } = row;
  if (status !== "ok" && status !== "rate-limited") {
    throw new TypeError(`Invalid OpenCode Go status for ${label}`);
  }
  if (typeof percent !== "number" || !Number.isFinite(percent) || percent < 0) {
    throw new TypeError(`Invalid OpenCode Go percent for ${label}`);
  }
  if (typeof resetsAt !== "string" || !Number.isFinite(Date.parse(resetsAt))) {
    throw new TypeError(`Invalid OpenCode Go resetsAt for ${label}`);
  }
  return {
    percent,
    resetsAt,
    status,
  };
};

/**
 * Validate and normalize OpenCode Go usage response.
 *
 * Accepts either `{ usage: { rolling, weekly, monthly } }` (the live API payload)
 * or `{ rolling, weekly, monthly }` (unwrapped).
 */
export const parseGoUsage = (value: unknown): GoUsage => {
  if (!isRecord(value)) {
    throw new TypeError(
      "Invalid OpenCode Go usage response: expected an object"
    );
  }
  const root = value;
  const source = isRecord(root.usage) ? root.usage : root;

  const rollingRaw = source.rolling;
  const weeklyRaw = source.weekly;
  const monthlyRaw = source.monthly;

  if (!isRecord(rollingRaw) || !isRecord(weeklyRaw) || !isRecord(monthlyRaw)) {
    throw new TypeError("Invalid OpenCode Go usage response: missing window");
  }

  const rolling = parseWindow(rollingRaw, "rolling");
  const weekly = parseWindow(weeklyRaw, "weekly");
  const monthly = parseWindow(monthlyRaw, "monthly");

  const sourceId =
    typeof root.source === "string" &&
    root.source.length > 0 &&
    root.source.length <= 128
      ? root.source
      : undefined;

  const { zenOverflow: rootOverflow } = root;
  const { zenOverflow: sourceOverflow } = source;

  let zenOverflow: boolean | undefined;
  if (typeof rootOverflow === "boolean") {
    zenOverflow = rootOverflow;
  } else if (typeof sourceOverflow === "boolean") {
    zenOverflow = sourceOverflow;
  }

  let session: SessionUsageSnapshot | undefined;
  const sessionRaw = isRecord(root.session) ? root.session : undefined;
  if (
    sessionRaw !== undefined &&
    typeof sessionRaw.costFormatted === "string" &&
    typeof sessionRaw.totalTokens === "number"
  ) {
    session = {
      ...(typeof sessionRaw.activeModel === "string" &&
      sessionRaw.activeModel.length > 0
        ? { activeModel: sessionRaw.activeModel }
        : {}),
      ...(typeof sessionRaw.activeRateFormatted === "string"
        ? { activeRateFormatted: sessionRaw.activeRateFormatted }
        : {}),
      cacheReadTokens:
        typeof sessionRaw.cacheReadTokens === "number"
          ? sessionRaw.cacheReadTokens
          : 0,
      costFormatted: sessionRaw.costFormatted,
      costUsd: typeof sessionRaw.costUsd === "number" ? sessionRaw.costUsd : 0,
      ...(sessionRaw.freeModel === true ? { freeModel: true } : {}),
      inputTokens:
        typeof sessionRaw.inputTokens === "number" ? sessionRaw.inputTokens : 0,
      modelsUsed: Array.isArray(sessionRaw.modelsUsed)
        ? sessionRaw.modelsUsed.filter(
            (m): m is string => typeof m === "string"
          )
        : [],
      outputTokens:
        typeof sessionRaw.outputTokens === "number"
          ? sessionRaw.outputTokens
          : 0,
      totalTokens: sessionRaw.totalTokens,
      turns: typeof sessionRaw.turns === "number" ? sessionRaw.turns : 0,
    };
  }

  return {
    monthly,
    rolling,
    ...(session === undefined ? {} : { session }),
    ...(sourceId === undefined ? {} : { source: sourceId }),
    weekly,
    ...(zenOverflow === undefined ? {} : { zenOverflow }),
  };
};

declare module "@deepseek-ai/dsh-typert-protocol" {
  interface RemoteErrorDetailsMap {
    "opencode-go/usage-unavailable": {
      /**
       * `false` when the account has no Go credential at all — a configuration
       * state, not a fault, so the client renders nothing rather than an
       * unavailable meter.
       */
      readonly configured?: boolean;
      readonly retainPrevious: boolean;
      readonly retryable: boolean;
      readonly source?: string;
    };
  }
  interface TypertRemoteNamespaceMap {
    opencodeGoUsage: {
      read: (query?: UsageQuery) => Promise<RemoteResult<GoUsage>>;
    };
  }
}

const usageCodec = {
  create: () => ({ parse: parseGoUsage }),
  mode: "strict" as const,
  schema: { parse: parseGoUsage },
  typeSymbol: "dsh-opencode-patch#GoUsage",
};

/**
 * What the caller may tell the Host about the meter it is rendering.
 *
 * `provider` picks the route (hence the account) being metered, `sessionId`
 * scopes the spend figure to the conversation on screen, and `model` names the
 * model the picker is ON — which is not the model that priced the spend so far.
 * The Host owns the catalog, so it is the only side that can answer "what does
 * the next turn on this model cost"; without the field the rate beside the figure
 * describes the last completed turn and goes stale the moment you switch.
 */
export interface UsageQuery {
  model?: string;
  provider?: string;
  sessionId?: string;
}

/**
 * Validate the optional query. The whole value is optional on the wire
 * (`acceptsUndefined`), as is every field within it.
 */
export const parseUsageQuery = (value?: unknown): UsageQuery => {
  if (value === undefined || value === null) {
    return {};
  }
  if (!isRecord(value)) {
    throw new TypeError("Invalid OpenCode usage query: expected an object");
  }
  const { model, provider, sessionId } = value;
  return {
    ...(typeof model === "string" && model.length > 0 ? { model } : {}),
    ...(typeof provider === "string" && provider.length > 0
      ? { provider }
      : {}),
    ...(typeof sessionId === "string" && sessionId.length > 0
      ? { sessionId }
      : {}),
  };
};

const usageQueryCodec = {
  create: () => ({ parse: parseUsageQuery }),
  mode: "strict" as const,
  schema: { parse: parseUsageQuery },
  typeSymbol: "dsh-opencode-patch#UsageQuery",
};

export const usageRemote: TypertRemoteContribution = {
  descriptors: [
    {
      id: "dsh-opencode-patch#opencodeGoUsage/read",
      invocation: { kind: "direct" },
      method: "read",
      namespace: "opencodeGoUsage",
      parameters: [
        {
          // The query is optional: a caller that knows nothing still gets the
          // default route and the latest session.
          acceptsUndefined: true,
          codec: usageQueryCodec,
          name: "query",
          source: "json",
          wire: "query",
        },
      ],
      result: usageCodec,
      service: "opencodeGoUsage",
    },
  ],
  package: "dsh-opencode-patch",
};
