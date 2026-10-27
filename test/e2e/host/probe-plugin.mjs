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
 * request to `opencode.ai` or `models.opencode.ai` is recorded (URL and model
 * only — never a header, so never a key) and answered with a 401, and every
 * other host passes through untouched. What it writes is URLs, model ids,
 * verdicts and host error messages — never a header or a key value — and
 * every error message is cut to {@link MESSAGE_LIMIT} characters, since one
 * could name a path on the runner.
 *
 * Inputs, all from the environment the e2e sets:
 *
 * - `PROBE_OUT`: where to write the JSON;
 * - `PROBE_MODELS`: `{ "<route>": ["<model id>", …] }`, the ids to ask about;
 * - `PROBE_SAVE`: an id to append to `opencode`'s models through the config
 *   editor, the way the Settings page saves one. It is tried three times over:
 *   onto the plane as booted (`saveBlocked`), then — after the ids in
 *   `PROBE_SAVE_DROP` are removed from the plane (`saveCleared`) — once more
 *   (`save`), so the last answer is about the id itself and not about a gap id
 *   the plane already stores;
 * - `PROBE_SAVE_DROP`: `["<model id>", …]`, the ids to remove first;
 * - `PROBE_ROUTES`: `["<route>", …]`, the hidden routes to wait for, which the
 *   e2e passes from `INTERNAL_ROUTES` so the probe holds no copy of them;
 * - `PROBE_PI_PACKAGE`: the package name pi-ai's loader entry carries;
 * - `PROBE_SETTLE_MS`: how long to wait for the plugin's hidden routes
 *   (default 30000).
 *
 * @module test/e2e/host/probe-plugin
 */
import { writeFileSync } from "node:fs";

export const name = "dsh-host-probe";

const OUT = process.env.PROBE_OUT;
const SETTLE_MS = Number(process.env.PROBE_SETTLE_MS ?? "30000");
const GATEWAY_HOSTS = new Set(["opencode.ai", "models.opencode.ai"]);
/** The routes today's plugin mounts behind the planes. */
const HIDDEN_ROUTES = JSON.parse(process.env.PROBE_ROUTES ?? "[]");
const PI_AI_PACKAGE = process.env.PROBE_PI_PACKAGE ?? "";
/** The longest error message written: enough to triage, too short for a dump. */
const MESSAGE_LIMIT = 500;

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

const modelOf = async (input, init) => {
  let body = init?.body;
  if (body === undefined && input instanceof Request) {
    body = await input.clone().text();
  }
  try {
    const { model } = JSON.parse(String(body));
    return typeof model === "string" ? model : null;
  } catch {
    return null;
  }
};

const probeFetch = async (input, init) => {
  const url = urlOf(input);
  if (!GATEWAY_HOSTS.has(hostOf(url))) {
    return passThrough(input, init);
  }
  requests.push({ model: await modelOf(input, init), url });
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
  return {
    ...out,
    afterSave: {
      callConfig: call.error?.code ?? "ok",
      dispatch: await turn(llm, "opencode", saveId),
      listed: listed.ok?.map((model) => model.id) ?? listed,
    },
  };
};

const measure = async (ctx) => {
  if (HIDDEN_ROUTES.length === 0 || PI_AI_PACKAGE.length === 0) {
    throw new Error("probe: PROBE_ROUTES and PROBE_PI_PACKAGE must be set");
  }
  await ctx.get("loader")?.await?.();
  const llm = required(ctx, "llm");
  const registry = () => llm.adapters;
  const until = Date.now() + SETTLE_MS;
  while (
    HIDDEN_ROUTES.some((route) => !registry().has(route)) &&
    Date.now() < until
  ) {
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
      })),
    fetchInnermost: globalThis.fetch !== probeFetch,
    owners: Object.fromEntries(
      [...registry()].map(([route, row]) => [
        route,
        row.adapter.constructor.name,
      ])
    ),
    // Whether the plugin's adapter decoration (decoratePlaneAdapters in
    // src/models-discovery.ts) wrapped pi-ai's plane adapter. It wraps only
    // the adapters registered when its effect ran, so the apply order is
    // INFERRED from it (`inferredOrder`) — not observed: a pi-ai restart after
    // the plugin applied would read as plugin-first. The per-model rows depend
    // on the decoration, not on the order as such, so this is what they need.
    planeAdapterDecorated: Object.hasOwn(
      registry().get("opencode")?.adapter ?? {},
      "resolveModel"
    ),
    providers: llm.listProviders().map((provider) => provider.id),
    registryRoutes: [...registry().keys()],
    routesSettled: HIDDEN_ROUTES.every((route) => registry().has(route)),
  };
  registered.inferredOrder = registered.planeAdapterDecorated
    ? "pi-ai-first"
    : "plugin-first";
  const asked = await askAbout(llm, ids);
  const zenNs = registered.configurable.find(
    (entry) => entry.provider === "opencode"
  )?.settingsNs;
  const discovered = await settle(() =>
    llm.discoverModels(zenNs, { provider: "opencode" })
  );
  const dispatch = {};
  for (const [route, models] of Object.entries(ids)) {
    for (const model of models) {
      dispatch[`${route}/${model}`] = await turn(llm, route, model);
    }
  }
  const listModelsAfter = {};
  for (const route of Object.keys(ids)) {
    const listed = await settle(() => llm.listModels(route));
    listModelsAfter[route] = listed.ok?.map((model) => model.id) ?? listed;
  }
  const piDescriptor = required(ctx, "settings")
    .describe()
    .find((descriptor) => descriptor.ns === "llm-pi-ai");
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
    discovery: discovered.ok ? { count: discovered.ok.length } : discovered,
    dispatch,
    listModelsAfter,
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
