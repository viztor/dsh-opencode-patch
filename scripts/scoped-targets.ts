/**
 * The scoped aliases `scripts/publish-scoped.ts` publishes the package under.
 *
 * Release.yml's verify step polls the same names on its `pending="…"` line, and
 * `test/package-checks.test.ts` fails when the two lists disagree. The list
 * lives apart from `publish-scoped.ts` because that script publishes at import
 * time, so the test could not read the list from there.
 *
 * `@viztor/dsh-opencode` is DEPRECATED and still published: a thin wrapper that
 * re-exports the canonical package, kept so an existing install keeps resolving.
 * A compatibility name that stops publishing breaks the installs still using it,
 * which is the one thing it must not do.
 *
 * @module scripts/scoped-targets
 */
export const SCOPED_TARGETS: readonly string[] = [
  "@viztor/dsh-opencode-patch",
  "@viztor/dsh-opencode",
];
