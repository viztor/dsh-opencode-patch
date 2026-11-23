/**
 * pi-ai credential record addressing without importing pi-ai's internals.
 *
 * `dsh-llm-pi-ai` kept `recordKeyFor` as an internal helper in 0.2.3 and
 * stopped exporting it from the package root. The plugin already restates
 * pi-ai's credential store and auth context over the host seams, so it owns
 * the same `<scope>/<id>` address locally instead of making the whole module
 * detection depend on an export that no longer exists.
 *
 * @module dsh-opencode-patch/host/pi-record-key
 */

/** The record scope pi-ai stores its credentials under (`auth.ts` `RECORD_SCOPE`). */
export const PI_AI_RECORD_SCOPE = "llm-pi-ai";

/** `dsh-credentials`' key-segment grammar: both halves of every record key. */
const KEY_SEGMENT = /^[a-z][a-z0-9-]*$/u;

/**
 * The credential record address for one pi-ai provider id.
 *
 * @param providerId - pi-ai's own provider id, which is also the harness route key.
 * @returns the scoped credential key pi-ai reads and writes.
 * @throws {TypeError} when the id is not a valid credential key segment.
 */
export function piAiRecordKeyFor(providerId: string): string {
  if (!KEY_SEGMENT.test(providerId)) {
    throw new TypeError(
      `credential key segment "${providerId}" must match ${String(KEY_SEGMENT)}`
    );
  }
  return `${PI_AI_RECORD_SCOPE}/${providerId}`;
}
