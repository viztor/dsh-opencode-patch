/**
 * OpenCode Go credential & gateway discovery.
 *
 * The Go plan's key and endpoint normally live in another plugin's row (an
 * `llm-pi-ai` provider registry or a standalone `opencode-go` entry) rather
 * than in this one, so before prompting the user for config the plugin reads
 * what the composition already declares and only falls back to its own
 * `usageKeyEnv`/`usageBaseURL` settings afterwards.
 *
 * @module dsh-opencode-patch/go-discovery
 */

import { DEFAULT_USAGE_BASE_URL, DEFAULT_USAGE_KEY_ENV } from "./config.ts";
import { isLoaderHost, readCredentialsResolver } from "./cordis-context.ts";
import { isRecord } from "./guards.ts";

/** Gateway settings found in other entries, if any. */
export interface DiscoveredGoConfig {
  baseURL?: string;
  keyEnv?: string;
  literalKey?: string;
}

const readProviderRow = (
  row: Record<string, unknown>,
  into: DiscoveredGoConfig
): void => {
  const keyEnv: unknown = row.apiKeyEnv;
  if (typeof keyEnv === "string" && keyEnv.length > 0) {
    into.keyEnv = keyEnv;
  }
  const literalKey: unknown = row.apiKey;
  if (typeof literalKey === "string" && literalKey.length > 0) {
    into.literalKey = literalKey;
  }
  const baseURL: unknown = row.baseURL;
  if (typeof baseURL === "string" && baseURL.length > 0) {
    into.baseURL = baseURL;
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
      }
      if (isRecord(providers["opencode-go"])) {
        readProviderRow(providers["opencode-go"], result);
      }
      if (isRecord(providers.opencode)) {
        readProviderRow(providers.opencode, result);
      }
      for (const pRow of Object.values(providers)) {
        if (isRecord(pRow)) {
          const bUrl: unknown = pRow.baseURL;
          if (typeof bUrl === "string" && bUrl.includes("opencode.ai")) {
            readProviderRow(pRow, result);
          }
        }
      }
    }

    // 2. Standalone provider entries like `id: opencode-go` or `id: opencode`.
    const { id, name } = options;
    if (
      (typeof targetProvider === "string" &&
        (id === targetProvider || name === targetProvider)) ||
      id === "opencode-go" ||
      id === "opencode" ||
      name === "dsh-opencode-go" ||
      name === "dsh-opencode"
    ) {
      readProviderRow(config, result);
    }
  }

  return result;
};

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
    if (discovered.baseURL.includes("opencode.ai/zen/v1")) {
      return discovered.baseURL.replace(
        "opencode.ai/zen/v1",
        "opencode.ai/zen/go/v1"
      );
    }
    return discovered.baseURL;
  }
  return configured;
};

/**
 * The effective credential reference for Go key lookups.
 *
 * An explicit non-default config wins outright; when the config still says
 * the default, a reference discovered from the composition refines it, so an
 * `apiKeyEnv` shipped by the provider registry is honored without the user
 * copying it into this row.
 *
 * @param discovered - result of {@link discoverGoConfig} (reuse when already computed).
 * @param configuredKeyEnv - the row's `usageKeyEnv` setting, if any.
 */
export const effectiveGoKeyRef = (
  discovered: DiscoveredGoConfig,
  configuredKeyEnv?: string
): string => {
  const explicit =
    configuredKeyEnv !== undefined && configuredKeyEnv.trim().length > 0
      ? configuredKeyEnv.trim()
      : undefined;
  if (explicit !== undefined && explicit !== DEFAULT_USAGE_KEY_ENV) {
    return explicit;
  }
  return discovered.keyEnv ?? explicit ?? DEFAULT_USAGE_KEY_ENV;
};

/**
 * Resolve the Go API key without ever exposing it to the client.
 *
 * Order: a literal `apiKey` discovered in another entry (composition wins
 * over config), then the credential service for the effective reference
 * (explicit config, unless it is just the default — discovery refines the
 * default), then environment fallbacks.
 *
 * @param ctx - the plugin context used for discovery and credentials.
 * @param configuredKeyEnv - the row's `usageKeyEnv` setting.
 * @param targetProvider - optional specific provider route id to prioritize.
 * @returns the key, or `undefined` when nothing resolves — the caller raises
 * the typed `MISSING_CREDENTIAL` error instead of a raw one.
 */
export const resolveGoApiKey = async (
  ctx: unknown,
  configuredKeyEnv?: string,
  targetProvider?: string
): Promise<string | undefined> => {
  const discovered = discoverGoConfig(ctx, targetProvider);
  if (
    typeof discovered.literalKey === "string" &&
    discovered.literalKey.length > 0
  ) {
    return discovered.literalKey;
  }
  const ref = effectiveGoKeyRef(discovered, configuredKeyEnv);
  const key = await resolveGoKeyForRef(ctx, ref);
  return key;
};

/**
 * Look one credential reference up through the credential service, then the
 * environment. Never throws: a failing credentials service degrades to the
 * env path.
 *
 * Zen keys (`OPENCODE_API_KEY` / `oc_sk_...`) are excluded here because Zen
 * keys lack the OpenCode Go subscription entitlement and will 403 when sent
 * to the Go quota endpoint.
 *
 * @param ctx - the plugin context used for credentials.
 * @param ref - effective credential reference from {@link effectiveGoKeyRef}.
 */
export const resolveGoKeyForRef = async (
  ctx: unknown,
  ref: string
): Promise<string | undefined> => {
  const isZenRef = ref === "OPENCODE_API_KEY";
  const resolve = readCredentialsResolver(ctx);
  if (resolve !== undefined) {
    const candidates = isZenRef
      ? [DEFAULT_USAGE_KEY_ENV]
      : [ref, DEFAULT_USAGE_KEY_ENV];
    const results = await Promise.allSettled(
      candidates.map((candidate) => resolve(candidate))
    );
    for (const res of results) {
      if (
        res.status === "fulfilled" &&
        res.value?.value !== undefined &&
        res.value.value.length > 0 &&
        !res.value.value.startsWith("oc_sk_")
      ) {
        return res.value.value;
      }
    }
  }

  if (!isZenRef) {
    const fromEnv = process.env[ref];
    if (
      fromEnv !== undefined &&
      fromEnv.length > 0 &&
      !fromEnv.startsWith("oc_sk_")
    ) {
      return fromEnv;
    }
  }
  const fallback = process.env[DEFAULT_USAGE_KEY_ENV];
  if (
    fallback !== undefined &&
    fallback.length > 0 &&
    !fallback.startsWith("oc_sk_")
  ) {
    return fallback;
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
 * is configured in DSH credentials or environment.
 *
 * @param ctx - plugin context used for credentials service lookup.
 */
export const resolveZenCreditInfo = async (
  ctx: unknown
): Promise<ZenCreditInfo> => {
  const resolve = readCredentialsResolver(ctx);

  if (resolve !== undefined) {
    try {
      const zenKeyRes = await resolve("OPENCODE_API_KEY");
      if (zenKeyRes?.value !== undefined && zenKeyRes.value.length > 0) {
        return { isConfigured: true };
      }
    } catch {
      // Degrade silently to env check
    }
  }
  const generic = process.env.OPENCODE_API_KEY;
  if (generic !== undefined && generic.length > 0) {
    return { isConfigured: true };
  }

  return { isConfigured: false };
};
