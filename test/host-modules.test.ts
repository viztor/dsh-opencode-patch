/**
 * Where the plugin reads the host's modules from (`src/host/host-modules.ts`)
 * and the seam that lets the harness replace it (`src/cordis-context.ts`).
 *
 * The default source is exercised against this repository's own install —
 * the same walk from the wrapper's directory a deployment takes — so a case
 * here proves the plugin finds pi, dsh-llm and the loader where pi-ai runs on
 * them, and pi-ai's own module on its loader entry.
 *
 * @module test/host-modules.test
 */
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import * as LlmPiAi from "@deepseek-ai/dsh-llm-pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";

import { hostModulesForTests } from "./support/host.ts";
import {
  asPiAiModule,
  defaultHostModuleSource,
  loadHostModules,
  loadHostPi,
  loadLibrariesFrom,
  PI_AI_RUNTIME,
  piAiFibers,
  readLaunchEnvironment,
  replaceHostModuleSource,
  wrapperEntryFor,
} from "./support/src.ts";

const roots: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

/** Write `files` (path → contents) under `root`. */
const writeTree = (root: string, files: Record<string, string>): void => {
  for (const [file, contents] of Object.entries(files)) {
    const target = path.join(root, file);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, contents);
  }
};

const esm = (body: string): string => `${body}\n`;
const pkg = (manifest: Record<string, unknown>): string =>
  JSON.stringify({ type: "module", ...manifest });

/**
 * A stand-in install: a profile-like directory whose `node_modules` holds the
 * wrapper, a pi carrying every module the plane provider reads, and dsh-llm.
 * `omit` drops files, `files` adds or replaces them.
 */
const standInInstall = (
  options: {
    readonly omit?: readonly string[];
    readonly files?: Record<string, string>;
  } = {}
): string => {
  // Canonical, as `wrapperEntryFor` realpaths the entry it finds: on macOS
  // the temporary directory is reached through a symlink.
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "host-modules-")));
  roots.push(root);
  const pi = "node_modules/@earendil-works/pi-ai";
  const files: Record<string, string> = {
    "node_modules/@deepseek-ai/dsh-llm-pi-ai/package.json": pkg({
      exports: { ".": { default: "./lib/index.js" } },
      name: "@deepseek-ai/dsh-llm-pi-ai",
    }),
    "node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/index.js": esm(
      "export const wrapper = true;"
    ),
    "node_modules/@deepseek-ai/dsh-llm/package.json": pkg({
      main: "index.js",
    }),
    "node_modules/@deepseek-ai/dsh-llm/index.js": esm(
      "export const resolveRetryPolicy = () => ({});"
    ),
    [`${pi}/package.json`]: pkg({ version: "9.9.9" }),
    [`${pi}/dist/providers/all.js`]: esm(
      'export const getBuiltinModels = () => [{ id: "stand-in" }];'
    ),
    [`${pi}/dist/api/anthropic-messages.lazy.js`]: esm(
      "export const anthropicMessagesApi = () => ({});"
    ),
    [`${pi}/dist/api/google-generative-ai.lazy.js`]: esm(
      "export const googleGenerativeAIApi = () => ({});"
    ),
    [`${pi}/dist/api/openai-completions.lazy.js`]: esm(
      "export const openAICompletionsApi = () => ({});"
    ),
    [`${pi}/dist/api/openai-responses.lazy.js`]: esm(
      "export const openAIResponsesApi = () => ({});"
    ),
    [`${pi}/dist/providers/opencode-headers.js`]: esm(
      "export const withOpenCodeSessionHeader = (api) => api;"
    ),
    [`${pi}/dist/models.js`]: esm(
      "export const createProvider = (input) => input;"
    ),
    [`${pi}/dist/providers/opencode.js`]: esm(
      "export const opencodeProvider = () => ({ auth: { zen: true } });"
    ),
    [`${pi}/dist/providers/opencode-go.js`]: esm(
      "export const opencodeGoProvider = () => ({ auth: { go: true } });"
    ),
    ...options.files,
  };
  const omit = new Set(options.omit);
  writeTree(
    root,
    Object.fromEntries(
      Object.entries(files).filter(([file]) => !omit.has(file))
    )
  );
  return root;
};

const baseOf = (root: string): string => pathToFileURL(`${root}/`).href;
const entryIn = (root: string): string | undefined =>
  wrapperEntryFor({ baseUrl: baseOf(root) });

describe("host-modules · the host's tree, found from the context's base URL", () => {
  it("resolves the wrapper from the base URL the loader resolves from, else from the plugin's own location", () => {
    const root = standInInstall();
    const own = wrapperEntryFor({});
    // The checkout's own copy: what a bare context, a base it cannot be
    // resolved from, or a base that throws all fall back to.
    expect(own).toContain(`${path.sep}dsh-llm-pi-ai${path.sep}`);
    expect(entryIn(root)?.startsWith(root)).toBe(true);
    expect(entryIn(root)).not.toBe(own);
    expect(wrapperEntryFor({ baseUrl: "file:///no-such-root/" })).toBe(own);
    expect(wrapperEntryFor({ baseUrl: 5 })).toBe(own);
    const throwing = {};
    Object.defineProperty(throwing, "baseUrl", {
      get: () => {
        throw new Error("no inject");
      },
    });
    expect(wrapperEntryFor(throwing)).toBe(own);
  });

  it("loads the libraries from that wrapper's tree, and reports which pi it loaded", async () => {
    const root = standInInstall();
    const libraries = await loadLibrariesFrom(entryIn(root));
    expect(libraries?.version).toBe("9.9.9");
    expect(libraries?.root).toBe(
      path.join(root, "node_modules", "@earendil-works", "pi-ai")
    );
    expect(libraries?.opencodeAuth).toEqual({ zen: true });
    expect(libraries?.opencodeGoAuth).toEqual({ go: true });
    expect(libraries?.builtinModels("opencode")).toEqual([{ id: "stand-in" }]);
    // No loader in this tree, and a dsh-llm without its optional helpers.
    expect(libraries?.interpolate).toBeUndefined();
    expect(libraries?.LlmError).toBeUndefined();
    expect(libraries?.assertUsableApiKey).toBeUndefined();
    // The default source keys its cache by the wrapper it resolved, so the
    // same base answers the same load and another base its own.
    const viaSource = await defaultHostModuleSource.libraries({
      baseUrl: baseOf(root),
    });
    expect(viaSource?.root).toBe(libraries?.root);
    expect(
      await defaultHostModuleSource.libraries({ baseUrl: baseOf(root) })
    ).toBe(viaSource);
    const own = await defaultHostModuleSource.libraries({});
    expect(own?.version).toBe("1.1.0");
    const pi = await loadHostPi({ baseUrl: baseOf(root) });
    expect(pi?.version).toBe("9.9.9");
    expect(pi?.root).toBe(libraries?.root);
  });

  it("answers no libraries for a tree missing pi, dsh-llm or one of pi's exports; a manifest without a version reads as empty", async () => {
    expect(await loadLibrariesFrom()).toBeUndefined();
    const noPi = standInInstall({
      omit: ["node_modules/@earendil-works/pi-ai/package.json"],
    });
    expect(await loadLibrariesFrom(entryIn(noPi))).toBeUndefined();
    expect(await loadHostPi({ baseUrl: baseOf(noPi) })).toBeUndefined();
    const noLlm = standInInstall({
      omit: ["node_modules/@deepseek-ai/dsh-llm/package.json"],
    });
    expect(await loadLibrariesFrom(entryIn(noLlm))).toBeUndefined();
    const movedExport = standInInstall({
      files: {
        "node_modules/@earendil-works/pi-ai/dist/providers/all.js": esm(
          "export const somethingElse = 1;"
        ),
      },
    });
    expect(await loadLibrariesFrom(entryIn(movedExport))).toBeUndefined();
    expect(await loadHostPi({ baseUrl: baseOf(movedExport) })).toBeUndefined();
    const throwingAuth = standInInstall({
      files: {
        "node_modules/@earendil-works/pi-ai/dist/providers/opencode.js": esm(
          'export const opencodeProvider = () => { throw new Error("no"); };'
        ),
      },
    });
    expect(await loadLibrariesFrom(entryIn(throwingAuth))).toBeUndefined();
    const unreadableLlm = standInInstall({
      files: {
        "node_modules/@deepseek-ai/dsh-llm/package.json": "{not json",
      },
    });
    expect(await loadLibrariesFrom(entryIn(unreadableLlm))).toBeUndefined();
    const stringExports = standInInstall({
      files: {
        "node_modules/@deepseek-ai/dsh-llm/package.json": pkg({
          exports: "./index.js",
        }),
        "node_modules/@earendil-works/pi-ai/package.json": pkg({}),
      },
    });
    const loaded = await loadLibrariesFrom(entryIn(stringExports));
    expect(loaded?.version).toBe("");
    const stringPi = await loadHostPi({ baseUrl: baseOf(stringExports) });
    expect(stringPi?.version).toBe("");
    const brokenManifest = standInInstall({
      files: {
        "node_modules/@earendil-works/pi-ai/package.json": "{not json",
      },
    });
    const broken = await loadLibrariesFrom(entryIn(brokenManifest));
    expect(broken?.version).toBe("");
    expect(
      await loadHostPi({ baseUrl: baseOf(brokenManifest) })
    ).toBeUndefined();
  });
});

describe("host-modules · the default source", () => {
  it("loads pi, dsh-llm and the loader from the wrapper's own tree, once", async () => {
    const libraries = await defaultHostModuleSource.libraries();
    expect(libraries).toBeDefined();
    expect(libraries?.version).toBe("1.1.0");
    expect(Object.keys(libraries?.apis ?? {}).toSorted()).toEqual([
      "anthropic-messages",
      "google-generative-ai",
      "openai-completions",
      "openai-responses",
    ]);
    expect(typeof libraries?.createProvider).toBe("function");
    expect(typeof libraries?.interpolate).toBe("function");
    expect(typeof libraries?.assertUsableApiKey).toBe("function");
    expect(libraries?.LlmError).toBeTypeOf("function");
    expect(
      libraries
        ?.builtinModels("opencode")
        .some((model) => model.id === "deepseek-v4-pro")
    ).toBe(true);
    expect(await defaultHostModuleSource.libraries()).toBe(libraries);
  });

  it("reads pi-ai's module off its loader entry, unwrapping it through the loader when it must, and nothing else", async () => {
    const fiber = { entry: { moduleNamespace: LlmPiAi } };
    expect(await defaultHostModuleSource.piAi({}, fiber)).toBe(LlmPiAi);
    const wrapped = { default: LlmPiAi };
    const loader = {
      entries: () => [],
      unwrapExports: (exports: { default?: unknown }) => exports.default,
    };
    expect(
      await defaultHostModuleSource.piAi(
        { loader },
        { entry: { moduleNamespace: wrapped } }
      )
    ).toBe(LlmPiAi);
    // A namespace that is not pi-ai's, with no loader to unwrap it and no
    // loader entry to resolve from, is no module.
    expect(
      await defaultHostModuleSource.piAi(
        {},
        { entry: { moduleNamespace: wrapped } }
      )
    ).toBeUndefined();
    expect(await defaultHostModuleSource.piAi({})).toBeUndefined();
    expect(
      await defaultHostModuleSource.piAi({}, { entry: 5 })
    ).toBeUndefined();
  });

  it("falls back to the module resolved from the loader's base URL when the entry kept no namespace", async () => {
    // One loader generation keeps only the fiber on its entry. The module is
    // the SAME one the loader executed, reached by resolving the entry's own
    // name from the context's base URL — this checkout's root, here, whose
    // install is what the loader would have resolved against.
    const base = new URL("../", import.meta.url).href;
    const entry = { options: { name: "@deepseek-ai/dsh-llm-pi-ai" } };
    const generator = {
      *entries() {
        yield { options: { name: "something-else" } };
        yield entry;
      },
    };
    expect(
      await defaultHostModuleSource.piAi({ baseUrl: base, loader: generator })
    ).toBe(LlmPiAi);
    // Through `ctx.get`, which is the path that works when `ctx.loader`
    // throws for an undeclared service.
    const refusing = {
      baseUrl: base,
      get: (name: string) => (name === "loader" ? generator : undefined),
    };
    Object.defineProperty(refusing, "loader", {
      get: () => {
        throw new Error('cannot get property "loader" without inject');
      },
    });
    expect(await defaultHostModuleSource.piAi(refusing)).toBe(LlmPiAi);
    // No entry names pi-ai, no base URL, a base it cannot resolve from, an
    // entries() that throws or answers no iterable: each is "no module",
    // never a throw.
    const only = (entries: unknown) => ({ baseUrl: base, loader: { entries } });
    expect(await defaultHostModuleSource.piAi(only(() => []))).toBeUndefined();
    expect(
      await defaultHostModuleSource.piAi({ loader: generator })
    ).toBeUndefined();
    expect(
      await defaultHostModuleSource.piAi({
        baseUrl: "file:///no-such-root/",
        loader: generator,
      })
    ).toBeUndefined();
    expect(
      await defaultHostModuleSource.piAi(
        only(() => {
          throw new Error("entries failed");
        })
      )
    ).toBeUndefined();
    expect(await defaultHostModuleSource.piAi(only(() => 42))).toBeUndefined();
    expect(
      await defaultHostModuleSource.piAi({
        baseUrl: base,
        get: () => {
          throw new Error("no loader");
        },
      })
    ).toBeUndefined();
    expect(await defaultHostModuleSource.piAi(null)).toBeUndefined();
  });

  it("asPiAiModule answers only a record with pi-ai's three exports", () => {
    expect(asPiAiModule(LlmPiAi)).toBe(LlmPiAi);
    expect(asPiAiModule({ ...LlmPiAi, recordKeyFor: 1 })).toBeUndefined();
    expect(asPiAiModule(null)).toBeUndefined();
  });
});

describe("cordis-context · the host-module seam", () => {
  it("answers both halves, or nothing while either is missing or throws; a replacement restores in order", async () => {
    const test = hostModulesForTests();
    const outer = replaceHostModuleSource(test);
    try {
      const both = await loadHostModules({});
      expect(both?.piAi).toBe(LlmPiAi);
      const inner = replaceHostModuleSource({
        libraries: test.libraries,
        piAi: async () => {},
      });
      expect(await loadHostModules({})).toBeUndefined();
      inner();
      expect(await loadHostModules({})).toBeDefined();
      const throwing = replaceHostModuleSource({
        libraries: () => Promise.reject(new Error("no")),
        piAi: test.piAi,
      });
      expect(await loadHostModules({})).toBeUndefined();
      throwing();
    } finally {
      outer();
    }
    // The default source again: no fiber and no loader entry, so no pi-ai.
    expect(await loadHostModules({})).toBeUndefined();
  });

  it("readLaunchEnvironment reads the composition's snapshot, else the process environment", () => {
    const snapshot = {
      get: (name: string): unknown =>
        ({ A: { source: "process", value: "a" }, B: 5 })[name],
    };
    const launch = readLaunchEnvironment({
      get: (name: string) =>
        name === "launchEnvironment" ? snapshot : undefined,
    });
    expect(launch.get("A")).toEqual({ value: "a" });
    expect(launch.get("B")).toBeUndefined();
    vi.stubEnv("LAUNCH_ENV_PROBE", "p");
    for (const ctx of [
      {},
      5,
      {
        get: () => {
          throw new Error("no inject");
        },
      },
    ]) {
      const env = readLaunchEnvironment(ctx);
      expect(env.get("LAUNCH_ENV_PROBE")).toEqual({ value: "p" });
      expect(env.get("LAUNCH_ENV_PROBE_UNSET")).toBeUndefined();
    }
  });

  it("piAiFibers reads pi-ai's runtimes off the registry, and answers none for anything else", () => {
    const fiber = { state: 2, uid: 1 };
    const registry = {
      values: () => [
        { fibers: [fiber, 5], name: PI_AI_RUNTIME },
        { fibers: [{ uid: 2 }], name: "other" },
        { name: PI_AI_RUNTIME },
        null,
      ],
    };
    expect(piAiFibers({ registry })).toEqual([fiber]);
    expect(piAiFibers({})).toEqual([]);
    expect(piAiFibers(null)).toEqual([]);
    expect(
      piAiFibers({
        registry: {
          values: () => {
            throw new Error("gone");
          },
        },
      })
    ).toEqual([]);
  });
});
