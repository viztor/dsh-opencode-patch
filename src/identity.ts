/**
 * Component and package identity.
 *
 * The same plugin answers to several names, and they are not interchangeable:
 * see `AGENTS.md` ("Package vs component") for the full mapping. Keeping the
 * literals here — rather than scattered across `index.ts`, `lifecycle.ts` and
 * the client bundle — makes the one place that must agree with
 * `package.json`/`cordis.patch.yml` obvious.
 *
 * @module dsh-opencode-patch/identity
 */

/** Component identity (log lines, service scoping). */
export const name = "dsh-opencode-patch";

/** Pre-rename component identity; rows using it get a rename notice. */
export const LEGACY_NAME = "dsh-opencode";

/** Pre-rename npm package; rows using it get a rename notice. */
export const LEGACY_PKG = "@viztor/dsh-opencode";

/** Host injections: the plugin needs the `llm` stream lifecycle. */
export const inject = ["llm"];
