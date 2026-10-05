/**
 * Register the gateway's non-default planes from the plugin, reusing DSH's own
 * pi-ai plugin.
 *
 * The requirement this exists for: **the user changes nothing.** They keep the
 * `opencode` provider and the key they already have, and any model the gateway
 * serves on a different API simply works — the picker selection is matched to
 * the right route by the SDK the vendor's catalog names for that model.
 *
 * ## Why this mounts the official plugin instead of building an adapter
 *
 * `llm-pi-ai` is written as a **plugin**, not a library: its package root exports
 * the plugin contract (`apply`, `inject`, `name`) plus what a configuration
 * surface needs (`Config`, `PiAiAdapter`, the profile types). The pieces that
 * turn a raw profile into a serviceable route — `resolveProfiles`,
 * `credentialStoreFrom`, `authContextFrom` — are imported for its own use and
 * **not exported**, and its published `exports` map advertises `"./src/*"` while
 * `files` ships only `lib/`, so that path is dead in every installed copy.
 *
 * `apply(ctx, config)` is the supported entry point, and it resolves all of that
 * internally. It cannot be mounted twice in this composition for one reason:
 * `registerPiAiFlows` registers an authorization flow per installed catalog
 * provider, and `authorization.registerFlow` throws `DUPLICATE_FLOW` on the
 * second instance.
 *
 * The plugin's own comment names the escape — the flows are
 *
 * > Scoped to the authorization seam rather than injected outright, because a
 * > composition without it (headless, ACP) simply has no surface to sign in
 * > from, **while everything else this plugin does still works**.
 *
 * and cordis provides exactly that scope: `isolate(name)` creates a child
 * context whose reads and writes of `name` resolve in a new scope. Mounting
 * below `isolate('authorization')` means `apply`'s
 * `ctx.inject(['authorization'], …)` never resolves, so no flows are registered
 * — and every other thing it does, including the adapter registration this
 * module wants, proceeds.
 *
 * @module dsh-opencode-patch/responses-provider
 */

import { createRequire } from "node:module";
import { homedir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import type { CordisContext } from "./cordis-context.ts";
import { isRecord } from "./guards.ts";
import { getLiveGoCatalog, getLiveZenCatalog } from "./models-catalog.ts";
import { PROTOCOL_FOR_SDK, ROUTE_FOR_PROTOCOL } from "./responses-routes.ts";

/** The harness plugin this module mounts, and the scope it is mounted in. */
const PI_AI_PACKAGE = "@deepseek-ai/dsh-llm-pi-ai";

/**
 * Load the host's `llm-pi-ai`.
 *
 * It is a **profile bundle**, not a dependency of the `dsh` package, so it is
 * not reachable from the running CLI's entry point — and declaring it here is
 * not an option either: it drags in roughly a thousand lockfile lines (through
 * `@google/genai`, `protobufjs` and friends) and pnpm then refuses the install
 * over their build scripts, which would break every consumer's `pnpm install`.
 *
 * So it is looked for where a host actually keeps it, in order, and a miss is
 * reported rather than thrown. An `import()` of the bare specifier is tried
 * first because a hoisted or flat install answers it directly.
 *
 * @returns the module namespace, or `undefined` when no candidate resolved.
 */
const loadPiAi = async (): Promise<Record<string, unknown> | undefined> => {
  const candidates: (() => Promise<unknown>)[] = [
    () => import(PI_AI_PACKAGE),
    () => {
      // Resolve from the profile that mounted this plugin, which is where a
      // bundle's own dependencies are installed.
      const require = createRequire(
        `${process.env.DSH_PROFILE_DIR ?? path.join(homedir(), ".dsh", "profiles", "web")}/package.json`
      );
      return import(pathToFileURL(require.resolve(PI_AI_PACKAGE)).href);
    },
  ];
  for (const attempt of candidates) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- the order is the contract
      const loaded: unknown = await attempt();
      if (isRecord(loaded) && typeof loaded.apply === "function") {
        return loaded;
      }
    } catch {
      // Try the next location; the caller reports the aggregate miss.
    }
  }
  return undefined;
};

/**
 * The service hidden from the mounted instance.
 *
 * Not a workaround for a bug: `llm-pi-ai` documents that a composition without
 * this seam works in full apart from sign-in, and hiding it is how a second
 * instance coexists with the host's own.
 */
const HIDDEN_SERVICE = "authorization";

/** The gateway's endpoint, shared by every plane. */
const ZEN_BASE_URL = "https://opencode.ai/zen/v1";

/**
 * The credential the user already configured for `opencode`. Read, never
 * re-asked: every route this module registers authenticates with the same key.
 */
const USER_CREDENTIAL_REF = "OPENCODE_API_KEY";

/** One model entry, in the shape `llm-pi-ai`'s config schema expects. */
interface ModelProfile {
  contextWindow: number;
  id: string;
  input: string[];
  maxTokens: number;
  name: string;
}

/**
 * Every catalog model the gateway serves on the API one SDK names.
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
 * The provider profile for one route, in the shape the config schema takes. The
 * mounted plugin resolves it — defaults, serviceable models and all — exactly as
 * it would a profile the user wrote.
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

/** The routes the host already serves, so a declared one is never overridden. */
const declaredRoutes = (llm: CordisContext["llm"]): Set<unknown> => {
  const listed = llm?.listProviders?.();
  return new Set(
    Array.isArray(listed)
      ? listed
          .filter((route) => isRecord(route))
          .map((route) => (isRecord(route) ? route.id : undefined))
      : []
  );
};

/**
 * Mount `llm-pi-ai` once per route this plugin owns.
 *
 * Never throws: a deployment without the package installed, or one that already
 * declares a route, leaves the caller with the previous behaviour rather than a
 * failed boot. Reported at `info`, because both are expected states rather than
 * faults.
 *
 * @param ctx - host context carrying the LLM registry and the services the
 *   mounted plugin needs.
 * @returns the disposer withdrawing every mount, or `undefined` when nothing was
 *   mounted.
 */
export const registerResponsesProvider = async (
  ctx: CordisContext
): Promise<(() => void) | undefined> => {
  const { llm } = ctx;
  if (llm === undefined || typeof llm.registerAdapter !== "function") {
    return undefined;
  }
  const declared = declaredRoutes(llm);
  // A deployment that already declares a route in its profile keeps it: the user
  // hand-picks the models it serves, and mounting over that would take the choice
  // away. Deferring is the point — this module exists so a deployment that
  // declares NOTHING still works, not to override one that does.
  const wanted = Object.entries(ROUTE_FOR_PROTOCOL).filter(
    ([, route]) => !declared.has(route)
  );
  if (wanted.length === 0) {
    ctx.logger?.info?.(
      "[dsh-opencode-patch] every internal route is already declared; leaving them alone"
    );
    return undefined;
  }
  const scope = ctx.isolate?.(HIDDEN_SERVICE);
  if (scope === undefined || typeof scope.plugin !== "function") {
    ctx.logger?.info?.(
      "[dsh-opencode-patch] this host exposes no isolate/plugin scope; internal routes stay unregistered"
    );
    return undefined;
  }
  try {
    // Dynamic, so a profile without `llm-pi-ai` degrades instead of failing to
    // resolve the import at load time. Resolved at runtime, so its exports
    // cannot be typed here — the guards below are the runtime check these casts
    // stand in for.
    // oxlint-disable typescript/no-unsafe-assignment, typescript/no-unsafe-type-assertion, typescript/no-unsafe-call, typescript/no-unsafe-member-access -- see above.
    const piAi = await loadPiAi();
    if (piAi === undefined) {
      ctx.logger?.info?.(
        "[dsh-opencode-patch] no reachable llm-pi-ai; internal routes stay unregistered"
      );
      return undefined;
    }
    const { apply, inject, name: pluginName, Config } = piAi;
    if (
      typeof apply !== "function" ||
      typeof Config !== "function" ||
      pluginName === undefined
    ) {
      ctx.logger?.info?.(
        "[dsh-opencode-patch] llm-pi-ai does not export the plugin contract; internal routes stay unregistered"
      );
      return undefined;
    }
    const stop: (() => void)[] = [];
    for (const [protocol, route] of wanted) {
      const sdk = sdkForRoute(route);
      const models = sdk === undefined ? [] : modelsForSdk(sdk);
      if (models.length === 0) {
        continue;
      }
      const config = Config({
        providers: { [route]: providerProfile(protocol, models) },
      });
      const fiber = scope.plugin({ apply, inject, name: pluginName }, config);
      ctx.logger?.info?.(
        "[dsh-opencode-patch] mounted %s (%s) with %d model(s)",
        route,
        protocol,
        models.length
      );
      stop.push(() => {
        fiber?.dispose?.();
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
    // `info`, not `warn`: the usual cause is that the host ships no reachable
    // copy of `llm-pi-ai`, which is an expected state and not a fault — every
    // route declared in the profile still works. A warning on every boot would
    // read as a bug in a deployment where nothing is wrong.
    ctx.logger?.info?.(
      "[dsh-opencode-patch] internal routes stay unregistered (%s); routes declared in the profile are unaffected",
      error instanceof Error ? error.message : String(error)
    );
    return undefined;
  }
};
