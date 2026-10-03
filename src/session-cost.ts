/**
 * Session token and dollar cost tracking with multi-model switching support.
 *
 * Users can switch models midway through a session (e.g. from Claude to DeepSeek
 * on Go, or to a free-tier model). This tracker records each turn using the exact
 * pricing rates of the model that executed that turn, maintains cumulative session
 * spend, and provides rate lookups for the currently selected model.
 *
 * @module dsh-opencode-patch/session-cost
 */

export interface ModelCostRate {
  cache_read?: number;
  cache_write?: number;
  input: number;
  output: number;
}

export interface TurnRecord {
  costFormatted: string;
  costUsd: number;
  inputTokens: number;
  isFree?: boolean;
  model: string;
  outputTokens: number;
  timestamp: number;
  totalTokens: number;
}

export interface SessionUsageSnapshot {
  /**
   * The model that executed the most recent turn. A session may switch models
   * midway, so this is the *current* one, not the only one used.
   */
  activeModel?: string;
  /** Human-readable rate for {@link activeModel}, e.g. `$2.5 / $15 per 1M`. */
  activeRateFormatted?: string;
  cacheReadTokens: number;
  costFormatted: string;
  costUsd: number;
  /** True when the active model bills nothing (free tier or plan-included). */
  includedInPlan?: boolean;
  inputTokens: number;
  modelsUsed: string[];
  outputTokens: number;
  totalTokens: number;
  turns: number;
}

interface MutableSessionUsage {
  activeIsFree?: boolean;
  activeModel?: string;
  activeRate?: ModelCostRate;
  cacheReadTokens: number;
  costUsd: number;
  history: TurnRecord[];
  inputTokens: number;
  modelsUsed: Set<string>;
  outputTokens: number;
  totalTokens: number;
  turns: number;
}

const sessionStore = new Map<string, MutableSessionUsage>();

/** Format a USD dollar amount with appropriate decimal precision. */
export const formatUsd = (usd: number): string => {
  if (usd === 0) {
    return "$0.00";
  }
  if (usd < 0.001) {
    return `$${usd.toFixed(4)}`;
  }
  if (usd < 0.01) {
    return `$${usd.toFixed(3)}`;
  }
  return `$${usd.toFixed(2)}`;
};

/** Format model rate per 1M tokens. */
export const formatModelRate = (
  cost?: ModelCostRate,
  isFree = false
): string => {
  if (isFree || cost === undefined || (cost.input === 0 && cost.output === 0)) {
    return "Free Tier ($0.00)";
  }
  return `$${cost.input} / $${cost.output} per 1M`;
};

/** Calculate the cost of a turn given tokens and pricing rates (prices per 1M tokens). */
export const calculateTurnCost = (
  tokens: {
    cacheReadTokens?: number;
    inputTokens?: number;
    outputTokens?: number;
  },
  cost?: ModelCostRate,
  isFree = false
): number => {
  if (isFree || cost === undefined) {
    return 0;
  }
  const inputCost = ((tokens.inputTokens ?? 0) * cost.input) / 1_000_000;
  const outputCost = ((tokens.outputTokens ?? 0) * cost.output) / 1_000_000;
  const cacheCost =
    ((tokens.cacheReadTokens ?? 0) * (cost.cache_read ?? 0)) / 1_000_000;
  return inputCost + outputCost + cacheCost;
};

/** Project the mutable accumulator into the wire snapshot. */
const toSnapshot = (val: MutableSessionUsage): SessionUsageSnapshot => {
  const { activeModel } = val;
  return {
    ...(activeModel === undefined ? {} : { activeModel }),
    ...(activeModel === undefined
      ? {}
      : {
          activeRateFormatted: formatModelRate(
            val.activeRate,
            val.activeIsFree === true
          ),
        }),
    cacheReadTokens: val.cacheReadTokens,
    costFormatted: formatUsd(val.costUsd),
    costUsd: val.costUsd,
    ...(val.activeIsFree === true ? { includedInPlan: true } : {}),
    inputTokens: val.inputTokens,
    modelsUsed: [...val.modelsUsed],
    outputTokens: val.outputTokens,
    totalTokens: val.totalTokens,
    turns: val.turns,
  };
};

/** Record a completed turn's token usage into the session accumulator. */
export const recordTurnUsage = (
  sessionId: string,
  tokens: {
    cacheReadTokens?: number;
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  },
  cost?: ModelCostRate,
  model = "unknown",
  isFree = false
): SessionUsageSnapshot => {
  const existing = sessionStore.get(sessionId) ?? {
    cacheReadTokens: 0,
    costUsd: 0,
    history: [],
    inputTokens: 0,
    modelsUsed: new Set<string>(),
    outputTokens: 0,
    totalTokens: 0,
    turns: 0,
  };

  const turnCost = calculateTurnCost(tokens, cost, isFree);
  const total =
    tokens.totalTokens ??
    (tokens.inputTokens ?? 0) + (tokens.outputTokens ?? 0);

  const turnRecord: TurnRecord = {
    costFormatted: formatUsd(turnCost),
    costUsd: turnCost,
    inputTokens: tokens.inputTokens ?? 0,
    ...(isFree ? { isFree: true } : {}),
    model,
    outputTokens: tokens.outputTokens ?? 0,
    timestamp: Date.now(),
    totalTokens: total,
  };

  const modelsUsed = new Set(existing.modelsUsed);
  const named = model.length > 0 && model !== "unknown";
  if (named) {
    modelsUsed.add(model);
  }

  const updated: MutableSessionUsage = {
    // Switching models mid-session replaces the "active" identity, so the
    // meter always describes the model that will run the next turn.
    ...(named
      ? {
          activeIsFree: isFree,
          activeModel: model,
          ...(cost === undefined ? {} : { activeRate: cost }),
        }
      : {}),
    cacheReadTokens: existing.cacheReadTokens + (tokens.cacheReadTokens ?? 0),
    costUsd: existing.costUsd + turnCost,
    history: [...existing.history, turnRecord],
    inputTokens: existing.inputTokens + (tokens.inputTokens ?? 0),
    modelsUsed,
    outputTokens: existing.outputTokens + (tokens.outputTokens ?? 0),
    totalTokens: existing.totalTokens + total,
    turns: existing.turns + 1,
  };

  sessionStore.set(sessionId, updated);

  return toSnapshot(updated);
};

/** Read accumulated token and dollar usage for a session (or the latest active session). */
export const getSessionUsage = (
  sessionId?: string
): SessionUsageSnapshot | undefined => {
  const found =
    sessionId === undefined ? undefined : sessionStore.get(sessionId);
  if (found !== undefined) {
    return toSnapshot(found);
  }
  const latest = [...sessionStore.values()].at(-1);
  return latest === undefined ? undefined : toSnapshot(latest);
};

/** Clear session usage (primarily for tests). */
export const clearSessionUsageStore = (): void => {
  sessionStore.clear();
};
