/**
 * The fetch patch's credential resolver, and the store it learns keys into.
 *
 * Three effects, each over the pure rules in `utils/credential-policy.ts`:
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
 *   the wire is never replaced. This is the one place the fill reads the
 *   process environment; the plane adapter's key is pi-ai's rule over the
 *   host's services (D20), and never comes from here.
 * - **The installation's store** (`resolveOpencodeStoreKey`): the credential
 *   an OpenCode installation already holds for a plane, read only when the
 *   deployment turned `readOpencodeStore` on.
 *
 * Nothing here logs a key, and nothing here throws.
 *
 * @module dsh-opencode-patch/credentials
 */

import os from "node:os";

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
  type KeySourcePolicy,
  mayCapture,
  strike,
  usableKey,
} from "./utils/credential-policy.ts";
import { isRecord } from "./utils/guards.ts";

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

/** A property read that a hostile or half-built value cannot throw out of. */
const rootOf = (ctx: unknown): object | undefined => {
  if (!isRecord(ctx)) {
    return undefined;
  }
  try {
    const root: unknown = Reflect.get(ctx, "root");
    return isRecord(root) ? root : ctx;
  } catch {
    return ctx;
  }
};

/**
 * The capture store of a context's root: every activation, scope and service
 * of one composition shares it, and another composition never does.
 *
 * @param ctx - any context of the composition, real or a stand-in; a value
 *   that is not an object gets a store of its own that nothing else reads.
 */
export const captureStoreFor = (ctx: unknown): CaptureStore => {
  const root = rootOf(ctx);
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
      const declaredName =
        plane === "opencode-go" ||
        (plane.length === 0 && provider === "opencode-go")
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
