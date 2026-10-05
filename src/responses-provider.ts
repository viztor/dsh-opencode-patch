/**
 * Register the gateway's non-default planes from the plugin, reusing DSH's own
 * pi-ai adapter.
 *
 * The requirement this exists for: **the user changes nothing.** They keep the
 * `opencode` provider and the key they already have, and any model the gateway
 * serves on a different API simply works — the picker selection is matched to
 * the right route by the SDK the vendor's catalog names for that model.
 *
 * That rules out the two shapes tried before it:
 *
 * - Routes declared in the profile mean user configuration, which is what we are
 *   removing.
 * - A second `llm-pi-ai` row cannot mount: `registerPiAiFlows` registers an
 *   authorization flow per installed catalog provider id and
 *   `authorization.registerFlow` throws `DUPLICATE_FLOW` on the second instance.
 *
 * So the plugin registers the routes itself. **Nothing is reimplemented**:
 * `llm-pi-ai` exports `PiAiAdapter` (its pi-ai-event-to-`StreamChunk`
 * translation), `resolveProfiles` (the resolver that materialises defaults and
 * models), and `credentialStoreFrom` / `authContextFrom`. The package's exports
 * map carries `"./src/*"`, so the two that are not re-exported from the root are
 * reachable by deep path. This module is glue, not a protocol client.
 *
 * Each route's models are read from the catalog rather than listed: every model
 * whose `provider.npm` names that route's SDK is served there, so a route covers
 * all of them instead of the one a hand-written list would name.
 *
 * @module dsh-opencode-patch/responses-provider
 */

import type { CordisContext } from "./cordis-context.ts";
import { isRecord } from "./guards.ts";
import { getLiveGoCatalog, getLiveZenCatalog } from "./models-catalog.ts";
import { PROTOCOL_FOR_SDK, ROUTE_FOR_PROTOCOL } from "./responses-routes.ts";

/** The harness package whose adapter and resolvers this module reuses. */
const PI_AI_PACKAGE = "@deepseek-ai/dsh-llm-pi-ai";

/** The gateway's endpoint, shared by every plane. */
const ZEN_BASE_URL = "https://opencode.ai/zen/v1";

/**
 * The credential the user already configured for `opencode`. Read, never
 * re-asked: every route this module registers authenticates with the same key.
 */
const USER_CREDENTIAL_REF = "OPENCODE_API_KEY";

/**
 * What `resolveApiKey` returns: nothing. Each route's own `apiKeyEnv` is the
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
 * Every catalog model the gateway serves on the API one protocol names.
 *
 * Read from the catalog's `provider.npm`, the vendor's own statement of the
 * split, so this list never has to be maintained.
 *
 * @param sdk - the models.dev `provider.npm` value the route serves.
 * @returns one profile per model, deduplicated across both planes.
 */
export const modelsForSdk = (sdk: string): ModelProfile[] => {
  const seen = new Set<string>();
  const profiles: ModelProfile[] = [];
  for (const spec of [...getLiveZenCatalog(), ...getLiveGoCatalog()]) {
    if (spec.provider_npm !== sdk || seen.has(spec.id)) {
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
 * The provider profile for one route, in the shape the config schema takes — so
 * `resolveProfiles` can materialise it exactly as it would a configured one.
 *
 * @param protocol - the pi-ai protocol the route's `api` names.
 * @param models - the models to serve.
 * @returns the profile, keyed by nothing yet (the caller keys it).
 */
const providerProfile = (
  protocol: string,
  models: readonly ModelProfile[]
) => ({
  // The sentinel: pi-ai's `getClientApiKey` THROWS when a route names neither a
  // key nor an `authorization` header, before `fetch` — so the credential the
  // user already stored never gets a chance to be resolved without it.
  headers: { authorization: "Bearer unused" },
  api: protocol,
  apiKeyEnv: USER_CREDENTIAL_REF,
  baseURL: ZEN_BASE_URL,
  models: [...models],
});

/** The SDK a route serves, given its route id. */
const sdkForRoute = (route: string): string | undefined =>
  Object.keys(PROTOCOL_FOR_SDK).find((sdk) => {
    const protocol = PROTOCOL_FOR_SDK[sdk];
    return protocol !== undefined && ROUTE_FOR_PROTOCOL[protocol] === route;
  });

/**
 * Register every non-default route with the host's LLM registry.
 *
 * Never throws: a deployment without `llm-pi-ai` installed, or one that already
 * declares a route, leaves the caller with the previous behaviour rather than a
 * failed boot. Every failure is reported so it is not silent.
 *
 * @param ctx - host context carrying the LLM registry and the services the
 *   adapters need.
 * @returns the disposer withdrawing every registration, or `undefined` when
 *   nothing was registered.
 */
export const registerResponsesProvider = async (
  ctx: CordisContext
): Promise<(() => void) | undefined> => {
  const { llm } = ctx;
  if (llm === undefined || typeof llm.registerAdapter !== "function") {
    return undefined;
  }
  const existing = llm.listProviders?.();
  const declared = new Set(
    Array.isArray(existing)
      ? existing
          .filter((route) => isRecord(route))
          .map((route) => (isRecord(route) ? route.id : undefined))
      : []
  );
  const wanted = Object.entries(ROUTE_FOR_PROTOCOL).filter(
    ([, route]) => !declared.has(route)
  );
  // A deployment that already declares a route in its profile keeps it: the user
  // hand-picks the models it serves, and registering over that would both throw
  // `DUPLICATE_ADAPTER` and take that choice away. Deferring is the point — this
  // module exists so a deployment that declares NOTHING still works, not to
  // override one that does.
  if (wanted.length === 0) {
    ctx.logger?.info?.(
      "[dsh-opencode-patch] every internal route is already declared; leaving them alone"
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
        "[dsh-opencode-patch] llm-pi-ai does not export what the internal routes need; leaving them unregistered"
      );
      return undefined;
    }
    const auth = {
      credentials: credentialStoreFrom(ctx),
      authContext: authContextFrom(ctx),
    };
    const Adapter = PiAiAdapter as new (options: unknown) => unknown;
    const stop: (() => void)[] = [];
    for (const [protocol, route] of wanted) {
      const sdk = sdkForRoute(route);
      const models = sdk === undefined ? [] : modelsForSdk(sdk);
      if (models.length === 0) {
        continue;
      }
      const profiles = resolveProfiles({
        [route]: providerProfile(protocol, models),
      }) as Map<string, unknown>;
      const registration = llm.registerAdapter(
        [route],
        new Adapter({
          auth,
          profiles: () => profiles,
          resolveApiKey: (): Promise<string | undefined> =>
            Promise.resolve(NO_KEY_OVERRIDE),
        })
      );
      ctx.logger?.info?.(
        "[dsh-opencode-patch] registered %s (%s) with %d model(s)",
        route,
        protocol,
        models.length
      );
      stop.push(() => {
        registration?.dispose?.();
      });
    }
    if (stop.length === 0) {
      return undefined;
    }
    return () => {
      for (const dispose of stop) {
        dispose();
      }
    };
  } catch (error) {
    // `info`, not `warn`: this is the expected state today, not a fault. The
    // usual cause is that `llm-pi-ai` ships only `lib/` and exports no profile
    // resolver, so the module that would build the adapter is unreachable from
    // here. Reporting it at warning level on every boot would read as a bug in
    // a deployment where nothing is wrong and every route still works.
    ctx.logger?.info?.(
      "[dsh-opencode-patch] internal routes stay unregistered (%s); routes declared in the profile are unaffected",
      error instanceof Error ? error.message : String(error)
    );
    return undefined;
  }
};
