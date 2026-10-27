/**
 * The measurement probe the `e2e-host` job boots inside the real host.
 *
 * A bundle plugin with one job: once the published `dsh` binary has booted a
 * profile holding this plugin and `dsh-opencode-patch`, ask the host what it
 * now serves — the registry, the listings, the validation verdicts, where one
 * turn per model is sent, what the settings page reads, and whether a
 * catalog-unknown id can be saved — write that as JSON to `PROBE_OUT`, and exit
 * the process. `test/e2e/host-binary.e2e.ts` reads the file.
 *
 * It never reaches the network: `fetch` is replaced at module load, so every
 * request to `opencode.ai` or `models.opencode.ai` is recorded (URL, model and
 * a Google body's `generationConfig.thinkingConfig` only — never a header, so
 * never a key) and answered with a 401, and every other host passes through
 * untouched. What it writes is URLs, model ids, thinking configs, verdicts and
 * host error messages — never a header or a key value — and
 * every error message is cut to {@link MESSAGE_LIMIT} characters, since one
 * could name a path on the runner.
 *
 * Inputs, all from the environment the e2e sets:
 *
 * - `PROBE_OUT`: where to write the JSON;
 * - `PROBE_MODELS`: `{ "<route>": ["<model id>", …] }`, the ids to ask about;
 * - `PROBE_SAVE`: an id to append to `opencode`'s models through the config
 *   editor, the way the Settings page saves one. It is tried onto the plane as
 *   booted (`saveBlocked`); only if that is refused are the ids in
 *   `PROBE_SAVE_DROP` removed (`saveCleared`) and the id tried once more
 *   (`save`), so the last answer is about the id itself;
 * - `PROBE_SAVE_DROP`: `["<model id>", …]`, the ids to remove on a refusal;
 * - `PROBE_PLANES`: `["<route>", …]`, the plane routes to wait for until an
 *   adapter other than pi-ai's serves each (the plugin's own);
 * - `PROBE_PI_PACKAGE`: the package name pi-ai's loader entry carries;
 * - `PROBE_HOST_PREFIX`: the host's install prefix. The probe records which pi
 *   the plugin's plane provider was built from RELATIVE to it, so the JSON
 *   never holds an absolute path, and says whether it is inside it at all;
 * - `PROBE_SETTLE_MS`: how long to wait for the planes (default 30000).
 *
 * @module test/e2e/host/probe-plugin
 */
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { isAbsolute, relative, sep } from "node:path";

export const name = "dsh-host-probe";

const OUT = process.env.PROBE_OUT;
const SETTLE_MS = Number(process.env.PROBE_SETTLE_MS ?? "30000");
const GATEWAY_HOSTS = new Set(["opencode.ai", "models.opencode.ai"]);
/** The plane routes the plugin owns. */
const PLANES = JSON.parse(process.env.PROBE_PLANES ?? "[]");
const PI_AI_PACKAGE = process.env.PROBE_PI_PACKAGE ?? "";
/** The longest error message written: enough to triage, too short for a dump. */
const MESSAGE_LIMIT = 500;

const HOST_PREFIX = process.env.PROBE_HOST_PREFIX ?? "";

/**
 * Where the plane provider's pi came from, relative to the host prefix: the
 * plane adapter's class carries the root and version it was built from. A
 * root outside the prefix is reported as such, never as a path.
 */
const piLoadedFrom = (adapter) => {
  const hostPi = adapter?.constructor?.hostPi;
  if (hostPi === undefined || typeof hostPi.root !== "string") {
    return null;
  }
  let path;
  try {
    path = relative(realpathSync(HOST_PREFIX), realpathSync(hostPi.root));
  } catch {
    path = "..";
  }
  const inside = path.length > 0 && !path.startsWith("..") && !isAbsolute(path);
  return {
    fromHostPrefix: inside,
    path: inside ? path.split(sep).join("/") : null,
    version: hostPi.version,
  };
};

/** An error's message, cut to {@link MESSAGE_LIMIT}. */
const messageOf = (error) =>
  String(error?.message ?? error).slice(0, MESSAGE_LIMIT);

/** A service the measurement needs, or a named failure where it is missing. */
const required = (ctx, service) => {
  const value = ctx.get(service);
  if (value === undefined) {
    throw new Error(`probe: no ${service} service in this host`);
  }
  return value;
};

const requests = [];
const passThrough = globalThis.fetch;

const urlOf = (input) => {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.href : input.url;
};

const hostOf = (url) => {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
};

/** A request's JSON body, or `null` where it has none. */
const bodyOf = async (input, init) => {
  let body = init?.body;
  if (body === undefined && input instanceof Request) {
    body = await input.clone().text();
  }
  try {
    return JSON.parse(String(body));
  } catch {
    return null;
  }
};

/**
 * What one gateway request is recorded as: its URL, the model its body names,
 * and — on the Google protocol, whose body names no model — the thinking
 * config the body carries (the D16 wire: a level, or pi's budget).
 */
const recordOf = async (input, init, url) => {
  const body = await bodyOf(input, init);
  const model = typeof body?.model === "string" ? body.model : null;
  const thinkingConfig = body?.generationConfig?.thinkingConfig;
  return thinkingConfig === undefined
    ? { model, url }
    : { model, thinkingConfig, url };
};

const probeFetch = async (input, init) => {
  const url = urlOf(input);
  if (!GATEWAY_HOSTS.has(hostOf(url))) {
    return passThrough(input, init);
  }
  requests.push(await recordOf(input, init, url));
  return Response.json(
    { error: { message: "probe: offline", type: "AuthError" } },
    { status: 401 }
  );
};
// Installed at module load, which the host runs before any plugin's `apply`
// that needs a service: the plugin's fetch patch then wraps THIS function, so
// the probe sees the request the patch actually sends.
globalThis.fetch = probeFetch;

/** A call's answer, or its failure as `{ code, message }`. */
const settle = async (run) => {
  try {
    return { ok: await run() };
  } catch (error) {
    return {
      error: {
        code: typeof error?.code === "string" ? error.code : undefined,
        message: messageOf(error),
      },
    };
  }
};

const sleep = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** Drain one turn through the host's own stream path. */
const turn = async (llm, provider, model) => {
  const before = requests.length;
  let finish;
  const drained = await settle(async () => {
    for await (const chunk of llm.stream({
      messages: [{ content: [{ text: "hi", type: "text" }], role: "user" }],
      model,
      provider,
      signal: AbortSignal.timeout(15_000),
    })) {
      if (chunk.type === "finish") {
        finish = chunk.reason?.failure?.code ?? chunk.reason?.kind;
      }
    }
  });
  return {
    finish,
    sent: requests
      .slice(before)
      .map((request) => request.url)
      .filter((url) => hostOf(url) === "opencode.ai"),
    ...(drained.error === undefined ? {} : { error: drained.error }),
  };
};

/** Every id in `PROBE_MODELS` asked three questions: listing, info, verdict. */
const askAbout = async (llm, ids) => {
  const listModels = {};
  const modelInfo = {};
  const callConfig = {};
  for (const [route, models] of Object.entries(ids)) {
    const listed = await settle(() => llm.listModels(route));
    listModels[route] = listed.ok?.map((model) => model.id) ?? listed;
    for (const model of models) {
      const info = await settle(() => llm.resolveModelInfo(route, model));
      modelInfo[`${route}/${model}`] = info.ok
        ? {
            context: info.ok.context?.contextWindow,
            efforts:
              info.ok.reasoning?.efforts?.map((effort) => effort.id) ?? [],
          }
        : { error: info.error.code };
      const call = await settle(() =>
        llm.resolveCallConfig({ model, provider: route })
      );
      callConfig[`${route}/${model}`] = call.ok ? "ok" : call.error.code;
    }
  }
  return { callConfig, listModels, modelInfo };
};

/** One config-editor edit of `opencode`, as the Settings page makes it. */
const editZen = async (editor, entry, mutate) => {
  const saved = await settle(() =>
    editor.edit(entry, (current) => {
      const providers = { ...current.providers };
      providers.opencode = mutate(providers.opencode ?? {});
      return { ...current, providers };
    })
  );
  return saved.error === undefined
    ? { accepted: true }
    : { rejected: saved.error.message };
};

/**
 * Save `saveId` into `opencode`'s models: onto the plane as booted, then onto
 * the plane without the `drop` ids, so the last verdict is about `saveId`.
 */
const saveSequence = async (llm, editor, saveId, drop) => {
  const entry = editor
    .entries()
    .find((candidate) => candidate.options?.name === PI_AI_PACKAGE);
  const append = (plane) => ({
    ...plane,
    models: [...(plane.models ?? []), { id: saveId }],
  });
  const blocked = await editZen(editor, entry, append);
  const document = editor.documentPath;
  let out = { saveBlocked: { id: saveId, ...blocked } };
  let saved = blocked;
  if (blocked.rejected !== undefined) {
    const cleared = await editZen(editor, entry, (plane) => ({
      ...plane,
      models: (plane.models ?? []).filter((model) => !drop.includes(model.id)),
    }));
    saved = await editZen(editor, entry, append);
    out = { ...out, saveCleared: { dropped: drop, ...cleared } };
  }
  out = { ...out, save: { id: saveId, ...saved } };
  if (saved.rejected !== undefined) {
    return out;
  }
  const listed = await settle(() => llm.listModels("opencode"));
  const call = await settle(() =>
    llm.resolveCallConfig({ model: saveId, provider: "opencode" })
  );
  let savedInFile;
  try {
    savedInFile = readFileSync(document, "utf8").includes(saveId);
  } catch {
    savedInFile = false;
  }
  return {
    ...out,
    savedInFile,
    afterSave: {
      callConfig: call.error?.code ?? "ok",
      dispatch: await turn(llm, "opencode", saveId),
      listed: listed.ok?.map((model) => model.id) ?? listed,
    },
  };
};

const measure = async (ctx) => {
  if (PLANES.length === 0 || PI_AI_PACKAGE.length === 0) {
    throw new Error("probe: PROBE_PLANES and PROBE_PI_PACKAGE must be set");
  }
  await ctx.get("loader")?.await?.();
  const llm = required(ctx, "llm");
  const registry = () => llm.adapters;
  /** Whether the plugin's adapter, not pi-ai's, serves a plane. */
  const claimed = (route) => {
    const owner = registry().get(route)?.adapter?.constructor.name;
    return owner !== undefined && owner !== "PiAiAdapter";
  };
  const until = Date.now() + SETTLE_MS;
  while (!PLANES.every(claimed) && Date.now() < until) {
    await sleep(100);
  }
  const ids = JSON.parse(process.env.PROBE_MODELS ?? "{}");
  const registered = {
    configurable: llm
      .listConfigurableProviders()
      .filter((entry) => /opencode/u.test(entry.provider))
      .map((entry) => ({
        provider: entry.provider,
        settingsNs: entry.settingsNs,
        settingsPath: entry.settingsPath,
        ...(entry.error === undefined ? {} : { error: messageOf(entry.error) }),
      })),
    fetchInnermost: globalThis.fetch !== probeFetch,
    owners: Object.fromEntries(
      [...registry()].map(([route, row]) => [
        route,
        row.adapter.constructor.name,
      ])
    ),
    piLoaded: piLoadedFrom(registry().get(PLANES[0])?.adapter),
    planesSettled: PLANES.every(claimed),
    providers: llm.listProviders().map((provider) => provider.id),
    registryRoutes: [...registry().keys()],
  };
  const asked = await askAbout(llm, ids);
  const zenNs = registered.configurable.find(
    (entry) => entry.provider === "opencode"
  )?.settingsNs;
  const discovered = await settle(() =>
    llm.discoverModels(zenNs, { provider: "opencode" })
  );
  const dispatch = {};
  const thinking = {};
  for (const [route, models] of Object.entries(ids)) {
    for (const model of models) {
      const before = requests.length;
      dispatch[`${route}/${model}`] = await turn(llm, route, model);
      const sent = requests
        .slice(before)
        .filter((request) => request.thinkingConfig !== undefined)
        .map((request) => request.thinkingConfig);
      if (sent.length > 0) {
        thinking[`${route}/${model}`] = sent;
      }
    }
  }
  const listModelsAfter = {};
  for (const route of Object.keys(ids)) {
    const listed = await settle(() => llm.listModels(route));
    listModelsAfter[route] = listed.ok?.map((model) => model.id) ?? listed;
  }
  const settings = required(ctx, "settings");
  const piDescriptor = settings
    .describe()
    .find((descriptor) => descriptor.ns === "llm-pi-ai");
  // What Settings reads per plane: the profile's apiKeyEnv and model ids
  // (`describeEntries`), and the Models page's join (`modelsJoin`) — the
  // directory entry looked up in the redacted describe at its settingsPath.
  const describeEntries = {};
  for (const plane of PLANES) {
    const entry = piDescriptor?.value?.providers?.[plane];
    describeEntries[plane] =
      entry === undefined
        ? null
        : {
            apiKeyEnv: entry.apiKeyEnv,
            models: (entry.models ?? []).map((model) => model.id),
          };
  }
  const redacted = settings.describe({ redactSecrets: true });
  const modelsJoin = {};
  for (const entry of llm.listConfigurableProviders()) {
    if (!PLANES.includes(entry.provider)) continue;
    const view = redacted.find(
      (namespace) => namespace.ns === entry.settingsNs
    );
    let profile = view?.value;
    for (const key of entry.settingsPath) {
      profile =
        typeof profile === "object" && profile !== null
          ? profile[key]
          : undefined;
    }
    const ref =
      typeof profile === "object" && profile !== null
        ? profile.apiKeyEnv
        : undefined;
    modelsJoin[entry.provider] = {
      apiKeyEnv: typeof ref === "string" && ref.length > 0 ? ref : undefined,
      configured:
        view !== undefined &&
        (entry.settingsPath.length === 0 || profile !== undefined),
    };
  }
  const editor = required(ctx, "configEditor");
  const saveId = process.env.PROBE_SAVE ?? "";
  const drop = JSON.parse(process.env.PROBE_SAVE_DROP ?? "[]");
  const saving =
    saveId.length === 0 ? {} : await saveSequence(llm, editor, saveId, drop);
  return {
    ...registered,
    ...asked,
    ...saving,
    describe:
      piDescriptor === undefined
        ? undefined
        : {
            user: Object.keys(piDescriptor.user?.providers ?? {}),
            value: Object.keys(piDescriptor.value?.providers ?? {}),
          },
    describeEntries,
    discovery: discovered.ok ? { count: discovered.ok.length } : discovered,
    dispatch,
    modelsJoin,
    listModelsAfter,
    thinking,
  };
};

export const apply = (ctx) => {
  let stopped = false;
  ctx.effect?.(() => () => {
    stopped = true;
  });
  // Not awaited: `apply` returns at once, and the measurement runs once the
  // loader has settled every row.
  void (async () => {
    try {
      const out = await measure(ctx);
      if (stopped) return;
      writeFileSync(OUT, `${JSON.stringify(out, null, 2)}\n`);
      setTimeout(() => process.exit(0), 200);
    } catch (error) {
      const fatal = messageOf(error);
      // On stderr too: the e2e shows the tail when the host exits non-zero.
      process.stderr.write(`[dsh-host-probe] fatal: ${fatal}\n`);
      writeFileSync(OUT, `${JSON.stringify({ fatal })}\n`);
      setTimeout(() => process.exit(1), 200);
    }
  })();
};
