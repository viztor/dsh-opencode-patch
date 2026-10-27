/**
 * Shared by the `host-planes*` files: the plugin owning the plane routes, on
 * the real host. The wire recorder, the edits a settings surface derives, the
 * registry and profile readers, and the tier-B boot every case starts from.
 *
 * `wire` is the recorder the last {@link offline} installed; a case reads it,
 * and {@link disposeBooted} disposes every host {@link bootPlanes} booted.
 *
 * @module test/support/host-planes
 */
import { vi } from "vitest";

import {
  adaptersOf,
  type ApplyOrder,
  bootTierB,
  characterizedProviders,
  drainStream,
  fakeCredentials,
  type HostLlm,
  logLines,
  piAiRestarts,
  type PluginRow,
  recordingFetch,
  type RecordingFetch,
  type TierB,
} from "./host.ts";

/** The recorder the last {@link offline} installed. */
// oxlint-disable-next-line import/no-mutable-exports -- a live binding: each case reads the recorder its own `offline()` installed.
export let wire: RecordingFetch;

/** Hosts {@link bootPlanes} booted and the case has not disposed. */
const booted: TierB[] = [];

/** Dispose every host {@link bootPlanes} booted; each file's `afterEach` runs it. */
export const disposeBooted = async (): Promise<void> => {
  for (const tier of booted.splice(0)) {
    await tier.dispose();
  }
};

/** A fiber's state, read as a plain value. */
export const stateOf = (
  fiber: { readonly state: unknown } | undefined
): unknown => fiber?.state;

/** Stub `fetch` with a fresh recorder (before mounting the plugin). */
export const offline = (
  respond?: Parameters<typeof recordingFetch>[0]
): void => {
  wire = recordingFetch(respond);
  vi.stubGlobal("fetch", wire.fetch);
};

export type Providers = Record<string, Record<string, unknown>>;

/** An edit of one provider entry, the way a settings surface derives one. */
export const editProvider =
  (route: string, patch: Record<string, unknown>) =>
  (current: Record<string, unknown>): Record<string, unknown> => {
    const providers = { ...(current.providers as Providers) };
    providers[route] = { ...providers[route], ...patch };
    return { ...current, providers };
  };

/** An edit removing provider entries, the way a settings surface derives one. */
export const removeProviders =
  (...routes: string[]) =>
  (current: Record<string, unknown>): Record<string, unknown> => ({
    ...current,
    providers: Object.fromEntries(
      Object.entries(current.providers as Providers).filter(
        ([route]) => !routes.includes(route)
      )
    ),
  });

/** A config-editor mutation appending `id` to a plane's models. */
export const appendTo =
  (plane: string, id: string) => (current: Record<string, unknown>) => {
    const entry = (current.providers as Providers)[plane] as
      | { models?: { id: string }[] }
      | undefined;
    return editProvider(plane, {
      models: [...(entry?.models ?? []), { id }],
    })(current);
  };

export { routeIds } from "./host.ts";

/** The plane adapter's resolved profile for a route (its private `config`). */
export const planeProfile = (
  llm: HostLlm,
  route: string
): Record<string, unknown> => {
  const adapter = adaptersOf(llm).get(route)?.adapter as unknown as {
    config: { profiles: () => ReadonlyMap<string, Record<string, unknown>> };
  };
  const profile = adapter.config.profiles().get(route);
  if (profile === undefined) {
    throw new Error(`no plane profile for ${route}`);
  }
  return profile;
};

/** One turn's gateway requests, the catalog read excluded. */
export const turn = async (llm: HostLlm, route: string, model: string) => {
  const before = wire.requests.length;
  const drained = await drainStream(llm, route, model);
  return {
    drained,
    requests: wire.requests
      .slice(before)
      .filter(
        (request) => !request.url.startsWith("https://models.opencode.ai/")
      ),
  };
};

export const callConfigOf = async (
  llm: HostLlm,
  route: string,
  model: string
): Promise<string> => {
  try {
    await llm.resolveCallConfig({ model, provider: route } as never);
    return "ok";
  } catch (error) {
    return String((error as { code?: unknown }).code);
  }
};

/** Boot tier B with the characterization profile, counting pi-ai's restarts. */
export const bootPlanes = async (
  options: {
    readonly order?: ApplyOrder;
    readonly pluginRow?: PluginRow;
    readonly providers?: Providers;
  } = {}
): Promise<{
  tier: TierB;
  restarts: () => number;
  logged: () => string[];
}> => {
  offline();
  let restarts: ReturnType<typeof piAiRestarts> | undefined;
  let log: ReturnType<typeof logLines> | undefined;
  const tier = await bootTierB({
    credentials: fakeCredentials({
      refs: { OPENCODE_API_KEY: "zen-k", OPENCODE_GO_API_KEY: "go-k" },
    }),
    order: options.order ?? "plugin-first",
    ...(options.pluginRow === undefined
      ? {}
      : { pluginRow: options.pluginRow }),
    prepare: (root) => {
      restarts = piAiRestarts(root);
      log = logLines(root);
    },
    providers: options.providers ?? characterizedProviders(),
  });
  booted.push(tier);
  return {
    logged: () => log?.lines() ?? [],
    restarts: () => restarts?.count() ?? 0,
    tier,
  };
};

/** Let every queued microtask and timer of a settled host run. */
export const settle = async (): Promise<void> => {
  for (let index = 0; index < 10; index += 1) {
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
  }
};
