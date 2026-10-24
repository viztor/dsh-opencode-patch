/**
 * The scoped aliases `scripts/publish-scoped.ts` publishes the package under.
 *
 * Release.yml's verify step polls the same names on its `pending="…"` line, and
 * `scripts/check.ts` fails when the two lists disagree. The list lives apart
 * from `publish-scoped.ts` because that script publishes at import time, so the
 * check and its test could not read the list from there.
 *
 * `@viztor/dsh-opencode` is no longer published (retired in 1.x, D9): its last
 * version's "Renamed to @viztor/dsh-opencode-patch" deprecation stands as the
 * final message on the registry.
 *
 * @module scripts/scoped-targets
 */
export const SCOPED_TARGETS: readonly string[] = ["@viztor/dsh-opencode-patch"];
