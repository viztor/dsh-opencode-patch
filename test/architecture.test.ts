/**
 * The `utils/` boundary, enforced rather than agreed.
 *
 * `utils` is the one folder every codebase has and every codebase lets rot,
 * because "utility" has no membership test — a function that reads a context and
 * causes a side effect is *arguably* a utility, and once one lands the folder
 * means nothing.
 *
 * So the membership test is a property: **a utility is a function of its
 * arguments.** No context, no globals, no I/O. This test is what makes that true
 * rather than aspirational — it fails the build, the way `scripts/check.ts`
 * already fails it for a client module reaching host-only code.
 *
 * @module test/architecture.test
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";

import { describe, expect, it } from "vitest";

const SRC_DIR = join(import.meta.dirname, "..", "src");
const UTILS_DIR = join(SRC_DIR, "utils");

/**
 * Every `.ts`/`.tsx` file under `dir`, at any depth, relative to `dir`.
 *
 * Recursive on purpose: a utility in a subfolder is still a utility, and a walk
 * that read one level would let `utils/nested/` hold anything at all.
 */
const filesUnder = (dir: string): string[] => {
  const files: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (/\.tsx?$/u.test(entry.name)) {
        files.push(full.slice(dir.length + 1).replaceAll("\\", "/"));
      }
    }
  };
  walk(dir);
  return files.toSorted();
};

/** Every utility, at any depth under `src/utils/`. */
const utilityFiles = (): string[] => filesUnder(UTILS_DIR);

/** The source with `//` and block comments removed, keeping line structure. */
const stripComments = (source: string): string =>
  source
    .replaceAll(/\/\*[\s\S]*?\*\//gu, "")
    .replaceAll(/^\s*\/\/.*$/gmu, "")
    .replaceAll(/\/\/.*$/gmu, "");

/**
 * Runtime imports of one file. A type-only import is erased by the compiler,
 * so it is no edge in the bundle and is skipped; a mixed one is a real edge.
 */
const runtimeImportsOf = (source: string): string[] => {
  const specifiers: string[] = [];
  for (const match of source.matchAll(
    /\b(?:import|export)\s+(type\s+)?(?:[^;"']*?\sfrom\s+)?"([^"]+)"/gu
  )) {
    if (match[1] === undefined && match[2] !== undefined) {
      specifiers.push(match[2]);
    }
  }
  return specifiers;
};

/**
 * Every `src/` file `entry` reaches at runtime, entry included, mapped to its
 * source with comments stripped.
 */
const runtimeGraph = (entry: string): Map<string, string> => {
  const seen = new Map<string, string>();
  const visit = (file: string): void => {
    if (seen.has(file)) {
      return;
    }
    const source = stripComments(readFileSync(join(SRC_DIR, file), "utf8"));
    seen.set(file, source);
    for (const specifier of runtimeImportsOf(source)) {
      if (specifier.startsWith("./") || specifier.startsWith("../")) {
        visit(join(file, "..", specifier).replaceAll("\\", "/"));
      }
    }
  };
  visit(entry);
  return seen;
};

/** The module specifiers one file imports. */
const importsOf = (source: string): string[] => {
  const specifiers: string[] = [];
  const patterns = [/from\s+"([^"]+)"/gu, /import\s+"([^"]+)"/gu];
  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(source)) !== null) {
      if (match[1] !== undefined) {
        specifiers.push(match[1]);
      }
    }
  }
  return specifiers;
};

/** What a utility may not reach. Each entry names the rule it breaks. */
const FORBIDDEN: readonly {
  readonly matches: (specifier: string) => boolean;
  readonly because: string;
}[] = [
  {
    because:
      "a node built-in is I/O: the utility would need the filesystem or a stream to answer",
    matches: (s) => s.startsWith("node:"),
  },
  {
    because:
      "a cordis context is the world: a utility takes its inputs as arguments instead",
    matches: (s) => s.startsWith("@deepseek-ai/cordis"),
  },
];

/**
 * Why a relative import from the utility at `file` (a path relative to
 * `src/utils/`) leaves the folder, or `undefined` when it stays inside.
 *
 * The specifier is resolved against the importing file's own directory, so a
 * nested utility's `../guards.ts` is a sibling, not an escape. Comparing the raw
 * specifier would flag every `../` — which, once the walk is recursive, rejects
 * exactly the nested utilities the recursion admits.
 */
const escapesUtils = (file: string, specifier: string): string | undefined => {
  if (!specifier.startsWith("./") && !specifier.startsWith("../")) {
    return undefined;
  }
  // Resolved under a root named for the folder, so a path that leaves and
  // re-enters it (`../../utils/guards.ts`) is judged by where it lands.
  const target = posix.join("/utils", posix.dirname(file), specifier);
  return target.startsWith("/utils/")
    ? undefined
    : "only guards.ts and other utilities may be imported; anything else is an effect module";
};

describe("architecture · a property read is a declared dependency", () => {
  const SRC = join(import.meta.dirname, "..", "src");

  /**
   * Cordis's own framework members, mixed onto every context. Reading these
   * needs no declaration — they are not services.
   */
  const FRAMEWORK = new Set([
    "baseUrl",
    "effect",
    "fiber",
    "get",
    "inject",
    "logger",
    "on",
    "plugin",
    "provide",
    "root",
  ]);

  /**
   * The CLIENT half's context, which is a different object from the host's.
   *
   * Every read there is optional (`ctx.remote === undefined`,
   * `ctx.slots?.inject?.(…)`), which is the pattern the host half must use for
   * its optional services and does. They are not `inject` declarations because
   * the host plugin declares only `llm` — see the next test.
   */
  const CLIENT_OPTIONAL = new Set([
    "configForms",
    "locale",
    "modelDirectories",
    "remote",
    "slots",
  ]);

  /** The one service the plugin DECLARES, so reading it as a property is right. */
  const DECLARED = new Set(["llm"]);

  /** Every `ctx.<name>` in a file, excluding `ctx.get("name")`. */
  const serviceReads = (file: string): string[] => {
    const source = stripComments(readFileSync(join(SRC, file), "utf8"));
    const names = new Set<string>();
    // Two shapes are the same bug: `ctx.loader` and `(ctx as {loader}).loader`.
    // The cast form is what a "quick fix" looks like, and matching only the
    // first let a planted regression pass.
    for (const match of source.matchAll(
      /\bctx\.([A-Za-z][A-Za-z0-9_]*)|\bctx as [^\n]*\}\)\.([A-Za-z][A-Za-z0-9_]*)/gu
    )) {
      const name = match[1] ?? match[2];
      if (
        name === undefined ||
        FRAMEWORK.has(name) ||
        CLIENT_OPTIONAL.has(name) ||
        DECLARED.has(name)
      ) {
        continue;
      }
      names.add(name);
    }
    return [...names];
  };

  const sourceFiles = (): string[] => filesUnder(SRC);

  it("reads no host service as a property except the declared `llm`", () => {
    // Cordis THROWS `cannot get property "X" without inject` for an undeclared
    // name, and its `inject` form has no required/optional split: a declared
    // service is REQUIRED, so declaring the optional ones would stop the plugin
    // activating on a headless host — a silent total failure.
    //
    // Consequence: every optional host service must be read through `ctx.get`,
    // which reads the store without consulting `inject`. This shipped as two
    // real bugs: `isLoaderHost` — which exists to answer "is there a loader?" —
    // read `ctx.loader` and threw, and `loaderOf` read it before its own
    // guarded fallback. Both failed the mount.
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      for (const name of serviceReads(file)) {
        offenders.push(`${file}: ctx.${name}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("declares `llm`, the one service the plugin cannot work without", async () => {
    const { inject } = await import("./support/src.ts");
    expect(inject).toContain("llm");
  });
});

describe("architecture · no source module imports a test library", () => {
  const SRC = join(import.meta.dirname, "..", "src");

  it("keeps vitest and testing-library out of everything in src/", () => {
    // Wider than `utils/`: an effect module importing `vitest` would be just as
    // fatal to a published package, and just as invisible in review. The gate on
    // `lib/client.js`'s requires catches it only if the import survives to the
    // bundle, which a type-only import does not.
    const violations: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!/\.tsx?$/u.test(entry.name)) {
          continue;
        }
        const source = stripComments(readFileSync(full, "utf8"));
        if (/from\s+"(?:vitest|@testing-library[^"]*)"/u.test(source)) {
          violations.push(full.slice(SRC.length + 1));
        }
      }
    };
    walk(SRC);
    expect(violations).toEqual([]);
  });
});

describe("architecture · utils/ holds only pure functions", () => {
  it("has utilities to check", () => {
    // Without this the suite passes vacuously on an empty folder — the exact
    // "a grep over a directory that does not exist" failure.
    expect(utilityFiles().length).toBeGreaterThan(0);
  });

  it("imports nothing host-only, and nothing outside utils/", () => {
    const violations: string[] = [];
    for (const file of utilityFiles()) {
      const source = readFileSync(join(UTILS_DIR, file), "utf8");
      for (const specifier of importsOf(source)) {
        for (const rule of FORBIDDEN) {
          if (rule.matches(specifier)) {
            violations.push(`${file} imports "${specifier}" — ${rule.because}`);
          }
        }
        // `guards.ts` lives in utils/ and is dependency-free by construction,
        // so it resolves inside the folder like any other utility.
        const escape = escapesUtils(file, specifier);
        if (escape !== undefined) {
          violations.push(`${file} imports "${specifier}" — ${escape}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("resolves an import from the importing file's folder, at any depth", () => {
    // Known answers, so the rule is seen to allow and to reject.
    expect(escapesUtils("retry.ts", "./guards.ts")).toBeUndefined();
    expect(escapesUtils("nested/a.ts", "../guards.ts")).toBeUndefined();
    expect(escapesUtils("nested/a.ts", "./b.ts")).toBeUndefined();
    expect(escapesUtils("nested/a.ts", "../retry.ts")).toBeUndefined();
    expect(escapesUtils("retry.ts", "../config.ts")).toBeDefined();
    expect(escapesUtils("retry.ts", "./../config.ts")).toBeDefined();
    expect(escapesUtils("nested/a.ts", "../../config.ts")).toBeDefined();
    expect(
      escapesUtils("nested/a.ts", "../../utils/guards.ts")
    ).toBeUndefined();
    expect(escapesUtils("retry.ts", "../utils/guards.ts")).toBeUndefined();
    expect(escapesUtils("nested/a.ts", "../../utilsx/a.ts")).toBeDefined();
  });

  it("never reads process.env, a global the arguments could have carried", () => {
    // Comments are stripped first: prose ABOUT the environment is exactly what
    // a rule explaining itself looks like, and a rule that flags its own
    // explanation would push the explanation out of the code.
    const violations = utilityFiles().filter((file) =>
      /process\.env/u.test(
        stripComments(readFileSync(join(UTILS_DIR, file), "utf8"))
      )
    );
    expect(violations).toEqual([]);
  });

  it("never calls fetch, which is I/O by definition", () => {
    const violations = utilityFiles().filter((file) => {
      // `fetch(` / `globalThis.fetch(` — but not the word inside a comment or a
      // longer identifier like `fetchPatch`.
      const source = stripComments(readFileSync(join(UTILS_DIR, file), "utf8"));
      return /(?:^|[^.\w])(?:fetch|globalThis\.fetch)\s*\(/mu.test(source);
    });
    expect(violations).toEqual([]);
  });

  /**
   * A reference to the console or to a global timer, outside a comment — not
   * only a call: `timer = setTimeout` as a default parameter, `backoffOver(setTimeout)`
   * and `const log = console.warn` reach the global just as surely, and so do
   * the four spellings of the global object (`globalThis.`, `window.`,
   * `global.`, `self.`). A member of something else (`options.timer(`,
   * `x.setTimeout(`) is not the global.
   *
   * A tripwire for the honest spelling, not a sandbox: an alias
   * (`const g = globalThis; g.setTimeout(…)`) or bracket access on the global
   * object gets past it, and catching those is a type-aware lint's job.
   */
  const AMBIENT_EFFECT =
    /(?<![.\w$])(?:globalThis\.|window\.|global\.|self\.)?(?:console|setTimeout|setInterval|setImmediate|clearTimeout|clearInterval|clearImmediate)\b/u;

  it("never touches console or a global timer, which are effects the caller owns", () => {
    // A log line is output and a timer is a clock: both are the world, and a
    // utility that needs one takes it as a parameter, the way `retry.ts` takes
    // its `sleep` and its `warn` and leaves the timer to the caller.
    const violations: string[] = [];
    for (const file of utilityFiles()) {
      // Block comments are blanked rather than removed, so a line number in a
      // violation is the line in the file.
      const source = stripComments(
        readFileSync(join(UTILS_DIR, file), "utf8").replaceAll(
          /\/\*[\s\S]*?\*\//gu,
          (comment) => comment.replaceAll(/[^\n]/gu, "")
        )
      );
      for (const [index, line] of source.split("\n").entries()) {
        const match = AMBIENT_EFFECT.exec(line);
        if (match !== null) {
          violations.push(
            `${file}:${index + 1} — ${match[0].trim()} is an effect the caller owns`
          );
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("knows a console call and a timer when it sees one, and walks every level", () => {
    // Known answers, so an empty violation list means the rule ran.
    expect(AMBIENT_EFFECT.test('console.warn("x")')).toBe(true);
    expect(AMBIENT_EFFECT.test("setTimeout(f, 1)")).toBe(true);
    expect(AMBIENT_EFFECT.test("globalThis.setInterval(f, 1)")).toBe(true);
    expect(AMBIENT_EFFECT.test("global.setTimeout(f, 1)")).toBe(true);
    expect(AMBIENT_EFFECT.test("self.console.warn(x)")).toBe(true);
    expect(AMBIENT_EFFECT.test("setImmediate(f)")).toBe(true);
    expect(AMBIENT_EFFECT.test("clearTimeout(handle)")).toBe(true);
    expect(
      AMBIENT_EFFECT.test("(timer: RetryTimer = setTimeout, baseMs = 300) =>")
    ).toBe(true);
    expect(AMBIENT_EFFECT.test("const sleep = backoffOver(setTimeout);")).toBe(
      true
    );
    expect(AMBIENT_EFFECT.test("const log = console.warn;")).toBe(true);
    expect(AMBIENT_EFFECT.test("const { warn } = console;")).toBe(true);
    expect(AMBIENT_EFFECT.test('console["warn"](x)')).toBe(true);
    expect(AMBIENT_EFFECT.test("(options.warn ?? console.warn)(m, e)")).toBe(
      true
    );
    expect(AMBIENT_EFFECT.test("options.timer(resolve, ms)")).toBe(false);
    expect(AMBIENT_EFFECT.test("x.setTimeout(f, 1)")).toBe(false);
    expect(AMBIENT_EFFECT.test("const consoleLike = 1;")).toBe(false);
    expect(
      AMBIENT_EFFECT.test(
        "type RetryTimer = (callback: () => void, delayMs: number) => unknown"
      )
    ).toBe(false);
    expect(utilityFiles()).toContain("retry.ts");
    expect(filesUnder(SRC_DIR)).toContain("utils/retry.ts");
  });
});

describe("architecture · the client bundle reaches nothing host-only", () => {
  /** The client bundle's entry, as `vite.config.ts` names it. */
  const ENTRY = "settings-page.tsx";

  /** Every `src/` file the entry reaches at runtime, entry included. */
  const clientGraph = (): Map<string, string> => runtimeGraph(ENTRY);

  /** What a client module may not import, each with the reason it is host-only. */
  const HOST_ONLY: readonly {
    readonly matches: (specifier: string) => boolean;
    readonly because: string;
  }[] = [
    {
      because: "a node built-in does not exist in the browser",
      matches: (s) => s.startsWith("node:"),
    },
    {
      because:
        "the cordis runtime is the host's, and the client gets its own context",
      matches: (s) => s === "@deepseek-ai/cordis",
    },
    {
      because:
        "pi is loaded from the host's installation, never shipped to a page",
      matches: (s) => s.startsWith("@earendil-works/pi-ai"),
    },
  ];

  it("walks a graph that actually contains the client modules", () => {
    // A walker that resolved nothing would pass every rule below vacuously.
    const graph = clientGraph();
    expect(graph.has(ENTRY)).toBe(true);
    expect(graph.has("usage-pill.tsx")).toBe(true);
    expect(graph.has("config-values.ts")).toBe(true);
    // And it must not wander into the host half through a type-only import.
    expect(graph.has("lifecycle.ts")).toBe(false);
  });

  it("imports no node built-in, no cordis runtime and no pi", () => {
    const violations: string[] = [];
    for (const [file, source] of clientGraph()) {
      for (const specifier of runtimeImportsOf(source)) {
        for (const rule of HOST_ONLY) {
          if (rule.matches(specifier)) {
            violations.push(`${file} imports "${specifier}" — ${rule.because}`);
          }
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("never reads process.env, which the browser does not have", () => {
    // The bundle test runs the built file in a VM, so a read inside a function
    // that never runs there passes it. Reading the source closes that gap.
    const violations = [...clientGraph()]
      .filter(([, source]) => /\bprocess\.env\b/u.test(source))
      .map(([file]) => file);
    expect(violations).toEqual([]);
  });

  it("flags a planted violation, so a pass means something", () => {
    // The rule is run over a source string with a known answer.
    const planted =
      'import { readFileSync } from "node:fs";\nimport type { X } from "node:os";';
    expect(runtimeImportsOf(planted)).toEqual(["node:fs"]);
    expect(HOST_ONLY.some((rule) => rule.matches("node:fs"))).toBe(true);
  });
});

describe("architecture · the host bundle mutates no registry it does not own", () => {
  /** The host half's composition root: everything `apply()` can run. */
  const ENTRY = "lifecycle.ts";

  /** A write to an `adapters` map: the llm registry's private table. */
  const REGISTRY_WRITE = /\badapters\??\.(?:delete|set|clear)\s*\(/u;

  it("walks a graph that actually contains the host modules", () => {
    const graph = runtimeGraph(ENTRY);
    expect(graph.has("stream-hook.ts")).toBe(true);
    expect(graph.has("responses-provider.ts")).toBe(true);
    expect(graph.has("settings-page.tsx")).toBe(false);
    expect(REGISTRY_WRITE.test('llm.adapters.delete("opencode")')).toBe(true);
    expect(REGISTRY_WRITE.test('llm.adapters?.delete("opencode")')).toBe(true);
    expect(REGISTRY_WRITE.test("this.adapters.get(route)")).toBe(false);
  });

  it("nothing reachable from lifecycle.ts deletes or sets an llm adapters entry", () => {
    // `registerAdapter` is all-or-nothing and only the owner's handle moves a
    // registration's routes. An entry deleted from outside leaves the owner
    // believing it holds the route, and its next dispose deletes ours. The
    // plugin keeps pi-ai off the planes through the config waterfall instead
    // (docs/engineering-notes.md, "Replacing another plugin's adapter
    // registration is not an API").
    const violations = [...runtimeGraph(ENTRY)]
      .filter(([, source]) => REGISTRY_WRITE.test(source))
      .map(([file]) => file);
    expect(violations).toEqual([]);
  });
});

describe("architecture · tests reach src through one door", () => {
  const SUPPORT = join(import.meta.dirname, "support", "src.ts");

  /**
   * Whether `source` DECLARES `name` — an `export const|function|class|…`
   * of it — rather than passing it on with `export { name } from "…"`.
   */
  const declares = (source: string, name: string): boolean =>
    new RegExp(
      String.raw`export (?:declare )?(?:abstract )?(?:async )?(?:const|let|function\*?|class|interface|type|enum) ${name}\b`,
      "u"
    ).test(source);

  /** Each `export { names } from "../../src/<target>"` block, names unaliased. */
  const reExportBlocks = (
    source: string
  ): { readonly target: string; readonly names: readonly string[] }[] =>
    [
      ...source.matchAll(
        /^export (?:type )?\{([^}]*)\} from "\.\.\/\.\.\/src\/([^"]+)"/gmu
      ),
    ].map((match) => ({
      names: (match[1] ?? "")
        .split(",")
        .map((entry) =>
          entry
            .trim()
            .replace(/^type\s+/u, "")
            .replace(/\s+as\s+[\w$]+$/u, "")
        )
        .filter((entry) => entry !== ""),
      target: match[2] ?? "",
    }));

  it("knows a declaration from a pass-through when it sees one", () => {
    // Known answers, so an empty miss list means the rule ran.
    const config = readFileSync(join(SRC_DIR, "config.ts"), "utf8");
    expect(declares(config, "Config")).toBe(true);
    expect(declares('export { Config } from "./config.ts";', "Config")).toBe(
      false
    );
    expect(declares("export type ConfigLike = 1;", "Config")).toBe(false);
    expect(
      reExportBlocks(
        'export { a, type B, c as d } from "../../src/x.ts";\nexport type { E } from "../../src/y.ts";'
      )
    ).toEqual([
      { names: ["a", "B", "c"], target: "x.ts" },
      { names: ["E"], target: "y.ts" },
    ]);
  });

  it("test/support/src.ts re-exports each name from the module that declares it", () => {
    // Re-exporting through `src/index.ts` would tie every test to the barrel
    // P2 shrinks, which is the coupling this file exists to remove; and a name
    // taken from a module that only passes it on breaks when P10a moves the
    // module that really defines it.
    const source = readFileSync(SUPPORT, "utf8");
    expect(source).not.toMatch(/src\/index\.ts/u);
    const blocks = reExportBlocks(source);
    // Every `from "../../src/…"` in the file is one of the parsed blocks, and
    // there is one block per module, so the walk below is not vacuous.
    expect(blocks.length).toBe(
      source.match(/from "\.\.\/\.\.\/src\//gu)?.length ?? 0
    );
    expect(blocks.length).toBeGreaterThanOrEqual(40);
    const missing = blocks
      .map(({ target }) => target)
      .filter((target) => !existsSync(join(SRC_DIR, target)));
    expect(missing).toEqual([]);
    const notDeclared = blocks.flatMap(({ names, target }) => {
      const defining = readFileSync(join(SRC_DIR, target), "utf8");
      return names
        .filter((name) => !declares(defining, name))
        .map((name) => `${name} is not declared in src/${target}`);
    });
    expect(notDeclared).toEqual([]);
  });
});
