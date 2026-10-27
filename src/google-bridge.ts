/**
 * The bridge: a route this plugin registers through its own adapter, for a
 * protocol the wrapper's hand-declared table refuses to name.
 *
 * Why this module exists is a chain of closed doors, each one measured:
 *
 * - A hand-declared route may only name a protocol in the wrapper's table, and
 *   that table does not carry `google-generative-ai`. Its own comment calls the
 *   omission "for want of a consumer rather than a blocker" — one line, once a
 *   deployment needs it — but this plugin cannot add that line: the table is a
 *   module-private constant, unreachable from outside.
 * - A catalog route reaches every protocol, but only under the catalog
 *   provider's own name, and `opencode` is taken by whatever the deployment
 *   declared. Reusing pi's `google` catalog provider would work — measured,
 *   end to end — but registering the name `google` would take it away from a
 *   deployment that wants the real Google AI Studio under it. That trade is
 *   not ours to make, which is why this route is `opencode-google` and stays
 *   internal: the picker lists its models under the plane route, and the
 *   stream hook dispatches the call here.
 * - Handing the route back (`handle.replace`) needs the registration handle of
 *   whoever owns `opencode`, and a plugin that loads after the wrapper never
 *   sees that handle.
 *
 * So the route is served by an adapter this plugin builds and registers on the
 * real `llm` service — but the adapter is the wrapper's own class
 * (`PiAiAdapter`, reached through the loader), and the wire protocol is pi's
 * own implementation, so nothing about the request shape is reinvented here.
 *
 * The one runtime pi import in this entire plugin is resolved HERE, at runtime,
 * and deliberately not declared as a dependency.
 *
 * **Why not a dependency.** The harness wrapper (`dsh-llm-pi-ai`) already
 * depends on `@earendil-works/pi-ai` with a RANGE (`^1.1.0`). The harness's
 * own lockfile pins that to 1.1.0 plus its patch; a registry install of the
 * published host resolves the range to the newest 1.x; this repo's dev install
 * pins 1.1.0 (`test/support/host-versions.ts`). Declaring the
 * same package as an exact dependency here puts a SECOND pi in the tree and
 * turns every harness bump into a version-skew bug: the worst measured shape is
 * a degraded Google route whose error names the model rather than the version.
 *
 * So the rule is the user's own: *use whatever the harness provides*. The
 * lookup below asks the harness which pi that is, from the wrapper's own
 * location (its `package.json` declares the range; node's lookup from there
 * finds the installed copy), so the bridge always wires the same implementation
 * the wrapper mounts — one instance, one version, no pin to chase.
 *
 * The plugin's own copy stays in `devDependencies`, for the unit tests and for
 * this repo's own development, and is never what a deployment loads.
 *
 * pi's `exports` map declares `types` and `import` only — no `require` — so this
 * resolves by walking node's own pnpm/node_modules layout rather than with
 * `createRequire`, which would only ever see the `require` condition and miss.
 *
 * The same construction would serve `@ai-sdk/mistral`: pi implements
 * `mistral-conversations`, and a bridge on this pattern is one lazy import
 * away. It is not built, because that dialect at the gateway is unmeasured and
 * no entitled key exists to measure it — the decision lives in
 * `UNSERVED_SDKS`, with this module as the record of how it would be served.
 *
 * @module dsh-opencode-patch/google-bridge
 */

import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { attachmentResolvers } from "./attachment-services.ts";
import type { CatalogModelSpec } from "./catalog-data.ts";
import type { EndpointFamily } from "./config-values.ts";
import { readCredentialsResolver } from "./cordis-context.ts";
import { resolveOpencodeStoreKey } from "./go-discovery.ts";
import { type Plane, piModelFor } from "./pi-provider.ts";
import {
  GO_GOOGLE_INTERNAL_ROUTE,
  GOOGLE_INTERNAL_ROUTE,
} from "./responses-routes.ts";
import { isFunctionLike, isRecord } from "./utils/guards.ts";

/**
 * pi's installed catalog entry for one model on one plane, or undefined when
 * pi does not know it.
 *
 * The bridge builds its models by hand rather than reusing a catalog route, so
 * this is where the entry the installed provider already carries comes back:
 * the compatibility switches, the `reasoning` flag, the thinking-level map and
 * the input limits are all things pi knows and this module does not, and a model
 * built without them would serve requests with those behaviours silently off.
 * Spreading that entry is what the wrapper's own materialization does.
 *
 * @param plane - the gateway plane, which is also pi's provider id.
 * @param id - the model id.
 * @returns the installed entry, or undefined when the catalog lacks it.
 */
/**
 * The slice of pi's Google provider the bridge calls: two stream entry points.
 *
 * Typed here rather than imported from pi's own declarations, because the
 * package this repo compiles against is a devDependency at one version while
 * the runtime copy is whatever the harness installed — the bridge only needs
 * these two methods, and stating them locally is what keeps a harness bump a
 * runtime decision instead of a type error.
 */
export interface PiGoogleApi {
  stream: (model: never, context: never, options?: never) => unknown;
  streamSimple: (model: never, context: never, options?: never) => unknown;
}

/** The wrapper whose own dependency tree names the pi the host installed. */
const WRAPPER_PACKAGE = "@deepseek-ai/dsh-llm-pi-ai";

/** The pi surface the bridge needs, read off whichever copy the host installed. */
export interface PiRuntime {
  /** pi's Google wire implementation, as `googleProviderFor` consumes it. */
  googleGenerativeAIApi: () => PiGoogleApi;
  /** pi's own installed catalog, per provider id. */
  getBuiltinModels: (plane: string) => readonly { id: string }[];
  /** The version string of the copy that was loaded, for diagnostics. */
  version: string;
}

/** The two module paths the bridge needs, relative to a pi package root. */
const PI_GOOGLE_API = "dist/api/google-generative-ai.lazy.js";
const PI_PROVIDERS_ALL = "dist/providers/all.js";

/**
 * Where the installed pi lives, found by walking node's lookup from the
 * WRAPPER's own directory.
 *
 * The wrapper declares pi as a dependency, so the copy node would hand IT is
 * the copy every other consumer in that tree gets — which is the whole point.
 * The walk is explicit because pnpm's layout is not a plain `node_modules`
 * beside the package: the wrapper's dependencies live in the `.pnpm` hosting
 * directory above it (or in a hoisted store beside it), and under a `link:` or
 * `file:` install they live somewhere else again. Walking the parent chain and
 * testing for the package is the one rule that covers all of them without
 * encoding a package-manager layout.
 *
 * @returns the pi package ROOT, or `undefined` when the wrapper cannot be
 *   located or carries no pi.
 */
const installedPiRoot = (): string | undefined => {
  // `import.meta.resolve` honours the wrapper's `import`/`default` conditions,
  // which is what an ESM-only package declares. It is resolved from THIS
  // module's own location, so the answer is the wrapper this plugin's tree
  // installed — the one the host loader mounts.
  let wrapperEntry: string | undefined;
  try {
    wrapperEntry = import.meta.resolve(WRAPPER_PACKAGE);
  } catch {
    wrapperEntry = undefined;
  }
  if (wrapperEntry === undefined) {
    return undefined;
  }
  let dir = path.dirname(realpathSync(fileURLToPath(wrapperEntry)));
  // The entry is `<wrapper>/lib/index.js`; its `node_modules` walk starts at the
  // package root, which the hosting directory above it also covers, so walking
  // up from the entry's own directory reaches the same install either way.
  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = path.join(
      dir,
      "node_modules",
      "@earendil-works",
      "pi-ai"
    );
    if (existsSync(path.join(candidate, "package.json"))) {
      return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  return undefined;
};

/**
 * The pi the HOST installed, loaded once.
 *
 * Everything the bridge needs from pi comes through this record, so a harness
 * that bumps pi changes the wire implementation the route speaks and nothing
 * else about the bridge: the adapter, the profile and the models are this
 * plugin's own objects, and pi reads fields off them rather than checking
 * identity.
 *
 * @returns the runtime, or `undefined` when the host's pi is not reachable —
 *   in which case the bridge simply does not mount, and says so on the console.
 */
export const loadHostPi = async (): Promise<PiRuntime | undefined> => {
  const root = installedPiRoot();
  if (root === undefined) {
    return undefined;
  }
  try {
    const manifest = readFileSync(path.join(root, "package.json"), "utf-8");
    const [googleApi, providersAll] = await Promise.all([
      import(pathToFileURL(path.join(root, PI_GOOGLE_API)).href),
      import(pathToFileURL(path.join(root, PI_PROVIDERS_ALL)).href),
    ]);
    // Read the two exports off the dynamically imported modules, and narrow
    // before using either: a pi that has moved an export answers `undefined`
    // here rather than throwing somewhere inside a request.
    const googleApiModule: unknown = googleApi;
    const providersModule: unknown = providersAll;
    if (!isRecord(googleApiModule) || !isRecord(providersModule)) {
      return undefined;
    }
    const { googleGenerativeAIApi } = googleApiModule;
    const { getBuiltinModels } = providersModule;
    if (
      typeof googleGenerativeAIApi !== "function" ||
      typeof getBuiltinModels !== "function"
    ) {
      return undefined;
    }
    const manifestData: unknown = JSON.parse(manifest);
    const version =
      isRecord(manifestData) && typeof manifestData.version === "string"
        ? manifestData.version
        : "";
    return {
      // pi's own signatures, as this module consumes them. Narrowed at the
      // boundary rather than asserted from `any`: the export check above is the
      // runtime guard these casts stand in for.
      getBuiltinModels: getBuiltinModels as PiRuntime["getBuiltinModels"],
      googleGenerativeAIApi: () =>
        (googleGenerativeAIApi as () => unknown)() as PiGoogleApi,
      version,
    };
  } catch {
    return undefined;
  }
};

/** Go's Google protocol has no endpoint on the legacy Zen API. */
export const GO_GOOGLE_BASE_URL =
  "https://opencode.ai/inference/go/google/v1beta";

const googleRouteFor = (plane: Plane): string =>
  plane === "opencode-go" ? GO_GOOGLE_INTERNAL_ROUTE : GOOGLE_INTERNAL_ROUTE;

/** The host adapter's default: five minutes without a chunk. */
const STREAM_IDLE_TIMEOUT_MS = 300_000;

/**
 * The request-level image budget a route defaults to, read from the wrapper's
 * own constants: twenty MiB of base64 payload, 2048 by 2048 pixels, and one
 * MiB as the per-image byte target after the quality ladder.
 */
const MAX_REQUEST_IMAGE_BYTES = 20 * 1024 * 1024;
const REQUEST_IMAGE_PIXEL_BUDGET = 2048 * 2048;
const REQUEST_IMAGE_MAX_BYTES = 1024 * 1024;

/**
 * The retry policy a route carries when its deployment configured none, read
 * from the harness's own defaults: five retries over `EMPTY_RESPONSE`,
 * `RATE_LIMIT`, `SERVER`, `TIMEOUT` and `TRANSPORT`, backing off from half a
 * second to ten with a tenth of jitter.
 */
const gatewayRetryPolicy = (): unknown =>
  Object.freeze({
    mode: "normal",
    maxRetries: 5,
    retryableCodes: [
      "EMPTY_RESPONSE",
      "RATE_LIMIT",
      "SERVER",
      "TIMEOUT",
      "TRANSPORT",
    ],
    initialDelayMs: 500,
    maxDelayMs: 10_000,
    jitterRatio: 0.1,
  });

/**
 * A credential store with nothing in it. This route's key always arrives per
 * request through `resolveApiKey`, so the store pi would consult for
 * login-written credentials is never read for a stream call; an empty
 * implementation is the honest shape for that, not a stub hiding a miss.
 */
/** The credential-store surface pi's collection calls. */
export interface BridgeCredentialStore {
  delete: (providerId: string, options?: unknown) => Promise<void>;
  list: (options?: unknown) => Promise<readonly unknown[]>;
  modify: (
    providerId: string,
    fn: (current?: unknown) => Promise<unknown>,
    options?: unknown
  ) => Promise<unknown>;
  read: (providerId: string, options?: unknown) => Promise<unknown>;
}

export const emptyCredentialStore = (): BridgeCredentialStore => ({
  // Nothing was ever stored, so every read is absent and nothing is ever
  // withdrawn: the route's key always arrives per request instead.
  delete: (): Promise<void> => Promise.resolve(),
  list: (): Promise<readonly unknown[]> => Promise.resolve([]),
  modify: (
    _providerId: string,
    fn: (current?: unknown) => Promise<unknown>
  ): Promise<unknown> => fn(),
  read: (): Promise<unknown> => Promise.resolve(),
});

/**
 * Ambient auth lookups over the process environment. The routes this plugin
 * serves name a credential reference, and a named reference that misses fails
 * loud rather than falling through to pi's own discovery, so these lookups
 * exist to satisfy the collection's shape — the plugin's own resolution always
 * answers first.
 */
/** The ambient-lookup surface a provider asks while resolving its own auth. */
export interface BridgeAuthContext {
  env: (name: string) => Promise<string | undefined>;
  fileExists: (path: string) => Promise<boolean>;
}

export const ambientAuthContext = (): BridgeAuthContext => ({
  env: (name: string): Promise<string | undefined> =>
    Promise.resolve(process.env[name]),
  fileExists: (): Promise<boolean> => Promise.resolve(false),
});

/**
 * pi's installed catalog entry for one model on one plane, or undefined when
 * pi does not know it.
 *
 * The bridge builds its models by hand rather than reusing a catalog route, so
 * this is where the entry the installed provider already carries comes back:
 * the compatibility switches, the `reasoning` flag, the thinking-level map and
 * the input limits are all things pi knows and this module does not, and a model
 * built without them would serve requests with those behaviours silently off.
 * Spreading that entry is what the wrapper's own materialization does.
 *
 * @param pi - the host's pi runtime.
 * @param plane - the gateway plane, which is also pi's provider id.
 * @param id - the model id.
 * @returns the installed entry, or undefined when the catalog lacks it.
 */
const installedEntryFor = (
  pi: PiRuntime,
  plane: Plane,
  id: string
): object | undefined =>
  // The plane's whole installed catalog, searched for the id, rather than a
  // lookup by literal-typed key: the ids looked up here come from our own
  // catalog, which is ahead of the installed one, and half of them are not in
  // it at all. A miss is simply no entry to inherit.
  pi.getBuiltinModels(plane).find((model) => model.id === id);

/**
 * The provider this route serves: pi's Google wire implementation carrying our
 * catalog's Gemini models.
 *
 * Built by hand, the same way the wrapper's own `reuseCatalogProvider` builds
 * one — a provider is a record pi dispatches through, not a class it
 * instantiates. `getModels` returns the models of the Zen plane whose SDK is
 * `@ai-sdk/google`, each carrying the base URL this protocol uses on that
 * plane (`…/inference/google/v1beta` under auto or modern, and
 * `…/inference/go/google/v1beta` on Go), so the request lands on
 * `…/inference/google/v1beta/models/<id>:streamGenerateContent`.
 *
 * The streams are pi's raw implementation. The session, client, project and
 * User-Agent headers are NOT added here: the fetch patch already restores all
 * of them for every gateway-matched request, measured to override rather than
 * append, so the bridge would only duplicate that work.
 *
 * @param specs - the catalogued models the route serves.
 * @param family - the endpoint family to send them to; auto (an alias of
 *   modern) by default.
 * @returns the provider the adapter's collection will hold.
 */
export const googleProviderFor = (
  pi: PiRuntime,
  specs: readonly CatalogModelSpec[],
  family: EndpointFamily = "auto",
  plane: Plane = "opencode"
): Record<string, unknown> => {
  const route = googleRouteFor(plane);
  const api = pi.googleGenerativeAIApi();
  const models = specs.map((spec) => ({
    ...piModelFor(
      plane,
      spec,
      "google-generative-ai",
      installedEntryFor(pi, plane, spec.id),
      family
    ),
    ...(plane === "opencode-go" ? { baseUrl: GO_GOOGLE_BASE_URL } : {}),
    provider: route,
  }));
  return {
    auth: {
      apiKey: {
        name: "OpenCode API key",
        /**
         * Hand the key pi's auth resolver asks for back to the protocol.
         *
         * pi never reads the credential itself: it resolves the provider's
         * `auth.apiKey.resolve`, puts the `auth` this returns into the stream
         * options, and the Google implementation reads `options.apiKey` from
         * there. So a provider that declares only a name never authenticates —
         * every request fails with "API key auth failed for provider …: apiKey.
         * resolve is not a function" before a socket is opened, which is
         * exactly what the stream-path test caught.
         *
         * It returns the value rather than a promise for it: pi awaits the
         * result either way, and there is nothing here to wait for.
         *
         * The key arrives in the credential, because the adapter resolved it
         * through this plugin's own `resolveApiKey` — the credentials service
         * first, the launch environment second — and passed it as the request's
         * `apiKey` override. Returning that is the whole job. The empty case
         * throws rather than returning nothing: a silent `undefined` would send
         * an unauthenticated request and answer with a gateway error that says
         * the key is missing, rather than saying this plugin could not find one.
         */
        resolve: (input: {
          credential?: { key?: string };
        }): { auth: { apiKey: string }; source: string } => {
          const key = input.credential?.key;
          if (key === undefined || key.length === 0) {
            throw new Error(
              `${route} reached pi's auth resolver without a key`
            );
          }
          return { auth: { apiKey: key }, source: "the plugin's resolved key" };
        },
      },
    },
    getModels: () => models,
    id: route,
    name:
      plane === "opencode-go" ? "OpenCode Go (Google)" : "OpenCode (Google)",
    stream: (model: never, context: never, options?: never) =>
      api.stream(model, context, options),
    streamSimple: (model: never, context: never, options?: never) =>
      api.streamSimple(model, context, options),
  };
};

/**
 * Resolve one credential reference the way every route this plugin serves
 * does: through the credentials service, with the launch environment as
 * fallback, and a miss that fails loud.
 *
 * A miss must not return `undefined` for a named reference: pi treats a
 * request-level `undefined` as "resolve ambient auth instead", which would
 * pick up an unrelated key — `OPENAI_API_KEY` and friends — and bill another
 * tenant for a request this route meant to authenticate differently.
 *
 * @param ctx - host context carrying the credentials service.
 * @param ref - the credential reference, when the profile names one.
 * @param route - the route asking, for the failure's message.
 * @returns the resolved key, or `undefined` only when no reference was named.
 * @throws {Error} when a named reference resolves to nothing.
 */
export const resolveGatewayKey = async (
  ctx: unknown,
  ref: unknown,
  route: string
): Promise<string | undefined> => {
  if (typeof ref !== "string" || ref.length === 0) {
    return undefined;
  }
  const resolver = readCredentialsResolver(ctx);
  const viaService = await resolver?.(ref);
  const hit = viaService?.value ?? process.env[ref];
  if (typeof hit === "string" && hit.length > 0) {
    return hit;
  }
  throw new Error(
    `[dsh-opencode-patch] no credential for provider route "${route}";` +
      ` it resolves ${ref}, which is not set — store ${ref} through the` +
      " credentials service or export it, and remove the reference only if" +
      " this route should authenticate some other way (MISSING_CREDENTIAL)"
  );
};

/** What {@link registerGoogleBridge} needs from its caller. */
export interface GoogleBridgeInputs {
  /** The billing plane whose catalog, endpoint and credential this route uses. */
  readonly plane?: Plane;
  /** Host context, for resolving the credential reference. */
  readonly ctx: unknown;
  /** The real `llm` service — the bridge registers on it directly. */
  readonly llm: {
    registerAdapter: (routes: readonly string[], adapter: unknown) => unknown;
  };
  /** The loaded `llm-pi-ai` module, whose `PiAiAdapter` the bridge reuses. */
  readonly host: Record<string, unknown> | undefined;
  /**
   * The pi the HOST installed, as {@link loadHostPi} found it.
   *
   * Required rather than looked up here so the caller decides what to do when
   * the host's pi is missing: `registerResponsesProvider` loads it once and
   * skips the mount with a console line, while a test passes its own copy.
   */
  readonly pi: PiRuntime;
  /** The catalogued models the route serves. */
  readonly specs: readonly CatalogModelSpec[];
  /** The credential reference inherited from the deployment's own route. */
  readonly apiKeyRef: string;
  /**
   * Whether the installation's own credential store may be read.
   *
   * One switch for both halves of it, because it is one decision: may this
   * plugin read another program's store at all. It governs the stored LOGIN
   * (the alternative to the device flow, reached right after the grant) and the
   * stored KEY (the last resort of the same chain), and it is off unless the
   * deployment opted in, which is the default.
   */
  readonly readOpencodeStore?: boolean;
  /**
   * Which endpoint family the bridge's models are sent to. Auto (an alias of
   * modern) by default, and the same choice the internal routes use so a
   * deployment cannot end up on two families at once.
   */
  readonly endpoint?: EndpointFamily;
}

/**
 * Register the Google bridge route on the real `llm` service.
 *
 * Nothing about this depends on the wrapper's mount: the adapter is the
 * wrapper's own class, but it comes from the loaded module, so a deployment
 * that declares every protocol route in its profile still gets the Gemini
 * models — they were the one protocol a declared route could never name.
 *
 * The resolution is the plugin's default: the inherited
 * reference, resolved through the credentials service with the launch
 * environment as fallback. A miss fails loud, because handing pi `undefined`
 * for a named reference would let it pick up an unrelated ambient key and
 * bill another tenant.
 *
 * @param inputs - the context, the service, the loaded wrapper, the models
 *   and the credential reference.
 * @returns the registration handle for the caller to withdraw, or `undefined`
 *   when the bridge cannot mount here.
 */
export const registerGoogleBridge = (inputs: GoogleBridgeInputs): unknown => {
  const { ctx, host, llm, specs } = inputs;
  const plane = inputs.plane ?? "opencode";
  const routeId = googleRouteFor(plane);
  const adapter = host?.PiAiAdapter;
  if (typeof adapter !== "function" || specs.length === 0) {
    return undefined;
  }
  const provider = googleProviderFor(inputs.pi, specs, inputs.endpoint, plane);

  // One profile, built once: the adapter memoizes its snapshot by the identity
  // of the profiles map, so a fresh map per call would rebuild the collection
  // on every request for no reason.
  const profile: Record<string, unknown> = {
    apiKeyEnv: inputs.apiKeyRef,
    configuredMaxTokens: new Map<string, number>(),
    displayName: provider.name,
    maxRequestImageBytes: MAX_REQUEST_IMAGE_BYTES,
    modelErrors: new Map<string, string>(),
    piProvider: provider,
    provider: routeId,
    requestImageMaxBytes: REQUEST_IMAGE_MAX_BYTES,
    requestImagePixelBudget: REQUEST_IMAGE_PIXEL_BUDGET,
    retryPolicy: gatewayRetryPolicy(),
    streamIdleTimeoutMs: STREAM_IDLE_TIMEOUT_MS,
  };
  const profiles = new Map([[routeId, profile]]);

  const resolveApiKey = (
    route: unknown,
    resolved: { apiKeyEnv?: unknown }
  ): Promise<string | undefined> => {
    // A route that named a reference is answered by it, loudly if it resolves
    // nothing: `undefined` would tell the adapter to find ambient auth instead.
    const named = resolved.apiKeyEnv;
    if (typeof named === "string" && named.length > 0) {
      return resolveGatewayKey(ctx, named, String(route));
    }
    // With no named reference, optionally read the owning plane's stored API key.
    return Promise.resolve(
      resolveOpencodeStoreKey(plane, inputs.readOpencodeStore === true)
    );
  };

  const images = attachmentResolvers(ctx);
  try {
    const built: unknown = Reflect.construct(adapter, [
      {
        auth: {
          authContext: ambientAuthContext(),
          credentials: emptyCredentialStore(),
        },
        profiles: () => profiles,
        resolveApiKey,
        resolveAttachments: images.resolveAttachments,
        resolveImageAccess: images.resolveImageAccess,
      },
    ]);
    const registration = llm.registerAdapter([routeId], built);
    return () => {
      try {
        if (isFunctionLike(registration))
          Reflect.apply(registration, undefined, []);
      } finally {
        images.dispose();
      }
    };
  } catch (error) {
    images.dispose();
    throw error;
  }
};
