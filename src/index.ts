/**
 * `dsh-opencode-patch` — host plugin entry (public barrel).
 *
 * This is the package's contract with the host and nothing more: `apply`,
 * `Config`, `inject` and `name` — the four names a cordis host reads off a
 * plugin — and the config types a user of `Config` needs to name. Every other
 * module is internal; `test/public-api.test.ts` pins this list, so widening it
 * is a reviewed change rather than a side effect.
 *
 * Tests reach the internals through `test/support/src.ts`, which re-exports
 * each name from the module that defines it, never through this file.
 *
 * @module dsh-opencode-patch
 */

export { inject, name } from "./identity.ts";
export { apply } from "./lifecycle.ts";
export {
  Config,
  type ModelOverrideConfig,
  type ModelRouteConfig,
  type PluginConfig,
  type ResolvedPluginConfig,
} from "./config.ts";
export { type EndpointFamily, type KeySourcePolicy } from "./config-values.ts";
