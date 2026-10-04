/**
 * Register the gateway's Responses plane from the plugin, reusing DSH's own
 * pi-ai adapter.
 *
 * The requirement this exists for: **the user changes nothing.** They keep the
 * `opencode` provider and the key they already have, and the model that the
 * gateway serves on `/responses` simply works. That rules out the two shapes
 * tried before it:
 *
 * - A route declared in the profile means user configuration, which is what we
 *   are removing.
 * - A second `llm-pi-ai` row cannot mount: `registerPiAiFlows` registers an
 *   authorization flow per installed catalog provider id and
 *   `authorization.registerFlow` throws `DUPLICATE_FLOW` on the second instance.
 *
 * So the plugin registers the route itself. **Nothing is reimplemented**:
 * `llm-pi-ai` exports `PiAiAdapter` (its pi-ai-event-to-`StreamChunk`
 * translation), `resolveProfiles` (the resolver that materialises defaults and
 * models), and `credentialStoreFrom` / `authContextFrom`. The package's exports
 * map carries `"./src/*"`, so the two that are not re-exported from the root are
 * reachable by deep path. This module is glue, not a protocol client.
 *
 * The route's models are read from the catalog rather than listed: every model
 * whose `provider.npm` names the OpenAI SDK is served on `/responses`, so the
 * route covers all of them instead of the one a hand-written list would name.
 *
 * @module dsh-opencode-patch/responses-provider
 */

import type { CordisContext } from "./cordis-context.ts";
import { isRecord } from "./guards.ts";
import { getLiveGoCatalog, getLiveZenCatalog } from "./models-catalog.ts";
import { RESPONSES_ROUTE, RESPONSES_SDK } from "./responses-routes.ts";

/** The harness package whose adapter and resolvers this module reuses. */
const PI_AI_PACKAGE = "@deepseek-ai/dsh-llm-pi-ai";

/** The gateway's Responses endpoint, shared by both planes. */
const ZEN_BASE_URL = "https://opencode.ai/zen/v1";

/**
 * The credential the user already configured for `opencode`. Read, never
 * re-asked: the route this module registers authenticates with the same key.
 */
const USER_CREDENTIAL_REF = "OPENCODE_API_KEY";

/**
 * What `resolveApiKey` returns: nothing. The route's own `apiKeyEnv` is the
 * credential source, and `llm-pi-ai` reads it through the same services this
 * module passes in, so there is no per-call override to supply.
 */
const NO_KEY_OVERRIDE: string | undefined = undefined;

/** One model entry, in the shape `llm-pi-ai`'s config schema expects. */
interface ModelProfile {
  contextWindow: number;
  id: string;
  input: string[];
  maxTokens: number;
  name: string;
}

/**
 * Every catalog model the gateway serves on the Responses API.
 *
 * Read from the catalog's `provider.npm`, the vendor's own statement of the
 * split, so this list never has to be maintained.
 *
 * @returns one profile per model, deduplicated across both planes.
 */
export const responsesModelProfiles = (): ModelProfile[] => {
  const seen = new Set<string>();
  const profiles: ModelProfile[] = [];
  for (const spec of [...getLiveZenCatalog(), ...getLiveGoCatalog()]) {
    if (spec.provider_npm !== RESPONSES_SDK || seen.has(spec.id)) {
      continue;
    }
    seen.add(spec.id);
    profiles.push({
      contextWindow: spec.context_window,
      id: spec.id,
      input: [...spec.input_modalities],
      maxTokens: spec.max_output_tokens,
      name: spec.name,
    });
  }
  return profiles;
};

/**
 * The provider profile for the Responses route, in the shape the config schema
 * takes — so `resolveProfiles` can materialise it exactly as it would a
 * configured one.
 *
 * @param models - the models to serve.
 * @returns the profile, keyed by nothing yet (the caller keys it).
 */
const responsesProviderProfile = (models: readonly ModelProfile[]) => ({
  // The sentinel: pi-ai's `getClientApiKey` THROWS when a route names neither a
  // key nor an `authorization` header, before `fetch` — so the credential
  // captured from `opencode` never gets a chance to be injected without it.
  headers: { authorization: "Bearer unused" },
  api: "openai-responses",
  apiKeyEnv: USER_CREDENTIAL_REF,
  baseURL: ZEN_BASE_URL,
  models: [...models],
});

/**
 * Register the Responses route with the host's LLM registry.
 *
 * Never throws: a deployment without `llm-pi-ai` installed, or one that already
 * declares the route, leaves the caller with the previous behaviour rather than
 * a failed boot. Every failure is reported so it is not silent.
 *
 * @param ctx - host context carrying the LLM registry and the services the
 *   adapter needs.
 * @returns the disposer withdrawing the registration, or `undefined` when the
 *   route could not be registered.
 */
export const registerResponsesProvider = async (
  ctx: CordisContext
): Promise<(() => void) | undefined> => {
  const { llm } = ctx;
  if (llm === undefined || typeof llm.registerAdapter !== "function") {
    return undefined;
  }
  // A deployment that already declares the route in its profile keeps it: the
  // user hand-picks the models it serves, and registering over that would both
  // throw `DUPLICATE_ADAPTER` and take that choice away. Deferring is the point
  // — this module exists so a deployment that declares NOTHING still works, not
  // to override one that does.
  const existing = llm.listProviders?.();
  if (
    Array.isArray(existing) &&
    existing.some((route) => isRecord(route) && route.id === RESPONSES_ROUTE)
  ) {
    ctx.logger?.info?.(
      "[dsh-opencode-patch] %s is already declared; leaving it alone",
      RESPONSES_ROUTE
    );
    return undefined;
  }
  try {
    // Dynamic, so a profile without `llm-pi-ai` degrades instead of failing to
    // resolve the import at load time. The module is resolved at runtime, so its
    // exports cannot be typed here — the `typeof` guards below are the runtime
    // check these casts stand in for.
    // oxlint-disable typescript/no-unsafe-assignment, typescript/no-unsafe-type-assertion, typescript/no-unsafe-call, typescript/no-unsafe-member-access -- see above.
    const piAi: Record<string, unknown> = await import(PI_AI_PACKAGE);
    const { PiAiAdapter, credentialStoreFrom, authContextFrom } = piAi;
    const { resolveProfiles } = (await import(
      `${PI_AI_PACKAGE}/src/config.ts`
    )) as { resolveProfiles: (providers: unknown) => unknown };
    if (
      typeof PiAiAdapter !== "function" ||
      typeof credentialStoreFrom !== "function" ||
      typeof authContextFrom !== "function" ||
      typeof resolveProfiles !== "function"
    ) {
      ctx.logger?.warn?.(
        "[dsh-opencode-patch] llm-pi-ai does not export what the Responses route needs; leaving it unregistered"
      );
      return undefined;
    }
    const models = responsesModelProfiles();
    if (models.length === 0) {
      return undefined;
    }
    const profiles = resolveProfiles({
      [RESPONSES_ROUTE]: responsesProviderProfile(models),
    }) as Map<string, unknown>;
    const Adapter = PiAiAdapter as new (options: unknown) => unknown;
    const adapter = new Adapter({
      auth: {
        credentials: credentialStoreFrom(ctx),
        authContext: authContextFrom(ctx),
      },
      profiles: () => profiles,
      // No override: the route's own `apiKeyEnv` names the credential, and
      // `llm-pi-ai`'s resolver reads it through the same services below.
      resolveApiKey: (): Promise<string | undefined> =>
        Promise.resolve(NO_KEY_OVERRIDE),
    });
    const registration = llm.registerAdapter([RESPONSES_ROUTE], adapter);
    ctx.logger?.info?.(
      "[dsh-opencode-patch] registered the Responses route with %d model(s)",
      models.length
    );
    return () => {
      registration?.dispose?.();
    };
  } catch (error) {
    ctx.logger?.warn?.(
      "[dsh-opencode-patch] could not register the Responses route (%s); a route declared in the profile still works",
      error instanceof Error ? error.message : String(error)
    );
    return undefined;
  }
};
