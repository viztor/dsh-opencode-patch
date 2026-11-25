/**
 * Every credential the plugin reads: the fetch patch's resolver, the store it
 * learns keys into, and the meter's discovery of the Go plan's key and
 * endpoint.
 *
 * Four effects, each over the pure rules in `utils/credential-policy.ts`:
 *
 * - **The capture store**, one per root (`captureStoreFor`): the keys the
 *   plugin saw its own decorated turns send, filed by the plane and route
 *   they went to, and dropped again once the gateway refuses one twice in a
 *   row (L8). Per root rather than per process, so two compositions in one
 *   process never answer each other's lookups, and a test's fresh `Context`
 *   is a fresh store.
 * - **The fill** (`createCredentials`): the one resolver for a claimed
 *   request whose credential header is empty or a placeholder. It reads the
 *   request's own key, a captured key, the plane's declared variable in the
 *   process environment and, when the deployment opted in, the
 *   installation's store, in the policy's order (`FILL_ORDER`). A real key on
 *   the wire is never replaced. The plane adapter's key is pi-ai's rule over
 *   the host's services (D20), and never comes from here.
 * - **The installation's store** (`resolveOpencodeStoreKey`): the credential
 *   an OpenCode installation already holds for a plane, read only when the
 *   deployment turned `readOpencodeStore` on.
 * - **The meter's discovery and key resolution** (`discoverGoConfig`,
 *   `resolveGoBaseURL`, `resolveGoApiKey`, `resolveZenCreditInfo`). The Go
 *   plan's key and endpoint normally live in another plugin's row (an
 *   `llm-pi-ai` provider registry or a standalone `opencode-go` entry) rather
 *   than in this one, so this half reads what the composition already declares
 *   and falls back to a built-in default. There is deliberately **no** row
 *   setting for the credential reference: a knob here would duplicate the
 *   provider row's own `apiKeyEnv`, and the live request is the better source
 *   anyway (`key-capture.ts`). `usageBaseURL` remains as the one endpoint
 *   override. The sources are ordered against each other by `METER_ORDER`.
 *
 * The fill and the meter's key resolution both read the process environment,
 * and both read it here: the fill nowhere else, the meter after the host's
 * credentials service. Credential *capture* (pulling a key off a live request
 * and classifying its tier) lives in `key-capture.ts`.
 *
 * Nothing here logs a key, and nothing here throws.
 *
 * @module dsh-opencode-patch/credentials
 */

import os from "node:os";

import { DEFAULT_USAGE_BASE_URL, DEFAULT_USAGE_KEY_ENV } from "./config.ts";
import {
  loaderOfContext,
  readCredentialsResolver,
  rootOfContext,
} from "./cordis-context.ts";
import {
  extractApiKeyFromHeaders,
  type KeyTier,
  tierForRequest,
} from "./key-capture.ts";
import { opencodeDatabasePath } from "./opencode-paths.ts";
import { readOpencodeCredentials } from "./opencode-store.ts";
import {
  countsAsRefusal,
  FILL_ORDER,
  type FillSource,
  firstUsable,
  firstUsableAsync,
  type KeySourcePolicy,
  mayCapture,
  METER_ORDER,
  strike,
  usableKey,
} from "./utils/credential-policy.ts";
import { isRecord } from "./utils/guards.ts";
import {
  foreignCredentialsRealm,
  pluginMarkerOf,
  type RealmSide,
} from "./utils/plane-ownership.ts";
import { planeOfPlaneRoute } from "./utils/planes.ts";

/** What the gateway's answer says about the key a request carried. */
export type KeyOutcome = "accepted" | "refused";

/**
 * The keys the plugin's own decorated turns sent, read three ways.
 *
 * A lookup can be scoped by route or by tier; the tier map is what makes a
 * lookup survive a renamed route. The most recently seen key is the last
 * resort, and is why the tier argument matters: without it, "most recently
 * seen" can hand the Go endpoint a Zen key.
 */
export interface CaptureStore {
  /**
   * File a key under the route and plane its request went to. A blank or
   * placeholder value is ignored, and so is a key this store dropped for that
   * plane until a request carrying it is accepted again.
   *
   * @param key - the key the request carried.
   * @param provider - the turn's route, when known.
   * @param url - the request URL, which decides the plane first.
   */
  readonly record: (key: string, provider?: string, url?: string) => void;
  /**
   * A captured key by route or by tier. A tiered lookup answers only a key
   * sent to that plane: a key a route sent to a URL on neither plane answers
   * `forRoute` and an untiered lookup, never a plane's (OC3). A route named
   * `opencode`/`opencode-go` is the exception: on a URL on neither plane its
   * key is filed by the route's name as that plane's (a mirror's), so it
   * answers that tier and not `forRoute`.
   *
   * @param provider - route id to try first, when the caller has one.
   * @param tier - the tier the key must belong to. Pass it whenever the
   * request already identifies one: omitting it lets the most recently seen
   * key win, which may be for the other tier. A route-scoped hit is filtered
   * by it too — naming a route is a preference, not a licence to ignore the
   * tier.
   */
  readonly get: (provider?: string, tier?: "go" | "zen") => string | undefined;
  /**
   * The key a route sent to a URL on neither plane, and only that (OC3): a
   * key captured on a plane never answers a request the route claims
   * elsewhere. A route named after a plane files no key here: off the
   * gateway its key is that plane's, by the route-name fallback.
   *
   * @param provider - the route.
   */
  readonly forRoute: (provider: string) => string | undefined;
  /**
   * Fold the gateway's answer into the key's standing (L8): an accepted key
   * is cleared of strikes, a refused one gains a strike and is dropped from
   * every lookup of its plane at the second in a row. A drop is lifted only
   * by an acceptance of a request that may file the key (`recordable`, OC3):
   * the key its own decorated turn sent. A key the fill supplied, accepted,
   * leaves the drop where it is.
   *
   * @returns whether this answer lifted a drop, so the caller files the key
   *   again; a key the store neither holds nor dropped is left alone.
   */
  readonly settle: (
    key: string,
    provider: string | undefined,
    url: string,
    outcome: KeyOutcome,
    recordable: boolean
  ) => boolean;
}

/**
 * Whether a key classified as `tier` may answer a lookup for `wanted`: only a
 * key of that tier, identically in all three lookup paths.
 *
 * `unknown` used to be admitted too, on the reading that an unclassifiable key
 * was one never identified rather than one proved to be the other tier. Every
 * key is filed with the URL its request went to, though, so an `unknown` key
 * is one a route sent to a URL on NEITHER plane: a relay's or a mirror's, sent
 * to a third party. Admitted, it filled placeholder plane requests and reached
 * the Go `/usage` endpoint, and L8 could never drop it there (its strikes are
 * kept under its route), so dropping the plane's own key handed the plane the
 * relay's in its place. It answers its own route's lookup (`forRoute`) and an
 * untiered one, and nothing else (OC3, both directions).
 */
const tierSatisfies = (tier: KeyTier, wanted: "go" | "zen"): boolean =>
  tier === wanted;

/**
 * The scope a key's strikes and drop are kept under: its plane for a key
 * sent to the gateway, its route for one sent anywhere else.
 */
const scopeOf = (tier: KeyTier, provider: string | undefined): string =>
  tier === "unknown" ? `route:${provider ?? ""}` : tier;

/** A capture store of its own; {@link captureStoreFor} hands one out per root. */
export const createCaptureStore = (): CaptureStore => {
  /**
   * The route-scoped map carries the tier ALONGSIDE the key rather than only
   * the key. It used to hold `string`, which made the route lookup the one
   * path that ignored a requested tier: a Zen key seen while the Go route was
   * in play came back verbatim, so it outranked every correctly-filtered
   * source — and it is the FIRST captured step of both `auto` and `request`.
   * Holding the tier is what lets the route lookup apply the same rule the
   * other two already did.
   */
  const byProvider = new Map<string, { key: string; tier: KeyTier }>();
  const byTier = new Map<"go" | "zen", string>();
  let latest: { key: string; provider?: string; tier: KeyTier } | undefined;
  const strikes = new Map<string, { key: string; n: number }>();
  const dropped = new Map<string, string>();

  /** Remove `key` from every lookup of `scope`. */
  const forget = (key: string, scope: string): void => {
    for (const [provider, entry] of byProvider) {
      if (entry.key === key && scopeOf(entry.tier, provider) === scope) {
        byProvider.delete(provider);
      }
    }
    for (const [tier, held] of byTier) {
      if (held === key && tier === scope) {
        byTier.delete(tier);
      }
    }
    if (
      latest !== undefined &&
      latest.key === key &&
      scopeOf(latest.tier, latest.provider) === scope
    ) {
      latest = undefined;
    }
  };

  /** Whether `key` answers any lookup of `scope`. */
  const holds = (key: string, scope: string): boolean =>
    [...byProvider].some(
      ([provider, entry]) =>
        entry.key === key && scopeOf(entry.tier, provider) === scope
    ) ||
    [...byTier].some(([tier, held]) => held === key && tier === scope) ||
    (latest?.key === key && scopeOf(latest.tier, latest.provider) === scope);

  return {
    forRoute: (provider) => {
      const entry = byProvider.get(provider);
      return entry?.tier === "unknown" ? entry.key : undefined;
    },
    get: (provider, tier) => {
      if (typeof provider === "string" && provider.length > 0) {
        const direct = byProvider.get(provider);
        if (
          direct !== undefined &&
          (tier === undefined || tierSatisfies(direct.tier, tier))
        ) {
          return direct.key;
        }
      }
      if (tier !== undefined) {
        const held = byTier.get(tier);
        if (held !== undefined) {
          return held;
        }
      }
      return latest !== undefined &&
        (tier === undefined || tierSatisfies(latest.tier, tier))
        ? latest.key
        : undefined;
    },
    record: (raw, provider, url) => {
      const key = usableKey(raw);
      if (key === undefined) {
        return;
      }
      // Deliberately NOT the meter's route-first precedence (`resolveGoApiKey`):
      // a key seen on a live request is classified by the request that
      // carried it, not by the route the user named. See `tierForRequest`.
      const tier = tierForRequest(url, provider);
      if (dropped.get(scopeOf(tier, provider)) === key) {
        return;
      }
      if (typeof provider === "string" && provider.length > 0) {
        byProvider.set(provider, { key, tier });
      }
      if (tier !== "unknown") {
        byTier.set(tier, key);
      }
      latest = { key, provider, tier };
    },
    settle: (key, provider, url, outcome, recordable) => {
      const scope = scopeOf(tierForRequest(url, provider), provider);
      const wasDropped = dropped.get(scope) === key;
      if (!wasDropped && !holds(key, scope)) {
        return false;
      }
      if (wasDropped) {
        if (outcome === "accepted" && recordable) {
          dropped.delete(scope);
          return true;
        }
        return false;
      }
      if (outcome === "accepted") {
        strikes.delete(scope);
        return false;
      }
      const current = strikes.get(scope);
      const next = strike(current?.key === key ? current.n : 0, "refused");
      if (next.evict) {
        strikes.delete(scope);
        forget(key, scope);
        dropped.set(scope, key);
      } else {
        strikes.set(scope, { key, n: next.strikes });
      }
      return false;
    },
  };
};

/** One store per root; see {@link captureStoreFor}. */
const stores = new WeakMap<object, CaptureStore>();

/**
 * The key a context's capture store is filed under: its root, or the context
 * itself when it carries none. Read through {@link rootOfContext}, so cordis
 * 4.2's symbol and older cores' property both answer.
 */
const storeKeyOf = (ctx: unknown): object | undefined =>
  rootOfContext(ctx) ?? (isRecord(ctx) ? ctx : undefined);

/**
 * The capture store of a context's root: every activation, scope and service
 * of one composition shares it, and another composition never does.
 *
 * @param ctx - any context of the composition, real or a stand-in; a value
 *   that is not an object gets a store of its own that nothing else reads.
 */
export const captureStoreFor = (ctx: unknown): CaptureStore => {
  const root = storeKeyOf(ctx);
  if (root === undefined) {
    return createCaptureStore();
  }
  let store = stores.get(root);
  if (store === undefined) {
    store = createCaptureStore();
    stores.set(root, store);
  }
  return store;
};

/**
 * The database path the installation itself would use.
 *
 * Resolved per call rather than cached, because the two facts it depends on —
 * the ambient environment and the home directory — belong to the process at
 * request time.
 *
 * @returns the path the store readers take, which may be `:memory:`.
 */
const opencodeStorePath = (): string =>
  opencodeDatabasePath(
    {
      channel: process.env.OPENCODE_CHANNEL,
      env: process.env,
      home: os.homedir(),
    },
    os.tmpdir()
  );

/**
 * The credential the OpenCode installation already holds for a plane.
 *
 * The path is resolved the way the installation resolves it, from the ambient
 * environment and the user's home, because that is where those facts live at
 * request time. Nothing here throws and nothing here logs: a machine without
 * OpenCode is the ordinary case, and a secret never reaches a message.
 *
 * @param plane - the integration id to match: `opencode` (Zen) or
 *   `opencode-go`.
 * @param enabled - the deployment's opt-in. When false this answers
 *   `undefined` without touching the filesystem, which is the default.
 * @returns the stored value, or `undefined` when the switch is off, the store
 *   is absent or unreadable, or it holds nothing for this plane.
 */
export const resolveOpencodeStoreKey = (
  plane: string,
  enabled: boolean
): string | undefined => {
  if (!enabled || plane.length === 0) {
    return undefined;
  }
  const credentials = readOpencodeCredentials(opencodeStorePath());
  return credentials?.find((entry) => entry.integrationId === plane)?.value;
};

/**
 * What the fill consulted, for the no-credential report. Presence, never
 * values. The request's own key and a captured key are not reported: every
 * policy's order consults both ahead of the declared variable (`FILL_ORDER`),
 * so either one present fills the wire and no report follows.
 */
export interface FillConsulted {
  /** The plane's declared variable. */
  readonly declaredName: string;
  /**
   * Whether that variable is set at all, a placeholder included: the report
   * must not send the reader to set a variable that is set to the wrong value.
   */
  readonly declaredSet: boolean;
  readonly storeRead: boolean;
}

/** The fill's answer. */
export interface FillDecision {
  readonly key?: string;
  readonly source?: FillSource;
  readonly consulted: FillConsulted;
}

/** The fetch patch's one credential resolver. */
export interface FetchCredentials {
  /**
   * The request's own usable key, recorded only when the request belongs to a
   * turn the plugin decorated and to no other plugin (OC3).
   */
  readonly observe: (request: {
    readonly headers: Headers;
    readonly url: string;
    readonly provider?: string;
    readonly decorated: boolean;
    readonly foreign: boolean;
    readonly marked: boolean;
  }) => string | undefined;
  /** The key for an empty or placeholder wire key, in the policy's order. */
  readonly fillKey: (request: {
    readonly plane: string;
    readonly url: string;
    readonly provider?: string;
    readonly requestKey?: string;
  }) => FillDecision;
  /**
   * The gateway's answer to a request of a decorated turn, folded into the
   * standing of the key it carried (L8). A 2xx accepts it; a 401 on a
   * well-formed session refuses it; anything else says nothing about the key.
   * A request outside any decorated turn says nothing either way (OC3): the
   * meter's own `/usage` poll, a Console call or another tool's background
   * request neither strikes a key nor lifts a drop. The usage endpoint
   * refuses keys inference accepts, so its 401 is no evidence about a turn's
   * key.
   */
  readonly settle: (sent: {
    readonly key?: string;
    readonly url: string;
    readonly provider?: string;
    readonly status: number;
    readonly sessionWellFormed: boolean;
    /** The request belongs to a turn the plugin decorated. */
    readonly decorated: boolean;
    /** The key was the request's own, and the request's keys may be kept. */
    readonly recordable: boolean;
  }) => void;
  /** The pinned session id a deployment exported under `sessionIdEnv`. */
  readonly sessionPin: (name: string | undefined) => string | undefined;
}

/** What {@link createCredentials} takes. */
export interface CredentialInputs {
  readonly store: CaptureStore;
  readonly keySource: KeySourcePolicy;
  readonly readOpencodeStore: boolean;
  /** The process environment by default; a test hands its own. */
  readonly environment?: (name: string) => string | undefined;
  /**
   * The installation's store for a plane, consulted only when the deployment
   * opted in and every earlier step answered nothing. The real store
   * ({@link resolveOpencodeStoreKey}) by default; a test hands its own to see
   * when it is read.
   */
  readonly storeReader?: (plane: string) => string | undefined;
}

/**
 * The fetch patch's resolver over one capture store.
 *
 * @param inputs - the store, the policy, the store opt-in, the environment.
 * @returns the resolver.
 */
export const createCredentials = (
  inputs: CredentialInputs
): FetchCredentials => {
  const environment =
    inputs.environment ?? ((name: string) => process.env[name]);
  const storeReader =
    inputs.storeReader ??
    ((plane: string) => resolveOpencodeStoreKey(plane, true));
  const { store } = inputs;
  return {
    fillKey: ({ plane, provider, requestKey, url }) => {
      // The captured key is looked up by tier as well as by provider: a user
      // may have named the route anything, and a provider-id miss must not
      // hide a key that is already known to work. A request on neither plane
      // takes only the key its own route sent there (OC3). Under the
      // `configured` policy the declared credential wins outright, so the
      // capture is skipped entirely.
      const tier = tierForRequest(url, provider);
      let captured: string | undefined;
      if (inputs.keySource !== "configured") {
        if (tier !== "unknown") {
          captured = store.get(provider, tier);
        } else if (provider !== undefined) {
          captured = store.forRoute(provider);
        }
      }
      // Only a known gateway plane may ask for its own variable: a configured
      // provider can also claim other URLs, which take the Zen one, as they
      // always have.
      // A URL on a plane decides alone; with none, the exact route does.
      const declaredName =
        planeOfPlaneRoute(plane.length === 0 ? provider : plane) === "go"
          ? "OPENCODE_GO_API_KEY"
          : "OPENCODE_API_KEY";
      const declared = environment(declaredName);
      // **API key only.** The credential ladder ends at the installation's own
      // store: a login (device flow, session, credential pool) is v2 work and
      // does not live here. `readOpencodeStore` is off unless the deployment
      // opted in.
      const decided = firstUsable(FILL_ORDER[inputs.keySource], {
        captured: () => captured,
        declared: () => declared,
        request: () => requestKey,
        store: () =>
          inputs.readOpencodeStore ? storeReader(plane) : undefined,
      });
      return {
        consulted: {
          declaredName,
          declaredSet: declared !== undefined && declared.length > 0,
          storeRead: inputs.readOpencodeStore,
        },
        ...(decided === undefined
          ? {}
          : { key: decided.key, source: decided.step }),
      };
    },
    observe: ({ decorated, foreign, headers, marked, provider, url }) => {
      const key = usableKey(extractApiKeyFromHeaders(headers));
      if (key !== undefined && mayCapture({ decorated, foreign, marked })) {
        store.record(key, provider, url);
      }
      return key;
    },
    sessionPin: (name) =>
      name === undefined || name.length === 0 ? undefined : environment(name),
    settle: ({
      decorated,
      key,
      provider,
      recordable,
      sessionWellFormed,
      status,
      url,
    }) => {
      const sent = usableKey(key);
      if (sent === undefined || !decorated) {
        return;
      }
      if (status >= 200 && status < 300) {
        if (store.settle(sent, provider, url, "accepted", recordable)) {
          store.record(sent, provider, url);
        }
        return;
      }
      if (countsAsRefusal({ keySent: true, sessionWellFormed, status })) {
        store.settle(sent, provider, url, "refused", recordable);
      }
    },
  };
};

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
 *   never be mistaken for the key itself. The capture store already refuses
 *   one; a discovered literal has to refuse it too, or the meter's first step
 *   hands the gateway a placeholder and the poll fails with a 401 that reads
 *   like a missing subscription.
 *
 * Both are `usableKey`'s, the one filter every decider shares.
 */
const usableCredential = (value: unknown): value is string =>
  usableKey(value) !== undefined;

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

/** A property read that a hostile or half-built value cannot throw out of. */
const readSafely = (value: unknown, key: string): unknown => {
  if (!isRecord(value)) {
    return undefined;
  }
  try {
    return Reflect.get(value, key);
  } catch {
    return undefined;
  }
};

/**
 * A provider row this discovery may read: a record that carries no other
 * plugin's `x-opencode-plugin` marker (D27). A marked route belongs to the
 * plugin that wrote it, and so do its key reference, its literal key and its
 * base.
 */
const ownRow = (row: unknown): row is Record<string, unknown> =>
  isRecord(row) && pluginMarkerOf(row) === undefined;

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
 * **Another plugin's entry is never read** (D27): a row whose credentials
 * resolve in a realm this context does not resolve (the route claim's own
 * rule, `utils/plane-ownership.ts`), and a provider row that carries the
 * `x-opencode-plugin` marker. Its reference names a credential this context
 * cannot see, or can see only by accident through the environment, and its
 * base is that plugin's gateway: the meter sends neither the other plugin's
 * token nor the user's own key there.
 *
 * @param ctx - the plugin context, mock or real.
 * @param targetProvider - optional specific provider route id to prioritize.
 */
export const discoverGoConfig = (
  ctx: unknown,
  targetProvider?: string
): DiscoveredGoConfig => {
  const result: DiscoveredGoConfig = {};
  // The guard RETURNS the loader, so nothing re-reads a property that can throw.
  const loader = loaderOfContext(ctx);
  if (loader === undefined) {
    return result;
  }
  const own: RealmSide = {
    context: ctx,
    options: readSafely(
      readSafely(readSafely(ctx, "fiber"), "entry"),
      "options"
    ),
  };
  const root = rootOfContext(ctx);

  for (const entry of loader.entries()) {
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
    if (
      foreignCredentialsRealm(
        { context: readSafely(entry, "ctx"), options },
        own,
        root
      ) !== undefined
    ) {
      continue;
    }

    // 1. Providers inside a provider registry like llm-pi-ai.
    const providers: unknown = config.providers;
    if (isRecord(providers)) {
      if (
        typeof targetProvider === "string" &&
        targetProvider.length > 0 &&
        ownRow(providers[targetProvider])
      ) {
        readProviderRow(providers[targetProvider], result);
        continue;
      }
      if (ownRow(providers["opencode-go"])) {
        readProviderRow(providers["opencode-go"], result);
      } else if (ownRow(providers.opencode)) {
        readProviderRow(providers.opencode, result);
      } else {
        for (const pRow of Object.values(providers)) {
          if (ownRow(pRow)) {
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
    if (!ownRow(config)) {
      continue;
    }
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
 * Point a discovered base URL at the Go quota endpoint.
 *
 * **Both endpoint families have to land on the `zen/go` form, and that is
 * measured rather than assumed.** The public quota route is
 * `GET /zen/go/v1/usage` and there is no second one: the only route file in
 * either major version is
 * `packages/console/app/src/routes/zen/go/v1/usage.ts` (checked in 1.19.5 and
 * 2.0.32), and the inference proxy's path table
 * (`packages/console/app/src/lib/inference-proxy.ts`) lists
 * `"GET /zen/go/v1/usage": "/go/v1/usage"` with no `/inference/.../usage`
 * counterpart.
 *
 * The catalog now names the INFERENCE family for the `opencode` provider
 * (`api: https://opencode.ai/inference/openai/v1`), so a base discovered from a
 * provider row is very often that family. Rewriting only `zen/v1` left it
 * untouched, and the meter then asked `…/inference/openai/v1/usage` — a path
 * that does not exist — which is an unavailable meter with no explanation.
 *
 * A URL on neither family (a mirror, a self-hosted gateway) passes through
 * untouched: this function does not invent an endpoint it was not given.
 *
 * @param url - candidate base URL.
 */
export const toGoBaseURL = (url: string): string => {
  if (url.includes("opencode.ai/inference")) {
    return DEFAULT_USAGE_BASE_URL;
  }
  if (url.includes("opencode.ai/zen/v1")) {
    return url.replace("opencode.ai/zen/v1", "opencode.ai/zen/go/v1");
  }
  return url;
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
 * Resolve the Go API key without ever exposing it to the client.
 *
 * Order is `METER_ORDER[policy]`; with the default `auto` that is
 * a literal `apiKey` discovered in another entry, then a captured key for the
 * Go tier, then the credential service and environment, then any captured key,
 * and last the installation's own store when the deployment opted in.
 *
 * @param ctx - the plugin context used for discovery and credentials.
 * @param targetProvider - optional specific provider route id to prioritize.
 * @param policy - which source wins when several resolve.
 * @param readOpencodeStore - whether the installation's own store may be read
 *   as the last resort. Off by default.
 * @returns the key, or `undefined` when nothing resolves — the caller raises
 * the typed `MISSING_CREDENTIAL` error instead of a raw one.
 */
export const resolveGoApiKey = (
  ctx: unknown,
  targetProvider?: string,
  policy: KeySourcePolicy = "auto",
  readOpencodeStore = false
): Promise<string | undefined> => {
  const discovered = discoverGoConfig(ctx, targetProvider);
  const store = captureStoreFor(ctx);
  return firstUsableAsync(METER_ORDER[policy], {
    captured: () => store.get(targetProvider, "go"),
    capturedAny: () => store.get(undefined, "go"),
    configured: () => resolveGoKeyForRef(ctx, effectiveGoKeyRef(discovered)),
    literal: () => discovered.literalKey,
    opencodeStore: () =>
      resolveOpencodeStoreKey("opencode-go", readOpencodeStore),
  });
};

/**
 * Resolve one credential reference through the credentials service, then the
 * environment, each answer through the one filter (`usableKey`): a blank or a
 * placeholder is no credential, and a service that answers one falls through
 * to the environment, as {@link resolveGoKeyForRef} does.
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
      const answer = await resolve(ref);
      const hit = usableKey(answer?.value);
      if (hit !== undefined) {
        return hit;
      }
    } catch {
      // Fall through to the environment.
    }
  }
  return usableKey(process.env[ref]);
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
  usableKey(value) !== undefined;

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
  if (usableKey(captureStoreFor(ctx).get("opencode", "zen")) !== undefined) {
    return { isConfigured: true };
  }

  const zenKey = await resolveRef(ctx, "OPENCODE_API_KEY");
  return { isConfigured: zenKey !== undefined };
};
