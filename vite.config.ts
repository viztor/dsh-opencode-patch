import { fileURLToPath } from "node:url";

import ultraciteFmt from "ultracite/oxfmt";
import ultraciteLint from "ultracite/oxlint/core";
import { defineConfig } from "vite-plus";

export default defineConfig({
  fmt: {
    ...ultraciteFmt,
    ignorePatterns: [
      ...(ultraciteFmt.ignorePatterns ?? []),
      "lib/**",
      "coverage/**",
      // Bot-owned: release-please appends entries its own way every release.
      "CHANGELOG.md",
    ],
    sortPackageJson: true,
  },
  lint: {
    extends: [ultraciteLint],
    ignorePatterns: ["lib/**", "coverage/**"],
    options: {
      typeAware: true,
      typeCheck: true,
    },
    overrides: [
      {
        files: ["test/**/*.ts", "test/**/*.tsx", "scripts/**/*.ts"],
        rules: {
          "class-methods-use-this": "off",
          "func-style": "off",
          "import/first": "off",
          "import/namespace": "off",
          "no-await-in-loop": "off",
          "no-console": "off",
          "no-process-exit": "off",
          "promise/prefer-await-to-callbacks": "off",
          "require-await": "off",
          "sort-keys": "off",
          "typescript/array-type": "off",
          "typescript/consistent-type-imports": "off",
          "typescript/no-confusing-void-expression": "off",
          "typescript/no-non-null-assertion": "off",
          "typescript/no-unnecessary-type-assertion": "off",
          "typescript/no-unsafe-argument": "off",
          "typescript/no-unsafe-assignment": "off",
          "typescript/no-unsafe-call": "off",
          "typescript/no-unsafe-member-access": "off",
          "typescript/no-unsafe-return": "off",
          "typescript/no-unsafe-type-assertion": "off",
          "typescript/strict-boolean-expressions": "off",
          "unicorn/consistent-function-scoping": "off",
          "unicorn/import-style": "off",
          "unicorn/numeric-separators-style": "off",
          "unicorn/prefer-import-meta-properties": "off",
          "unicorn/text-encoding-identifier-case": "off",
        },
      },
    ],
    rules: {
      complexity: "off",
      "consistent-type-specifier-style": "off",
      curly: "off",
      eqeqeq: ["error", "always", { null: "ignore" }],
      "func-style": "off",
      "max-classes-per-file": "off",
      "max-nested-callbacks": "off",
      "no-await-in-loop": "warn",
      "no-eq-null": "off",
      "no-inline-comments": "off",
      "no-use-before-define": "off",
      "node/callback-return": "off",
      "prefer-named-capture-group": "off",
      "promise/avoid-new": "off",
      "require-await": "warn",
      "require-param-description": "off",
      "require-returns-description": "off",
      "require-unicode-regexp": "off",
      "sort-keys": "off",
      "typescript/await-thenable": "error",
      "typescript/no-explicit-any": "warn",
      "typescript/no-floating-promises": "error",
      "typescript/no-for-in-array": "error",
      "typescript/no-implied-eval": "error",
      "typescript/no-misused-promises": "error",
      "typescript/no-non-null-assertion": "warn",
      "typescript/no-unsafe-argument": "warn",
      "typescript/no-unsafe-assignment": "warn",
      "typescript/no-unsafe-call": "warn",
      "typescript/no-unsafe-enum-comparison": "warn",
      "typescript/no-unsafe-function-type": "warn",
      "typescript/no-unsafe-member-access": "warn",
      "typescript/no-unsafe-return": "warn",
      "typescript/no-unsafe-type-assertion": "warn",
      "typescript/only-throw-error": "error",
      "typescript/prefer-nullish-coalescing": "warn",
      "typescript/prefer-promise-reject-errors": "error",
      // Off: `withStore` iterators and the `fetch` patch intentionally use
      // sync functions returning promises so `AsyncLocalStorage.run` keeps
      // turn context without an extra async tick.
      "typescript/promise-function-async": "off",
      "typescript/return-await": "warn",
      "typescript/strict-boolean-expressions": "warn",
      "unicorn/filename-case": "off",
      "unicorn/prefer-export-from": "off",
    },
  },
  pack: [
    {
      clean: true,
      deps: {
        neverBundle: [
          "@deepseek-ai/cordis",
          "@deepseek-ai/dsh-typert-protocol",
          "@deepseek-ai/schemastery",
        ],
      },
      dts: true,
      format: ["esm"],
      outDir: "lib",
      platform: "node",
      sourcemap: false,
      target: "node24",
    },
    {
      banner: [
        "(function() {",
        "  var factory = function(require) {",
        "    var module = { exports: {} };",
        "    var exports = module.exports;",
      ].join("\n"),
      clean: false,
      deps: {
        neverBundle: [
          "react",
          "react/jsx-runtime",
          "@deepseek-ai/dsh-client-ui-primitives",
        ],
      },
      dts: false,
      entry: { client: "src/settings-page.tsx" },
      footer: [
        "    return module.exports;",
        "  };",
        '  window.__ModuleLoader__.load({ id: "dsh-opencode-patch", factory: factory });',
        '  try { window.__ModuleLoader__.load({ id: "@viztor/dsh-opencode", factory: factory }); } catch (e) {}',
        '  try { window.__ModuleLoader__.load({ id: "@viztor/dsh-opencode-patch", factory: factory }); } catch (e) {}',
        '  try { window.__ModuleLoader__.load({ id: "dsh-opencode", factory: factory }); } catch (e) {}',
        "})();",
      ].join("\n"),
      format: ["cjs"],
      outDir: "lib",
      platform: "browser",
      sourcemap: false,
    },
  ],
  test: {
    alias: {
      "@deepseek-ai/dsh-client-ui-primitives": fileURLToPath(
        new URL("test/primitives-stub.tsx", import.meta.url)
      ),
    },
    include: ["test/**/*.test.ts", "test/**/*.test.tsx"],
  },
});
