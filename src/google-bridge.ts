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
 * The one runtime pi import in this entire plugin lives below, and it is the
 * smallest thing that could serve the purpose: the protocol implementation
 * itself. Everything else this module hands the adapter is a plain object —
 * measured, pi reads fields and never checks identity — so a pi version change
 * can alter what the protocol emits, but not whether these objects interoperate.
 * `@earendil-works/pi-ai` is a pinned runtime dependency for exactly this
 * import, at the version the harness line installs, and `neverBundle` keeps
 * the packer from shipping a second pi beside the one the wrapper loads.
 *
 * The same construction would serve `@ai-sdk/mistral`: pi implements
 * `mistral-conversations`, and a bridge on this pattern is one lazy import
 * away. It is not built, because that dialect at the gateway is unmeasured and
 * no entitled key exists to measure it — the decision lives in
 * `UNSERVED_SDKS`, with this module as the record of how it would be served.
 *
 * @module dsh-opencode-patch/google-bridge
 */

import { googleGenerativeAIApi } from "@earendil-works/pi-ai/api/google-generative-ai.lazy";

import type { CatalogModelSpec } from "./catalog-data.ts";
import { readCredentialsResolver } from "./cordis-context.ts";
import { piModelFor } from "./pi-provider.ts";
import { GOOGLE_INTERNAL_ROUTE } from "./responses-routes.ts";

/**
 * The stream-idle interval a route defaults to, read from the wrapper's own
 * `DEFAULT_STREAM_IDLE_TIMEOUT_MS`: five minutes without a chunk before the
 * watchdog reports the provider idle.
 */
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
const emptyCredentialStore = (): Record<string, unknown> => ({
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
const ambientAuthContext = (): Record<string, unknown> => ({
  env: (name: string): Promise<string | undefined> =>
    Promise.resolve(process.env[name]),
  fileExists: (): Promise<boolean> => Promise.resolve(false),
});

/**
 * The provider this route serves: pi's Google wire implementation carrying our
 * catalog's Gemini models.
 *
 * Built by hand, the same way the wrapper's own `reuseCatalogProvider` builds
 * one — a provider is a record pi dispatches through, not a class it
 * instantiates. `getModels` returns the models of the Zen plane whose SDK is
 * `@ai-sdk/google`, each carrying the base URL this protocol uses on that
 * plane (`…/zen/v1`), so the request lands on
 * `…/zen/v1/models/<id>:streamGenerateContent`.
 *
 * The streams are pi's raw implementation. The session, client, project and
 * User-Agent headers are NOT added here: the fetch patch already restores all
 * of them for every gateway-matched request, measured to override rather than
 * append, so the bridge would only duplicate that work.
 *
 * @param specs - the catalogued models the route serves.
 * @returns the provider the adapter's collection will hold.
 */
export const googleProviderFor = (
  specs: readonly CatalogModelSpec[]
): Record<string, unknown> => {
  const api = googleGenerativeAIApi();
  const models = specs.map((spec) => ({
    ...piModelFor("opencode", spec, "google-generative-ai"),
    provider: GOOGLE_INTERNAL_ROUTE,
  }));
  return {
    auth: { apiKey: { name: "OpenCode API key" } },
    getModels: () => models,
    id: GOOGLE_INTERNAL_ROUTE,
    name: "OpenCode (Google)",
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
  /** Host context, for resolving the credential reference. */
  readonly ctx: unknown;
  /** The real `llm` service — the bridge registers on it directly. */
  readonly llm: {
    registerAdapter: (routes: readonly string[], adapter: unknown) => unknown;
  };
  /** The loaded `llm-pi-ai` module, whose `PiAiAdapter` the bridge reuses. */
  readonly host: Record<string, unknown> | undefined;
  /** The catalogued models the route serves. */
  readonly specs: readonly CatalogModelSpec[];
  /** The credential reference inherited from the deployment's own route. */
  readonly apiKeyRef: string;
}

/**
 * Register the Google bridge route on the real `llm` service.
 *
 * Nothing about this depends on the wrapper's mount: the adapter is the
 * wrapper's own class, but it comes from the loaded module, so a deployment
 * that declares every protocol route in its profile still gets the Gemini
 * models — they were the one protocol a declared route could never name.
 *
 * The resolution is the plugin's default, not the pool: the inherited
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
  const adapter = host?.PiAiAdapter;
  if (typeof adapter !== "function" || specs.length === 0) {
    return undefined;
  }
  const provider = googleProviderFor(specs);

  // One profile, built once: the adapter memoizes its snapshot by the identity
  // of the profiles map, so a fresh map per call would rebuild the collection
  // on every request for no reason.
  const profile: Record<string, unknown> = {
    apiKeyEnv: inputs.apiKeyRef,
    configuredMaxTokens: new Map<string, number>(),
    displayName: "OpenCode (Google)",
    maxRequestImageBytes: MAX_REQUEST_IMAGE_BYTES,
    modelErrors: new Map<string, string>(),
    piProvider: provider,
    provider: GOOGLE_INTERNAL_ROUTE,
    requestImageMaxBytes: REQUEST_IMAGE_MAX_BYTES,
    requestImagePixelBudget: REQUEST_IMAGE_PIXEL_BUDGET,
    retryPolicy: gatewayRetryPolicy(),
    streamIdleTimeoutMs: STREAM_IDLE_TIMEOUT_MS,
  };
  const profiles = new Map([[GOOGLE_INTERNAL_ROUTE, profile]]);

  const resolveApiKey = (
    route: unknown,
    resolved: { apiKeyEnv?: unknown }
  ): Promise<string | undefined> =>
    resolveGatewayKey(ctx, resolved.apiKeyEnv, String(route));

  const built: unknown = Reflect.construct(adapter, [
    {
      auth: {
        authContext: ambientAuthContext(),
        credentials: emptyCredentialStore(),
      },
      profiles: () => profiles,
      resolveApiKey,
    },
  ]);
  return llm.registerAdapter([GOOGLE_INTERNAL_ROUTE], built);
};
