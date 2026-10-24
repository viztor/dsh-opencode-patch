/**
 * The package's public API, pinned name by name.
 *
 * `src/index.ts` is what a consumer of `dsh-opencode-patch` can import, and
 * the host reads four names off it: `apply`, `Config`, `inject` and `name`.
 * Anything else the barrel exports is a promise the package did not mean to
 * make, so the list is pinned here and a change to it is a reviewed change to
 * this file, not a side effect of an edit somewhere in `src`.
 *
 * Two readings, because they can disagree: the SOURCE parse sees type exports,
 * which vanish at runtime, and the RUNTIME import sees what a consumer's
 * `import *` really gets. The subject of this file is the barrel itself, so it
 * imports `src/index.ts` directly rather than through `test/support/src.ts`.
 *
 * @module test/public-api.test
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { blankCommentLines } from "./support/strip-comments.ts";

const ROOT = join(import.meta.dirname, "..");
const BARREL = join(ROOT, "src", "index.ts");

/** The runtime names: what `import * as barrel` answers. */
const VALUE_EXPORTS: readonly string[] = ["Config", "apply", "inject", "name"];

/**
 * The type-only names: erased at runtime, still part of the contract.
 * `ModelRouteConfig` is here because `PluginConfig.modelRoutes` names it.
 */
const TYPE_EXPORTS: readonly string[] = [
  "EndpointFamily",
  "KeySourcePolicy",
  "ModelOverrideConfig",
  "ModelRouteConfig",
  "PluginConfig",
  "ResolvedPluginConfig",
];

/**
 * Every name the barrel's `export { … } from "./…"` blocks pass on, as the
 * consumer sees it (an `as` alias is the exported name), with `type ` dropped.
 */
const barrelExportNames = (source: string): string[] =>
  [...source.matchAll(/^export (?:type )?\{([^}]*)\} from "\.\/[^"]+";/gmu)]
    .flatMap((match) => (match[1] ?? "").split(","))
    .map((entry) =>
      entry
        .trim()
        .replace(/^type\s+/u, "")
        .replace(/^[\w$]+\s+as\s+/u, "")
    )
    .filter((entry) => entry !== "");

/**
 * What is left of the barrel once comments and every block
 * {@link barrelExportNames} reads are removed. Empty means the parse was
 * total: an `export *`, an `export type *`, a local `export interface` or a
 * single-quoted re-export would remain here and fail the pin, instead of
 * widening the type half of the contract unseen.
 */
const unparsedRemainder = (source: string): string =>
  blankCommentLines(source)
    .replaceAll(/^export (?:type )?\{[^}]*\} from "\.\/[^"]+";/gmu, "")
    .trim();

describe("public API · src/index.ts", () => {
  it("parses an export block the way a consumer reads it", () => {
    // A known answer, so an equal list below means the parser ran.
    expect(
      barrelExportNames(
        'export { a, type B } from "./x.ts";\nexport { type C } from "./y.ts";\nexport { d as e } from "./z.ts";'
      )
    ).toEqual(["a", "B", "C", "e"]);
  });

  it("reads the whole barrel: anything the parser skips is left over", () => {
    // Known answers, so an empty remainder below means the check can see.
    expect(
      unparsedRemainder('/** doc */\n// note\nexport { a } from "./x.ts";\n')
    ).toBe("");
    for (const widening of [
      'export type * from "./x.ts";',
      'export * from "./x.ts";',
      "export interface Extra { a: 1 }",
      "export type Extra = string;",
      "export { a } from './x.ts';",
    ]) {
      expect(
        unparsedRemainder(`export { a } from "./x.ts";\n${widening}`)
      ).toBe(widening);
      // A `//` comment holding a glob's `/*`, then the widening, then a doc
      // block: the `/*` must open nothing that swallows the widening.
      expect(
        unparsedRemainder(
          `// internals live in src/* and stay there\n${widening}\n/** The host entry. */\nexport { apply } from "./lifecycle.ts";\n`
        )
      ).toBe(widening);
    }
  });

  it("the barrel exports exactly the pinned names (source parse)", () => {
    const source = readFileSync(BARREL, "utf8");
    expect(unparsedRemainder(source)).toBe("");
    expect(barrelExportNames(source).toSorted()).toEqual(
      [...VALUE_EXPORTS, ...TYPE_EXPORTS].toSorted()
    );
  });

  it("the barrel's runtime surface is the pinned value names, and the four the host calls are real", async () => {
    const barrel = await import("../src/index.ts");
    expect(Object.keys(barrel).toSorted()).toEqual(VALUE_EXPORTS.toSorted());
    const pkg: unknown = JSON.parse(
      readFileSync(join(ROOT, "package.json"), "utf8")
    );
    expect(typeof barrel.apply).toBe("function");
    expect(typeof barrel.Config).toBe("function");
    expect(barrel.inject).toEqual(["llm"]);
    expect(barrel.name).toBe((pkg as { name: string }).name);
  });
});
