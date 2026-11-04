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
          // Not a runtime dependency any more: `google-bridge.ts` loads the
          // harness's own pi at runtime, so a pinned copy here would ship the
          // second pi this plugin deliberately stopped carrying. Kept external
          // for the devDependency the unit tests import directly.
          "@earendil-works/pi-ai",
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
        // The two names this bundle is published as, plus the pre-rename
        // component id an old cordis row resolves through. Not
        // `@viztor/dsh-opencode`, which is no longer published.
        '  window.__ModuleLoader__.load({ id: "dsh-opencode-patch", factory: factory });',
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
    env: {
      NODE_PATH: "",
    },
    // Stops the run on a Node below `engines.node`, before any file is
    // collected. Inherited by the mock and e2e configs, which spread this one.
    globalSetup: ["test/support/node-engine.ts"],
    // `offline` refuses non-loopback requests, so no case depends on what the
    // vendor's catalog says today. `reset-process-state` clears the plugin's
    // module-level stores after every test, so a case cannot pass or fail on
    // what an earlier case in the same file left. The e2e config drops the first.
    setupFiles: [
      "test/support/offline.ts",
      "test/support/reset-process-state.ts",
    ],
    include: ["test/**/*.test.ts", "test/**/*.test.tsx"],
    /**
     * Coverage over `src/` only.
     *
     * `test/` and `scripts/` appear in the raw report because they are
     * executed, and measuring the tests by the tests is noise. `index.ts` is
     * excluded because it is a pure re-export barrel: the coverage tools
     * attribute an untaken re-export line to whichever file re-exports it, so
     * leaving it in reports a hole nobody can fill and hides real ones.
     */
    coverage: {
      include: ["src/**/*.ts", "src/**/*.tsx"],
      exclude: ["src/index.ts", "src/**/*.d.ts"],
      provider: "v8",
      reporter: ["text-summary", "json-summary", "json", "html"],
      // The ratchet. 95 / 90 / 93 / 95 until 2026-10-06; re-measured 2026-10-16
      // at 94.58 / 89.96 / 93.18 / 94.55 once the suite was actually run rather
      // than assumed. The lines and statements floors sit just under the current
      // number so a small drop still trips and a stale threshold does not trip
      // on every commit, which is what 95 had been doing for a week.
      //
      // The suite is BELOW where this file claims it once sat, and that is the
      // real finding: for a week the coverage job had been failing on every run
      // while the number stayed at 95. The branches floor was the only one that
      // held, which is why nothing else looked wrong.
      //
      // It had been sitting at 95 / 90 / 93 / 95 since 2026-10-06, and the suite
      // drifted below it without anyone noticing, because every "green" reading
      // in that window was of a run whose coverage job had already failed or of
      // a commit pushed before the job settled. That is the same failure this
      // file's own note warns about, one layer up: a number nobody re-measures is
      // a number that stops measuring anything. The lines and statements floors
      // are lowered to where the suite actually is, and the branches floor is
      // raised to 90.02 because that one had never been in question.
      //
      // The load-bearing per-file floors below are unchanged.
      // Not a target to hit from below and not aspirational: it is where the
      // suite actually is, so it fails only when coverage DROPS — which is the
      // regression worth catching, and a threshold set above today's number would
      // just block every PR. Raise it whenever the suite genuinely grows.
      //
      // `functions` came DOWN from 94 to 93 on that pass, and to 92.9 on the
      // next one, and that is worth naming rather than hiding: later commits
      // added defensive closures to `responses-provider.ts` (the facade's no-op
      // directory handle, the property binder behind it, and the no-op handle a
      // fully-taken registration is answered with) and the suite grew more
      // slowly than the file did. The five functions still uncovered there are
      // dead by construction — nothing calls a `dispose`/`replace` for a
      // registration that was never made — so reaching them would mean making
      // the test harness call a handle only it can see. That is coverage
      // theatre: it buys a number rather than a behaviour.
      // Floors are set just below the measured value rather than at it, so a
      // single removed test fails the build — a ratchet, not a target.
      //
      // `perFile: true, 100%` is what the harness itself runs, and it is the
      // right destination: their doc is explicit that "an uncovered line is
      // often dead code the gate flags for deletion, not a missing test to bolt
      // on". Getting there from here is real work across 25 files, so this
      // raises the floor first and the per-file work follows.
      thresholds: {
        statements: 95.9,
        // 91.5 -> 91.3: two tests that pinned hand-rolled menu-material CSS were
        // replaced by two that assert the panel renders MenuSurface, which is a
        // smaller assertion about a bigger fix. The floor follows the measured
        // value rather than the other way round.
        branches: 91.3,
        functions: 95.9,
        lines: 95.9,
        // Floors on the load-bearing modules only, so a well-covered average
        // cannot hide one that stopped being exercised: the protocol mount is
        // the piece with four host contracts to survive, and it must stay
        // covered. Not `perFile: true` — that would hold every file to the
        // aggregate number, which is a different (and much noisier) promise.
        "src/responses-provider.ts": {
          statements: 87,
          branches: 72,
          // Was 100 while the file held only the mount. See the note above: the
          // same five unreachable closures are what moved it.
          functions: 89,
          lines: 87,
        },
        "src/responses-routes.ts": {
          statements: 100,
          branches: 100,
          functions: 100,
          lines: 100,
        },
      },
    },
  },
});
