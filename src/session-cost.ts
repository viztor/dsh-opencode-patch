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

import type { CatalogPlane } from "./models-catalog.ts";

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
  /** The billing plane that served the turn — which balance the spend hits. */
  plane: CatalogPlane;
  timestamp: number;
  totalTokens: number;
}

export interface SessionUsageSnapshot {
  /**
   * The model that executed the most recent turn. A session may switch models
   * midway, so this is the *current* one, not the only one used.
   */
  activeModel?: string;
  /** The catalog's display name for {@link activeModel}, when it has one. */
  activeModelName?: string;
  /** Human-readable rate for {@link activeModel}, e.g. `$2.5 / $15 per 1M`. */
  activeRateFormatted?: string;
  cacheReadTokens: number;
  /** Spend attributed to each billing plane — Go allowance vs Zen balance. */
  costByPlane: { go: number; zen: number };
  costFormatted: string;
  costUsd: number;
  /**
   * THIS route's plane spend, projected by the usage service once it knows
   * which plane the reading is for. `costUsd` above is the session's
   * all-planes total and is the wrong number for a panel that answers for one
   * balance.
   */
  planeCostFormatted?: string;
  planeSpendUsd?: number;
  /**
   * True when the ACTIVE model is free — the catalog's free-tier flag, not a
   * plan entitlement. The name this carried (`includedInPlan`) said the Go plan
   * covered the cost, which is a different and often false claim: a free model
   * bills nothing at all, on any plan.
   */
  freeModel?: boolean;
  inputTokens: number;
  modelsUsed: string[];
  outputTokens: number;
  totalTokens: number;
  turns: number;
}

interface MutableSessionUsage {
  activeIsFree?: boolean;
  activeModelName?: string;
  activeModel?: string;
  activeRate?: ModelCostRate;
  cacheReadTokens: number;
  costGo: number;
  costUsd: number;
  costZen: number;
  history: TurnRecord[];
  inputTokens: number;
  modelsUsed: Set<string>;
  outputTokens: number;
  totalTokens: number;
  turns: number;
}

const sessionStore = new Map<string, MutableSessionUsage>();

/**
 * Format a USD dollar amount, always two decimals.
 *
 * The precision used to tier by magnitude — three decimals below a cent, four
 * below a tenth of one — and the owner read `$0.006` on the trigger and called
 * it too much precision in the wrong place. A meter is a gauge, not an
 * invoice: `$0.01` of a real spend is an honest rounding of six tenths of a
 * cent, the same rounding every wallet UI makes. Precision tiers reintroduce
 * the exact thing the panel keeps paying to remove — a number whose LENGTH
 * changes with its value, so the row shifts on every turn. (The allowance
 * table's `formatUsd` in go-limits.ts keeps its own contract: whole dollars
 * drop the cents, because a published $60 total is not the same kind of
 * figure as a metered spend.)
 */
export const formatUsd = (usd: number): string => `$${usd.toFixed(2)}`;

/** Format model rate per 1M tokens. */
export const formatModelRate = (
  cost?: ModelCostRate,
  isFree = false
): string => {
  if (cost === undefined) {
    // `isFree` is the one case where an absent rate is still a known answer:
    // the catalog said the model is free, so no price is the price.
    if (isFree) {
      return "Free";
    }
    // No rate data at all is NOT the same as free, and saying "Free" for a model
    // the catalog has never heard of is a claim nobody can make — it is how the
    // panel told the user a price it did not have. The catalog is refreshed on a
    // schedule, so a model newer than it reads "unknown" until the next sync.
    return "—";
  }
  if (isFree || (cost !== undefined && cost.input === 0 && cost.output === 0)) {
    // "Free Tier ($0.00)" repeated the row's own value in a field that otherwise
    // holds a PER-MILLION price, so the line read "$0.00" twice and the rate was
    // not a rate. The row says free in its own words; this field just says it.
    return "Free";
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
    /** Spend attributed to each billing plane; every turn knows its own. */
    costByPlane: { go: val.costGo, zen: val.costZen },
    costFormatted: formatUsd(val.costUsd),
    costUsd: val.costUsd,
    ...(val.activeIsFree === true ? { freeModel: true } : {}),
    inputTokens: val.inputTokens,
    modelsUsed: [...val.modelsUsed],
    outputTokens: val.outputTokens,
    totalTokens: val.totalTokens,
    turns: val.turns,
  };
};

/**
 * Record a completed turn's token usage into the session accumulator.
 *
 * `plane` is which billing plane served the turn — Go allowance or Zen balance —
 * and it is what makes the split below possible. A session that switches planes
 * midway (Go `mimo-v2.6-pro`, then Zen `mimo-v2.6-flash-free`) used to fold BOTH
 * planes' spend into one total, so the Zen panel billed the session with money
 * the Go allowance had paid. Each turn is attributed where it was served.
 */
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
  isFree = false,
  plane: CatalogPlane = "zen"
): SessionUsageSnapshot => {
  const existing = sessionStore.get(sessionId) ?? {
    cacheReadTokens: 0,
    costGo: 0,
    costUsd: 0,
    costZen: 0,
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
    plane,
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
    // meter always describes the model that will run the next turn. A turn
    // that names no model keeps the previous identity rather than blanking it.
    ...(existing.activeModel === undefined
      ? {}
      : { activeModel: existing.activeModel }),
    ...(existing.activeRate === undefined
      ? {}
      : { activeRate: existing.activeRate }),
    ...(existing.activeIsFree === undefined
      ? {}
      : { activeIsFree: existing.activeIsFree }),
    ...(named
      ? {
          activeIsFree: isFree,
          activeModel: model,
          ...(cost === undefined ? {} : { activeRate: cost }),
        }
      : {}),
    cacheReadTokens: existing.cacheReadTokens + (tokens.cacheReadTokens ?? 0),
    costGo: existing.costGo + (plane === "go" ? turnCost : 0),
    costZen: existing.costZen + (plane === "zen" ? turnCost : 0),
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

/**
 * Re-describe a snapshot for a DIFFERENT model, without touching the spend.
 *
 * The accumulator prices each turn at the model that ran it, so its `active*`
 * fields name the last one. The panel's rate is prospective — what the next turn
 * costs — so when the caller knows which model is selected now and it differs,
 * this swaps the identity and re-derives the rate from the catalog entry the Host
 * holds. The spend total is deliberately untouched: it is history.
 */
export const describeModel = (
  snapshot: SessionUsageSnapshot,
  model: string,
  rate: ModelCostRate | undefined,
  isFree: boolean,
  displayName?: string
): SessionUsageSnapshot => {
  // Dropped first: a paid model after a free one must not inherit `freeModel`.
  const { activeModelName: _wasNamed, freeModel: _wasFree, ...rest } = snapshot;
  return {
    ...rest,
    activeModel: model,
    // The id is what the gateway speaks; the name is what the catalog calls it.
    // `muse-spark-1.3-contributor-free` in a row that also says "free" says it
    // twice and reads like a debug value.
    ...(displayName === undefined ? {} : { activeModelName: displayName }),
    activeRateFormatted: formatModelRate(rate, isFree),
    ...(isFree ? { freeModel: true } : {}),
  };
};

/** Clear session usage (primarily for tests). */
export const clearSessionUsageStore = (): void => {
  sessionStore.clear();
};
