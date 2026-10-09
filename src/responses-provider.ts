/**
 * Serve the gateway's non-default APIs from the plugin, so a model the user
 * already picked simply works.
 *
 * The problem this solves: OpenCode Zen is one route whose models do not all
 * speak one wire format. models.dev names a per-model SDK for exactly those that
 * differ — 30 bundled Zen models name `@ai-sdk/openai` (Responses API) and 17
 * name `@ai-sdk/anthropic` (Messages API), against a route declared as
 * `openai-completions`. DSH cannot express "this model speaks a different
 * format": `llm-pi-ai` carries one `api` per ROUTE, and `llm.registerAdapter`
 * refuses a route that already has an adapter. So the format has to live on a
 * route, and the model has to be dispatched to the route whose `api` names it.
 *
 * ## Why this mounts the host's own plugin instead of building an adapter
 *
 * `llm-pi-ai` is a plugin, not a library. Its package root exports the plugin
 * contract (`apply`/`inject`/`name`) plus what a configuration surface needs;
 * the pieces that turn a raw profile into a serviceable route are internal, and
 * its published `exports` map advertises `"./src/*"` while `files` ships only
 * `lib/` — so that path is dead in every installed copy. `apply` is the
 * supported entry and resolves all of it itself, which is why nothing here
 * reimplements a protocol or copies the host's resolver.
 *
 * ## The four collisions a second instance causes, and how each is handled
 *
 * | collision | why | handled by |
 * | --- | --- | --- |
 * | `DUPLICATE_FLOW` | `apply` registers one authorization flow per installed catalog provider | `isolate('authorization')`, so the `inject` never fires |
 * | `DUPLICATE_DIRECTORY` | `apply` declares the WHOLE catalog, not just the routes being added | the facade answers `registerConfigurableProviders` locally |
 * | `DUPLICATE_DISCOVERY` | discovery is keyed by settings namespace, and a nested entry inherits its parent's id | the facade answers `registerModelDiscovery` locally |
 * | `providers.get expected object` | the registry keys its runtime by `apply` identity, so the FIRST instance's schema validates the second mount | the mount is handed RAW config, never a pre-validated `Config` |
 *
 * The facade is a local view for the mounted instance only. It forwards
 * `registerAdapter` to the real service — so the child fiber still owns and
 * releases the registration — and suppresses the two publishing calls.
 *
 * @module dsh-opencode-patch/responses-provider
 */

import type { CordisContext } from "./cordis-context.ts";
import { isFunctionLike, isRecord } from "./guards.ts";
import {
  type CatalogModelSpec,
  getLiveGoCatalog,
  getLiveZenCatalog,
} from "./models-catalog.ts";
import { PROTOCOL_FOR_SDK, ROUTE_FOR_PROTOCOL } from "./responses-routes.ts";

/** The host plugin whose `apply` this module mounts. */
const PI_AI_PACKAGE = "@deepseek-ai/dsh-llm-pi-ai";

/** The route whose profile the internal routes inherit their credential from. */
const SOURCE_ROUTE = "opencode";

/** Services hidden from the mounted instance; see the module header. */
const HIDDEN_SERVICES: readonly string[] = ["authorization", "settings"];

/** The credential the README tells a user to store. */
const DEFAULT_CREDENTIAL_REF = "OPENCODE_API_KEY";

/** The gateway's endpoint. */
const DEFAULT_BASE_URL = "https://opencode.ai/zen/v1";

/**
 * The sentinel that makes the stored credential resolvable at all: pi-ai's
 * `getClientApiKey` throws when a route names neither a key nor an
 * `authorization` header, before `fetch` — so the key the user already stored
 * never gets a chance to be resolved without it. The fetch patch swaps it for
 * the real one.
 */
const KEY_SENTINEL = "Bearer unused";

/** One model entry, in the shape `llm-pi-ai`'s config schema expects. */
interface ModelProfile {
  contextWindow: number;
  id: string;
  input: string[];
  maxTokens: number;
  name: string;
}

/**
 * Read a value that may be an array or any iterable as an array.
 *
 * The loader's `entries()` is a generator, so it is not an array; a mock or a
 * future version may hand over either.
 *
 * @param value - the candidate.
 * @returns the items, or `[]` when the value is not iterable.
 */
const toArray = (value: unknown): unknown[] => {
  if (Array.isArray(value)) {
    return value;
  }
  if (value === null || typeof value !== "object") {
    return [];
  }
  const iterator: unknown = Reflect.get(value, Symbol.iterator);
  if (typeof iterator !== "function") {
    return [];
  }
  const items: unknown[] = [];
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the Symbol.iterator check above is the runtime proof
  for (const item of value as Iterable<unknown>) {
    items.push(item);
  }
  return items;
};

/**
 * The loader service, off the context or through the service registry.
 *
 * `ctx.loader` is the accessor cordis installs for the service; `ctx.get` is the
 * untyped escape hatch, kept because a context that exposes only the latter is
 * still a context this plugin can work in.
 *
 * @param ctx - the host context.
 * @returns the loader, or `undefined` when the host serves none.
 */
const loaderOf = (ctx: unknown): Record<string, unknown> | undefined => {
  if (!isRecord(ctx)) {
    return undefined;
  }
  const direct: unknown = ctx.loader;
  if (isRecord(direct) && isFunctionLike(direct.entries)) {
    return direct;
  }
  if (!isFunctionLike(ctx.get)) {
    return undefined;
  }
  let viaGet: unknown;
  try {
    viaGet = Reflect.apply(ctx.get, ctx, ["loader"]);
  } catch {
    return undefined;
  }
  return isRecord(viaGet) && isFunctionLike(viaGet.entries)
    ? viaGet
    : undefined;
};

/** Every entry the host's loader holds, or `[]` when there is no loader. */
const loaderEntries = (ctx: unknown): unknown[] => {
  const loader = loaderOf(ctx);
  if (loader === undefined) {
    return [];
  }
  const { entries } = loader;
  if (typeof entries !== "function") {
    return [];
  }
  try {
    return toArray(Reflect.apply(entries, loader, []));
  } catch {
    return [];
  }
};

/**
 * The host's already-loaded `llm-pi-ai`, asked of the loader rather than guessed
 * from the filesystem.
 *
 * The loader imported the plugin in the first place, so its entry carries the
 * raw import result. That is the only way to reach the plugin which does not
 * encode a package-manager layout — this repository deliberately does not depend
 * on `llm-pi-ai`, because doing so drags in roughly a thousand lockfile lines
 * and makes pnpm refuse the install over ignored build scripts.
 *
 * `unwrapExports` is the loader's own normalization, so a default-export or
 * CJS-interop shape needs no second guess here.
 *
 * @param ctx - host context carrying the loader.
 * @returns the plugin, or `undefined` when no entry carries a usable one.
 */
export const loadPiAi = (ctx: unknown): Record<string, unknown> | undefined => {
  const loader = loaderOf(ctx);
  const entry = loaderEntries(ctx).find(
    (candidate) =>
      isRecord(candidate) &&
      isRecord(candidate.options) &&
      candidate.options.name === PI_AI_PACKAGE &&
      candidate.moduleNamespace !== undefined
  );
  if (!isRecord(entry) || entry.moduleNamespace === undefined) {
    return undefined;
  }
  const unwrapped =
    loader !== undefined && isFunctionLike(loader.unwrapExports)
      ? Reflect.apply(loader.unwrapExports, loader, [entry.moduleNamespace])
      : entry.moduleNamespace;
  return isRecord(unwrapped) && isFunctionLike(unwrapped.apply)
    ? unwrapped
    : undefined;
};

/**
 * The credential reference the composition already resolves for `opencode`.
 *
 * A deployment that named its own environment variable must not be asked to
 * state it again here: pi-ai resolves the reference through the credentials
 * service, so the same reference is the same stored record, and a different one
 * would be a route that authenticates as nobody.
 *
 * @param ctx - host context carrying the loader.
 * @returns the declared reference, or the documented default.
 */
export const inheritedCredentialRef = (ctx: unknown): string => {
  for (const entry of loaderEntries(ctx)) {
    if (!isRecord(entry) || !isRecord(entry.options)) {
      continue;
    }
    const { options } = entry;
    if (!isRecord(options)) {
      continue;
    }
    const { config } = options;
    if (!isRecord(config) || !isRecord(config.providers)) {
      continue;
    }
    const source = config.providers[SOURCE_ROUTE];
    if (!isRecord(source)) {
      continue;
    }
    const ref = source.apiKeyEnv;
    if (typeof ref === "string" && ref.length > 0) {
      return ref;
    }
  }
  return DEFAULT_CREDENTIAL_REF;
};

/**
 * Every model the gateway serves on the API one SDK names.
 *
 * The default catalog unions BOTH planes, which is the right answer to "what
 * does this gateway serve". It is the wrong answer for the routes this module
 * mounts: they carry Zen's `baseURL`, and the Go plane names models the Zen
 * endpoint does not serve, so offering one resolves to "model not found" against
 * the route's own endpoint. The mount therefore passes {@link getLiveZenCatalog}
 * explicitly.
 *
 * @param sdk - the models.dev `provider.npm` value the route serves.
 * @param catalog - the catalog to read; both planes by default.
 * @returns one profile per model, deduplicated.
 */
export const modelsForSdk = (
  sdk: string,
  catalog: readonly CatalogModelSpec[] = [
    ...getLiveZenCatalog(),
    ...getLiveGoCatalog(),
  ]
): ModelProfile[] => {
  const seen = new Set<string>();
  const profiles: ModelProfile[] = [];
  for (const spec of catalog) {
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
 * The provider profile for one route, in the shape the config schema takes.
 *
 * The mounted plugin resolves it — defaults, serviceable models and all —
 * exactly as it would a profile the user wrote.
 *
 * @param protocol - the pi-ai protocol the route's `api` names.
 * @param models - the models to serve.
 * @param apiKeyEnv - the credential reference the composition already uses.
 * @returns the profile, keyed by nothing yet (the caller keys it).
 */
const providerProfile = (
  protocol: string,
  models: readonly ModelProfile[],
  apiKeyEnv: string,
  baseURL: string
) => ({
  api: protocol,
  apiKeyEnv,
  baseURL,
  headers: { authorization: KEY_SENTINEL },
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

/** Withdraw one registration, whichever handle shape the registry returned. */
const releaseRegistration = (handle: unknown): void => {
  try {
    if (typeof handle === "function") {
      Reflect.apply(handle, undefined, []);
      return;
    }
    if (isRecord(handle) && typeof handle.dispose === "function") {
      Reflect.apply(handle.dispose, handle, []);
    }
  } catch {
    // A registration that cannot be withdrawn must not stop the unwind.
  }
};

/**
 * A view of the real `llm` service for the mounted instance.
 *
 * `registerAdapter` is forwarded — bound to the real service, so the child fiber
 * owns what it registers — and every handle it returns is captured, which is
 * what lets {@link registerResponsesProvider}'s disposer withdraw the routes
 * deterministically rather than relying on the fiber's own unwind.
 *
 * The two publishing calls are answered locally, which is what keeps a second
 * instance from colliding with the host's own directory and discovery
 * registrations. Every other member passes through with the correct receiver.
 *
 * @param real - the real `llm` service.
 * @param captured - collects the handles `registerAdapter` returns.
 * @returns the facade, or `real` when it is not an object.
 */
const llmFacade = (real: unknown, captured: unknown[]): unknown => {
  if (typeof real !== "object" || real === null) {
    return real;
  }
  return new Proxy(real, {
    get: (source, prop) => {
      if (prop === "registerAdapter") {
        const register: unknown = Reflect.get(source, prop, source);
        if (typeof register !== "function") {
          return register;
        }
        return (routes: readonly string[], adapter: unknown) => {
          const handle: unknown = Reflect.apply(register, source, [
            routes,
            adapter,
          ]);
          captured.push(handle);
          return handle;
        };
      }
      if (prop === "registerConfigurableProviders") {
        return () => ({
          dispose: () => {
            // Nothing was published, so there is nothing to withdraw.
          },
          replace: () => {
            // Nothing was published, so there is nothing to replace.
          },
        });
      }
      if (prop === "registerModelDiscovery") {
        return () => {
          // Nothing was published, so there is nothing to withdraw.
        };
      }
      const value: unknown = Reflect.get(source, prop, source);
      if (typeof value !== "function") {
        return value;
      }
      const bound = (...args: unknown[]): unknown =>
        Reflect.apply(value, source, args);
      return bound;
    },
  });
};

/**
 * The real `llm` service, read through the holder's own `get`.
 *
 * Read off `this` rather than captured, because the shadow is installed on a
 * parent scope and every context below it resolves the service through its own
 * isolation chain — a captured reference would pin the mount to whichever scope
 * happened to build the facade.
 *
 * @param holder - the context the getter was reached through.
 * @returns the service, or `undefined` when the holder cannot resolve it.
 */
const readLlmService = (holder: unknown): unknown => {
  if (!isRecord(holder)) {
    return undefined;
  }
  const { get } = holder;
  if (typeof get !== "function") {
    return undefined;
  }
  try {
    return Reflect.apply(get, holder, ["llm"]);
  } catch {
    return undefined;
  }
};

/**
 * The scope the host plugin is mounted in, or `undefined` when unsupported.
 *
 * Both isolated services are load-bearing. `authorization` is what keeps the
 * flows from colliding; `settings` is what keeps the mounted instance from
 * writing a settings section nobody asked for, which is the seam a check of
 * `authorization` alone would miss.
 *
 * @param ctx - the host context.
 * @param captured - collects the handles `registerAdapter` returns.
 * @returns the scope to mount into.
 */
const mountScope = (
  ctx: CordisContext,
  captured: unknown[]
): CordisContext | undefined => {
  let scope: CordisContext | undefined = ctx;
  for (const service of HIDDEN_SERVICES) {
    if (scope === undefined || typeof scope.isolate !== "function") {
      return undefined;
    }
    scope = scope.isolate(service);
  }
  if (scope === undefined || typeof scope.extend !== "function") {
    return undefined;
  }
  const shadow = {
    get llm(): unknown {
      return llmFacade(readLlmService(this), captured);
    },
  };
  return scope.extend(shadow);
};

/**
 * Mount the host's `llm-pi-ai` once, for every internal route this plugin owns.
 *
 * One mount, not one per route: `apply` declares the whole catalog on every
 * call, so a per-route mount is a collision no matter how few routes it carries.
 *
 * Never throws. A deployment where the host plugin is not loaded, or that
 * already declares these routes, keeps its previous behaviour — reported at
 * `info`, because both are expected states rather than faults.
 *
 * @param ctx - host context carrying the loader, the LLM registry and the
 *   services the mounted plugin needs.
 * @returns the disposer withdrawing the mount, or `undefined` when nothing was
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
  const host = loadPiAi(ctx);
  if (host === undefined) {
    ctx.logger?.info?.(
      "[dsh-opencode-patch] no loaded llm-pi-ai in this composition; internal routes stay unregistered"
    );
    return undefined;
  }
  const apiKeyEnv = inheritedCredentialRef(ctx);
  const zen = getLiveZenCatalog();
  const providers: Record<string, unknown> = {};
  const mounted: string[] = [];
  for (const [protocol, route] of wanted) {
    const sdk = sdkForRoute(route);
    const models = sdk === undefined ? [] : modelsForSdk(sdk, zen);
    if (models.length === 0) {
      continue;
    }
    providers[route] = providerProfile(
      protocol,
      models,
      apiKeyEnv,
      DEFAULT_BASE_URL
    );
    mounted.push(`${route} (${protocol}) with ${models.length} model(s)`);
  }
  if (mounted.length === 0) {
    ctx.logger?.info?.(
      "[dsh-opencode-patch] no model needs an internal route; nothing to mount"
    );
    return undefined;
  }
  const captured: unknown[] = [];
  const scope = mountScope(ctx, captured);
  if (scope === undefined || typeof scope.plugin !== "function") {
    ctx.logger?.info?.(
      "[dsh-opencode-patch] this host exposes no isolate/plugin scope; internal routes stay unregistered"
    );
    return undefined;
  }
  try {
    const fiber = scope.plugin(host, { providers });
    // Cordis's `Fiber` is not thenable; `await()` is what waits for the
    // lifecycle work and rethrows a startup error. A stand-in may hand over a
    // promise instead, so both shapes are settled here.
    const settle = fiber?.await;
    await Promise.resolve(
      typeof settle === "function" ? fiber?.await?.() : fiber
    );
    if (captured.length === 0) {
      ctx.logger?.info?.(
        "[dsh-opencode-patch] the mount registered no route; internal routes stay unregistered"
      );
      return undefined;
    }
    ctx.logger?.info?.("[dsh-opencode-patch] mounted %s", mounted.join("; "));
    return () => {
      for (const handle of captured) {
        releaseRegistration(handle);
      }
      captured.length = 0;
      void (async () => {
        try {
          await fiber?.dispose?.();
        } catch {
          // A disposal failure must not mask the plugin's own teardown.
        }
      })();
    };
  } catch (error) {
    ctx.logger?.info?.(
      "[dsh-opencode-patch] internal routes stay unregistered (%s); routes declared in the profile are unaffected",
      error instanceof Error ? error.message : String(error)
    );
    return undefined;
  }
};
