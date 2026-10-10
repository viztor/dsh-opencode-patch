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

/**
 * The OpenCode CLI version this plugin claims to be.
 *
 * The User-Agent is origin proof: the gateway reads it to decide whether the
 * caller is the official CLI, so it has to name a version the CLI actually has.
 * It is a single constant here, and every other place that needs it imports it,
 * because five hand-copied strings are five chances to disagree and nothing
 * notices when one drifts - a stale patch version still looks like a version.
 * `pnpm run cli:version` compares this against the published CLI.
 */
export const OPENCODE_CLI_VERSION = "1.18.35";

/** The User-Agent the stream hook sends: the CLI's own shape, verbatim. */
export const OPENCODE_USER_AGENT = `opencode/${OPENCODE_CLI_VERSION} ai-sdk/provider-utils/4.0.40 runtime/bun/1.3.14`;

/** The User-Agent the plugin signs its own requests with. */
export const OPENCODE_PATCH_USER_AGENT = `opencode/${OPENCODE_CLI_VERSION} dsh-opencode-patch`;
