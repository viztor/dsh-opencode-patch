/**
 * The default way the plugin reaches the host's own modules: pi-ai's (for
 * `PiAiAdapter`, `Config` and `recordKeyFor`), and the libraries pi-ai itself
 * runs on — pi, dsh-llm and the loader.
 *
 * None of them is a dependency of this package, on purpose: declaring one puts
 * a second copy in the tree and turns every host bump into a version-skew bug.
 * So each is asked of the host. pi-ai's module comes from pi-ai's own loader
 * entry (the loader keeps the raw import on it before the first config run),
 * and the libraries from the dependency tree of the wrapper the loader
 * resolves from the context's base URL, which is where the copy pi-ai runs on
 * lives — never from this plugin's own install, which under a `link:` is a
 * checkout with its own development copies.
 *
 * `cordis-context.ts` holds the seam: {@link defaultHostModuleSource} is what
 * it uses unless the harness replaced it. Every export check is narrowed; a
 * module that moved an export answers `undefined` here, never a throw.
 *
 * @module dsh-opencode-patch/host/host-modules
 */

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import type {
  HostLibraries,
  HostModuleSource,
  PiAiModule,
} from "../cordis-context.ts";
import { isFunctionLike, isRecord } from "../utils/guards.ts";
import type { PlaneRoute, Protocol } from "../utils/protocols.ts";

/** The host plugin this module reads. */
const PI_AI_PACKAGE = "@deepseek-ai/dsh-llm-pi-ai";

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
  // Guarded, because THIS read throws: cordis answers
  // `cannot get property "loader" without inject` for an undeclared name, and
  // this plugin declares no service at its root. An unguarded read here failed
  // the whole mount, not just the lookup.
  try {
    const { loader: direct } = ctx as { loader?: unknown };
    if (isRecord(direct) && isFunctionLike(direct.entries)) {
      return direct;
    }
  } catch {
    // Not injected: the `ctx.get` path below is the one that works.
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
 * The loader entry the composition loaded the host plugin under.
 *
 * @param ctx - host context carrying the loader.
 * @returns the entry, or `undefined` when no entry names the package.
 */
const piAiEntry = (ctx: unknown): Record<string, unknown> | undefined => {
  const entry = loaderEntries(ctx).find(
    (candidate) =>
      isRecord(candidate) &&
      isRecord(candidate.options) &&
      candidate.options.name === PI_AI_PACKAGE
  );
  return isRecord(entry) ? entry : undefined;
};

/**
 * The raw module namespace, for a loader entry that kept none.
 *
 * The plane adapter extends the wrapper's own `PiAiAdapter`, and the class
 * lives on the module namespace — which one loader generation keeps on its
 * entry and the other drops entirely, keeping only the fiber. The registry's
 * runtime record does not keep it either: it holds
 * `{ name, callback, fibers, Config }` and nothing else.
 *
 * The module is still reachable, because it is the SAME module: the loader
 * resolved the entry's own name against the context's base URL, so resolving
 * that name from the same base reaches the same file, and Node's module cache
 * hands back the namespace the loader already executed. Nothing is imported
 * twice and nothing is guessed from a package-manager layout.
 *
 * @param ctx - host context carrying the loader and its base URL.
 * @returns the namespace, or `undefined` when no entry names the package or
 *   the module cannot be resolved from the base URL.
 */
export const loadPiAiModule = async (
  ctx: unknown
): Promise<Record<string, unknown> | undefined> => {
  if (piAiEntry(ctx) === undefined) {
    return undefined;
  }
  const base = isRecord(ctx) ? ctx.baseUrl : undefined;
  if (typeof base !== "string" || base.length === 0) {
    return undefined;
  }
  try {
    // The base URL is the directory the loader resolves bare specifiers
    // against, so the sibling file only anchors `createRequire` to that
    // directory; it is never read.
    const resolve = createRequire(new URL("noop.js", base));
    const namespace: unknown = await import(
      pathToFileURL(resolve.resolve(PI_AI_PACKAGE)).href
    );
    return isRecord(namespace) ? namespace : undefined;
  } catch {
    return undefined;
  }
};

/** The wrapper whose own dependency tree names the pi the host installed. */
const WRAPPER_PACKAGE = "@deepseek-ai/dsh-llm-pi-ai";

/** The pi installation's identity, as the host-version pin reads it. */
export interface HostPi {
  /** pi's own installed catalog, per provider id, exactly as pi exports it. */
  getBuiltinModels: (provider: string) => readonly { id: string }[];
  /** The version string of the copy that was loaded. */
  version: string;
  /** The package root it was loaded from. */
  root: string;
}

/**
 * The wrapper's entry file, resolved the way the host's loader resolved it.
 *
 * The loader resolves pi-ai's row against the context's base URL (the
 * profile's directory), and the host's resolution interception answers a bare
 * request from there with the INSTALLATION's copy — the one the host runs. So
 * resolving the wrapper from that same base reaches the host's copy, whether
 * this plugin was installed into the profile or linked from a checkout: a
 * linked checkout's own tree is never consulted. Only a context with no base
 * URL, or one the wrapper cannot be resolved from (a bare cordis context in a
 * test), falls back to resolving from this module's own location.
 *
 * @param ctx - the plugin context, whose `baseUrl` the loader set.
 * @returns the entry's real path, or `undefined` when neither resolves.
 */
export const wrapperEntryFor = (ctx: unknown): string | undefined => {
  let base: unknown;
  try {
    base = isRecord(ctx) ? ctx.baseUrl : undefined;
  } catch {
    base = undefined;
  }
  if (typeof base === "string" && base.length > 0) {
    try {
      // The sibling file only anchors `createRequire` to the base directory;
      // it is never read.
      return realpathSync(
        createRequire(new URL("noop.js", base)).resolve(WRAPPER_PACKAGE)
      );
    } catch {
      // Not resolvable from the base: the plugin's own location below.
    }
  }
  try {
    // `import.meta.resolve` honours the wrapper's `import`/`default`
    // conditions, which is what an ESM-only package declares.
    return realpathSync(fileURLToPath(import.meta.resolve(WRAPPER_PACKAGE)));
  } catch {
    return undefined;
  }
};

/**
 * Where one of the wrapper's own dependencies lives, found by walking node's
 * lookup from the WRAPPER's own directory.
 *
 * The wrapper declares pi as a dependency and dsh-llm and the loader as peers,
 * so the copy node would hand IT is the copy every other consumer in that tree
 * gets — which is the whole point: one instance, one version. The walk is
 * explicit because pnpm's layout is not a plain `node_modules` beside the
 * package: the wrapper's dependencies live in the `.pnpm` hosting directory
 * above it (or in a hoisted store beside it), and under a `link:` or `file:`
 * install they live somewhere else again. Walking the parent chain and testing
 * for the package is the one rule that covers all of them without encoding a
 * package-manager layout.
 *
 * @param wrapperEntry - the wrapper's entry file ({@link wrapperEntryFor}).
 * @param scope - the package scope, `@earendil-works`.
 * @param name - the package name within it, `pi-ai`.
 * @returns the package ROOT, or `undefined` when the wrapper's tree carries
 *   no such package.
 */
const installedPackageRoot = (
  wrapperEntry: string,
  scope: string,
  name: string
): string | undefined => {
  let dir = path.dirname(wrapperEntry);
  // The entry is `<wrapper>/lib/index.js`; its `node_modules` walk starts at the
  // package root, which the hosting directory above it also covers, so walking
  // up from the entry's own directory reaches the same install either way.
  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = path.join(dir, "node_modules", scope, name);
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

/** The pi modules the plane provider is composed from, relative to pi's root. */
const PI_MODULES = {
  all: "dist/providers/all.js",
  anthropic: "dist/api/anthropic-messages.lazy.js",
  completions: "dist/api/openai-completions.lazy.js",
  go: "dist/providers/opencode-go.js",
  google: "dist/api/google-generative-ai.lazy.js",
  headers: "dist/providers/opencode-headers.js",
  models: "dist/models.js",
  responses: "dist/api/openai-responses.lazy.js",
  zen: "dist/providers/opencode.js",
} as const;

/** A package's ESM entry file, read from its manifest. */
const entryFileOf = (root: string): string | undefined => {
  try {
    const manifest: unknown = JSON.parse(
      readFileSync(path.join(root, "package.json"), "utf-8")
    );
    if (!isRecord(manifest)) {
      return undefined;
    }
    const { exports, main } = manifest;
    const dot: unknown = isRecord(exports) ? exports["."] : exports;
    const target: unknown = isRecord(dot) ? (dot.import ?? dot.default) : dot;
    const file = typeof target === "string" ? target : main;
    return typeof file === "string" ? path.join(root, file) : undefined;
  } catch {
    return undefined;
  }
};

/** Import a module by file path, answering `undefined` for anything but a record. */
const importRecord = async (
  file: string | undefined
): Promise<Record<string, unknown> | undefined> => {
  if (file === undefined) {
    return undefined;
  }
  try {
    const namespace: unknown = await import(pathToFileURL(file).href);
    return isRecord(namespace) ? namespace : undefined;
  } catch {
    return undefined;
  }
};

/** A function export of a module, or `undefined`. */
const fn = (
  namespace: Record<string, unknown> | undefined,
  key: string
): ((...args: never[]) => unknown) | undefined => {
  const value = namespace?.[key];
  return isFunctionLike(value) ? value : undefined;
};

/** A provider factory's `auth`, read off a fresh provider. */
const authOf = (
  factory: ((...args: never[]) => unknown) | undefined
): unknown => {
  try {
    const provider: unknown = factory?.();
    return isRecord(provider) ? provider.auth : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Load the libraries: pi's provider pieces, dsh-llm's error and retry helpers,
 * and the loader's `interpolate`, each from the given wrapper's own tree.
 *
 * @param wrapperEntry - the wrapper's entry file ({@link wrapperEntryFor}).
 * @returns the libraries, or `undefined` when there is no wrapper, or pi or
 *   dsh-llm cannot be read from its tree.
 */
export const loadLibrariesFrom = async (
  wrapperEntry?: string
): Promise<HostLibraries | undefined> => {
  if (wrapperEntry === undefined) {
    return undefined;
  }
  const piRoot = installedPackageRoot(wrapperEntry, "@earendil-works", "pi-ai");
  const llmRoot = installedPackageRoot(wrapperEntry, "@deepseek-ai", "dsh-llm");
  if (piRoot === undefined || llmRoot === undefined) {
    return undefined;
  }
  const loaderRoot = installedPackageRoot(
    wrapperEntry,
    "@deepseek-ai",
    "cordis-plugin-loader"
  );
  const piFile = (key: keyof typeof PI_MODULES): string =>
    path.join(piRoot, PI_MODULES[key]);
  const [
    all,
    anthropic,
    completions,
    go,
    google,
    headers,
    models,
    responses,
    zen,
    llm,
    loader,
  ] = await Promise.all([
    importRecord(piFile("all")),
    importRecord(piFile("anthropic")),
    importRecord(piFile("completions")),
    importRecord(piFile("go")),
    importRecord(piFile("google")),
    importRecord(piFile("headers")),
    importRecord(piFile("models")),
    importRecord(piFile("responses")),
    importRecord(piFile("zen")),
    importRecord(entryFileOf(llmRoot)),
    importRecord(
      loaderRoot === undefined ? undefined : entryFileOf(loaderRoot)
    ),
  ]);
  const apis: Partial<Record<Protocol, (...args: never[]) => unknown>> = {
    "anthropic-messages": fn(anthropic, "anthropicMessagesApi"),
    "google-generative-ai": fn(google, "googleGenerativeAIApi"),
    "openai-completions": fn(completions, "openAICompletionsApi"),
    "openai-responses": fn(responses, "openAIResponsesApi"),
  };
  const createProvider = fn(models, "createProvider");
  const withSessionHeader = fn(headers, "withOpenCodeSessionHeader");
  const getBuiltinModels = fn(all, "getBuiltinModels");
  const resolveRetryPolicy = fn(llm, "resolveRetryPolicy");
  const opencodeAuth = authOf(fn(zen, "opencodeProvider"));
  const opencodeGoAuth = authOf(fn(go, "opencodeGoProvider"));
  if (
    createProvider === undefined ||
    withSessionHeader === undefined ||
    getBuiltinModels === undefined ||
    resolveRetryPolicy === undefined ||
    opencodeAuth === undefined ||
    opencodeGoAuth === undefined ||
    Object.values(apis).some((factory) => factory === undefined)
  ) {
    return undefined;
  }
  const LlmError = llm?.LlmError;
  const assertUsableApiKey = fn(llm, "assertUsableApiKey");
  const interpolate = fn(loader, "interpolate");
  let version = "";
  try {
    const manifest: unknown = JSON.parse(
      readFileSync(path.join(piRoot, "package.json"), "utf-8")
    );
    version =
      isRecord(manifest) && typeof manifest.version === "string"
        ? manifest.version
        : "";
  } catch {
    version = "";
  }
  // pi's own signatures, as this module consumes them; the export checks
  // above are the runtime guard these casts stand in for.
  /* oxlint-disable typescript/no-unsafe-type-assertion */
  return {
    apis: apis as HostLibraries["apis"],
    builtinModels: (route: PlaneRoute) =>
      (getBuiltinModels as (id: string) => unknown)(route) as ReturnType<
        HostLibraries["builtinModels"]
      >,
    createProvider: createProvider as HostLibraries["createProvider"],
    opencodeAuth,
    opencodeGoAuth,
    resolveRetryPolicy:
      resolveRetryPolicy as HostLibraries["resolveRetryPolicy"],
    root: piRoot,
    version,
    withOpenCodeSessionHeader:
      withSessionHeader as HostLibraries["withOpenCodeSessionHeader"],
    ...(isFunctionLike(LlmError)
      ? { LlmError: LlmError as unknown as HostLibraries["LlmError"] }
      : {}),
    ...(assertUsableApiKey === undefined
      ? {}
      : {
          assertUsableApiKey:
            assertUsableApiKey as HostLibraries["assertUsableApiKey"],
        }),
    ...(interpolate === undefined
      ? {}
      : { interpolate: interpolate as HostLibraries["interpolate"] }),
  };
  /* oxlint-enable typescript/no-unsafe-type-assertion */
};

/**
 * The pi the HOST installed: its version, its root and its own
 * `getBuiltinModels`.
 *
 * It walks to pi exactly as {@link loadLibrariesFrom} does, so the version pin
 * in `test/host-versions.test.ts` reads the copy the plane provider is built
 * from, and the function's identity proves there is one module instance.
 *
 * @param ctx - the plugin context, whose base URL the wrapper resolves from.
 * @returns the identity, or `undefined` when the host's pi is not reachable.
 */
export const loadHostPi = async (
  ctx?: unknown
): Promise<HostPi | undefined> => {
  const wrapper = wrapperEntryFor(ctx);
  const root =
    wrapper === undefined
      ? undefined
      : installedPackageRoot(wrapper, "@earendil-works", "pi-ai");
  if (root === undefined) {
    return undefined;
  }
  try {
    const manifest = readFileSync(path.join(root, "package.json"), "utf-8");
    const providers = await importRecord(path.join(root, PI_MODULES.all));
    const getBuiltinModels = fn(providers, "getBuiltinModels");
    if (getBuiltinModels === undefined) {
      return undefined;
    }
    const manifestData: unknown = JSON.parse(manifest);
    return {
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- pi's own signature; the export check above is the runtime guard.
      getBuiltinModels: getBuiltinModels as HostPi["getBuiltinModels"],
      root,
      version:
        isRecord(manifestData) && typeof manifestData.version === "string"
          ? manifestData.version
          : "",
    };
  } catch {
    return undefined;
  }
};

/** The libraries, loaded once per wrapper install for the life of the process. */
const librariesByWrapper = new Map<
  string,
  Promise<HostLibraries | undefined>
>();

/** A record carrying pi-ai's three exports, or `undefined`. */
export const asPiAiModule = (value: unknown): PiAiModule | undefined =>
  isRecord(value) &&
  isFunctionLike(value.PiAiAdapter) &&
  isFunctionLike(value.Config) &&
  isFunctionLike(value.recordKeyFor)
    ? // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the three export checks above are the runtime guard.
      (value as unknown as PiAiModule)
    : undefined;

/**
 * pi-ai's module, from the fiber's own loader entry first: the loader stores
 * the raw import on the entry before pi-ai's first config run
 * (`loader/src/config/entry.ts:233-237`). The module resolved from the
 * loader's base URL is the fallback, for a loader generation that kept none.
 *
 * @param ctx - the plugin context.
 * @param fiber - pi-ai's fiber.
 */
const piAiFromFiber = async (
  ctx: unknown,
  fiber: unknown
): Promise<PiAiModule | undefined> => {
  const entry: unknown = isRecord(fiber) ? fiber.entry : undefined;
  const namespace: unknown = isRecord(entry)
    ? entry.moduleNamespace
    : undefined;
  if (namespace !== undefined) {
    const direct = asPiAiModule(namespace);
    if (direct !== undefined) {
      return direct;
    }
    const loader = loaderOf(ctx);
    const unwrapped =
      loader !== undefined && isFunctionLike(loader.unwrapExports)
        ? Reflect.apply(loader.unwrapExports, loader, [namespace])
        : undefined;
    const viaLoader = asPiAiModule(unwrapped);
    if (viaLoader !== undefined) {
      return viaLoader;
    }
  }
  return asPiAiModule(await loadPiAiModule(ctx));
};

/** The source `cordis-context.ts` uses unless the harness replaced it. */
export const defaultHostModuleSource: HostModuleSource = {
  libraries: (ctx?: unknown) => {
    const wrapper = wrapperEntryFor(ctx);
    if (wrapper === undefined) {
      return loadLibrariesFrom();
    }
    let loaded = librariesByWrapper.get(wrapper);
    if (loaded === undefined) {
      loaded = loadLibrariesFrom(wrapper);
      librariesByWrapper.set(wrapper, loaded);
    }
    return loaded;
  },
  piAi: piAiFromFiber,
};
