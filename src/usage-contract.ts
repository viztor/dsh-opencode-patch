/**
 * Remote contract and validation for OpenCode Go account usage statistics.
 *
 * Modeled on the Typert protocol so the host can fetch usage stats using server-side
 * credentials without ever exposing tokens to the browser client.
 *
 * @module dsh-opencode-patch/usage-contract
 */

import type {
  RemoteResult,
  TypertRemoteContribution,
} from "@deepseek-ai/dsh-typert-protocol";

import type { SessionUsageSnapshot } from "./session-cost.ts";

export interface UsageWindow {
  percent: number;
  resetsAt: string;
  status: "ok" | "rate-limited";
}

export interface GoUsage {
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

const isRecord = (val: unknown): val is Record<string, unknown> =>
  typeof val === "object" && val !== null;

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
      ...(sessionRaw.includedInPlan === true ? { includedInPlan: true } : {}),
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
       * `false` when the account has no OpenCode Go credential at all, which is
       * a configuration state rather than a fault: there is no quota to show,
       * so the client renders nothing instead of an unavailable meter. A
       * transient failure leaves it `true`/absent and stays visible with a
       * retry.
       */
      readonly configured?: boolean;
      readonly retainPrevious: boolean;
      readonly retryable: boolean;
      readonly source?: string;
    };
  }
  interface TypertRemoteNamespaceMap {
    opencodeGoUsage: {
      read: () => Promise<RemoteResult<GoUsage>>;
    };
  }
}

const usageCodec = {
  create: () => ({ parse: parseGoUsage }),
  mode: "strict" as const,
  schema: { parse: parseGoUsage },
  typeSymbol: "dsh-opencode-patch#GoUsage",
};

export const usageRemote: TypertRemoteContribution = {
  descriptors: [
    {
      id: "dsh-opencode-patch#opencodeGoUsage/read",
      invocation: { kind: "direct" },
      method: "read",
      namespace: "opencodeGoUsage",
      parameters: [],
      result: usageCodec,
      service: "opencodeGoUsage",
    },
  ],
  package: "dsh-opencode-patch",
};
