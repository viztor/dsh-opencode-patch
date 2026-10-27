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
        files: [
          "test/**/*.ts",
          "test/**/*.tsx",
          "test/**/*.mjs",
          "scripts/**/*.ts",
        ],
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
          // Not a runtime dependency: `src/host/host-modules.ts` loads the
          // host's own pi at runtime, so a pinned copy here would ship the
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
      // Floors are set just below the measured value rather than at it, so a
      // single removed test fails the build — a ratchet, not a target.
      //
      // `perFile: true, 100%` is what the harness itself runs, and it is the
      // right destination: their doc is explicit that "an uncovered line is
      // often dead code the gate flags for deletion, not a missing test to bolt
      // on". Getting there from here is real work across 25 files, so this
      // raises the floor first and the per-file work follows.
      thresholds: {
        // Re-measured after the P-R1 review at 97.66 / 94.24 / 97.48 / 97.65,
        // once the hidden-route modules (about 4,000 lines, the least covered
        // in the tree) were deleted and the plane modules that replaced them
        // landed at 100% where they are pure. Set just below that measurement.
        // Raised in P-T2 to just below 98.2 / 95.6 / 98.01 / 98.19, measured
        // after the mock-booting files left the unit run and the floor pins
        // below landed.
        statements: 98,
        // 91.5 -> 91.3: two tests that pinned hand-rolled menu-material CSS were
        // replaced by two that assert the panel renders MenuSurface, which is a
        // smaller assertion about a bigger fix. The floor follows the measured
        // value rather than the other way round. 94 since P-R1 (above).
        branches: 95.4,
        functions: 97.9,
        lines: 98,
        // Floors on the load-bearing modules only, so a well-covered average
        // cannot hide one that stopped being exercised. Not `perFile: true` —
        // that would hold every file to the aggregate number, which is a
        // different (and much noisier) promise. Every key here must name a
        // file that exists: `test/architecture.test.ts` fails the build on a
        // floor whose file moved or was deleted, which is a floor on nothing.
        // The one way to patch a host method: every branch is a reload case.
        "src/host/patch-method.ts": {
          statements: 100,
          branches: 100,
          functions: 100,
          lines: 100,
        },
        // The plane routes' pure decisions (P-R1): every branch is a protocol,
        // a precedence or one of pi-ai's checks, so all of them are covered.
        "src/utils/protocols.ts": {
          statements: 100,
          branches: 100,
          functions: 100,
          lines: 100,
        },
        "src/utils/model-metadata.ts": {
          statements: 100,
          branches: 100,
          functions: 100,
          lines: 100,
        },
        "src/utils/plane-model.ts": {
          statements: 100,
          branches: 100,
          functions: 100,
          lines: 100,
        },
        "src/utils/plane-profile.ts": {
          statements: 100,
          branches: 100,
          functions: 100,
          lines: 100,
        },
        // The plane routes' host half, measured rather than aspirational: what
        // is left uncovered are guards for host shapes no composition offers.
        "src/host/route-claim.ts": {
          statements: 97,
          branches: 86,
          functions: 95,
          lines: 97,
        },
        "src/host/plane-provider.ts": {
          statements: 99,
          branches: 97,
          functions: 100,
          lines: 99,
        },
        "src/host/describe-graft.ts": {
          statements: 100,
          branches: 94,
          functions: 100,
          lines: 100,
        },
        // The three modules that install the plugin's effects on the host (P-T2):
        // the composition, the stream hook and the fetch patch. Measured at
        // 92.72 / 92.15 / 100 / 92.59, 100 / 97.72 / 100 / 100 and
        // 100 / 98 / 100 / 100 once every branch a composition can reach was
        // pinned (lifecycle: the rename notice on tier B, the usage service's
        // base-URL closure, a composition with no `get`; stream-hook: numeric
        // ids, a blank-named root, `cwd: "/"`, a non-string model, a usage
        // chunk with one counter; fetch-patch: the `configured` policy, bodies
        // the free-model check cannot read, a placeholder in the env, the
        // store read, a blank `sessionIdEnv`, a debug entry of nulls), and set
        // just below. What is left uncovered no composition reaches, and is
        // named here rather than driven through a stand-in:
        // - lifecycle.ts: `root.plugin()` throwing for the usage, purge and
        //   store services (L172-173, L258-261, L283-284), `ctx.get` throwing
        //   (L213), a usage binding whose namespace is not a string (L233), the
        //   debug hook's `debugFile ?? ""` behind its own guard (L324), an
        //   `llm` scope that is not a record or has no `effect` (L370-371, L375);
        // - stream-hook.ts: `headerValueFor` answering `undefined` for a
        //   non-empty session id (L149, L154), which it never does;
        // - fetch-patch.ts: the report's "present" for a request key or a
        //   captured key (L319, L321), since either one fills the wire and no
        //   report follows, and a session header that is null after the patch
        //   set it (L466).
        "src/lifecycle.ts": {
          statements: 92.5,
          branches: 92,
          functions: 100,
          lines: 92.5,
        },
        "src/stream-hook.ts": {
          statements: 100,
          branches: 97.5,
          functions: 100,
          lines: 100,
        },
        "src/fetch-patch.ts": {
          statements: 100,
          branches: 97.5,
          functions: 100,
          lines: 100,
        },
        // Where every host library the planes run on is found. Its fallbacks
        // (a tree missing a package, a manifest of another shape) are driven
        // through stand-in installs; what is left uncovered are guards for
        // shapes no install produces (a manifest that is not an object, a
        // module namespace that is not a record) and a host with no wrapper
        // reachable from anywhere.
        "src/host/host-modules.ts": {
          statements: 96,
          branches: 92,
          functions: 100,
          lines: 96,
        },
      },
    },
  },
});
