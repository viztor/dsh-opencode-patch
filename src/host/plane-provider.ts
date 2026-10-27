/**
 * The adapter the plugin registers under `opencode` and `opencode-go`: the
 * host's own `PiAiAdapter`, over profiles the plugin resolves (D13).
 *
 * `PiAiAdapter` is a public export of pi-ai, and it already serves every
 * protocol per model, validates efforts against each model, projects replay
 * state and normalizes failures. What the plugin adds is only what pi-ai's own
 * profiles cannot say: a model pi's catalog does not describe, the endpoint
 * family, and the Off/On names of a toggle model. So the subclass overrides
 * three methods and no stream:
 *
 * - `listModels` answers the declared ids when `super` answers nothing or the
 *   key is missing (F18): a plane lists its models whether or not a key
 *   resolves, and dispatch still fails loudly (D21);
 * - `resolveModel` and `prepareCall` relabel a toggle model's `high` as "On"
 *   (D1). Ids, validation and the stream are pi-ai's.
 *
 * pi-ai exports neither its credential store nor its auth context (F19), so
 * both are restated here over the same seams, keyed by pi-ai's exported
 * `recordKeyFor`, and the key resolution mirrors pi-ai's exactly (D20).
 *
 * @module dsh-opencode-patch/host/plane-provider
 */

import type { ResolvedPluginConfig } from "../config.ts";
import {
  type HostLibraries,
  type HostModules,
  readLaunchEnvironment,
} from "../cordis-context.ts";
import { resolveOpencodeStoreKey } from "../go-discovery.ts";
import { isFunctionLike, isRecord } from "../utils/guards.ts";
import type { PlaneProviderBuilder } from "../utils/plane-profile.ts";
import { PROTOCOLS } from "../utils/protocols.ts";
import { withCatalogThinkingLevels } from "./google-levels.ts";

/** A resolved plane profile, as far as this module reads one. */
export interface PlaneProfileLike {
  readonly apiKeyEnv?: string;
  readonly piProvider?: unknown;
  readonly [key: string]: unknown;
}

/** A model listing row, the shape `LlmAdapter.listModels` answers. */
interface ListedModel {
  readonly provider: string;
  readonly id: string;
  readonly name: string;
  readonly inputModalities?: readonly string[];
}

/**
 * The `PiAiAdapter` surface the subclass calls through `super`. Method
 * signatures on purpose: a subclass overrides a method, never a property.
 */
/* oxlint-disable typescript/method-signature-style */
interface PiAiAdapterLike {
  listModels(provider: string): Promise<readonly ListedModel[]>;
  resolveModel(
    provider: string,
    model: string,
    signal?: AbortSignal
  ): Promise<unknown>;
  prepareCall(
    provider: string,
    model: string,
    signal?: AbortSignal
  ): Promise<unknown>;
}
/* oxlint-enable typescript/method-signature-style */

/** What {@link createPlaneAdapter} takes. */
export interface PlaneAdapterInputs {
  readonly modules: HostModules;
  readonly profiles: () => ReadonlyMap<string, PlaneProfileLike>;
  /** The display names a model's efforts carry, when the catalog decided them. */
  readonly effortNames: (
    provider: string,
    model: string
  ) => Readonly<Record<string, string>> | undefined;
  readonly resolveApiKey: (
    provider: string,
    profile: PlaneProfileLike
  ) => Promise<string | undefined>;
  readonly auth: PlaneAuth;
  readonly resolveAttachments?: () => unknown;
  readonly resolveImageAccess?: (store: unknown, ref: unknown) => unknown;
  readonly onReplayDegrade?: (event: {
    provider: string;
    model: string;
    reason: string;
  }) => void;
}

/** The error code of a thrown value, when it has one. */
const codeOf = (error: unknown): unknown =>
  isRecord(error) ? error.code : undefined;

/**
 * Model info with its efforts renamed (D1's "On"), or the same object when
 * there is nothing to rename. Ids are never touched: dispatch matches them.
 *
 * @param info - what `resolveModel` answered.
 * @param names - display names by effort id, when the catalog decided them.
 */
export const relabelEfforts = (
  info: unknown,
  names?: Readonly<Record<string, string>>
): unknown => {
  if (names === undefined || !isRecord(info) || !isRecord(info.reasoning)) {
    return info;
  }
  const { efforts } = info.reasoning;
  if (!Array.isArray(efforts)) {
    return info;
  }
  return {
    ...info,
    reasoning: {
      ...info.reasoning,
      efforts: efforts.map((effort: unknown) =>
        isRecord(effort) && typeof effort.id === "string"
          ? { ...effort, name: names[effort.id] ?? effort.name }
          : effort
      ),
    },
  };
};

/**
 * Build the plane adapter: a subclass of the host's `PiAiAdapter`.
 *
 * @param inputs - the host modules, the profiles and the auth seams.
 * @returns the adapter, whose `constructor.name` is `PlaneAdapter`.
 */
export const createPlaneAdapter = (inputs: PlaneAdapterInputs): object => {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- pi-ai's exported class, checked to be a constructor by `asPiAiModule`; its methods are the ones `PiAiAdapterLike` names.
  const Base = inputs.modules.piAi.PiAiAdapter as unknown as new (
    options: Record<string, unknown>
  ) => PiAiAdapterLike;

  class PlaneAdapter extends Base {
    override async listModels(
      provider: string
    ): Promise<readonly ListedModel[]> {
      let listed: readonly ListedModel[];
      try {
        listed = await super.listModels(provider);
      } catch (error) {
        if (codeOf(error) !== "MISSING_CREDENTIAL") {
          throw error;
        }
        listed = [];
      }
      if (listed.length > 0) {
        return listed;
      }
      // pi-ai answers [] on a missing key (F18); the plane still lists what
      // the user declared, and the turn is what fails, loudly.
      const piProvider = inputs.profiles().get(provider)?.piProvider;
      const models: unknown =
        isRecord(piProvider) && isFunctionLike(piProvider.getModels)
          ? Reflect.apply(piProvider.getModels, piProvider, [])
          : [];
      return (Array.isArray(models) ? models : []).flatMap((model: unknown) =>
        isRecord(model) && typeof model.id === "string"
          ? [
              {
                id: model.id,
                inputModalities: Array.isArray(model.input)
                  ? model.input.filter(
                      (item): item is string => typeof item === "string"
                    )
                  : ["text"],
                name: typeof model.name === "string" ? model.name : model.id,
                provider,
              },
            ]
          : []
      );
    }

    override async resolveModel(
      provider: string,
      model: string,
      signal?: AbortSignal
    ): Promise<unknown> {
      return relabelEfforts(
        await super.resolveModel(provider, model, signal),
        inputs.effortNames(provider, model)
      );
    }

    override async prepareCall(
      provider: string,
      model: string,
      signal?: AbortSignal
    ): Promise<unknown> {
      const prepared = await super.prepareCall(provider, model, signal);
      return isRecord(prepared)
        ? {
            ...prepared,
            model: relabelEfforts(
              prepared.model,
              inputs.effortNames(provider, model)
            ),
          }
        : prepared;
    }
  }
  // A bundler may rename a class it emits; the probe and the tests read this.
  Object.defineProperty(PlaneAdapter, "name", { value: "PlaneAdapter" });
  // Which pi the provider is built from: the binary e2e's probe asserts it is
  // the host's own copy, not a linked checkout's.
  Object.defineProperty(PlaneAdapter, "hostPi", {
    value: Object.freeze({
      root: inputs.modules.libraries.root,
      version: inputs.modules.libraries.version,
    }),
  });

  return new PlaneAdapter({
    auth: inputs.auth,
    profiles: inputs.profiles,
    resolveApiKey: inputs.resolveApiKey,
    ...(inputs.resolveAttachments === undefined
      ? {}
      : { resolveAttachments: inputs.resolveAttachments }),
    ...(inputs.resolveImageAccess === undefined
      ? {}
      : { resolveImageAccess: inputs.resolveImageAccess }),
    ...(inputs.onReplayDegrade === undefined
      ? {}
      : { onReplayDegrade: inputs.onReplayDegrade }),
  });
};

/** A pi credential, as pi-ai maps one from a stored record. */
type PiCredential = Readonly<Record<string, unknown>>;

/** The credentials service, as far as the auth seams read it. */
interface CredentialsLike {
  resolve?: (ref: string) => Promise<unknown>;
  readRecord?: (key: string) => Promise<unknown>;
  listRecords?: () => Promise<unknown>;
  modifyRecord?: (
    key: string,
    mutate: (current: unknown) => Promise<unknown>
  ) => Promise<unknown>;
  deleteRecord?: (key: string) => Promise<unknown>;
}

/** pi's `CredentialStore` and `AuthContext`, over the host's seams. */
export interface PlaneAuth {
  readonly credentials: {
    read: (providerId: string) => Promise<PiCredential | undefined>;
    list: () => Promise<{ providerId: string; type: string }[]>;
    modify: (
      providerId: string,
      mutate: (current?: PiCredential) => Promise<PiCredential | undefined>
    ) => Promise<PiCredential | undefined>;
    delete: (providerId: string) => Promise<void>;
  };
  readonly authContext: {
    env: (name: string) => Promise<string | undefined>;
    fileExists: (path: string) => Promise<boolean>;
  };
}

/** The record id grammar (`dsh-credentials` `KEY_SEGMENT_PATTERN`). */
const KEY_SEGMENT = /^[a-z][a-z0-9-]*$/u;

/** The credential-ref grammar (`dsh-credentials` `REF_PATTERN`). */
const REF_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;

/** The scope pi-ai stores its records under (`auth.ts` `RECORD_SCOPE`). */
const RECORD_SCOPE = "llm-pi-ai";

/** The credentials service, read per call. */
const credentialsOf = (ctx: unknown): CredentialsLike | undefined => {
  if (!isRecord(ctx) || !isFunctionLike(ctx.get)) {
    return undefined;
  }
  const service: unknown = Reflect.apply(ctx.get, ctx, ["credentials"]);
  return isRecord(service) ? service : undefined;
};

/** pi-ai's `toPiCredential` (`auth.ts:74-88`). */
const toPiCredential = (record: unknown): PiCredential | undefined => {
  if (!isRecord(record)) {
    return undefined;
  }
  if (record.kind === "api-key") {
    return {
      type: "api_key",
      ...(record.key === undefined ? {} : { key: record.key }),
      ...(isRecord(record.env) ? { env: { ...record.env } } : {}),
    };
  }
  return isRecord(record.payload) ? record.payload : undefined;
};

/** The JSON image of a grant payload (`auth.ts` `jsonImage`). */
const jsonImage = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map((entry: unknown) =>
      entry === undefined ? null : jsonImage(entry)
    );
  }
  if (isRecord(value) && Object.getPrototypeOf(value) === Object.prototype) {
    const image: Record<string, unknown> = {};
    for (const [key, member] of Object.entries(value)) {
      if (member !== undefined) {
        image[key] = jsonImage(member);
      }
    }
    return image;
  }
  return value;
};

/** pi-ai's `toRecord` (`auth.ts:90-100`). */
const toRecord = (credential: PiCredential): Record<string, unknown> =>
  credential.type === "api_key"
    ? {
        kind: "api-key",
        ...(credential.key === undefined ? {} : { key: credential.key }),
        ...(isRecord(credential.env) ? { env: { ...credential.env } } : {}),
      }
    : { kind: "grant", payload: jsonImage(credential) };

/** An error carrying a host failure code, in dsh-llm's class when there is one. */
export const hostError = (
  libraries: HostLibraries | undefined,
  message: string,
  code: string
): Error => {
  if (libraries?.LlmError !== undefined) {
    return new libraries.LlmError(message, code);
  }
  const error = new Error(message) as Error & {
    code?: string;
    failure?: unknown;
  };
  error.code = code;
  error.failure = Object.freeze({ code, message });
  return error;
};

/**
 * pi's credential store and auth context over the host's seams, as pi-ai
 * builds its own (`llm-pi-ai/src/auth.ts:141-231`): records under
 * `recordKeyFor(provider)`, so a Sign-in record under `llm-pi-ai/opencode`
 * keeps authenticating the plane, and `env` asks the credentials service
 * before the launch environment. OpenCode's auth reads no file.
 *
 * @param ctx - the plugin context.
 * @param recordKeyFor - pi-ai's exported record addressing.
 * @param libraries - for the host's error class.
 */
export const planeAuth = (
  ctx: unknown,
  recordKeyFor: (providerId: string) => string,
  libraries?: HostLibraries
): PlaneAuth => ({
  authContext: {
    env: async (name: string): Promise<string | undefined> => {
      if (REF_NAME.test(name)) {
        const hit: unknown = await credentialsOf(ctx)?.resolve?.(name);
        if (hit !== undefined) {
          return isRecord(hit) && typeof hit.value === "string"
            ? hit.value
            : undefined;
        }
      }
      return readLaunchEnvironment(ctx).get(name)?.value;
    },
    fileExists: (): Promise<boolean> => Promise.resolve(false),
  },
  credentials: {
    delete: async (providerId: string): Promise<void> => {
      if (!KEY_SEGMENT.test(providerId)) {
        return;
      }
      await writable(ctx, libraries).deleteRecord?.(recordKeyFor(providerId));
    },
    list: async (): Promise<{ providerId: string; type: string }[]> => {
      const stored: unknown = await credentialsOf(ctx)?.listRecords?.();
      return (Array.isArray(stored) ? stored : []).flatMap((entry: unknown) => {
        if (!isRecord(entry) || typeof entry.key !== "string") {
          return [];
        }
        const slash = entry.key.indexOf("/");
        return entry.key.slice(0, slash) === RECORD_SCOPE
          ? [
              {
                providerId: entry.key.slice(slash + 1),
                type: entry.kind === "api-key" ? "api_key" : "oauth",
              },
            ]
          : [];
      });
    },
    modify: async (
      providerId: string,
      mutate: (current?: PiCredential) => Promise<PiCredential | undefined>
    ): Promise<PiCredential | undefined> => {
      if (!KEY_SEGMENT.test(providerId)) {
        throw hostError(
          libraries,
          `dsh-opencode-patch: provider id "${providerId}" cannot address a stored credential record; authenticate this route through apiKeyEnv instead`,
          "UNSTORABLE_PROVIDER_ID"
        );
      }
      const store = writable(ctx, libraries);
      return toPiCredential(
        await store.modifyRecord?.(
          recordKeyFor(providerId),
          async (current: unknown) => {
            const next = await mutate(toPiCredential(current));
            return next === undefined ? undefined : toRecord(next);
          }
        )
      );
    },
    read: async (providerId: string): Promise<PiCredential | undefined> => {
      const credentials = credentialsOf(ctx);
      if (credentials === undefined || !KEY_SEGMENT.test(providerId)) {
        return undefined;
      }
      return toPiCredential(
        await credentials.readRecord?.(recordKeyFor(providerId))
      );
    },
  },
});

/** The credentials service for a write, or the refusal pi-ai raises. */
const writable = (
  ctx: unknown,
  libraries: HostLibraries | undefined
): CredentialsLike => {
  const credentials = credentialsOf(ctx);
  if (credentials === undefined) {
    throw hostError(
      libraries,
      "dsh-opencode-patch: this composition mounts no credentials service, so there is nowhere to store the credential a sign-in produces",
      "NO_CREDENTIAL_STORE"
    );
  }
  return credentials;
};

/** The variable pi's own OpenCode auth reads, on both planes (`providers/opencode*.js`). */
const PI_OPENCODE_KEY_ENV = "OPENCODE_API_KEY";

/**
 * Whether pi's own lookup would authenticate the route: a stored record of any
 * kind owns the provider (`auth/resolve.js`), else `OPENCODE_API_KEY` through
 * the auth context.
 */
const piLookupAnswers = async (
  auth: PlaneAuth,
  provider: string
): Promise<boolean> => {
  if ((await auth.credentials.read(provider)) !== undefined) {
    return true;
  }
  const ambient = await auth.authContext.env(PI_OPENCODE_KEY_ENV);
  return ambient !== undefined && ambient.length > 0;
};

/**
 * The plane's key, by pi-ai's own rule (D20; `llm-pi-ai/src/index.ts:188-211`):
 *
 * - no reference named: pi's own lookup applies (`undefined`) — a stored
 *   Sign-in record for the route, then `OPENCODE_API_KEY` through the
 *   credentials service and the launch environment. Only when that lookup
 *   would find nothing, and the deployment opted in, does OpenCode's own store
 *   answer: the store is the LAST resort, so an explicit key here must never
 *   pre-empt pi's (pi lets the request's `apiKey` win over its own lookup);
 * - a named reference: the credentials service when one is mounted (a failure
 *   there propagates), the launch environment only without one;
 * - a miss: `MISSING_CREDENTIAL`, and no request is sent.
 *
 * A captured key or a literal one never answers here: those are the fetch
 * patch's fill for an empty wire key, not the adapter's credential.
 *
 * @param ctx - the plugin context.
 * @param modules - for the host's error and key helpers.
 * @param config - the plugin's settings (`readOpencodeStore`).
 * @param auth - pi's credential store and auth context, as the adapter hands
 *   them to pi; defaults to {@link planeAuth} over the same seams.
 */
export const planeApiKeyResolver =
  (
    ctx: unknown,
    modules: HostModules,
    config: Pick<ResolvedPluginConfig, "readOpencodeStore">,
    auth: PlaneAuth = planeAuth(
      ctx,
      modules.piAi.recordKeyFor,
      modules.libraries
    )
  ) =>
  async (
    provider: string,
    profile: PlaneProfileLike
  ): Promise<string | undefined> => {
    const ref = profile.apiKeyEnv;
    if (ref === undefined) {
      if (
        !config.readOpencodeStore ||
        (await piLookupAnswers(auth, provider))
      ) {
        return undefined;
      }
      return resolveOpencodeStoreKey(provider, config.readOpencodeStore);
    }
    const credentials = credentialsOf(ctx);
    let hit: string | undefined;
    if (credentials === undefined) {
      hit = readLaunchEnvironment(ctx).get(ref)?.value;
    } else {
      const resolved: unknown = await credentials.resolve?.(ref);
      hit =
        isRecord(resolved) && typeof resolved.value === "string"
          ? resolved.value
          : undefined;
    }
    if (hit !== undefined && hit.length > 0) {
      const { assertUsableApiKey } = modules.libraries;
      return assertUsableApiKey === undefined
        ? hit.trim()
        : assertUsableApiKey(hit, "dsh-opencode-patch", ref);
    }
    throw hostError(
      modules.libraries,
      `dsh-opencode-patch: no credential for provider route "${provider}"; its profile resolves ${ref}, which is not set — store ${ref} through the credentials service (the web Models page writes it) or export it, and remove apiKeyEnv only if this provider should authenticate from pi's own environment discovery`,
      "MISSING_CREDENTIAL"
    );
  };

/**
 * pi's provider for one plane: `createProvider` over all four protocols, each
 * wrapped with pi's own OpenCode session header, and pi's own OpenCode auth so
 * a profile naming no key keeps pi's ambient discovery. Google is wired on Go
 * too, which pi 1.1.0's own Go provider is not (F10), and serves the ids the
 * catalog describes by thinking level by level (`host/google-levels.ts`, D16).
 *
 * @param libraries - the host's pi.
 */
export const buildPlaneProvider =
  (libraries: HostLibraries): PlaneProviderBuilder =>
  ({ id, levelThinkingModels = new Set(), models, name }) =>
    libraries.createProvider({
      api: Object.fromEntries(
        PROTOCOLS.map((protocol) => {
          const api = libraries.apis[protocol]();
          return [
            protocol,
            libraries.withOpenCodeSessionHeader(
              protocol === "google-generative-ai"
                ? withCatalogThinkingLevels(
                    api,
                    levelThinkingModels,
                    libraries.googleLevels
                  )
                : api
            ),
          ];
        })
      ),
      auth:
        id === "opencode-go"
          ? libraries.opencodeGoAuth
          : libraries.opencodeAuth,
      id,
      models,
      name,
    });
