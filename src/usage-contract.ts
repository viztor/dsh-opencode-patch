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

export interface UsageWindow {
  percent: number;
  resetsAt: string;
  status: "ok" | "rate-limited";
}

export interface GoUsage {
  monthly: UsageWindow;
  rolling: UsageWindow;
  /** Opaque Host identity for this endpoint/account; never a credential or its hash. */
  source?: string;
  weekly: UsageWindow;
  /** Attached available Zen credit / balance (e.g. "$15.00", "Pay-as-you-go"). */
  zenCredit?: string;
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

  const { zenCredit: rootCredit, zenOverflow: rootOverflow } = root;
  const { zenCredit: sourceCredit, zenOverflow: sourceOverflow } = source;

  let zenCredit: string | undefined;
  if (typeof rootCredit === "string" && rootCredit.length > 0) {
    zenCredit = rootCredit;
  } else if (typeof sourceCredit === "string" && sourceCredit.length > 0) {
    zenCredit = sourceCredit;
  }

  let zenOverflow: boolean | undefined;
  if (typeof rootOverflow === "boolean") {
    zenOverflow = rootOverflow;
  } else if (typeof sourceOverflow === "boolean") {
    zenOverflow = sourceOverflow;
  }

  return {
    monthly,
    rolling,
    ...(sourceId === undefined ? {} : { source: sourceId }),
    weekly,
    ...(zenCredit === undefined ? {} : { zenCredit }),
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
