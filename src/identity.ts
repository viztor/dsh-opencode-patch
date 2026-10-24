/**
 * Component and package identity.
 *
 * The same plugin answers to several names, and they are not interchangeable:
 * `name` is the component id (and the unscoped npm name), `LEGACY_NAME` and
 * `LEGACY_PKG` are the pre-rename ids an old row may still use, and
 * `SCOPED_PKG` in `settings-page.tsx` is the scoped npm name the settings card
 * registers under. README "Changed in 1.x" records the retired
 * `@viztor/dsh-opencode` wrapper. Keeping the
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
 * because seven hand-copied strings are seven chances to disagree and nothing
 * notices when one drifts - a stale patch version still looks like a version.
 * `pnpm run cli:version` compares this against the published CLI.
 *
 * The pin names the 1.x line - the generation this plugin emulates, and what
 * the registry's `latest` tag publishes. The 2.x line ships as
 * `0.0.0-<channel>-*` snapshots under the `dev`/`next`/`beta` tags; nothing
 * here claims it, and a claim that did would need its own constant.
 */
export const OPENCODE_CLI_VERSION = "1.19.4";

/**
 * The User-Agent the stream hook sends: the CLI's own shape, verbatim.
 *
 * `packages/opencode/src/session/llm/request.ts:18` is
 * `opencode/${InstallationVersion}` and nothing more - no SDK, no runtime, no
 * build. The `ai-sdk/provider-utils/… runtime/bun/…` tail this sent was the AI
 * SDK's own User-Agent, which is what a DIFFERENT transport stamps on a request;
 * it is not the client's, and 2.x changed the shape again to
 * `opencode/<channel>/<version>/<client>` (`packages/core/src/app.ts:24`).
 */
export const OPENCODE_USER_AGENT = `opencode/${OPENCODE_CLI_VERSION}`;

/** The User-Agent the plugin signs its own requests with. */
export const OPENCODE_PATCH_USER_AGENT = `opencode/${OPENCODE_CLI_VERSION} dsh-opencode-patch`;
