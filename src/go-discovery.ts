/**
 * OpenCode Go credential & gateway discovery.
 *
 * The Go plan's key and endpoint normally live in another plugin's row (an
 * `llm-pi-ai` provider registry or a standalone `opencode-go` entry) rather
 * than in this one, so this module reads what the composition already declares
 * and falls back to a built-in default. There is deliberately **no** row setting
 * for the credential reference: a knob here would duplicate the provider row's
 * own `apiKeyEnv`, and the live request is the better source anyway
 * (`key-capture.ts`). `usageBaseURL` remains as the one endpoint override.
 *
 * Credential *capture* — pulling a key off a live request and classifying its
 * tier — lives in `key-capture.ts`. This module owns the plan side: which
 * endpoint, which credential reference, and the policy that orders the two
 * sources against each other.
 *
 * @module dsh-opencode-patch/go-discovery
 */

import type { KeySourcePolicy } from "./config-values.ts";
import { DEFAULT_USAGE_BASE_URL, DEFAULT_USAGE_KEY_ENV } from "./config.ts";
import { isLoaderHost, readCredentialsResolver } from "./cordis-context.ts";
import { isRecord } from "./guards.ts";
import {
  extractApiKeyFromHeaders,
  getCapturedApiKey,
  isPlaceholderApiKey,
} from "./key-capture.ts";

/** Gateway settings found in other entries, if any. */
export interface DiscoveredGoConfig {
  baseURL?: string;
  keyEnv?: string;
  literalKey?: string;
}

/**
 * A configured string that is worth treating as a credential.
 *
 * Two rejections, and both are load-bearing rather than tidiness:
 *
 * - **Whitespace.** `apiKey: "   "` is what a YAML file produces when someone
 *   indents a secret they then blank out. It passes a bare `length > 0`, and
 *   since `literal` is the FIRST step of both `auto` and `configured`, it would
 *   outrank a working stored credential. `config-values.ts:readString` already
 *   trims, so this is also where the two halves of the repo used to disagree.
 * - **Placeholders.** `Bearer unused` is not a typo — it is what this plugin's
 *   own keyless routes carry, and what the README tells users to write. It is a
 *   deliberate stand-in for "this route needs a key injected later", so it must
 *   never be mistaken for the key itself. `recordCapturedApiKey` already refuses
 *   one; a discovered literal has to refuse it too, or the meter's first step
 *   hands the gateway a placeholder and the poll fails with a 401 that reads
 *   like a missing subscription.
 */
const usableCredential = (value: unknown): value is string =>
  typeof value === "string" &&
  value.trim().length > 0 &&
  !isPlaceholderApiKey(value.trim());

const readProviderRow = (
  row: Record<string, unknown>,
  into: DiscoveredGoConfig
): void => {
  const keyEnv: unknown = row.apiKeyEnv;
  if (typeof keyEnv === "string" && keyEnv.length > 0) {
    into.keyEnv = keyEnv;
  }
  if (into.literalKey === undefined && usableCredential(row.apiKey)) {
    into.literalKey = row.apiKey.trim();
  }
  const baseURL: unknown = row.baseURL;
  if (typeof baseURL === "string" && baseURL.length > 0) {
    into.baseURL = baseURL;
  }

  if (into.literalKey === undefined) {
    const fromHeaders = extractApiKeyFromHeaders(row.headers);
    if (usableCredential(fromHeaders)) {
      into.literalKey = fromHeaders.trim();
    }
  }
  if (into.literalKey === undefined && isRecord(row.options)) {
    if (usableCredential(row.options.apiKey)) {
      into.literalKey = row.options.apiKey.trim();
    } else {
      const fromOptHeaders = extractApiKeyFromHeaders(row.options.headers);
      if (usableCredential(fromOptHeaders)) {
        into.literalKey = fromOptHeaders.trim();
      }
    }
  }
};

/**
 * Auto-discover OpenCode Go provider configuration from loaded Cordis
 * entries (e.g. llm-pi-ai), honoring both shapes it ships in: a
 * provider row inside a provider registry, and a standalone entry.
 *
 * Checks `targetProvider` first if specified, then falls back to `opencode-go`
 * and `opencode` (Zen), or any provider pointing to `opencode.ai`.
 *
 * Later entries win, mirroring composition order.
 *
 * @param ctx - the plugin context, mock or real.
 * @param targetProvider - optional specific provider route id to prioritize.
 */
export const discoverGoConfig = (
  ctx: unknown,
  targetProvider?: string
): DiscoveredGoConfig => {
  const result: DiscoveredGoConfig = {};
  if (!isLoaderHost(ctx)) {
    return result;
  }

  for (const entry of ctx.loader.entries()) {
    if (!isRecord(entry)) {
      continue;
    }
    const options: unknown = entry.options;
    if (!isRecord(options)) {
      continue;
    }
    const config: unknown = options.config;
    if (!isRecord(config)) {
      continue;
    }

    // 1. Providers inside a provider registry like llm-pi-ai.
    const providers: unknown = config.providers;
    if (isRecord(providers)) {
      if (
        typeof targetProvider === "string" &&
        targetProvider.length > 0 &&
        isRecord(providers[targetProvider])
      ) {
        readProviderRow(providers[targetProvider], result);
        continue;
      }
      if (isRecord(providers["opencode-go"])) {
        readProviderRow(providers["opencode-go"], result);
      } else if (isRecord(providers.opencode)) {
        readProviderRow(providers.opencode, result);
      } else {
        for (const pRow of Object.values(providers)) {
          if (isRecord(pRow)) {
            const bUrl: unknown = pRow.baseURL;
            if (typeof bUrl === "string" && bUrl.includes("opencode.ai")) {
              readProviderRow(pRow, result);
              break;
            }
          }
        }
      }
    }

    // 2. Standalone provider entries like `id: opencode-go` or `id: opencode`.
    const { id, name } = options;
    if (
      typeof targetProvider === "string" &&
      targetProvider.length > 0 &&
      (id === targetProvider || name === targetProvider)
    ) {
      readProviderRow(config, result);
      continue;
    }
    if (
      targetProvider === undefined &&
      (id === "opencode-go" ||
        id === "opencode" ||
        name === "dsh-opencode-go" ||
        name === "dsh-opencode")
    ) {
      readProviderRow(config, result);
    }
  }

  return result;
};

/**
 * Point a Zen base URL at the Go quota endpoint.
 *
 * The two share a host, so a base URL discovered from a Zen provider row
 * (`…/zen/v1`) still addresses the Go plan's `/usage` once rewritten; every
 * other URL passes through untouched.
 *
 * @param url - candidate base URL.
 */
export const toGoBaseURL = (url: string): string =>
  url.includes("opencode.ai/zen/v1")
    ? url.replace("opencode.ai/zen/v1", "opencode.ai/zen/go/v1")
    : url;

/**
 * Base URL for Go quota requests: an explicit non-default config wins,
 * otherwise a discovered gateway URL, otherwise the configured default.
 *
 * @param ctx - the plugin context used for discovery.
 * @param configured - the row's `usageBaseURL` setting.
 * @param targetProvider - optional specific provider route id to prioritize.
 */
export const resolveGoBaseURL = (
  ctx: unknown,
  configured: string,
  targetProvider?: string
): string => {
  if (configured.length > 0 && configured !== DEFAULT_USAGE_BASE_URL) {
    return configured;
  }
  const discovered = discoverGoConfig(ctx, targetProvider);
  if (discovered.baseURL !== undefined && discovered.baseURL.length > 0) {
    return toGoBaseURL(discovered.baseURL);
  }
  return configured;
};

/**
 * The effective credential reference for Go key lookups.
 *
 * The composition is the only place a reference comes from: an `apiKeyEnv`
 * declared by the provider registry is honoured as-is, and the built-in default
 * is the fallback. There is deliberately no row setting for this — a knob here
 * would duplicate the provider row's own declaration, which is exactly the
 * setting a user has already made once.
 *
 * @param discovered - result of {@link discoverGoConfig} (reuse when already computed).
 */
export const effectiveGoKeyRef = (discovered: DiscoveredGoConfig): string =>
  discovered.keyEnv ?? DEFAULT_USAGE_KEY_ENV;

/**
 * One lookup step a policy can consult.
 *
 * `captured` is scoped to the route in hand; `capturedAny` accepts a key
 * captured under any route. They are separate steps so `auto` can keep
 * credentials ahead of the any-route fallback, exactly as it always has.
 */
type KeySourceStep = "captured" | "capturedAny" | "configured" | "literal";

/**
 * The lookup order each policy imposes — the only thing the user is choosing
 * between.
 *
 * `auto` reproduces the original precedence exactly, so the default is not a
 * behaviour change: composition first, then a captured key in the right tier,
 * then credentials/env, then any captured key. `request` promotes both captured
 * steps above the declared sources; `configured` does the reverse.
 *
 * Tier safety is orthogonal and applies to all three: a step that returns a key
 * for the wrong tier is never consulted, because the Go endpoint rejects a Zen
 * key outright.
 */
const KEY_SOURCE_ORDER: Record<KeySourcePolicy, readonly KeySourceStep[]> = {
  auto: ["literal", "captured", "configured", "capturedAny"],
  configured: ["literal", "configured", "captured", "capturedAny"],
  request: ["captured", "capturedAny", "literal", "configured"],
};

/** First non-empty result from a policy's steps, or `undefined`. */
const firstResolved = async (
  order: readonly KeySourceStep[],
  steps: Record<KeySourceStep, () => unknown>
): Promise<string | undefined> => {
  for (const step of order) {
    // Sequential on purpose: the order IS the policy, and a later step must not
    // run (or be able to throw) once an earlier one has answered.
    // oxlint-disable-next-line no-await-in-loop -- see above; order is the contract.
    const value: unknown = await steps[step]();
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return undefined;
};

/**
 * Resolve the Go API key without ever exposing it to the client.
 *
 * Order is {@link KEY_SOURCE_ORDER}`[policy]`; with the default `auto` that is
 * a literal `apiKey` discovered in another entry, then a captured key for the
 * Go tier, then the credential service and environment, then any captured key.
 *
 * @param ctx - the plugin context used for discovery and credentials.
 * @param targetProvider - optional specific provider route id to prioritize.
 * @param policy - which source wins when several resolve.
 * @returns the key, or `undefined` when nothing resolves — the caller raises
 * the typed `MISSING_CREDENTIAL` error instead of a raw one.
 */
export const resolveGoApiKey = (
  ctx: unknown,
  targetProvider?: string,
  policy: KeySourcePolicy = "auto"
): Promise<string | undefined> => {
  const discovered = discoverGoConfig(ctx, targetProvider);
  return firstResolved(KEY_SOURCE_ORDER[policy], {
    captured: () => getCapturedApiKey(targetProvider, "go"),
    capturedAny: () => getCapturedApiKey(undefined, "go"),
    configured: () => resolveGoKeyForRef(ctx, effectiveGoKeyRef(discovered)),
    literal: () => discovered.literalKey,
  });
};

/**
 * Resolve one credential reference through the credentials service, then the
 * environment.
 *
 * Never throws: a failing credentials service degrades to the env path.
 *
 * @param ctx - the plugin context used for credentials.
 * @param ref - credential reference to look up.
 */
const resolveRef = async (
  ctx: unknown,
  ref: string
): Promise<string | undefined> => {
  const resolve = readCredentialsResolver(ctx);
  if (resolve !== undefined) {
    try {
      const hit = await resolve(ref);
      if (hit?.value !== undefined && hit.value.length > 0) {
        return hit.value;
      }
    } catch {
      // Fall through to the environment.
    }
  }
  const fromEnv = process.env[ref];
  return fromEnv !== undefined && fromEnv.length > 0 ? fromEnv : undefined;
};

/**
 * Whether a resolved value is a usable credential for the Go quota endpoint.
 *
 * There is no prefix test here any more, and the reason is measured rather than
 * argued. This used to reject `oc_sk_…` on the belief that "Zen keys lack the
 * OpenCode Go subscription entitlement and will 403 when sent to the Go quota
 * endpoint". Probed live on 2026-10-08: an `oc_sk_…` key stored as
 * `OPENCODE_GO_API_KEY` answers `/zen/go/v1/usage` with **HTTP 200 and real
 * windows** — OpenCode issues that prefix for Go credentials too, so the prefix
 * does not name a tier.
 *
 * The cost of the old guard was not a wasted request; it was the ONE credential
 * that worked being thrown away, after which the meter fell through to
 * `capturedAny` (or to no key at all) and drew an overflow card with no quota
 * anywhere on it. `usage.ts`'s `403 EntitlementError` branch is what handles a
 * credential that genuinely lacks Go entitlement — the endpoint's own answer,
 * rather than a guess about a string.
 */
const isUsableGoKey = (value: string | undefined): value is string =>
  value !== undefined && value.length > 0 && !isPlaceholderApiKey(value);

/**
 * Look one credential reference up for the Go quota endpoint.
 *
 * Zen keys (`OPENCODE_API_KEY` / `oc_sk_…`) are excluded because Zen keys lack
 * the OpenCode Go subscription entitlement and will 403 when sent to the Go
 * quota endpoint. That exclusion is why this is not just {@link resolveRef}: the
 * routed-provider lookup below must accept a Zen key, because there the Zen tier
 * is the target rather than a mistake.
 *
 * @param ctx - the plugin context used for credentials.
 * @param ref - effective credential reference from {@link effectiveGoKeyRef}.
 */
export const resolveGoKeyForRef = async (
  ctx: unknown,
  ref: string
): Promise<string | undefined> => {
  // Deduplicated rather than merely conditional: when the declared reference IS
  // the built-in default — which is exactly the common case, since
  // `effectiveGoKeyRef` falls back to it — `[ref, DEFAULT]` asks the credentials
  // service the same question twice on every meter poll. Order is preserved,
  // because order is the policy.
  const candidates =
    ref === "OPENCODE_API_KEY" || ref === DEFAULT_USAGE_KEY_ENV
      ? [DEFAULT_USAGE_KEY_ENV]
      : [ref, DEFAULT_USAGE_KEY_ENV];

  // Every reference is tried through the credentials service before the
  // environment is consulted at all, so a stored credential always beats a
  // stale exported variable.
  const resolve = readCredentialsResolver(ctx);
  if (resolve !== undefined) {
    const results = await Promise.allSettled(
      candidates.map((candidate) => resolve(candidate))
    );
    for (const result of results) {
      if (result.status !== "fulfilled") {
        continue;
      }
      const value = result.value?.value;
      if (isUsableGoKey(value)) {
        return value;
      }
    }
  }

  for (const candidate of candidates) {
    const value = process.env[candidate];
    if (isUsableGoKey(value)) {
      return value;
    }
  }
  return undefined;
};

/** Result of resolving Zen credit/balance status. */
export interface ZenCreditInfo {
  isConfigured: boolean;
}

/**
 * Resolve whether OpenCode Zen pay-as-you-go is configured.
 *
 * Checks whether an OpenCode Zen key (`OPENCODE_API_KEY` or `oc_sk_...`)
 * is configured in DSH credentials or environment. There is no endpoint to ask
 * for a balance, so this answers "can the Go plan overflow into Zen credit?"
 * rather than "how much credit is left".
 *
 * @param ctx - plugin context used for credentials service lookup.
 */
export const resolveZenCreditInfo = async (
  ctx: unknown
): Promise<ZenCreditInfo> => {
  const capturedZen = getCapturedApiKey("opencode", "zen");
  if (capturedZen !== undefined && capturedZen.length > 0) {
    return { isConfigured: true };
  }

  const zenKey = await resolveRef(ctx, "OPENCODE_API_KEY");
  return { isConfigured: zenKey !== undefined };
};

/** Key resolution details for a routed provider. */
export interface RoutedKeyDetails {
  key?: string;
  keyPrefix?: string;
  provider: string;
  tier: "go" | "zen" | "unknown";
}

/**
 * Resolve the effective API key and account tier for a currently routed provider.
 *
 * Unlike {@link resolveGoApiKey} this never rejects a Zen key: the routed
 * provider *is* the tier, so a Zen route legitimately resolves a Zen key.
 *
 * @param ctx - plugin context
 * @param provider - routed provider name (e.g. "opencode-go", "opencode")
 * @param policy - which source wins when several resolve.
 */
export const resolveRoutedKey = async (
  ctx: unknown,
  provider: string,
  policy: KeySourcePolicy = "auto"
): Promise<RoutedKeyDetails> => {
  const discovered = discoverGoConfig(ctx, provider);
  const isGoRoute = provider === "opencode-go";
  const configuredRef =
    discovered.keyEnv ??
    (isGoRoute ? DEFAULT_USAGE_KEY_ENV : "OPENCODE_API_KEY");

  const key = await firstResolved(KEY_SOURCE_ORDER[policy], {
    captured: () => getCapturedApiKey(provider, isGoRoute ? "go" : undefined),
    capturedAny: () => getCapturedApiKey(undefined, isGoRoute ? "go" : "zen"),
    configured: () => resolveRef(ctx, configuredRef),
    literal: () => discovered.literalKey,
  });

  // Inverse precedence of `recordCapturedApiKey`: here the routed provider is
  // authoritative, because the resolved key may be a shared or fallback
  // credential whose prefix says nothing about the route in use.
  let tier: "go" | "zen" | "unknown" = "unknown";
  if (isGoRoute || (key !== undefined && key.startsWith("sk-"))) {
    tier = "go";
  } else if (
    provider === "opencode" ||
    (key !== undefined && key.startsWith("oc_sk_"))
  ) {
    tier = "zen";
  }

  // The floor matches the slice, so an 8- or 9-character key is not reported
  // whole: a "prefix" that happens to be the entire secret leaks more than the
  // eight characters it was supposed to.
  const keyPrefix =
    key !== undefined && key.length >= 10 ? key.slice(0, 10) : undefined;

  return {
    key,
    keyPrefix,
    provider,
    tier,
  };
};
